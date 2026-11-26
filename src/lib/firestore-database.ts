import { createHash, randomUUID } from "crypto";
import { isClubPresident, PRESIDENT_EXIT_MESSAGE } from "@/lib/club-roles";
import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase-admin";
import { recordBalanceMovement } from "@/lib/balance-ledger";
import { memberAccountName, readMemberName, reserveMemberName, validatedAccountName, validatedDisplayName } from "@/lib/member-names.mjs";
import { createClaimCodeRecord, type Viewer } from "@/lib/device-auth";
import { manageInvoice, voidInvoiceBatch } from "@/lib/invoice-management";
import { fetchOfficialClosures } from "@/lib/official-closures";
import { validateQuarterSchedule, validateQuarterDateRange, effectiveInvoiceAmounts, invoiceCoversEvent, reduceUnpaidInvoice, validCalendarDate, type QuarterBillingPeriod, type QuarterRules, type SuggestedActivity } from "@/lib/quarter-planning";

type StoredDate = Timestamp | Date | string | null | undefined;
type InvoiceReceipt = {
  method: "CASH" | "BANK";
  receivedDate: string;
  amount: number;
  note: string | null;
  recordedBy: string;
  recordedByName: string;
  recordedAt: Date;
};

function dateValue(value: StoredDate) {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string") return new Date(value);
  return null;
}

function iso(value: StoredDate) {
  return dateValue(value)?.toISOString() ?? null;
}

function taipeiDate(value: StoredDate) {
  const date = dateValue(value);
  if (!date || Number.isNaN(date.getTime())) throw new Error("日期格式不正確");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}



async function activeFee(db: Firestore, kind: "MEMBER_VISIT" | "GUEST_VISIT", at: Date) {
  const snapshot = await db.collection("feeRates").where("kind", "==", kind).get();
  const matching = snapshot.docs
    .map((document) => document.data())
    .filter((rate) => {
      const from = dateValue(rate.effectiveFrom);
      const to = dateValue(rate.effectiveTo);
      return from && from <= at && (!to || to > at);
    })
    .sort((a, b) => (dateValue(b.effectiveFrom)?.getTime() ?? 0) - (dateValue(a.effectiveFrom)?.getTime() ?? 0));
  return Number(matching[0]?.amount ?? (kind === "MEMBER_VISIT" ? 150 : 180));
}

function bookingPriority(booking: DocumentData) {
  return booking.kindSnapshot === "MEMBER" ? 0 : 1;
}

function isBadmintonEvent(event: DocumentData) {
  return event.eventKind !== "OTHER";
}

// The on/off setting is independent of previously issued fee snapshots and
// the event's quarterly or single-session classification.
function eventAllowsNewBilling(event: DocumentData) {
  return event.billingPaused !== true &&
    (isBadmintonEvent(event) ? event.memberBilling !== "FREE" : event.memberBilling === "NORMAL");
}

function isQuarterEligibleEvent(event: DocumentData) {
  return isBadmintonEvent(event) && eventAllowsNewBilling(event) && event.status !== "CANCELLED"
    && (event.memberBilling == null || event.memberBilling === "NORMAL");
}

function quarterPeriodForDate(periods: FirebaseFirestore.QueryDocumentSnapshot[], date: string, statuses: string[]) {
  return periods.find((period) => {
    const data = period.data();
    return statuses.includes(String(data.status)) && String(data.startDate) <= date && String(data.endDate) >= date;
  });
}

function addQuarterChargeCoverage(coverage: Set<string>, data: DocumentData) {
  if (!["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "MEMBER_EXTRA"].includes(data.type)) return;
  if (data.eventId) coverage.add(String(data.eventId));
  if (Array.isArray(data.eventIds)) for (const eventId of data.eventIds) coverage.add(String(eventId));
}

function memberAt(member: DocumentData, at: Date) {
  if (isClubPresident(member)) return true;
  const memberSince = dateValue(member.memberSince);
  if (memberSince && memberSince > at) return false;
  if (member.membershipStatus === "MEMBER") return true;
  const endingAt = dateValue(member.endingAt);
  return member.membershipStatus === "EXITING" && Boolean(endingAt && endingAt >= at);
}

const MEMBER_DEFAULTS_VERSION = 1;

function defaultMemberBooking(eventId: string, memberId: string, member: DocumentData, now: Date) {
  return {
    id: `${eventId}-${memberId}`,
    eventId,
    memberId,
    displayNameSnapshot: String(member.displayName ?? "未知使用者"),
    accountNameSnapshot: memberAccountName(member),
    kindSnapshot: "MEMBER",
    status: "REGULAR",
    confirmedAt: now,
    autoEnrolledAt: now,
    attendanceSource: "MEMBER_DEFAULT",
    cancelledAt: null,
    updatedAt: now,
  };
}

async function ensureMemberFutureBookings(memberId: string) {
  const db = getAdminFirestore();
  const now = new Date();
  const [memberSnapshot, eventSnapshot] = await Promise.all([
    db.collection("members").doc(memberId).get(),
    db.collection("events").get(),
  ]);
  if (!memberSnapshot.exists) return;
  const member = memberSnapshot.data()!;

  for (const eventDocument of eventSnapshot.docs) {
    const eventData = eventDocument.data();
    const startsAt = dateValue(eventData.startsAt);
    if (eventData.status !== "SCHEDULED" || !startsAt || startsAt <= now || !memberAt(member, startsAt)) continue;
    const bookingRef = eventDocument.ref.collection("bookings").doc(memberId);
    await db.runTransaction(async (transaction) => {
      const [freshEvent, booking] = await transaction.getAll(eventDocument.ref, bookingRef);
      if (!freshEvent.exists || freshEvent.data()?.status !== "SCHEDULED") return;
      const freshStartsAt = dateValue(freshEvent.data()?.startsAt);
      if (!freshStartsAt || freshStartsAt <= now || !memberAt(member, freshStartsAt)) return;
      if (!isBadmintonEvent(freshEvent.data()!)) {
        if (booking.exists && ["REGULAR", "STANDBY"].includes(String(booking.data()?.status)) && booking.data()?.kindSnapshot !== "MEMBER") {
          transaction.update(bookingRef, { kindSnapshot: "MEMBER", updatedAt: now });
        }
        return;
      }
      if (booking.exists) {
        const status = String(booking.data()?.status ?? "");
        if (status === "STANDBY") {
          transaction.update(bookingRef, { kindSnapshot: "MEMBER", status: "REGULAR", promotedAt: now, updatedAt: now });
          transaction.update(eventDocument.ref, {
            regularCount: FieldValue.increment(1),
            standbyCount: FieldValue.increment(-1),
            updatedAt: now,
          });
        } else if (status === "REGULAR" && booking.data()?.kindSnapshot !== "MEMBER") {
          transaction.update(bookingRef, { kindSnapshot: "MEMBER", updatedAt: now });
        }
        return;
      }
      transaction.create(bookingRef, defaultMemberBooking(eventDocument.id, memberId, member, now));
      transaction.update(eventDocument.ref, { regularCount: FieldValue.increment(1), updatedAt: now });
    });
  }
}

async function backfillDefaultMemberBookings() {
  const db = getAdminFirestore();
  const now = new Date();
  const eventSnapshot = await db.collection("events").get();
  const events = eventSnapshot.docs.filter((document) => {
    const event = document.data();
    const startsAt = dateValue(event.startsAt);
    return isBadmintonEvent(event) && event.status === "SCHEDULED"
      && Boolean(startsAt && startsAt > now)
      && Number(event.memberDefaultsVersion ?? 0) < MEMBER_DEFAULTS_VERSION;
  });
  if (events.length === 0) return;
  const memberSnapshot = await db.collection("members").get();

  for (const eventDocument of events) {
    await db.runTransaction(async (transaction) => {
      const [freshEvent, bookings] = await Promise.all([
        transaction.get(eventDocument.ref),
        transaction.get(eventDocument.ref.collection("bookings")),
      ]);
      const event = freshEvent.data();
      const startsAt = dateValue(event?.startsAt);
      if (!freshEvent.exists || event?.status !== "SCHEDULED" || !startsAt || startsAt <= now) return;
      if (Number(event.memberDefaultsVersion ?? 0) >= MEMBER_DEFAULTS_VERSION) return;

      const bookingsByMember = new Map(bookings.docs.map((document) => [document.id, document]));
      let addedRegular = 0;
      let promotedFromStandby = 0;
      for (const memberDocument of memberSnapshot.docs.filter((document) => memberAt(document.data(), startsAt))) {
        const existing = bookingsByMember.get(memberDocument.id);
        if (!existing) {
          const bookingRef = eventDocument.ref.collection("bookings").doc(memberDocument.id);
          transaction.create(bookingRef, defaultMemberBooking(eventDocument.id, memberDocument.id, memberDocument.data(), now));
          addedRegular += 1;
          continue;
        }
        const status = String(existing.data().status ?? "");
        if (status === "STANDBY") {
          transaction.update(existing.ref, { kindSnapshot: "MEMBER", status: "REGULAR", promotedAt: now, updatedAt: now });
          promotedFromStandby += 1;
        } else if (status === "REGULAR" && existing.data().kindSnapshot !== "MEMBER") {
          transaction.update(existing.ref, { kindSnapshot: "MEMBER", updatedAt: now });
        }
      }
      transaction.update(eventDocument.ref, {
        regularCount: FieldValue.increment(addedRegular + promotedFromStandby),
        standbyCount: FieldValue.increment(-promotedFromStandby),
        memberDefaultsVersion: MEMBER_DEFAULTS_VERSION,
        updatedAt: now,
      });
    });
  }
}

function notificationData({
  title,
  message,
  type,
  tab,
  recipientId = null,
}: {
  title: string;
  message: string;
  type: string;
  tab: string;
  recipientId?: string | null;
}) {
  const now = new Date();
  return {
    title,
    message,
    type,
    tab,
    audience: recipientId ? "USER" : "ALL",
    recipientId,
    createdAt: now,
    updatedAt: now,
  };
}

async function promoteStandbyInTransaction(
  transaction: Transaction,
  eventRef: DocumentReference,
  event: DocumentData,
  vacancies: number,
  now: Date,
) {
  const startsAt = dateValue(event.startsAt);
  if (vacancies <= 0 || event.status !== "SCHEDULED" || !startsAt || startsAt <= now) return 0;
  const standbySnapshot = await transaction.get(eventRef.collection("bookings").where("status", "==", "STANDBY"));
  const candidates = standbySnapshot.docs
    .sort((a, b) => bookingPriority(a.data()) - bookingPriority(b.data()) || (dateValue(a.data().confirmedAt)?.getTime() ?? 0) - (dateValue(b.data().confirmedAt)?.getTime() ?? 0))
    .slice(0, vacancies);
  for (const candidate of candidates) {
    transaction.update(candidate.ref, { status: "REGULAR", promotedAt: now });
    const recipientId = String(candidate.data().memberId ?? candidate.id);
    if (recipientId) {
      const notificationRef = eventRef.firestore.collection("notifications").doc();
      transaction.create(notificationRef, notificationData({ title: "候補已遞補", message: `${taipeiDate(event.startsAt)} 的活動已遞補為正取`, type: "EVENT", tab: "活動", recipientId }));
    }
  }
  return candidates.length;
}

async function promoteStandby(eventId: string) {
  const db = getAdminFirestore();
  const eventRef = db.collection("events").doc(eventId);
  const now = new Date();
  await db.runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(eventRef);
    if (!eventSnapshot.exists) return;
    const event = eventSnapshot.data()!;
    const vacancies = Number(event.regularCapacity ?? 0) - Number(event.regularCount ?? 0);
    const promoted = await promoteStandbyInTransaction(transaction, eventRef, event, vacancies, now);
    if (promoted > 0) transaction.update(eventRef, {
      regularCount: FieldValue.increment(promoted),
      standbyCount: FieldValue.increment(-promoted),
      updatedAt: now,
    });
  });
}

type EventCancellationSummary = {
  cancelledBookings: number;
  voidedInvoices: number;
  creditedInvoices: number;
  eventId?: string; eventDate?: string; courts?: string; reducedAmount?: number; creditedAmount?: number; pendingCashRefundAmount?: number; pendingCreditAmount?: number; previewKey?: string;
};

type GuestSettlement = {
  memberId: string;
  status: "ISSUED" | "SKIPPED" | "LEGACY";
  amount: number | null;
  payerKind?: "MEMBER" | "GUEST";
};

function storedGuestSettlements(event: DocumentData): GuestSettlement[] {
  return Array.isArray(event.guestSettlements) ? event.guestSettlements : [];
}

// A historical settlement entry may survive a void. Keep genuine or
// unverified charges protected, not a superseded unpaid guest invoice.
function eventFeeLocks(event: DocumentData, eventId: string, linkedPeriods: DocumentData[], invoices: DocumentData[]) {
  const charges = invoices.filter((bill) => invoiceCoversEvent(bill, eventId));
  const guestInvoices = invoices.filter((bill) => bill.type === "SINGLE_EVENT");
  const guest = charges.some((bill) => bill.type === "SINGLE_EVENT")
    || storedGuestSettlements(event).some((entry) => {
      if (entry.payerKind === "MEMBER" || (entry.status !== "ISSUED" && entry.status !== "LEGACY")) return false;
      const records = guestInvoices.filter((bill) => bill.memberId === entry.memberId);
      return !records.length || records.some((bill) => bill.status !== "VOID" || bill.receipt || bill.confirmedAt);
    });
  const member = event.memberBilling === "EXTRA"
    || linkedPeriods.some((period) => ["GENERATING", "ACTIVE"].includes(String(period.status)))
    || charges.some((bill) => bill.type !== "SINGLE_EVENT");
  return { member, guest };
}

function isManagedGuestBill(invoice: DocumentData) {
  return ["SINGLE_EVENT", "MEMBER_SINGLE"].includes(invoice.type) && ["POST_EVENT", "MANUAL"].includes(String(invoice.guestSettlementSource));
}

function legacyGuestBills(invoices: FirebaseFirestore.QueryDocumentSnapshot[]) {
  const byEvent = new Map<string, Map<string, number | null>>();
  const creditsByInvoice = new Map<string, DocumentData[]>();
  for (const entry of invoices) {
    const data = entry.data();
    if (data.type !== "CREDIT" || !data.relatedInvoiceId) continue;
    const key = String(data.relatedInvoiceId);
    const credits = creditsByInvoice.get(key) ?? [];
    credits.push(data);
    creditsByInvoice.set(key, credits);
  }
  for (const entry of invoices) {
    const data = entry.data();
    if (!data.memberId) continue;
    const managed = isManagedGuestBill(data);
    const credits = creditsByInvoice.get(entry.id) ?? [];
    const awaitingRefund = credits.some((credit) => ["AWAITING_PAYMENT_CONFIRMATION", "AWAITING_OFFLINE_REFUND"].includes(credit.status));
    const bookingRefund = credits.some((credit) => credit.bookingCancellationRefund === true &&
      (credit.status === "CONFIRMED" || credit.status === "VOID" && effectiveInvoiceAmounts(data).grossAmount === 0));
    const ids = new Set<string>([...(Array.isArray(data.eventIds) ? data.eventIds.map(String) : []), ...(data.eventId ? [String(data.eventId)] : [])]);
    for (const eventId of ids) {
      const active = invoiceCoversEvent(data, eventId);
      // Legacy guest history keeps its existing manual-review behavior. For
      // managed cancellations, allow a genuinely new booking after resolution.
      if (managed ? !awaitingRefund && (!active || bookingRefund) : !active && data.type !== "SINGLE_EVENT") continue;
      const memberId = String(data.memberId);
      const eventBills = byEvent.get(eventId) ?? new Map<string, number | null>();
      const liveAmount = data.type === "SINGLE_EVENT" && !managed && active ? effectiveInvoiceAmounts(data).amount : null;
      if (!eventBills.has(memberId) || liveAmount !== null) eventBills.set(memberId, liveAmount);
      byEvent.set(eventId, eventBills);
    }
  }
  return byEvent;
}

// Keep an unverified transfer pending. The standard confirm/reject actions
// resolve its linked credit after the cash has (or has not) been verified.
function cancelSingleEventInvoice(transaction: Transaction, db: Firestore, invoice: DocumentSnapshot, eventId: string, reason: string, now: Date, actor: Viewer, related: DocumentData[] = []) {
  const data = invoice.data()!;
  const amounts = effectiveInvoiceAmounts(data);
  const memberId = String(data.memberId ?? "");
  if (!memberId) return { voided: 0, credited: 0 };
  const creditRef = db.collection("invoices").doc("credit-" + eventId + "-" + invoice.id);
  // A separate cancellation can encounter this same bill after its linked
  // credit was resolved and its principal changed from REPORTED to CONFIRMED.
  if (Array.isArray(data.adjustments) && data.adjustments.some((entry: DocumentData) => entry.creditInvoiceId === creditRef.id)) return { voided: 0, credited: 0 };
  const explanation = reason === "EVENT_CANCELLED" ? "活動取消" : "取消報名";
  const audit = { eventId, reason: explanation, actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() };
  let balanceRefund = 0;
  if (isManagedGuestBill(data) && ["REPORTED", "CONFIRMED"].includes(data.status)) {
    const effect = cancellationBillEffect(eventId, invoice, related);
    if (!effect) return { voided: 0, credited: 0 };
    const reported = data.status === "REPORTED";
    const status = reported ? "AWAITING_PAYMENT_CONFIRMATION" : effect.cash > 0 ? "AWAITING_OFFLINE_REFUND" : "CONFIRMED";
    transaction.create(creditRef, {
      id: creditRef.id, memberId, memberNameSnapshot: data.memberNameSnapshot ?? "未知使用者",
      eventId, relatedInvoiceId: invoice.id, type: "CREDIT", eventCancellationRefund: true, bookingCancellationRefund: true,
      grossAmount: -effect.charge, creditApplied: 0, amount: -effect.charge,
      refundWalletAmount: effect.wallet, refundCashAmount: effect.cash,
      originalReceiptMethod: data.receipt?.method ?? null, status, periodLabel: "取消報名退款",
      confirmedAt: status === "CONFIRMED" ? now : null, createdAt: now, updatedAt: now,
    });
    transaction.update(invoice.ref, {
      adjustments: FieldValue.arrayUnion({ ...audit, kind: status === "CONFIRMED" ? "CREDIT" : "CREDIT_PENDING", amount: -effect.charge, creditInvoiceId: creditRef.id }),
      updatedAt: now,
    });
    if (!reported && effect.wallet > 0) {
      transaction.update(db.collection("members").doc(memberId), { creditBalance: FieldValue.increment(effect.wallet), updatedAt: now });
      recordBalanceMovement(transaction, db, {
        memberId, amount: effect.wallet, reason: "取消報名恢復帳戶餘額", sourceKey: "invoice:" + creditRef.id + ":credit",
        invoiceId: creditRef.id, relatedInvoiceId: invoice.id, eventId, actorId: actor.id, actorName: actor.name, createdAt: now,
      });
    }
    if (!reported && effect.cash > 0) transaction.create(db.collection("notifications").doc(), notificationData({
      title: "取消報名退款待處理", message: `待幹部於站外退款 NT$${effect.cash}。`,
      type: "PAYMENT", tab: "費用管理", recipientId: memberId,
    }));
    return { voided: 0, credited: 1 };
  }
  if (data.status === "PENDING") {
    balanceRefund = amounts.creditApplied;
    transaction.update(invoice.ref, { status: "VOID", cancellationReason: reason, voidReason: explanation, updatedAt: now });
  } else if (data.status === "CONFIRMED") {
    balanceRefund = amounts.grossAmount;
    transaction.update(invoice.ref, { status: "CREDITED", cancellationReason: reason, updatedAt: now });
  } else if (data.status === "REPORTED" && amounts.grossAmount > 0) {
    transaction.create(creditRef, {
      id: creditRef.id, memberId, memberNameSnapshot: data.memberNameSnapshot ?? "未知使用者",
      eventId, relatedInvoiceId: invoice.id, type: "CREDIT",
      grossAmount: -amounts.grossAmount, creditApplied: 0, amount: -amounts.grossAmount,
      status: "AWAITING_PAYMENT_CONFIRMATION", periodLabel: "取消活動費待退回",
      confirmedAt: null, note: "待原帳單收款確認後退回餘額", createdAt: now, updatedAt: now,
    });
    transaction.update(invoice.ref, {
      adjustments: FieldValue.arrayUnion({ ...audit, kind: "CREDIT_PENDING", amount: -amounts.grossAmount, creditInvoiceId: creditRef.id }),
      updatedAt: now,
    });
    return { voided: 0, credited: 1 };
  } else {
    return { voided: 0, credited: 0 };
  }
  if (balanceRefund > 0) {
    transaction.update(db.collection("members").doc(memberId), { creditBalance: FieldValue.increment(balanceRefund), updatedAt: now });
    recordBalanceMovement(transaction, db, {
      memberId, amount: balanceRefund, reason: data.status === "PENDING" ? "取消活動費恢復餘額抵扣" : "取消活動費退回餘額",
      sourceKey: `invoice:${invoice.id}:cancel`, invoiceId: invoice.id, eventId,
      actorId: actor.id, actorName: actor.name, createdAt: now,
    });
  }
  return { voided: Number(data.status === "PENDING"), credited: Number(data.status === "CONFIRMED") };
}


