/* eslint-disable @typescript-eslint/no-require-imports */
/* All Firestore calls use the in-memory adapter below. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { randomUUID } = require("node:crypto");
const nearbyRoot = path.resolve(__dirname, "..");
const sourceRoot = fs.existsSync(path.join(nearbyRoot, "package.json")) ? nearbyRoot : "C:/Users/barry.chen/Desktop/badminton";
const sourceRequire = createRequire(path.join(sourceRoot, "package.json"));
const ts = sourceRequire("typescript");
const admin = { id: "admin", name: "幹部", role: "ADMIN" };
const member = { id: "member", name: "社員", role: "MEMBER" };
function loadTs(relative, dependencies = {}) {
  const source = fs.readFileSync(path.join(sourceRoot, relative), "utf8");
  const result = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  assert.equal((result.diagnostics ?? []).filter((entry) => entry.category === ts.DiagnosticCategory.Error).length, 0);
  const loaded = { exports: {} };
  new Function("require", "module", "exports", result.outputText)((id) => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (["crypto", "node:crypto"].includes(id)) return require(id);
    throw new Error("Unexpected dependency; offline test blocked it: " + id);
  }, loaded, loaded.exports);
  return loaded.exports;
}
const ledger = loadTs("src/lib/balance-ledger.ts");
const history = loadTs("src/lib/balance-history.ts");
function database() {
  let records = new Map();
  let pending = Promise.resolve();
  const snapshot = (ref) => ({ id: ref.id, ref, exists: records.has(ref.path), data: () => structuredClone(records.get(ref.path)) });
  const reference = (pathname) => ({ path: pathname, id: pathname.split("/").at(-1), get: async () => snapshot(reference(pathname)) });
  const db = {
    collection: (name) => ({ doc: (id = randomUUID()) => reference(name + "/" + id) }),
    seed: (key, value) => records.set(key, structuredClone(value)),
    data: (key) => structuredClone(records.get(key)),
    entries: (prefix = "") => structuredClone([...records.entries()].filter(([key]) => key.startsWith(prefix))),
    runTransaction(callback) {
      const run = pending.then(async () => {
        if (db.beforeNextTransaction) { const hook = db.beforeNextTransaction; db.beforeNextTransaction = null; await hook(); }
        const writes = [];
        const read = async (ref) => { assert.equal(writes.length, 0, "All Firestore reads must precede writes"); return ref.get(); };
        const tx = { get: read, getAll: (...refs) => Promise.all(refs.map(read)) };
        for (const kind of ["create", "update", "set", "delete"]) tx[kind] = (ref, data) => writes.push({ kind, ref, data });
        const result = await callback(tx);
        const before = structuredClone(records);
        try {
          for (const { kind, ref, data } of writes) {
            if (db.failCollection && ref.path.startsWith(db.failCollection + "/")) { db.failCollection = null; throw new Error("Injected commit failure"); }
            const previous = records.get(ref.path);
            if (kind === "create" && previous) throw new Error("ALREADY_EXISTS");
            if (kind === "update" && !previous) throw new Error("NOT_FOUND");
            if (kind === "delete") records.delete(ref.path);
            else records.set(ref.path, { ...(kind === "update" ? previous : {}), ...structuredClone(data) });
          }
          const addedMovements = [...records.entries()].filter(([key]) => key.startsWith("balanceMovements/") && !before.has(key)).map(([, data]) => data);
          for (const [key, original] of before) if (key.startsWith("members/")) {
            const delta = Number(records.get(key)?.creditBalance ?? 0) - Number(original.creditBalance ?? 0);
            assert.equal(addedMovements.filter((entry) => entry.memberId === key.split("/")[1]).reduce((sum, entry) => sum + entry.amount, 0), delta, "Atomic ledger must equal actual balance change");
          }
        } catch (error) { records = before; throw error; }
        return result;
      });
      pending = run.catch(() => {});
      return run;
    },
  };
  return db;
}
function setup(balance = 100) {
  const db = database();
  db.seed("members/admin", { displayName: "幹部", role: "ADMIN", creditBalance: 0 });
  db.seed("members/member", {
    displayName: "社員", accountName: "stable-account", role: "MEMBER", department: "資訊部", membershipStatus: "EXITING",
    endingAt: new Date("2030-01-01"), creditBalance: balance, custom: { preserved: true }, updatedAt: new Date("2026-01-01"),
  });
  const backend = loadTs("src/lib/firestore-database.ts", {
    "@/lib/club-roles": {}, "firebase-admin/firestore": {}, "@/lib/firebase-admin": { getAdminFirestore: () => db },
    "@/lib/balance-ledger": ledger, "@/lib/member-names.mjs": {}, "@/lib/device-auth": {},
    "@/lib/invoice-management": {}, "@/lib/quarter-planning": {}, "@/lib/official-closures": {},
  });
  const input = (extra = {}) => ({ action: "adjustMemberBalance", memberId: "member", balanceAdjustment: "50", adjustmentNote: "  更正餘額  ", expectedBalance: String(balance), requestId: randomUUID(), ...extra });
  return { db, input, mutate: (body, actor = admin) => backend.mutate("adjustMemberBalance", body, actor) };
}
async function unchangedReject(s, body, pattern, actor = admin) {
  const before = s.db.entries();
  await assert.rejects(s.mutate(body, actor), pattern);
  assert.deepEqual(s.db.entries(), before, "Rejected mutation must leave every record unchanged");
}
function count(s, collection) { return s.db.entries(collection + "/").length; }

test("dedicated balance action changes only balance/timestamp and atomically records invoice, ledger and audit", async () => {
  const s = setup();
  const original = s.db.data("members/member");
  const result = await s.mutate(s.input());
  assert.equal(result.creditBalance, 150);
  const updated = s.db.data("members/member");
  assert.deepEqual({ ...updated, creditBalance: original.creditBalance, updatedAt: original.updatedAt }, original);
  const invoice = s.db.data("invoices/" + result.adjustmentInvoiceId);
  assert.equal(invoice.type, "ADJUSTMENT"); assert.equal(invoice.amount, -50); assert.equal(invoice.status, "CONFIRMED");
  assert.equal(invoice.note, "更正餘額"); assert.equal(invoice.confirmedBy, admin.id);
  const movement = s.db.entries("balanceMovements/")[0][1];
  assert.equal(movement.amount, 50); assert.equal(movement.reason, "更正餘額"); assert.equal(movement.sourceKey, "invoice:" + invoice.id + ":adjustment");
  const audit = s.db.entries("auditLogs/")[0][1];
  assert.equal(audit.action, "UPDATE_MEMBER"); assert.deepEqual(audit.before, { creditBalance: 100 }); assert.deepEqual(audit.after, { creditBalance: 150 });
  assert.equal(audit.targetMemberId, "member"); assert.equal(audit.actorNameSnapshot, admin.name);
  assert.deepEqual([...new Set(s.db.entries().map(([key]) => key.split("/")[0]))].sort(), ["auditLogs", "balanceMovements", "invoices", "members"]);
});
test("subtracting exactly the balance reaches zero without modifying membership", async () => {
  const s = setup(); await s.mutate(s.input({ balanceAdjustment: "-100" }));
  assert.equal(s.db.data("members/member").creditBalance, 0);
  assert.equal(s.db.data("members/member").membershipStatus, "EXITING");
});
test("administrators may adjust their own balance while preserving president and account fields", async () => {
  const s = setup();
  s.db.seed("members/admin", { displayName: "社長", role: "ADMIN", primaryAdmin: true, accountName: "chief", membershipStatus: "MEMBER", creditBalance: 25 });
  const original = s.db.data("members/admin");
  await s.mutate(s.input({ memberId: "admin", expectedBalance: "25" }));
  const after = s.db.data("members/admin");
  assert.deepEqual({ ...after, creditBalance: 25, updatedAt: undefined }, { ...original, updatedAt: undefined });
});
test("role checks reject members, stale administrators and a role changed inside the transaction", async () => {
  const s = setup(); await unchangedReject(s, s.input(), /只有幹部/, member);
  s.db.seed("members/admin", { role: "MEMBER", creditBalance: 0 });
  await unchangedReject(s, s.input(), /權限已變更/);
  const raced = setup();
  raced.db.beforeNextTransaction = () => raced.db.seed("members/admin", { role: "MEMBER", creditBalance: 0 });
  await assert.rejects(raced.mutate(raced.input()), /權限已變更/);
  assert.equal(raced.db.data("members/member").creditBalance, 100); assert.equal(count(raced, "invoices"), 0);
});
test("missing targets are rejected before any write", async () => {
  const s = setup(); await unchangedReject(s, s.input({ memberId: "missing" }), /找不到使用者/);
});
test("only the six string payload fields are allowed and member IDs cannot contain slashes or controls", async () => {
  const s = setup();
  for (const extra of [{ role: "ADMIN" }, { membershipStatus: "GUEST" }, { department: "changed" }, { endingAt: "" }, { balanceAdjustment: 50 }, { adjustmentNote: null }, { action: "updateMember" }]) await unchangedReject(s, s.input(extra), /資料不正確|操作不正確/);
  for (const memberId of ["", "   ", "member/path", "member\n", "\nmember", "member\u0085", ".", "..", "中".repeat(501)]) await unchangedReject(s, s.input({ memberId }), /識別碼/);
});
test("invalid, zero, fractional and out-of-range adjustments are rejected", async () => {
  const s = setup();
  for (const balanceAdjustment of ["", " ", "0", "-0", "1.5", "100001", "-100001", "NaN", "Infinity", "9007199254740992", "no"]) await unchangedReject(s, s.input({ balanceAdjustment }), /金額|非零整數/);
  await unchangedReject(s, { ...s.input(), balanceAdjustment: undefined }, /資料不正確/);
});
test("expected balances, reasons and request IDs are mandatory and validated", async () => {
  const s = setup();
  for (const expectedBalance of ["", "  ", "-1", "1.5", "Infinity", "NaN", "9007199254740992"]) await unchangedReject(s, s.input({ expectedBalance }), /目前餘額/);
  for (const adjustmentNote of ["", " \n ", "字".repeat(201)]) await unchangedReject(s, s.input({ adjustmentNote }), /原因/);
  for (const requestId of ["", "arbitrary", "../path", "123e4567-e89b-12d3-a456-426614174000", "123e4567-e89b-42d3-7456-426614174000"]) await unchangedReject(s, s.input({ requestId }), /識別碼/);
  const noAction = s.input(); delete noAction.action; await s.mutate(noAction);
  assert.equal(s.db.data("members/member").creditBalance, 150);
});
test("stale balances, insufficient funds and unsafe totals leave all records unchanged", async () => {
  const s = setup(); await unchangedReject(s, s.input({ expectedBalance: "99" }), /餘額已變更/);
  await unchangedReject(s, s.input({ balanceAdjustment: "-101" }), /不能小於零/);
  const high = setup(Number.MAX_SAFE_INTEGER); await unchangedReject(high, high.input(), /安全整數/);
});
test("an exact UUID retry produces one invoice, ledger and audit even with stale expected balance", async () => {
  const s = setup(); const body = s.input();
  const first = await s.mutate(body); const retry = await s.mutate(body);
  assert.deepEqual(retry, first); assert.equal(count(s, "invoices"), 1); assert.equal(count(s, "balanceMovements"), 1); assert.equal(count(s, "auditLogs"), 1);
  const capitalized = await s.mutate({ ...body, requestId: body.requestId.toUpperCase() });
  assert.deepEqual(capitalized, first); assert.equal(count(s, "invoices"), 1);
  await s.mutate(s.input({ expectedBalance: "150", balanceAdjustment: "25" }));
  const afterOtherChange = await s.mutate(body);
  assert.equal(afterOtherChange.creditBalance, 175); assert.equal(count(s, "invoices"), 2);
});
test("reusing a receipt for a different amount, reason, member or administrator is rejected", async () => {
  const s = setup(); const body = s.input(); await s.mutate(body);
  s.db.seed("members/second", { role: "MEMBER", creditBalance: 100 });
  s.db.seed("members/other-admin", { role: "ADMIN", creditBalance: 0 });
  for (const extra of [{ balanceAdjustment: "-50" }, { adjustmentNote: "另一個原因" }, { memberId: "second" }]) await unchangedReject(s, { ...body, ...extra }, /識別碼已使用/);
  await unchangedReject(s, body, /識別碼已使用/, { id: "other-admin", name: "另一幹部", role: "ADMIN" });
});
test("simultaneous duplicate requests apply one adjustment; separate stale requests cannot both spend", async () => {
  const s = setup(); const body = s.input({ balanceAdjustment: "-100" });
  await Promise.all([s.mutate(body), s.mutate(body)]);
  assert.equal(s.db.data("members/member").creditBalance, 0); assert.equal(count(s, "invoices"), 1);
  const raced = setup();
  const results = await Promise.allSettled([raced.mutate(raced.input({ balanceAdjustment: "-100" })), raced.mutate(raced.input({ balanceAdjustment: "-100" }))]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.match(results.find((entry) => entry.status === "rejected").reason.message, /餘額已變更/);
  assert.equal(raced.db.data("members/member").creditBalance, 0); assert.equal(count(raced, "invoices"), 1);
});
test("a failure committing the audit rolls back the balance, invoice and movement", async () => {
  const s = setup(); s.db.failCollection = "auditLogs";
  await unchangedReject(s, s.input(), /Injected commit failure/);
});
test("balance history renders a dedicated action exactly once across ledger, invoice and audit evidence", async () => {
  const s = setup(); await s.mutate(s.input());
  const docs = (collection) => s.db.entries(collection + "/").map(([key, data]) => ({ id: key.split("/")[1], data }));
  const evidence = { memberId: "member", memberName: "社員", accountName: "stable-account", currentBalance: 150, invoices: docs("invoices"), movements: docs("balanceMovements"), audits: docs("auditLogs"), events: [] };
  const built = history.buildBalanceHistory(evidence);
  assert.equal(built.entries.length, 1); assert.equal(built.entries[0].amount, 50); assert.equal(built.entries[0].reason, "更正餘額");
  const legacy = history.buildBalanceHistory({ ...evidence, movements: [] });
  assert.equal(legacy.entries.length, 1); assert.equal(legacy.entries[0].actorName, admin.name);
});
