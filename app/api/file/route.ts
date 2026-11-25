import { NextResponse } from "next/server";
import { getRepo } from "@/lib/store";

/** GET /api/file?repoId=…&path=… — returns one file's content for the code viewer. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const repoId = searchParams.get("repoId") ?? "";
  const path = searchParams.get("path") ?? "";
  const index = getRepo(repoId);
  if (!index) {
    return NextResponse.json({ error: "Repo not loaded." }, { status: 404 });
  }
  const file = index.files.find((f) => f.path === path);
  if (!file) {
    return NextResponse.json({ error: "File not found in this repo." }, { status: 404 });
  }
  return NextResponse.json({ path: file.path, content: file.content });
}