type CancellationBillEffect = { id: string; memberId: string; status: string; amount: number; wallet: number; cash: number; charge: number; single: boolean };
const CREDIT_RESERVED = ["CONFIRMED", "AWAITING_PAYMENT_CONFIRMATION", "AWAITING_OFFLINE_REFUND"];
const creditValue = (data: DocumentData) => Math.max(0, -Number(data.amount ?? 0));
function cancellationBillEffect(eventId: string, invoice: DocumentSnapshot, related: DocumentData[]): CancellationBillEffect | null {
  const data = invoice.data()!;
  if (!memberChargesForEvent([data], eventId) || !data.memberId) return null;
  const single = ["SINGLE_EVENT", "MEMBER_SINGLE"].includes(data.type);
  const ids = Array.isArray(data.eventIds) ? data.eventIds.map(String) : [String(data.eventId ?? "")];
  const index = ids.indexOf(eventId);
  if (index < 0 || (data.adjustments ?? []).some((entry: DocumentData) => entry.creditInvoiceId === "credit-" + eventId + "-" + invoice.id)) return null;
  const effective = effectiveInvoiceAmounts(data);
  const originalLineAmount = data.eventAmounts?.[index] ?? data.unitAmount ?? data.eventSnapshots?.[index]?.memberFeeSnapshot;
  if (!single && ids.length > 1 && originalLineAmount == null) throw new Error("舊帳單缺少原始場次金額，請先核對，避免退錯款");
  const nominal = single || originalLineAmount == null ? effective.grossAmount : Number(originalLineAmount);
  if (![nominal, effective.grossAmount, effective.amount, effective.creditApplied].every((amount) => Number.isSafeInteger(amount) && amount >= 0)) throw new Error("活動帳單金額不正確，請先核對");
  const prior = related.filter((entry) => entry.type === "CREDIT" && CREDIT_RESERVED.includes(String(entry.status)));
  const previous = prior.reduce((sum, entry) => sum + creditValue(entry), 0);
  const charge = Math.max(0, Math.min(nominal, effective.grossAmount - previous));
  const result = { id: invoice.id, memberId: String(data.memberId), status: String(data.status), charge, single, amount: 0, wallet: 0, cash: 0 };
  if (charge === 0) return null;
  if (data.status === "PENDING") {
    const reduced = reduceUnpaidInvoice(data, charge);
    return { ...result, amount: effective.amount - reduced.adjustedAmount, wallet: reduced.restoredCredit };
  }
  const walletUsed = prior.reduce((sum, entry) => sum + Math.max(0, Number(entry.refundWalletAmount ?? entry.balanceRefund ?? creditValue(entry))), 0);
  const cashUsed = prior.reduce((sum, entry) => sum + Math.max(0, Number(entry.refundCashAmount ?? entry.cashRefund ?? 0)), 0);
  const cashLimit = Math.max(0, Number(data.receipt?.amount ?? effective.amount) - cashUsed);
  const wallet = Math.min(charge, Math.max(0, effective.creditApplied - walletUsed));
  const cash = Math.min(charge - wallet, cashLimit);
  if (wallet + cash !== charge) throw new Error("活動退款與原付款金額不符，請先核對帳單");
  return { ...result, wallet, cash };
}
function cancellationQuote(eventId: string, event: DocumentData, bookingIds: string[], effects: CancellationBillEffect[]) {
  const totals = {
    eventId, eventDate: taipeiDate(event.startsAt), courts: String(event.courts ?? ""),
    cancelledBookings: bookingIds.length,
    voidedInvoices: effects.filter((entry) => entry.single && entry.status === "PENDING").length,
    creditedInvoices: effects.filter((entry) => entry.status !== "PENDING").length,
    reducedAmount: effects.reduce((sum, entry) => sum + entry.amount, 0),
    creditedAmount: effects.reduce((sum, entry) => sum + (entry.status === "REPORTED" ? 0 : entry.wallet), 0),
    pendingCashRefundAmount: effects.reduce((sum, entry) => sum + (entry.status === "CONFIRMED" ? entry.cash : 0), 0),
    pendingCreditAmount: effects.reduce((sum, entry) => sum + (entry.status === "REPORTED" ? entry.charge : 0), 0),
  };
  const previewKey = createHash("sha256").update(JSON.stringify([
    totals, iso(event.startsAt), iso(event.endsAt), String(event.status ?? ""),
    bookingIds.sort(), [...effects].sort((a, b) => a.id.localeCompare(b.id)),
  ])).digest("hex");
  return { ...totals, previewKey };
}

