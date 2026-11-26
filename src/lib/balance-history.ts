import type { DocumentData } from "firebase-admin/firestore";

export type BalanceHistoryEntry = {
  id: string;
  sourceKey: string;
  amount: number;
  occurredAt: string | null;
  reason: string;
  invoiceId: string | null;
  invoiceLabel: string | null;
  eventDates: string[];
  actorName: string | null;
  source: "ledger" | "legacy";
};

export type MemberBalanceHistory = {
  memberId: string;
  memberName: string;
  accountName: string;
  currentBalance: number;
  totalIncreases: number;
  totalDecreases: number;
  unreconciledAmount: number;
  entries: BalanceHistoryEntry[];
};

type HistoryDocument = { id: string; data: DocumentData };
type HistoryInput = {
  memberId: string;
  memberName: string;
  accountName: string;
  currentBalance: number;
  invoices: HistoryDocument[];
  movements: HistoryDocument[];
  audits: HistoryDocument[];
  events: HistoryDocument[];
};

const CHARGE_TYPES = new Set(["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "SINGLE_EVENT", "MEMBER_EXTRA", "MEMBER_SINGLE"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function amount(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function data(value: unknown): DocumentData {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DocumentData : {};
}

function timestamp(value: unknown): string | null {
  try {
    const converted = value instanceof Date ? value : typeof data(value).toDate === "function" ? data(value).toDate() : value;
    if (!(converted instanceof Date) && typeof converted !== "string") return null;
    const date = converted instanceof Date ? converted : new Date(converted);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

function adjustments(invoice: DocumentData): DocumentData[] {
  return Array.isArray(invoice.adjustments) ? invoice.adjustments.map(data) : [];
}

function actorName(record: DocumentData): string | null {
  return text(record.actorName) ?? text(record.actorNameSnapshot);
}

function calendarDate(value: unknown): string | null {
  const date = timestamp(value);
  return date ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(date)) : null;
}

/** Reads evidence only. This function never recalculates or changes a member's stored balance. */
export function buildBalanceHistory(input: HistoryInput): MemberBalanceHistory {
  const invoices = input.invoices.filter((document) => document.data.memberId === input.memberId);
  const invoicesById = new Map(invoices.map((document) => [document.id, document.data]));
  const eventsById = new Map(input.events.map((document) => [document.id, document.data]));
  const entriesByKey = new Map<string, BalanceHistoryEntry>();
  const storedMovements = new Map<string, HistoryDocument>();
  const audits = input.audits.filter((document) => document.data.targetMemberId === input.memberId && document.data.action === "UPDATE_MEMBER");
  const matchedAudits = new Set<string>();
  const matchedManualMovements = new Set<string>();

  function eventDates(record: DocumentData, invoice?: DocumentData): string[] {
    const dates = new Set<string>();
    if (typeof record.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.eventDate)) dates.add(record.eventDate);
    const ids = text(record.eventId) ? [record.eventId] : Array.isArray(record.eventIds) ? record.eventIds : invoice ? (text(invoice.eventId) ? [invoice.eventId] : invoice.eventIds) : [];
    if (Array.isArray(ids)) for (const id of ids) {
      const date = calendarDate(eventsById.get(String(id))?.startsAt);
      if (date) dates.add(date);
    }
    return [...dates].sort();
  }

  function add(entry: BalanceHistoryEntry) {
    if (!Number.isSafeInteger(entry.amount) || entry.amount === 0 || entriesByKey.has(entry.sourceKey)) return;
    entriesByKey.set(entry.sourceKey, entry);
  }

  function legacy(id: string, invoice: DocumentData, key: string, delta: number, reason: string, occurredAt: string | null, record: DocumentData = invoice) {
    add({ id: "legacy:" + key, sourceKey: key, amount: delta, occurredAt, reason, invoiceId: id, invoiceLabel: text(invoice.periodLabel), eventDates: eventDates(record, invoice), actorName: actorName(record), source: "legacy" });
  }

  // A stored movement wins over reconstructed evidence for the same operation.
  for (const document of input.movements) {
    const movement = document.data;
    if (movement.memberId !== input.memberId) continue;
    const sourceKey = text(movement.sourceKey);
    const delta = amount(movement.amount);
    if (!sourceKey || delta === null || delta === 0 || entriesByKey.has(sourceKey)) continue;
    const invoiceId = text(movement.invoiceId) ?? text(movement.relatedInvoiceId);
    const invoice = invoiceId ? invoicesById.get(invoiceId) : undefined;
    add({ id: document.id, sourceKey, amount: delta, occurredAt: timestamp(movement.createdAt), reason: text(movement.reason) ?? "帳戶餘額變動", invoiceId, invoiceLabel: text(movement.invoiceLabel) ?? text(invoice?.periodLabel), eventDates: eventDates(movement, invoice), actorName: actorName(movement), source: "ledger" });
    storedMovements.set(document.id, document);
  }

  function auditDelta(audit: DocumentData): number | null {
    const before = amount(data(audit.before).creditBalance);
    const after = amount(data(audit.after).creditBalance);
    return before === null || after === null ? null : after - before;
  }

  // Old manual adjustments wrote an invoice and an audit atomically, without a shared ID.
  // Pair exact evidence one-to-one; the invoice remains the canonical source key.
  function matchingAudit(record: DocumentData, delta: number): HistoryDocument | undefined {
    const createdAt = timestamp(record.createdAt);
    if (!createdAt) return undefined;
    return audits.find((document) => {
      const audit = document.data;
      const actorId = text(record.confirmedBy) ?? text(record.actorId);
      return !matchedAudits.has(document.id)
        && timestamp(audit.createdAt) === createdAt
        && auditDelta(audit) === delta
        && (text(record.note) ?? text(record.reason)) === text(audit.note)
        && (!actorId || !text(audit.actorId) || actorId === text(audit.actorId));
    });
  }

  for (const document of invoices) {
    const invoice = document.data;
    if (invoice.type !== "ADJUSTMENT" || invoice.status !== "CONFIRMED") continue;
    const value = amount(invoice.amount);
    if (value === null || value === 0) continue;
    const delta = -value;
    const audit = matchingAudit(invoice, delta);
    if (audit) matchedAudits.add(audit.id);
    const sourceKey = `invoice:${document.id}:adjustment`;
    const movement = entriesByKey.get(sourceKey);
    if (audit && movement?.source === "ledger") matchedManualMovements.add(movement.id);
    legacy(document.id, invoice, sourceKey, delta, text(invoice.note) ?? "幹部手動餘額調整", timestamp(invoice.createdAt), { ...invoice, actorName: actorName(invoice) ?? (audit ? actorName(audit.data) : null) });
  }

  // A direct audit fallback covers adjustments whose invoice is no longer available.
  for (const document of audits) {
    if (matchedAudits.has(document.id)) continue;
    const audit = document.data;
    const delta = auditDelta(audit);
    if (delta === null || delta === 0) continue;
    const movement = [...storedMovements.values()].find((entry) => !matchedManualMovements.has(entry.id)
      && text(entry.data.sourceKey)?.endsWith(":adjustment")
      && amount(entry.data.amount) === delta
      && timestamp(entry.data.createdAt) !== null
      && timestamp(entry.data.createdAt) === timestamp(audit.createdAt)
      && text(entry.data.reason) === text(audit.note)
      && (!text(entry.data.actorId) || !text(audit.actorId) || text(entry.data.actorId) === text(audit.actorId)));
    if (movement) {
      matchedManualMovements.add(movement.id);
      continue;
    }
    const sourceKey = `audit:${document.id}:adjustment`;
    add({ id: "legacy:" + sourceKey, sourceKey, amount: delta, occurredAt: timestamp(audit.createdAt), reason: text(audit.note) ?? "幹部手動餘額調整", invoiceId: null, invoiceLabel: null, eventDates: [], actorName: actorName(audit), source: "legacy" });
  }

  for (const document of invoices) {
    const invoice = document.data;
    const id = document.id;
    const records = adjustments(invoice);
    if (invoice.type === "CREDIT") {
      if (invoice.status !== "CONFIRMED") continue;
      const recordedRefund = amount(invoice.balanceRefund);
      // A cash refund is not spendable credit. Missing split data is not guessed.
      const delta = Object.hasOwn(invoice, "balanceRefund") ? recordedRefund : (invoice.refundMode === "OFFLINE" ? null : -(amount(invoice.amount) ?? 0));
      if (delta === null || delta <= 0) continue;
      const parent = invoicesById.get(String(invoice.relatedInvoiceId));
      const confirmedAt = timestamp(invoice.confirmedAt);
      const release = parent ? adjustments(parent).find((record) => record.kind === "CREDIT_RELEASED" && confirmedAt !== null && timestamp(record.createdAt) === confirmedAt) : undefined;
      const creditRecord = records.find((record) => record.kind === "REFUND") ?? release ?? (parent ? adjustments(parent).find((record) => record.creditInvoiceId === id) : undefined);
      legacy(id, invoice, `invoice:${id}:credit`, delta, text(invoice.note) ?? text(creditRecord?.reason) ?? "退款退回帳戶餘額", confirmedAt, { ...invoice, actorName: creditRecord ? actorName(creditRecord) : null });
      continue;
    }
    if (!CHARGE_TYPES.has(String(invoice.type))) continue;

    const createdAt = timestamp(invoice.createdAt);
    const applied = amount(invoice.creditApplied) ?? 0;
    const reductionsAtCreation = records.filter((record) => record.kind === "REDUCTION" && createdAt !== null && timestamp(record.createdAt) === createdAt);
    const restoredAtCreation = reductionsAtCreation.reduce((sum, record) => sum + Math.max(0, amount(record.restoredCredit) ?? 0), 0);
    // Billing already cancelled events debited only this net amount, never two transient balances.
    const netApplied = Math.max(0, applied - restoredAtCreation);
    if (netApplied > 0) legacy(id, invoice, `invoice:${id}:apply`, -netApplied, "帳單抵用帳戶餘額", createdAt);

    for (const [index, record] of records.entries()) {
      if (record.kind !== "REDUCTION" || reductionsAtCreation.includes(record)) continue;
      const restored = amount(record.restoredCredit) ?? 0;
      if (restored <= 0) continue;
      const eventId = text(record.eventId) ?? `unrecorded-${index}`;
      legacy(id, invoice, `invoice:${id}:reduction:${eventId}`, restored, text(record.reason) ?? "活動減收，退還抵用餘額", timestamp(record.createdAt), record);
    }

    if (invoice.status === "VOID") {
      const voidRecord = records.find((record) => record.kind === "VOID" && (amount(record.restoredCredit) ?? 0) > 0);
      if (voidRecord) {
        legacy(id, invoice, `invoice:${id}:void`, amount(voidRecord.restoredCredit)!, text(voidRecord.reason) ?? "帳單作廢，退還抵用餘額", timestamp(voidRecord.createdAt) ?? timestamp(invoice.voidedAt), voidRecord);
      } else if (invoice.cancellationReason === "MEMBERSHIP_JOIN" && applied > 0) {
        legacy(id, invoice, `invoice:${id}:membership-join`, applied, "入社後退回原零打抵扣", timestamp(invoice.voidedAt ?? invoice.updatedAt));
      } else if (["SINGLE_EVENT", "MEMBER_EXTRA", "MEMBER_SINGLE"].includes(String(invoice.type)) && invoice.cancellationReason !== "ADMIN_VOID" && !invoice.replacedById && applied > 0) {
        const key = invoice.cancellationReason === "EVENT_CANCELLED" ? "event-cancel" : "cancel";
        legacy(id, invoice, `invoice:${id}:${key}`, applied, key === "event-cancel" ? "活動取消，退還抵用餘額" : "取消報名，退還抵用餘額", timestamp(invoice.cancelledAt));
      }
    } else if (invoice.status === "CREDITED" && ["SINGLE_EVENT", "MEMBER_EXTRA", "MEMBER_SINGLE"].includes(String(invoice.type))) {
      const returned = amount(invoice.grossAmount) ?? amount(invoice.amount) ?? 0;
      const key = invoice.cancellationReason === "EVENT_CANCELLED" ? "event-cancel" : "cancel";
      if (returned > 0) legacy(id, invoice, `invoice:${id}:${key}`, returned, key === "event-cancel" ? "活動取消，費用退回餘額" : "取消報名，費用退回餘額", timestamp(invoice.cancelledAt));
    }
    // REISSUED / REPORT_REJECTED omit the historical restored credit amount.
    // Their invoice amount changes cannot safely be interpreted as balance changes.
  }

  const entries = [...entriesByKey.values()].sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? "") || a.sourceKey.localeCompare(b.sourceKey));
  const totalIncreases = entries.reduce((sum, entry) => sum + Math.max(0, entry.amount), 0);
  const totalDecreases = entries.reduce((sum, entry) => sum + Math.max(0, -entry.amount), 0);
  return { memberId: input.memberId, memberName: input.memberName, accountName: input.accountName, currentBalance: input.currentBalance, totalIncreases, totalDecreases, unreconciledAmount: input.currentBalance - (totalIncreases - totalDecreases), entries };
}
