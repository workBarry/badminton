import { mutate, readState } from "@/lib/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(await readState());
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: string } & Record<string, string>;
    if (!body.action) return Response.json({ error: "缺少操作類型" }, { status: 400 });
    await mutate(body.action, body);
    return Response.json(await readState());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "資料庫操作失敗" }, { status: 400 });
  }
}
