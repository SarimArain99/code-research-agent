import type { AnswerResult, RepoIndex, SourceRef } from "../types";
import { isPackageEntry, packageJson } from "./lexicalAnswer";

/**
 * Auto Review: an autonomous, deterministic scan of the whole loaded repo.
 * No question, no Gemini key, no API calls — it reads the code itself and
 * reports what it found, each finding cited as file:line with a suggested
 * fix. It finds unused files and exports, dead functions, TODOs, hardcoded
 * secrets, oversized files, and missing package basics.
 */

export interface ReviewFinding {
  category: string;
  severity: "high" | "medium" | "low";
  file: string;
  line: number;
  title: string;
  detail: string;
  fix: string;
}

const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|rb|php)$/i;
const ES_EXT = /\.(js|jsx|ts|tsx|mjs|cjs)$/i;
const DOC_EXT = /\.(md|mdx|txt|rst)$/i;
const DATA_EXT = /\.(json|ya?ml|toml|lock|csv)$/i;

function isTestFile(path: string): boolean {
  return /(^|\/)test[.-]|__tests__|\.test\.|\.spec\.|test-d/i.test(path);
}

function isConfigFile(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return (
    base.startsWith(".") ||
    /^(tsconfig|babel|eslint|prettier|jest|vitest|vite|webpack|rollup|tailwind|postcss|next\.config|package\.json|package-lock\.json|license|licence|readme|changelog|contributing)/i.test(
      base,
    )
  );
}

/** Framework entry points: never imported by user code, never dead. */
function isFrameworkEntry(path: string): boolean {
  return (
    /(^|\/)(app|src\/app)\/(.*\/)?(page|layout|route|loading|error|not-found|template|default|global-error)\.[tj]sx?$/.test(
      path,
    ) ||
    /(^|\/)pages\//.test(path) ||
    /(^|\/)middleware\.[tj]s$/.test(path) ||
    /(^|\/)instrumentation\.[tj]s$/.test(path)
  );
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

const SPEC_RE_SOURCE =
  String.raw`(?:from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\))`;

function resolveSpecifier(
  spec: string,
  fromFile: string,
  files: Map<string, string>,
  index: RepoIndex,
): string | null {
  let rel: string | null = null;
  if (spec.startsWith(".")) {
    // Relative import: ./lib/store from app/api/ask/route.ts.
    const dir = fromFile.split("/").slice(0, -1).join("/");
    rel = normalizePath(dir ? `${dir}/${spec}` : spec);
  } else if (spec.startsWith("@/") || spec.startsWith("~/")) {
    // tsconfig path alias: @/lib/store means <root>/lib/store.
    rel = normalizePath(spec.slice(2));
  } else if (spec.includes("/")) {
    // Root-relative attempt (lib/store). The candidates check below is the
    // guard: next/server or react/jsx-runtime match no repo file.
    rel = normalizePath(spec);
  } else {
    // Bare package name: only the package itself counts as internal.
    const pkg = packageJson(index);
    const name = typeof pkg?.name === "string" ? pkg.name : "";
    if (name && spec === name) {
      for (const f of files.keys()) if (isPackageEntry(index, f)) return f;
    }
    return null;
  }
  for (const c of [
    rel,
    `${rel}.js`,
    `${rel}.ts`,
    `${rel}.jsx`,
    `${rel}.tsx`,
    `${rel}.mjs`,
    `${rel}.cjs`,
    `${rel}/index.js`,
    `${rel}/index.ts`,
  ]) {
    if (files.has(c)) return c;
  }
  return null;
}

/** Every repo file that some other file imports. Built in one pass. */
function buildImportedSet(index: RepoIndex): Set<string> {
  const files = new Map(index.files.map((f) => [f.path, f.content]));
  const imported = new Set<string>();
  const specRe = new RegExp(SPEC_RE_SOURCE, "g");
  for (const f of index.files) {
    specRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = specRe.exec(f.content)) !== null) {
      const spec = m[1] ?? m[2] ?? m[3] ?? "";
      if (!spec) continue;
      const target = resolveSpecifier(spec, f.path, files, index);
      if (target && target !== f.path) imported.add(target);
    }
  }
  return imported;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function oneLine(text: string, max = 110): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

interface ExportDecl {
  name: string;
  line: number;
  isDefault: boolean;
}

function getExports(content: string): ExportDecl[] {
  const out: ExportDecl[] = [];
  const lines = content.split("\n");
  const declRe = /^\s*export\s+(default\s+)?(function|class|const|let|var)?\s*([A-Za-z_$][\w$]*)?/;
  const namedRe = /^\s*export\s*\{([^}]+)\}/;
  const cjsRe = /^\s*exports\.([A-Za-z_$][\w$]*)\s*=/;
  lines.forEach((l, i) => {
    const d = declRe.exec(l);
    if (d && d[3] && !/^from$/.test(d[3])) {
      out.push({ name: d[3], line: i + 1, isDefault: Boolean(d[1]) });
      return;
    }
    const n = namedRe.exec(l);
    if (n) {
      for (const part of n[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim();
        if (name) out.push({ name, line: i + 1, isDefault: false });
      }
      return;
    }
    const c = cjsRe.exec(l);
    if (c) out.push({ name: c[1], line: i + 1, isDefault: false });
  });
  return out;
}

