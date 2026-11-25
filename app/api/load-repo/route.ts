import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { fetchRepoFiles, parseGitHubUrl } from "@/lib/github";
import { embedChunks, splitFiles } from "@/lib/retrieval";
import { storeRepo } from "@/lib/store";
import { suggestQuestions } from "@/lib/suggest";
import type { RepoIndex } from "@/lib/types";

const BodySchema = z.object({
  url: z
    .string({ error: "A GitHub repo URL is required." })
    .min(1, "A GitHub repo URL is required."),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }

  const repoUrl = parseGitHubUrl(parsed.data.url);
  if (!repoUrl) {
    return NextResponse.json(
      { error: "That is not a GitHub repo URL. Use the form https://github.com/owner/repo (an optional /tree/branch is allowed)." },
      { status: 400 },
    );
  }

  let outcome;
  try {
    outcome = await fetchRepoFiles(repoUrl.owner, repoUrl.repo, repoUrl.branch);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch the repo from GitHub.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  if (outcome.files.length === 0) {
    return NextResponse.json(
      { error: "No readable text files were found in this repo (it may be empty, or contain only binaries)." },
      { status: 422 },
    );
  }

  const chunks = await splitFiles(outcome.files);

  const index: RepoIndex = {
    id: randomUUID(),
    owner: outcome.owner,
    repo: outcome.repo,
    branch: outcome.branch,
    url: outcome.url,
    files: outcome.files,
    chunks,
    vectorStore: null,
    embedded: false,
    truncated: outcome.truncated,
    totalFound: outcome.totalFound,
    totalBytes: outcome.totalBytes,
    createdAt: Date.now(),
  };

  // Embeddings are best-effort: a missing key or a failed embedding call
  // must not block loading — lexical search still works.
  const apiKey = req.headers.get("x-gemini-api-key")?.trim() || process.env.GEMINI_API_KEY?.trim() || "";
  let embedNote: string | null = null;
  if (apiKey) {
    try {
      index.vectorStore = await embedChunks(chunks, apiKey);
      index.embedded = index.vectorStore !== null;
      if (!index.embedded) embedNote = "Embeddings produced no vectors; lexical search will be used.";
    } catch (err) {
      embedNote =
        err instanceof Error && /API_KEY_INVALID|invalid/i.test(err.message)
          ? "Embeddings were skipped: the Gemini API key looks invalid. Lexical search will be used."
          : "Embeddings failed (network or Gemini error). Lexical search will be used.";
    }
  } else {
    embedNote = "No Gemini key provided, so chunks were not embedded. Lexical search will be used until a key is added in Settings.";
  }

  storeRepo(index);

  return NextResponse.json({
    repoId: index.id,
    owner: index.owner,
    repo: index.repo,
    branch: index.branch,
    url: index.url,
    fileCount: index.files.length,
    totalFound: index.totalFound,
    truncated: index.truncated,
    totalBytes: index.totalBytes,
    chunkCount: chunks.length,
    embedded: index.embedded,
    embedNote,
    files: index.files.map((f) => f.path).sort(),
    suggestedQuestions: suggestQuestions(index),
  });
}