async function cancelEventInTransaction(
  transaction: Transaction,
  db: Firestore,
  eventRef: DocumentReference,
  reason: string,
  now: Date,
  actor: Viewer,
  options: { preview: boolean; previewKey?: string; note: string },
): Promise<EventCancellationSummary> {
  const [eventSnapshot, manager] = await transaction.getAll(eventRef, db.collection("members").doc(actor.id));
  if (manager.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
  if (!eventSnapshot.exists) throw new Error("找不到活動");
  const event = eventSnapshot.data()!;
  const eventDateRef = db.collection("eventDates").doc(taipeiDate(event.startsAt));

  if (event.status === "CANCELLED") {
    if (options.preview) throw new Error("活動已取消");
    if (event.cancellationQuote?.previewKey === options.previewKey && String(event.cancellationNote ?? "") === options.note) return event.cancellationQuote;
    throw new Error("活動已取消，原預覽已失效");
  }

  const endsAt = dateValue(event.endsAt);
  if (endsAt && endsAt <= now) throw new Error("活動已結束，無法取消");
  const [dateSnapshot, bookingSnapshot, directInvoiceSnapshot, quarterlyInvoiceSnapshot] = await Promise.all([
    transaction.get(eventDateRef),
    transaction.get(eventRef.collection("bookings")),
    transaction.get(db.collection("invoices").where("eventId", "==", eventRef.id)),
    transaction.get(db.collection("invoices").where("eventIds", "array-contains", eventRef.id)),
  ]);

  const activeBookings = bookingSnapshot.docs.filter((document) => ["REGULAR", "STANDBY"].includes(String(document.data().status)));
  const invoices = [...new Map([...directInvoiceSnapshot.docs, ...quarterlyInvoiceSnapshot.docs].map((document) => [document.id, document])).values()];

  const candidates = invoices.filter((invoice) => memberChargesForEvent([invoice.data()], eventRef.id));
  const related = await Promise.all(candidates.map((invoice) => transaction.get(db.collection("invoices").where("relatedInvoiceId", "==", invoice.id))));
  const effects = candidates.flatMap((invoice, index) => {
    const effect = cancellationBillEffect(eventRef.id, invoice, related[index].docs.map((entry) => entry.data()));
    return effect ? [effect] : [];
  });
  const quote = cancellationQuote(eventRef.id, event, activeBookings.map((entry) => entry.id + ":" + String(entry.data().status)), effects);
  if (options.preview) return quote;
  if (quote.previewKey !== options.previewKey) throw new Error("活動或帳務已變更，請重新預覽取消影響");
  const effectsById = new Map(effects.map((entry) => [entry.id, entry]));
  const linkedPeriods = await transaction.get(db.collection("billingPeriods").where("eventIds", "array-contains", eventRef.id));
  const adjustment = { eventId: eventRef.id, eventDate: taipeiDate(event.startsAt), reason: options.note || "活動取消", actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() };
  if (3 + linkedPeriods.size + activeBookings.length * 2 + effects.length * 5 > 440) throw new Error("本場帳務影響過多，請先分批核對再取消");
  for (const period of linkedPeriods.docs) transaction.update(period.ref, { eventChanges: FieldValue.arrayUnion({ ...adjustment, kind: "CANCELLED" }), updatedAt: now });
  const creditsByMember = new Map<string, number>();
  const balanceCredits: { memberId: string; amount: number; reason: string; sourceKey: string; invoiceId: string; relatedInvoiceId?: string }[] = [];

  for (const booking of activeBookings) {
    transaction.update(booking.ref, {
      status: "CANCELLED",
      cancelledAt: now,
      cancellationReason: "EVENT_CANCELLED",
      updatedAt: now,
    });
    const recipientId = String(booking.data().memberId ?? booking.id);
    if (recipientId) {
      const notificationRef = db.collection("notifications").doc();
      transaction.create(notificationRef, notificationData({
        title: "活動已取消",
        message: `${taipeiDate(event.startsAt)} ${String(event.courts ?? "羽球活動")} 已取消` + (options.note ? "；原因：" + options.note : ""),
        type: "EVENT",
        tab: "活動",
        recipientId,
      }));
    }
  }

  for (const invoice of candidates) {
    const invoiceData = invoice.data();
    const memberId = String(invoiceData.memberId);
    const effect = effectsById.get(invoice.id);
    if (!effect) continue;
    if (effect.status === "PENDING") {
      if (effect.single) {
        const before = effectiveInvoiceAmounts(invoiceData);
        transaction.update(invoice.ref, {
          status: "VOID", cancellationReason: "EVENT_CANCELLED", voidReason: adjustment.reason, voidedAt: now, voidedBy: actor.id,
          adjustedGrossAmount: 0, adjustedAmount: 0, adjustedCreditApplied: 0,
          adjustments: FieldValue.arrayUnion({ ...adjustment, kind: "REDUCTION", amount: -effect.charge, beforeAmount: before.amount, afterAmount: 0, restoredCredit: effect.wallet }),
          updatedAt: now,
        });
        if (effect.wallet > 0) {
          creditsByMember.set(memberId, (creditsByMember.get(memberId) ?? 0) + effect.wallet);
          balanceCredits.push({ memberId, amount: effect.wallet, reason: "取消活動費恢復餘額抵扣", sourceKey: "invoice:" + invoice.id + ":cancel", invoiceId: invoice.id });
        }
      } else {
        const before = effectiveInvoiceAmounts(invoiceData);
        const { restoredCredit, ...reduced } = reduceUnpaidInvoice(invoiceData, effect.charge);
        if (restoredCredit > 0) {
          creditsByMember.set(memberId, (creditsByMember.get(memberId) ?? 0) + restoredCredit);
          balanceCredits.push({ memberId, amount: restoredCredit, reason: "活動取消恢復帳單抵扣", sourceKey: "invoice:" + invoice.id + ":reduction:" + eventRef.id, invoiceId: invoice.id });
        }
        transaction.update(invoice.ref, { ...reduced, status: reduced.adjustedAmount === 0 ? "CONFIRMED" : "PENDING", confirmedAt: reduced.adjustedAmount === 0 ? now : null, adjustments: FieldValue.arrayUnion({ ...adjustment, kind: "REDUCTION", amount: -effect.charge, beforeAmount: before.amount, afterAmount: reduced.adjustedAmount, restoredCredit }), updatedAt: now });
      }
    } else {
      const creditRef = db.collection("invoices").doc("credit-" + eventRef.id + "-" + invoice.id);
      const awaitingPayment = effect.status === "REPORTED";
      const status = awaitingPayment ? "AWAITING_PAYMENT_CONFIRMATION" : effect.cash > 0 ? "AWAITING_OFFLINE_REFUND" : "CONFIRMED";
      transaction.create(creditRef, {
        id: creditRef.id, memberId, memberNameSnapshot: String(invoiceData.memberNameSnapshot ?? "未知使用者"),
        eventId: eventRef.id, relatedInvoiceId: invoice.id, type: "CREDIT", eventCancellationRefund: true,
        periodId: invoiceData.periodId ?? invoiceData.relatedPeriodId ?? null,
        grossAmount: -effect.charge, creditApplied: 0, amount: -effect.charge,
        refundWalletAmount: effect.wallet, refundCashAmount: effect.cash,
        originalReceiptMethod: invoiceData.receipt?.method ?? null, status, periodLabel: "活動取消退款",
        confirmedAt: status === "CONFIRMED" ? now : null, createdAt: now, updatedAt: now,
      });
      transaction.update(invoice.ref, { adjustments: FieldValue.arrayUnion({ ...adjustment, kind: status === "CONFIRMED" ? "CREDIT" : "CREDIT_PENDING", amount: -effect.charge, creditInvoiceId: creditRef.id }), updatedAt: now });
      if (!awaitingPayment && effect.wallet > 0) {
        creditsByMember.set(memberId, (creditsByMember.get(memberId) ?? 0) + effect.wallet);
        balanceCredits.push({ memberId, amount: effect.wallet, reason: "活動取消退回原抵扣的帳戶餘額", sourceKey: "invoice:" + creditRef.id + ":credit", invoiceId: creditRef.id, relatedInvoiceId: invoice.id });
      }
      if (!awaitingPayment && effect.cash > 0) transaction.create(db.collection("notifications").doc(), notificationData({
        title: "活動取消退款待處理", message: adjustment.eventDate + " 已取消，款項 NT$" + effect.cash + " 待幹部於站外退款。",
        type: "PAYMENT", tab: "費用管理", recipientId: memberId,
      }));
    }
  }

  for (const [memberId, amount] of creditsByMember) {
    if (memberId && amount > 0) {
      transaction.update(db.collection("members").doc(memberId), { creditBalance: FieldValue.increment(amount), updatedAt: now });
      for (const credit of balanceCredits.filter((entry) => entry.memberId === memberId)) {
        recordBalanceMovement(transaction, db, { ...credit, eventId: eventRef.id, actorId: actor.id, actorName: actor.name, createdAt: now });
      }
    }
  }

  transaction.update(eventRef, {
    status: "CANCELLED",
    regularCount: 0,
    standbyCount: 0,
    cancelledAt: now,
    cancellationReason: reason,
    cancellationQuote: quote,
    cancellationNote: options.note,
    updatedAt: now,
  });
  if (dateSnapshot.data()?.eventId === eventRef.id) transaction.delete(eventDateRef);
  return quote;
}

export async function readState(viewer: Viewer | null = null) {
  if (viewer?.role === "ADMIN") await backfillDefaultMemberBookings();
  const db = getAdminFirestore();
  const isAdmin = viewer?.role === "ADMIN";
  const invoiceQuery = isAdmin
    ? db.collection("invoices")
    : viewer
      ? db.collection("invoices").where("memberId", "==", viewer.id)
      : null;
  const membershipRequestQuery = isAdmin
    ? db.collection("membershipRequests")
    : viewer
      ? db.collection("membershipRequests").where("memberId", "==", viewer.id)
      : null;
  const targetedNotificationQuery = viewer ? db.collection("notifications").where("recipientId", "==", viewer.id) : null;
  const broadcastNotificationQuery = viewer ? db.collection("notifications").where("audience", "==", "ALL") : null;
  const notificationReadQuery = viewer ? db.collection("notificationReads").where("memberId", "==", viewer.id) : null;
  const [eventSnapshot, announcementSnapshot, memberSnapshot, bookingSnapshot, invoiceSnapshot, feeRateSnapshot, membershipRequestSnapshot, targetedNotificationSnapshot, broadcastNotificationSnapshot, notificationReadSnapshot, planSnapshot, periodSnapshot, currentMemberFee, currentGuestFee] = await Promise.all([
    db.collection("events").get(),
    db.collection("announcements").get(),
    viewer ? db.collection("members").get() : Promise.resolve(null),
    viewer ? db.collectionGroup("bookings").get() : Promise.resolve(null),
    invoiceQuery ? invoiceQuery.get() : Promise.resolve(null),
    isAdmin ? db.collection("feeRates").get() : Promise.resolve(null),
    membershipRequestQuery ? membershipRequestQuery.get() : Promise.resolve(null),
    targetedNotificationQuery ? targetedNotificationQuery.get() : Promise.resolve(null),
    broadcastNotificationQuery ? broadcastNotificationQuery.get() : Promise.resolve(null),
    notificationReadQuery ? notificationReadQuery.get() : Promise.resolve(null),
    isAdmin ? db.collection("quarterPlans").where("status", "==", "CONFIRMED").get() : Promise.resolve(null),
    viewer ? db.collection("billingPeriods").get() : Promise.resolve(null),
    activeFee(db, "MEMBER_VISIT", new Date()),
    activeFee(db, "GUEST_VISIT", new Date()),
  ]);

  const memberDocuments = memberSnapshot?.docs ?? [];
  const membersById = new Map(memberDocuments.map((document) => [document.id, document.data()]));
  const members = memberDocuments
    .map((document) => {
      const member = document.data();
      const storedMembershipStatus = String(member.membershipStatus ?? "GUEST");
      const membershipStatus = isClubPresident(member) ? "MEMBER" : storedMembershipStatus === "EXITING" && !memberAt(member, new Date()) ? "GUEST" : storedMembershipStatus;
      const name = String(member.displayName ?? "");
      return {
        id: document.id,
        name,
        accountName: memberAccountName(member),
        department: member.department ? String(member.department) : null,
        role: String(member.role ?? "MEMBER"),
        membershipStatus,
        membershipEndingAt: membershipStatus === "EXITING" ? iso(member.endingAt) : null,
        creditBalance: Number(member.creditBalance ?? 0),
        primaryAdmin: isClubPresident(member),
        canReceivePresidency: !isClubPresident(member) && member.membershipStatus === "MEMBER" && !member.endingAt
          && ["guest", "recoverable", "verified"].includes(String(member.accountType))
          && !(membershipRequestSnapshot?.docs ?? []).some((request) => request.data().memberId === document.id && request.data().kind === "EXIT" && request.data().status === "PENDING"),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));

  const bookingsByEvent = new Map<string, Array<Record<string, unknown>>>();
  for (const document of bookingSnapshot?.docs ?? []) {
    const booking = document.data();
    if (booking.status !== "REGULAR" && booking.status !== "STANDBY") continue;
    const eventId = String(booking.eventId ?? document.ref.parent.parent?.id ?? "");
    const member = membersById.get(String(booking.memberId));
    const item = {
      id: String(booking.id ?? document.id),
      memberId: String(booking.memberId ?? document.id),
      name: String(member?.displayName ?? booking.displayNameSnapshot ?? "未知使用者"),
      accountName: member ? memberAccountName(member) : String(booking.accountNameSnapshot ?? ""),
      kind: String(booking.kindSnapshot ?? "GUEST"),
      status: String(booking.status),
      confirmedAt: iso(booking.confirmedAt),
      transferred: Boolean(booking.transferredFromMemberId),
    };
    const list = bookingsByEvent.get(eventId) ?? [];
    list.push(item);
    bookingsByEvent.set(eventId, list);
  }

  const legacyByEvent = isAdmin ? legacyGuestBills(invoiceSnapshot?.docs ?? []) : new Map<string, Map<string, number | null>>();
  const invoicesByEvent = new Map<string, DocumentData[]>();
  if (isAdmin) for (const invoice of invoiceSnapshot?.docs ?? []) {
    const bill = invoice.data();
    const ids = new Set<string>([...(Array.isArray(bill.eventIds) ? bill.eventIds.map(String) : []), ...(bill.eventId ? [String(bill.eventId)] : [])]);
    for (const id of ids) {
      const list = invoicesByEvent.get(id) ?? [];
      list.push(bill);
      invoicesByEvent.set(id, list);
    }
  }
  const periodByEvent = new Map<string, DocumentData>();
  const linkedPeriodsByEvent = new Map<string, DocumentData[]>();
  const coveredQuarterEvents = new Set<string>();
  for (const period of periodSnapshot?.docs ?? []) {
    const data = period.data();
    const editable = data.status === "PLANNED" && data.origin === "BILLING_MANAGER" && Boolean(data.confirmationKey);
    if (Array.isArray(data.eventIds)) for (const eventId of data.eventIds) {
      const id = String(eventId);
      periodByEvent.set(id, data);
      const linked = linkedPeriodsByEvent.get(id) ?? [];
      linked.push(data);
      linkedPeriodsByEvent.set(id, linked);
      // Saved draft activities are still selectable through the calendar's only issuance entry.
      if (!editable) coveredQuarterEvents.add(String(eventId));
    }
  }
  if (isAdmin) for (const invoice of invoiceSnapshot?.docs ?? []) addQuarterChargeCoverage(coveredQuarterEvents, invoice.data());
  const events = eventSnapshot.docs
    .map((document) => {
      const event = document.data();
      const guestSettlements = isAdmin ? storedGuestSettlements(event) : [];
      const settledGuestIds = new Set(guestSettlements.map((entry) => entry.memberId));
      const guestBookingIds = new Set((bookingsByEvent.get(document.id) ?? []).filter((booking) => booking.kind === "GUEST").map((booking) => String(booking.memberId)));
      const period = periodByEvent.get(document.id);
      const memberBillingLabel = event.billingPaused === true ? "不再開單"
        : event.memberBilling === "FREE" ? "免費活動"
        : event.memberBilling === "NO_CHARGE" ? "本場不另計社員費"
        : event.memberBilling === "EXTRA" ? "另收社員加場費"
        : !isBadmintonEvent(event) && event.memberBilling === "NORMAL" ? "單場收費"
        : !isBadmintonEvent(event) ? "免費活動"
        : period?.status === "PLANNED" ? "納入季度社費草稿"
        : period?.status === "GENERATING" ? "季度社費開單中"
        : period?.status === "ACTIVE" ? "季度社費場次"
        : "尚未納入季度社費";
      return {
        id: document.id,
        starts_at: iso(event.startsAt),
        ends_at: iso(event.endsAt),
        courts: String(event.courts ?? ""),
        regular_capacity: Number(event.regularCapacity ?? 10),
        standby_capacity: Number(event.standbyCapacity ?? 4),
        regular_count: Number(event.regularCount ?? 0),
        standby_count: Number(event.standbyCount ?? 0),
        member_fee: event.billingPaused === true ? 0 : Number(event.memberFeeSnapshot ?? 150),
        ...(isAdmin ? { member_list_rate: Number(event.memberListRateSnapshot ?? (Number(event.memberFeeSnapshot) > 0 ? event.memberFeeSnapshot : 150)), guest_list_rate: Number(event.guestFeeSnapshot ?? 180) } : {}),
        member_billing: event.billingPaused === true ? "FREE" : event.memberBilling ?? (isBadmintonEvent(event) ? null : "FREE"),
        billing_paused: event.billingPaused === true,
        member_billing_label: memberBillingLabel,
        event_kind: isBadmintonEvent(event) ? "BADMINTON" : "OTHER",
        guest_fee: event.billingPaused === true ? 0 : Number(event.guestFeeSnapshot ?? 180),
        status: String(event.status ?? "SCHEDULED"),
        cancellation_reason: event.cancellationNote ?? event.cancellationReason ?? null,
        created_at: iso(event.createdAt),
        bookings: (bookingsByEvent.get(document.id) ?? []).sort((a, b) => String(a.confirmedAt).localeCompare(String(b.confirmedAt))),
        ...(isAdmin ? { billing_locks: eventFeeLocks(event, document.id, linkedPeriodsByEvent.get(document.id) ?? [], invoicesByEvent.get(document.id) ?? []), quarter_eligible: isQuarterEligibleEvent(event) && !coveredQuarterEvents.has(document.id), guest_settlements: [...guestSettlements, ...[...(legacyByEvent.get(document.id) ?? [])]
          .filter(([memberId]) => guestBookingIds.has(memberId) && !settledGuestIds.has(memberId))
          .map(([memberId, amount]): GuestSettlement => ({ memberId, status: "LEGACY", amount }))] } : {}),
      };
    })
    .filter((event) => event.status !== "CANCELLED")
    .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));

  const announcements = announcementSnapshot.docs
    .map((document) => {
      const announcement = document.data();
      return {
        id: document.id,
        title: String(announcement.title ?? ""),
        content: String(announcement.content ?? ""),
        linkUrl: announcement.linkUrl ? String(announcement.linkUrl) : null,
        pinned: Boolean(announcement.pinned),
        publishedAt: iso(announcement.publishedAt),
      };
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.publishedAt).localeCompare(String(a.publishedAt)));
  const eventSchedulesById = new Map(eventSnapshot.docs.map((document) => {
    const event = document.data();
    return [document.id, {
      id: document.id,
      starts_at: iso(event.startsAt),
      ends_at: iso(event.endsAt),
      courts: String(event.courts ?? ""),
      status: String(event.status ?? "SCHEDULED"),
      cancellation_reason: event.cancellationNote ?? event.cancellationReason ?? null,
    }];
  }));

  const invoices = (invoiceSnapshot?.docs ?? [])
    .map((document) => {
      const invoice = document.data();
      const member = membersById.get(String(invoice.memberId));
      const period = periodSnapshot?.docs.find((entry) => entry.id === (invoice.periodId ?? invoice.relatedPeriodId))?.data();
      const refundTotal = (invoiceSnapshot?.docs ?? []).filter((entry) => entry.data().relatedInvoiceId === document.id && entry.data().type === "CREDIT" && CREDIT_RESERVED.includes(entry.data().status)).reduce((sum, entry) => sum + Math.max(0, -Number(entry.data().amount)), 0);
      const directEventId = invoice.eventId ? String(invoice.eventId) : null;
      const eventIds = Array.isArray(invoice.eventIds) ? invoice.eventIds.map(String) : directEventId ? [directEventId] : [];
      const storedSchedules: (DocumentData | null)[] = Array.isArray(invoice.eventSnapshots) ? invoice.eventSnapshots : [];
      const originalsById = new Map<string, DocumentData>(storedSchedules.flatMap((snapshot) => typeof snapshot?.id === "string" ? [[snapshot.id, snapshot]] : []));
      const originalEventSchedules = eventIds.flatMap((id, index) => {
        const positionMatches = storedSchedules.length === eventIds.length && storedSchedules[index]?.id == null;
        const snapshot = originalsById.get(id) ?? (positionMatches ? storedSchedules[index] : undefined);
        if (!snapshot) return [];
        const originalStart = dateValue(snapshot.startsAt);
        const originalEnd = dateValue(snapshot.endsAt);
        const starts_at = originalStart && Number.isFinite(originalStart.getTime()) ? originalStart.toISOString() : null;
        const ends_at = originalEnd && Number.isFinite(originalEnd.getTime()) ? originalEnd.toISOString() : null;
        const courts = typeof snapshot.courts === "string" ? snapshot.courts : "";
        return starts_at || ends_at || courts ? [{ id, starts_at, ends_at, courts }] : [];
      });
      const receipt = invoice.receipt as InvoiceReceipt | undefined;
      return {
        id: document.id,
        member_id: String(invoice.memberId ?? ""),
        event_id: directEventId,
        event_ids: eventIds,
        original_event_amounts: eventIds.length ? eventIds.map((_, index) => Number(invoice.eventAmounts?.[index] ?? invoice.unitAmount ?? Math.floor(Number(invoice.grossAmount ?? invoice.amount ?? 0) / eventIds.length))) : [Number(invoice.grossAmount ?? invoice.amount ?? 0)],
        event_amounts: eventIds.length ? eventIds.map((id, index) => eventSchedulesById.get(id)?.status === "CANCELLED" || membershipChargeRemoved(invoice, id) ? 0 : Number(invoice.eventAmounts?.[index] ?? invoice.unitAmount ?? Math.floor(effectiveInvoiceAmounts(invoice).grossAmount / eventIds.length))) : [effectiveInvoiceAmounts(invoice).grossAmount],
        event_schedules: eventIds.flatMap((eventId) => {
          const schedule = eventSchedulesById.get(eventId);
          return schedule ? [schedule] : [];
        }),
        ...(originalEventSchedules.length ? { original_event_schedules: originalEventSchedules } : {}),
        memberName: String(member?.displayName ?? invoice.memberNameSnapshot ?? "未知使用者"),
        memberAccountName: member ? memberAccountName(member) : String(invoice.accountNameSnapshot ?? ""),
        type: String(invoice.type ?? ""),

        gross_amount: effectiveInvoiceAmounts(invoice).grossAmount,
        credit_applied: effectiveInvoiceAmounts(invoice).creditApplied,
        amount: effectiveInvoiceAmounts(invoice).amount,
        original_gross_amount: Number(invoice.grossAmount ?? invoice.amount ?? 0),
        original_amount: Number(invoice.amount ?? 0),
        baseline_event_count: Number(invoice.baselineEventCount ?? eventIds.length),
        adjustments: Array.isArray(invoice.adjustments) ? invoice.adjustments : [],
        related_invoice_id: invoice.relatedInvoiceId ?? null,
        period_id: invoice.periodId ?? invoice.relatedPeriodId ?? null,
        period_start: period?.startDate ?? null,
        period_end: period?.endDate ?? null,
        replacement_of_id: invoice.replacementOfId ?? null,
        replaced_by_id: invoice.replacedById ?? null,
        void_reason: invoice.voidReason ?? null,
        cancellation_reason: invoice.cancellationReason ?? null,
        refundable_amount: invoice.status === "CONFIRMED" && ["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "SINGLE_EVENT", "MEMBER_EXTRA", "MEMBER_SINGLE"].includes(invoice.type) ? Math.max(0, effectiveInvoiceAmounts(invoice).grossAmount - refundTotal) : 0,
        status: String(invoice.status ?? "PENDING"),
        period_label: invoice.periodLabel ? String(invoice.periodLabel) : null,
        due_at: iso(invoice.dueAt),
        reported_at: iso(invoice.reportedAt),
        confirmed_at: iso(invoice.confirmedAt),
        ...(invoice.eventCancellationRefund ? {
          pending_refund_amount: invoice.status === "AWAITING_OFFLINE_REFUND" ? Number(invoice.refundCashAmount ?? 0) : 0,
          refund_wallet_amount: invoice.status === "AWAITING_PAYMENT_CONFIRMATION" ? 0 : Number(invoice.refundWalletAmount ?? 0),
          original_receipt_method: invoice.originalReceiptMethod ?? null,
          refund_method: invoice.offlineRefundReceipt?.method ?? null,
          refund_completed_date: invoice.offlineRefundReceipt?.refundedDate ?? null,
          refund_completed_amount: Number(invoice.offlineRefundReceipt?.amount ?? 0),
          ...(isAdmin && invoice.offlineRefundReceipt ? {
            refund_recorded_by_name: invoice.offlineRefundReceipt.recordedByName,
            refund_note: invoice.offlineRefundReceipt.note,
          } : {}),
        } : {}),
        ...(receipt ? {
          receipt_method: receipt.method,
          receipt_received_date: receipt.receivedDate,
          receipt_amount: receipt.amount,
          ...(isAdmin ? {
            receipt_recorded_by: receipt.recordedBy,
            receipt_recorded_by_name: receipt.recordedByName,
            receipt_recorded_at: iso(receipt.recordedAt),
            receipt_note: receipt.note,
          } : {}),
        } : {}),
        note: invoice.note ? String(invoice.note) : null,
        created_at: iso(invoice.createdAt),
      };
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  const feeRates = (feeRateSnapshot?.docs ?? [])
    .map((document) => ({
      id: document.id,
      kind: String(document.data().kind ?? ""),
      amount: Number(document.data().amount ?? 0),
      effective_from: iso(document.data().effectiveFrom),
      effective_to: iso(document.data().effectiveTo),
    }))
    .sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)));
  const membershipRequests = (membershipRequestSnapshot?.docs ?? [])
    .map((document) => {
      const request = document.data();
      const member = membersById.get(String(request.memberId));
      return {
        id: document.id,
        memberId: String(request.memberId ?? ""),
        memberName: String(member?.displayName ?? request.memberNameSnapshot ?? "未知使用者"),
        accountName: member ? memberAccountName(member) : "",
        kind: String(request.kind ?? "JOIN"),
        status: String(request.status ?? "PENDING"),
        requestedAt: iso(request.requestedAt),
        reviewedAt: iso(request.reviewedAt),
      };
    })
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
  const readNotificationIds = new Set((notificationReadSnapshot?.docs ?? []).map((document) => String(document.data().notificationId ?? "")));
  const notificationDocuments = [...new Map([
    ...(targetedNotificationSnapshot?.docs ?? []),
    ...(broadcastNotificationSnapshot?.docs ?? []),
  ].map((document) => [document.id, document])).values()];
  const notifications = notificationDocuments
    .map((document) => {
      const notification = document.data();
      return {
        id: document.id,
        title: String(notification.title ?? "通知"),
        message: String(notification.message ?? ""),
        type: String(notification.type ?? "INFO"),
        tab: String(notification.tab ?? "總覽"),
        createdAt: iso(notification.createdAt),
        read: readNotificationIds.has(document.id),
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 50);


  const quarterPlans = (planSnapshot?.docs ?? []).map((doc) => {
    const plan = doc.data();
    return { ...plan, id: doc.id, confirmedAt: iso(plan.confirmedAt), createdAt: iso(plan.createdAt), updatedAt: iso(plan.updatedAt), billed: periodSnapshot?.docs.some((period) => period.data().planId === doc.id && period.data().status === "ACTIVE") ?? false };
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const quarterBillingPeriods = isAdmin
    ? (periodSnapshot?.docs ?? []).flatMap((doc): QuarterBillingPeriod[] => {
      const period = doc.data();
      if (!doc.id.startsWith("quarter-") || !["PLANNED", "GENERATING", "ACTIVE"].includes(String(period.status))) return [];
      const eventIds = Array.isArray(period.eventIds) ? period.eventIds.map(String) : [];
      return [{ id: doc.id.slice("quarter-".length), label: String(period.label ?? "季度社費"), startDate: String(period.startDate ?? ""),
        endDate: String(period.endDate ?? ""), status: period.status as QuarterBillingPeriod["status"], eventIds,
        eventCount: Number(period.eventCount ?? eventIds.length), grossAmount: Number(period.grossAmount ?? 0),
        ...(period.origin === "BILLING_MANAGER" && period.status === "PLANNED" && period.confirmationKey ? { revision: String(period.confirmationKey) } : {}) }];
    }).sort((a, b) => b.startDate.localeCompare(a.startDate) || b.id.localeCompare(a.id)) : [];
  return { viewer, members, events, announcements, invoices, quarterPlans, quarterBillingPeriods, feeRates, membershipRequests, notifications, currentFees: { member: currentMemberFee, guest: currentGuestFee } };
}

async function join(input: Record<string, string>, actor: Viewer) {
  const db = getAdminFirestore();
  const memberSnapshot = await db.collection("members").doc(actor.id).get();
  if (!memberSnapshot.exists) throw new Error("找不到使用者");
  const eventRef = db.collection("events").doc(input.eventId);
  const bookingRef = eventRef.collection("bookings").doc(memberSnapshot.id);
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const [eventSnapshot, bookingSnapshot, freshMemberSnapshot] = await transaction.getAll(eventRef, bookingRef, memberSnapshot.ref);
    if (!eventSnapshot.exists) throw new Error("找不到活動");
    if (!freshMemberSnapshot.exists) throw new Error("找不到使用者");
    const event = eventSnapshot.data()!;
    const member = freshMemberSnapshot.data()!;
    const startsAt = dateValue(event.startsAt);
    if (event.status !== "SCHEDULED" || !startsAt || startsAt <= now) throw new Error("活動已開始或已取消，無法再報名");
    const kind = memberAt(member, startsAt) ? "MEMBER" : "GUEST";
    if (bookingSnapshot.exists && bookingSnapshot.data()?.status !== "CANCELLED") return;

    const regularCount = Number(event.regularCount ?? 0);
    const standbyCount = Number(event.standbyCount ?? 0);
    const regularCapacity = Number(event.regularCapacity ?? 10);
    const standbyCapacity = Number(event.standbyCapacity ?? 4);
    const reservedMember = kind === "MEMBER" && isBadmintonEvent(event);
    const status = reservedMember
      ? "REGULAR"
      : regularCount < regularCapacity
        ? "REGULAR"
        : standbyCount < standbyCapacity
          ? "STANDBY"
          : null;
    if (!status) throw new Error("本場正取與候補名額皆已額滿");

    transaction.set(bookingRef, {
      id: bookingSnapshot.data()?.id ?? `${input.eventId}-${memberSnapshot.id}`,
      eventId: input.eventId,
      memberId: memberSnapshot.id,
      displayNameSnapshot: member.displayName,
      accountNameSnapshot: memberAccountName(member),
      kindSnapshot: kind,
      status,
      confirmedAt: now,
      attendanceSource: reservedMember ? "MEMBER_REJOIN" : "SELF_REGISTERED",
      cancelledAt: null,
      transferredFromMemberId: null,
      updatedAt: now,
    }, { merge: true });
    transaction.update(eventRef, {
      [status === "REGULAR" ? "regularCount" : "standbyCount"]: FieldValue.increment(1),
      updatedAt: now,
    });

  });
}

function previewCredit(raw: string | undefined) {
  const prior = new Map<string, number>();
  if (!raw) return prior;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("抵扣資料不正確"); }
  if (!Array.isArray(parsed) || parsed.some((entry) => !Array.isArray(entry) || entry.length !== 2 ||
    typeof entry[0] !== "string" || !Number.isSafeInteger(entry[1]) || entry[1] < 0)) throw new Error("抵扣資料不正確");
  for (const [id, amount] of parsed) prior.set(id, amount);
  return prior;
}

async function publishGuestEventBills(input: Record<string, string>, actor: Viewer, preview = false) {
  const partial = preview || Boolean(input.previewKey);
  const prior = preview ? previewCredit(input.priorCredit) : new Map<string, number>();
  if (!input.eventId || input.eventId.includes("/") || input.eventId.length > 200) throw new Error("活動識別碼不正確");
  let raw: unknown;
  try { raw = JSON.parse(input.decisions ?? ""); } catch { throw new Error("請確認每位零打球友的收費方式"); }
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new Error("每批請確認 1 至 100 位零打球友");
  const decisions = new Map<string, "BILL" | "SKIP">();
  for (const item of raw) {
    if (!item || typeof item.memberId !== "string" || !item.memberId || item.memberId.includes("/") || item.memberId.length > 200
      || (item.decision !== "BILL" && item.decision !== "SKIP") || decisions.has(item.memberId)) throw new Error("零打名單格式不正確");
    decisions.set(item.memberId, item.decision);
  }
  const db = getAdminFirestore();
  const eventRef = db.collection("events").doc(input.eventId);
  const now = new Date();
  return db.runTransaction(async (transaction) => {
    const [currentActor, eventSnapshot, bookings, direct, grouped] = await Promise.all([
      transaction.get(db.collection("members").doc(actor.id)),
      transaction.get(eventRef),
      transaction.get(eventRef.collection("bookings")),
      transaction.get(db.collection("invoices").where("eventId", "==", eventRef.id)),
      transaction.get(db.collection("invoices").where("eventIds", "array-contains", eventRef.id)),
    ]);
    if (currentActor.data()?.role !== "ADMIN") throw new Error("只有幹部可以開零打帳單");
    const event = eventSnapshot.data();
    if (!eventSnapshot.exists || event?.status !== "SCHEDULED") throw new Error("沒有可開單的活動");
    const other = !isBadmintonEvent(event);
    if (!eventAllowsNewBilling(event)) throw new Error("本場活動不開立帳單");
    if (other && !partial) throw new Error("請先核對這場活動的帳單");
    const startsAt = dateValue(event.startsAt);
    const endsAt = dateValue(event.endsAt);
    if (!startsAt || !endsAt || !Number.isFinite(+startsAt) || !Number.isFinite(+endsAt) || endsAt <= startsAt) throw new Error("活動時間資料不正確");
    const guestFee = Number(event.guestFeeSnapshot ?? 180);
    const memberFee = other ? Number(event.memberFeeSnapshot) : 0;
    if (!Number.isSafeInteger(guestFee) || guestFee < Number(other) || guestFee > 10_000
      || (other && (!Number.isSafeInteger(memberFee) || memberFee < 1 || memberFee > 10_000))) throw new Error("活動收費金額不正確");
    const eligible = new Set(bookings.docs.filter((entry) => {
      const booking = entry.data();
      return booking.status === "REGULAR" && (other || booking.kindSnapshot === "GUEST") && !booking.transferredFromMemberId;
    }).map((entry) => String(entry.data().memberId ?? entry.id)));
    const existing = storedGuestSettlements(event);
    const settled = new Map(existing.map((entry) => [entry.memberId, entry.status]));
    const invoices = [...new Map([...direct.docs, ...grouped.docs].map((doc) => [doc.id, doc])).values()];
    const legacy = legacyGuestBills(invoices).get(eventRef.id);
    const pending = [...eligible].filter((id) => !settled.has(id) && !legacy?.has(id));
    const matchesExisting = (id: string, decision: "BILL" | "SKIP") => settled.get(id) === (decision === "BILL" ? "ISSUED" : "SKIPPED");
    if ((!partial && pending.some((id) => !decisions.has(id))) || [...decisions].some(([id, decision]) => !eligible.has(id) || (settled.has(id) ? !matchesExisting(id, decision) : legacy?.has(id)))) {
      throw new Error("結算名單已變更，請重新開啟後確認");
    }
    const selected = pending.filter((id) => decisions.has(id));
    if (!selected.length && !partial) return { issued: 0, skipped: 0 };

    const billIds = selected.filter((id) => decisions.get(id) === "BILL");
    if (!preview && billIds.length && (!/^\d+$/.test(input.reviewedGuestFee ?? "") || Number(input.reviewedGuestFee) !== guestFee || (other && Number(input.reviewedMemberFee) !== memberFee))) {
      throw new Error(other ? "活動費用已變更或未核對，請重新整理後再預覽開單" : "零打費已變更或未核對，請重新整理後再預覽開單");
    }
    const members = billIds.length ? await transaction.getAll(...billIds.map((id) => db.collection("members").doc(id))) : [];
    if (members.some((entry) => !entry.exists)) throw new Error("零打球友資料不存在，請重新整理");
    const memberById = new Map(members.map((entry) => [entry.id, entry]));
    const bookingsByMember = new Map(bookings.docs.map((doc) => [String(doc.data().memberId ?? doc.id), doc.data()]));
    const rows = billIds.sort().map((memberId) => {
      const data = memberById.get(memberId)!.data()!;
      const payerKind: "MEMBER" | "GUEST" = other && (startsAt > now ? memberAt(data, startsAt) : bookingsByMember.get(memberId)?.kindSnapshot === "MEMBER") ? "MEMBER" : "GUEST";
      const grossAmount = payerKind === "MEMBER" ? memberFee : guestFee;
      const creditApplied = Math.min(grossAmount, Math.max(0, Number(data.creditBalance ?? 0) - (prior.get(memberId) ?? 0)));
      if (!Number.isSafeInteger(creditApplied)) throw new Error("零打球友的帳戶餘額不正確");
      return { memberId, name: String(data.displayName ?? "未知使用者"), eventCount: 1, grossAmount, creditApplied, amount: grossAmount - creditApplied, ...(other ? { payerKind } : {}) };
    });
    const skipped = selected.filter((id) => decisions.get(id) === "SKIP").sort();
    const periodLabel = `${taipeiDate(startsAt)} ${other ? "單場活動費" : "零打費"}`;
    const totalAmount = rows.reduce((sum, row) => sum + row.amount, 0);
    const previewKey = createHash("sha256").update(JSON.stringify([eventRef.id, startsAt.toISOString(), endsAt.toISOString(), event.courts, guestFee, ...(other ? [memberFee] : []), rows, skipped])).digest("hex");
    if (preview) return { rows, periodLabel, totalAmount, previewKey };
    if (partial && previewKey !== input.previewKey) throw new Error("名單、場次或餘額已變更，請重新核對");
    const priced = new Map(rows.map((row) => [row.memberId, row]));
    const dueAt = billingBoundary(taipeiDate(new Date(now.getTime() + 7 * 86_400_000)), true);
    const results: GuestSettlement[] = [];
    for (const memberId of selected) {
      if (decisions.get(memberId) === "SKIP") {
        results.push({ memberId, status: "SKIPPED", amount: null });
        continue;
      }
      const member = memberById.get(memberId)!;
      const memberData = member.data()!;
      const { grossAmount, creditApplied, amount, payerKind } = priced.get(memberId)!;
      const feeLabel = other ? "單場活動費" : "零打活動費";
      // The transaction and roster decision prevent duplicates. A new booking after cancellation gets a new invoice ID.
      const invoiceId = "guest-settlement-" + randomUUID();
      const invoiceRef = db.collection("invoices").doc(invoiceId);
      transaction.create(invoiceRef, {
        id: invoiceId, memberId, memberNameSnapshot: String(memberData.displayName ?? "未知使用者"),
        eventId: eventRef.id, type: payerKind === "MEMBER" ? "MEMBER_SINGLE" : "SINGLE_EVENT", periodLabel: feeLabel, guestSettlementSource: "MANUAL",
        eventSnapshots: [{ id: eventRef.id, startsAt, endsAt, courts: String(event.courts ?? "") }],
        grossAmount, creditApplied, amount, dueAt, status: amount === 0 ? "CONFIRMED" : "PENDING",
        reportedAt: null, confirmedAt: amount === 0 ? now : null, createdAt: now, updatedAt: now,
      });
      // Every issuance for this payer writes the same member document,
      // including when no wallet credit is used.
      transaction.update(member.ref, { ...(creditApplied > 0 ? { creditBalance: FieldValue.increment(-creditApplied) } : {}), updatedAt: now });
      if (creditApplied > 0) {
        recordBalanceMovement(transaction, db, {
          memberId, amount: -creditApplied, reason: feeLabel + "抵扣", sourceKey: `invoice:${invoiceId}:apply`,
          invoiceId, eventId: eventRef.id, actorId: actor.id, actorName: actor.name, createdAt: now,
        });
      }
      transaction.create(db.collection("notifications").doc(), notificationData({
        title: "活動帳單已開立", message: `${taipeiDate(event.startsAt)} ${feeLabel}；應付 NT$${amount}`,
        type: "PAYMENT", tab: "費用管理", recipientId: memberId,
      }));
      results.push({ memberId, status: "ISSUED", amount, ...(other ? { payerKind } : {}) });
    }
    transaction.update(eventRef, { guestSettlements: [...existing, ...results], guestSettledAt: now, guestSettledBy: actor.id, updatedAt: now });
    return { issued: billIds.length, skipped: skipped.length, ...(partial ? { totalAmount } : {}) };
  });
}

async function cancel(input: Record<string, string>, actor: Viewer) {
  const db = getAdminFirestore();
  const memberSnapshot = await db.collection("members").doc(actor.id).get();
  if (!memberSnapshot.exists) throw new Error("找不到使用者");
  const eventRef = db.collection("events").doc(input.eventId);
  const bookingRef = eventRef.collection("bookings").doc(memberSnapshot.id);
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const [eventSnapshot, bookingSnapshot] = await transaction.getAll(eventRef, bookingRef);
    if (!eventSnapshot.exists || !bookingSnapshot.exists) throw new Error("找不到可取消的報名");
    const event = eventSnapshot.data()!;
    const booking = bookingSnapshot.data()!;
    if (booking.status !== "REGULAR" && booking.status !== "STANDBY") return;

    const beforeStart = (dateValue(event.startsAt)?.getTime() ?? 0) > now.getTime();
    if ((!isBadmintonEvent(event) || booking.kindSnapshot !== "MEMBER") && !beforeStart) throw new Error("活動已開始，不能自行取消報名；請聯絡幹部確認出席");
    const invoices = beforeStart ? await transaction.get(db.collection("invoices").where("eventId", "==", input.eventId)) : null;
    const relatedInvoices = invoices?.docs.filter((document) => document.data().memberId === memberSnapshot.id && ["SINGLE_EVENT", "MEMBER_EXTRA", "MEMBER_SINGLE"].includes(document.data().type) && ["PENDING", "REPORTED", "CONFIRMED"].includes(document.data().status)) ?? [];
    const pendingDecisions = beforeStart ? storedGuestSettlements(event) : [];
    const clearGuestDecision = pendingDecisions.some((entry) => entry.memberId === memberSnapshot.id);
    const linkedCredits = invoices?.docs.map((invoice) => invoice.data()).filter((invoice) => invoice.type === "CREDIT") ?? [];
    let promoted = 0;
    if (booking.status === "REGULAR" && beforeStart) {
      promoted = await promoteStandbyInTransaction(transaction, eventRef, event, 1, now);
    }

    transaction.update(bookingRef, { status: "CANCELLED", cancelledAt: now, updatedAt: now });
    if (booking.status === "REGULAR") {
      transaction.update(eventRef, {
        regularCount: FieldValue.increment(-1 + promoted),
        standbyCount: FieldValue.increment(-promoted),
        ...(clearGuestDecision ? { guestSettlements: pendingDecisions.filter((entry) => entry.memberId !== memberSnapshot.id) } : {}),
        updatedAt: now,
      });
    } else {
      transaction.update(eventRef, { standbyCount: FieldValue.increment(-1), updatedAt: now });
    }

    for (const invoice of relatedInvoices) cancelSingleEventInvoice(transaction, db, invoice, input.eventId, "BOOKING_CANCELLED", now, actor, linkedCredits.filter((credit) => credit.relatedInvoiceId === invoice.id));
  });
}

