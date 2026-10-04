import { ask } from "@/lib/claude";
import { AskRequestSchema } from "@/lib/requests";
import { errorResponse, readJson } from "../http";

export const maxDuration = 60;

export async function POST(req: Request) {
  const body = await readJson(req, AskRequestSchema);
  if ("error" in body) return body.error;
  try {
    return new Response(await ask(body.data), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
