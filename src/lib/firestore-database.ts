import { randomUUID } from "crypto";
import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import { getAdminFirestore } from "@/lib/firebase-admin";
import { createClaimCodeRecord, type Viewer } from "@/lib/device-auth";
import { manageInvoice, voidInvoiceBatch } from "@/lib/invoice-management";
import { validateQuarterDraft, effectiveInvoiceAmounts, reduceUnpaidInvoice, type QuarterRules, type SuggestedActivity } from "@/lib/quarter-planning";

type StoredDate = Timestamp | Date | string | null | undefined;

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


async function membersForName(db: Firestore, name: string) {
  const snapshot = await db.collection("members").where("displayName", "==", name).get();
  return snapshot.docs;
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
      if (eventIndex < 0 || !["PENDING", "REPORTED", "CONFIRMED"].includes(String(invoiceData.status))) continue;
      const eventCharge = Number(invoiceData.eventAmounts?.[eventIndex] ?? invoiceData.unitAmount ?? event.memberFeeSnapshot ?? 150);
      if (invoiceData.status === "PENDING") {
        const before = effectiveInvoiceAmounts(invoiceData);
        const reduced = reduceUnpaidInvoice(invoiceData, eventCharge);
        const { restoredCredit, ...amounts } = reduced;
        if (restoredCredit > 0) creditsByMember.set(memberId, (creditsByMember.get(memberId) ?? 0) + restoredCredit);
        transaction.update(invoice.ref, { ...amounts, status: reduced.adjustedAmount === 0 ? "CONFIRMED" : "PENDING", confirmedAt: reduced.adjustedAmount === 0 ? now : null, adjustments: FieldValue.arrayUnion({ ...adjustment, kind: "REDUCTION", amount: -eventCharge, beforeAmount: before.amount, afterAmount: reduced.adjustedAmount, restoredCredit }), updatedAt: now });
      } else {
        // A reported transfer is not settled money: wait for administrator confirmation before making this credit spendable.
        const creditRef = db.collection("invoices").doc("credit-" + eventRef.id + "-" + invoice.id);
        const settled = invoiceData.status === "CONFIRMED";
        if (settled) creditsByMember.set(memberId, (creditsByMember.get(memberId) ?? 0) + eventCharge);
        creditedInvoices += 1;
        transaction.create(creditRef, { id: creditRef.id, memberId, memberNameSnapshot: invoiceData.memberNameSnapshot, eventId: eventRef.id, relatedInvoiceId: invoice.id, type: "CREDIT", grossAmount: -eventCharge, creditApplied: 0, amount: -eventCharge, status: settled ? "CONFIRMED" : "AWAITING_PAYMENT_CONFIRMATION", periodLabel: "活動取消退回餘額", confirmedAt: settled ? now : null, note: settled ? "活動取消，已退回帳戶餘額" : "待原帳單收款確認後退回餘額", createdAt: now, updatedAt: now });
        transaction.update(invoice.ref, { adjustments: FieldValue.arrayUnion({ ...adjustment, kind: settled ? "CREDIT" : "CREDIT_PENDING", amount: -eventCharge, creditInvoiceId: creditRef.id }), updatedAt: now });
      }
      continue;
    }
    if (invoiceData.status === "PENDING") {
      voidedInvoices += 1;
      const restoredCredit = Number(invoiceData.creditApplied ?? 0);
      if (restoredCredit > 0) creditsByMember.set(memberId, (creditsByMember.get(memberId) ?? 0) + restoredCredit);
      transaction.update(invoice.ref, { status: "VOID", cancellationReason: "EVENT_CANCELLED", updatedAt: now });
    } else if (invoiceData.status === "REPORTED" || invoiceData.status === "CONFIRMED") {
      creditedInvoices += 1;
      creditsByMember.set(memberId, (creditsByMember.get(memberId) ?? 0) + Number(invoiceData.grossAmount ?? invoiceData.amount ?? 0));
      transaction.update(invoice.ref, { status: "CREDITED", cancellationReason: "EVENT_CANCELLED", updatedAt: now });
    }
  }

  for (const [memberId, amount] of creditsByMember) {
    if (memberId && amount > 0) transaction.update(db.collection("members").doc(memberId), { creditBalance: FieldValue.increment(amount), updatedAt: now });
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
    isAdmin ? db.collection("quarterPlans").get() : Promise.resolve(null),
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
      const membershipStatus = storedMembershipStatus === "EXITING" && !memberAt(member, new Date()) ? "GUEST" : storedMembershipStatus;
      const name = String(member.displayName ?? "");
      return {
        id: document.id,
        name,
        department: member.department ? String(member.department) : null,
        role: String(member.role ?? "MEMBER"),
        membershipStatus,
        creditBalance: Number(member.creditBalance ?? 0),
        primaryAdmin: Boolean(member.primaryAdmin) || name.toLocaleLowerCase("en-US") === "barryadmin",
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
      name: String(booking.displayNameSnapshot ?? member?.displayName ?? "未知使用者"),
      kind: String(booking.kindSnapshot ?? "GUEST"),
      status: String(booking.status),
      confirmedAt: iso(booking.confirmedAt),
      transferred: Boolean(booking.transferredFromMemberId),
    };
    const list = bookingsByEvent.get(eventId) ?? [];
    list.push(item);
    bookingsByEvent.set(eventId, list);
  }

  const events = eventSnapshot.docs
    .map((document) => {
      const event = document.data();
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
      return {
        id: document.id,
        member_id: String(invoice.memberId ?? ""),
        event_id: directEventId,
        event_ids: eventIds,
        event_amounts: eventIds.length ? eventIds.map((id, index) => eventSchedulesById.get(id)?.status === "CANCELLED" ? 0 : Number(invoice.eventAmounts?.[index] ?? invoice.unitAmount ?? Math.floor(effectiveInvoiceAmounts(invoice).grossAmount / eventIds.length))) : [effectiveInvoiceAmounts(invoice).grossAmount],
        event_schedules: eventIds.flatMap((eventId) => {
          const schedule = eventSchedulesById.get(eventId);
          return schedule ? [schedule] : [];
        }),
        memberName: String(invoice.memberNameSnapshot ?? member?.displayName ?? "未知使用者"),
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
        memberName: String(request.memberNameSnapshot ?? member?.displayName ?? "未知使用者"),
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
      kindSnapshot: kind,
      status,
      confirmedAt: now,
      attendanceSource: kind === "MEMBER" ? "MEMBER_REJOIN" : "SELF_REGISTERED",
      cancelledAt: null,
      updatedAt: now,
    }, { merge: true });
    transaction.update(eventRef, {
      [status === "REGULAR" ? "regularCount" : "standbyCount"]: FieldValue.increment(1),
      updatedAt: now,
    });

    if (kind === "GUEST") {
      const invoiceRef = db.collection("invoices").doc(`single-${input.eventId}-${memberSnapshot.id}-${randomUUID()}`);
      const grossAmount = Number(event.guestFeeSnapshot ?? 180);
      const creditApplied = Math.min(Math.max(0, Number(member.creditBalance ?? 0)), grossAmount);
      const amount = grossAmount - creditApplied;
      transaction.set(invoiceRef, {
        id: invoiceRef.id,
        memberId: memberSnapshot.id,
        memberNameSnapshot: member.displayName,
        eventId: input.eventId,
        type: "SINGLE_EVENT",
        grossAmount,
        creditApplied,
        amount,
        status: amount === 0 ? "CONFIRMED" : "PENDING",
        periodLabel: "單次活動",
        dueAt: null,
        reportedAt: null,
        confirmedAt: amount === 0 ? now : null,
        note: creditApplied > 0 ? `已使用帳戶餘額 NT$${creditApplied}` : null,
        createdAt: now,
        updatedAt: now,
      }, { merge: true });
      if (creditApplied > 0) transaction.update(memberSnapshot.ref, { creditBalance: FieldValue.increment(-creditApplied), updatedAt: now });
    }
  });
}

