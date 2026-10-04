import { NextResponse } from "next/server";
import { listen } from "@/lib/claude";
import { ListenRequestSchema } from "@/lib/requests";
import { errorResponse, readJson } from "../http";

export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await readJson(req, ListenRequestSchema);
  if ("error" in body) return body.error;
  try {
    return NextResponse.json(await listen(body.data));
  } catch (err) {
    return errorResponse(err);
  }
}
