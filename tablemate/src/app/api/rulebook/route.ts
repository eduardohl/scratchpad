import { NextResponse } from "next/server";
import { uploadRulebook } from "@/lib/claude";
import { errorResponse } from "../http";

export const maxDuration = 60;

const MAX_BYTES = 30 * 1024 * 1024;

export async function POST(req: Request) {
  let file: FormDataEntryValue | null;
  try {
    file = (await req.formData()).get("file");
  } catch {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  }
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing file." }, { status: 400 });
  if (file.type !== "application/pdf") return NextResponse.json({ error: "Rulebook must be a PDF." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "Rulebook PDF is too large (30 MB max)." }, { status: 413 });
  try {
    return NextResponse.json({ fileId: await uploadRulebook(file), name: file.name });
  } catch (err) {
    return errorResponse(err);
  }
}
