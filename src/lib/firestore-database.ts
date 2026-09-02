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
  for (const candidate of candidates) transaction.update(candidate.ref, { status: "REGULAR", promotedAt: now });
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

export async function readState(viewer: Viewer | null = null) {
  const db = getAdminFirestore();
  const isAdmin = viewer?.role === "ADMIN";
  const invoiceQuery = isAdmin
    ? db.collection("invoices")
    : viewer
      ? db.collection("invoices").where("memberId", "==", viewer.id)
      : null;
  const [eventSnapshot, announcementSnapshot, memberSnapshot, bookingSnapshot, invoiceSnapshot, restDaySnapshot, feeRateSnapshot] = await Promise.all([
    db.collection("events").get(),
    db.collection("announcements").get(),
    viewer ? db.collection("members").get() : Promise.resolve(null),
    viewer ? db.collectionGroup("bookings").get() : Promise.resolve(null),
    invoiceQuery ? invoiceQuery.get() : Promise.resolve(null),
    isAdmin ? db.collection("restDays").get() : Promise.resolve(null),
    isAdmin ? db.collection("feeRates").get() : Promise.resolve(null),
  ]);

  const memberDocuments = memberSnapshot?.docs ?? [];
  const membersById = new Map(memberDocuments.map((document) => [document.id, document.data()]));
  const members = memberDocuments
    .map((document) => {
      const member = document.data();
      return {
        id: document.id,
        name: String(member.displayName ?? ""),
        department: member.department ? String(member.department) : null,
        role: String(member.role ?? "MEMBER"),
        membershipStatus: String(member.membershipStatus ?? "GUEST"),
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

  return { viewer, members, events, announcements, invoices, restDays, feeRates };
}

async function join(input: Record<string, string>, actor: Viewer) {
  const db = getAdminFirestore();
  const memberSnapshot = await db.collection("members").doc(actor.id).get();
  if (!memberSnapshot.exists) throw new Error("找不到使用者");
  const eventRef = db.collection("events").doc(input.eventId);
  const bookingRef = eventRef.collection("bookings").doc(memberSnapshot.id);
  const member = memberSnapshot.data()!;
  const kind = member.membershipStatus === "MEMBER" ? "MEMBER" : "GUEST";
  const now = new Date();
  const guestFee = kind === "GUEST" ? await activeFee(db, "GUEST_VISIT", now) : 0;

  await db.runTransaction(async (transaction) => {
    const [eventSnapshot, bookingSnapshot] = await transaction.getAll(eventRef, bookingRef);
    if (!eventSnapshot.exists) throw new Error("找不到活動");
    const event = eventSnapshot.data()!;
    const startsAt = dateValue(event.startsAt);
    if (event.status !== "SCHEDULED" || !startsAt || startsAt <= now) throw new Error("活動已開始或已取消，無法再報名");
    if (bookingSnapshot.exists && bookingSnapshot.data()?.status !== "CANCELLED") return;

    const regularCount = Number(event.regularCount ?? 0);
    const standbyCount = Number(event.standbyCount ?? 0);
    const regularCapacity = Number(event.regularCapacity ?? 10);
    const standbyCapacity = Number(event.standbyCapacity ?? 4);
    const status = regularCount < regularCapacity ? "REGULAR" : standbyCount < standbyCapacity ? "STANDBY" : null;
    if (!status) throw new Error("本場正取與候補名額皆已額滿");

    transaction.set(bookingRef, {
      id: bookingSnapshot.data()?.id ?? `${input.eventId}-${memberSnapshot.id}`,
      eventId: input.eventId,
      memberId: memberSnapshot.id,
      displayNameSnapshot: member.displayName,
      kindSnapshot: kind,
      status,
      confirmedAt: now,
      cancelledAt: null,
      updatedAt: now,
    }, { merge: true });
    transaction.update(eventRef, {
      [status === "REGULAR" ? "regularCount" : "standbyCount"]: FieldValue.increment(1),
      updatedAt: now,
    });

    if (kind === "GUEST") {
      const invoiceRef = db.collection("invoices").doc(`single-${input.eventId}-${memberSnapshot.id}`);
      transaction.set(invoiceRef, {
        id: invoiceRef.id,
        memberId: memberSnapshot.id,
        memberNameSnapshot: member.displayName,
        eventId: input.eventId,
        type: "SINGLE_EVENT",
        amount: guestFee,
        status: "PENDING",
        periodLabel: "單次活動",
        dueAt: null,
        reportedAt: null,
        confirmedAt: null,
        note: null,
        createdAt: now,
        updatedAt: now,
      }, { merge: true });
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
      if (invoiceData.status === "PENDING") {
        transaction.update(invoice.ref, { status: "VOID", updatedAt: now });
      } else if (invoiceData.status === "REPORTED" || invoiceData.status === "CONFIRMED") {
        transaction.update(invoice.ref, { status: "CREDITED", updatedAt: now });
        transaction.update(memberRef, { creditBalance: FieldValue.increment(Number(invoiceData.amount ?? 0)), updatedAt: now });
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
  });
  return claim ? { claimCode: claim.code, recipientName } : undefined;
}

async function publish(input: Record<string, string>) {
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
  const db = getAdminFirestore();
  const announcementRef = db.collection("announcements").doc();
  await announcementRef.set({ id: announcementRef.id, title, content, linkUrl, pinned: false, publishedAt: new Date() });
}

function validatedEventInput(input: Record<string, string>) {
  if (!input.startsAt || !input.endsAt || !input.courts?.trim()) throw new Error("請填寫活動日期、時間與場地");
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);
  const regularCapacity = Number(input.regularCapacity || 10);
  const standbyCapacity = Number(input.standbyCapacity || 4);
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) throw new Error("結束時間必須晚於開始時間");
  if (!Number.isInteger(regularCapacity) || regularCapacity < 1 || !Number.isInteger(standbyCapacity) || standbyCapacity < 0) throw new Error("請填寫正確的正取與候補人數");
  return { startsAt, endsAt, courts: input.courts.trim(), regularCapacity, standbyCapacity, date: taipeiDate(startsAt) };
}

async function createEvent(input: Record<string, string>) {
  const values = validatedEventInput(input);
  const db = getAdminFirestore();
  const eventRef = db.collection("events").doc();
  const eventDateRef = db.collection("eventDates").doc(values.date);
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
      regularCount: 0,
      standbyCount: 0,
      status: "SCHEDULED",
      createdAt: now,
      updatedAt: now,
    });
    transaction.create(eventDateRef, { eventId: eventRef.id, date: values.date, createdAt: now });
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
    const newDateSnapshot = await transaction.get(newDateRef);
    if (newDateSnapshot.exists && newDateSnapshot.data()?.eventId !== input.eventId) throw new Error("這一天已有其他活動");

    const regularCount = Number(event.regularCount ?? 0);
    const standbyCount = Number(event.standbyCount ?? 0);
    if (values.regularCapacity < regularCount) throw new Error(`正取已有 ${regularCount} 人，容量不能調低於目前人數`);
    const promoted = await promoteStandbyInTransaction(transaction, eventRef, event, values.regularCapacity - regularCount, now);
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
  });
}

