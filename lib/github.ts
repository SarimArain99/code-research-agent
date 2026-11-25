import type { RepoFile } from "./types";

export const MAX_FILES = 300;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 200 * 1024;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "vendor",
  "__pycache__",
  ".idea",
  ".vscode",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
]);

const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif",
  "mp3", "mp4", "wav", "ogg", "webm", "mov",
  "pdf", "zip", "tar", "gz", "rar", "7z",
  "exe", "dll", "so", "dylib", "bin", "dat",
  "ttf", "otf", "woff", "woff2", "eot",
  "db", "sqlite", "sqlite3",
]);

export interface ParsedRepoUrl {
  owner: string;
  repo: string;
  branch: string | null;
}

export function parseGitHubUrl(input: string): ParsedRepoUrl | null {
  const trimmed = input.trim().replace(/\/$/, "");
  const m = trimmed.match(
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/tree\/([^/?#]+))?(?:[/?#].*)?$/,
  );
  if (!m) return null;
  const repo = m[2].replace(/\.git$/, "");
  return { owner: m[1], repo, branch: m[3] ?? null };
}

function extOf(path: string): string {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

function shouldSkip(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  const base = parts[parts.length - 1];
  if (SKIP_FILES.has(base)) return true;
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return true;
  if (BINARY_EXTS.has(extOf(path))) return true;
  return false;
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

async function githubJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "CodeLens/1.0",
    },
  });
  if (res.status === 404) {
    throw new Error("Repository not found. Check the owner and repo name — it must be a public repo.");
  }
  if (res.status === 403) {
    throw new Error(
      "GitHub API rate limit reached (unauthenticated requests are limited). Wait a few minutes and try again.",
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub API error (${res.status}). Try again in a moment.`);
  }
  return (await res.json()) as T;
}

export interface LoadRepoOutcome {
  owner: string;
  repo: string;
  branch: string;
  url: string;
  files: RepoFile[];
  truncated: boolean;
  totalFound: number;
  totalBytes: number;
}

export async function fetchRepoFiles(
  owner: string,
  repo: string,
  branchHint: string | null,
): Promise<LoadRepoOutcome> {
  const repoMeta = await githubJson<{ default_branch: string }>(
    `https://api.github.com/repos/${owner}/${repo}`,
  );
  const branch = branchHint ?? repoMeta.default_branch;
  const tree = await githubJson<{ tree: TreeEntry[]; truncated?: boolean }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );

  const blobs = tree.tree.filter((e) => e.type === "blob" && !shouldSkip(e.path));
  const totalFound = blobs.length;
  let truncated = tree.truncated === true;

  const picked: TreeEntry[] = [];
  let totalBytes = 0;
  for (const entry of blobs) {
    const size = entry.size ?? 0;
    if (size > MAX_FILE_BYTES) {
      truncated = true;
      continue;
    }
    if (picked.length >= MAX_FILES || totalBytes + size > MAX_TOTAL_BYTES) {
      truncated = true;
      continue;
    }
    picked.push(entry);
    totalBytes += size;
  }

  // Download with bounded concurrency.
  const files: RepoFile[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < picked.length; i += CONCURRENCY) {
    const batch = picked.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry) => {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${entry.path}`;
        const res = await fetch(rawUrl, { headers: { "User-Agent": "CodeLens/1.0" } });
        if (!res.ok) return null;
        const text = await res.text();
        // Binary guard: NUL byte in the first chunk means binary.
        if (text.slice(0, 8000).includes("\0")) return null;
        if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) return null;
        return { path: entry.path, content: text } satisfies RepoFile;
      }),
    );
    for (const f of results) if (f) files.push(f);
  }

  return {
    owner,
    repo,
    branch,
    url: `https://github.com/${owner}/${repo}`,
    files,
    truncated,
    totalFound,
    totalBytes,
  };
}
