import type { RepoIndex } from "./types";

// In-memory index per session for v1. No database, nothing persisted to disk.
// Entries live only while the server process runs.
const repos = new Map<string, RepoIndex>();

export function storeRepo(index: RepoIndex): void {
  repos.set(index.id, index);
  // Keep the map small: drop the oldest entries past 20 repos.
  if (repos.size > 20) {
    const oldest = [...repos.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) repos.delete(oldest.id);
  }
}

export function getRepo(id: string): RepoIndex | undefined {
  return repos.get(id);
}

export function listRepoIds(): string[] {
  return [...repos.keys()];
}
