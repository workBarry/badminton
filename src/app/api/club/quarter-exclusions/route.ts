import { NextRequest, NextResponse } from "next/server";
import { DEVICE_COOKIE, viewerForDeviceToken } from "@/lib/device-auth";
import { fetchOfficialClosures } from "@/lib/official-closures";
import { validateQuarterDateRange } from "@/lib/quarter-planning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" };
  const viewer = await viewerForDeviceToken(request.cookies.get(DEVICE_COOKIE)?.value);
  if (!viewer) return NextResponse.json({ error: "請先登入再產生建議活動" }, { status: 401, headers });
  if (viewer.role !== "ADMIN") return NextResponse.json({ error: "只有幹部可以規劃季度活動" }, { status: 403, headers });

  const startDate = request.nextUrl.searchParams.get("startDate") ?? "";
  const endDate = request.nextUrl.searchParams.get("endDate") ?? "";
  try {
    validateQuarterDateRange(startDate, endDate);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "季度日期不正確" }, { status: 400, headers });
  }

  try {
    return NextResponse.json({ closures: await fetchOfficialClosures(startDate, endDate) }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "無法取得政府假日資料，請稍後再試";
    return NextResponse.json({ error: message }, { status: 502, headers });
  }
}
