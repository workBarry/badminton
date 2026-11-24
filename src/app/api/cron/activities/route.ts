export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ error: "請在活動管理的季度規劃確認建立活動" }, { status: 410 });
}
