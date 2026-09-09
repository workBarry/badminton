import { randomUUID } from "crypto";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase-admin";
import type { Viewer } from "@/lib/device-auth";
import { effectiveInvoiceAmounts, reduceUnpaidInvoice, validCalendarDate } from "@/lib/quarter-planning";
const TYPES = ["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "SINGLE_EVENT", "MEMBER_EXTRA"];
function eventIds(data: DocumentData): string[] { return Array.isArray(data.eventIds) ? data.eventIds.map(String) : data.eventId ? [String(data.eventId)] : []; }

export async function manageInvoice(action: string, input: Record<string, string>, actor: Viewer) {
  if (actor.role !== "ADMIN") throw new Error("只有幹部可以管理帳單");
  if (!input.invoiceId || input.invoiceId.includes("/")) throw new Error("帳單識別碼不正確");
  const reason = input.reason?.trim();
  if (!reason || reason.length > 200) throw new Error("請填寫原因（最多 200 字）");
  if (!["voidInvoice", "reissueInvoice", "refundInvoice", "rejectPaymentReport"].includes(action)) throw new Error("不支援的帳單操作");
  const db = getAdminFirestore();
  const ref = db.collection("invoices").doc(input.invoiceId);
  const replacementRef = db.collection("invoices").doc("reissue-" + randomUUID());
  return db.runTransaction(async (transaction) => {
    const original = await transaction.get(ref);
    if (!original.exists) throw new Error("找不到帳單");
    const data = original.data()!;
    if (!TYPES.includes(data.type)) throw new Error("退款與調整紀錄不能作廢或重開");
    if (action === "voidInvoice" && data.status === "VOID") return { status: "VOID", invoiceId: ref.id };
    if (action === "reissueInvoice" && data.replacedById) return { status: "REISSUED", invoiceId: String(data.replacedById) };
    if (action === "refundInvoice" && data.status === "REFUNDED") return { status: "REFUNDED", invoiceId: ref.id };
    const effective = effectiveInvoiceAmounts(data);
    if (input.expectedStatus !== data.status || Number(input.expectedAmount) !== effective.amount) throw new Error("帳單狀態或金額已變更，請重新開啟帳單");
    const memberRef = db.collection("members").doc(String(data.memberId));
    const [member, related] = await Promise.all([transaction.get(memberRef), transaction.get(db.collection("invoices").where("relatedInvoiceId", "==", ref.id))]);
    if (!member.exists) throw new Error("找不到帳單使用者");
    const now = new Date();
    const audit = { reason, actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() };
    const notify = (message: string) => transaction.create(db.collection("notifications").doc(), { title: "帳單異動", message, type: "PAYMENT", tab: "費用管理", audience: "USER", recipientId: String(data.memberId), createdAt: now, updatedAt: now });

    if (action === "rejectPaymentReport") {
      if (data.status !== "REPORTED" || input.checkedNotReceived !== "true") throw new Error("請先確認尚未收到此筆轉帳");
      const pendingCredits = related.docs.filter((doc) => doc.data().status === "AWAITING_PAYMENT_CONFIRMATION");
      const reduction = pendingCredits.reduce((sum, doc) => sum - Number(doc.data().amount), 0);
      const reduced = reduceUnpaidInvoice(data, reduction);
      const { restoredCredit, ...amounts } = reduced;
      for (const credit of pendingCredits) transaction.update(credit.ref, { status: "VOID", voidReason: "轉帳未入帳，改由原單減收", updatedAt: now });
      transaction.update(ref, { ...amounts, status: reduced.adjustedAmount === 0 ? "CONFIRMED" : "PENDING", reportedAt: null, confirmedAt: reduced.adjustedAmount === 0 ? now : null, updatedAt: now, adjustments: FieldValue.arrayUnion({ ...audit, kind: "REPORT_REJECTED", amount: -reduction, beforeAmount: effective.amount, afterAmount: reduced.adjustedAmount }) });
      if (restoredCredit > 0) transaction.update(memberRef, { creditBalance: FieldValue.increment(restoredCredit), updatedAt: now });
      notify("幹部核對未入帳，帳單已退回待繳；原因：" + reason);
      return { status: "REPORT_REJECTED", invoiceId: ref.id };
    }
    if (action === "refundInvoice") {
      if (data.status !== "CONFIRMED") throw new Error("只有已確認收款的帳單可以退款");
      const refunded = related.docs.filter((doc) => doc.data().type === "CREDIT" && ["CONFIRMED", "AWAITING_PAYMENT_CONFIRMATION"].includes(doc.data().status)).reduce((sum, doc) => sum + Math.max(0, -Number(doc.data().amount)), 0);
      const remaining = Math.max(0, effective.grossAmount - refunded);
      if (remaining <= 0) throw new Error("此帳單已無可退金額");
      if (Number(input.expectedRefundable) !== remaining) throw new Error("可退金額已變更，請重新開啟帳單");
      if (!["BALANCE", "OFFLINE"].includes(input.refundMode)) throw new Error("請選擇退款方式");
      if (input.refundMode === "OFFLINE" && input.offlineRefunded !== "true") throw new Error("請先確認已完成人工退款");
      const cashRefund = input.refundMode === "OFFLINE" ? Math.min(remaining, effective.amount) : 0;
      const balanceRefund = remaining - cashRefund;
      const creditRef = db.collection("invoices").doc("refund-" + ref.id);
      transaction.create(creditRef, { id: creditRef.id, memberId: data.memberId, memberNameSnapshot: data.memberNameSnapshot, relatedInvoiceId: ref.id, type: "CREDIT", grossAmount: -remaining, creditApplied: 0, amount: -remaining, status: "CONFIRMED", periodId: data.periodId ?? data.relatedPeriodId ?? null, periodLabel: data.periodLabel ?? "帳單退款", eventIds: eventIds(data), refundMode: input.refundMode, cashRefund, balanceRefund, adjustments: [{ ...audit, kind: "REFUND", amount: -remaining }], confirmedAt: now, createdAt: now, updatedAt: now });
      transaction.update(ref, { status: "REFUNDED", refundMode: input.refundMode, refundedAt: now, updatedAt: now, adjustments: FieldValue.arrayUnion({ ...audit, kind: "REFUND", amount: -remaining, cashRefund, balanceRefund }) });
      if (balanceRefund > 0) transaction.update(memberRef, { creditBalance: FieldValue.increment(balanceRefund), updatedAt: now });
      notify("帳單退款 NT$" + remaining + "；退回餘額 NT$" + balanceRefund + "、人工退款 NT$" + cashRefund + "。原因：" + reason);
      return { status: "REFUNDED", invoiceId: ref.id, balanceRefund, cashRefund };
    }
    if (action === "voidInvoice") {
      if (data.status !== "PENDING") throw new Error("只有未繳帳單可以直接作廢；已回報或收款請先核對／退款");
      transaction.update(ref, { status: "VOID", voidReason: reason, cancellationReason: "ADMIN_VOID", voidedAt: now, voidedBy: actor.id, updatedAt: now, adjustments: FieldValue.arrayUnion({ ...audit, kind: "VOID", amount: -effective.amount, restoredCredit: effective.creditApplied }) });
      if (effective.creditApplied > 0) transaction.update(memberRef, { creditBalance: FieldValue.increment(effective.creditApplied), updatedAt: now });
      notify("帳單已作廢，活動與報名仍保留。原因：" + reason);
      return { status: "VOID", invoiceId: ref.id };
    }
    if (data.status !== "PENDING" && !(data.status === "VOID" && data.cancellationReason === "ADMIN_VOID")) throw new Error("僅未繳或幹部作廢的帳單可重開");
    const ids = eventIds(data);
    const events = ids.length ? await transaction.getAll(...ids.map((id) => db.collection("events").doc(id))) : [];
    let amounts: number[];
    try { amounts = JSON.parse(input.eventAmounts || ""); } catch { throw new Error("請填寫重開帳單各項金額"); }
    if (!Array.isArray(amounts) || amounts.length !== Math.max(ids.length, 1) || amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0 || amount > 1000000)) throw new Error("重開金額須為 0 至 1,000,000 的整數元，且項目數需符合原單");
    events.forEach((event, index) => { if ((!event.exists || event.data()?.status === "CANCELLED") && amounts[index] !== 0) throw new Error("已取消或不存在的場次不能重新收費"); });
    const grossAmount = amounts.reduce((sum, amount) => sum + amount, 0);
    if (grossAmount <= 0) throw new Error("總金額需大於 0；免收請直接作廢帳單");
    if (!validCalendarDate(input.dueDate)) throw new Error("請填寫正確的繳費期限");
    const dueAt = new Date(input.dueDate + "T23:59:59.999+08:00");
    if (dueAt < now) throw new Error("繳費期限不能早於今天");
    const restoredCredit = data.status === "PENDING" ? effective.creditApplied : 0;
    const creditApplied = Math.min(grossAmount, Number(member.data()?.creditBalance ?? 0) + restoredCredit);
    const amount = grossAmount - creditApplied;
    transaction.create(replacementRef, { id: replacementRef.id, memberId: data.memberId, memberNameSnapshot: data.memberNameSnapshot ?? member.data()?.displayName, type: data.type, eventId: data.eventId ?? null, eventIds: ids, eventAmounts: ids.length ? amounts : [], eventSnapshots: data.eventSnapshots ?? [], periodId: data.periodId ?? null, relatedPeriodId: data.relatedPeriodId ?? null, periodLabel: data.periodLabel ?? "重開帳單", baselineEventCount: data.baselineEventCount ?? ids.length, baselineGrossAmount: data.baselineGrossAmount ?? data.grossAmount ?? effective.grossAmount, baselineEventAmounts: data.baselineEventAmounts ?? data.eventAmounts ?? [], grossAmount, creditApplied, amount, dueAt, status: amount === 0 ? "CONFIRMED" : "PENDING", confirmedAt: amount === 0 ? now : null, reportedAt: null, replacementOfId: ref.id, adjustments: [{ ...audit, kind: "REISSUE", amount: grossAmount - effective.grossAmount, previousGrossAmount: effective.grossAmount }], createdAt: now, updatedAt: now });
    transaction.update(ref, { status: "VOID", cancellationReason: "ADMIN_VOID", voidReason: reason, replacedById: replacementRef.id, voidedAt: now, updatedAt: now, adjustments: FieldValue.arrayUnion({ ...audit, kind: "REISSUED", amount: -effective.amount, replacementId: replacementRef.id }) });
    transaction.update(memberRef, { creditBalance: FieldValue.increment(restoredCredit - creditApplied), updatedAt: now });
    notify("帳單已作廢重開，新單應付 NT$" + amount + "；原因：" + reason);
    return { status: "REISSUED", invoiceId: replacementRef.id };
  });
}

export async function voidInvoiceBatch(input: Record<string, string>, actor: Viewer) {
  if (actor.role !== "ADMIN") throw new Error("只有幹部可以批次作廢");
  if (!input.reason?.trim() || input.reason.length > 200) throw new Error("請填寫作廢原因（最多 200 字）");
  let entries: { id: string; amount: number }[];
  try { entries = JSON.parse(input.invoices || ""); } catch { throw new Error("批次帳單格式不正確"); }
  if (!Array.isArray(entries) || !entries.length || entries.length > 100 || new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("每批請選擇 1 至 100 筆不同帳單");
  const results = [];
  for (const entry of entries) {
    try { await manageInvoice("voidInvoice", { invoiceId: entry.id, reason: input.reason, expectedStatus: "PENDING", expectedAmount: String(entry.amount) }, actor); results.push({ id: entry.id, success: true }); }
    catch (error) { results.push({ id: entry.id, success: false, error: error instanceof Error ? error.message : "作廢失敗" }); }
  }
  return { results };
}
