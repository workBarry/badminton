export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ error: "已改用季度草稿確認流程，自動建立正式活動已停用" }, { status: 410 });
}
