import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiKeyError, runAgent } from "@/lib/agent/run";
import { lexicalAnswer } from "@/lib/agent/lexicalAnswer";
import { getRepo } from "@/lib/store";
import { DEFAULT_MODEL, SUPPORTED_MODELS } from "@/lib/types";

const BodySchema = z.object({
  repoId: z
    .string({ error: "Load a repo first — I never answer from general knowledge." })
    .min(1, "Load a repo first — I never answer from general knowledge."),
  question: z
    .string({ error: "Ask a question first." })
    .min(1, "Ask a question first.")
    .max(2000),
  model: z.enum(SUPPORTED_MODELS).optional(),
  // The file the user currently has open in the code viewer, so
  // "this file" in a question resolves to it. null is accepted too.
  contextFile: z.string().max(500).nullish(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }

  const index = getRepo(parsed.data.repoId);
  if (!index) {
    return NextResponse.json(
      { error: "No repo is loaded for this session. Load a repo first — I never answer from general knowledge." },
      { status: 404 },
    );
  }

  const model = parsed.data.model ?? DEFAULT_MODEL;
  const contextFile = parsed.data.contextFile ?? undefined;
  const apiKey =
    req.headers.get("x-gemini-api-key")?.trim() || process.env.GEMINI_API_KEY?.trim() || "";

  // Decided behaviour, applied consistently: without a key, /api/ask answers
  // with the deterministic lexical fallback (keyword search + citations),
  // never with a missing-key error. A key unlocks the Gemini agent.
  if (!apiKey) {
    const result = await lexicalAnswer(index, parsed.data.question, contextFile);
    return NextResponse.json(result);
  }

  try {
    const result = await runAgent(index, parsed.data.question, apiKey, model, contextFile);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ApiKeyError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    // Any other agent failure falls back to lexical so the user still gets
    // a grounded answer instead of a dead end.
    const fallback = await lexicalAnswer(index, parsed.data.question, contextFile);
    fallback.note =
      "The Gemini agent failed, so this is the lexical fallback answer built from keyword search.";
    return NextResponse.json(fallback);
  }
}
