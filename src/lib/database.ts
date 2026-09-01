import fs from "fs";
import path from "path";
import initSqlJs, { Database, SqlValue } from "sql.js";

const dbPath = path.join(process.cwd(), "data", "badminton.sqlite");
let databasePromise: Promise<Database> | undefined;

function id() { return crypto.randomUUID(); }

function rows(db: Database, sql: string, params: SqlValue[] = []) {
  const statement = db.prepare(sql);
  statement.bind(params);
  const result: Record<string, SqlValue>[] = [];
  while (statement.step()) result.push(statement.getAsObject() as Record<string, SqlValue>);
  statement.free();
  return result;
}

function promoteStandby(db: Database, eventId: string, now: string) {
  const event = rows(db, "SELECT starts_at, regular_capacity, status FROM club_events WHERE id = ?", [eventId])[0];
  if (!event || event.status !== "SCHEDULED" || new Date(String(event.starts_at)) <= new Date(now)) return false;
  const regularCount = Number(rows(db, "SELECT COUNT(*) AS count FROM bookings WHERE event_id = ? AND status = 'REGULAR'", [eventId])[0].count);
  const vacancies = Number(event.regular_capacity) - regularCount;
  if (vacancies <= 0) return false;
  const candidates = rows(db, `
    SELECT id FROM bookings
    WHERE event_id = ? AND status = 'STANDBY'
    ORDER BY CASE WHEN kind_snapshot = 'MEMBER' THEN 0 ELSE 1 END, confirmed_at ASC
    LIMIT ?
  `, [eventId, vacancies]);
  for (const candidate of candidates) db.run("UPDATE bookings SET status = 'REGULAR' WHERE id = ?", [candidate.id]);
  return candidates.length > 0;
}

function save(db: Database) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, db.export());
}