async function transfer(input: Record<string, string>, actor: Viewer) {
  const db = getAdminFirestore();
  const recipientName = validatedAccountName(input.recipient);
  const sourceRef = db.collection("members").doc(actor.id);
  const newRecipientRef = db.collection("members").doc(randomUUID());
  const claimCode = createClaimCodeRecord();
  const eventRef = db.collection("events").doc(input.eventId);
  const sourceBookingRef = eventRef.collection("bookings").doc(actor.id);
  const transferRef = db.collection("transfers").doc(`transfer-${input.eventId}-${actor.id}`);
  const notificationRef = db.collection("notifications").doc();
  const now = new Date();

  return db.runTransaction(async (transaction) => {
    // Resolve by the unique name inside the transaction, including legacy names.
    const nameClaim = await readMemberName(transaction, db, recipientName);
    if (nameClaim.member?.id === actor.id) throw new Error("不能將名額轉讓給自己");
    const recipientRef = nameClaim.member?.ref ?? newRecipientRef;
    const actualName = String(nameClaim.member?.data().displayName ?? nameClaim.displayName);
    const recipientBookingRef = eventRef.collection("bookings").doc(recipientRef.id);
    const [sourceSnapshot, eventSnapshot, sourceBookingSnapshot, recipientBookingSnapshot] = await transaction.getAll(sourceRef, eventRef, sourceBookingRef, recipientBookingRef);
    if (!sourceSnapshot.exists) throw new Error("找不到轉讓者");
    if (!eventSnapshot.exists) throw new Error("找不到活動");
    const event = eventSnapshot.data()!;
    const startsAt = dateValue(event.startsAt);
    if (event.status !== "SCHEDULED" || !startsAt || startsAt <= now) throw new Error("活動已開始或已取消，無法轉讓");
    if (!sourceBookingSnapshot.exists || !["REGULAR", "STANDBY"].includes(String(sourceBookingSnapshot.data()?.status))) throw new Error("沒有可轉讓的名額");
    if (recipientBookingSnapshot.exists && recipientBookingSnapshot.data()?.status !== "CANCELLED") throw new Error("接手者已在本次活動名單中");
    const sourceBooking = sourceBookingSnapshot.data()!;

    // All reads have completed; reserve the name and create the account atomically.
    reserveMemberName(transaction, nameClaim, recipientRef.id, now);
    if (!nameClaim.member) {
      transaction.create(recipientRef, {
        id: recipientRef.id,
        accountName: nameClaim.accountName,
        accountNameKey: nameClaim.nameKey,
        displayName: actualName,
        department: null,
        role: "MEMBER",
        membershipStatus: "GUEST",
        accountType: "unclaimed",
        joinedAt: null,
        endingAt: null,
        creditBalance: 0,
        claimCodeSalt: claimCode.salt,
        claimCodeHash: claimCode.hash,
        claimCodeCreatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    transaction.set(recipientBookingRef, {
      id: recipientBookingSnapshot.data()?.id ?? `${input.eventId}-${recipientRef.id}`,
      eventId: input.eventId,
      memberId: recipientRef.id,
      displayNameSnapshot: actualName,
      accountNameSnapshot: nameClaim.member ? memberAccountName(nameClaim.member.data()) : nameClaim.accountName,
      kindSnapshot: "GUEST",
      status: sourceBooking.status,
      confirmedAt: now,
      cancelledAt: null,
      transferredFromMemberId: actor.id,
      updatedAt: now,
    }, { merge: true });
    transaction.update(sourceBookingRef, { status: "TRANSFERRED", transferredAt: now, updatedAt: now });
    transaction.set(transferRef, {
      id: transferRef.id,
      eventId: input.eventId,
      sourceBookingId: String(sourceBooking.id ?? sourceBookingRef.id),
      sourceMemberId: actor.id,
      recipientId: recipientRef.id,
      settlement: "CONFIRMED",
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
    transaction.create(notificationRef, notificationData({ title: "收到活動名額", message: `${actor.name} 已將 ${taipeiDate(event.startsAt)} 的活動名額轉讓給你，費用請私下結清`, type: "TRANSFER", tab: "活動", recipientId: recipientRef.id }));
    return nameClaim.member ? undefined : { claimCode: claimCode.code, recipientName: actualName };
  });
}

function validatedAnnouncementInput(input: Record<string, string>) {
  const title = input.title?.trim();
  const content = input.content?.trim();
  const linkUrl = input.linkUrl?.trim() || null;
  if (!title || !content) throw new Error("請填寫公告標題與內容");
  if (title.length > 80 || content.length > 2000) throw new Error("公告內容超過字數限制");
  if (linkUrl) {
    try {
      const url = new URL(linkUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      throw new Error("外部連結必須是完整的 http:// 或 https:// 網址");
    }
  }
  return { title, content, linkUrl };
}

async function publish(input: Record<string, string>) {
  const values = validatedAnnouncementInput(input);
  const db = getAdminFirestore();
  const announcementRef = db.collection("announcements").doc();
  const notificationRef = db.collection("notifications").doc();
  const now = new Date();
  const batch = db.batch();
  batch.set(announcementRef, { id: announcementRef.id, ...values, pinned: false, publishedAt: now, updatedAt: now });
  batch.set(notificationRef, notificationData({ title: "新公告", message: values.title, type: "ANNOUNCEMENT", tab: "公告" }));
  await batch.commit();
}

async function updateAnnouncement(input: Record<string, string>) {
  if (!input.announcementId) throw new Error("缺少公告識別碼");
  const values = validatedAnnouncementInput(input);
  const reference = getAdminFirestore().collection("announcements").doc(input.announcementId);
  const announcement = await reference.get();
  if (!announcement.exists) throw new Error("找不到公告");
  await reference.update({ ...values, updatedAt: new Date() });
}

async function deleteAnnouncement(announcementId: string) {
  if (!announcementId) throw new Error("缺少公告識別碼");
  const reference = getAdminFirestore().collection("announcements").doc(announcementId);
  const announcement = await reference.get();
  if (!announcement.exists) return;
  await reference.delete();
}

async function setAnnouncementPinned(announcementId: string, pinned: string) {
  if (!announcementId) throw new Error("缺少公告識別碼");
  const reference = getAdminFirestore().collection("announcements").doc(announcementId);
  const announcement = await reference.get();
  if (!announcement.exists) throw new Error("找不到公告");
  await reference.update({ pinned: pinned === "true", updatedAt: new Date() });
}

function validatedEventInput(input: Record<string, string>) {
  if (!input.startsAt || !input.endsAt || !input.courts?.trim()) throw new Error("請填寫活動日期、時間與場地");
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  const regularCapacity = Number(input.regularCapacity || 10);
  const standbyCapacity = Number(input.standbyCapacity === "" || input.standbyCapacity == null ? 4 : input.standbyCapacity);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) throw new Error("結束時間必須晚於開始時間");
  if (!Number.isInteger(regularCapacity) || regularCapacity < 1 || !Number.isInteger(standbyCapacity) || standbyCapacity < 0) throw new Error("請填寫正確的正取與候補人數");
  if (regularCapacity + standbyCapacity > 100) throw new Error("單場正取與候補合計最多 100 人");
  return { startsAt, endsAt, courts: input.courts.trim(), regularCapacity, standbyCapacity, date: taipeiDate(startsAt) };
}

function eventAmount(raw: string | undefined, label: string) {
  if (!raw?.trim()) return undefined;
  const amount = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(amount) || amount < 1 || amount > 10_000) {
    throw new Error(label + "須為 1 至 10,000 元的整數");
  }
  return amount;
}

async function createEvent(input: Record<string, string>, actor: Viewer) {
  const values = validatedEventInput(input);
  const eventKind = input.eventKind || "BADMINTON";
  if (eventKind !== "BADMINTON" && eventKind !== "OTHER") throw new Error("活動類型不正確");
  const badminton = eventKind === "BADMINTON";
  const requested = input.memberBilling || (badminton ? "NORMAL" : "FREE");
  if (requested === "EXTRA") throw new Error("活動建立不會開單；請建立後另行預覽與確認社員加場費");
  if (!["NORMAL", "NO_CHARGE", "FREE"].includes(requested) || (!badminton && requested === "NO_CHARGE")) throw new Error("請選擇符合活動類型的收費方式");
  const requestedReason = input.billingReason?.trim() ?? "";
  if (requestedReason.length > 200 || (requested === "NO_CHARGE" && !requestedReason)) throw new Error("請填寫不另計社員費的原因（最多 200 字）");
  if (values.startsAt <= new Date()) throw new Error("不能新增已開始的活動");
  const db = getAdminFirestore();
  const customMemberRate = requested === "FREE" ? undefined : eventAmount(input.memberAmount, "社員費用");
  const customGuestRate = requested === "FREE" ? undefined : eventAmount(input.guestAmount, "非社員費用");
  const [defaultMemberRate, defaultGuestRate, memberSnapshot] = await Promise.all([
    activeFee(db, "MEMBER_VISIT", values.startsAt),
    activeFee(db, "GUEST_VISIT", values.startsAt),
    db.collection("members").get(),
  ]);
  const defaultMembers = badminton ? memberSnapshot.docs.filter((document) => memberAt(document.data(), values.startsAt)) : [];
  const memberRate = customMemberRate ?? defaultMemberRate;
  const guestRate = customGuestRate ?? defaultGuestRate;
  const eventRef = db.collection("events").doc();
  const eventDateRef = db.collection("eventDates").doc(values.date);
  const notificationRef = input.notify === "false" ? null : db.collection("notifications").doc();
  const now = new Date();
  const memberBilling = await db.runTransaction(async (transaction) => {
    const [manager, dateSnapshot, periods, nearbyEvents] = await Promise.all([
      transaction.get(db.collection("members").doc(actor.id)),
      badminton ? transaction.get(eventDateRef) : null,
      badminton ? transaction.get(db.collection("billingPeriods")) : null,
      badminton ? transaction.get(db.collection("events").where("startsAt", ">=", billingBoundary(values.date)).where("startsAt", "<=", billingBoundary(values.date, true))) : null,
    ]);
    if (manager.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    const lockedPeriod = quarterPeriodForDate(periods?.docs ?? [], values.date, ["GENERATING", "ACTIVE"]);
    const memberBilling = lockedPeriod && requested === "NORMAL" ? "NO_CHARGE" : requested;
    const billingReason = memberBilling !== requested ? "季度社費已開立或處理中，本場不另計社員費" : requestedReason;
    const memberFeeSnapshot = memberBilling === "NO_CHARGE" || memberBilling === "FREE" ? 0 : memberRate;
    const guestFeeSnapshot = memberBilling === "FREE" ? 0 : guestRate;
    if (dateSnapshot?.exists || nearbyEvents?.docs.some((doc) => isBadmintonEvent(doc.data()) && doc.data().status !== "CANCELLED")) throw new Error("這一天已有羽球活動，請直接編輯既有活動");
    transaction.create(eventRef, {
      id: eventRef.id,
      startsAt: values.startsAt,
      endsAt: values.endsAt,
      courts: values.courts,
      regularCapacity: values.regularCapacity,
      standbyCapacity: values.standbyCapacity,
      memberFeeSnapshot,
      memberListRateSnapshot: memberRate,
      guestFeeSnapshot,
      regularCount: defaultMembers.length,
      standbyCount: 0,
      memberDefaultsVersion: MEMBER_DEFAULTS_VERSION,
      source: "MANUAL",
      eventKind,
      memberBilling,
      billingReason: billingReason || null,
      status: "SCHEDULED",
      createdAt: now,
      updatedAt: now,
    });
    if (badminton) transaction.create(eventDateRef, { eventId: eventRef.id, date: values.date, createdAt: now });
    for (const memberDocument of defaultMembers) {
      transaction.create(
        eventRef.collection("bookings").doc(memberDocument.id),
        defaultMemberBooking(eventRef.id, memberDocument.id, memberDocument.data(), now),
      );
    }

    if (notificationRef) transaction.create(notificationRef, notificationData({ title: "新活動已排程", message: `${values.date} ${values.courts}；${badminton ? "社員已預設正取，非社員可依剩餘名額報名" : "請自行報名"}`, type: "EVENT", tab: "活動" }));
    return memberBilling;
  });
  return { eventId: eventRef.id, date: values.date, memberBilling };
}

async function updateEvent(input: Record<string, string>, actor: Viewer) {
  if (!input.eventId || input.eventId.includes("/") || input.eventId.length > 200) throw new Error("活動識別碼不正確");
  const values = validatedEventInput(input);
  const requested = input.memberBilling;
  if (requested && !["NORMAL", "FREE"].includes(requested)) throw new Error("請選擇收費或不收費");
  const memberPrice = requested !== "FREE" ? eventAmount(input.memberAmount, "社員費用") : undefined;
  const guestPrice = requested !== "FREE" ? eventAmount(input.guestAmount, "非社員費用") : undefined;
  const updatesBilling = Boolean(requested || memberPrice !== undefined || guestPrice !== undefined);
  const db = getAdminFirestore();
  const eventRef = db.collection("events").doc(input.eventId);
  const now = new Date();
  await db.runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(eventRef);
    if (!eventSnapshot.exists || (eventSnapshot.data()?.status ?? "SCHEDULED") !== "SCHEDULED") throw new Error("找不到可編輯的活動");
    const event = eventSnapshot.data()!;
    const badminton = isBadmintonEvent(event);
    const oldDate = taipeiDate(event.startsAt);
    const oldDateRef = db.collection("eventDates").doc(oldDate);
    const newDateRef = db.collection("eventDates").doc(values.date);
    const originallyFree = event.memberBilling === "FREE" || (!badminton && event.memberBilling !== "NORMAL");
    const reenable = originallyFree && requested === "NORMAL";
    const [manager, newDateSnapshot, bookingSnapshot, linkedPeriods, direct, grouped, allPeriods] = await Promise.all([
      transaction.get(db.collection("members").doc(actor.id)),
      badminton ? transaction.get(newDateRef) : null,
      transaction.get(eventRef.collection("bookings")),
      transaction.get(db.collection("billingPeriods").where("eventIds", "array-contains", input.eventId)),
      updatesBilling ? transaction.get(db.collection("invoices").where("eventId", "==", input.eventId)) : null,
      updatesBilling ? transaction.get(db.collection("invoices").where("eventIds", "array-contains", input.eventId)) : null,
      reenable && badminton ? transaction.get(db.collection("billingPeriods")) : null,
    ]);
    if (manager.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");

    if (newDateSnapshot?.exists && newDateSnapshot.data()?.eventId !== input.eventId) throw new Error("這一天已有其他羽球活動");

    const scheduleChanged = iso(event.startsAt) !== values.startsAt.toISOString()
      || iso(event.endsAt) !== values.endsAt.toISOString() || String(event.courts ?? "") !== values.courts;
    if (scheduleChanged && linkedPeriods.docs.some((period) => period.data().status === "GENERATING")) {
      throw new Error("本場季度社費正在開單，請等開單完成後再調整日期或場地");
    }

    const feeUpdates: DocumentData = {};
    const draftUpdates: { ref: DocumentReference; values: DocumentData }[] = [];
    if (updatesBilling) {
      const wasFree = !eventAllowsNewBilling(event);
      const free = requested ? requested === "FREE" : wasFree;
      const bills = [...new Map([...(direct?.docs ?? []), ...(grouped?.docs ?? [])].map((doc) => [doc.id, doc.data()])).values()];
      const { member: memberLocked, guest: guestLocked } = eventFeeLocks(event, input.eventId, linkedPeriods.docs.map((doc) => doc.data()), bills);
      const oldMemberPrice = Number(event.memberListRateSnapshot ?? (Number(event.memberFeeSnapshot) > 0 ? event.memberFeeSnapshot : 150));
      const oldGuestPrice = Number(event.guestFeeSnapshot ?? 180);
      if (!free && memberLocked && memberPrice !== undefined && memberPrice !== oldMemberPrice) throw new Error("社員費已開單，無法修改價格");
      if (!free && guestLocked && guestPrice !== undefined && guestPrice !== oldGuestPrice) throw new Error("非社員費已開單，無法修改價格");
      if (free !== wasFree) feeUpdates.billingPaused = free;
      if (!free) {
        if (originallyFree) {
          feeUpdates.memberBilling = quarterPeriodForDate(allPeriods?.docs ?? [], values.date, ["GENERATING", "ACTIVE"]) ? "NO_CHARGE" : "NORMAL";
          feeUpdates.billingReason = "";
          if (!memberLocked) {
            feeUpdates.memberListRateSnapshot = memberPrice ?? oldMemberPrice;
            feeUpdates.memberFeeSnapshot = feeUpdates.memberBilling === "NORMAL" ? feeUpdates.memberListRateSnapshot : 0;
          }
          if (!guestLocked) feeUpdates.guestFeeSnapshot = guestPrice ?? (oldGuestPrice > 0 ? oldGuestPrice : 180);
        } else {
          if (memberPrice !== undefined && memberPrice !== oldMemberPrice) {
            feeUpdates.memberListRateSnapshot = memberPrice;
            if (event.memberBilling !== "NO_CHARGE") feeUpdates.memberFeeSnapshot = memberPrice;
          }
          if (guestPrice !== undefined && guestPrice !== oldGuestPrice) feeUpdates.guestFeeSnapshot = guestPrice;
        }
      }
      if (!wasFree && (free || feeUpdates.memberFeeSnapshot !== undefined)) {
        for (const draft of linkedPeriods.docs.filter((doc) => doc.data().status === "PLANNED")) {
          const period = draft.data();
          const snapshots = period.eventSnapshots ?? [];
          const ids: string[] = period.eventIds;
          const amounts = ids.map((id, index) => id === input.eventId ? Number(feeUpdates.memberFeeSnapshot ?? 0)
            : Number(period.eventAmounts?.[index] ?? snapshots[index]?.memberFeeSnapshot));
          if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) throw new Error("草稿費率資料不完整，請先核對季度草稿");
          const keep = (_item: unknown, index: number) => !free || ids[index] !== input.eventId;
          const eventAmounts = amounts.filter(keep);
          const eventIds = ids.filter(keep);
          const eventSnapshots = snapshots.map((snapshot: DocumentData, index: number) => ids[index] === input.eventId
            ? { ...snapshot, memberFeeSnapshot: amounts[index] } : snapshot).filter(keep);
          draftUpdates.push({ ref: draft.ref, values: { eventIds, eventAmounts, eventSnapshots,
            eventCount: eventIds.length, grossAmount: eventAmounts.reduce((sum, amount) => sum + amount, 0), updatedAt: now,
            ...(period.origin === "BILLING_MANAGER" ? { confirmationKey: createHash("sha256").update(JSON.stringify([period.confirmationKey, eventIds, eventAmounts])).digest("hex") } : {}),
          } });
        }
      }
    }
    const feesChanged = Object.keys(feeUpdates).length > 0;
    const regularCount = Number(event.regularCount ?? 0);
    const standbyCount = Number(event.standbyCount ?? 0);
    const promoted = await promoteStandbyInTransaction(transaction, eventRef, event, Math.max(0, values.regularCapacity - regularCount), now);
    const remainingStandby = standbyCount - promoted;
    if (values.standbyCapacity < remainingStandby) throw new Error(`調整後仍有 ${remainingStandby} 位候補，候補容量不能低於目前人數`);

    for (const draft of draftUpdates) transaction.update(draft.ref, draft.values);
    transaction.update(eventRef, {
      ...feeUpdates,
      startsAt: values.startsAt,
      endsAt: values.endsAt,
      courts: values.courts,
      regularCapacity: values.regularCapacity,
      standbyCapacity: values.standbyCapacity,
      regularCount: FieldValue.increment(promoted),
      standbyCount: FieldValue.increment(-promoted),
      changes: FieldValue.arrayUnion({ reason: feesChanged ? "更新活動收費設定" : "調整活動時間／場地／容量，計費基準不變", ...(feesChanged ? { billingBefore: { billingPaused: event.billingPaused === true, memberBilling: event.memberBilling ?? "NORMAL", memberFee: event.memberFeeSnapshot ?? 150, guestFee: event.guestFeeSnapshot ?? 180 }, billingAfter: feeUpdates } : {}), before: { startsAt: iso(event.startsAt), endsAt: iso(event.endsAt), courts: event.courts }, after: { startsAt: values.startsAt.toISOString(), endsAt: values.endsAt.toISOString(), courts: values.courts }, actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() }),
      updatedAt: now,
    });
    if (badminton) {
      if (oldDate !== values.date) transaction.delete(oldDateRef);
      transaction.set(newDateRef, { eventId: input.eventId, date: values.date, updatedAt: now }, { merge: true });
    }
    for (const booking of bookingSnapshot.docs.filter((document) => ["REGULAR", "STANDBY"].includes(String(document.data().status)))) {
      const recipientId = String(booking.data().memberId ?? booking.id);
      const notificationRef = db.collection("notifications").doc();
      transaction.create(notificationRef, notificationData({ title: "活動資訊已更新", message: `${values.date} ${values.courts}，請重新確認${feesChanged ? "活動資訊與收費" : "日期、時間與集合地點"}`, type: "EVENT", tab: "活動", recipientId }));
    }
  });
}

async function cancelEvent(input: Record<string, string>, actor: Viewer, preview = false) {
  const { eventId, previewKey } = input;
  if (!eventId || eventId.includes("/") || eventId.length > 200) throw new Error("缺少有效的活動識別碼");
  const rawNote = input.reason ?? input.note ?? "";
  if (typeof rawNote !== "string" || rawNote.trim().length > 200) throw new Error("活動取消原因最多 200 字");
  if ((!preview && !previewKey) || (previewKey && !/^[0-9a-f]{64}$/.test(previewKey))) throw new Error("請重新預覽取消影響後再確認");
  if (!preview && !rawNote.trim()) throw new Error("請填寫活動取消原因");
  const db = getAdminFirestore();
  const eventRef = db.collection("events").doc(eventId);
  return db.runTransaction((transaction) => cancelEventInTransaction(transaction, db, eventRef, "ADMIN_CANCELLED", new Date(), actor, { preview, previewKey, note: rawNote.trim() }));
}


function parseQuarterSchedule(input: string) {
  let parsed: { rules: QuarterRules; activities: SuggestedActivity[] } | null;
  try { parsed = JSON.parse(input); } catch { throw new Error("季度規劃格式不正確"); }
  if (!parsed) throw new Error("季度規劃格式不正確");
  validateQuarterSchedule(parsed.rules, parsed.activities);
  const rules: QuarterRules = {
    label: parsed.rules.label.trim(), startDate: parsed.rules.startDate, endDate: parsed.rules.endDate,
    weekday: parsed.rules.weekday, startTime: parsed.rules.startTime, endTime: parsed.rules.endTime,
    courts: parsed.rules.courts.trim(), regularCapacity: parsed.rules.regularCapacity, standbyCapacity: parsed.rules.standbyCapacity,
    excludedDates: [...new Set(parsed.rules.excludedDates)].sort(),
  };
  const activities = parsed.activities.map((entry) => ({
    date: entry.date, startTime: entry.startTime, endTime: entry.endTime, courts: entry.courts.trim(),
    regularCapacity: entry.regularCapacity, standbyCapacity: entry.standbyCapacity,
  })).sort((a, b) => a.date.localeCompare(b.date));
  return { rules, activities };
}

function existingQuarterConfirmation(snapshot: DocumentSnapshot, confirmationKey: string) {
  const plan = snapshot.data();
  if (!plan) return null;
  if (plan.status !== "CONFIRMED" || plan.confirmationKey !== confirmationKey) {
    throw new Error("此季度識別碼已使用，請重新整理頁面後再確認");
  }
  return { eventCount: Number(plan.eventCount), totalAmount: Number(plan.grossAmount), planId: snapshot.id, skippedDates: Array.isArray(plan.skippedDates) ? plan.skippedDates.map(String) : [] };
}

async function confirmQuarterPlan(input: Record<string, string>, actor: Viewer) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.planId ?? "")) throw new Error("季度識別碼不正確");
  const { rules: plan, activities } = parseQuarterSchedule(input.schedule ?? "");
  const confirmationKey = createHash("sha256").update(JSON.stringify({ plan, activities })).digest("hex");
  const activitiesByDate = new Map<string, SuggestedActivity>();
  const repeatedDates = new Set<string>();
  for (const activity of activities) {
    if (activitiesByDate.has(activity.date)) repeatedDates.add(activity.date);
    else activitiesByDate.set(activity.date, activity);
  }
  const db = getAdminFirestore();
  const planRef = db.collection("quarterPlans").doc(input.planId);
  const confirmed = existingQuarterConfirmation(await planRef.get(), confirmationKey);
  if (confirmed) return confirmed;
  const calendar = await fetchOfficialClosures(plan.startDate, plan.endDate).then(
    (closures) => ({ closedDates: new Set(closures.map((entry) => entry.date)) }),
    (error: unknown) => ({ error }),
  );
  return db.runTransaction(async (transaction) => {
    const [existingPlan, manager] = await transaction.getAll(planRef, db.collection("members").doc(actor.id));
    if (manager.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    const confirmed = existingQuarterConfirmation(existingPlan, confirmationKey);
    if (confirmed) return confirmed;
    const now = new Date();
    // Date-index reads and writes are in this same transaction. On contention
    // Firestore retries against the new date reservation before creating anything.
    const [dates, nearbyEvents] = await Promise.all([
      transaction.getAll(...[...activitiesByDate.keys()].map((date) => db.collection("eventDates").doc(date))),
      transaction.get(db.collection("events")
        .where("startsAt", ">=", billingBoundary(plan.startDate))
        .where("startsAt", "<=", billingBoundary(plan.endDate, true))),
    ]);
    const occupied = new Set(dates.filter((doc) => doc.exists).map((doc) => doc.id));
    // Imported activities are also protected if an old record is missing its date index.
    for (const doc of nearbyEvents.docs) {
      const event = doc.data();
      if (event.status === "CANCELLED" || !isBadmintonEvent(event)) continue;
      const date = taipeiDate(event.startsAt);
      if (activitiesByDate.has(date)) occupied.add(date);
    }
    const skippedDates = [...new Set([...repeatedDates, ...occupied])].sort();
    const newActivities = [...activitiesByDate.values()].filter((entry) => !occupied.has(entry.date));
    if (!newActivities.length) return { eventCount: 0, totalAmount: 0, planId: planRef.id, skippedDates };
    if (newActivities.some((entry) => new Date(entry.date + "T" + entry.startTime + ":00+08:00") <= now)) throw new Error("建議場次包含已開始的日期，請先調整");
    if ("error" in calendar) throw calendar.error;
    const conflictsWithCalendar = newActivities.filter((entry) => calendar.closedDates.has(entry.date));
    if (conflictsWithCalendar.length) throw new Error("以下場次遇國定假日或新北市停班停課，請先調整：" + conflictsWithCalendar.map((entry) => entry.date).join("、"));
    const [periods, members, rates] = await Promise.all([
      transaction.get(db.collection("billingPeriods")),
      transaction.get(db.collection("members")),
      transaction.get(db.collection("feeRates")),
    ]);
    const rateFor = (kind: string, startsAt: Date) => {
      const rate = rates.docs.map((doc) => doc.data()).filter((rate) => rate.kind === kind && (!dateValue(rate.effectiveFrom) || dateValue(rate.effectiveFrom)! <= startsAt) && (!dateValue(rate.effectiveTo) || dateValue(rate.effectiveTo)! > startsAt))
        .sort((a, b) => (dateValue(b.effectiveFrom)?.getTime() ?? 0) - (dateValue(a.effectiveFrom)?.getTime() ?? 0))[0];
      return Number(rate?.amount ?? (kind === "MEMBER_VISIT" ? 150 : 180));
    };
    const snapshots = newActivities.map((entry, index) => {
      const startsAt = new Date(entry.date + "T" + entry.startTime + ":00+08:00");
      const endsAt = new Date(entry.date + "T" + entry.endTime + ":00+08:00");
      const eventRef = db.collection("events").doc("quarter-" + planRef.id + "-" + index);
      const defaultMembers = members.docs.filter((member) => memberAt(member.data(), startsAt));
      const memberBilling = quarterPeriodForDate(periods.docs, entry.date, ["GENERATING", "ACTIVE"]) ? "NO_CHARGE" : "NORMAL";
      const memberListRateSnapshot = rateFor("MEMBER_VISIT", startsAt);
      const memberFeeSnapshot = memberBilling === "NO_CHARGE" ? 0 : memberListRateSnapshot;
      transaction.create(eventRef, { id: eventRef.id, startsAt, endsAt, courts: entry.courts, regularCapacity: entry.regularCapacity, standbyCapacity: entry.standbyCapacity, memberFeeSnapshot, memberListRateSnapshot, guestFeeSnapshot: rateFor("GUEST_VISIT", startsAt), regularCount: defaultMembers.length, standbyCount: 0, memberDefaultsVersion: MEMBER_DEFAULTS_VERSION, source: "QUARTER_PLAN", quarterPlanId: planRef.id, eventKind: "BADMINTON", memberBilling, status: "SCHEDULED", createdAt: now, updatedAt: now });
      transaction.create(db.collection("eventDates").doc(entry.date), { eventId: eventRef.id, date: entry.date, createdAt: now });
      for (const member of defaultMembers) transaction.create(eventRef.collection("bookings").doc(member.id), defaultMemberBooking(eventRef.id, member.id, member.data(), now));
      return eventRef.id;
    });
    const eventIds = snapshots;
    transaction.create(planRef, { id: planRef.id, ...plan, activities: newActivities, skippedDates, status: "CONFIRMED", confirmationKey, eventIds, eventCount: eventIds.length, grossAmount: 0, confirmedBy: actor.id, confirmedAt: now, createdAt: now, updatedAt: now });
    transaction.create(db.collection("notifications").doc(), notificationData({ title: "一批羽球活動已排程", message: plan.label + " 新增 " + eventIds.length + " 場；社員已預設參加。這次排程未建立帳單", type: "EVENT", tab: "活動" }));
    return { planId: planRef.id, eventCount: eventIds.length, totalAmount: 0, skippedDates };
  });
}

async function createQuarterBillingPeriod(input: Record<string, string>, actor: Viewer, preview = false) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.periodId ?? "")) throw new Error("季度社費期間識別碼不正確");
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label || label.length > 60) throw new Error("請填寫季度社費名稱（最多 60 字）");
  validateQuarterDateRange(input.startDate, input.endDate);
  let raw: unknown;
  try { raw = JSON.parse(input.eventIds ?? ""); } catch { throw new Error("請選擇要納入季度社費的活動"); }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32 || raw.some((id) => typeof id !== "string" || !id || id.length > 200 || id.includes("/"))) {
    throw new Error("每期請選擇 1 至 32 場活動");
  }
  const selectedIds = [...new Set<string>(raw)].sort();
  const confirmationKey = createHash("sha256").update(JSON.stringify([label, input.startDate, input.endDate, selectedIds])).digest("hex");
  const db = getAdminFirestore();
  const periodRef = db.collection("billingPeriods").doc("quarter-" + input.periodId);
  const now = new Date();
  return db.runTransaction(async (transaction) => {
    const [manager, existingPeriod] = await transaction.getAll(db.collection("members").doc(actor.id), periodRef);
    if (manager.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    const existing = existingPeriod.data();
    if (existing) {
      if (!preview && !input.previewKey && existing.origin === "BILLING_MANAGER" && existing.confirmationKey === confirmationKey)
        return { periodId: input.periodId, eventCount: Number(existing.eventCount), totalAmount: Number(existing.grossAmount), skippedEventIds: existing.skippedEventIds ?? [] };
      if (existing.origin !== "BILLING_MANAGER" || existing.status !== "PLANNED") throw new Error("這個季度社費期間不能編輯");
      if (existing.confirmationKey !== confirmationKey && (!input.expectedRevision || existing.confirmationKey !== input.expectedRevision)) throw new Error("季度社費草稿已變更，請重新開啟後再編輯");
    } else if (input.expectedRevision) throw new Error("找不到可編輯的季度社費草稿");
    const [periods, events, invoices] = await Promise.all([
      transaction.get(db.collection("billingPeriods")),
      transaction.getAll(...selectedIds.map((id) => db.collection("events").doc(id))),
      transaction.get(db.collection("invoices")),
    ]);
    if (periods.docs.some((doc) => {
      const period = doc.data();
      return doc.id !== periodRef.id && ["PLANNED", "GENERATING", "ACTIVE"].includes(String(period.status)) && String(period.startDate) <= input.endDate && String(period.endDate) >= input.startDate;
    })) throw new Error("季度社費期間不能重疊，請先調整起訖日期");
    const covered = new Set<string>();
    for (const doc of periods.docs) if (doc.id !== periodRef.id && Array.isArray(doc.data().eventIds)) for (const id of doc.data().eventIds) covered.add(String(id));
    for (const invoice of invoices.docs) addQuarterChargeCoverage(covered, invoice.data());
    const eventSnapshots = events.flatMap((doc) => {
      const data = doc.data();
      const startsAt = dateValue(data?.startsAt);
      if (!data || !startsAt || !Number.isFinite(startsAt.getTime()) || covered.has(doc.id) || !isQuarterEligibleEvent(data)) return [];
      const date = taipeiDate(startsAt);
      if (date < input.startDate || date > input.endDate) return [];
      const memberFeeSnapshot = Number(data.memberFeeSnapshot ?? 150);
      if (!Number.isSafeInteger(memberFeeSnapshot) || memberFeeSnapshot < 0) throw new Error("活動缺少有效的社員費率，請先核對");
      return [{ id: doc.id, startsAt, endsAt: dateValue(data.endsAt), courts: String(data.courts ?? ""), memberFeeSnapshot }];
    }).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id));
    if (!eventSnapshots.length) throw new Error("沒有可納入季度社費的活動，請重新選擇");
    const eventIds = eventSnapshots.map((event) => event.id);
    const selected = new Set(eventIds);
    const skippedEventIds = selectedIds.filter((id) => !selected.has(id));
    const eventAmounts = eventSnapshots.map((event) => event.memberFeeSnapshot);
    const grossAmount = eventAmounts.reduce((sum, amount) => sum + amount, 0);
    const values = {
      confirmationKey,
      label, startDate: input.startDate, endDate: input.endDate, eventIds, eventAmounts, eventSnapshots, skippedEventIds,
      eventCount: eventIds.length, grossAmount, confirmedBy: actor.id, confirmedAt: now, updatedAt: now,
    };
    if (preview || input.previewKey) {
      if (skippedEventIds.length) throw new Error("有場次已變更或已開單，請重新選取");
      const dueAt = billingBoundary(input.dueDate, true);
      if (dueAt < now) throw new Error("繳費期限不能是過去日期");
      const members = await transaction.get(db.collection("members"));
      const byId = new Map(events.map((doc) => [doc.id, doc]));
      const quote = quarterlyQuote({ ...values, id: periodRef.id, status: "PLANNED" }, members.docs,
        eventIds.map((id) => byId.get(id)!), invoices.docs, dueAt, preview ? previewCredit(input.priorCredit) : undefined);
      if (preview) return quote;
      if (!quote.rows.length || quote.previewKey !== input.previewKey) throw new Error("場次、名單或餘額已變更，請重新核對");
    }
    if (existing) transaction.update(periodRef, values);
    else transaction.create(periodRef, { ...values, id: periodRef.id, type: "QUARTERLY_MEMBER", origin: "BILLING_MANAGER", status: "PLANNED", createdAt: now });
    return { periodId: input.periodId, eventCount: eventIds.length, totalAmount: grossAmount, skippedEventIds };
  });
}

