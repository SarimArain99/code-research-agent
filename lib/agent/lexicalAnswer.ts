import type { AnswerResult, RepoIndex, SourceRef } from "../types";
import { hybridSearch } from "../retrieval/index";

/**
 * Deterministic fallback used when no Gemini key is available.
 *
 * It ANSWERS — it never dumps raw code. Every answer is short:
 * a direct statement first, then at most 4 evidence bullets of one
 * trimmed line each, every claim cited as file:line. Usage questions
 * ("where is X used?") are traced for real: imports/requires of the
 * file, or call sites of the symbol, across the repo.
 */

const URDU_WORDS =
  /\b(kahan|kidhar|kisne|kis|yeh|ye|hai|hain|batao|kya|kaise|kaun|liye|karta|karti|hota|hoti|kis|kaam|matlab)\b/i;
const URDU_SCRIPT = /[\u0600-\u06FF]/;

function isUrdu(q: string): boolean {
  return URDU_SCRIPT.test(q) || URDU_WORDS.test(q);
}

function oneLine(text: string, max = 120): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function fileLines(index: RepoIndex, path: string): string[] {
  const f = index.files.find((x) => x.path === path);
  return f ? f.content.split("\n") : [];
}

export function packageJson(index: RepoIndex): Record<string, unknown> | null {
  const f = index.files.find((x) => x.path === "package.json");
  if (!f) return null;
  try {
    return JSON.parse(f.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** True when the file is the package entry point (main or exports "."). */
export function isPackageEntry(index: RepoIndex, targetPath: string): boolean {
  const pkg = packageJson(index);
  if (!pkg) return false;
  const norm = (v: unknown) => (typeof v === "string" ? v.replace(/^\.\//, "") : "");
  if (norm(pkg.main) === targetPath) return true;
  const exp = pkg.exports;
  if (typeof exp === "string") return norm(exp) === targetPath;
  if (exp && typeof exp === "object") {
    const obj = exp as Record<string, unknown>;
    // {".": "./index.js"} or {".": {import: ..., default: ...}}
    const dot = obj["."];
    if (typeof dot === "string") return norm(dot) === targetPath;
    if (dot && typeof dot === "object") {
      for (const v of Object.values(dot as Record<string, unknown>)) {
        if (norm(v) === targetPath) return true;
      }
    }
    // {"types": "./index.d.ts", "default": "./index.js"} — no "." key.
    for (const v of Object.values(obj)) {
      if (typeof v === "string" && norm(v) === targetPath) return true;
    }
  }
  return false;
}

/** The file the question names, or the file the user has open ("this file"). */
function pickTargetFile(
  question: string,
  index: RepoIndex,
  contextFile?: string,
): string | null {
  const q = question.toLowerCase();
  if (contextFile && /\b(this|yeh|ye|us|is)\s+file\b/.test(q)) {
    return contextFile;
  }
  let best: string | null = null;
  for (const f of index.files) {
    const base = f.path.split("/").pop() ?? "";
    if (base && q.includes(base.toLowerCase()) && (!best || f.path.length < best.length)) {
      best = f.path;
    }
    if (q.includes(f.path.toLowerCase()) && (!best || f.path.length > best.length)) {
      best = f.path;
    }
  }
  return best;
}

function isUsageQuestion(q: string, hasTarget: boolean): boolean {
  const text = q.toLowerCase();
  const mentionsUse = /\b(used|uses|use|usage|usages|imported|import)\b/.test(text);
  const asksWhere = /\b(where|who|kahan|kidhar|kis|kisne)\b/.test(text);
  // "Where is X used?" / "this file is used" / "index.js kahan use hua hai?"
  // all count — the last two only when a file is named or open.
  return mentionsUse && (asksWhere || hasTarget);
}

function isWhatDoesQuestion(q: string): boolean {
  return /\bwhat does\b.*\bdo\b|\bwhat is\b.*\bfor\b|\bkya karta\b|\bkis kaam\b|\bwhat does\b/.test(
    q.toLowerCase(),
  );
}

interface Usage {
  file: string;
  line: number;
  text: string;
}

/** Every file that imports/requires the target file — one line per file, code first. */
function findFileUsages(index: RepoIndex, targetPath: string): Usage[] {
  const base = targetPath.split("/").pop() ?? targetPath;
  const stem = base.replace(/\.[^.]+$/, "");
  const pkg = packageJson(index);
  const pkgName = typeof pkg?.name === "string" ? pkg.name : "";
  // `import x from 'p-limit'` only counts as a usage of this file when this
  // file IS the package entry point (package.json main/exports). Otherwise it
  // would falsely attribute every package import to any file asked about.
  const isEntry = isPackageEntry(index, targetPath);
  const usages: Usage[] = [];
  const seenFiles = new Set<string>();
  const specRe = /(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\))/g;
  const matchesSpecifier = (spec: string): boolean => {
    const clean = spec.split("?")[0].replace(/^\.{1,2}\//, "");
    const specBase = clean.split("/").pop() ?? "";
    if (specBase === base || specBase === stem) return true;
    if (isEntry && pkgName && (spec === pkgName || spec.endsWith(`/${pkgName}`))) return true;
    return false;
  };
  const code: Usage[] = [];
  const docs: Usage[] = [];
  for (const f of index.files) {
    if (f.path === targetPath || seenFiles.has(f.path)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      specRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      let hit = false;
      while ((m = specRe.exec(lines[i])) !== null) {
        if (matchesSpecifier(m[1] ?? m[2] ?? "")) {
          hit = true;
          break;
        }
      }
      if (hit) {
        seenFiles.add(f.path);
        const usage = { file: f.path, line: i + 1, text: lines[i].trim() };
        if (/\.(md|mdx|txt|rst)$/i.test(f.path)) docs.push(usage);
        else code.push(usage);
        break;
      }
    }
  }
  usages.push(...code, ...docs);
  return usages.slice(0, 6);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where a symbol is defined — real code first, .d.ts type declarations last. */
function definitionLine(
  index: RepoIndex,
  symbol: string,
): { file: string; line: number; text: string } | null {
  const re = new RegExp(
    `(export\\s+)?(default\\s+)?(function|class|const|let|var)\\s+${escapeRe(symbol)}\\b`,
  );
  const scan = (skipDts: boolean) => {
    for (const f of index.files) {
      if (skipDts && /\.d\.ts$/i.test(f.path)) continue;
      const lines = f.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) return { file: f.path, line: i + 1, text: lines[i].trim() };
      }
    }
    return null;
  };
  return scan(true) ?? scan(false);
}

/** Short purpose of a file: leading comment + what it exports. */
function describeFile(index: RepoIndex, path: string): { exports: string[]; comment: string | null } {
  const lines = fileLines(index, path);
  const exportsList: string[] = [];
  const exportRe = /export\s+(default\s+)?(function|class|const|let|var)?\s*([A-Za-z_$][\w$]*)/;
  const namedRe = /export\s*\{([^}]+)\}/;
  for (const l of lines) {
    const m = exportRe.exec(l);
    if (m && m[3]) exportsList.push(m[3]);
    const n = namedRe.exec(l);
    if (n) {
      for (const part of n[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) exportsList.push(name);
      }
    }
  }
  const commentLines: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (t === "" && commentLines.length === 0) continue;
    if (/^(\/\/|#|\/\*|\*)/.test(t)) {
      commentLines.push(t.replace(/^(\/\/|#|\/\*|\*)\s?/, ""));
      if (commentLines.length >= 2) break;
    } else if (commentLines.length > 0) break;
    else break;
  }
  return { exports: [...new Set(exportsList)], comment: commentLines.length ? commentLines.join(" ") : null };
}

function usageAnswer(
  index: RepoIndex,
  question: string,
  targetPath: string,
  urdu: boolean,
): AnswerResult {
  const usages = findFileUsages(index, targetPath);
  const sources: SourceRef[] = usages.map((u) => ({
    file: u.file,
    startLine: u.line,
    endLine: u.line,
    snippet: u.text,
  }));
  const pkg = packageJson(index);
  const isEntry = isPackageEntry(index, targetPath);
  const head = urdu
    ? usages.length > 0
      ? `${targetPath} ${usages.length} file${usages.length === 1 ? "" : "s"} me use hota hai:`
      : `${targetPath} ko repo ki kisi aur file ne import nahi kiya.`
    : usages.length > 0
      ? `${targetPath} is used in ${usages.length} file${usages.length === 1 ? "" : "s"}:`
      : `${targetPath} is not imported by any other file in this repo.`;
  const bullets = usages.map((u) => `- ${u.file}:${u.line} — ${oneLine(u.text)}`);
  const tail: string[] = [];
  if (usages.length === 0 && isEntry) {
    tail.push(
      urdu
        ? `package.json me ye entry point hai ("main": "${targetPath}"), is liye bahar se load hota hai, repo ke andar se nahi.`
        : `package.json lists it as the entry point ("main": "${targetPath}"), so it is loaded from outside, not from inside the repo.`,
    );
  }
  if (usages.length === 0 && !isEntry) {
    tail.push(
      /(^|\/)test[.-]|__tests__|\.test\./i.test(targetPath)
        ? "Test files are run by the test runner, not imported by other files — that is normal."
        : urdu
          ? "Ho sakta hai ye sirf bahar se use hota ho, ya dead code ho — repo ke andar iska koi reference nahi mila."
          : "It may only be used from outside the repo, or be dead code — no reference to it was found inside the repo.",
    );
  }
  const answer = [head, "", ...bullets, ...tail.map((t) => `\n${t}`)].join("\n").trim();
  return {
    answer,
    mode: "lexical",
    steps: [
      {
        tool: "find_symbol",
        input: JSON.stringify({ file: targetPath }),
        output: `${usages.length} file${usages.length === 1 ? "" : "s"} import ${targetPath}.`,
      },
    ],
    sources,
    model: null,
    note: null,
  };
}

function whatDoesAnswer(
  index: RepoIndex,
  targetPath: string,
  urdu: boolean,
): AnswerResult {
  const { exports: exps, comment } = describeFile(index, targetPath);
  const lines = fileLines(index, targetPath);
  const pkg = packageJson(index);
  const isEntry = isPackageEntry(index, targetPath);
  const pkgDesc = isEntry && typeof pkg?.description === "string" ? pkg.description : null;
  const head = urdu ? `${targetPath} ye karta hai:` : `${targetPath}:`;
  const parts: string[] = [head];
  if (pkgDesc) parts.push(`- ${oneLine(pkgDesc, 160)}`);
  if (comment) parts.push(`- ${oneLine(comment, 160)}`);
  if (exps.length > 0) {
    parts.push(
      urdu
        ? `- Ye export karta hai: ${exps.join(", ")}`
        : `- It exports: ${exps.join(", ")}`,
    );
  }
  if (parts.length === 1) {
    parts.push(
      urdu
        ? "- Is file me koi description comment nahi hai. Upar di gayi files me iska istemal dekh kar pata chalega ye kis kaam ki hai."
        : "- The file has no description comment. Its exports above are the short answer; check where it is used for more context.",
    );
  }
  const def = lines.findIndex((l) => l.trim().length > 0);
  const sources: SourceRef[] =
    def >= 0
      ? [{ file: targetPath, startLine: def + 1, endLine: def + 1, snippet: lines[def] }]
      : [];
  return {
    answer: parts.join("\n"),
    mode: "lexical",
    steps: [
      {
        tool: "read_file",
        input: JSON.stringify({ path: targetPath }),
        output: `Read ${targetPath}: ${exps.length} export${exps.length === 1 ? "" : "s"} found.`,
      },
    ],
    sources,
    model: null,
    note: null,
  };
}

export async function lexicalAnswer(
  index: RepoIndex,
  question: string,
  contextFile?: string,
): Promise<AnswerResult> {
  const urdu = isUrdu(question);
  const target = pickTargetFile(question, index, contextFile ?? undefined);

  if (target && isUsageQuestion(question, true)) {
    return usageAnswer(index, question, target, urdu);
  }
  if (target && isWhatDoesQuestion(question)) {
    return whatDoesAnswer(index, target, urdu);
  }
  if (isUsageQuestion(question, false) && !target) {
    return {
      answer: urdu
        ? "Kaunsi file? Misaal: “test.js kahan use hota hai?” — ya koi file khol kar poochho “ye file kahan use hoti hai?”"
        : "Which file? For example: “Where is test.js used?” — or open a file and ask “Where is this file used?”",
      mode: "lexical",
      steps: [],
      sources: [],
      model: null,
      note: null,
    };
  }

  const hits = await hybridSearch(index.chunks, index.vectorStore, question, 5);
  if (hits.length === 0) {
    return {
      answer: urdu
        ? "Is repo me is sawal se milta-julta kuch nahi mila. Kisi file, function ya feature ka naam try karo — files explorer me dekh sakte ho."
        : "I could not find anything in this repo that matches that question. Try the name of a file, function, or feature — you can see them in the file explorer.",
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
      note: null,
    };
  }

  // Direct answer first: if a hit is the definition of the thing asked
  // about, say so in one line instead of listing raw snippets.
  const nameMatch = /["'`]([A-Za-z_$][\w$]*)["'`]|\b([A-Za-z_$][\w$]{2,})\b/g;
  const names = [...question.matchAll(nameMatch)]
    .map((m) => m[1] ?? m[2])
    .filter((n) => !/^(where|what|how|does|file|used|this|that|the|repo|code|function|kahan|kya|hai|yeh|kaunsi)$/i.test(n));
  let head: string | null = null;
  for (const name of names) {
    const def = definitionLine(index, name);
    if (def) {
      head = urdu
        ? `${name} ${def.file}:${def.line} me defined hai — ${oneLine(def.text)}`
        : `${name} is defined in ${def.file}:${def.line} — ${oneLine(def.text)}`;
      break;
    }
  }

  const seen = new Set<string>();
  const bullets: string[] = [];
  const sources: SourceRef[] = [];
  const tokenLower = names.map((n) => n.toLowerCase());
  for (const h of hits) {
    const key = `${h.file}:${h.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Show the line that actually mentions what was asked about, not the
    // chunk's first line (which is often `return {` or a fence).
    const hitLines = h.snippet.split("\n");
    const matching =
      hitLines.find((l) => tokenLower.some((t) => l.toLowerCase().includes(t))) ??
      hitLines.map((l) => l.trim()).find((l) => l.length > 0) ??
      "";
    bullets.push(`- ${h.file}:${h.startLine} — ${oneLine(matching.trim())}`);
    sources.push({ file: h.file, startLine: h.startLine, endLine: h.endLine, snippet: h.snippet });
    if (bullets.length >= 4) break;
  }

  const answer = [
    head ??
      (urdu
        ? `“${question}” ke liye repo me ye mila:`
        : `Here is what matches “${question}” in ${index.owner}/${index.repo}:`),
    "",
    ...bullets,
    "",
    urdu
      ? "Poori detail ke liye kisi citation par click karo — file usi line par khul jayegi."
      : "Click any citation to open that file at that line.",
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
    note: null,
  };
}
