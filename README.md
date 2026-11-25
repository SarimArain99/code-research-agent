# CodeLens — Code Research Agent

Ask a codebase questions, get answers grounded in the code itself — with a
`file:line` citation for every claim. Load any public GitHub repo, or try the
demo repo. Ask in English or Urdu.

## What it is

CodeLens is a developer tool, not a chatbot. It never answers from general
knowledge: every answer comes from code it actually read from the repo you
loaded. If the repo does not contain the answer, it says so.

Two modes:

- **Gemini agent (with a key):** a LangChain.js v1 `createAgent()` loop
  (LangGraph-backed) with four tools — `search_code`, `read_file`,
  `list_files`, `find_symbol` — answers with citations and shows every tool
  call it made.
- **Lexical mode (no key):** the same questions are answered deterministically
  from keyword search over the indexed chunks, with the same `file:line`
  citations and Sources panel, labelled as lexical so nobody mistakes it for
  an AI summary. Lexical answers are short on purpose — a direct statement
  first, then at most four one-line evidence bullets, never a dump of raw
  code. “Where is X used?” is traced for real: it lists the files that
  import X with the exact import line. “What does X do?” reports what the
  file exports (plus the package description for the entry point). With a
  file open in the code viewer, “this file” means that file, and two buttons
  ask those two questions for it directly.

## Stack

- Next.js 15 (App Router), TypeScript strict, Tailwind CSS 4, React 19
- LangChain.js **1.6** — `createAgent({ model, tools, systemPrompt })` from
  `langchain` (LangGraph-backed). No `AgentExecutor`, no `createToolCallingAgent`,
  no `LLMChain` anywhere.
- `@langchain/google-genai` **2.3.6** — `ChatGoogleGenerativeAI` +
  `GoogleGenerativeAIEmbeddings` (`text-embedding-004`)
- `@langchain/textsplitters` — `RecursiveCharacterTextSplitter`
  (chunk 1000 chars, overlap 200, metadata: file path + start line)
- `@langchain/classic` — `MemoryVectorStore` (in v1 the vector stores live in
  the classic/legacy package; import from
  `@langchain/classic/vectorstores/memory`)
- Zod for request validation. No database: indexed repos live in a server-side
  in-memory `Map` keyed by a repo id returned from `/api/load-repo`.

All `@langchain/*` packages share `@langchain/core` **1.5.1** (verified with
`npm ls`). Verified API notes: in LangChain.js 1.6 the system prompt param is
`systemPrompt` (not `prompt`); the embeddings constructor takes `model`
(not `modelName`); `createAgent` is invoked with
`{ messages: [{ role: "user", content }] }`.

## Run locally

```bash
npm install
npm run dev        # http://localhost:3000
# or
npm run build && npm start
```

## Get a Gemini key (free)

1. Open https://aistudio.google.com/app/apikey and create a key.
2. In CodeLens, open **Settings**, paste the key, pick a model, save.
3. The key is stored only in your browser's `localStorage` and sent per
   request as the `x-gemini-api-key` header. It is never stored server-side,
   never logged, never committed. You can also set `GEMINI_API_KEY` in a local
   `.env` file instead (see `.env.example`); the header key takes precedence
   when both are present.

Models: `gemini-2.5-flash` (default), `gemini-2.5-pro`, `gemini-2.0-flash`.

Without a key, loading still works and questions are answered in lexical mode.
With an invalid key, `/api/ask` returns HTTP 401 with the exact fix (check the
key in Settings, get one at the AI Studio link above).

## How to use it

1. Paste a public GitHub URL (`https://github.com/owner/repo`, optional
   `/tree/branch`) and click **Load repo**, or click **Try demo repo**.