function billingBoundary(value: string | undefined, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) throw new Error("請填寫正確的帳單期間");
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}+08:00`);
  if (Number.isNaN(date.getTime())) throw new Error("請填寫正確的帳單期間");
  return date;
}

function membershipChargeRemoved(invoice: DocumentData, eventId: string) {
  return Array.isArray(invoice.adjustments) && invoice.adjustments.some((entry: DocumentData) =>
    entry.eventId === eventId && ["MEMBERSHIP_END_REDUCTION", "MEMBERSHIP_END_CREDIT"].includes(entry.kind));
}

function memberChargesForEvent(invoices: DocumentData[], eventId: string) {
  return invoices.some((invoice) => invoiceCoversEvent(invoice, eventId));
}

async function memberExtraQuote(transaction: Transaction, db: Firestore, event: DocumentSnapshot, now: Date, prior = new Map<string, number>()) {
  const data = event.data();
  const startsAt = dateValue(data?.startsAt);
  if (!data || !isBadmintonEvent(data) || data.status !== "SCHEDULED" || !startsAt || !Number.isFinite(startsAt.getTime()) || startsAt <= now
    || !eventAllowsNewBilling(data) || ![undefined, null, "NORMAL", "NO_CHARGE"].includes(data.memberBilling)) throw new Error("這場活動不能另開社員加場費");
  const fee = Number(data.memberListRateSnapshot ?? data.memberFeeSnapshot ?? 150);
  if (!Number.isSafeInteger(fee) || fee <= 0 || fee > 10_000) throw new Error("這場活動沒有有效的社員費率，請先核對");
  const [bookings, periods, direct, grouped] = await Promise.all([
    transaction.get(event.ref.collection("bookings")),
    transaction.get(db.collection("billingPeriods").where("eventIds", "array-contains", event.id)),
    transaction.get(db.collection("invoices").where("eventId", "==", event.id)),
    transaction.get(db.collection("invoices").where("eventIds", "array-contains", event.id)),
  ]);
  const covered = new Set<string>();
  const invoices = [...new Map([...direct.docs, ...grouped.docs].map((doc) => [doc.id, doc.data()])).values()];
  for (const invoice of invoices) addQuarterChargeCoverage(covered, invoice);
  if (periods.docs.length || covered.has(event.id)) throw new Error("本場已納入季度社費或已另開帳單，不能重複收費");
  const memberIds = [...new Set(bookings.docs.filter((doc) => {
    const booking = doc.data();
    return booking.status === "REGULAR" && booking.kindSnapshot === "MEMBER" && !booking.transferredFromMemberId;
  }).map((doc) => String(doc.data().memberId ?? doc.id)))];
  if (memberIds.length > 100) throw new Error("本場社員超過 100 位，無法在同一批安全開立加場費");
  const members = memberIds.length ? await transaction.getAll(...memberIds.map((id) => db.collection("members").doc(id))) : [];
  const rows = members.flatMap((member) => {
    const data = member.data();
    if (!data || !memberAt(data, startsAt) || memberChargesForEvent(invoices.filter((invoice) => invoice.memberId === member.id), event.id)) return [];
    const creditApplied = Math.min(Math.max(0, Number(data.creditBalance ?? 0) - (prior.get(member.id) ?? 0)), fee);
    return [{ memberId: member.id, name: String(data.displayName ?? ""), eventCount: 1, eventIds: [event.id], grossAmount: fee, creditApplied, amount: fee - creditApplied }];
  }).sort((a, b) => a.memberId.localeCompare(b.memberId));
  const previewKey = createHash("sha256").update(JSON.stringify([event.id, startsAt.toISOString(), rows])).digest("hex");
  return { startsAt, fee, periodLabel: `${taipeiDate(startsAt)} 社員加場費`, rows, totalAmount: rows.reduce((sum, row) => sum + row.amount, 0), previewKey };
}

async function previewMemberExtraBills(input: Record<string, string>, actor: Viewer) {
  if (!input.eventId || input.eventId.includes("/") || input.eventId.length > 200) throw new Error("活動識別碼不正確");
  const db = getAdminFirestore();
  return db.runTransaction(async (transaction) => {
    const [manager, event] = await transaction.getAll(db.collection("members").doc(actor.id), db.collection("events").doc(input.eventId));
    if (manager.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    const { periodLabel, rows, totalAmount, previewKey } = await memberExtraQuote(transaction, db, event, new Date(), previewCredit(input.priorCredit));
    return { periodLabel, rows, totalAmount, previewKey };
  });
}

async function publishMemberExtraBills(input: Record<string, string>, actor: Viewer) {
  if (!input.eventId || input.eventId.includes("/") || input.eventId.length > 200) throw new Error("活動識別碼不正確");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason || reason.length > 200) throw new Error("請填寫另收加場費原因（最多 200 字）");
  if (!/^[a-f0-9]{64}$/.test(input.previewKey ?? "")) throw new Error("請先預覽並確認社員加場帳單");
  const db = getAdminFirestore();
  const now = new Date();
  return db.runTransaction(async (transaction) => {
    const [manager, event] = await transaction.getAll(db.collection("members").doc(actor.id), db.collection("events").doc(input.eventId));
    if (manager.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    const prior = event.data()?.memberExtraBilling;
    if (prior) {
      if (prior.previewKey === input.previewKey && prior.reason === reason) return { invoiceCount: Number(prior.invoiceCount), totalAmount: Number(prior.totalAmount) };
      throw new Error("加場費已開單，請勿重複開單");
    }
    const quote = await memberExtraQuote(transaction, db, event, now);
    if (quote.previewKey !== input.previewKey) throw new Error("名單、費率或餘額已變更，請重新預覽");
    if (!quote.rows.length) throw new Error("本場沒有可開單的社員");
    for (const row of quote.rows) {
      const invoiceRef = db.collection("invoices").doc(`extra-${event.id}-${row.memberId}`);
      transaction.create(invoiceRef, {
        id: invoiceRef.id, memberId: row.memberId, memberNameSnapshot: row.name,
        eventId: event.id, eventIds: [event.id], eventAmounts: [quote.fee], type: "MEMBER_EXTRA",
        grossAmount: row.grossAmount, creditApplied: row.creditApplied, amount: row.amount,
        periodLabel: quote.periodLabel, dueAt: quote.startsAt, status: row.amount === 0 ? "CONFIRMED" : "PENDING",
        reportedAt: null, confirmedAt: row.amount === 0 ? now : null,
        adjustments: [{ kind: "EXTRA", reason, eventDate: taipeiDate(quote.startsAt), amount: quote.fee, actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() }],
        createdAt: now, updatedAt: now,
      });
      transaction.update(db.collection("members").doc(row.memberId), { ...(row.creditApplied > 0 ? { creditBalance: FieldValue.increment(-row.creditApplied) } : {}), updatedAt: now });
      if (row.creditApplied > 0) {
        recordBalanceMovement(transaction, db, { memberId: row.memberId, amount: -row.creditApplied, reason: "社員加場費抵扣", sourceKey: `invoice:${invoiceRef.id}:apply`, invoiceId: invoiceRef.id, eventId: event.id, actorId: actor.id, actorName: actor.name, createdAt: now });
      }
      transaction.create(db.collection("notifications").doc(), notificationData({ title: "加場費已開單", message: `${quote.periodLabel}應付 NT$${row.amount}；原季度帳單不變`, type: "PAYMENT", tab: "費用管理", recipientId: row.memberId }));
    }
    const result = { invoiceCount: quote.rows.length, totalAmount: quote.totalAmount };
    transaction.update(event.ref, { memberBilling: "EXTRA", memberFeeSnapshot: quote.fee, billingReason: reason,
      memberExtraBilling: { ...result, previewKey: quote.previewKey, reason, actorId: actor.id, issuedAt: now }, updatedAt: now });
    return result;
  });
}

function periodEvents(period: DocumentData, events: (DocumentSnapshot | undefined)[]) {
  const seen = new Set<string>();
  return events.flatMap((event, index) => {
    const snapshot = period.eventSnapshots?.[index];
    const data = event?.data();
    const startsAt = dateValue(data?.startsAt ?? snapshot?.startsAt);
    if (!event || !data || !startsAt || !Number.isFinite(startsAt.getTime()) || seen.has(event.id)) return [];
    seen.add(event.id);
    return [{ id: event.id, data, startsAt, amount: Number(period.eventAmounts?.[index] ?? data.memberFeeSnapshot ?? 150), snapshot: snapshot ?? null }];
  });
}

function quarterlyQuote(period: DocumentData, members: DocumentSnapshot[], events: DocumentSnapshot[], invoices: DocumentSnapshot[], dueAt: Date, prior = new Map<string, number>()) {
  const entries = periodEvents(period, events).filter((entry) => period.status !== "PLANNED" || eventAllowsNewBilling(entry.data));
  if (period.status === "PLANNED" && period.startDate && period.endDate) {
    const moved = entries.filter((entry) => {
      const day = taipeiDate(entry.startsAt);
      return entry.data.status !== "CANCELLED" && (day < period.startDate || day > period.endDate);
    });
    if (moved.length) throw new Error("以下場次已移出本期，請先調整季費草稿：" + moved.map((entry) =>
      `${taipeiDate(entry.startsAt)} ${String(entry.data.courts ?? "")}`).join("、"));
  }
  const invoicesByMember = new Map<string, DocumentData[]>();
  for (const invoice of invoices) {
    const data = invoice.data()!;
    const memberId = String(data.memberId ?? "");
    if (!invoicesByMember.has(memberId)) invoicesByMember.set(memberId, []);
    invoicesByMember.get(memberId)!.push(data);
  }
  const rows = members.flatMap((member) => {
    const data = member.data()!;
    const eligible = entries.filter((entry) => memberAt(data, entry.startsAt) && !memberChargesForEvent(invoicesByMember.get(member.id) ?? [], entry.id));
    if (!eligible.length) return [];
    const effective = eligible.filter((entry) => entry.data.status !== "CANCELLED");
    const grossAmount = effective.reduce((sum, entry) => sum + entry.amount, 0);
    const creditApplied = Math.min(Math.max(0, Number(data.creditBalance ?? 0) - (prior.get(member.id) ?? 0)), grossAmount);
    return [{ memberId: member.id, name: String(data.displayName ?? ""), eventCount: effective.length, eventIds: effective.map((entry) => entry.id), grossAmount, creditApplied, amount: grossAmount - creditApplied }];
  }).sort((a, b) => a.memberId.localeCompare(b.memberId));
  const schedule = entries.map((entry) => [entry.id, entry.startsAt.toISOString(), iso(entry.data.endsAt), entry.data.courts ?? "", entry.data.status ?? ""]);
  const previewKey = createHash("sha256").update(JSON.stringify([period.id, period.startDate, period.endDate, dueAt.toISOString(), schedule, rows])).digest("hex");
  return { periodLabel: String(period.label ?? "季度社員費"), rows, totalAmount: rows.reduce((sum, row) => sum + row.amount, 0), previewKey };
}

async function previewQuarterlyInvoices(input: Record<string, string>, actor: Viewer) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.planId ?? "")) throw new Error("請選擇已確認的季度");
  const db = getAdminFirestore();
  const dueAt = billingBoundary(input.dueDate, true);
  if (dueAt < new Date()) throw new Error("繳費期限不能是過去日期");
  return db.runTransaction(async (transaction) => {
    const [periodDocument, manager, members, invoices] = await Promise.all([
      transaction.get(db.collection("billingPeriods").doc("quarter-" + input.planId)),
      transaction.get(db.collection("members").doc(actor.id)),
      transaction.get(db.collection("members")),
      transaction.get(db.collection("invoices")),
    ]);
    if (manager.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    const period = periodDocument.data();
    if (!period || !["PLANNED", "GENERATING"].includes(String(period.status))) throw new Error("沒有可預覽的未開單季度");
    const refs = (period.eventIds as string[]).map((id) => db.collection("events").doc(id));
    const events = refs.length ? await transaction.getAll(...refs) : [];
    return quarterlyQuote(period, members.docs, events, invoices.docs, dueAt, previewCredit(input.priorCredit));
  });
}

async function createQuarterlyInvoices(input: Record<string, string>, actor: Viewer) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.planId ?? "")) throw new Error("請選擇已確認的季度");
  const db = getAdminFirestore();
  const periodRef = db.collection("billingPeriods").doc("quarter-" + input.planId);
  const dueAt = billingBoundary(input.dueDate, true);
  const now = new Date();
  if (dueAt < now) throw new Error("繳費期限不能是過去日期");
  await db.runTransaction(async (transaction) => {
    const [period, manager] = await transaction.getAll(periodRef, db.collection("members").doc(actor.id));
    if (manager.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    if (!period.exists || !["PLANNED", "GENERATING", "ACTIVE"].includes(String(period.data()?.status))) throw new Error("請先確認季度活動");
    if (period.data()?.status === "ACTIVE") throw new Error("這個季度的社員帳單已經建立");
    const basis = period.data()!;
    if (basis.origin === "BILLING_MANAGER" && !/^[a-f0-9]{64}$/.test(input.previewKey ?? "")) throw new Error("請先預覽並確認社員帳單");
    if (period.data()?.status === "GENERATING") return;
    const [members, invoices, events] = await Promise.all([
      transaction.get(db.collection("members")),
      transaction.get(db.collection("invoices")),
      transaction.getAll(...(basis.eventIds as string[]).map((id) => db.collection("events").doc(id))),
    ]);
    const quote = quarterlyQuote(basis, members.docs, events, invoices.docs, dueAt);
    if (input.previewKey && quote.previewKey !== input.previewKey) throw new Error("場次、名單、帳單或餘額已變更，請重新預覽");
    if (!quote.rows.length) throw new Error("目前沒有可開單社員");
    transaction.update(periodRef, { status: "GENERATING", recipientIds: quote.rows.map((row) => row.memberId), dueAt, generatedBy: actor.id, updatedAt: now });
  });
  const period = (await periodRef.get()).data()!;
  const recipients = period.recipientIds as string[];
  for (const memberId of recipients) {
    await db.runTransaction(async (transaction) => {
      const invoiceRef = db.collection("invoices").doc(periodRef.id + "-" + memberId);
      const memberRef = db.collection("members").doc(memberId);
      const [freshPeriod, memberSnapshot, existingInvoice] = await transaction.getAll(periodRef, memberRef, invoiceRef);
      if (existingInvoice.exists) return;
      if (!memberSnapshot.exists) throw new Error("季度開單社員資料不存在");
      const basis = freshPeriod.data()!;
      const member = memberSnapshot.data()!;
      const [events, otherInvoices] = await Promise.all([
        transaction.getAll(...(basis.eventIds as string[]).map((id) => db.collection("events").doc(id))),
        transaction.get(db.collection("invoices").where("memberId", "==", memberId)),
      ]);
      const selected = periodEvents(basis, events).filter((entry) => memberAt(member, entry.startsAt) && !memberChargesForEvent(otherInvoices.docs.map((doc) => doc.data()), entry.id));
      if (!selected.length) return;
      const eventIds = selected.map((entry) => entry.id);
      const eventAmounts = selected.map((entry) => entry.amount);
      const eventSnapshots = selected.map((entry) => entry.snapshot ?? { id: entry.id, startsAt: entry.startsAt, memberFeeSnapshot: entry.amount });
      const grossAmount = eventAmounts.reduce((sum, amount) => sum + amount, 0);
      const creditApplied = Math.min(Math.max(0, Number(member.creditBalance ?? 0)), grossAmount);
      const amount = grossAmount - creditApplied;
      const cancellations = selected.filter((entry) => entry.data.status === "CANCELLED");
      let effective = { grossAmount, creditApplied, amount };
      let restoredCredit = 0;
      const adjustments = cancellations.map(({ id, startsAt, amount: eventAmount }) => {
        const reduced = reduceUnpaidInvoice(effective, eventAmount);
        const record = { kind: "REDUCTION", eventId: id, eventDate: taipeiDate(startsAt), reason: "確認季度後、開單前活動取消", amount: -eventAmount, beforeAmount: effective.amount, afterAmount: reduced.adjustedAmount, restoredCredit: reduced.restoredCredit, actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() };
        restoredCredit += reduced.restoredCredit;
        effective = { grossAmount: reduced.adjustedGrossAmount, creditApplied: reduced.adjustedCreditApplied, amount: reduced.adjustedAmount };
        return record;
      });
      transaction.create(invoiceRef, { id: invoiceRef.id, memberId, memberNameSnapshot: String(member.displayName), eventId: null, eventIds, eventAmounts, eventSnapshots, baselineEventCount: eventIds.length, type: "QUARTERLY_MEMBER", grossAmount, creditApplied, amount, ...(adjustments.length ? { adjustedGrossAmount: effective.grossAmount, adjustedCreditApplied: effective.creditApplied, adjustedAmount: effective.amount } : {}), adjustments, unitAmount: eventAmounts.every((value) => value === eventAmounts[0]) ? eventAmounts[0] : null, periodId: periodRef.id, periodLabel: basis.label, dueAt: basis.dueAt, status: effective.amount === 0 ? "CONFIRMED" : "PENDING", reportedAt: null, confirmedAt: effective.amount === 0 ? now : null, createdAt: now, updatedAt: now });
      transaction.update(memberRef, { ...(creditApplied > restoredCredit ? { creditBalance: FieldValue.increment(-(creditApplied - restoredCredit)) } : {}), updatedAt: now });
      if (creditApplied - restoredCredit > 0) {
        recordBalanceMovement(transaction, db, { memberId, amount: -(creditApplied - restoredCredit), reason: "季度帳單抵扣", sourceKey: `invoice:${invoiceRef.id}:apply`, invoiceId: invoiceRef.id, actorId: actor.id, actorName: actor.name, createdAt: now });
      }
      transaction.create(db.collection("notifications").doc(), notificationData({ title: "新的社員帳單", message: String(basis.label) + "，季度基準 " + eventIds.length + " 場；應付 NT$" + effective.amount, type: "PAYMENT", tab: "費用管理", recipientId: memberId }));
    });
  }
  const invoiceSnapshot = await db.collection("invoices").where("periodId", "==", periodRef.id).get();
  const invoices = invoiceSnapshot.docs.filter((doc) => doc.data().type === "QUARTERLY_MEMBER");
  const totalAmount = invoices.reduce((sum, doc) => sum + effectiveInvoiceAmounts(doc.data()).amount, 0);
  await periodRef.update({ status: "ACTIVE", invoiceCount: invoices.length, totalAmount, completedAt: new Date(), updatedAt: new Date() });
  return { invoiceCount: invoices.length, eventCount: Number(period.eventCount), totalAmount, periodLabel: String(period.label) };
}

async function setFeeRates(input: Record<string, string>) {
  const memberAmount = Number(input.memberAmount);
  const guestAmount = Number(input.guestAmount);
  if (!Number.isInteger(memberAmount) || memberAmount < 1 || memberAmount > 10000 || !Number.isInteger(guestAmount) || guestAmount < 1 || guestAmount > 10000) {
    throw new Error("費率必須是 1 到 10,000 元的整數");
  }
  const effectiveDate = input.effectiveDate;
  const effectiveFrom = billingBoundary(effectiveDate);
  const db = getAdminFirestore();
  const now = new Date();
  const batch = db.batch();
  for (const [kind, amount] of [["MEMBER_VISIT", memberAmount], ["GUEST_VISIT", guestAmount]] as const) {
    const reference = db.collection("feeRates").doc(`${kind}-${effectiveDate}`);
    batch.set(reference, { id: reference.id, kind, amount, effectiveFrom, effectiveTo: null, createdAt: now, updatedAt: now }, { merge: true });
  }
  await batch.commit();
  return { memberAmount, guestAmount, effectiveDate };
}


async function reportPayment(invoiceId: string, actor: Viewer) {
  if (!invoiceId) throw new Error("缺少帳單識別碼");
  const db = getAdminFirestore();
  const administrators = await db.collection("members").where("role", "==", "ADMIN").get();
  const invoiceRef = db.collection("invoices").doc(invoiceId);
  await db.runTransaction(async (transaction) => {
    const invoice = await transaction.get(invoiceRef);
    if (!invoice.exists) throw new Error("找不到帳單");
    const data = invoice.data()!;
    if (actor.role !== "ADMIN" && data.memberId !== actor.id) throw new Error("你不能更新其他人的帳單");
    if (data.status === "REPORTED") return;
    if (data.status !== "PENDING") throw new Error("這筆帳單目前無法回報轉帳");
    const now = new Date();
    transaction.update(invoiceRef, { status: "REPORTED", reportedAt: now, updatedAt: now });
    for (const admin of administrators.docs) transaction.create(db.collection("notifications").doc(), notificationData({ title: "待確認轉帳", message: String(data.memberNameSnapshot) + " 回報已轉帳 NT$" + effectiveInvoiceAmounts(data).amount, type: "PAYMENT", tab: "費用管理", recipientId: admin.id }));
  });
}

async function pendingInvoiceCredits(transaction: Transaction, db: Firestore, invoiceId: string) {
  const credits = await transaction.get(db.collection("invoices").where("relatedInvoiceId", "==", invoiceId));
  return credits.docs.filter((doc) => doc.data().status === "AWAITING_PAYMENT_CONFIRMATION");
}


function applyInvoiceConfirmation(transaction: Transaction, db: Firestore, invoice: DocumentSnapshot, pending: FirebaseFirestore.QueryDocumentSnapshot[], now: Date, actor: Viewer, receipt?: InvoiceReceipt) {
  const data = invoice.data()!;
  const memberId = String(data.memberId);
  const releases = pending.map((credit) => {
    const linked = credit.data();
    const total = creditValue(linked);
    const wallet = linked.eventCancellationRefund ? Number(linked.refundWalletAmount) : total;
    const cash = linked.eventCancellationRefund ? Number(linked.refundCashAmount) : 0;
    if (![wallet, cash].every((amount) => Number.isSafeInteger(amount) && amount >= 0) || wallet + cash !== total) throw new Error("待處理的退款金額不正確，請先核對");
    return { credit, linked, wallet, cash };
  });
  const wallet = releases.reduce((sum, entry) => sum + entry.wallet, 0);
  const cash = releases.reduce((sum, entry) => sum + entry.cash, 0);
  transaction.update(invoice.ref, {
    status: "CONFIRMED", confirmedAt: now, confirmedBy: actor.id, updatedAt: now,
    ...(receipt ? { receipt } : {}),
    ...(pending.length ? { adjustments: FieldValue.arrayUnion({ kind: "CREDIT_RELEASED", reason: "收款確認，活動取消退款進入後續處理", amount: -(wallet + cash), walletRefund: wallet, pendingOfflineRefund: cash, actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() }) } : {}),
  });
  for (const { credit, linked, wallet: walletPart, cash: cashPart } of releases) {
    transaction.update(credit.ref, {
      status: cashPart > 0 ? "AWAITING_OFFLINE_REFUND" : "CONFIRMED", confirmedAt: cashPart > 0 ? null : now, updatedAt: now,
      ...(linked.eventCancellationRefund ? { originalReceiptMethod: receipt?.method ?? linked.originalReceiptMethod ?? null } : {}),
    });
    if (walletPart > 0) recordBalanceMovement(transaction, db, { memberId, amount: walletPart, reason: "收款確認釋放活動退款", sourceKey: "invoice:" + credit.id + ":credit", invoiceId: credit.id, relatedInvoiceId: invoice.id, eventId: linked.eventId ? String(linked.eventId) : null, actorId: actor.id, actorName: actor.name, createdAt: now });
  }
  if (wallet > 0) transaction.update(db.collection("members").doc(memberId), { creditBalance: FieldValue.increment(wallet), updatedAt: now });
  const receiptMessage = receipt
    ? receipt.receivedDate + " 已登記" + (receipt.method === "CASH" ? "現金" : "轉帳") + "收款 NT$" + receipt.amount
    : "NT$" + effectiveInvoiceAmounts(data).amount + " 已確認收款";
  transaction.create(db.collection("notifications").doc(), notificationData({
    title: "款項已確認",
    message: receiptMessage + (wallet > 0 ? "；已退回帳戶餘額 NT$" + wallet : "") + (cash > 0 ? "；站外待退款 NT$" + cash : ""),
    type: "PAYMENT", tab: "費用管理", recipientId: memberId,
  }));
}

async function confirmPayment(input: Record<string, string>, actor: Viewer) {
  const { invoiceId, expectedStatus, expectedAmount } = input;
  if (!invoiceId || invoiceId.includes("/") || invoiceId.length > 600) throw new Error("缺少有效的帳單識別碼");
  const db = getAdminFirestore();
  const invoiceRef = db.collection("invoices").doc(invoiceId);
  await db.runTransaction(async (transaction) => {
    const [invoice, manager] = await transaction.getAll(invoiceRef, db.collection("members").doc(actor.id));
    if (manager.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    if (!invoice.exists) throw new Error("找不到帳單");
    const data = invoice.data()!;
    if (data.status === "CONFIRMED") return;
    if (!["PENDING", "REPORTED"].includes(data.status)) throw new Error("這筆帳單目前無法確認收款");
    if ((expectedStatus !== undefined && expectedStatus !== data.status) || (expectedAmount !== undefined && (!/^\d+$/.test(expectedAmount) || Number(expectedAmount) !== effectiveInvoiceAmounts(data).amount))) throw new Error("帳單狀態或金額已變更，請重新整理");
    const pending = await pendingInvoiceCredits(transaction, db, invoiceId);
    applyInvoiceConfirmation(transaction, db, invoice, pending, new Date(), actor);
  });
}

async function recordInvoiceReceipts(input: Record<string, string>, actor: Viewer) {
  const method = input.method;
  if (method !== "CASH" && method !== "BANK") throw new Error("請選擇現金或轉帳收款");
  const now = new Date();
  const receivedDate = input.receivedDate;
  if (typeof receivedDate !== "string" || !validCalendarDate(receivedDate) || receivedDate > taipeiDate(now)) throw new Error("請填寫有效的實際收款日期，不能晚於今天");
  if (input.note !== undefined && typeof input.note !== "string") throw new Error("收款備註格式不正確");
  const note = input.note?.trim() || null;
  if (note && note.length > 200) throw new Error("收款備註最多 200 字");
  let raw: unknown;
  try { raw = JSON.parse(input.invoices ?? ""); } catch { throw new Error("登記收款的帳單格式不正確"); }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) throw new Error("每次請選擇 1 至 20 筆帳單");
  const entries = new Map<string, number>();
  for (const item of raw) {
    if (!item || typeof item.id !== "string" || !item.id || item.id.length > 200 || item.id.includes("/") || entries.has(item.id)
      || !Number.isSafeInteger(item.amount) || item.amount <= 0) throw new Error("請選擇不重複的帳單並填寫正確的收款金額");
    entries.set(item.id, item.amount);
  }
  const db = getAdminFirestore();
  return db.runTransaction(async (transaction) => {
    const managerRef = db.collection("members").doc(actor.id);
    const invoiceRefs = [...entries.keys()].map((id) => db.collection("invoices").doc(id));
    const [manager, ...invoices] = await transaction.getAll(managerRef, ...invoiceRefs);
    const managerData = manager.data();
    if (managerData?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    const recordedByName = String(managerData.displayName ?? actor.name);
    let alreadyRecorded = 0;
    let totalAmount = 0;
    const toRecord: { invoice: DocumentSnapshot; receipt: InvoiceReceipt }[] = [];
    for (const invoice of invoices) {
      const data = invoice.data();
      const amount = entries.get(invoice.id)!;
      if (!data?.memberId || !["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "SINGLE_EVENT", "MEMBER_EXTRA", "MEMBER_SINGLE"].includes(String(data.type))) throw new Error("找不到可登記的收費帳單，請重新整理");
      const existing = data.receipt as InvoiceReceipt | undefined;
      if (existing && existing.amount === amount && existing.method === method && existing.receivedDate === receivedDate && existing.note === note) {
        alreadyRecorded++;
        continue;
      }
      if (existing || !["PENDING", "REPORTED"].includes(data.status) || effectiveInvoiceAmounts(data).amount !== amount) {
        throw new Error("帳單狀態、未繳金額或收款紀錄已變更，請重新整理");
      }
      totalAmount += amount;
      if (!Number.isSafeInteger(totalAmount)) throw new Error("合計收款金額不正確");
      toRecord.push({ invoice, receipt: { method, receivedDate, amount, note, recordedBy: actor.id, recordedByName, recordedAt: now } });
    }
    const pendingCredits = await Promise.all(toRecord.map(({ invoice }) => pendingInvoiceCredits(transaction, db, invoice.id)));
    // At most 20 invoices, plus an explicit linked write budget in case old data
    // has large numbers of pending credits that would exceed Firestore limits.
    if (toRecord.length * 3 + pendingCredits.reduce((count, credits) => count + credits.length * 2, 0) > 400) {
      throw new Error("一批涉及的退款紀錄過多，請拆成較小批次登記");
    }
    const managerActor = { ...actor, name: recordedByName };
    toRecord.forEach(({ invoice, receipt }, index) => applyInvoiceConfirmation(transaction, db, invoice, pendingCredits[index], now, managerActor, receipt));
    if (toRecord.length) transaction.create(db.collection("auditLogs").doc(), {
      action: "RECORD_INVOICE_RECEIPTS", actorId: actor.id, actorNameSnapshot: recordedByName,
      method, receivedDate, note, totalAmount, invoices: toRecord.map(({ invoice, receipt }) => ({ id: invoice.id, amount: receipt.amount })), createdAt: now,
    });
    return { recorded: toRecord.length, alreadyRecorded, totalAmount };
  });
}


async function recordEventRefunds(input: Record<string, string>, actor: Viewer) {
  const { eventId, method, refundedDate } = input;
  if (!eventId || eventId.length > 200 || eventId.includes("/")) throw new Error("請選擇已取消的活動");
  if (method !== "CASH" && method !== "BANK") throw new Error("請選擇實際退款方式");
  if (input.offlineRefunded !== "true") throw new Error("請先確認站外退款已完成");
  const now = new Date();
  if (typeof refundedDate !== "string" || !validCalendarDate(refundedDate) || refundedDate > taipeiDate(now)) throw new Error("實際退款日期不能晚於今天");
  if (input.note !== undefined && typeof input.note !== "string") throw new Error("退款備註格式不正確");
  const note = input.note?.trim() || null;
  if (note && note.length > 200) throw new Error("退款備註最多 200 字");
  let raw: unknown;
  try { raw = JSON.parse(input.refunds ?? ""); } catch { throw new Error("退款清單格式不正確"); }
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw new Error("每次請選擇 1 至 20 筆退款");
  const entries = new Map<string, number>();
  for (const item of raw) {
    if (!item || typeof item.id !== "string" || !item.id || item.id.length > 600 || item.id.includes("/") || entries.has(item.id) ||
      !Number.isSafeInteger(item.amount) || item.amount <= 0) throw new Error("退款金額或清單格式不正確");
    entries.set(item.id, item.amount);
  }
  const db = getAdminFirestore();
  return db.runTransaction(async (transaction) => {
    const refs = [...entries.keys()].map((id) => db.collection("invoices").doc(id));
    const [manager, event, ...credits] = await transaction.getAll(db.collection("members").doc(actor.id), db.collection("events").doc(eventId), ...refs);
    const managerData = manager.data();
    if (managerData?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    if (!event.exists) throw new Error("只能登記有效活動的退款");
    const recordedByName = String(managerData.displayName ?? actor.name);
    let alreadyRecorded = 0;
    let totalAmount = 0;
    const toRecord: { credit: DocumentSnapshot; amount: number; memberId: string }[] = [];
    for (const credit of credits) {
      const data = credit.data();
      const amount = entries.get(credit.id)!;
      if (!data?.eventCancellationRefund || data.type !== "CREDIT" || data.eventId !== eventId || !data.memberId || Number(data.refundCashAmount) !== amount) throw new Error("退款活動或待退款金額已變更，請重新整理");
      if (event.data()?.status !== "CANCELLED" && data.bookingCancellationRefund !== true) throw new Error("只能登記取消活動或取消報名產生的退款");
      const receipt = data.offlineRefundReceipt;
      if (data.status === "CONFIRMED" && receipt?.amount === amount && receipt.method === method && receipt.refundedDate === refundedDate && receipt.note === note) {
        alreadyRecorded++;
        continue;
      }
      if (data.status !== "AWAITING_OFFLINE_REFUND" || receipt) throw new Error("退款已處理或尚未確認收款，請重新整理");
      totalAmount += amount;
      toRecord.push({ credit, amount, memberId: String(data.memberId) });
    }
    for (const { credit, amount, memberId } of toRecord) {
      transaction.update(credit.ref, {
        status: "CONFIRMED", confirmedAt: now, updatedAt: now,
        offlineRefundReceipt: { method, refundedDate, amount, note, recordedBy: actor.id, recordedByName, recordedAt: now },
      });
      transaction.create(db.collection("notifications").doc(), notificationData({
        title: "活動退款已登記", message: refundedDate + " 已登記" + (method === "CASH" ? "現金" : "轉帳") + "退款 NT$" + amount + "。",
        type: "PAYMENT", tab: "費用管理", recipientId: memberId,
      }));
    }
    if (toRecord.length) transaction.create(db.collection("auditLogs").doc(), {
      action: "RECORD_EVENT_REFUNDS", eventId, method, refundedDate, note, totalAmount, actorId: actor.id,
      actorNameSnapshot: recordedByName, refunds: toRecord.map(({ credit, amount }) => ({ id: credit.id, amount })), createdAt: now,
    });
    return { recorded: toRecord.length, alreadyRecorded, totalAmount };
  });
}

async function remindPayment(invoiceId: string, actor: Viewer) {
  if (!invoiceId) throw new Error("缺少帳單識別碼");
  const db = getAdminFirestore();
  const invoiceRef = db.collection("invoices").doc(invoiceId);
  const invoice = await invoiceRef.get();
  if (!invoice.exists) throw new Error("找不到帳單");
  const data = invoice.data()!;
  if (data.status !== "PENDING") throw new Error("只有未繳帳單可以發送催款通知");
  const lastRemindedAt = dateValue(data.lastRemindedAt);
  if (lastRemindedAt && Date.now() - lastRemindedAt.getTime() < 60_000) throw new Error("催款通知剛剛已發送，請稍候再試");
  const memberId = String(data.memberId ?? "");
  if (!memberId) throw new Error("帳單缺少使用者資料");
  const amount = effectiveInvoiceAmounts(data).amount;
  const periodLabel = String(data.periodLabel ?? "羽球活動費");
  const now = new Date();
  const notificationRef = db.collection("notifications").doc();
  const batch = db.batch();
  batch.set(notificationRef, notificationData({
    title: "活動費用尚未繳納",
    message: `${periodLabel} 尚有 NT$${amount.toLocaleString("zh-TW")} 未繳。已轉帳可至費用管理回報，也可由幹部直接登記收款。`,
    type: "PAYMENT_REMINDER",
    tab: "費用管理",
    recipientId: memberId,
  }));
  batch.update(invoiceRef, {
    lastRemindedAt: now,
    lastRemindedBy: actor.id,
    reminderCount: FieldValue.increment(1),
    updatedAt: now,
  });
  await batch.commit();
}

async function markNotificationsRead(input: Record<string, string>, actor: Viewer) {
  const notificationIds = [...new Set((input.notificationIds ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
  if (notificationIds.length === 0) return;
  if (notificationIds.length > 50) throw new Error("一次最多處理 50 筆通知");
  const db = getAdminFirestore();
  const references = notificationIds.map((id) => db.collection("notifications").doc(id));
  const notifications = await db.getAll(...references);
  const batch = db.batch();
  const now = new Date();
  for (const notification of notifications) {
    if (!notification.exists) continue;
    const data = notification.data()!;
    if (data.audience !== "ALL" && String(data.recipientId ?? "") !== actor.id) throw new Error("你不能更新其他人的通知");
    const readRef = db.collection("notificationReads").doc(`${actor.id}_${notification.id}`);
    batch.set(readRef, { memberId: actor.id, notificationId: notification.id, readAt: now }, { merge: true });
  }
  await batch.commit();
}

async function requestMembershipChange(kind: string, actor: Viewer) {
  if (kind !== "JOIN" && kind !== "EXIT") throw new Error("申請類型不正確");
  const db = getAdminFirestore();
  const memberRef = db.collection("members").doc(actor.id);
  const lockRef = db.collection("membershipRequestLocks").doc(actor.id);
  const requestRef = db.collection("membershipRequests").doc(randomUUID());
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const [[memberSnapshot, lockSnapshot], adminSnapshot] = await Promise.all([
      transaction.getAll(memberRef, lockRef),
      transaction.get(db.collection("members").where("role", "==", "ADMIN")),
    ]);
    if (!memberSnapshot.exists) throw new Error("找不到使用者");
    if (lockSnapshot.exists) throw new Error("你已有一筆待審核的社員申請");
    const member = memberSnapshot.data()!;
    if (kind === "EXIT" && isClubPresident(member)) throw new Error(PRESIDENT_EXIT_MESSAGE);
    const currentlyMember = memberAt(member, now);
    if (kind === "JOIN" && currentlyMember) throw new Error("你目前已是社員或會籍仍在有效期間");
    if (kind === "EXIT" && !currentlyMember) throw new Error("你目前不是社員");

    transaction.create(requestRef, {
      id: requestRef.id,
      memberId: actor.id,
      memberNameSnapshot: String(member.displayName ?? actor.name),
      kind,
      status: "PENDING",
      requestedAt: now,
      reviewedAt: null,
      reviewedBy: null,
      createdAt: now,
      updatedAt: now,
    });
    transaction.create(lockRef, { memberId: actor.id, requestId: requestRef.id, kind, createdAt: now });
    for (const administrator of adminSnapshot.docs) {
      const notificationRef = db.collection("notifications").doc();
      transaction.create(notificationRef, notificationData({ title: "新的社員申請", message: `${String(member.displayName ?? actor.name)} 申請${kind === "JOIN" ? "加入" : "退出"}社員`, type: "MEMBERSHIP", tab: "社員名單", recipientId: administrator.id }));
    }
  });
}

function currentBillingPeriod(periods: FirebaseFirestore.QueryDocumentSnapshot[], now: Date) {
  const date = taipeiDate(now);
  return periods
    .filter((document) => {
      const period = document.data();
      return ["PLANNED", "GENERATING", "ACTIVE"].includes(String(period.status)) && String(period.startDate ?? "") <= date && String(period.endDate ?? "") >= date;
    })
    .sort((a, b) => String(a.data().endDate).localeCompare(String(b.data().endDate)))[0] ?? null;
}

async function reviewMembershipRequest(requestId: string, decision: string, actor: Viewer) {
  if (!requestId) throw new Error("缺少社員申請識別碼");
  if (decision !== "APPROVE" && decision !== "REJECT") throw new Error("審核結果不正確");
  const db = getAdminFirestore();
  const requestRef = db.collection("membershipRequests").doc(requestId);
  const requestSnapshot = await requestRef.get();
  if (!requestSnapshot.exists) throw new Error("找不到社員申請");
  const requestData = requestSnapshot.data()!;
  if (requestData.status !== "PENDING") return;
  const memberId = String(requestData.memberId ?? "");
  const kind = String(requestData.kind ?? "");
  if (!memberId || (kind !== "JOIN" && kind !== "EXIT")) throw new Error("社員申請資料不完整");

  const now = new Date();
  const memberRef = db.collection("members").doc(memberId);
  const lockRef = db.collection("membershipRequestLocks").doc(memberId);
  const notificationRef = db.collection("notifications").doc();
  const result = await db.runTransaction(async (transaction) => {
    const [snapshots, reviewer] = await Promise.all([transaction.getAll(requestRef, memberRef, lockRef), transaction.get(db.collection("members").doc(actor.id))]);
    if (reviewer.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    const freshRequest = snapshots[0];
    const freshMember = snapshots[1];
    const lock = snapshots[2];
    if (!freshRequest.exists || freshRequest.data()?.status !== "PENDING") return { amount: 0, joined: false };
    if (!freshMember.exists) throw new Error("找不到申請人");
    if (decision === "REJECT") {
      transaction.update(requestRef, { status: "REJECTED", reviewedAt: now, reviewedBy: actor.id, updatedAt: now });
      if (lock.exists && lock.data()?.requestId === requestId) transaction.delete(lockRef);
      transaction.create(notificationRef, notificationData({ title: "社員申請結果", message: `你的${kind === "JOIN" ? "加入" : "退出"}社員申請未獲核准`, type: "MEMBERSHIP", tab: "個人資訊", recipientId: memberId }));
      return { amount: 0, joined: false };
    }

    const member = freshMember.data()!;
    const [periods, allEvents, memberInvoices] = await Promise.all([
      transaction.get(db.collection("billingPeriods")),
      transaction.get(db.collection("events")),
      transaction.get(db.collection("invoices").where("memberId", "==", memberId)),
    ]);
    const periodDocument = currentBillingPeriod(periods.docs, now);
    const period = periodDocument?.data();
    const eventsById = new Map(allEvents.docs.map((event) => [event.id, event]));
    if (kind === "JOIN") {
      if (memberAt(member, now)) throw new Error("申請人已是社員，請退回這筆重複申請");
      const pendingGuestBills = memberInvoices.docs.filter((document) => {
        const invoice = document.data();
        const event = eventsById.get(String(invoice.eventId))?.data();
        const starts = dateValue(event?.startsAt);
        return invoice.type === "SINGLE_EVENT" && invoice.status === "PENDING" && event?.status === "SCHEDULED" && starts && starts > now;
      });
      const waitingForQuarter = new Set(periods.docs.flatMap((document) => {
        const draft = document.data();
        return draft.status === "PLANNED" && Array.isArray(draft.eventIds) ? draft.eventIds.map(String) : [];
      }));
      const memberName = String(member.displayName ?? freshRequest.data()?.memberNameSnapshot ?? "未知使用者");
      const pendingIds = new Set(pendingGuestBills.map((document) => document.id));
      const existing = memberInvoices.docs.filter((document) => !pendingIds.has(document.id)).map((document) => document.data());
      let balanceDelta = 0;
      let amount = 0;
      let singleInvoiceCount = 0;
      for (const document of pendingGuestBills) {
        const restored = effectiveInvoiceAmounts(document.data()).creditApplied;
        balanceDelta += restored;
        transaction.update(document.ref, { status: "VOID", voidReason: "活動開始前已轉為社員，取消原零打帳單", cancellationReason: "MEMBERSHIP_JOIN", voidedAt: now, updatedAt: now });
        recordBalanceMovement(transaction, db, { memberId, amount: restored, reason: "入社後退回原零打抵扣", sourceKey: `invoice:${document.id}:membership-join`, invoiceId: document.id, eventId: String(document.data().eventId), actorId: actor.id, actorName: actor.name, createdAt: now });
      }
      const graceDueAt = new Date(now);
      graceDueAt.setUTCDate(graceDueAt.getUTCDate() + 14);
      const billedPeriods = periods.docs.filter((document) => ["GENERATING", "ACTIVE"].includes(String(document.data().status)) && String(document.data().endDate) >= taipeiDate(now))
        .sort((a, b) => String(a.data().startDate).localeCompare(String(b.data().startDate)));
      for (const document of billedPeriods) {
        const basis = document.data();
        const refs = (Array.isArray(basis.eventIds) ? basis.eventIds : []).map((id: string) => eventsById.get(id));
        const eligible = periodEvents(basis, refs).filter((entry) => entry.data.status === "SCHEDULED" && eventAllowsNewBilling(entry.data) && entry.startsAt > now && !memberChargesForEvent(existing, entry.id));
        if (!eligible.length) continue;
        const gross = eligible.reduce((sum, entry) => sum + entry.amount, 0);
        const creditApplied = Math.min(Math.max(0, Number(member.creditBalance ?? 0) + balanceDelta), gross);
        const due = dateValue(basis.dueAt);
        const invoiceRef = db.collection("invoices").doc(`membership-${document.id}-${requestId}`);
        const row = {
          id: invoiceRef.id, memberId, memberNameSnapshot: memberName,
          eventId: null, eventIds: eligible.map((entry) => entry.id), eventAmounts: eligible.map((entry) => entry.amount),
          eventSnapshots: eligible.map((entry) => entry.snapshot ?? { id: entry.id, startsAt: entry.startsAt, memberFeeSnapshot: entry.amount }),
          type: "MEMBERSHIP_PRORATED", grossAmount: gross, creditApplied, amount: gross - creditApplied,
          periodId: document.id, periodLabel: `${String(basis.label ?? "社員費")}（中途加入）`,
          dueAt: due && due > graceDueAt ? due : billingBoundary(taipeiDate(graceDueAt), true),
          status: gross === creditApplied ? "CONFIRMED" : "PENDING", reportedAt: null, confirmedAt: gross === creditApplied ? now : null,
          note: "依核准後符合會籍的剩餘活動場次計費", createdAt: now, updatedAt: now,
        };
        transaction.create(invoiceRef, row);
        recordBalanceMovement(transaction, db, { memberId, amount: -creditApplied, reason: "加入社員帳單抵扣", sourceKey: `invoice:${invoiceRef.id}:apply`, invoiceId: invoiceRef.id, actorId: actor.id, actorName: actor.name, createdAt: now });
        existing.push(row);
        balanceDelta -= creditApplied;
        amount += row.amount;
      }
      // Only replace an actual unpaid guest bill. A new member does not create
      // single-session charges for every future booking by joining the club.
      for (const document of [...pendingGuestBills].sort((a, b) =>
        +dateValue(eventsById.get(String(a.data().eventId))?.data()?.startsAt)! -
        +dateValue(eventsById.get(String(b.data().eventId))?.data()?.startsAt)! || a.id.localeCompare(b.id))) {
        const eventId = String(document.data().eventId);
        const event = eventsById.get(eventId)!.data();
        if (waitingForQuarter.has(eventId) || memberChargesForEvent(existing, eventId)
          || !eventAllowsNewBilling(event) || event.memberBilling === "NO_CHARGE") continue;
        const gross = Number(event.memberFeeSnapshot ?? event.memberListRateSnapshot ?? 150);
        if (!Number.isSafeInteger(gross) || gross < 0 || gross > 10_000) throw new Error("活動社員費率不正確，請先核對後再核准入社");
        if (gross === 0) continue;
        const creditApplied = Math.min(Math.max(0, Number(member.creditBalance ?? 0) + balanceDelta), gross);
        const dueAt = dateValue(document.data().dueAt);
        const invoiceRef = db.collection("invoices").doc(`member-join-${requestId}-${eventId}`);
        const row = {
          id: invoiceRef.id, memberId, memberNameSnapshot: memberName,
          eventId, eventIds: [eventId], eventAmounts: [gross], type: "MEMBER_SINGLE",
          eventSnapshots: [{ id: eventId, startsAt: dateValue(event.startsAt), endsAt: dateValue(event.endsAt), courts: String(event.courts ?? ""), memberFeeSnapshot: gross }],
          grossAmount: gross, creditApplied, amount: gross - creditApplied,
          periodLabel: taipeiDate(event.startsAt),
          dueAt: dueAt && dueAt > graceDueAt ? dueAt : billingBoundary(taipeiDate(graceDueAt), true),
          status: gross === creditApplied ? "CONFIRMED" : "PENDING",
          reportedAt: null, confirmedAt: gross === creditApplied ? now : null,
          replacementOfId: document.id, note: "入社後按本場社員價開單", createdAt: now, updatedAt: now,
        };
        transaction.create(invoiceRef, row);
        transaction.update(document.ref, { replacedById: invoiceRef.id });
        recordBalanceMovement(transaction, db, { memberId, amount: -creditApplied, reason: "社員單場費抵扣", sourceKey: `invoice:${invoiceRef.id}:apply`, invoiceId: invoiceRef.id, eventId, actorId: actor.id, actorName: actor.name, createdAt: now });
        existing.push(row);
        balanceDelta -= creditApplied;
        amount += row.amount;
        singleInvoiceCount += 1;
      }
      transaction.update(memberRef, {
        membershipStatus: "MEMBER",
        memberSince: now,
        endingAt: null,
        creditBalance: FieldValue.increment(balanceDelta),
        updatedAt: now,
      });
      transaction.update(requestRef, { status: "APPROVED", reviewedAt: now, reviewedBy: actor.id, proratedAmount: amount, updatedAt: now });
      if (lock.exists && lock.data()?.requestId === requestId) transaction.delete(lockRef);
      transaction.create(notificationRef, notificationData({ title: "已加入社員", message: amount > 0 ? `申請已核准，新開帳單應付 NT$${amount}` : "申請已核准，社員身分已立即生效", type: "MEMBERSHIP", tab: amount > 0 ? "費用管理" : "個人資訊", recipientId: memberId }));
      return { amount, joined: true, replacedGuestBillCount: pendingGuestBills.length, singleInvoiceCount };
    }

    if (isClubPresident(member)) throw new Error(PRESIDENT_EXIT_MESSAGE);
    const endingAt = periodDocument ? billingBoundary(String(period?.endDate), true) : now;
    const afterEnd = allEvents.docs.filter((document) => {
      const data = document.data();
      const starts = dateValue(data.startsAt);
      return isBadmintonEvent(data) && data.status === "SCHEDULED" && starts && starts > endingAt;
    });
    const bookingRefs = afterEnd.map((document) => document.ref.collection("bookings").doc(memberId));
    const bookings = bookingRefs.length ? await transaction.getAll(...bookingRefs) : [];
    const promotions: string[] = [];
    for (const [index, booking] of bookings.entries()) {
      const data = booking.data();
      if (data?.kindSnapshot !== "MEMBER" || data.transferredFromMemberId || !["REGULAR", "STANDBY"].includes(String(data.status))) continue;
      const ref = afterEnd[index].ref;
      if (data.status === "REGULAR") promotions.push(ref.id);
      transaction.update(booking.ref, { status: "CANCELLED", cancelledAt: now, cancellationReason: "MEMBERSHIP_ENDED", updatedAt: now });
      transaction.update(ref, { [data.status === "REGULAR" ? "regularCount" : "standbyCount"]: FieldValue.increment(-1), updatedAt: now });
    }
    let restoredBalance = 0;
    const futureEvents = new Map(afterEnd.map((event) => [event.id, event.data()]));
    for (const document of memberInvoices.docs) {
      const invoice = document.data();
      if (!["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "MEMBER_EXTRA", "MEMBER_SINGLE"].includes(String(invoice.type))) continue;
      const ids: string[] = Array.isArray(invoice.eventIds) ? invoice.eventIds : invoice.eventId ? [invoice.eventId] : [];
      const records: DocumentData[] = [];
      let effective = effectiveInvoiceAmounts(invoice);
      for (const [index, id] of ids.entries()) {
        const event = futureEvents.get(id);
        if (!event || !memberChargesForEvent([invoice], id)) continue;
        const charge = Number(invoice.eventAmounts?.[index] ?? invoice.unitAmount ?? event.memberFeeSnapshot ?? 0);
        if (!Number.isSafeInteger(charge) || charge <= 0) continue;
        const audit = { eventId: id, eventDate: taipeiDate(event.startsAt), reason: "會籍已於活動前結束", actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() };
        if (invoice.status === "PENDING") {
          const reduced = reduceUnpaidInvoice(effective, charge);
          records.push({ ...audit, kind: "MEMBERSHIP_END_REDUCTION", amount: -charge, beforeAmount: effective.amount, afterAmount: reduced.adjustedAmount, restoredCredit: reduced.restoredCredit });
          effective = { grossAmount: reduced.adjustedGrossAmount, creditApplied: reduced.adjustedCreditApplied, amount: reduced.adjustedAmount };
          restoredBalance += reduced.restoredCredit;
          recordBalanceMovement(transaction, db, { memberId, amount: reduced.restoredCredit, reason: "會籍結束恢復帳單抵扣", sourceKey: `invoice:${document.id}:membership-end:${id}`, invoiceId: document.id, eventId: id, actorId: actor.id, actorName: actor.name, createdAt: now });
        } else {
          const confirmed = invoice.status === "CONFIRMED";
          const creditRef = db.collection("invoices").doc(`membership-end-${document.id}-${id}`);
          records.push({ ...audit, kind: "MEMBERSHIP_END_CREDIT", amount: -charge, creditInvoiceId: creditRef.id });
          transaction.create(creditRef, { id: creditRef.id, memberId, memberNameSnapshot: invoice.memberNameSnapshot ?? String(member.displayName), relatedInvoiceId: document.id, eventId: id, type: "CREDIT", grossAmount: -charge, creditApplied: 0, amount: -charge, status: confirmed ? "CONFIRMED" : "AWAITING_PAYMENT_CONFIRMATION", periodId: invoice.periodId ?? invoice.relatedPeriodId ?? null, periodLabel: "會籍結束退回餘額", confirmedAt: confirmed ? now : null, createdAt: now, updatedAt: now });
          if (confirmed) {
            restoredBalance += charge;
            recordBalanceMovement(transaction, db, { memberId, amount: charge, reason: "會籍結束退回未涵蓋的場次費", sourceKey: `invoice:${creditRef.id}:credit`, invoiceId: creditRef.id, relatedInvoiceId: document.id, eventId: id, actorId: actor.id, actorName: actor.name, createdAt: now });
          }
        }
      }
      if (records.length) transaction.update(document.ref, {
        ...(invoice.status === "PENDING" ? { adjustedGrossAmount: effective.grossAmount, adjustedCreditApplied: effective.creditApplied, adjustedAmount: effective.amount, ...(effective.amount === 0 ? { status: "CONFIRMED", confirmedAt: now } : {}) } : {}),
        adjustments: FieldValue.arrayUnion(...records), updatedAt: now,
      });
    }
    transaction.update(memberRef, {
      membershipStatus: periodDocument ? "EXITING" : "GUEST",
      endingAt: periodDocument ? endingAt : null,
      ...(restoredBalance ? { creditBalance: FieldValue.increment(restoredBalance) } : {}),
      updatedAt: now,
    });
    transaction.update(requestRef, { status: "APPROVED", reviewedAt: now, reviewedBy: actor.id, effectiveAt: endingAt, updatedAt: now });
    if (lock.exists && lock.data()?.requestId === requestId) transaction.delete(lockRef);
    transaction.create(notificationRef, notificationData({ title: "退出申請已核准", message: periodDocument ? `社員身分將維持至 ${String(period?.endDate)}` : "社員身分已結束", type: "MEMBERSHIP", tab: "個人資訊", recipientId: memberId }));
    return { amount: 0, endingAt: endingAt.toISOString(), joined: false, promotions };
  });
  if (result.joined) await ensureMemberFutureBookings(memberId);
  if (result.promotions) await Promise.allSettled(result.promotions.map(promoteStandby));
  return result;
}

function assertImmutableAccountName(input: Record<string, string>) {
  if (["accountName", "accountNameKey", "username", "userName"].some(field => Object.hasOwn(input, field))) throw new Error("帳號名稱建立後不可修改");
}

async function updateDisplayName(input: Record<string, string>, actor: Viewer) {
  assertImmutableAccountName(input);
  if (input.memberId && input.memberId !== actor.id) throw new Error("只能修改自己的顯示名稱");
  if (Object.keys(input).some(field => !["action", "displayName", "memberId"].includes(field))) throw new Error("此操作只能修改顯示名稱");
  const displayName = validatedDisplayName(input.displayName);
  const db = getAdminFirestore();
  const memberRef = db.collection("members").doc(actor.id);
  const auditRef = db.collection("auditLogs").doc(randomUUID());
  const now = new Date();
  await db.runTransaction(async transaction => {
    const memberSnapshot = await transaction.get(memberRef);
    if (!memberSnapshot.exists) throw new Error("找不到使用者");
    const member = memberSnapshot.data()!;
    const accountName = memberAccountName(member);
    validatedAccountName(accountName);
    const claim = await readMemberName(transaction, db, accountName);
    if (claim.member?.id !== actor.id) throw new Error("帳號名稱資料不一致，請聯絡幹部確認");
    if (member.accountNameKey !== undefined && member.accountNameKey !== claim.nameKey) throw new Error("帳號名稱索引不一致，請聯絡幹部確認");
    reserveMemberName(transaction, claim, actor.id, now);
    transaction.update(memberRef, {
      // Freeze the old name before editing a legacy display name, in one commit.
      accountName,
      accountNameKey: claim.nameKey,
      displayName,
      ...(!Object.hasOwn(member, "primaryAdmin") ? { primaryAdmin: isClubPresident(member) } : {}),
      updatedAt: now,
    });
    transaction.create(auditRef, {
      id: auditRef.id, action: "UPDATE_DISPLAY_NAME", actorId: actor.id,
      actorNameSnapshot: String(member.displayName ?? ""), targetMemberId: actor.id, accountName,
      before: { displayName: String(member.displayName ?? "") }, after: { displayName }, createdAt: now,
    });
  });
}


async function adjustMemberBalance(input: Record<string, string>, actor: Viewer) {
  const allowedFields = new Set(["action", "memberId", "balanceAdjustment", "adjustmentNote", "expectedBalance", "requestId"]);
  if (Object.keys(input).some((field) => !allowedFields.has(field) || typeof input[field] !== "string")) throw new Error("餘額調整資料不正確");
  if (input.action !== undefined && input.action !== "adjustMemberBalance") throw new Error("餘額調整操作不正確");
  const memberId = input.memberId;
  if (!memberId || memberId !== memberId.trim() || Buffer.byteLength(memberId, "utf8") > 1500 || /[\/\p{Cc}]/u.test(memberId) || [".", ".."].includes(memberId)) throw new Error("使用者識別碼不正確");
  if (!input.balanceAdjustment?.trim()) throw new Error("請填寫餘額調整金額");
  const balanceAdjustment = Number(input.balanceAdjustment);
  if (!Number.isSafeInteger(balanceAdjustment) || balanceAdjustment === 0 || Math.abs(balanceAdjustment) > 100000) throw new Error("餘額調整必須是介於 -100,000 到 100,000 的非零整數");
  if (!input.expectedBalance?.trim()) throw new Error("缺少目前餘額，請重新載入後再試");
  const expectedBalance = Number(input.expectedBalance);
  if (!Number.isSafeInteger(expectedBalance) || expectedBalance < 0) throw new Error("目前餘額不正確，請重新載入後再試");
  const adjustmentNote = input.adjustmentNote?.trim() ?? "";
  if (!adjustmentNote) throw new Error("調整帳戶餘額時必須填寫原因");
  if (adjustmentNote.length > 200) throw new Error("調整原因不能超過 200 個字元");
  const requestId = input.requestId;
  if (!requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error("餘額調整識別碼不正確，請重新載入後再試");

  const db = getAdminFirestore();
  const memberRef = db.collection("members").doc(memberId);
  const actorRef = db.collection("members").doc(actor.id);
  const adjustmentRef = db.collection("invoices").doc(`adjustment-${requestId.toLowerCase()}`);
  const auditRef = db.collection("auditLogs").doc();
  return db.runTransaction(async (transaction) => {
    const [memberSnapshot, actorSnapshot, existingAdjustment] = await transaction.getAll(memberRef, actorRef, adjustmentRef);
    if (actorSnapshot.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    if (!memberSnapshot.exists) throw new Error("找不到使用者");
    const member = memberSnapshot.data()!;
    const currentBalance = Number(member.creditBalance ?? 0);
    if (!Number.isSafeInteger(currentBalance) || currentBalance < 0) throw new Error("目前餘額資料不正確，請重新載入後再試");

    // The committed invoice is the receipt: an exact retry succeeds even after the balance changes.
    if (existingAdjustment.exists) {
      const receipt = existingAdjustment.data()!;
      if (receipt.type !== "ADJUSTMENT" || receipt.memberId !== memberId || receipt.confirmedBy !== actor.id || receipt.amount !== -balanceAdjustment || receipt.note !== adjustmentNote) throw new Error("餘額調整識別碼已使用，請重新載入後再試");
      return { memberId, creditBalance: currentBalance, adjustmentInvoiceId: adjustmentRef.id };
    }
    if (currentBalance !== expectedBalance) throw new Error("餘額已變更，請重新載入後再試");
    const nextBalance = currentBalance + balanceAdjustment;
    if (!Number.isSafeInteger(nextBalance) || nextBalance < 0) throw new Error("調整後的帳戶餘額不能小於零或超過安全整數範圍");
    const now = new Date();
    transaction.update(memberRef, { creditBalance: nextBalance, updatedAt: now });
    transaction.create(adjustmentRef, {
      id: adjustmentRef.id,
      memberId,
      memberNameSnapshot: String(member.displayName ?? "未知使用者"),
      eventId: null,
      type: "ADJUSTMENT",
      grossAmount: -balanceAdjustment,
      creditApplied: 0,
      amount: -balanceAdjustment,
      status: "CONFIRMED",
      periodLabel: "幹部手動餘額調整",
      confirmedAt: now,
      confirmedBy: actor.id,
      note: adjustmentNote,
      createdAt: now,
      updatedAt: now,
    });
    recordBalanceMovement(transaction, db, { memberId, amount: balanceAdjustment, reason: adjustmentNote, sourceKey: `invoice:${adjustmentRef.id}:adjustment`, invoiceId: adjustmentRef.id, actorId: actor.id, actorName: actor.name, createdAt: now });
    transaction.create(auditRef, {
      actorId: actor.id,
      actorNameSnapshot: actor.name,
      action: "UPDATE_MEMBER",
      targetMemberId: memberId,
      before: { creditBalance: currentBalance },
      after: { creditBalance: nextBalance },
      note: adjustmentNote,
      createdAt: now,
    });
    return { memberId, creditBalance: nextBalance, adjustmentInvoiceId: adjustmentRef.id };
  });
}

async function updateMember(input: Record<string, string>, actor: Viewer) {
  assertImmutableAccountName(input);
  const memberId = input.memberId;
  const role = input.role;
  const membershipStatus = input.membershipStatus;
  const department = input.department?.trim() || null;
  const balanceAdjustment = Number(input.balanceAdjustment || 0);
  const adjustmentNote = input.adjustmentNote?.trim() || "";
  if (!memberId) throw new Error("缺少使用者識別碼");
  if (role !== "ADMIN" && role !== "MEMBER") throw new Error("角色設定不正確");
  if (membershipStatus !== "MEMBER" && membershipStatus !== "GUEST" && membershipStatus !== "EXITING") throw new Error("社員身分設定不正確");
  if (department && department.length > 60) throw new Error("部門名稱不能超過 60 個字元");
  if (!Number.isInteger(balanceAdjustment) || Math.abs(balanceAdjustment) > 100000) throw new Error("餘額調整必須是介於 -100,000 到 100,000 的整數");
  if (balanceAdjustment !== 0 && !adjustmentNote) throw new Error("調整帳戶餘額時必須填寫原因");
  if (adjustmentNote.length > 200) throw new Error("調整原因不能超過 200 個字元");

  const db = getAdminFirestore();
  const memberRef = db.collection("members").doc(memberId);
  const adminQuery = db.collection("members").where("role", "==", "ADMIN");
  const auditRef = db.collection("auditLogs").doc(randomUUID());
  const adjustmentRef = balanceAdjustment === 0 ? null : db.collection("invoices").doc(`adjustment-${randomUUID()}`);
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const [memberSnapshot, adminSnapshot, manager] = await Promise.all([transaction.get(memberRef), transaction.get(adminQuery), transaction.get(db.collection("members").doc(actor.id))]);
    if (manager.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    if (!memberSnapshot.exists) throw new Error("找不到使用者");
    const member = memberSnapshot.data()!;
    const isPrimaryAdmin = isClubPresident(member);
    const isDemotion = member.role === "ADMIN" && role !== "ADMIN";
    if (isPrimaryAdmin && (role !== "ADMIN" || membershipStatus !== "MEMBER")) throw new Error(PRESIDENT_EXIT_MESSAGE);
    if (actor.id === memberId && isDemotion) throw new Error("不能取消自己的幹部權限");
    if (isDemotion && adminSnapshot.size <= 1) throw new Error("系統至少需要保留一位幹部");
    const currentBalance = Number(member.creditBalance ?? 0);
    const nextBalance = currentBalance + balanceAdjustment;
    if (nextBalance < 0) throw new Error("帳戶餘額不足，無法套用這筆扣除");
    if (membershipStatus === "EXITING" && !member.endingAt) throw new Error("只有已排定期末退出的使用者可以保留此狀態");

    transaction.update(memberRef, {
      department,
      role,
      // Do not turn a same-name guest into a second legacy president on promotion.
      primaryAdmin: isPrimaryAdmin,
      membershipStatus,
      endingAt: membershipStatus === "EXITING" ? member.endingAt : null,
      creditBalance: nextBalance,
      updatedAt: now,
    });
    transaction.create(auditRef, {
      id: auditRef.id,
      action: "UPDATE_MEMBER",
      actorId: actor.id,
      actorNameSnapshot: actor.name,
      targetMemberId: memberId,
      before: {
        department: member.department ?? null,
        role: member.role ?? "MEMBER",
        membershipStatus: member.membershipStatus ?? "GUEST",
        creditBalance: currentBalance,
      },
      after: { department, role, membershipStatus, creditBalance: nextBalance },
      note: adjustmentNote || null,
      createdAt: now,
    });
    if (adjustmentRef) {
      recordBalanceMovement(transaction, db, { memberId, amount: balanceAdjustment, reason: adjustmentNote, sourceKey: `invoice:${adjustmentRef.id}:adjustment`, invoiceId: adjustmentRef.id, actorId: actor.id, actorName: actor.name, createdAt: now });
      transaction.create(adjustmentRef, {
        id: adjustmentRef.id,
        memberId,
        memberNameSnapshot: String(member.displayName ?? "未知使用者"),
        eventId: null,
        type: "ADJUSTMENT",
        grossAmount: -balanceAdjustment,
        creditApplied: 0,
        amount: -balanceAdjustment,
        status: "CONFIRMED",
        periodLabel: "幹部手動餘額調整",
        confirmedAt: now,
        confirmedBy: actor.id,
        note: adjustmentNote,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  if (membershipStatus === "MEMBER") await ensureMemberFutureBookings(memberId);
}

async function transferPresident(input: Record<string, string>, actor: Viewer) {
  const memberId = input.memberId?.trim();
  if (!memberId || memberId === actor.id) throw new Error("請選擇另一位社員接任社長");
  if (input.confirmed !== "true") throw new Error("請先確認轉交社長權限");
  const db = getAdminFirestore();
  const currentRef = db.collection("members").doc(actor.id);
  const targetRef = db.collection("members").doc(memberId);
  const lockRef = db.collection("membershipRequestLocks").doc(memberId);
  const auditRef = db.collection("auditLogs").doc(randomUUID());
  const now = new Date();
  return db.runTransaction(async (transaction) => {
    const [[currentSnapshot, targetSnapshot, lock], administrators, requests] = await Promise.all([
      transaction.getAll(currentRef, targetRef, lockRef),
      transaction.get(db.collection("members").where("role", "==", "ADMIN")),
      transaction.get(db.collection("membershipRequests").where("memberId", "==", memberId)),
    ]);
    const current = currentSnapshot.data();
    const target = targetSnapshot.data();
    if (!current || !isClubPresident(current)) throw new Error("只有現任社長可以轉交社長權限");
    const presidents = administrators.docs.filter((entry) => isClubPresident(entry.data()));
    if (presidents.length !== 1 || presidents[0].id !== actor.id) throw new Error("社長資料不一致，請先聯絡系統管理者確認");
    if (!target) throw new Error("找不到接任社員");
    if (target.membershipStatus !== "MEMBER" || target.endingAt) throw new Error("接任者必須是未排定退出的有效社員");
    if (!["guest", "recoverable", "verified"].includes(String(target.accountType))) throw new Error("請先讓接任社員完成帳號認領或建立帳號");
    if (lock.data()?.kind === "EXIT" || requests.docs.some((entry) => entry.data().kind === "EXIT" && entry.data().status === "PENDING")) throw new Error("接任社員有待審核的退出申請，請先處理申請");

    transaction.update(currentRef, { role: "MEMBER", primaryAdmin: false, membershipStatus: "MEMBER", endingAt: null, updatedAt: now });
    transaction.update(targetRef, { role: "ADMIN", primaryAdmin: true, updatedAt: now });
    transaction.create(auditRef, {
      id: auditRef.id, action: "TRANSFER_PRESIDENT", actorId: actor.id,
      actorNameSnapshot: String(current.displayName ?? actor.name), targetMemberId: memberId,
      targetNameSnapshot: String(target.displayName ?? "社員"),
      before: { presidentId: actor.id, targetRole: String(target.role ?? "MEMBER") },
      after: { presidentId: memberId, formerPresidentRole: "MEMBER" }, createdAt: now,
    });
    transaction.create(db.collection("notifications").doc(), notificationData({ title: "社長權限已轉交", message: "你已轉交社長權限給「" + String(target.displayName ?? "社員") + "」，目前為一般社員；如需退社，可再提出申請。", type: "MEMBERSHIP", tab: "個人資訊", recipientId: actor.id }));
    transaction.create(db.collection("notifications").doc(), notificationData({ title: "你已接任社長", message: String(current.displayName ?? actor.name) + " 已將社長權限轉交給你。", type: "MEMBERSHIP", tab: "個人資訊", recipientId: memberId }));
    return { presidentId: memberId };
  });
}

async function issueClaimCode(memberId: string, actor: Viewer) {
  if (!memberId) throw new Error("缺少使用者識別碼");
  const db = getAdminFirestore();
  const memberRef = db.collection("members").doc(memberId);
  const claim = createClaimCodeRecord();
  return db.runTransaction(async (transaction) => {
    const [member, manager] = await transaction.getAll(memberRef, db.collection("members").doc(actor.id));
    if (manager.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
    if (!member.exists) throw new Error("找不到使用者");
    if (isClubPresident(member.data()!) && memberId !== actor.id) throw new Error("只有社長本人可以為自己的帳號產生認領碼");
    transaction.update(memberRef, { claimCodeSalt: claim.salt, claimCodeHash: claim.hash, claimCodeCreatedAt: new Date(), updatedAt: new Date() });
    return { claimCode: claim.code, recipientName: String(member.data()?.displayName ?? "使用者") };
  });
}

export async function mutate(action: string, input: Record<string, string>, actor: Viewer) {
  if (action === "updateDisplayName") return updateDisplayName(input, actor);
  if (action === "join") return join(input, actor);
  if (action === "cancel") return cancel(input, actor);
  if (action === "transfer") return transfer(input, actor);
  if (action === "reportPayment") return reportPayment(input.invoiceId, actor);
  if (action === "requestMembershipChange") return requestMembershipChange(input.kind, actor);
  if (action === "markNotificationsRead") return markNotificationsRead(input, actor);

  if (actor.role !== "ADMIN") throw new Error("只有幹部可以執行這項操作");
  const currentActor = await getAdminFirestore().collection("members").doc(actor.id).get();
  if (currentActor.data()?.role !== "ADMIN") throw new Error("幹部權限已變更，請重新整理");
  if (action === "adjustMemberBalance") return adjustMemberBalance(input, actor);
  if (action === "transferPresident") return transferPresident(input, actor);
  if (["voidInvoice", "reissueInvoice", "refundInvoice", "rejectPaymentReport"].includes(action)) return manageInvoice(action, input, actor);
  if (action === "voidInvoiceBatch") return voidInvoiceBatch(input, actor);
  if (action === "reviewMembershipRequest") return reviewMembershipRequest(input.requestId, input.decision, actor);
  if (action === "confirmPayment") return confirmPayment(input, actor);
  if (action === "recordInvoiceReceipts") return recordInvoiceReceipts(input, actor);
  if (action === "recordEventRefunds") return recordEventRefunds(input, actor);
  if (action === "previewGuestEventBills") return publishGuestEventBills(input, actor, true);
  if (action === "publishGuestEventBills") return publishGuestEventBills(input, actor);
  if (action === "remindPayment") return remindPayment(input.invoiceId, actor);
  if (action === "previewQuarterlyInvoices") return previewQuarterlyInvoices(input, actor);
  if (action === "previewCalendarQuarter") return createQuarterBillingPeriod(input, actor, true);
  if (action === "publishCalendarQuarter") {
    if (!/^[a-f0-9]{64}$/.test(input.previewKey ?? "")) throw new Error("請先核對帳單");
    await createQuarterBillingPeriod(input, actor);
    return createQuarterlyInvoices({ ...input, planId: input.periodId }, actor);
  }
  if (action === "createQuarterBillingPeriod") return createQuarterBillingPeriod(input, actor);
  if (action === "previewMemberExtraBills") return previewMemberExtraBills(input, actor);
  if (action === "publishMemberExtraBills") return publishMemberExtraBills(input, actor);
  if (action === "createQuarterlyInvoices") return createQuarterlyInvoices(input, actor);
  if (action === "setFeeRates") return setFeeRates(input);
  if (action === "updateMember") return updateMember(input, actor);
  if (action === "issueClaimCode") return issueClaimCode(input.memberId, actor);
  if (action === "publish") return publish(input);
  if (action === "updateAnnouncement") return updateAnnouncement(input);
  if (action === "deleteAnnouncement") return deleteAnnouncement(input.announcementId);
  if (action === "setAnnouncementPinned") return setAnnouncementPinned(input.announcementId, input.pinned);
  if (action === "createEvent") return createEvent(input, actor);
  if (action === "updateEvent") return updateEvent(input, actor);
  if (action === "previewCancelEvent") return cancelEvent(input, actor, true);
  if (action === "cancelEvent") return cancelEvent(input, actor);
  if (action === "confirmQuarterPlan") return confirmQuarterPlan(input, actor);
  if (action === "promoteStandby") return promoteStandby(input.eventId);
  throw new Error("不支援的操作");
}
