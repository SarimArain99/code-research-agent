"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { highlightLine } from "@/components/highlight";
import { DEMO_REPO_URL, SUPPORTED_MODELS } from "@/lib/types";
import type { SupportedModel } from "@/lib/types";

interface LoadRepoResponse {
  repoId: string;
  owner: string;
  repo: string;
  branch: string;
  url: string;
  fileCount: number;
  totalFound: number;
  truncated: boolean;
  totalBytes: number;
  chunkCount: number;
  embedded: boolean;
  embedNote: string | null;
  files: string[];
  suggestedQuestions: string[];
}

interface Step {
  tool: string;
  input: string;
  output: string;
}

interface Source {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  mode?: "agent" | "lexical";
  steps?: Step[];
  sources?: Source[];
  note?: string | null;
  model?: string | null;
}

type MobileTab = "files" | "chat" | "code";

const CITE_RE =
  /([A-Za-z0-9_.\-/]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;

function renderAnswer(
  text: string,
  onCite: (file: string, line: number) => void,
) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const file = m[1];
    const line = Number(m[2]);
    parts.push(
      <button
        key={`cite-${k++}`}
        type="button"
        onClick={() => onCite(file, line)}
        className="rounded bg-raised px-1 font-mono text-[13px] text-copper-soft underline decoration-copper-deep underline-offset-2 hover:bg-line"
        title={`Open ${file} at line ${line}`}
      >
        {m[0]}
      </button>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.23.6.83 1 1.51 1H21a2 2 0 1 1 0 4h-.09c-.68 0-1.28.4-1.51 1Z" />
    </svg>
  );
}

function LensIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="14" cy="14" r="9" stroke="#e07856" strokeWidth="2.5" />
      <circle cx="14" cy="14" r="4.5" stroke="#f2a488" strokeWidth="1.5" />
      <line x1="21" y1="21" x2="28" y2="28" stroke="#e07856" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export default function Home() {
  const [repoUrl, setRepoUrl] = useState("");
  const [repo, setRepo] = useState<LoadRepoResponse | null>(null);
  const [loadingRepo, setLoadingRepo] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState<SupportedModel>("gemini-2.5-flash");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState<SupportedModel>("gemini-2.5-flash");
  const [explorerFilter, setExplorerFilter] = useState("");
  const [selectedFile, setSelectedFile] = useState<{ path: string; content: string } | null>(null);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");
  const [showLoader, setShowLoader] = useState(true);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const codeLineRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    try {
      const savedKey = localStorage.getItem("codelens-gemini-key") ?? "";
      const savedModel = localStorage.getItem("codelens-model") ?? "";
      setApiKey(savedKey);
      setKeyDraft(savedKey);
      if ((SUPPORTED_MODELS as readonly string[]).includes(savedModel)) {
        setModel(savedModel as SupportedModel);
        setModelDraft(savedModel as SupportedModel);
      }
    } catch {
      // localStorage unavailable (private mode): key simply is not persisted.
    }
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, asking]);

  useEffect(() => {
    if (selectedLine === null) return;
    const el = codeLineRefs.current.get(selectedLine);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [selectedFile, selectedLine]);

  const openFile = useCallback(
    async (path: string, line?: number) => {
      if (!repo) return;
      setMobileTab("code");
      setSelectedLine(line ?? null);
      try {
        const res = await fetch(
          `/api/file?repoId=${encodeURIComponent(repo.repoId)}&path=${encodeURIComponent(path)}`,
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not open file.");
        setSelectedFile({ path: data.path, content: data.content });
      } catch (err) {
        setAskError(err instanceof Error ? err.message : "Could not open file.");
      }
    },
    [repo],
  );

  const loadRepo = useCallback(
    async (url: string) => {
      setLoadingRepo(true);
      setLoadError(null);
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["x-gemini-api-key"] = apiKey;
        const res = await fetch("/api/load-repo", {
          method: "POST",
          headers,
          body: JSON.stringify({ url }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to load repo.");
        setRepo(data as LoadRepoResponse);
        setMessages([]);
        setSelectedFile(null);
        setSelectedLine(null);
        setShowLoader(false);
        setMobileTab("chat");
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load repo.");
      } finally {
        setLoadingRepo(false);
      }
    },
    [apiKey],
  );

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || !repo || asking) return;
      setAsking(true);
      setAskError(null);
      setMessages((prev) => [...prev, { role: "user", text: q }]);
      setInput("");
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["x-gemini-api-key"] = apiKey;
        const res = await fetch("/api/ask", {
          method: "POST",
          headers,
          body: JSON.stringify({
            repoId: repo.repoId,
            question: q,
            model,
            contextFile: selectedFile?.path,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "The question could not be answered.");
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: data.answer as string,
            mode: data.mode as "agent" | "lexical",
            steps: (data.steps ?? []) as Step[],
            sources: (data.sources ?? []) as Source[],
            note: (data.note as string | null) ?? null,
            model: (data.model as string | null) ?? null,
          },
        ]);
      } catch (err) {
        setAskError(err instanceof Error ? err.message : "The question could not be answered.");
      } finally {
        setAsking(false);
      }
    },
    [repo, asking, apiKey, model, selectedFile],
  );

  const saveSettings = () => {
    const key = keyDraft.trim();
    setApiKey(key);
    setModel(modelDraft);
    try {
      if (key) localStorage.setItem("codelens-gemini-key", key);
      else localStorage.removeItem("codelens-gemini-key");
      localStorage.setItem("codelens-model", modelDraft);
    } catch {
      // Storage unavailable; the key still works for this session only.
    }
    setSettingsOpen(false);
  };

  const filteredFiles = repo
    ? repo.files.filter((f) =>
        explorerFilter ? f.toLowerCase().includes(explorerFilter.toLowerCase()) : true,
      )
    : [];

  const codeLines = selectedFile ? selectedFile.content.split("\n") : [];

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-line bg-panel px-4 py-3">
        <LensIcon />
        <div className="min-w-0">
          <h1 className="font-display text-xl font-semibold leading-none tracking-tight">
            CodeLens
          </h1>
          <p className="mt-1 truncate text-sm text-muted">
            Ask a repo anything, get answers with file and line citations
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span
            className={`hidden rounded-full border px-2.5 py-1 text-xs sm:inline-block ${
              apiKey ? "border-copper-deep text-copper-soft" : "border-line text-muted"
            }`}
          >
            {apiKey ? "Gemini agent" : "Lexical mode"}
          </span>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-lg border border-line bg-raised px-3 text-sm text-paper hover:border-copper-deep"
            aria-label="Open settings"
          >
            <GearIcon />
            <span className="hidden sm:inline">Settings</span>
          </button>
        </div>
      </header>

      <div className="flex shrink-0 gap-2 border-b border-line bg-panel px-4 py-2 md:hidden">
        {(["files", "chat", "code"] as MobileTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setMobileTab(tab)}
            className={`min-h-11 flex-1 rounded-lg px-3 text-sm capitalize ${
              mobileTab === tab ? "bg-copper text-copper-ink" : "bg-raised text-muted"
            }`}
            aria-pressed={mobileTab === tab}
          >
            {tab === "files" ? "Files" : tab === "chat" ? "Ask" : "Code"}
          </button>
        ))}
      </div>

      <main className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[260px_minmax(0,1fr)_minmax(0,420px)]">
        {/* File explorer */}
        <aside
          className={`min-h-0 flex-col overflow-hidden border-r border-line bg-panel ${
            mobileTab === "files" ? "flex" : "hidden"
          } md:flex`}
          aria-label="File explorer"
        >
          <div className="shrink-0 border-b border-line p-3">
            {repo ? (
              <div>
                <p className="truncate font-mono text-sm font-semibold text-paper">
                  {repo.owner}/{repo.repo}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {repo.branch}, {repo.fileCount} files indexed
                  {repo.totalFound > repo.fileCount ? ` of ${repo.totalFound} found` : ""}
                  {repo.embedded ? ", embedded" : ", lexical only"}
                </p>
                <button
                  type="button"
                  onClick={() => setShowLoader(true)}
                  className="mt-2 text-xs text-copper-soft underline underline-offset-2 hover:text-paper"
                >
                  Load a different repo
                </button>
              </div>
            ) : (
              <p className="text-sm text-muted">No repo loaded yet.</p>
            )}
            <label htmlFor="explorer-filter" className="sr-only">
              Filter files
            </label>
            <input
              id="explorer-filter"
              value={explorerFilter}
              onChange={(e) => setExplorerFilter(e.target.value)}
              placeholder="Filter files"
              className="mt-3 w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm text-paper placeholder:text-faint"
            />
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
            {filteredFiles.length === 0 && (
              <p className="p-2 text-sm text-faint">
                {repo ? "No files match that filter." : "Load a repo to browse its files."}
              </p>
            )}
            {filteredFiles.map((path) => (
              <button
                key={path}
                type="button"
                onClick={() => openFile(path)}
                className={`block w-full truncate rounded px-2 py-1.5 text-left font-mono text-[13px] hover:bg-raised ${
                  selectedFile?.path === path ? "bg-raised text-copper-soft" : "text-muted"
                }`}
                title={path}
              >
                {path}
              </button>
            ))}
          </div>
        </aside>

        {/* Chat column */}
        <section
          className={`min-w-0 flex-col overflow-hidden ${mobileTab === "chat" ? "flex" : "hidden"} md:flex`}
          aria-label="Ask the repo"
        >
          {(showLoader || !repo) && (
            <div className="shrink-0 border-b border-line bg-panel p-4">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  loadRepo(repoUrl);
                }}
                className="flex flex-col gap-2 sm:flex-row"
              >
                <label htmlFor="repo-url" className="sr-only">
                  Public GitHub repo URL
                </label>
                <input
                  id="repo-url"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-ink px-3 py-2.5 text-base text-paper placeholder:text-faint"
                />
                <button
                  type="submit"
                  disabled={loadingRepo || !repoUrl.trim()}
                  className="min-h-11 rounded-lg bg-copper px-4 text-sm font-semibold text-copper-ink disabled:opacity-50 hover:bg-copper-soft"
                >
                  {loadingRepo ? "Loading repo" : "Load repo"}
                </button>
                <button
                  type="button"
                  disabled={loadingRepo}
                  onClick={() => {
                    setRepoUrl(DEMO_REPO_URL);
                    loadRepo(DEMO_REPO_URL);
                  }}
                  className="min-h-11 rounded-lg border border-line bg-raised px-4 text-sm text-paper disabled:opacity-50 hover:border-copper-deep"
                >
                  Try demo repo
                </button>
              </form>
              {loadError && (
                <p role="alert" className="mt-3 rounded-lg border border-copper-deep bg-raised px-3 py-2 text-sm text-copper-soft">
                  {loadError}
                </p>
              )}
              <p className="mt-2 text-xs leading-relaxed text-faint">
                Public repos only. Text files are fetched through the GitHub API, capped at 300
                files and about 2 MB. Nothing is stored on disk.
              </p>
            </div>
          )}

          {repo && !showLoader && (
            <div className="shrink-0 border-b border-line bg-panel px-4 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-mono font-semibold">{repo.owner}/{repo.repo}</span>
                <span className="text-muted">{repo.chunkCount} chunks</span>
                <span className="text-muted">{repo.embedded ? "Vector search on" : "Lexical search"}</span>
                <button
                  type="button"
                  onClick={() => setShowLoader(true)}
                  className="text-copper-soft underline underline-offset-2 hover:text-paper"
                >
                  Change repo
                </button>
              </div>
              {repo.truncated && (
                <p className="mt-1 text-xs text-code-amber">
                  Only the first {repo.fileCount} files (of {repo.totalFound} found) were indexed,
                  within the 300-file and 2 MB limits.
                </p>
              )}
              {repo.embedNote && (
                <p className="mt-1 text-xs text-muted">{repo.embedNote}</p>
              )}
            </div>
          )}

          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {!repo && messages.length === 0 && (
              <div className="mx-auto max-w-2xl pt-6">
                <h2 className="font-display text-2xl font-semibold leading-snug">
                  Read a codebase by asking questions.
                </h2>
                <p className="mt-2 text-base leading-relaxed text-muted">
                  Paste a public GitHub URL, or try the demo repo. CodeLens indexes the code,
                  then answers from what it actually read, with a citation for every claim.
                </p>
                <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-base leading-relaxed text-muted">
                  <li>Load a public repo (or the demo repo above).</li>
                  <li>Ask in English or Urdu, for example where a function is defined.</li>
                  <li>Click a citation to open that file at that line.</li>
                </ol>
                {!apiKey && (
                  <p className="mt-4 rounded-lg border border-line bg-panel px-3 py-2 text-sm leading-relaxed text-muted">
                    No Gemini key? You can still ask: answers come from keyword search over the
                    loaded repo. Add a free key in Settings for full agent answers.
                  </p>
                )}
              </div>
            )}

            {repo && messages.length === 0 && (
              <div className="mx-auto max-w-2xl">
                <h2 className="font-display text-xl font-semibold">Suggested questions</h2>
                <p className="mt-1 text-sm text-muted">
                  Built from this repo&apos;s actual files.
                </p>
                <div className="mt-3 flex flex-col items-start gap-2">
                  {repo.suggestedQuestions.map((q) => (
                    <button
                      key={q}
                      type="button"
                      onClick={() => ask(q)}
                      className="rounded-lg border border-line bg-panel px-3 py-2 text-left text-sm text-paper hover:border-copper-deep"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) =>
              msg.role === "user" ? (
                <div key={i} className="mb-4 flex justify-end">
                  <div className="max-w-[85%] rounded-lg bg-raised px-3.5 py-2.5 text-base leading-relaxed">
                    {msg.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="mb-5 max-w-full">
                  <div className="rounded-lg border border-line bg-panel px-3.5 py-3">
                    <div className="whitespace-pre-wrap text-base leading-relaxed">
                      {renderAnswer(msg.text, openFile)}
                    </div>
                    {msg.note && (
                      <p className="mt-3 border-t border-line pt-2 text-xs leading-relaxed text-muted">
                        {msg.note}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-faint">
                      {msg.mode === "agent"
                        ? `Answered by Gemini ${msg.model ?? ""}`
                        : "Answered by lexical search"}
                    </p>
                  </div>
                  {msg.steps && msg.steps.length > 0 && (
                    <details className="mt-2 rounded-lg border border-line bg-panel px-3 py-2">
                      <summary className="cursor-pointer text-sm text-muted">
                        Agent steps ({msg.steps.length} tool call{msg.steps.length === 1 ? "" : "s"})
                      </summary>
                      <ul className="mt-2 space-y-2">
                        {msg.steps.map((s, j) => (
                          <li key={j} className="text-sm">
                            <span className="font-mono text-copper-soft">{s.tool}</span>
                            <span className="ml-2 font-mono text-xs text-faint">{s.input}</span>
                            {s.output && (
                              <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted">
                                {s.output.slice(0, 400)}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-2">
                      <h3 className="text-sm font-semibold text-muted">Sources</h3>
                      <ul className="mt-1.5 space-y-1.5">
                        {msg.sources.map((s, j) => (
                          <li key={j}>
                            <button
                              type="button"
                              onClick={() => openFile(s.file, s.startLine)}
                              className="block w-full rounded-lg border border-line bg-panel px-3 py-2 text-left hover:border-copper-deep"
                            >
                              <span className="font-mono text-[13px] text-copper-soft">
                                {s.file}:{s.startLine}
                                {s.endLine > s.startLine ? `-${s.endLine}` : ""}
                              </span>
                              <span className="mt-1 block truncate font-mono text-xs text-muted">
                                {s.snippet.split("\n")[0]}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ),
            )}
            {asking && (
              <p className="text-sm text-muted">Searching the repo and drafting an answer…</p>
            )}
            {askError && (
              <p role="alert" className="mb-4 rounded-lg border border-copper-deep bg-raised px-3 py-2 text-sm text-copper-soft">
                {askError}
              </p>
            )}
            <div ref={chatEndRef} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(input);
            }}
            className="shrink-0 border-t border-line bg-panel p-3"
          >
            <div className="flex gap-2">
              <label htmlFor="ask-input" className="sr-only">
                Ask a question about the loaded repo
              </label>
              <input
                id="ask-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  repo ? "Ask about this code, in English or Urdu" : "Load a repo first to ask questions"
                }
                disabled={!repo || asking}
                className="min-w-0 flex-1 rounded-lg border border-line bg-ink px-3 py-2.5 text-base text-paper placeholder:text-faint disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={!repo || asking || !input.trim()}
                className="min-h-11 rounded-lg bg-copper px-5 text-sm font-semibold text-copper-ink disabled:opacity-50 hover:bg-copper-soft"
              >
                Ask
              </button>
            </div>
          </form>
        </section>

        {/* Code viewer */}
        <section
          className={`min-w-0 flex-col overflow-hidden border-l border-line bg-ink ${
            mobileTab === "code" ? "flex" : "hidden"
          } md:flex`}
          aria-label="Code viewer"
        >
          <div className="shrink-0 border-b border-line bg-panel px-4 py-2.5">
            {selectedFile ? (
              <>
                <p className="truncate font-mono text-sm font-semibold">{selectedFile.path}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {codeLines.length} lines
                  {selectedLine !== null ? `, showing line ${selectedLine}` : ""}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => ask(`Where is ${selectedFile.path} used?`)}
                    disabled={asking}
                    className="rounded-full border border-line bg-ink px-2.5 py-1 text-xs text-copper-soft transition hover:border-copper disabled:opacity-50"
                  >
                    Where is this file used?
                  </button>
                  <button
                    type="button"
                    onClick={() => ask(`What does ${selectedFile.path} do?`)}
                    disabled={asking}
                    className="rounded-full border border-line bg-ink px-2.5 py-1 text-xs text-copper-soft transition hover:border-copper disabled:opacity-50"
                  >
                    What does this file do?
                  </button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted">
                Select a file, or click a citation, to read code here.
              </p>
            )}
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-auto p-0 font-mono text-[13px] leading-6">
            {selectedFile ? (
              codeLines.map((line, idx) => {
                const n = idx + 1;
                const active = n === selectedLine;
                return (
                  <div
                    key={n}
                    ref={(el) => {
                      if (el) codeLineRefs.current.set(n, el);
                      else codeLineRefs.current.delete(n);
                    }}
                    className={`flex min-w-0 whitespace-pre px-0 ${
                      active ? "bg-raised" : ""
                    }`}
                  >
                    <span
                      className={`w-12 shrink-0 select-none pr-3 text-right ${
                        active ? "text-copper-soft" : "text-faint"
                      }`}
                    >
                      {n}
                    </span>
                    <span className={`min-w-0 ${active ? "border-l-2 border-copper pl-2" : ""}`}>
                      {line.length === 0 ? " " : highlightLine(line, `l${n}`)}
                    </span>
                  </div>
                );
              })
            ) : (
              <p className="p-4 font-sans text-sm text-faint">
                No file open yet.
              </p>
            )}
          </div>
        </section>
      </main>

      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-t-xl border border-line bg-panel p-5 sm:rounded-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-display text-lg font-semibold">Settings</h2>
            <label htmlFor="gemini-key" className="mt-4 block text-sm text-muted">
              Gemini API key
            </label>
            <input
              id="gemini-key"
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder="Paste your Gemini API key"
              autoComplete="off"
              className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-base text-paper placeholder:text-faint"
            />
            <p className="mt-2 text-xs leading-relaxed text-faint">
              Stored only in this browser&apos;s local storage and sent with each request as a
              header. It is never saved on the server or committed anywhere. Without a key,
              CodeLens answers with lexical search only.
            </p>
            <p className="mt-2 text-sm">
              <a
                href="https://aistudio.google.com/app/apikey"
                target="_blank"
                rel="noreferrer"
                className="text-copper-soft underline underline-offset-2 hover:text-paper"
              >
                Get a free key at Google AI Studio
              </a>
            </p>
            <label htmlFor="model-select" className="mt-4 block text-sm text-muted">
              Model
            </label>
            <select
              id="model-select"
              value={modelDraft}
              onChange={(e) => setModelDraft(e.target.value as SupportedModel)}
              className="mt-1 w-full rounded-lg border border-line bg-ink px-3 py-2.5 text-base text-paper"
            >
              {SUPPORTED_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={saveSettings}
                className="min-h-11 flex-1 rounded-lg bg-copper px-4 text-sm font-semibold text-copper-ink hover:bg-copper-soft"
              >
                Save settings
              </button>
              <button
                type="button"
                onClick={() => {
                  setKeyDraft("");
                  setApiKey("");
                  try {
                    localStorage.removeItem("codelens-gemini-key");
                  } catch {
                    // ignore
                  }
                }}
                className="min-h-11 rounded-lg border border-line bg-raised px-4 text-sm text-paper hover:border-copper-deep"
              >
                Clear key
              </button>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="min-h-11 rounded-lg border border-line bg-raised px-4 text-sm text-paper hover:border-copper-deep"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