async function cancel(input: Record<string, string>, actor: Viewer) {
  const db = getAdminFirestore();
  const memberSnapshot = await db.collection("members").doc(actor.id).get();
  if (!memberSnapshot.exists) throw new Error("找不到使用者");
  const eventRef = db.collection("events").doc(input.eventId);
  const bookingRef = eventRef.collection("bookings").doc(memberSnapshot.id);
  const memberRef = memberSnapshot.ref;
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const [eventSnapshot, bookingSnapshot] = await transaction.getAll(eventRef, bookingRef);
    if (!eventSnapshot.exists || !bookingSnapshot.exists) throw new Error("找不到可取消的報名");
    const event = eventSnapshot.data()!;
    const booking = bookingSnapshot.data()!;
    if (booking.status !== "REGULAR" && booking.status !== "STANDBY") return;

    const invoices = await transaction.get(db.collection("invoices").where("eventId", "==", input.eventId));
    const invoice = invoices.docs.find((document) => document.data().memberId === memberSnapshot.id && ["SINGLE_EVENT", "MEMBER_EXTRA"].includes(document.data().type) && ["PENDING", "REPORTED", "CONFIRMED"].includes(document.data().status));
    const beforeStart = (dateValue(event.startsAt)?.getTime() ?? 0) > now.getTime();
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

    if (beforeStart && invoice) {
      const invoiceData = invoice.data();
      const creditApplied = Number(invoiceData.creditApplied ?? 0);
      if (invoiceData.status === "PENDING") {
        transaction.update(invoice.ref, { status: "VOID", updatedAt: now });
        if (creditApplied > 0) transaction.update(memberRef, { creditBalance: FieldValue.increment(creditApplied), updatedAt: now });
      } else if (invoiceData.status === "REPORTED" || invoiceData.status === "CONFIRMED") {
        transaction.update(invoice.ref, { status: "CREDITED", updatedAt: now });
        transaction.update(memberRef, { creditBalance: FieldValue.increment(Number(invoiceData.grossAmount ?? invoiceData.amount ?? 0)), updatedAt: now });
      }
    }
  });
}