function setup(db: Database) {
  db.run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, display_name TEXT UNIQUE NOT NULL, department TEXT, role TEXT NOT NULL DEFAULT 'MEMBER', membership_status TEXT NOT NULL DEFAULT 'GUEST', joined_at TEXT, ending_at TEXT, credit_balance INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS club_events (id TEXT PRIMARY KEY, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, courts TEXT NOT NULL, regular_capacity INTEGER NOT NULL DEFAULT 10, standby_capacity INTEGER NOT NULL DEFAULT 4, status TEXT NOT NULL DEFAULT 'SCHEDULED', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES club_events(id), member_id TEXT NOT NULL REFERENCES members(id), kind_snapshot TEXT NOT NULL, status TEXT NOT NULL, confirmed_at TEXT NOT NULL, cancelled_at TEXT, UNIQUE(event_id, member_id));
    CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), event_id TEXT REFERENCES club_events(id), type TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', period_label TEXT, due_at TEXT, reported_at TEXT, confirmed_at TEXT, note TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES club_events(id), source_booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id), source_member_id TEXT NOT NULL REFERENCES members(id), recipient_id TEXT NOT NULL REFERENCES members(id), settlement TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, link_url TEXT, pinned INTEGER NOT NULL DEFAULT 0, published_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rest_days (id TEXT PRIMARY KEY, date TEXT UNIQUE NOT NULL, label TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fee_rates (id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount INTEGER NOT NULL, effective_from TEXT NOT NULL, effective_to TEXT);
  `);
  if (Number(rows(db, "SELECT COUNT(*) AS count FROM members")[0].count) > 0) return;
  const now = "2026-08-29T00:00:00.000Z";
  const members = [
    ["王小芸", "人資", "ADMIN", "MEMBER"], ["陳韋廷", "工程", "ADMIN", "MEMBER"], ["林子晴", "設計", "MEMBER", "MEMBER"], ["周昱安", "業務", "MEMBER", "MEMBER"], ["許庭維", "財務", "MEMBER", "GUEST"], ["徐佩珊", "產品", "MEMBER", "MEMBER"], ["郭明軒", "工程", "MEMBER", "MEMBER"],
  ].map(([displayName, department, role, membershipStatus]) => ({ id: id(), displayName, department, role, membershipStatus }));
  for (const member of members) db.run("INSERT INTO members VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)", [member.id, member.displayName, member.department, member.role, member.membershipStatus, member.membershipStatus === "MEMBER" ? "2026-01-01T00:00:00.000Z" : null, now]);
  const events = [
    ["2026-09-04T11:00:00.000Z", "2026-09-04T13:00:00.000Z", "公司體育館 A 場", 10, 4], ["2026-09-11T11:00:00.000Z", "2026-09-11T13:00:00.000Z", "公司體育館 A 場", 10, 4], ["2026-09-18T11:00:00.000Z", "2026-09-18T13:00:00.000Z", "公司體育館 A、B 場", 20, 8],
  ].map(([startsAt, endsAt, courts, regular, standby]) => ({ id: id(), startsAt, endsAt, courts, regular, standby }));
  for (const event of events) db.run("INSERT INTO club_events VALUES (?, ?, ?, ?, ?, ?, 'SCHEDULED', ?)", [event.id, event.startsAt, event.endsAt, event.courts, event.regular, event.standby, now]);
  for (const member of members.filter((member) => member.membershipStatus === "MEMBER")) db.run("INSERT INTO bookings VALUES (?, ?, ?, 'MEMBER', 'REGULAR', ?, NULL)", [id(), events[0].id, member.id, now]);
  const guest = members.find((member) => member.displayName === "許庭維")!;
  db.run("INSERT INTO bookings VALUES (?, ?, ?, 'GUEST', 'REGULAR', ?, NULL)", [id(), events[0].id, guest.id, now]);
  for (const member of members.slice(0, 2)) db.run("INSERT INTO bookings VALUES (?, ?, ?, 'MEMBER', 'REGULAR', ?, NULL)", [id(), events[1].id, member.id, now]);
  db.run("INSERT INTO announcements VALUES (?, ?, ?, NULL, 1, ?), (?, ?, ?, NULL, 0, ?)", [id(), "九月活動時段與場地", "九月固定於週五 19:00 開打；9/18 將使用 A、B 兩場。", now, id(), "第三季社員費預收通知", "本季共 12 次活動，社員預收費用為 NT$1,800。請於 9/6 前完成轉帳。", now]);
  db.run("INSERT INTO fee_rates VALUES (?, 'MEMBER_VISIT', 150, '2026-07-01T00:00:00.000Z', NULL), (?, 'GUEST_VISIT', 180, '2026-07-01T00:00:00.000Z', NULL)", [id(), id()]);
  const byName = (name: string) => members.find((member) => member.displayName === name)!;
  for (const [name, amount, status, label] of [["王小芸", 1800, "CONFIRMED", "2026 Q3"], ["林子晴", 1800, "REPORTED", "2026 Q3"], ["周昱安", 1800, "CONFIRMED", "2026 Q3"], ["許庭維", 180, "PENDING", "9/4 活動"]] as const) db.run("INSERT INTO invoices VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)", [id(), byName(name).id, name === "許庭維" ? events[0].id : null, name === "許庭維" ? "SINGLE_EVENT" : "QUARTERLY_MEMBER", amount, status, label, now]);
  db.run("INSERT INTO rest_days VALUES (?, '2026-10-09T00:00:00.000Z', '國慶日連假')", [id()]);
  save(db);
}

export async function getDatabase() {
  if (!databasePromise) databasePromise = (async () => {
    const SQL = await initSqlJs({ locateFile: (file) => path.join(process.cwd(), "node_modules", "sql.js", "dist", file) });
    const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
    setup(db);
    const now = new Date().toISOString();
    let changed = false;
    for (const event of rows(db, "SELECT id FROM club_events WHERE status = 'SCHEDULED'")) {
      if (promoteStandby(db, String(event.id), now)) changed = true;
    }
    if (changed) save(db);
    return db;
  })();
  return databasePromise;
}

export async function readState() {
  const db = await getDatabase();
  const members = rows(db, "SELECT id, display_name AS name, department, role, membership_status AS membershipStatus, credit_balance AS creditBalance FROM members ORDER BY display_name");
  const events = rows(db, "SELECT * FROM club_events WHERE status != 'CANCELLED' ORDER BY starts_at").map((event) => ({ ...event, bookings: rows(db, "SELECT b.id, m.display_name AS name, b.kind_snapshot AS kind, b.status, b.confirmed_at AS confirmedAt FROM bookings b JOIN members m ON m.id = b.member_id WHERE b.event_id = ? AND b.status IN ('REGULAR', 'STANDBY') ORDER BY b.confirmed_at", [event.id]) }));
  return { members, events, announcements: rows(db, "SELECT id, title, content, link_url AS linkUrl, pinned, published_at AS publishedAt FROM announcements ORDER BY pinned DESC, published_at DESC"), invoices: rows(db, "SELECT i.*, m.display_name AS memberName FROM invoices i JOIN members m ON m.id = i.member_id ORDER BY i.created_at DESC"), restDays: rows(db, "SELECT * FROM rest_days ORDER BY date"), feeRates: rows(db, "SELECT * FROM fee_rates ORDER BY effective_from DESC") };
}

export async function mutate(action: string, input: Record<string, string>) {
  const db = await getDatabase();
  const now = new Date().toISOString();
  const memberFor = (name: string) => rows(db, "SELECT * FROM members WHERE display_name = ?", [name])[0];
  if (action === "login") { const existing = memberFor(input.name); if (!existing) { db.run("INSERT INTO members VALUES (?, ?, NULL, 'MEMBER', 'GUEST', NULL, NULL, 0, ?)", [id(), input.name, now]); save(db); } return; }
  if (action === "join") {
    const member = memberFor(input.name); const event = rows(db, "SELECT * FROM club_events WHERE id = ?", [input.eventId])[0]; if (!member || !event) throw new Error("找不到使用者或活動");
    if (event.status !== "SCHEDULED" || new Date(String(event.starts_at)) <= new Date(now)) throw new Error("活動已開始或已取消，無法再報名");
    const existingBooking = rows(db, "SELECT id, status FROM bookings WHERE event_id = ? AND member_id = ?", [input.eventId, member.id])[0];
    if (existingBooking && existingBooking.status !== "CANCELLED") return;
    promoteStandby(db, input.eventId, now);
    const regular = Number(rows(db, "SELECT COUNT(*) AS count FROM bookings WHERE event_id = ? AND status = 'REGULAR'", [input.eventId])[0].count);
    const standby = Number(rows(db, "SELECT COUNT(*) AS count FROM bookings WHERE event_id = ? AND status = 'STANDBY'", [input.eventId])[0].count);
    const status = regular < Number(event.regular_capacity) ? "REGULAR" : standby < Number(event.standby_capacity) ? "STANDBY" : null;
    if (!status) throw new Error("本場正取與候補名額皆已額滿");
    db.run("INSERT INTO bookings (id, event_id, member_id, kind_snapshot, status, confirmed_at, cancelled_at) VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(event_id, member_id) DO UPDATE SET kind_snapshot = excluded.kind_snapshot, status = excluded.status, confirmed_at = excluded.confirmed_at, cancelled_at = NULL", [existingBooking?.id ?? id(), input.eventId, member.id, member.membership_status, status, now]);
    if (member.membership_status === "GUEST") db.run("INSERT INTO invoices VALUES (?, ?, ?, 'SINGLE_EVENT', 180, 'PENDING', ?, NULL, NULL, NULL, NULL, ?)", [id(), member.id, input.eventId, "單次活動", now]);
  } else if (action === "cancel") {
    const member = memberFor(input.name); if (!member) throw new Error("找不到使用者"); db.run("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ? WHERE event_id = ? AND member_id = ?", [now, input.eventId, member.id]);
    if (member.membership_status === "GUEST") db.run("UPDATE invoices SET status = 'VOID' WHERE event_id = ? AND member_id = ? AND status = 'PENDING'", [input.eventId, member.id]);
    promoteStandby(db, input.eventId, now);
  } else if (action === "transfer") {
    const source = memberFor(input.name); if (!source) throw new Error("找不到轉讓者"); const booking = rows(db, "SELECT * FROM bookings WHERE event_id = ? AND member_id = ? AND status IN ('REGULAR','STANDBY')", [input.eventId, source.id])[0]; if (!booking) throw new Error("沒有可轉讓的名額");
    let recipient = memberFor(input.recipient); if (!recipient) { const recipientId = id(); db.run("INSERT INTO members VALUES (?, ?, NULL, 'MEMBER', 'GUEST', NULL, NULL, 0, ?)", [recipientId, input.recipient, now]); recipient = memberFor(input.recipient); }
    if (recipient.id === source.id) throw new Error("接手者不能是原社員本人");
    const recipientBooking = rows(db, "SELECT id, status FROM bookings WHERE event_id = ? AND member_id = ?", [input.eventId, recipient.id])[0];
    if (recipientBooking && recipientBooking.status !== "CANCELLED") throw new Error("接手者已在本次活動名單中");
    db.run("INSERT INTO bookings (id, event_id, member_id, kind_snapshot, status, confirmed_at, cancelled_at) VALUES (?, ?, ?, 'GUEST', ?, ?, NULL) ON CONFLICT(event_id, member_id) DO UPDATE SET kind_snapshot = 'GUEST', status = excluded.status, confirmed_at = excluded.confirmed_at, cancelled_at = NULL", [recipientBooking?.id ?? id(), input.eventId, recipient.id, booking.status, now]);
    db.run("UPDATE bookings SET status = 'TRANSFERRED' WHERE id = ?", [booking.id]); db.run("INSERT INTO transfers VALUES (?, ?, ?, ?, ?, 'CONFIRMED', ?)", [id(), input.eventId, booking.id, source.id, recipient.id, now]);
    promoteStandby(db, input.eventId, now);
  } else if (action === "publish") {
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
    db.run("INSERT INTO announcements VALUES (?, ?, ?, ?, 0, ?)", [id(), title, content, linkUrl, now]);
  }
  else if (action === "reportPayment") db.run("UPDATE invoices SET status = 'REPORTED', reported_at = ? WHERE id = ?", [now, input.invoiceId]);
  else if (action === "createEvent") {
    if (!input.startsAt || !input.endsAt || !input.courts) throw new Error("請填寫活動日期、時間與場地");
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const courts = input.courts.trim();
    const regularCapacity = Number(input.regularCapacity || 10);
    const standbyCapacity = Number(input.standbyCapacity || 4);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) throw new Error("結束時間必須晚於開始時間");
    if (!courts) throw new Error("請填寫活動場地");
    if (!Number.isInteger(regularCapacity) || regularCapacity < 1 || !Number.isInteger(standbyCapacity) || standbyCapacity < 0) throw new Error("請填寫正確的正取與候補人數");
    if (rows(db, "SELECT id FROM club_events WHERE starts_at LIKE ? AND status = 'SCHEDULED'", [`${input.startsAt.slice(0, 10)}%`]).length > 0) throw new Error("這一天已有活動，請直接編輯既有活動");
    db.run("INSERT INTO club_events VALUES (?, ?, ?, ?, ?, ?, 'SCHEDULED', ?)", [id(), input.startsAt, input.endsAt, courts, regularCapacity, standbyCapacity, now]);
  } else if (action === "updateEvent") {
    const regularCapacity = Number(input.regularCapacity);
    const standbyCapacity = Number(input.standbyCapacity);
    const regularCount = Number(rows(db, "SELECT COUNT(*) AS count FROM bookings WHERE event_id = ? AND status = 'REGULAR'", [input.eventId])[0].count);
    const standbyCount = Number(rows(db, "SELECT COUNT(*) AS count FROM bookings WHERE event_id = ? AND status = 'STANDBY'", [input.eventId])[0].count);
    if (!Number.isInteger(regularCapacity) || regularCapacity < 1 || !Number.isInteger(standbyCapacity) || standbyCapacity < 0) throw new Error("請填寫正確的正取與候補人數");
    if (regularCapacity < regularCount) throw new Error(`正取已有 ${regularCount} 人，容量不能調低於目前人數`);
    const remainingStandby = Math.max(0, standbyCount - (regularCapacity - regularCount));
    if (standbyCapacity < remainingStandby) throw new Error(`調整後仍有 ${remainingStandby} 位候補，候補容量不能低於目前人數`);
    db.run("UPDATE club_events SET starts_at = ?, ends_at = ?, courts = ?, regular_capacity = ?, standby_capacity = ? WHERE id = ? AND status = 'SCHEDULED'", [input.startsAt, input.endsAt, input.courts, regularCapacity, standbyCapacity, input.eventId]);
    promoteStandby(db, input.eventId, now);
  } else if (action === "cancelEvent") {
    db.run("UPDATE club_events SET status = 'CANCELLED' WHERE id = ?", [input.eventId]);
  } else if (action === "addRestDay") {
    if (!input.date || !input.label) throw new Error("請填寫休團日日期與名稱");
    if (rows(db, "SELECT id FROM rest_days WHERE date LIKE ?", [`${input.date.slice(0, 10)}%`]).length > 0) throw new Error("這一天已經是休團日");
    db.run("INSERT INTO rest_days VALUES (?, ?, ?)", [id(), input.date, input.label.trim()]);
  } else if (action === "removeRestDay") {
    db.run("DELETE FROM rest_days WHERE id = ?", [input.restDayId]);
  } else if (action === "generateWeeklyEvents") {
    const requestedWeeks = Number(input.weeks || 12);
    const regularCapacity = Number(input.regularCapacity || 10);
    const standbyCapacity = Number(input.standbyCapacity || 4);
    if (!Number.isInteger(requestedWeeks) || requestedWeeks < 1 || requestedWeeks > 16) throw new Error("建立週數必須是 1 到 16 的整數");
    if (!Number.isInteger(regularCapacity) || regularCapacity < 1 || !Number.isInteger(standbyCapacity) || standbyCapacity < 0) throw new Error("請填寫正確的正取與候補人數");
    const weeks = requestedWeeks;
    const validTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    const startTime = validTime.test(input.startTime || "") ? input.startTime : "19:00";
    const endTime = validTime.test(input.endTime || "") ? input.endTime : "21:00";
    if (endTime <= startTime) throw new Error("結束時間必須晚於開始時間");
    const start = new Date(`${input.startDate || new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) throw new Error("請填寫正確的起始日期");
    while (start.getUTCDay() !== 5) start.setUTCDate(start.getUTCDate() + 1);
    for (let index = 0; index < weeks; index += 1) {
      const day = new Date(start); day.setUTCDate(start.getUTCDate() + index * 7);
      const date = day.toISOString().slice(0, 10);
      const resting = rows(db, "SELECT id FROM rest_days WHERE date LIKE ?", [`${date}%`]).length > 0;
      const exists = rows(db, "SELECT id FROM club_events WHERE starts_at LIKE ?", [`${date}%`]).length > 0;
      if (!resting && !exists) {
        const startsAt = new Date(`${date}T${startTime}:00+08:00`).toISOString();
        const endsAt = new Date(`${date}T${endTime}:00+08:00`).toISOString();
        db.run("INSERT INTO club_events VALUES (?, ?, ?, ?, ?, ?, 'SCHEDULED', ?)", [id(), startsAt, endsAt, input.courts?.trim() || "公司體育館 A 場", regularCapacity, standbyCapacity, now]);
      }
    }
  } else throw new Error("不支援的操作");
  save(db);
}
