import path from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { createClient } from "@libsql/client";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import nextEnv from "@next/env";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function optionalDate(value) {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function taipeiDate(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(String(value)));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function createClaimCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(16);
  const characters = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
  const code = [characters.slice(0, 4), characters.slice(4, 8), characters.slice(8, 12), characters.slice(12, 16)]
    .map((group) => group.join(""))
    .join("-");
  const salt = randomBytes(16).toString("hex");
  const normalized = code.replaceAll("-", "");
  return { code, salt, hash: scryptSync(normalized, salt, 32).toString("hex") };
}

const projectId = required("FIREBASE_PROJECT_ID");
const clientEmail = required("FIREBASE_CLIENT_EMAIL");
const privateKey = required("FIREBASE_PRIVATE_KEY").replace(/^['"]|['"]$/g, "").replace(/\\n/g, "\n");
const databaseId = process.env.FIREBASE_DATABASE_ID?.trim() || "(default)";
const app = getApps()[0] ?? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
const firestore = databaseId === "(default)" ? getFirestore(app) : getFirestore(app, databaseId);
const migrationCollections = ["members", "events", "invoices", "transfers", "announcements", "restDays", "feeRates", "eventDates"];
const collectionChecks = await Promise.all(migrationCollections.map(async (name) => ({
  name,
  hasData: !(await firestore.collection(name).limit(1).get()).empty,
})));
const nonEmptyCollections = collectionChecks.filter((item) => item.hasData).map((item) => item.name);

if (process.argv.includes("--check")) {
  console.log(JSON.stringify({ connected: true, databaseId, nonEmptyCollections }, null, 2));
  process.exit(0);
}

if (!process.argv.includes("--write")) {
  throw new Error("This command writes to Firestore. Run the package script with the explicit --write flag.");
}

const existingMigration = await firestore.collection("system").doc("migration-sqlite-v1").get();
if (existingMigration.exists) throw new Error("SQLite migration has already completed; refusing to overwrite Firestore data.");
if (nonEmptyCollections.length > 0) {
  throw new Error(`Firestore is not empty (${nonEmptyCollections.join(", ")}); refusing to mix or overwrite existing data.`);
}

const sqlitePath = path.join(process.cwd(), "data", "badminton.sqlite").replace(/\\/g, "/");
const sqlite = createClient({ url: `file:${sqlitePath}` });
const select = async (sql, args = []) => (await sqlite.execute({ sql, args })).rows.map((row) => ({ ...row }));
const now = new Date();

const [members, events, bookings, invoices, transfers, announcements, restDays, feeRates] = await Promise.all([
  select("SELECT * FROM members"),
  select("SELECT * FROM club_events"),
  select("SELECT * FROM bookings"),
  select("SELECT * FROM invoices"),
  select("SELECT * FROM transfers"),
  select("SELECT * FROM announcements"),
  select("SELECT * FROM rest_days"),
  select("SELECT * FROM fee_rates"),
]);

const memberNames = new Map(members.map((member) => [String(member.id), String(member.display_name)]));
const memberClaimCodes = new Map(members.map((member) => [String(member.id), createClaimCode()]));
const operations = [];
const put = (ref, data) => operations.push({ ref, data });

for (const member of members) {
  const memberId = String(member.id);
  const claim = memberClaimCodes.get(memberId);
  put(firestore.collection("members").doc(memberId), {
  id: memberId,
  displayName: String(member.display_name),
  department: member.department ? String(member.department) : null,
  role: String(member.role ?? "MEMBER"),
  membershipStatus: String(member.membership_status ?? "GUEST"),
  joinedAt: optionalDate(member.joined_at),
  endingAt: optionalDate(member.ending_at),
  creditBalance: Number(member.credit_balance ?? 0),
  accountType: "unclaimed",
  claimCodeSalt: claim.salt,
  claimCodeHash: claim.hash,
  claimCodeCreatedAt: now,
  createdAt: optionalDate(member.created_at) ?? now,
  updatedAt: now,
});
}

for (const event of events) {
  const eventId = String(event.id);
  const eventBookings = bookings.filter((booking) => String(booking.event_id) === eventId);
  const regularCount = eventBookings.filter((booking) => booking.status === "REGULAR").length;
  const standbyCount = eventBookings.filter((booking) => booking.status === "STANDBY").length;
  put(firestore.collection("events").doc(eventId), {
    id: eventId,
    startsAt: optionalDate(event.starts_at),
    endsAt: optionalDate(event.ends_at),
    courts: String(event.courts),
    regularCapacity: Number(event.regular_capacity ?? 10),
    standbyCapacity: Number(event.standby_capacity ?? 4),
    regularCount,
    standbyCount,
    status: String(event.status ?? "SCHEDULED"),
    createdAt: optionalDate(event.created_at) ?? now,
    updatedAt: now,
  });
  if (event.status === "SCHEDULED") {
    const date = taipeiDate(event.starts_at);
    put(firestore.collection("eventDates").doc(date), { eventId, date, updatedAt: now });
  }
}

for (const booking of bookings) {
  const eventId = String(booking.event_id);
  const memberId = String(booking.member_id);
  put(firestore.collection("events").doc(eventId).collection("bookings").doc(memberId), {
    id: String(booking.id),
    eventId,
    memberId,
    displayNameSnapshot: memberNames.get(memberId) ?? "未知使用者",
    kindSnapshot: String(booking.kind_snapshot),
    status: String(booking.status),
    confirmedAt: optionalDate(booking.confirmed_at) ?? now,
    cancelledAt: optionalDate(booking.cancelled_at),
    updatedAt: now,
  });
}

for (const invoice of invoices) {
  const memberId = String(invoice.member_id);
  put(firestore.collection("invoices").doc(String(invoice.id)), {
    id: String(invoice.id),
    memberId,
    memberNameSnapshot: memberNames.get(memberId) ?? "未知使用者",
    eventId: invoice.event_id ? String(invoice.event_id) : null,
    type: String(invoice.type),
    amount: Number(invoice.amount),
    status: String(invoice.status),
    periodLabel: invoice.period_label ? String(invoice.period_label) : null,
    dueAt: optionalDate(invoice.due_at),
    reportedAt: optionalDate(invoice.reported_at),
    confirmedAt: optionalDate(invoice.confirmed_at),
    note: invoice.note ? String(invoice.note) : null,
    createdAt: optionalDate(invoice.created_at) ?? now,
    updatedAt: now,
  });
}

for (const transfer of transfers) put(firestore.collection("transfers").doc(String(transfer.id)), {
  id: String(transfer.id),
  eventId: String(transfer.event_id),
  sourceBookingId: String(transfer.source_booking_id),
  sourceMemberId: String(transfer.source_member_id),
  recipientId: String(transfer.recipient_id),
  settlement: String(transfer.settlement ?? "PENDING"),
  createdAt: optionalDate(transfer.created_at) ?? now,
  updatedAt: now,
});

for (const announcement of announcements) put(firestore.collection("announcements").doc(String(announcement.id)), {
  id: String(announcement.id),
  title: String(announcement.title),
  content: String(announcement.content),
  linkUrl: announcement.link_url ? String(announcement.link_url) : null,
  pinned: Boolean(announcement.pinned),
  publishedAt: optionalDate(announcement.published_at) ?? now,
});

for (const restDay of restDays) {
  const date = String(restDay.date).slice(0, 10);
  put(firestore.collection("restDays").doc(date), { id: date, date, label: String(restDay.label), updatedAt: now });
}

for (const feeRate of feeRates) put(firestore.collection("feeRates").doc(String(feeRate.id)), {
  id: String(feeRate.id),
  kind: String(feeRate.kind),
  amount: Number(feeRate.amount),
  effectiveFrom: optionalDate(feeRate.effective_from),
  effectiveTo: optionalDate(feeRate.effective_to),
  updatedAt: now,
});

put(firestore.collection("system").doc("migration-sqlite-v1"), {
  completedAt: now,
  source: "data/badminton.sqlite",
  counts: { members: members.length, events: events.length, bookings: bookings.length, invoices: invoices.length, transfers: transfers.length, announcements: announcements.length, restDays: restDays.length, feeRates: feeRates.length },
});

for (let offset = 0; offset < operations.length; offset += 400) {
  const batch = firestore.batch();
  for (const operation of operations.slice(offset, offset + 400)) batch.set(operation.ref, operation.data);
  await batch.commit();
}

await sqlite.close();
console.log(JSON.stringify({ databaseId, writtenDocuments: operations.length, members: members.length, events: events.length, bookings: bookings.length, invoices: invoices.length, transfers: transfers.length, announcements: announcements.length, restDays: restDays.length, feeRates: feeRates.length }, null, 2));
console.log("\nOne-time account claim codes (store securely; Firestore contains hashes only):");
for (const member of members) {
  console.log(`${String(member.display_name)}\t${memberClaimCodes.get(String(member.id)).code}`);
}