async function transfer(input: Record<string, string>, actor: Viewer) {
  const db = getAdminFirestore();
  const recipientName = input.recipient?.trim();
  if (!recipientName) throw new Error("請填寫接手者名稱");
  const sourceSnapshot = await db.collection("members").doc(actor.id).get();
  if (!sourceSnapshot.exists) throw new Error("找不到轉讓者");
  const matchingRecipients = (await membersForName(db, recipientName)).filter((document) => document.id !== actor.id);
  if (matchingRecipients.length > 1) throw new Error("有多位同名使用者，請由幹部協助確認接手帳號");

  const recipientRef = matchingRecipients[0]?.ref ?? db.collection("members").doc(randomUUID());
  const recipientData = matchingRecipients[0]?.data() ?? null;
  const claim = recipientData ? null : createClaimCodeRecord();

  const eventRef = db.collection("events").doc(input.eventId);
  const sourceBookingRef = eventRef.collection("bookings").doc(sourceSnapshot.id);
  const recipientBookingRef = eventRef.collection("bookings").doc(recipientRef.id);
  const transferRef = db.collection("transfers").doc(`transfer-${input.eventId}-${sourceSnapshot.id}`);
  const notificationRef = db.collection("notifications").doc();
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const [eventSnapshot, sourceBookingSnapshot, recipientBookingSnapshot] = await transaction.getAll(eventRef, sourceBookingRef, recipientBookingRef);
    if (!eventSnapshot.exists) throw new Error("找不到活動");
    const event = eventSnapshot.data()!;
    const startsAt = dateValue(event.startsAt);
    if (event.status !== "SCHEDULED" || !startsAt || startsAt <= now) throw new Error("活動已開始或已取消，無法轉讓");
    if (!sourceBookingSnapshot.exists || !["REGULAR", "STANDBY"].includes(String(sourceBookingSnapshot.data()?.status))) throw new Error("沒有可轉讓的名額");
    if (recipientBookingSnapshot.exists && recipientBookingSnapshot.data()?.status !== "CANCELLED") throw new Error("接手者已在本次活動名單中");
    const sourceBooking = sourceBookingSnapshot.data()!;

    if (!recipientData && claim) {
      transaction.create(recipientRef, {
        id: recipientRef.id,
        displayName: recipientName,
        department: null,
        role: "MEMBER",
        membershipStatus: "GUEST",
        accountType: "unclaimed",
        joinedAt: null,
        endingAt: null,
        creditBalance: 0,
        claimCodeSalt: claim.salt,
        claimCodeHash: claim.hash,
        claimCodeCreatedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }

    transaction.set(recipientBookingRef, {
      id: recipientBookingSnapshot.data()?.id ?? `${input.eventId}-${recipientRef.id}`,
      eventId: input.eventId,
      memberId: recipientRef.id,
      displayNameSnapshot: recipientName,
      kindSnapshot: "GUEST",
      status: sourceBooking.status,
      confirmedAt: now,
      cancelledAt: null,
      transferredFromMemberId: sourceSnapshot.id,
      updatedAt: now,
    }, { merge: true });
    transaction.update(sourceBookingRef, { status: "TRANSFERRED", transferredAt: now, updatedAt: now });
    transaction.set(transferRef, {
      id: transferRef.id,
      eventId: input.eventId,
      sourceBookingId: String(sourceBooking.id ?? sourceBookingRef.id),
      sourceMemberId: sourceSnapshot.id,
      recipientId: recipientRef.id,
      settlement: "CONFIRMED",
      createdAt: now,
      updatedAt: now,
    }, { merge: true });
    transaction.create(notificationRef, notificationData({ title: "收到活動名額", message: `${actor.name} 已將 ${taipeiDate(event.startsAt)} 的活動名額轉讓給你，費用請私下結清`, type: "TRANSFER", tab: "活動", recipientId: recipientRef.id }));
  });
  return claim ? { claimCode: claim.code, recipientName } : undefined;
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


function parseQuarterDraft(input: Record<string, string>) {
  let parsed: { rules: QuarterRules; activities: SuggestedActivity[] };
  try { parsed = JSON.parse(input.draft || ""); } catch { throw new Error("季度草稿格式不正確"); }
  validateQuarterDraft(parsed.rules, parsed.activities);
  const rules: QuarterRules = {
    label: parsed.rules.label.trim(), startDate: parsed.rules.startDate, endDate: parsed.rules.endDate,
    weekday: parsed.rules.weekday, startTime: parsed.rules.startTime, endTime: parsed.rules.endTime,
    courts: parsed.rules.courts.trim(), regularCapacity: parsed.rules.regularCapacity, standbyCapacity: parsed.rules.standbyCapacity,
    excludedDates: [...new Set(parsed.rules.excludedDates)].sort(), excludeWeekends: parsed.rules.excludeWeekends === true,
  };
  const activities = parsed.activities.map((entry) => ({
    date: entry.date, startTime: entry.startTime, endTime: entry.endTime, courts: entry.courts.trim(),
    regularCapacity: entry.regularCapacity, standbyCapacity: entry.standbyCapacity,
  })).sort((a, b) => a.date.localeCompare(b.date));
  return { rules, activities };
}

async function saveQuarterDraft(input: Record<string, string>, actor: Viewer) {
  const values = parseQuarterDraft(input);
  const db = getAdminFirestore();
  const id = input.planId || randomUUID();
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("季度識別碼不正確");
  const ref = db.collection("quarterPlans").doc(id);
  return db.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists && existing.data()?.status !== "DRAFT") throw new Error("已確認季度不能覆寫，請使用活動或帳單調整");
    if (existing.exists && Number(input.revision) !== Number(existing.data()?.revision)) throw new Error("草稿已由其他幹部修改，請關閉視窗並重新開啟");
    const revision = Number(existing.data()?.revision ?? 0) + 1;
    transaction.set(ref, { id, ...values.rules, activities: values.activities, status: "DRAFT", revision, updatedBy: actor.id, updatedAt: new Date(), ...(!existing.exists ? { createdAt: new Date() } : {}) }, { merge: true });
    return { planId: id, revision };
  });
}

