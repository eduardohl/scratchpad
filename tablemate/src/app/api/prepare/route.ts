import { NextResponse } from "next/server";
import { prepareGame } from "@/lib/claude";
import { GameConfigSchema } from "@/lib/requests";
import { errorResponse, readJson } from "../http";

export const maxDuration = 120;

export async function POST(req: Request) {
  const body = await readJson(req, GameConfigSchema);
  if ("error" in body) return body.error;
  try {
    return NextResponse.json({ brief: await prepareGame(body.data) });
  } catch (err) {
    return errorResponse(err);
  }
}
