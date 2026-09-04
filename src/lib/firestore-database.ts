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
): Promise<EventCancellationSummary> {
  const eventSnapshot = await transaction.get(eventRef);
  if (!eventSnapshot.exists) throw new Error("找不到活動");
  const event = eventSnapshot.data()!;
  const eventDateRef = db.collection("eventDates").doc(taipeiDate(event.startsAt));

  if (event.status === "CANCELLED") {
    const dateSnapshot = await transaction.get(eventDateRef);
    if (dateSnapshot.exists) transaction.delete(eventDateRef);
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
  const paidQuarterlyInvoices = invoices.filter((document) => document.data().type === "QUARTERLY_MEMBER" && ["REPORTED", "CONFIRMED"].includes(String(document.data().status)));
  const quarterlyCreditRefs = paidQuarterlyInvoices.map((document) => db.collection("invoices").doc(`credit-${eventRef.id}-${document.data().memberId}`));
  const existingQuarterlyCredits = quarterlyCreditRefs.length > 0 ? await transaction.getAll(...quarterlyCreditRefs) : [];
  const existingCreditIds = new Set(existingQuarterlyCredits.filter((document) => document.exists).map((document) => document.id));
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
    const memberId = String(invoiceData.memberId ?? "");
    if (invoiceData.type === "QUARTERLY_MEMBER") {
      const eventIds = Array.isArray(invoiceData.eventIds) ? invoiceData.eventIds.map(String) : [];
      const eventAmounts = Array.isArray(invoiceData.eventAmounts) ? invoiceData.eventAmounts.map(Number) : [];
      const eventIndex = eventIds.indexOf(eventRef.id);
      if (eventIndex < 0) continue;
      const eventCharge = Number(eventAmounts[eventIndex] ?? invoiceData.unitAmount ?? event.memberFeeSnapshot ?? 150);
      if (invoiceData.status === "PENDING") {
        const remainingEventIds = eventIds.filter((_: string, index: number) => index !== eventIndex);
        const remainingEventAmounts = eventAmounts.filter((_: number, index: number) => index !== eventIndex);
        const previousCredit = Number(invoiceData.creditApplied ?? 0);
        const nextGross = Math.max(0, Number(invoiceData.grossAmount ?? invoiceData.amount ?? 0) - eventCharge);
        const nextCredit = Math.min(previousCredit, nextGross);
        const restoredCredit = previousCredit - nextCredit;
        const nextAmount = nextGross - nextCredit;
        if (restoredCredit > 0) creditsByMember.set(memberId, (creditsByMember.get(memberId) ?? 0) + restoredCredit);
        if (nextGross === 0) voidedInvoices += 1;
        transaction.update(invoice.ref, {
          eventIds: remainingEventIds,
          eventAmounts: remainingEventAmounts,
          grossAmount: nextGross,
          creditApplied: nextCredit,
          amount: nextAmount,
          status: nextGross === 0 ? "VOID" : nextAmount === 0 ? "CONFIRMED" : "PENDING",
          confirmedAt: nextAmount === 0 && nextGross > 0 ? now : null,
          cancellationReason: "EVENT_CANCELLED",
          updatedAt: now,
        });
      } else if (["REPORTED", "CONFIRMED"].includes(String(invoiceData.status))) {
        const creditRef = db.collection("invoices").doc(`credit-${eventRef.id}-${memberId}`);
        if (!existingCreditIds.has(creditRef.id)) {
          creditedInvoices += 1;
          creditsByMember.set(memberId, (creditsByMember.get(memberId) ?? 0) + eventCharge);
          transaction.create(creditRef, {
            id: creditRef.id,
            memberId,
            memberNameSnapshot: invoiceData.memberNameSnapshot,
            eventId: eventRef.id,
            type: "CREDIT",
            grossAmount: -eventCharge,
            creditApplied: 0,
            amount: -eventCharge,
            status: "CONFIRMED",
            periodLabel: "活動取消退回餘額",
            confirmedAt: now,
            note: `活動取消，NT$${eventCharge} 已轉入帳戶餘額`,
            createdAt: now,
            updatedAt: now,
          });
        }
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
  if (dateSnapshot.exists) transaction.delete(eventDateRef);
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
  const [eventSnapshot, announcementSnapshot, memberSnapshot, bookingSnapshot, invoiceSnapshot, restDaySnapshot, feeRateSnapshot, membershipRequestSnapshot, targetedNotificationSnapshot, broadcastNotificationSnapshot, notificationReadSnapshot, currentMemberFee, currentGuestFee] = await Promise.all([
    db.collection("events").get(),
    db.collection("announcements").get(),
    viewer ? db.collection("members").get() : Promise.resolve(null),
    viewer ? db.collectionGroup("bookings").get() : Promise.resolve(null),
    invoiceQuery ? invoiceQuery.get() : Promise.resolve(null),
    isAdmin ? db.collection("restDays").get() : Promise.resolve(null),
    isAdmin ? db.collection("feeRates").get() : Promise.resolve(null),
    membershipRequestQuery ? membershipRequestQuery.get() : Promise.resolve(null),
    targetedNotificationQuery ? targetedNotificationQuery.get() : Promise.resolve(null),
    broadcastNotificationQuery ? broadcastNotificationQuery.get() : Promise.resolve(null),
    notificationReadQuery ? notificationReadQuery.get() : Promise.resolve(null),
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

  const invoices = (invoiceSnapshot?.docs ?? [])
    .map((document) => {
      const invoice = document.data();
      const member = membersById.get(String(invoice.memberId));
      return {
        id: document.id,
        member_id: String(invoice.memberId ?? ""),
        event_id: invoice.eventId ? String(invoice.eventId) : null,
        memberName: String(invoice.memberNameSnapshot ?? member?.displayName ?? "未知使用者"),
        type: String(invoice.type ?? ""),
        gross_amount: Number(invoice.grossAmount ?? invoice.amount ?? 0),
        credit_applied: Number(invoice.creditApplied ?? 0),
        amount: Number(invoice.amount ?? 0),
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

  const restDays = (restDaySnapshot?.docs ?? [])
    .map((document) => ({ id: document.id, date: String(document.data().date ?? document.id), label: String(document.data().label ?? "") }))
    .sort((a, b) => a.date.localeCompare(b.date));
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

  return { viewer, members, events, announcements, invoices, restDays, feeRates, membershipRequests, notifications, currentFees: { member: currentMemberFee, guest: currentGuestFee } };
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
      const invoiceRef = db.collection("invoices").doc(`single-${input.eventId}-${memberSnapshot.id}`);
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
    const invoice = invoices.docs.find((document) => document.data().memberId === memberSnapshot.id);
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

async function createEvent(input: Record<string, string>) {
  const values = validatedEventInput(input);
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
    if (notificationRef) transaction.create(notificationRef, notificationData({ title: "新活動已排程", message: `${values.date} ${values.courts}；社員已預設正取，非社員可依剩餘名額報名`, type: "EVENT", tab: "活動" }));
  });
}

async function updateEvent(input: Record<string, string>) {
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

async function cancelEvent(eventId: string) {
  if (!eventId) throw new Error("缺少活動識別碼");
  const db = getAdminFirestore();
  const eventRef = db.collection("events").doc(eventId);
  return db.runTransaction((transaction) => cancelEventInTransaction(transaction, db, eventRef, "ADMIN_CANCELLED", new Date()));
}

async function addRestDay(input: Record<string, string>) {
  const date = input.date?.slice(0, 10);
  const label = input.label?.trim();
  if (!date || !label) throw new Error("請填寫休團日日期與名稱");
  const db = getAdminFirestore();
  const restDayRef = db.collection("restDays").doc(date);
  const eventDateRef = db.collection("eventDates").doc(date);
  const now = new Date();
  return db.runTransaction(async (transaction) => {
    const [restDaySnapshot, eventDateSnapshot] = await transaction.getAll(restDayRef, eventDateRef);
    if (restDaySnapshot.exists) throw new Error("這一天已經是休團日");
    let cancelledEvent: EventCancellationSummary | null = null;
    if (eventDateSnapshot.exists) {
      const eventId = String(eventDateSnapshot.data()?.eventId ?? "");
      if (eventId) cancelledEvent = await cancelEventInTransaction(transaction, db, db.collection("events").doc(eventId), "REST_DAY", now);
    }
    transaction.create(restDayRef, { id: date, date, label, createdAt: now, updatedAt: now });
    return { cancelledEvent };
  });
}

async function removeRestDay(restDayId: string) {
  if (!restDayId) throw new Error("缺少休團日識別碼");
  await getAdminFirestore().collection("restDays").doc(restDayId).delete();
}

async function generateWeeklyEvents(input: Record<string, string>) {
  const requestedWeeks = Number(input.weeks || 12);
  const regularCapacity = Number(input.regularCapacity || 10);
  const standbyCapacity = Number(input.standbyCapacity || 4);
  if (!Number.isInteger(requestedWeeks) || requestedWeeks < 1 || requestedWeeks > 16) throw new Error("建立週數必須是 1 到 16 的整數");
  if (!Number.isInteger(regularCapacity) || regularCapacity < 1 || !Number.isInteger(standbyCapacity) || standbyCapacity < 0) throw new Error("請填寫正確的正取與候補人數");
  if (regularCapacity + standbyCapacity > 100) throw new Error("單場正取與候補合計最多 100 人");
  const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const startTime = validTime.test(input.startTime || "") ? input.startTime : "19:00";
  const endTime = validTime.test(input.endTime || "") ? input.endTime : "21:00";
  if (endTime <= startTime) throw new Error("結束時間必須晚於開始時間");
  const start = new Date(`${input.startDate || new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error("請填寫正確的起始日期");
  while (start.getUTCDay() !== 5) start.setUTCDate(start.getUTCDate() + 1);

  const db = getAdminFirestore();
  let createdCount = 0;
  for (let index = 0; index < requestedWeeks; index += 1) {
    const day = new Date(start);
    day.setUTCDate(start.getUTCDate() + index * 7);
    const date = day.toISOString().slice(0, 10);
    const [restDay, eventDate] = await Promise.all([
      db.collection("restDays").doc(date).get(),
      db.collection("eventDates").doc(date).get(),
    ]);
    if (restDay.exists || eventDate.exists) continue;
    const startsAt = new Date(`${date}T${startTime}:00+08:00`).toISOString();
    const endsAt = new Date(`${date}T${endTime}:00+08:00`).toISOString();
    await createEvent({
      startsAt,
      endsAt,
      courts: input.courts?.trim() || "公司體育館 A 場",
      regularCapacity: String(regularCapacity),
      standbyCapacity: String(standbyCapacity),
      notify: "false",
    });
    createdCount += 1;
  }
  if (createdCount > 0) {
    const notificationRef = db.collection("notifications").doc();
    await notificationRef.set(notificationData({ title: "未來活動已建立", message: `新增 ${createdCount} 場週五活動，社員已預設列為正取`, type: "EVENT", tab: "活動" }));
  }
  return { createdCount };
}

function billingBoundary(value: string | undefined, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) throw new Error("請填寫正確的帳單期間");
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00"}+08:00`);
  if (Number.isNaN(date.getTime())) throw new Error("請填寫正確的帳單期間");
  return date;
}

async function createQuarterlyInvoices(input: Record<string, string>) {
  const startDate = input.startDate;
  const endDate = input.endDate;
  const startsAt = billingBoundary(startDate);
  const endsAt = billingBoundary(endDate, true);
  if (endsAt <= startsAt) throw new Error("帳單結束日期必須晚於開始日期");
  const label = input.label?.trim() || `${startDate}～${endDate}`;
  if (label.length > 60) throw new Error("帳單期間名稱不能超過 60 個字元");
  const dueAt = input.dueDate ? billingBoundary(input.dueDate, true) : null;
  const db = getAdminFirestore();
  const periodId = `quarterly-${startDate}-${endDate}`;
  const periodRef = db.collection("billingPeriods").doc(periodId);
  const [existingPeriod, eventSnapshot, memberSnapshot] = await Promise.all([
    periodRef.get(),
    db.collection("events").get(),
    db.collection("members").where("membershipStatus", "==", "MEMBER").get(),
  ]);

  if (existingPeriod.exists && existingPeriod.data()?.status === "ACTIVE") throw new Error("這個期間的社員帳單已經建立");
  const scheduledEvents = existingPeriod.exists
    ? null
    : eventSnapshot.docs
      .map((document) => {
        const event = document.data();
        return { id: document.id, startsAt: event.startsAt as StoredDate, status: String(event.status ?? "SCHEDULED"), memberFeeSnapshot: Number(event.memberFeeSnapshot ?? 150) };
      })
      .filter((event) => {
        const eventStart = dateValue(event.startsAt);
        return event.status === "SCHEDULED" && eventStart && eventStart >= startsAt && eventStart <= endsAt;
      })
      .sort((a, b) => (dateValue(a.startsAt)?.getTime() ?? 0) - (dateValue(b.startsAt)?.getTime() ?? 0));

  if (scheduledEvents && scheduledEvents.length === 0) throw new Error("這個期間沒有可計費的活動");
  const periodData = existingPeriod.data();
  const eventIds = scheduledEvents?.map((event) => event.id) ?? (Array.isArray(periodData?.eventIds) ? periodData.eventIds.map(String) : []);
  const eventAmounts = scheduledEvents?.map((event) => Number(event.memberFeeSnapshot ?? 150))
    ?? (Array.isArray(periodData?.eventAmounts) ? periodData.eventAmounts.map(Number) : []);
  const grossAmount = eventAmounts.reduce((total, amount) => total + amount, 0);
  if (eventIds.length === 0 || grossAmount <= 0) throw new Error("帳單期間資料不完整，請聯絡系統管理者");
  const now = new Date();

  if (!existingPeriod.exists) {
    await periodRef.create({
      id: periodId,
      type: "QUARTERLY_MEMBER",
      label,
      startDate,
      endDate,
      dueAt,
      eventIds,
      eventAmounts,
      eventCount: eventIds.length,
      grossAmount,
      status: "GENERATING",
      createdAt: now,
      updatedAt: now,
    });
  }

  let invoiceCount = 0;
  let totalAmount = 0;
  const members = memberSnapshot.docs;
  for (let offset = 0; offset < members.length; offset += 20) {
    const results = await Promise.all(members.slice(offset, offset + 20).map((memberDocument) => {
      const notificationRef = db.collection("notifications").doc();
      return db.runTransaction(async (transaction) => {
      const invoiceRef = db.collection("invoices").doc(`${periodId}-${memberDocument.id}`);
      const [freshMember, existingInvoice] = await transaction.getAll(memberDocument.ref, invoiceRef);
      if (!freshMember.exists) return null;
      if (existingInvoice.exists) return Number(existingInvoice.data()?.amount ?? 0);
      const member = freshMember.data()!;
      const creditApplied = Math.min(Math.max(0, Number(member.creditBalance ?? 0)), grossAmount);
      const amount = grossAmount - creditApplied;
      transaction.create(invoiceRef, {
        id: invoiceRef.id,
        memberId: memberDocument.id,
        memberNameSnapshot: String(member.displayName ?? "未知使用者"),
        eventId: null,
        eventIds,
        eventAmounts,
        type: "QUARTERLY_MEMBER",
        grossAmount,
        creditApplied,
        amount,
        unitAmount: eventAmounts.every((value) => value === eventAmounts[0]) ? eventAmounts[0] : null,
        periodId,
        periodLabel: existingPeriod.exists ? String(periodData?.label ?? label) : label,
        dueAt: existingPeriod.exists ? dateValue(periodData?.dueAt) : dueAt,
        status: amount === 0 ? "CONFIRMED" : "PENDING",
        reportedAt: null,
        confirmedAt: amount === 0 ? now : null,
        note: creditApplied > 0 ? `已使用帳戶餘額 NT$${creditApplied}` : null,
        createdAt: now,
        updatedAt: now,
      });
      if (creditApplied > 0) transaction.update(memberDocument.ref, { creditBalance: FieldValue.increment(-creditApplied), updatedAt: now });
      transaction.create(notificationRef, notificationData({
        title: "新的社員帳單",
        message: amount === 0 ? `${label} 已由帳戶餘額全額抵扣` : `${label} 應付 NT$${amount}`,
        type: "PAYMENT",
        tab: "費用管理",
        recipientId: memberDocument.id,
      }));
      return amount;
      });
    }));
    for (const amount of results) {
      if (amount !== null) {
        invoiceCount += 1;
        totalAmount += amount;
      }
    }
  }

  await periodRef.update({ status: "ACTIVE", invoiceCount, totalAmount, completedAt: new Date(), updatedAt: new Date() });
  return { invoiceCount, eventCount: eventIds.length, totalAmount, periodLabel: existingPeriod.exists ? String(periodData?.label ?? label) : label };
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
  const invoiceRef = db.collection("invoices").doc(invoiceId);
  const [invoice, administrators] = await Promise.all([
    invoiceRef.get(),
    db.collection("members").where("role", "==", "ADMIN").get(),
  ]);
  if (!invoice.exists) throw new Error("找不到帳單");
  if (actor.role !== "ADMIN" && String(invoice.data()?.memberId) !== actor.id) throw new Error("你不能更新其他人的帳單");
  if (invoice.data()?.status === "REPORTED") return;
  if (invoice.data()?.status !== "PENDING") throw new Error("這筆帳單目前無法回報轉帳");
  const now = new Date();
  const batch = db.batch();
  batch.update(invoiceRef, { status: "REPORTED", reportedAt: now, updatedAt: now });
  for (const administrator of administrators.docs) {
    const notificationRef = db.collection("notifications").doc();
    batch.set(notificationRef, notificationData({ title: "待確認轉帳", message: `${String(invoice.data()?.memberNameSnapshot ?? actor.name)} 回報已轉帳 NT$${Number(invoice.data()?.amount ?? 0).toLocaleString("zh-TW")}`, type: "PAYMENT", tab: "費用管理", recipientId: administrator.id }));
  }
  await batch.commit();
}

async function confirmPayment(invoiceId: string) {
  if (!invoiceId) throw new Error("缺少帳單識別碼");
  const invoiceRef = getAdminFirestore().collection("invoices").doc(invoiceId);
  const invoice = await invoiceRef.get();
  if (!invoice.exists) throw new Error("找不到帳單");
  if (invoice.data()?.status === "CONFIRMED") return;
  if (invoice.data()?.status !== "PENDING" && invoice.data()?.status !== "REPORTED") throw new Error("這筆帳單目前無法確認收款");
  const now = new Date();
  const db = getAdminFirestore();
  const batch = db.batch();
  batch.update(invoiceRef, { status: "CONFIRMED", confirmedAt: now, updatedAt: now });
  const memberId = String(invoice.data()?.memberId ?? "");
  if (memberId) {
    const notificationRef = db.collection("notifications").doc();
    batch.set(notificationRef, notificationData({ title: "款項已確認", message: `NT$${Number(invoice.data()?.amount ?? 0).toLocaleString("zh-TW")} 已由幹部確認收款`, type: "PAYMENT", tab: "費用管理", recipientId: memberId }));
  }
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
  if (action === "reviewMembershipRequest") return reviewMembershipRequest(input.requestId, input.decision, actor);
  if (action === "confirmPayment") return confirmPayment(input.invoiceId);
  if (action === "createQuarterlyInvoices") return createQuarterlyInvoices(input);
  if (action === "setFeeRates") return setFeeRates(input);
  if (action === "updateMember") return updateMember(input, actor);
  if (action === "issueClaimCode") return issueClaimCode(input.memberId);
  if (action === "publish") return publish(input);
  if (action === "updateAnnouncement") return updateAnnouncement(input);
  if (action === "deleteAnnouncement") return deleteAnnouncement(input.announcementId);
  if (action === "setAnnouncementPinned") return setAnnouncementPinned(input.announcementId, input.pinned);
  if (action === "createEvent") return createEvent(input);
  if (action === "updateEvent") return updateEvent(input);
  if (action === "cancelEvent") return cancelEvent(input.eventId);
  if (action === "addRestDay") return addRestDay(input);
  if (action === "removeRestDay") return removeRestDay(input.restDayId);
  if (action === "generateWeeklyEvents") return generateWeeklyEvents(input);
  if (action === "promoteStandby") return promoteStandby(input.eventId);
  throw new Error("不支援的操作");
}
