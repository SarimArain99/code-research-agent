import { NextResponse } from "next/server";
import { z } from "zod";
import { autoReview } from "@/lib/agent/autoReview";
import { getRepo } from "@/lib/store";

const BodySchema = z.object({
  repoId: z
    .string({ error: "Load a repo first — Auto Review needs a loaded repo." })
    .min(1, "Load a repo first — Auto Review needs a loaded repo."),
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
      { error: "No repo is loaded for this session. Load a repo first — Auto Review needs a loaded repo." },
      { status: 404 },
    );
  }

  // Deterministic scan, no Gemini key and no API calls.
  return NextResponse.json(autoReview(index));
}