2. Pick a suggested question (generated from the repo's actual file list) or
   type your own.
3. Read the answer, expand **Agent steps** to see the tool calls, and click any
   citation or source to open that file at that line in the code viewer.
4. Browse files in the explorer sidebar; filter by name.

## Demo repo (verified)

`sindresorhus/p-limit` (`main` branch, JavaScript, 16 files, ~49 KB) —
verified against the GitHub API before wiring it in. Loading it indexes
**16 files into 70 chunks**, not truncated. Example questions that work:

1. Where is the main entry point defined, and what does `index.js` do?
2. What does this project do, according to the README?
3. Where are the tests, and what do they cover?

Expected lexical-mode behaviour for question 1: an answer listing matching
snippets with citations such as `readme.md:1`, `index.d.ts:64`,
`index.js:1` (exact top hits vary with the query wording; every citation is a
real file and line in the repo). With a Gemini key, the agent instead writes a
short summary citing the same files.

## Limits

- Public repos only, unauthenticated GitHub API (rate limits apply).
- Max **300 files**, max **~2 MB total**, max **200 KB per file**. Text files
  only: `node_modules`, `.git`, `dist`, `build`, lockfiles, binaries, images
  and minified files are skipped. When the cap bites, the UI says how many
  files were found vs indexed.
- Embeddings cap: first 400 chunks are embedded when a key is present.
- `read_file` is capped at 400 lines per call.
- Indexes live in server memory only (max 20 repos, oldest evicted) and are
  lost when the server restarts. There is no persistence, no auth, no sharing.
- The agent answers only about the loaded repo. Asking with no repo loaded
  returns HTTP 404 and the UI refuses instead of guessing.
- Lexical mode is keyword search plus deterministic tracing: usage and
  “what does it do” questions are answered from real imports/exports, but
  open-ended questions still rank by keyword overlap, so a very common word
  can surface README hits above the definition site. Add a key for agent
  answers.

## Design

Palette: **Copper Lens** — deep ink-charcoal base `#0E1116`, panels `#161B23`
/ `#1C232E`, warm off-white text `#ECE9E2`, one burnt-copper accent `#E07856`
(dark text `#20100A` on copper buttons). Chosen because it is a warm,
instrument-like developer-tool palette that is distinct from the retired
sea-green/white/black combination and from the Signal Amber used on the
portfolio; copper reads as a lens/optics accent without any purple-to-blue
gradient. Type: Space Grotesk (display) + Inter (UI), as in the Physical AI
book. Hallmark Floor applied; `sloplint --tier floor` is clean
(0 FAIL, 0 REFLEX, 0 WARN) on the static check. Responsive: no horizontal
scroll at 320 px (verified in headless Chromium at 320/375/768/1440).

## API

- `POST /api/load-repo` — `{ url }` → repo id, file list, chunk count,
  embedded flag, truncation note, suggested questions. Optional
  `x-gemini-api-key` header enables embeddings at load time.
- `POST /api/ask` — `{ repoId, question, model? }` → `{ answer, mode, steps,
  sources, model, note }`. Plain JSON (no streaming in v1). Without a key it
  returns the lexical answer; with an invalid key, HTTP 401.
- `GET /api/file?repoId=…&path=…` — one file's content for the code viewer.

## What is NOT built yet

- Streaming answers; multi-turn chat memory (each question is independent).
- Private repos / GitHub auth; persisting indexes across restarts.
- Symbol index / call-graph / cross-repo search; test running.
- Deployment of any kind (no Vercel, no GitHub push in this build).

## Verified (2026-11-25, local)

- `npm install` and `npm run build` pass with zero TypeScript errors, zero
  `any`, zero `ts-ignore`.
- Live end-to-end on the production build: `POST /api/load-repo` for
  `sindresorhus/p-limit` → 16 files, 70 chunks, not truncated; `POST /api/ask`
  without a key → lexical answer with real citations (`readme.md:102`,
  `index.d.ts:64`, `index.js:1`, `test.js:1`…); Urdu question
  ("test.js mein kya test kiya gaya hai?") → `test.js` citations at lines
  1/35/71/109/143/178; invalid key → HTTP 401 with the exact fix; bad URL →
  HTTP 400; ask with no repo → HTTP 404; `GET /api/file` returns real file
  content. UI flow verified in headless Chromium: demo load, suggested
  question, answer with Sources panel, citation click opens `index.js` at the
  cited line with highlighting.
- **Not verified (needs a real Gemini key): the LLM agent path.**
  `createAgent` + Gemini has not been run end to end here because no key was
  available. To verify: add a key in Settings, load the demo repo, ask
  "Where is pLimit defined?" and confirm the answer cites `index.js` and the
  Agent steps panel lists `search_code` / `read_file` calls.
