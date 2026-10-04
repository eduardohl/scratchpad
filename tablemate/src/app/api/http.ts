import { NextResponse } from "next/server";
import type { z } from "zod";
import { describeError } from "@/lib/claude";

export async function readJson<T>(req: Request, schema: z.ZodType<T>): Promise<{ data: T } | { error: NextResponse }> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { error: NextResponse.json({ error: "Body must be JSON." }, { status: 400 }) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { error: NextResponse.json({ error: "Invalid request.", issues: parsed.error.issues.slice(0, 5) }, { status: 400 }) };
  }
  return { data: parsed.data };
}

export function errorResponse(err: unknown): NextResponse {
  console.error(err);
  const { status, message } = describeError(err);
  return NextResponse.json({ error: message }, { status });
}
