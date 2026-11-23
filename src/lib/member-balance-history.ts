import { getAdminFirestore } from "@/lib/firebase-admin";
import { memberAccountName } from "@/lib/member-names.mjs";
import type { Viewer } from "@/lib/device-auth";
import { buildBalanceHistory } from "@/lib/balance-history";

export class BalanceHistoryError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "BalanceHistoryError";
  }
}

export async function readMemberBalanceHistory(memberId: string, actor: Viewer | null) {
  if (!actor) throw new BalanceHistoryError("請先登入", 401);
  if (actor.role !== "ADMIN") throw new BalanceHistoryError("只有幹部可以查看帳戶餘額紀錄", 403);
  if (!memberId || memberId !== memberId.trim() || Buffer.byteLength(memberId, "utf8") > 1500 || /[/\p{Cc}]/u.test(memberId) || [".", ".."].includes(memberId)) {
    throw new BalanceHistoryError("使用者識別碼不正確", 400);
  }

  const db = getAdminFirestore();
  return db.runTransaction(async (transaction) => {
    const [manager, member] = await transaction.getAll(db.collection("members").doc(actor.id), db.collection("members").doc(memberId));
    if (!manager.exists || manager.data()?.role !== "ADMIN") throw new BalanceHistoryError("幹部權限已變更，請重新整理", 403);
    if (!member.exists) throw new BalanceHistoryError("找不到使用者", 404);

    const [invoices, movements, audits] = await Promise.all([
      transaction.get(db.collection("invoices").where("memberId", "==", memberId)),
      transaction.get(db.collection("balanceMovements").where("memberId", "==", memberId)),
      transaction.get(db.collection("auditLogs").where("targetMemberId", "==", memberId)),
    ]);
    const eventIds = new Set<string>();
    for (const entry of [...invoices.docs, ...movements.docs]) {
      const data = entry.data();
      for (const value of [data.eventId, ...(Array.isArray(data.eventIds) ? data.eventIds : [])]) {
        if (typeof value === "string" && value && !value.includes("/")) eventIds.add(value);
      }
    }
    const events = eventIds.size ? await transaction.getAll(...[...eventIds].map((id) => db.collection("events").doc(id))) : [];
    const data = member.data()!;
    const currentBalance = Number(data.creditBalance ?? 0);
    if (!Number.isSafeInteger(currentBalance)) throw new BalanceHistoryError("帳戶餘額資料異常，請聯絡系統管理者", 500);

    return buildBalanceHistory({
      memberId,
      memberName: String(data.displayName ?? "使用者"),
      accountName: memberAccountName(data),
      currentBalance,
      invoices: invoices.docs.map((entry) => ({ id: entry.id, data: entry.data() })),
      movements: movements.docs.map((entry) => ({ id: entry.id, data: entry.data() })),
      audits: audits.docs.map((entry) => ({ id: entry.id, data: entry.data() })),
      events: events.filter((entry) => entry.exists).map((entry) => ({ id: entry.id, data: entry.data()! })),
    });
  });
}
