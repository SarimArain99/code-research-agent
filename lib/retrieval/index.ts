import { Document } from "@langchain/core/documents";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import type { CodeChunk, RepoFile, SearchHit } from "../types";

export const EMBED_MODEL = "text-embedding-004";
const MAX_EMBED_CHUNKS = 400;

/**
 * Split files with RecursiveCharacterTextSplitter (chunk ~1000 chars, overlap 200).
 * The splitter does not report line numbers, so each chunk's start line is found
 * by locating its first non-empty line inside the source file.
 */
export async function splitFiles(files: RepoFile[]): Promise<CodeChunk[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const chunks: CodeChunk[] = [];
  for (const file of files) {
    const docs = await splitter.createDocuments([file.content], [
      { file: file.path },
    ]);
    const lines = file.content.split("\n");
    for (const doc of docs) {
      const firstLine = doc.pageContent
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      let startLine = 1;
      if (firstLine) {
        const idx = lines.findIndex((l) => l.includes(firstLine));
        if (idx !== -1) startLine = idx + 1;
      }
      const chunkLines = doc.pageContent.split("\n").length;
      chunks.push({
        file: file.path,
        startLine,
        endLine: startLine + chunkLines - 1,
        text: doc.pageContent,
      });
    }
  }
  return chunks;
}

export async function embedChunks(
  chunks: CodeChunk[],
  apiKey: string,
): Promise<MemoryVectorStore | null> {
  const toEmbed = chunks.slice(0, MAX_EMBED_CHUNKS);
  if (toEmbed.length === 0) return null;
  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey,
    model: EMBED_MODEL,
  });
  const docs = toEmbed.map(
    (c) =>
      new Document({
        pageContent: c.text,
        metadata: { file: c.file, startLine: c.startLine, endLine: c.endLine },
      }),
  );
  return MemoryVectorStore.fromDocuments(docs, embeddings);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}

function lexicalScore(queryTokens: string[], chunk: CodeChunk): number {
  const hay = `${chunk.file}\n${chunk.text}`.toLowerCase();
  let score = 0;
  for (const tok of queryTokens) {
    if (hay.includes(tok)) score += tok.length > 4 ? 2 : 1;
  }
  // Path/filename matches count extra: a question about "tests" should surface test files.
  const fileLower = chunk.file.toLowerCase();
  for (const tok of queryTokens) {
    if (fileLower.includes(tok)) score += 2;
  }
  return score;
}

export function lexicalSearch(
  chunks: CodeChunk[],
  query: string,
  k = 6,
): SearchHit[] {
  const tokens = [...new Set(tokenize(query))];
  if (tokens.length === 0) return [];
  return chunks
    .map((c) => ({ chunk: c, score: lexicalScore(tokens, c) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => ({
      file: r.chunk.file,
      startLine: r.chunk.startLine,
      endLine: r.chunk.endLine,
      snippet: r.chunk.text.slice(0, 600),
      score: r.score,
      kind: "lexical" as const,
    }));
}

export async function vectorSearch(
  store: MemoryVectorStore,
  query: string,
  k = 6,
): Promise<SearchHit[]> {
  const docs = await store.similaritySearch(query, k);
  return docs.map((d) => ({
    file: String(d.metadata.file ?? "unknown"),
    startLine: Number(d.metadata.startLine ?? 1),
    endLine: Number(d.metadata.endLine ?? 1),
    snippet: d.pageContent.slice(0, 600),
    score: 1,
    kind: "vector" as const,
  }));
}

export async function hybridSearch(
  chunks: CodeChunk[],
  vectorStore: MemoryVectorStore | null,
  query: string,
  k = 6,
): Promise<SearchHit[]> {
  const lexical = lexicalSearch(chunks, query, k);
  if (!vectorStore) return lexical;
  let vector: SearchHit[] = [];
  try {
    vector = await vectorSearch(vectorStore, query, k);
  } catch {
    vector = [];
  }
  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  for (const hit of [...vector, ...lexical]) {
    const key = `${hit.file}:${hit.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
    if (merged.length >= k) break;
  }
  return merged;
}