async function confirmQuarterPlan(input: Record<string, string>, actor: Viewer) {
  const db = getAdminFirestore();
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(input.planId ?? "")) throw new Error("請先儲存季度草稿");
  const planRef = db.collection("quarterPlans").doc(input.planId);
  return db.runTransaction(async (transaction) => {
    const planSnapshot = await transaction.get(planRef);
    if (!planSnapshot.exists) throw new Error("找不到季度草稿");
    const plan = planSnapshot.data()!;
    if (plan.status === "CONFIRMED") return { eventCount: Number(plan.eventCount), totalAmount: Number(plan.grossAmount), planId: planRef.id };
    if (Number(input.revision) !== Number(plan.revision)) throw new Error("草稿版本已變更，請重新檢查場次");
    validateQuarterDraft(plan as QuarterRules, plan.activities);
    const activities = plan.activities as SuggestedActivity[];
    if (!activities.length) throw new Error("至少保留一場活動才能確認季度");
    const now = new Date();
    if (activities.some((entry) => new Date(entry.date + "T" + entry.startTime + ":00+08:00") <= now)) throw new Error("建議場次包含已開始的日期，請先調整");
    const [periods, members, rates, dates] = await Promise.all([
      transaction.get(db.collection("billingPeriods")),
      transaction.get(db.collection("members")),
      transaction.get(db.collection("feeRates")),
      transaction.getAll(...activities.map((entry) => db.collection("eventDates").doc(entry.date))),
    ]);
    if (periods.docs.some((doc) => String(doc.data().startDate) <= plan.endDate && String(doc.data().endDate) >= plan.startDate)) throw new Error("此季度與既有計費期間重疊，請調整日期範圍");
    const conflicts = dates.filter((doc) => doc.exists).map((doc) => doc.id);
    if (conflicts.length) throw new Error("以下日期已有活動，請先調整建議場次：" + conflicts.join("、"));
    const rateFor = (kind: string, startsAt: Date) => {
      const rate = rates.docs.map((doc) => doc.data()).filter((rate) => rate.kind === kind && (!dateValue(rate.effectiveFrom) || dateValue(rate.effectiveFrom)! <= startsAt) && (!dateValue(rate.effectiveTo) || dateValue(rate.effectiveTo)! > startsAt))
        .sort((a, b) => (dateValue(b.effectiveFrom)?.getTime() ?? 0) - (dateValue(a.effectiveFrom)?.getTime() ?? 0))[0];
      return Number(rate?.amount ?? (kind === "MEMBER_VISIT" ? 150 : 180));
    };
    const snapshots = activities.map((entry, index) => {
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
    transaction.update(planRef, { status: "CONFIRMED", eventIds, eventAmounts, eventCount: eventIds.length, grossAmount, periodId, confirmedBy: actor.id, confirmedAt: now, updatedAt: now });
    transaction.create(db.collection("notifications").doc(), notificationData({ title: "季度活動已確認", message: plan.label + " 共 " + eventIds.length + " 場；社員已預設參加，季度計費基準已保存", type: "EVENT", tab: "活動" }));
    return { planId: planRef.id, eventCount: eventIds.length, totalAmount: grossAmount };
  });
}

function billingBoundary(value: string | undefined, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) throw new Error("請填寫正確的帳單期間");
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}+08:00`);
  if (Number.isNaN(date.getTime())) throw new Error("請填寫正確的帳單期間");
  return date;
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
    const members = await transaction.get(db.collection("members"));
    const eligibleMembers = members.docs.filter((member) => memberAt(member.data(), now));
    if (!eligibleMembers.length) throw new Error("目前沒有可開單社員");
    transaction.update(periodRef, { status: "GENERATING", recipientIds: eligibleMembers.map((member) => member.id), dueAt, generatedBy: actor.id, updatedAt: now });
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
      const eventIds = basis.eventIds as string[];
      const eventAmounts = basis.eventAmounts as number[];
      const events = await transaction.getAll(...eventIds.map((id) => db.collection("events").doc(id)));
      const grossAmount = Number(basis.grossAmount);
      const creditApplied = Math.min(Math.max(0, Number(member.creditBalance ?? 0)), grossAmount);
      const amount = grossAmount - creditApplied;
      const cancellations = events.map((event, index) => ({ event, amount: eventAmounts[index] })).filter(({ event }) => event.data()?.status === "CANCELLED");
      let effective = { grossAmount, creditApplied, amount };
      let restoredCredit = 0;
      const adjustments = cancellations.map(({ event, amount: eventAmount }) => {
        const reduced = reduceUnpaidInvoice(effective, eventAmount);
        const record = { kind: "REDUCTION", eventId: event.id, eventDate: taipeiDate(event.data()?.startsAt), reason: "確認季度後、開單前活動取消", amount: -eventAmount, beforeAmount: effective.amount, afterAmount: reduced.adjustedAmount, restoredCredit: reduced.restoredCredit, actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() };
        restoredCredit += reduced.restoredCredit;
        effective = { grossAmount: reduced.adjustedGrossAmount, creditApplied: reduced.adjustedCreditApplied, amount: reduced.adjustedAmount };
        return record;
      });
      transaction.create(invoiceRef, { id: invoiceRef.id, memberId, memberNameSnapshot: String(member.displayName), eventId: null, eventIds, eventAmounts, eventSnapshots: basis.eventSnapshots, baselineEventCount: eventIds.length, type: "QUARTERLY_MEMBER", grossAmount, creditApplied, amount, ...(adjustments.length ? { adjustedGrossAmount: effective.grossAmount, adjustedCreditApplied: effective.creditApplied, adjustedAmount: effective.amount } : {}), adjustments, unitAmount: eventAmounts.every((value) => value === eventAmounts[0]) ? eventAmounts[0] : null, periodId: periodRef.id, periodLabel: basis.label, dueAt: basis.dueAt, status: effective.amount === 0 ? "CONFIRMED" : "PENDING", reportedAt: null, confirmedAt: effective.amount === 0 ? now : null, createdAt: now, updatedAt: now });
      if (creditApplied - restoredCredit > 0) transaction.update(memberRef, { creditBalance: FieldValue.increment(-(creditApplied - restoredCredit)), updatedAt: now });
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
    const credits = await transaction.get(db.collection("invoices").where("relatedInvoiceId", "==", invoiceId));
    const pending = credits.docs.filter((doc) => doc.data().status === "AWAITING_PAYMENT_CONFIRMATION");
    const amount = pending.reduce((sum, doc) => sum - Number(doc.data().amount), 0);
    const now = new Date();
    transaction.update(invoiceRef, { status: "CONFIRMED", confirmedAt: now, confirmedBy: actor.id, updatedAt: now, ...(pending.length ? { adjustments: FieldValue.arrayUnion({ kind: "CREDIT_RELEASED", reason: "收款確認，取消活動費退回帳戶餘額", amount: -amount, actorId: actor.id, actorName: actor.name, createdAt: now.toISOString() }) } : {}) });
    for (const credit of pending) transaction.update(credit.ref, { status: "CONFIRMED", confirmedAt: now, updatedAt: now });
    if (amount > 0) transaction.update(db.collection("members").doc(String(data.memberId)), { creditBalance: FieldValue.increment(amount), updatedAt: now });
    transaction.create(db.collection("notifications").doc(), notificationData({ title: "款項已確認", message: "NT$" + effectiveInvoiceAmounts(data).amount + " 已確認收款" + (amount > 0 ? "；取消活動費 NT$" + amount + " 已退回帳戶餘額" : ""), type: "PAYMENT", tab: "費用管理", recipientId: String(data.memberId) }));
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
    message: `${periodLabel} 尚有 NT$${amount.toLocaleString("zh-TW")} 未繳，請完成轉帳後至費用管理點選「我已轉帳」。`,
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
      return period.status === "ACTIVE" && String(period.startDate ?? "") <= date && String(period.endDate ?? "") >= date;
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
  const periods = await db.collection("billingPeriods").get();
  const periodDocument = currentBillingPeriod(periods.docs, now);
  const period = periodDocument?.data();
  let proratedGross = 0;
  const proratedEventIds: string[] = [];
  const proratedEventAmounts: number[] = [];
  if (decision === "APPROVE" && kind === "JOIN" && periodDocument) {
    const eventIds = Array.isArray(period?.eventIds) ? period.eventIds.map(String) : [];
    const eventAmounts = Array.isArray(period?.eventAmounts) ? period.eventAmounts.map(Number) : [];
    if (eventIds.length > 0) {
      const eventSnapshots = await db.getAll(...eventIds.map((eventId) => db.collection("events").doc(eventId)));
      eventSnapshots.forEach((eventSnapshot, index) => {
        const event = eventSnapshot.data();
        const startsAt = dateValue(event?.startsAt);
        if (eventSnapshot.exists && event?.status === "SCHEDULED" && startsAt && startsAt > now) {
          const amount = Number(eventAmounts[index] ?? event.memberFeeSnapshot ?? 150);
          proratedEventIds.push(eventSnapshot.id);
          proratedEventAmounts.push(amount);
          proratedGross += amount;
        }
      });
    }
  }

  const memberRef = db.collection("members").doc(memberId);
  const lockRef = db.collection("membershipRequestLocks").doc(memberId);
  const invoiceRef = periodDocument ? db.collection("invoices").doc(`membership-${periodDocument.id}-${memberId}`) : null;
  const notificationRef = db.collection("notifications").doc();
  const result = await db.runTransaction(async (transaction) => {
    const references = invoiceRef ? [requestRef, memberRef, lockRef, invoiceRef] : [requestRef, memberRef, lockRef];
    const snapshots = await transaction.getAll(...references);
    const freshRequest = snapshots[0];
    const freshMember = snapshots[1];
    const lock = snapshots[2];
    const existingInvoice = invoiceRef ? snapshots[3] : null;
    if (!freshRequest.exists || freshRequest.data()?.status !== "PENDING") return { amount: 0, joined: false };
    if (!freshMember.exists) throw new Error("找不到申請人");
    if (decision === "REJECT") {
      transaction.update(requestRef, { status: "REJECTED", reviewedAt: now, reviewedBy: actor.id, updatedAt: now });
      if (lock.exists && lock.data()?.requestId === requestId) transaction.delete(lockRef);
      transaction.create(notificationRef, notificationData({ title: "社員申請結果", message: `你的${kind === "JOIN" ? "加入" : "退出"}社員申請未獲核准`, type: "MEMBERSHIP", tab: "個人資訊", recipientId: memberId }));
      return { amount: 0, joined: false };
    }

    const member = freshMember.data()!;
    if (kind === "JOIN") {
      const creditApplied = Math.min(Math.max(0, Number(member.creditBalance ?? 0)), proratedGross);
      const amount = proratedGross - creditApplied;
      transaction.update(memberRef, {
        membershipStatus: "MEMBER",
        memberSince: now,
        endingAt: null,
        creditBalance: FieldValue.increment(-creditApplied),
        updatedAt: now,
      });
      if (invoiceRef && proratedGross > 0 && !existingInvoice?.exists) {
        transaction.create(invoiceRef, {
          id: invoiceRef.id,
          memberId,
          memberNameSnapshot: String(member.displayName ?? freshRequest.data()?.memberNameSnapshot ?? "未知使用者"),
          eventId: null,
          eventIds: proratedEventIds,
          eventAmounts: proratedEventAmounts,
          type: "MEMBERSHIP_PRORATED",
          grossAmount: proratedGross,
          creditApplied,
          amount,
          periodId: periodDocument.id,
          periodLabel: `${String(period?.label ?? "本期社員費")}（中途加入）`,
          dueAt: period?.dueAt ?? null,
          status: amount === 0 ? "CONFIRMED" : "PENDING",
          reportedAt: null,
          confirmedAt: amount === 0 ? now : null,
          note: "依核准後剩餘活動場次計費",
          createdAt: now,
          updatedAt: now,
        });
      }
      transaction.update(requestRef, { status: "APPROVED", reviewedAt: now, reviewedBy: actor.id, proratedAmount: amount, updatedAt: now });
      if (lock.exists && lock.data()?.requestId === requestId) transaction.delete(lockRef);
      transaction.create(notificationRef, notificationData({ title: "已加入社員", message: amount > 0 ? `申請已核准，本期應付 NT$${amount}` : "申請已核准，社員身分已立即生效", type: "MEMBERSHIP", tab: amount > 0 ? "費用管理" : "個人資訊", recipientId: memberId }));
      return { amount, joined: true };
    }

    const endingAt = periodDocument ? billingBoundary(String(period?.endDate), true) : now;
    transaction.update(memberRef, {
      membershipStatus: periodDocument ? "EXITING" : "GUEST",
      endingAt: periodDocument ? endingAt : null,
      updatedAt: now,
    });
    transaction.update(requestRef, { status: "APPROVED", reviewedAt: now, reviewedBy: actor.id, effectiveAt: endingAt, updatedAt: now });
    if (lock.exists && lock.data()?.requestId === requestId) transaction.delete(lockRef);
    transaction.create(notificationRef, notificationData({ title: "退出申請已核准", message: periodDocument ? `社員身分將維持至 ${String(period?.endDate)}` : "社員身分已結束", type: "MEMBERSHIP", tab: "個人資訊", recipientId: memberId }));
    return { amount: 0, endingAt: endingAt.toISOString(), joined: false };
  });
  if (result.joined) await ensureMemberFutureBookings(memberId);
  return result;
}

async function updateMember(input: Record<string, string>, actor: Viewer) {
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
    const [memberSnapshot, adminSnapshot] = await Promise.all([transaction.get(memberRef), transaction.get(adminQuery)]);
    if (!memberSnapshot.exists) throw new Error("找不到使用者");
    const member = memberSnapshot.data()!;
    const isPrimaryAdmin = Boolean(member.primaryAdmin) || String(member.displayName ?? "").toLocaleLowerCase("en-US") === "barryadmin";
    const isDemotion = member.role === "ADMIN" && role !== "ADMIN";
    if (isPrimaryAdmin && isDemotion) throw new Error("BarryAdmin 是主要幹部，不能降為一般使用者");
    if (actor.id === memberId && isDemotion) throw new Error("不能取消自己的幹部權限");
    if (isDemotion && adminSnapshot.size <= 1) throw new Error("系統至少需要保留一位幹部");
    const currentBalance = Number(member.creditBalance ?? 0);
    const nextBalance = currentBalance + balanceAdjustment;
    if (nextBalance < 0) throw new Error("帳戶餘額不足，無法套用這筆扣除");
    if (membershipStatus === "EXITING" && !member.endingAt) throw new Error("只有已排定期末退出的使用者可以保留此狀態");

    transaction.update(memberRef, {
      department,
      role,
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

async function issueClaimCode(memberId: string) {
  if (!memberId) throw new Error("缺少使用者識別碼");
  const db = getAdminFirestore();
  const memberRef = db.collection("members").doc(memberId);
  const member = await memberRef.get();
  if (!member.exists) throw new Error("找不到使用者");
  const claim = createClaimCodeRecord();
  await memberRef.update({
    claimCodeSalt: claim.salt,
    claimCodeHash: claim.hash,
    claimCodeCreatedAt: new Date(),
    updatedAt: new Date(),
  });
  return { claimCode: claim.code, recipientName: String(member.data()?.displayName ?? "使用者") };
}

export async function mutate(action: string, input: Record<string, string>, actor: Viewer) {
  if (action === "join") return join(input, actor);
  if (action === "cancel") return cancel(input, actor);
  if (action === "transfer") return transfer(input, actor);
  if (action === "reportPayment") return reportPayment(input.invoiceId, actor);
  if (action === "requestMembershipChange") return requestMembershipChange(input.kind, actor);
  if (action === "markNotificationsRead") return markNotificationsRead(input, actor);

  if (actor.role !== "ADMIN") throw new Error("只有幹部可以執行這項操作");
  if (["voidInvoice", "reissueInvoice", "refundInvoice", "rejectPaymentReport"].includes(action)) return manageInvoice(action, input, actor);
  if (action === "voidInvoiceBatch") return voidInvoiceBatch(input, actor);
  if (action === "reviewMembershipRequest") return reviewMembershipRequest(input.requestId, input.decision, actor);
  if (action === "confirmPayment") return confirmPayment(input.invoiceId, actor);
  if (action === "remindPayment") return remindPayment(input.invoiceId, actor);
  if (action === "createQuarterlyInvoices") return createQuarterlyInvoices(input, actor);
  if (action === "setFeeRates") return setFeeRates(input);
  if (action === "updateMember") return updateMember(input, actor);
  if (action === "issueClaimCode") return issueClaimCode(input.memberId);
  if (action === "publish") return publish(input);
  if (action === "updateAnnouncement") return updateAnnouncement(input);
  if (action === "deleteAnnouncement") return deleteAnnouncement(input.announcementId);
  if (action === "setAnnouncementPinned") return setAnnouncementPinned(input.announcementId, input.pinned);
  if (action === "createEvent") return createEvent(input, actor);
  if (action === "updateEvent") return updateEvent(input, actor);
  if (action === "cancelEvent") return cancelEvent(input.eventId, actor);
  if (action === "saveQuarterDraft") return saveQuarterDraft(input, actor);
  if (action === "confirmQuarterPlan") return confirmQuarterPlan(input, actor);
  if (action === "promoteStandby") return promoteStandby(input.eventId);
  throw new Error("不支援的操作");
}
