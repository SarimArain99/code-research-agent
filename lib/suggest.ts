import type { RepoIndex } from "./types";

/** Suggested questions built from the ACTUAL file list — never invented. */
export function suggestQuestions(index: RepoIndex): string[] {
  const paths = index.files.map((f) => f.path);
  const out: string[] = [];

  const entry = paths.find(
    (p) => /(^|\/)(index|main|app|mod|lib)\.(ts|js|tsx|jsx|py|go|rs)$/.test(p),
  );
  if (entry) out.push(`Where is the main entry point defined, and what does ${entry} do?`);

  const readme = paths.find((p) => /^readme\.md$/i.test(p));
  if (readme) out.push("What does this project do, according to the README?");

  const tests = paths.filter((p) =>
    /(\.test\.|\.spec\.|__tests__|\/test\/|(^|\/)test\.)/i.test(p),
  );
  if (tests.length > 0) {
    out.push(`Where are the tests, and what do they cover? (${tests.length} test file${tests.length === 1 ? "" : "s"})`);
  }

  const config = paths.find((p) => /package\.json|pyproject\.toml|go\.mod|Cargo\.toml/.test(p));
  if (config) out.push(`What are the dependencies and scripts in ${config}?`);

  const authish = paths.find((p) => /auth|login|session|token/i.test(p));
  if (authish) out.push(`How does authentication work in ${authish}?`);

  const apiish = paths.find((p) => /api|route|handler|controller/i.test(p));
  if (apiish) out.push(`How is the API structured? Start with ${apiish}.`);

  if (out.length === 0) {
    out.push("What are the main files in this repo, and what does each one do?");
  }
  out.push("Give me a short overview of how this codebase is organised.");
  return out.slice(0, 6);
}
