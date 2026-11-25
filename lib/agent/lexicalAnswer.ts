import type { AnswerResult, RepoIndex } from "../types";
import { hybridSearch } from "../retrieval/index";

/**
 * Deterministic fallback used when no Gemini key is available.
 * It never answers from general knowledge: every claim comes from a
 * retrieved snippet, cited as file:line. If nothing matches, it says so.
 */
export async function lexicalAnswer(
  index: RepoIndex,
  question: string,
): Promise<AnswerResult> {
  const hits = await hybridSearch(index.chunks, index.vectorStore, question, 6);
  const sources = hits.map((h) => ({
    file: h.file,
    startLine: h.startLine,
    endLine: h.endLine,
    snippet: h.snippet,
  }));

  if (hits.length === 0) {
    return {
      answer:
        "I could not find anything in this repo that matches that question. Try different keywords, or ask about a file, function, or feature that exists here — use list_files in the explorer to see what is available.",
      mode: "lexical",
      steps: [
        {
          tool: "search_code",
          input: JSON.stringify({ query: question }),
          output: "No matching code found.",
        },
      ],
      sources: [],
      model: null,
      note: "Lexical mode: no Gemini key was provided, so this answer is built only from keyword search over the loaded repo — no AI summary.",
    };
  }

  const lines = hits.map(
    (h) =>
      `- ${h.file}:${h.startLine}-${h.endLine}\n  ${h.snippet.split("\n").slice(0, 4).join("\n  ")}`,
  );
  const answer = [
    `Here is what I found in ${index.owner}/${index.repo} for "${question}":`,
    "",
    ...lines,
    "",
    "Open any citation to read the full file at that line. Add a Gemini API key in Settings for a written summary of these results.",
  ].join("\n");

  return {
    answer,
    mode: "lexical",
    steps: [
      {
        tool: "search_code",
        input: JSON.stringify({ query: question }),
        output: `${hits.length} matching snippet${hits.length === 1 ? "" : "s"} found.`,
      },
    ],
    sources,
    model: null,
    note: "Lexical mode: no Gemini key was provided, so this answer is built only from keyword search over the loaded repo — no AI summary.",
  };
}
