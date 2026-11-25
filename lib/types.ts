import type { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";

export interface RepoFile {
  path: string;
  content: string;
}

export interface CodeChunk {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface SearchHit {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
  kind: "vector" | "lexical";
}

export interface RepoIndex {
  id: string;
  owner: string;
  repo: string;
  branch: string;
  url: string;
  files: RepoFile[];
  chunks: CodeChunk[];
  vectorStore: MemoryVectorStore | null;
  embedded: boolean;
  truncated: boolean;
  totalFound: number;
  totalBytes: number;
  createdAt: number;
}

export interface AgentStep {
  tool: string;
  input: string;
  output: string;
}

export interface SourceRef {
  file: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface AnswerResult {
  answer: string;
  mode: "agent" | "lexical";
  steps: AgentStep[];
  sources: SourceRef[];
  model: string | null;
  note: string | null;
}

export const SUPPORTED_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export const DEFAULT_MODEL: SupportedModel = "gemini-2.5-flash";

export const DEMO_REPO_URL = "https://github.com/sindresorhus/p-limit";