function topLevelFunctions(content: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const lines = content.split("\n");
  const fnRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
  const arrowRe =
    /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
  lines.forEach((l, i) => {
    const f = fnRe.exec(l) ?? arrowRe.exec(l);
    if (f) out.push({ name: f[1], line: i + 1 });
  });
  return out;
}

const SECRET_RES: RegExp[] = [
  /(api[_-]?key|apikey|secret|passwd|password|auth[_-]?token|access[_-]?token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const SECRET_NOISE = /example|placeholder|your[-_ ]?(api|secret|key|password)|xxx|dummy|fake/i;

export function autoReview(index: RepoIndex): AnswerResult {
  const findings: ReviewFinding[] = [];
  const push = (f: ReviewFinding) => {
    if (findings.length < 25) findings.push(f);
  };
  const imported = buildImportedSet(index);
  const contents = new Map(index.files.map((f) => [f.path, f.content]));
  const allText = index.files.map((f) => f.content).join("\n");
  const frameworkEntries = new Set(
    index.files.filter((f) => isFrameworkEntry(f.path)).map((f) => f.path),
  );

  // 1. Unused files — code files nothing imports (entry points, tests,
  //    configs, docs and type declarations are never "unused"). Files named
  //    in package.json scripts are runnable entries, not dead code.
  const scriptFiles = new Set<string>();
  const pkgScripts = (packageJson(index)?.scripts as Record<string, unknown> | undefined) ?? {};
  for (const cmd of Object.values(pkgScripts)) {
    if (typeof cmd !== "string") continue;
    for (const f of index.files) {
      const base = f.path.split("/").pop() ?? "";
      if (base && cmd.includes(base)) scriptFiles.add(f.path);
    }
  }
  const unusedFiles = new Set<string>();
  for (const f of index.files) {
    if (!CODE_EXT.test(f.path)) continue;
    if (imported.has(f.path)) continue;
    if (scriptFiles.has(f.path)) continue;
    if (frameworkEntries.has(f.path)) continue;
    if (isTestFile(f.path) || isConfigFile(f.path)) continue;
    if (/\.d\.ts$/i.test(f.path)) continue;
    if (isPackageEntry(index, f.path)) continue;
    unusedFiles.add(f.path);
    if (unusedFiles.size >= 5) break;
  }
  for (const path of unusedFiles) {
    push({
      category: "unused-files",
      severity: "medium",
      file: path,
      line: 1,
      title: `Unused file: ${path}`,
      detail: "Nothing in this repo imports it.",
      fix: "Delete it if it is not loaded some other way (script tag, config, CLI entry).",
    });
  }

  // 2. Unused exports — named exports no other file mentions.
  let exportCount = 0;
  const flaggedExports = new Set<string>();
  for (const f of index.files) {
    if (!ES_EXT.test(f.path) || isTestFile(f.path) || /\.d\.ts$/i.test(f.path)) continue;
    if (unusedFiles.has(f.path) || frameworkEntries.has(f.path)) continue;
    for (const exp of getExports(f.content)) {
      if (exp.isDefault) {
        if (imported.has(f.path)) continue;
      }
      // Used if the name appears anywhere else: in another file, or in this
      // file outside its own export line (an export used by its own module
      // still counts as used).
      const re = new RegExp(`\\b${escapeRe(exp.name)}\\b`);
      let used = false;
      for (const [path, content] of contents) {
        const text =
          path === f.path
            ? content
                .split("\n")
                .map((l, i) => (i === exp.line - 1 ? "" : l))
                .join("\n")
            : content;
        if (re.test(text)) {
          used = true;
          break;
        }
        re.lastIndex = 0;
      }
      if (!used) {
        flaggedExports.add(`${f.path}:${exp.name}`);
        push({
          category: "unused-exports",
          severity: "medium",
          file: f.path,
          line: exp.line,
          title: `Unused export: ${exp.name} in ${f.path}`,
          detail: `Exported at line ${exp.line} but never used in any other file.`,
          fix: `Remove the export${exp.isDefault ? "" : ` of ${exp.name}`} or use it somewhere.`,
        });
        if (++exportCount >= 5) break;
      }
    }
    if (exportCount >= 5) break;
  }

  // 3. Dead functions — top-level functions referenced only at their definition.
  let deadCount = 0;
  for (const f of index.files) {
    if (!ES_EXT.test(f.path) || isTestFile(f.path)) continue;
    if (unusedFiles.has(f.path) || frameworkEntries.has(f.path)) continue;
    for (const fn of topLevelFunctions(f.content)) {
      if (flaggedExports.has(`${f.path}:${fn.name}`)) continue;
      const matches = allText.match(new RegExp(`\\b${escapeRe(fn.name)}\\b`, "g"));
      if ((matches?.length ?? 0) <= 1) {
        push({
          category: "dead-functions",
          severity: "medium",
          file: f.path,
          line: fn.line,
          title: `Dead function: ${fn.name} in ${f.path}`,
          detail: `Defined at line ${fn.line} and never called anywhere in the repo.`,
          fix: `Delete ${fn.name} or call it where it is needed.`,
        });
        if (++deadCount >= 5) break;
      }
    }
    if (deadCount >= 5) break;
  }

  // 4. TODO / FIXME / HACK markers.
  let todoCount = 0;
  for (const f of index.files) {
    if (DOC_EXT.test(f.path) || DATA_EXT.test(f.path)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(lines[i])) {
        push({
          category: "todos",
          severity: "low",
          file: f.path,
          line: i + 1,
          title: `Unfinished marker in ${f.path}`,
          detail: oneLine(lines[i]),
          fix: "Finish the work or track it as an issue, then remove the marker.",
        });
        if (++todoCount >= 5) break;
      }
    }
    if (todoCount >= 5) break;
  }

  // 5. Hardcoded secrets (code/config only, never docs or tests).
  let secretCount = 0;
  for (const f of index.files) {
    if (DOC_EXT.test(f.path) || isTestFile(f.path)) continue;
    const lines = f.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (SECRET_NOISE.test(line)) continue;
      if (SECRET_RES.some((re) => re.test(line))) {
        push({
          category: "secrets",
          severity: "high",
          file: f.path,
          line: i + 1,
          title: `Possible hardcoded secret in ${f.path}`,
          detail: "A key, password or token value appears written directly in the code.",
          fix: "Move it to an environment variable and rotate the exposed value.",
        });
        if (++secretCount >= 5) break;
      }
    }
    if (secretCount >= 5) break;
  }

  // 6. Oversized files (source code only — not tests, fixtures or docs).
  let largeCount = 0;
  for (const f of index.files) {
    if (!CODE_EXT.test(f.path) || isTestFile(f.path)) continue;
    const lines = f.content.split("\n").length;
    if (lines > 400) {
      push({
        category: "large-files",
        severity: "low",
        file: f.path,
        line: 1,
        title: `Large file: ${f.path} (${lines} lines)`,
        detail: `Over 400 lines in one file.`,
        fix: "Split it into smaller focused modules.",
      });
      if (++largeCount >= 5) break;
    }
  }

  // 7. Package basics.
  const pkg = packageJson(index);
  if (pkg) {
    const scripts = (pkg.scripts as Record<string, unknown> | undefined) ?? {};
    if (!scripts.test) {
      push({
        category: "package",
        severity: "low",
        file: "package.json",
        line: 1,
        title: "No test script in package.json",
        detail: "`npm test` does nothing in this repo.",
        fix: "Add a \"test\" script that runs the test suite.",
      });
    }
    if (!pkg.license) {
      push({
        category: "package",
        severity: "low",
        file: "package.json",
        line: 1,
        title: "No license field in package.json",
        detail: "Other developers cannot tell how this code may be used.",
        fix: "Add a \"license\" field, e.g. \"MIT\".",
      });
    }
  }
  if (!index.files.some((f) => /^readme\.md$/i.test(f.path))) {
    push({
      category: "package",
      severity: "low",
      file: "package.json",
      line: 1,
      title: "No README in this repo",
      detail: "There is no README.md describing what the project does.",
      fix: "Add a short README with setup and usage.",
    });
  }

  const sources: SourceRef[] = findings.map((f) => ({
    file: f.file,
    startLine: f.line,
    endLine: f.line,
    snippet: (contents.get(f.file) ?? "").split("\n")[f.line - 1]?.trim() ?? "",
  }));

  const byCategory = new Map<string, number>();
  for (const f of findings) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);

  const head =
    findings.length === 0
      ? `Auto Review — ${index.owner}/${index.repo}: no issues found. No unused files or exports, no dead functions, no TODOs, no secrets, no oversized files.`
      : `Auto Review — ${index.owner}/${index.repo}: ${findings.length} finding${findings.length === 1 ? "" : "s"} (${[...byCategory.entries()].map(([c, n]) => `${n} ${c}`).join(", ")}).`;
  const bullets = findings.map(
    (f) => `- ${f.file}:${f.line} [${f.severity}] ${f.title} — ${oneLine(f.detail)} Fix: ${oneLine(f.fix)}`,
  );
  const answer = [
    head,
    "",
    ...bullets,
    "",
    "Click any citation to open that file at that line. No Gemini key was needed — this review reads the code directly.",
  ]
    .join("\n")
    .trim();

  return {
    answer,
    mode: "lexical",
    steps: [...byCategory.entries()].map(([category, n]) => ({
      tool: "auto_review",
      input: JSON.stringify({ category }),
      output: `${n} finding${n === 1 ? "" : "s"}.`,
    })),
    sources,
    model: null,
    note: null,
  };
}