async function cancelEvent(eventId: string) {
  const db = getAdminFirestore();
  const eventRef = db.collection("events").doc(eventId);
  await db.runTransaction(async (transaction) => {
    const eventSnapshot = await transaction.get(eventRef);
    if (!eventSnapshot.exists) throw new Error("找不到活動");
    const dateRef = db.collection("eventDates").doc(taipeiDate(eventSnapshot.data()!.startsAt));
    await transaction.get(dateRef);
    transaction.update(eventRef, { status: "CANCELLED", updatedAt: new Date() });
    transaction.delete(dateRef);
  });
}

async function addRestDay(input: Record<string, string>) {
  const date = input.date?.slice(0, 10);
  const label = input.label?.trim();
  if (!date || !label) throw new Error("請填寫休團日日期與名稱");
  const db = getAdminFirestore();
  const restDayRef = db.collection("restDays").doc(date);
  try {
    await restDayRef.create({ id: date, date, label, createdAt: new Date() });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && Number((error as { code: number }).code) === 6) throw new Error("這一天已經是休團日");
    throw error;
  }
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
  const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const startTime = validTime.test(input.startTime || "") ? input.startTime : "19:00";
  const endTime = validTime.test(input.endTime || "") ? input.endTime : "21:00";
  if (endTime <= startTime) throw new Error("結束時間必須晚於開始時間");
  const start = new Date(`${input.startDate || new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error("請填寫正確的起始日期");
  while (start.getUTCDay() !== 5) start.setUTCDate(start.getUTCDate() + 1);

  const db = getAdminFirestore();
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
    });
  }
}

async function reportPayment(invoiceId: string, actor: Viewer) {
  if (!invoiceId) throw new Error("缺少帳單識別碼");
  const invoiceRef = getAdminFirestore().collection("invoices").doc(invoiceId);
  const invoice = await invoiceRef.get();
  if (!invoice.exists) throw new Error("找不到帳單");
  if (actor.role !== "ADMIN" && String(invoice.data()?.memberId) !== actor.id) throw new Error("你不能更新其他人的帳單");
  if (invoice.data()?.status === "VOID" || invoice.data()?.status === "CREDITED") throw new Error("這筆帳單已無需付款");
  await invoiceRef.update({ status: "REPORTED", reportedAt: new Date(), updatedAt: new Date() });
}

export async function mutate(action: string, input: Record<string, string>, actor: Viewer) {
  if (action === "join") return join(input, actor);
  if (action === "cancel") return cancel(input, actor);
  if (action === "transfer") return transfer(input, actor);
  if (action === "reportPayment") return reportPayment(input.invoiceId, actor);

  if (actor.role !== "ADMIN") throw new Error("只有幹部可以執行這項操作");
  if (action === "publish") return publish(input);
  if (action === "createEvent") return createEvent(input);
  if (action === "updateEvent") return updateEvent(input);
  if (action === "cancelEvent") return cancelEvent(input.eventId);
  if (action === "addRestDay") return addRestDay(input);
  if (action === "removeRestDay") return removeRestDay(input.restDayId);
  if (action === "generateWeeklyEvents") return generateWeeklyEvents(input);
  if (action === "promoteStandby") return promoteStandby(input.eventId);
  throw new Error("不支援的操作");
}
