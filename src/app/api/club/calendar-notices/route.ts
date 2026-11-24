import { fetchCalendarNotices } from "@/lib/official-closures";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const month = new URL(request.url).searchParams.get("month") ?? "";
  const result = await fetchCalendarNotices(month);
  if (!result) {
    return Response.json({ error: "月份格式不正確，請使用 YYYY-MM。" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const cache = result.unavailable.length === 0 ? "public, s-maxage=60" : "no-store";
  return Response.json(result, { headers: { "Cache-Control": cache } });
}
