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
import { validateQuarterSchedule, effectiveInvoiceAmounts, reduceUnpaidInvoice, validCalendarDate, type QuarterRules, type SuggestedActivity } from "@/lib/quarter-planning";

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
    return event.status === "SCHEDULED"
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
};

type GuestSettlement = {
  memberId: string;
  status: "ISSUED" | "SKIPPED" | "LEGACY";
  amount: number | null;
};

function storedGuestSettlements(event: DocumentData): GuestSettlement[] {
  return Array.isArray(event.guestSettlements) ? event.guestSettlements : [];
}

function legacyGuestBills(invoices: FirebaseFirestore.QueryDocumentSnapshot[]) {
  const byEvent = new Map<string, Map<string, number | null>>();
  for (const entry of invoices) {
    const data = entry.data();
    if (data.type !== "SINGLE_EVENT" || data.guestSettlementSource === "POST_EVENT" || !data.eventId || !data.memberId) continue;
    const eventId = String(data.eventId);
    const memberId = String(data.memberId);
    const eventBills = byEvent.get(eventId) ?? new Map<string, number | null>();
    const liveAmount = ["PENDING", "REPORTED", "CONFIRMED"].includes(data.status) ? effectiveInvoiceAmounts(data).amount : null;
    if (!eventBills.has(memberId) || liveAmount !== null) eventBills.set(memberId, liveAmount);
    byEvent.set(eventId, eventBills);
  }
  return byEvent;
}

