import { tool } from "langchain";
import { z } from "zod";
import type { RepoIndex, SearchHit, SourceRef } from "../types";
import { hybridSearch } from "../retrieval/index";

function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "No matching code found.";
  return hits
    .map(
      (h) =>
        `${h.file}:${h.startLine}-${h.endLine}\n${h.snippet}`,
    )
    .join("\n---\n");
}

function toSources(hits: SearchHit[]): SourceRef[] {
  return hits.map((h) => ({
    file: h.file,
    startLine: h.startLine,
    endLine: h.endLine,
    snippet: h.snippet,
  }));
}

/** Tools bound to one loaded repo. Every tool only reads that repo's files. */
export function buildTools(index: RepoIndex) {
  const collected: SourceRef[] = [];
  const pushSources = (hits: SearchHit[]) => {
    for (const s of toSources(hits)) {
      if (!collected.some((c) => c.file === s.file && c.startLine === s.startLine)) {
        collected.push(s);
      }
    }
  };

  const searchCode = tool(
    async ({ query }: { query: string }) => {
      const hits = await hybridSearch(index.chunks, index.vectorStore, query, 6);
      pushSources(hits);
      return formatHits(hits);
    },
    {
      name: "search_code",
      description:
        "Search the loaded repo for code relevant to a query. Returns matching snippets as file:startLine-endLine plus the code text. Use this first for any question about the code.",
      schema: z.object({
        query: z.string().describe("Keywords or a short phrase describing the code to find"),
      }),
    },
  );

  const readFile = tool(
    async ({ path, startLine, endLine }: { path: string; startLine?: number; endLine?: number }) => {
      const file = index.files.find((f) => f.path === path);
      if (!file) {
        const similar = index.files
          .map((f) => f.path)
          .filter((p) => p.toLowerCase().includes(path.toLowerCase().split("/").pop() ?? ""))
          .slice(0, 5);
        return `File not found: ${path}.` + (similar.length ? ` Did you mean one of: ${similar.join(", ")}?` : "");
      }
      const lines = file.content.split("\n");
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(lines.length, endLine ?? start + 399);
      const slice = lines.slice(start - 1, end);
      collected.push({
        file: path,
        startLine: start,
        endLine: end,
        snippet: slice.join("\n").slice(0, 600),
      });
      return slice.map((l, i) => `${start + i}: ${l}`).join("\n");
    },
    {
      name: "read_file",
      description:
        "Read a whole file from the loaded repo by its exact path, with line numbers. Optionally limit to a line range. Output is capped at 400 lines.",
      schema: z.object({
        path: z.string().describe("Exact repo-relative path, e.g. index.js"),
        startLine: z.number().optional().describe("First line to read (1-based)"),
        endLine: z.number().optional().describe("Last line to read (1-based)"),
      }),
    },
  );

  const listFiles = tool(
    async ({ pattern }: { pattern?: string }) => {
      const paths = index.files.map((f) => f.path);
      const filtered = pattern
        ? paths.filter((p) => p.toLowerCase().includes(pattern.toLowerCase()))
        : paths;
      if (filtered.length === 0) return "No files match that pattern.";
      return filtered.join("\n");
    },
    {
      name: "list_files",
      description:
        "List the files in the loaded repo, optionally filtered by a substring of the path.",
      schema: z.object({
        pattern: z.string().optional().describe("Substring to filter file paths by"),
      }),
    },
  );

  const findSymbol = tool(
    async ({ name }: { name: string }) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`);
      const hits: SourceRef[] = [];
      for (const file of index.files) {
        const lines = file.content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push({
              file: file.path,
              startLine: i + 1,
              endLine: i + 1,
              snippet: lines[i].trim().slice(0, 200),
            });
            if (hits.length >= 20) break;
          }
        }
        if (hits.length >= 20) break;
      }
      if (hits.length === 0) return `Symbol "${name}" was not found in any file.`;
      pushSources(
        hits.map((h) => ({ ...h, score: 1, kind: "lexical" as const })),
      );
      return hits.map((h) => `${h.file}:${h.startLine}: ${h.snippet}`).join("\n");
    },
    {
      name: "find_symbol",
      description:
        "Find where a function, class, variable or other identifier name appears across the repo. Returns file:line plus the matching line.",
      schema: z.object({
        name: z.string().describe("Exact identifier name to search for"),
      }),
    },
  );

  return {
    tools: [searchCode, readFile, listFiles, findSymbol],
    collectSources: () => collected,
  };
}