// Keep an unverified transfer pending. The standard confirm/reject actions
// resolve its linked credit after the cash has (or has not) been verified.
function cancelSingleEventInvoice(transaction: Transaction, db: Firestore, invoice: DocumentSnapshot, eventId: string, reason: string, now: Date, actor: Viewer) {
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

async function cancelEventInTransaction(
  transaction: Transaction,
  db: Firestore,
  eventRef: DocumentReference,
  reason: string,
  now: Date,
  actor: Viewer,
): Promise<EventCancellationSummary> {
  const eventSnapshot = await transaction.get(eventRef);
  if (!eventSnapshot.exists) throw new Error("找不到活動");
  const event = eventSnapshot.data()!;
  const eventDateRef = db.collection("eventDates").doc(taipeiDate(event.startsAt));

  if (event.status === "CANCELLED") {
    const dateSnapshot = await transaction.get(eventDateRef);
    if (dateSnapshot.data()?.eventId === eventRef.id) transaction.delete(eventDateRef);
    return { cancelledBookings: 0, voidedInvoices: 0, creditedInvoices: 0 };
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

  const linkedPeriods = await transaction.get(db.collection("billingPeriods").where("eventIds", "array-contains", eventRef.id));
  const adjustment = { eventId: eventRef.id, eventDate: taipeiDate(event.startsAt), reason: "活動取消", actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() };
  for (const period of linkedPeriods.docs) transaction.update(period.ref, { eventChanges: FieldValue.arrayUnion({ ...adjustment, kind: "CANCELLED" }), updatedAt: now });
  const creditsByMember = new Map<string, number>();
  const balanceCredits: { memberId: string; amount: number; reason: string; sourceKey: string; invoiceId: string; relatedInvoiceId?: string }[] = [];
  let voidedInvoices = 0;
  let creditedInvoices = 0;

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
        message: `${taipeiDate(event.startsAt)} ${String(event.courts ?? "羽球活動")} 已取消`,
        type: "EVENT",
        tab: "活動",
        recipientId,
      }));
    }
  }

  for (const invoice of invoices) {
    const invoiceData = invoice.data();
    if (!["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "SINGLE_EVENT", "MEMBER_EXTRA"].includes(invoiceData.type)) continue;
    const memberId = String(invoiceData.memberId ?? "");

    if (["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "MEMBER_EXTRA"].includes(String(invoiceData.type))) {
      const eventIds = Array.isArray(invoiceData.eventIds) ? invoiceData.eventIds.map(String) : invoiceData.eventId ? [String(invoiceData.eventId)] : [];
      const eventIndex = eventIds.indexOf(eventRef.id);
      if (eventIndex < 0 || !memberChargesForEvent([invoiceData], eventRef.id)) continue;
      if (Array.isArray(invoiceData.adjustments) && invoiceData.adjustments.some((entry: DocumentData) => entry.creditInvoiceId === "credit-" + eventRef.id + "-" + invoice.id)) continue;
      const eventCharge = Number(invoiceData.eventAmounts?.[eventIndex] ?? invoiceData.unitAmount ?? event.memberFeeSnapshot ?? 150);
      if (invoiceData.status === "PENDING") {
        const before = effectiveInvoiceAmounts(invoiceData);
        const reduced = reduceUnpaidInvoice(invoiceData, eventCharge);
        const { restoredCredit, ...amounts } = reduced;
        if (restoredCredit > 0) {
          creditsByMember.set(memberId, (creditsByMember.get(memberId) ?? 0) + restoredCredit);
          balanceCredits.push({ memberId, amount: restoredCredit, reason: "活動取消恢復帳單抵扣", sourceKey: `invoice:${invoice.id}:reduction:${eventRef.id}`, invoiceId: invoice.id });
        }
        transaction.update(invoice.ref, { ...amounts, status: reduced.adjustedAmount === 0 ? "CONFIRMED" : "PENDING", confirmedAt: reduced.adjustedAmount === 0 ? now : null, adjustments: FieldValue.arrayUnion({ ...adjustment, kind: "REDUCTION", amount: -eventCharge, beforeAmount: before.amount, afterAmount: reduced.adjustedAmount, restoredCredit }), updatedAt: now });
      } else {
        // A reported transfer is not settled money: wait for administrator confirmation before making this credit spendable.
        const creditRef = db.collection("invoices").doc("credit-" + eventRef.id + "-" + invoice.id);
        const settled = invoiceData.status === "CONFIRMED";
        if (settled) {
          creditsByMember.set(memberId, (creditsByMember.get(memberId) ?? 0) + eventCharge);
          balanceCredits.push({ memberId, amount: eventCharge, reason: "活動取消退回活動費", sourceKey: `invoice:${creditRef.id}:credit`, invoiceId: creditRef.id, relatedInvoiceId: invoice.id });
        }
        creditedInvoices += 1;
        transaction.create(creditRef, { id: creditRef.id, memberId, memberNameSnapshot: invoiceData.memberNameSnapshot, eventId: eventRef.id, relatedInvoiceId: invoice.id, type: "CREDIT", grossAmount: -eventCharge, creditApplied: 0, amount: -eventCharge, status: settled ? "CONFIRMED" : "AWAITING_PAYMENT_CONFIRMATION", periodLabel: "活動取消退回餘額", confirmedAt: settled ? now : null, note: settled ? "活動取消，已退回帳戶餘額" : "待原帳單收款確認後退回餘額", createdAt: now, updatedAt: now });
        transaction.update(invoice.ref, { adjustments: FieldValue.arrayUnion({ ...adjustment, kind: settled ? "CREDIT" : "CREDIT_PENDING", amount: -eventCharge, creditInvoiceId: creditRef.id }), updatedAt: now });
      }
      continue;
    }
    const cancelled = cancelSingleEventInvoice(transaction, db, invoice, eventRef.id, "EVENT_CANCELLED", now, actor);
    voidedInvoices += cancelled.voided;
    creditedInvoices += cancelled.credited;
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
    updatedAt: now,
  });
  if (dateSnapshot.data()?.eventId === eventRef.id) transaction.delete(eventDateRef);
  return { cancelledBookings: activeBookings.length, voidedInvoices, creditedInvoices };
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
  const events = eventSnapshot.docs
    .map((document) => {
      const event = document.data();
      const guestSettlements = isAdmin ? storedGuestSettlements(event) : [];
      const settledGuestIds = new Set(guestSettlements.map((entry) => entry.memberId));
      return {
        id: document.id,
        starts_at: iso(event.startsAt),
        ends_at: iso(event.endsAt),
        courts: String(event.courts ?? ""),
        regular_capacity: Number(event.regularCapacity ?? 10),
        standby_capacity: Number(event.standbyCapacity ?? 4),
        regular_count: Number(event.regularCount ?? 0),
        standby_count: Number(event.standbyCount ?? 0),
        member_fee: Number(event.memberFeeSnapshot ?? 150),
        member_billing: event.memberBilling ?? null,
        guest_fee: Number(event.guestFeeSnapshot ?? 180),
        status: String(event.status ?? "SCHEDULED"),
        created_at: iso(event.createdAt),
        bookings: (bookingsByEvent.get(document.id) ?? []).sort((a, b) => String(a.confirmedAt).localeCompare(String(b.confirmedAt))),
        ...(isAdmin ? { guest_settlements: [...guestSettlements, ...[...(legacyByEvent.get(document.id) ?? [])]
          .filter(([memberId]) => !settledGuestIds.has(memberId))
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
    }];
  }));

  const invoices = (invoiceSnapshot?.docs ?? [])
    .map((document) => {
      const invoice = document.data();
      const member = membersById.get(String(invoice.memberId));
      const period = periodSnapshot?.docs.find((entry) => entry.id === (invoice.periodId ?? invoice.relatedPeriodId))?.data();
      const refundTotal = (invoiceSnapshot?.docs ?? []).filter((entry) => entry.data().relatedInvoiceId === document.id && entry.data().type === "CREDIT" && ["CONFIRMED", "AWAITING_PAYMENT_CONFIRMATION"].includes(entry.data().status)).reduce((sum, entry) => sum + Math.max(0, -Number(entry.data().amount)), 0);
      const directEventId = invoice.eventId ? String(invoice.eventId) : null;
      const eventIds = Array.isArray(invoice.eventIds) ? invoice.eventIds.map(String) : directEventId ? [directEventId] : [];
      const receipt = invoice.receipt as InvoiceReceipt | undefined;
      return {
        id: document.id,
        member_id: String(invoice.memberId ?? ""),
        event_id: directEventId,
        event_ids: eventIds,
        event_amounts: eventIds.length ? eventIds.map((id, index) => eventSchedulesById.get(id)?.status === "CANCELLED" || membershipChargeRemoved(invoice, id) ? 0 : Number(invoice.eventAmounts?.[index] ?? invoice.unitAmount ?? Math.floor(effectiveInvoiceAmounts(invoice).grossAmount / eventIds.length))) : [effectiveInvoiceAmounts(invoice).grossAmount],
        event_schedules: eventIds.flatMap((eventId) => {
          const schedule = eventSchedulesById.get(eventId);
          return schedule ? [schedule] : [];
        }),
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
        refundable_amount: invoice.status === "CONFIRMED" && ["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "SINGLE_EVENT", "MEMBER_EXTRA"].includes(invoice.type) ? Math.max(0, effectiveInvoiceAmounts(invoice).grossAmount - refundTotal) : 0,
        status: String(invoice.status ?? "PENDING"),
        period_label: invoice.periodLabel ? String(invoice.periodLabel) : null,
        due_at: iso(invoice.dueAt),
        reported_at: iso(invoice.reportedAt),
        confirmed_at: iso(invoice.confirmedAt),
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
  return { viewer, members, events, announcements, invoices, quarterPlans, feeRates, membershipRequests, notifications, currentFees: { member: currentMemberFee, guest: currentGuestFee } };
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
    const status = kind === "MEMBER"
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
      attendanceSource: kind === "MEMBER" ? "MEMBER_REJOIN" : "SELF_REGISTERED",
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

async function publishGuestEventBills(input: Record<string, string>, actor: Viewer) {
  if (!input.eventId || input.eventId.includes("/") || input.eventId.length > 200) throw new Error("活動識別碼不正確");
  let raw: unknown;
  try { raw = JSON.parse(input.decisions ?? ""); } catch { throw new Error("請確認每位零打球友的結算方式"); }
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new Error("每批請確認 1 至 100 位零打球友");
  const decisions = new Map<string, "BILL" | "SKIP">();
  for (const item of raw) {
    if (!item || typeof item.memberId !== "string" || !item.memberId || item.memberId.includes("/") || item.memberId.length > 200
      || (item.decision !== "BILL" && item.decision !== "SKIP") || decisions.has(item.memberId)) throw new Error("結算名單格式不正確");
    decisions.set(item.memberId, item.decision);
  }
  const db = getAdminFirestore();
  const eventRef = db.collection("events").doc(input.eventId);
  const now = new Date();
  return db.runTransaction(async (transaction) => {
    const [currentActor, eventSnapshot, bookings, invoices] = await Promise.all([
      transaction.get(db.collection("members").doc(actor.id)),
      transaction.get(eventRef),
      transaction.get(eventRef.collection("bookings")),
      transaction.get(db.collection("invoices").where("eventId", "==", eventRef.id)),
    ]);
    if (currentActor.data()?.role !== "ADMIN") throw new Error("只有幹部可以結算零打");
    const event = eventSnapshot.data();
    if (!eventSnapshot.exists || event?.status !== "SCHEDULED") throw new Error("沒有可結算的活動");
    const endsAt = dateValue(event.endsAt);
    if (!endsAt || !Number.isFinite(endsAt.getTime()) || endsAt > now) throw new Error("活動結束後才能發布零打帳單");
    const grossAmount = Number(event.guestFeeSnapshot ?? 180);
    if (!Number.isSafeInteger(grossAmount) || grossAmount < 0 || grossAmount > 10_000) throw new Error("活動零打費不正確");
    const eligible = new Set(bookings.docs.filter((entry) => {
      const booking = entry.data();
      return booking.status === "REGULAR" && booking.kindSnapshot === "GUEST" && !booking.transferredFromMemberId;
    }).map((entry) => String(entry.data().memberId ?? entry.id)));
    const existing = storedGuestSettlements(event);
    const settled = new Map(existing.map((entry) => [entry.memberId, entry.status]));
    const legacy = legacyGuestBills(invoices.docs).get(eventRef.id);
    const pending = [...eligible].filter((id) => !settled.has(id) && !legacy?.has(id));
    const matchesExisting = (id: string, decision: "BILL" | "SKIP") => settled.get(id) === (decision === "BILL" ? "ISSUED" : "SKIPPED");
    if (pending.some((id) => !decisions.has(id)) || [...decisions].some(([id, decision]) => !eligible.has(id) || (settled.has(id) ? !matchesExisting(id, decision) : legacy?.has(id)))) {
      throw new Error("結算名單已變更，請重新開啟後確認");
    }
    if (!pending.length) return { issued: 0, skipped: 0 };

    const billIds = pending.filter((id) => decisions.get(id) === "BILL");
    const members = billIds.length ? await transaction.getAll(...billIds.map((id) => db.collection("members").doc(id))) : [];
    if (members.some((entry) => !entry.exists)) throw new Error("零打球友資料不存在，請重新整理");
    const memberById = new Map(members.map((entry) => [entry.id, entry]));
    const dueAt = billingBoundary(taipeiDate(new Date(now.getTime() + 7 * 86_400_000)), true);
    const results: GuestSettlement[] = [];
    for (const memberId of pending) {
      if (decisions.get(memberId) === "SKIP") {
        results.push({ memberId, status: "SKIPPED", amount: null });
        continue;
      }
      const member = memberById.get(memberId)!;
      const memberData = member.data()!;
      const creditApplied = Math.min(grossAmount, Math.max(0, Number(memberData.creditBalance ?? 0)));
      if (!Number.isSafeInteger(creditApplied)) throw new Error("零打球友的帳戶餘額不正確");
      const amount = grossAmount - creditApplied;
      const invoiceId = "guest-settlement-" + createHash("sha256").update(JSON.stringify([eventRef.id, memberId])).digest("hex");
      const invoiceRef = db.collection("invoices").doc(invoiceId);
      transaction.create(invoiceRef, {
        id: invoiceId, memberId, memberNameSnapshot: String(memberData.displayName ?? "未知使用者"),
        eventId: eventRef.id, type: "SINGLE_EVENT", periodLabel: "零打活動費", guestSettlementSource: "POST_EVENT",
        grossAmount, creditApplied, amount, dueAt, status: amount === 0 ? "CONFIRMED" : "PENDING",
        reportedAt: null, confirmedAt: amount === 0 ? now : null, createdAt: now, updatedAt: now,
      });
      if (creditApplied > 0) {
        transaction.update(member.ref, { creditBalance: FieldValue.increment(-creditApplied), updatedAt: now });
        recordBalanceMovement(transaction, db, {
          memberId, amount: -creditApplied, reason: "零打活動費結算抵扣", sourceKey: `invoice:${invoiceId}:apply`,
          invoiceId, eventId: eventRef.id, actorId: actor.id, actorName: actor.name, createdAt: now,
        });
      }
      transaction.create(db.collection("notifications").doc(), notificationData({
        title: "零打活動費已結算", message: `${taipeiDate(event.startsAt)} 零打活動費已結算；應付 NT$${amount}`,
        type: "PAYMENT", tab: "費用管理", recipientId: memberId,
      }));
      results.push({ memberId, status: "ISSUED", amount });
    }
    transaction.update(eventRef, { guestSettlements: [...existing, ...results], guestSettledAt: now, guestSettledBy: actor.id, updatedAt: now });
    return { issued: billIds.length, skipped: pending.length - billIds.length };
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
    if (booking.kindSnapshot !== "MEMBER" && !beforeStart) throw new Error("活動已開始，不能自行取消報名；請聯絡幹部確認出席");
    const invoices = beforeStart ? await transaction.get(db.collection("invoices").where("eventId", "==", input.eventId)) : null;
    const relatedInvoices = invoices?.docs.filter((document) => document.data().memberId === memberSnapshot.id && ["SINGLE_EVENT", "MEMBER_EXTRA"].includes(document.data().type) && ["PENDING", "REPORTED", "CONFIRMED"].includes(document.data().status)) ?? [];
    let promoted = 0;
    if (booking.status === "REGULAR" && beforeStart) {
      promoted = await promoteStandbyInTransaction(transaction, eventRef, event, 1, now);
    }

    transaction.update(bookingRef, { status: "CANCELLED", cancelledAt: now, updatedAt: now });
    if (booking.status === "REGULAR") {
      transaction.update(eventRef, {
        regularCount: FieldValue.increment(-1 + promoted),
        standbyCount: FieldValue.increment(-promoted),
        updatedAt: now,
      });
    } else {
      transaction.update(eventRef, { standbyCount: FieldValue.increment(-1), updatedAt: now });
    }

    for (const invoice of relatedInvoices) cancelSingleEventInvoice(transaction, db, invoice, input.eventId, "BOOKING_CANCELLED", now, actor);
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
  const standbyCapacity = Number(input.standbyCapacity || 4);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) throw new Error("結束時間必須晚於開始時間");
  if (!Number.isInteger(regularCapacity) || regularCapacity < 1 || !Number.isInteger(standbyCapacity) || standbyCapacity < 0) throw new Error("請填寫正確的正取與候補人數");
  if (regularCapacity + standbyCapacity > 100) throw new Error("單場正取與候補合計最多 100 人");
  return { startsAt, endsAt, courts: input.courts.trim(), regularCapacity, standbyCapacity, date: taipeiDate(startsAt) };
}

async function createEvent(input: Record<string, string>, actor: Viewer) {
  const values = validatedEventInput(input);
  if (!["NO_CHARGE", "EXTRA"].includes(input.memberBilling)) throw new Error("請選擇加場的社員收費方式");
  if (!input.billingReason?.trim() || input.billingReason.length > 200) throw new Error("請填寫加場收費或免收原因（最多 200 字）");
  if (values.startsAt <= new Date()) throw new Error("不能新增已開始的活動");
  const db = getAdminFirestore();
  const [memberFeeSnapshot, guestFeeSnapshot, memberSnapshot] = await Promise.all([
    activeFee(db, "MEMBER_VISIT", values.startsAt),
    activeFee(db, "GUEST_VISIT", values.startsAt),
    db.collection("members").get(),
  ]);
  const defaultMembers = memberSnapshot.docs.filter((document) => memberAt(document.data(), values.startsAt));
  const eventRef = db.collection("events").doc();
  const eventDateRef = db.collection("eventDates").doc(values.date);
  const notificationRef = input.notify === "false" ? null : db.collection("notifications").doc();
  const now = new Date();
  await db.runTransaction(async (transaction) => {

    const dateSnapshot = await transaction.get(eventDateRef);
    const periods = await transaction.get(db.collection("billingPeriods"));
    const period = periods.docs.find((entry) => entry.data().startDate <= values.date && entry.data().endDate >= values.date);
    if (dateSnapshot.exists) throw new Error("這一天已有活動，請直接編輯既有活動");
    transaction.create(eventRef, {
      id: eventRef.id,
      startsAt: values.startsAt,
      endsAt: values.endsAt,
      courts: values.courts,
      regularCapacity: values.regularCapacity,
      standbyCapacity: values.standbyCapacity,
      memberFeeSnapshot,
      guestFeeSnapshot,
      regularCount: defaultMembers.length,
      standbyCount: 0,
      memberDefaultsVersion: MEMBER_DEFAULTS_VERSION,
      source: "MANUAL",
      memberBilling: input.memberBilling,
      billingReason: input.billingReason.trim(),
      relatedPeriodId: period?.id ?? null,
      status: "SCHEDULED",
      createdAt: now,
      updatedAt: now,
    });
    transaction.create(eventDateRef, { eventId: eventRef.id, date: values.date, createdAt: now });
    for (const memberDocument of defaultMembers) {
      transaction.create(
        eventRef.collection("bookings").doc(memberDocument.id),
        defaultMemberBooking(eventRef.id, memberDocument.id, memberDocument.data(), now),
      );
    }

    if (period) transaction.update(period.ref, { eventChanges: FieldValue.arrayUnion({ kind: "ADDED", eventId: eventRef.id, eventDate: values.date, memberBilling: input.memberBilling, reason: input.billingReason.trim(), actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() }), updatedAt: now });
    if (input.memberBilling === "EXTRA") {
      for (const member of defaultMembers) {
        const invoiceRef = db.collection("invoices").doc("extra-" + eventRef.id + "-" + member.id);
        transaction.create(invoiceRef, { id: invoiceRef.id, memberId: member.id, memberNameSnapshot: String(member.data().displayName), eventId: eventRef.id, eventIds: [eventRef.id], eventAmounts: [memberFeeSnapshot], type: "MEMBER_EXTRA", grossAmount: memberFeeSnapshot, creditApplied: 0, amount: memberFeeSnapshot, relatedPeriodId: period?.id ?? null, periodLabel: values.date + " 社員加場補收", status: "PENDING", dueAt: values.startsAt, adjustments: [{ kind: "EXTRA", reason: input.billingReason.trim(), eventDate: values.date, amount: memberFeeSnapshot, actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() }], createdAt: now, updatedAt: now });
        transaction.create(db.collection("notifications").doc(), notificationData({ title: "社員加場補收", message: values.date + " 加場，另收 NT$" + memberFeeSnapshot + "；原季度帳單不變", type: "PAYMENT", tab: "費用管理", recipientId: member.id }));
      }
    }
    if (notificationRef) transaction.create(notificationRef, notificationData({ title: "新活動已排程", message: `${values.date} ${values.courts}；社員已預設正取，非社員可依剩餘名額報名`, type: "EVENT", tab: "活動" }));
  });
  return { eventId: eventRef.id, date: values.date };
}

async function updateEvent(input: Record<string, string>, actor: Viewer) {
  const values = validatedEventInput(input);
  const db = getAdminFirestore();
  const eventRef = db.collection("events").doc(input.eventId);
  const now = new Date();
  await db.runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(eventRef);
    if (!eventSnapshot.exists || eventSnapshot.data()?.status !== "SCHEDULED") throw new Error("找不到可編輯的活動");
    const event = eventSnapshot.data()!;
    if (event.guestSettledAt) throw new Error("零打已結算，不能再編輯本場；帳單變更請在費用管理處理");
    const oldDate = taipeiDate(event.startsAt);
    const oldDateRef = db.collection("eventDates").doc(oldDate);
    const newDateRef = db.collection("eventDates").doc(values.date);
    const [newDateSnapshot, bookingSnapshot] = await Promise.all([
      transaction.get(newDateRef),
      transaction.get(eventRef.collection("bookings")),
    ]);
    if (newDateSnapshot.exists && newDateSnapshot.data()?.eventId !== input.eventId) throw new Error("這一天已有其他活動");

    const regularCount = Number(event.regularCount ?? 0);
    const standbyCount = Number(event.standbyCount ?? 0);
    const promoted = await promoteStandbyInTransaction(transaction, eventRef, event, Math.max(0, values.regularCapacity - regularCount), now);
    const remainingStandby = standbyCount - promoted;
    if (values.standbyCapacity < remainingStandby) throw new Error(`調整後仍有 ${remainingStandby} 位候補，候補容量不能低於目前人數`);

    transaction.update(eventRef, {

      startsAt: values.startsAt,
      endsAt: values.endsAt,
      courts: values.courts,
      regularCapacity: values.regularCapacity,
      standbyCapacity: values.standbyCapacity,
      regularCount: FieldValue.increment(promoted),
      standbyCount: FieldValue.increment(-promoted),
      changes: FieldValue.arrayUnion({ reason: "調整活動時間／場地／容量，計費基準不變", before: { startsAt: iso(event.startsAt), endsAt: iso(event.endsAt), courts: event.courts }, after: { startsAt: values.startsAt.toISOString(), endsAt: values.endsAt.toISOString(), courts: values.courts }, actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() }),
      updatedAt: now,
    });
    if (oldDate !== values.date) transaction.delete(oldDateRef);
    transaction.set(newDateRef, { eventId: input.eventId, date: values.date, updatedAt: now }, { merge: true });
    for (const booking of bookingSnapshot.docs.filter((document) => ["REGULAR", "STANDBY"].includes(String(document.data().status)))) {
      const recipientId = String(booking.data().memberId ?? booking.id);
      const notificationRef = db.collection("notifications").doc();
      transaction.create(notificationRef, notificationData({ title: "活動資訊已更新", message: `${values.date} ${values.courts}，請重新確認日期、時間與集合地點`, type: "EVENT", tab: "活動", recipientId }));
    }
  });
}

async function cancelEvent(eventId: string, actor: Viewer) {
  if (!eventId) throw new Error("缺少活動識別碼");
  const db = getAdminFirestore();
  const eventRef = db.collection("events").doc(eventId);
  return db.runTransaction((transaction) => cancelEventInTransaction(transaction, db, eventRef, "ADMIN_CANCELLED", new Date(), actor));
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
      if (event.status === "CANCELLED") continue;
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
    if (periods.docs.some((doc) => String(doc.data().startDate) <= plan.endDate && String(doc.data().endDate) >= plan.startDate)) throw new Error("此季度與既有計費期間重疊，請調整日期範圍");
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
      const memberFeeSnapshot = rateFor("MEMBER_VISIT", startsAt);
      transaction.create(eventRef, { id: eventRef.id, startsAt, endsAt, courts: entry.courts, regularCapacity: entry.regularCapacity, standbyCapacity: entry.standbyCapacity, memberFeeSnapshot, guestFeeSnapshot: rateFor("GUEST_VISIT", startsAt), regularCount: defaultMembers.length, standbyCount: 0, memberDefaultsVersion: MEMBER_DEFAULTS_VERSION, source: "QUARTER_PLAN", quarterPlanId: planRef.id, status: "SCHEDULED", createdAt: now, updatedAt: now });
      transaction.create(db.collection("eventDates").doc(entry.date), { eventId: eventRef.id, date: entry.date, createdAt: now });
      for (const member of defaultMembers) transaction.create(eventRef.collection("bookings").doc(member.id), defaultMemberBooking(eventRef.id, member.id, member.data(), now));
      return { id: eventRef.id, startsAt, endsAt, courts: entry.courts, memberFeeSnapshot };
    });
    const eventIds = snapshots.map((event) => event.id);
    const eventAmounts = snapshots.map((event) => event.memberFeeSnapshot);
    const grossAmount = eventAmounts.reduce((sum, amount) => sum + amount, 0);
    const periodId = "quarter-" + planRef.id;
    transaction.create(db.collection("billingPeriods").doc(periodId), { id: periodId, planId: planRef.id, type: "QUARTERLY_MEMBER", label: plan.label, startDate: plan.startDate, endDate: plan.endDate, eventIds, eventAmounts, eventSnapshots: snapshots, eventCount: eventIds.length, grossAmount, status: "PLANNED", confirmedBy: actor.id, confirmedAt: now, createdAt: now, updatedAt: now });
    transaction.create(planRef, { id: planRef.id, ...plan, activities: newActivities, skippedDates, status: "CONFIRMED", confirmationKey, eventIds, eventAmounts, eventCount: eventIds.length, grossAmount, periodId, confirmedBy: actor.id, confirmedAt: now, createdAt: now, updatedAt: now });
    transaction.create(db.collection("notifications").doc(), notificationData({ title: "季度活動已確認", message: plan.label + " 新增 " + eventIds.length + " 場；社員已預設參加，季度計費基準只包含新場次", type: "EVENT", tab: "活動" }));
    return { planId: planRef.id, eventCount: eventIds.length, totalAmount: grossAmount, skippedDates };
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
  return invoices.some((invoice) => ["PENDING", "REPORTED", "CONFIRMED"].includes(String(invoice.status)) &&
    ["SINGLE_EVENT", "QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "MEMBER_EXTRA"].includes(String(invoice.type)) &&
    (invoice.eventId === eventId || (Array.isArray(invoice.eventIds) && invoice.eventIds.includes(eventId))) &&
    !membershipChargeRemoved(invoice, eventId));
}

function periodEvents(period: DocumentData, events: (DocumentSnapshot | undefined)[]) {
  return events.flatMap((event, index) => {
    const snapshot = period.eventSnapshots?.[index];
    const data = event?.data();
    const startsAt = dateValue(data?.startsAt ?? snapshot?.startsAt);
    if (!event || !data || !startsAt || !Number.isFinite(startsAt.getTime())) return [];
    return [{ id: event.id, data, startsAt, amount: Number(period.eventAmounts?.[index] ?? data.memberFeeSnapshot ?? 150), snapshot: snapshot ?? null }];
  });
}

function quarterlyQuote(period: DocumentData, members: DocumentSnapshot[], events: DocumentSnapshot[], invoices: DocumentSnapshot[], dueAt: Date) {
  const entries = periodEvents(period, events);
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
    const creditApplied = Math.min(Math.max(0, Number(data.creditBalance ?? 0)), grossAmount);
    return [{ memberId: member.id, name: String(data.displayName ?? ""), eventCount: effective.length, eventIds: effective.map((entry) => entry.id), grossAmount, creditApplied, amount: grossAmount - creditApplied }];
  }).sort((a, b) => a.memberId.localeCompare(b.memberId));
  const previewKey = createHash("sha256").update(JSON.stringify([period.id, dueAt.toISOString(), rows])).digest("hex");
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
    return quarterlyQuote(period, members.docs, events, invoices.docs, dueAt);
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
    const period = await transaction.get(periodRef);
    if (!period.exists || !["PLANNED", "GENERATING", "ACTIVE"].includes(String(period.data()?.status))) throw new Error("請先確認季度活動");
    if (period.data()?.status === "ACTIVE") throw new Error("這個季度的社員帳單已經建立");
    if (period.data()?.status === "GENERATING") return;
    const basis = period.data()!;
    const [members, invoices, events] = await Promise.all([
      transaction.get(db.collection("members")),
      transaction.get(db.collection("invoices")),
      transaction.getAll(...(basis.eventIds as string[]).map((id) => db.collection("events").doc(id))),
    ]);
    const quote = quarterlyQuote(basis, members.docs, events, invoices.docs, dueAt);
    if (input.previewKey && quote.previewKey !== input.previewKey) throw new Error("員額、帳單或餘額已變更，請重新預覽");
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
      if (creditApplied - restoredCredit > 0) {
        transaction.update(memberRef, { creditBalance: FieldValue.increment(-(creditApplied - restoredCredit)), updatedAt: now });
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
  const amount = pending.reduce((sum, doc) => sum - Number(doc.data().amount), 0);
  transaction.update(invoice.ref, {
    status: "CONFIRMED", confirmedAt: now, confirmedBy: actor.id, updatedAt: now,
    ...(receipt ? { receipt } : {}),
    ...(pending.length ? { adjustments: FieldValue.arrayUnion({ kind: "CREDIT_RELEASED", reason: "收款確認，取消活動費退回帳戶餘額", amount: -amount, actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() }) } : {}),
  });
  for (const credit of pending) transaction.update(credit.ref, { status: "CONFIRMED", confirmedAt: now, updatedAt: now });
  if (amount > 0) {
    transaction.update(db.collection("members").doc(memberId), { creditBalance: FieldValue.increment(amount), updatedAt: now });
    for (const credit of pending) recordBalanceMovement(transaction, db, { memberId, amount: -Number(credit.data().amount), reason: "收款確認釋放活動退款", sourceKey: `invoice:${credit.id}:credit`, invoiceId: credit.id, relatedInvoiceId: invoice.id, eventId: credit.data().eventId ? String(credit.data().eventId) : null, actorId: actor.id, actorName: actor.name, createdAt: now });
  }
  const receiptMessage = receipt
    ? `${receipt.receivedDate} 已登記${receipt.method === "CASH" ? "現金" : "轉帳"}收款 NT$${receipt.amount}`
    : "NT$" + effectiveInvoiceAmounts(data).amount + " 已確認收款";
  transaction.create(db.collection("notifications").doc(), notificationData({ title: "款項已確認", message: receiptMessage + (amount > 0 ? "；取消活動費 NT$" + amount + " 已退回帳戶餘額" : ""), type: "PAYMENT", tab: "費用管理", recipientId: memberId }));
}

async function confirmPayment(invoiceId: string, actor: Viewer) {
  if (!invoiceId) throw new Error("缺少帳單識別碼");
  const db = getAdminFirestore();
  const invoiceRef = db.collection("invoices").doc(invoiceId);
  await db.runTransaction(async (transaction) => {
    const invoice = await transaction.get(invoiceRef);
    if (!invoice.exists) throw new Error("找不到帳單");
    const data = invoice.data()!;
    if (data.status === "CONFIRMED") return;
    if (!["PENDING", "REPORTED"].includes(data.status)) throw new Error("這筆帳單目前無法確認收款");
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
      if (!data?.memberId || !["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "SINGLE_EVENT", "MEMBER_EXTRA"].includes(String(data.type))) throw new Error("找不到可登記的收費帳單，請重新整理");
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
      const pendingIds = new Set(pendingGuestBills.map((document) => document.id));
      const existing = memberInvoices.docs.filter((document) => !pendingIds.has(document.id)).map((document) => document.data());
      let balanceDelta = 0;
      let amount = 0;
      for (const document of pendingGuestBills) {
        const restored = effectiveInvoiceAmounts(document.data()).creditApplied;
        balanceDelta += restored;
        transaction.update(document.ref, { status: "VOID", voidReason: "活動開始前已轉為社員，取消原零打帳單", cancellationReason: "MEMBERSHIP_JOIN", updatedAt: now });
        recordBalanceMovement(transaction, db, { memberId, amount: restored, reason: "入社後退回原零打抵扣", sourceKey: `invoice:${document.id}:membership-join`, invoiceId: document.id, actorId: actor.id, actorName: actor.name, createdAt: now });
      }
      const graceDueAt = new Date(now);
      graceDueAt.setUTCDate(graceDueAt.getUTCDate() + 14);
      const billedPeriods = periods.docs.filter((document) => ["GENERATING", "ACTIVE"].includes(String(document.data().status)) && String(document.data().endDate) >= taipeiDate(now))
        .sort((a, b) => String(a.data().startDate).localeCompare(String(b.data().startDate)));
      for (const document of billedPeriods) {
        const basis = document.data();
        const refs = (Array.isArray(basis.eventIds) ? basis.eventIds : []).map((id: string) => eventsById.get(id));
        const eligible = periodEvents(basis, refs).filter((entry) => entry.data.status === "SCHEDULED" && entry.startsAt > now && !memberChargesForEvent(existing, entry.id));
        if (!eligible.length) continue;
        const gross = eligible.reduce((sum, entry) => sum + entry.amount, 0);
        const creditApplied = Math.min(Math.max(0, Number(member.creditBalance ?? 0) + balanceDelta), gross);
        const due = dateValue(basis.dueAt);
        const invoiceRef = db.collection("invoices").doc(`membership-${document.id}-${requestId}`);
        const row = {
          id: invoiceRef.id, memberId, memberNameSnapshot: String(member.displayName ?? freshRequest.data()?.memberNameSnapshot ?? "未知使用者"),
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
      transaction.update(memberRef, {
        membershipStatus: "MEMBER",
        memberSince: now,
        endingAt: null,
        creditBalance: FieldValue.increment(balanceDelta),
        updatedAt: now,
      });
      transaction.update(requestRef, { status: "APPROVED", reviewedAt: now, reviewedBy: actor.id, proratedAmount: amount, updatedAt: now });
      if (lock.exists && lock.data()?.requestId === requestId) transaction.delete(lockRef);
      transaction.create(notificationRef, notificationData({ title: "已加入社員", message: amount > 0 ? `申請已核准，本期應付 NT$${amount}` : "申請已核准，社員身分已立即生效", type: "MEMBERSHIP", tab: amount > 0 ? "費用管理" : "個人資訊", recipientId: memberId }));
      return { amount, joined: true };
    }

    if (isClubPresident(member)) throw new Error(PRESIDENT_EXIT_MESSAGE);
    const endingAt = periodDocument ? billingBoundary(String(period?.endDate), true) : now;
    const afterEnd = allEvents.docs.filter((document) => {
      const data = document.data();
      const starts = dateValue(data.startsAt);
      return data.status === "SCHEDULED" && starts && starts > endingAt;
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
      if (!["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "MEMBER_EXTRA"].includes(String(invoice.type))) continue;
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
  if (action === "confirmPayment") return confirmPayment(input.invoiceId, actor);
  if (action === "recordInvoiceReceipts") return recordInvoiceReceipts(input, actor);
  if (action === "publishGuestEventBills") return publishGuestEventBills(input, actor);
  if (action === "remindPayment") return remindPayment(input.invoiceId, actor);
  if (action === "previewQuarterlyInvoices") return previewQuarterlyInvoices(input, actor);
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
  if (action === "cancelEvent") return cancelEvent(input.eventId, actor);
  if (action === "confirmQuarterPlan") return confirmQuarterPlan(input, actor);
  if (action === "promoteStandby") return promoteStandby(input.eventId);
  throw new Error("不支援的操作");
}
