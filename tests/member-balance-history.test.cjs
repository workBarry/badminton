/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const projectRoot = process.env.BADMINTON_TEST_ROOT || path.resolve(__dirname, "..");
const ts = require(path.join(projectRoot, "node_modules/typescript"));

function load(relative, dependencies) {
  const filename = path.join(projectRoot, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", output)((id) => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    throw new Error("Unexpected dependency: " + id);
  }, loaded, loaded.exports);
  return loaded.exports;
}

function setup(role = "ADMIN") {
  const documents = new Map([
    ["members/admin", { role, displayName: "幹部" }],
    ["members/alice", { displayName: "小美", accountName: "alice", creditBalance: 250, secret: "private" }],
    ["members/bob", { displayName: "小美", accountName: "bob", creditBalance: 800 }],
    ["invoices/one", { memberId: "alice", creditApplied: 50, eventId: "friday" }],
    ["invoices/two", { memberId: "bob", creditApplied: 99 }],
    ["balanceMovements/move", { memberId: "alice", amount: -50 }],
    ["balanceMovements/other", { memberId: "bob", amount: 800 }],
    ["auditLogs/audit", { targetMemberId: "alice", action: "UPDATE_MEMBER" }],
    ["auditLogs/other", { targetMemberId: "bob", action: "UPDATE_MEMBER" }],
    ["events/friday", { startsAt: new Date("2026-11-27T10:00:00Z") }],
  ]);
  const queries = [];
  let accesses = 0;
  let captured;
  const snapshot = (ref) => ({ id: ref.id, exists: documents.has(ref.path), data: () => documents.get(ref.path) });
  const db = {
    collection(name) {
      return {
        doc(id) { return { id, path: name + "/" + id }; },
        where(field, op, value) { assert.equal(op, "=="); return { name, field, value }; },
      };
    },
    async runTransaction(callback) {
      return callback({
        getAll: async (...refs) => refs.map(snapshot),
        get: async (query) => {
          queries.push(query);
          return { docs: [...documents].filter(([key, data]) => key.startsWith(query.name + "/") && data[query.field] === query.value).map(([key]) => snapshot({ path: key, id: key.split("/")[1] })) };
        },
        create() { throw new Error("History must be read-only"); },
        update() { throw new Error("History must be read-only"); },
        set() { throw new Error("History must be read-only"); },
      });
    },
  };
  const service = load("src/lib/member-balance-history.ts", {
    "@/lib/firebase-admin": { getAdminFirestore() { accesses += 1; return db; } },
    "@/lib/member-names.mjs": { memberAccountName: (member) => member.accountName || member.displayName },
    "@/lib/balance-history": { buildBalanceHistory(input) { captured = input; return { memberId: input.memberId, currentBalance: input.currentBalance, entries: [] }; } },
  });
  return { ...service, documents, queries, get accesses() { return accesses; }, get captured() { return captured; } };
}

const actor = { id: "admin", role: "ADMIN" };
test("history rejects anonymous and ordinary accounts before accessing Firestore", async () => {
  const s = setup();
  await assert.rejects(s.readMemberBalanceHistory("alice", null), { status: 401 });
  await assert.rejects(s.readMemberBalanceHistory("alice", { id: "bob", role: "MEMBER" }), { status: 403 });
  assert.equal(s.accesses, 0);
});
test("history rechecks current administrator authority within the read transaction", async () => {
  const s = setup("MEMBER");
  await assert.rejects(s.readMemberBalanceHistory("alice", actor), { status: 403 });
  assert.equal(s.queries.length, 0);
  s.documents.delete("members/admin");
  await assert.rejects(s.readMemberBalanceHistory("alice", actor), { status: 403 });
});
test("history rejects nested or invalid member references and missing accounts", async () => {
  const s = setup();
  for (const id of ["", " alice", "alice ", ".", "..", "alice/private", "bad\nname", "x".repeat(1501)]) await assert.rejects(s.readMemberBalanceHistory(id, actor), { status: 400 });
  assert.equal(s.accesses, 0);
  await assert.rejects(s.readMemberBalanceHistory("absent", actor), { status: 404 });
});
test("history reads only the requested member's evidence and related events without mutating balances", async () => {
  const s = setup();
  const original = structuredClone([...s.documents]);
  const result = await s.readMemberBalanceHistory("alice", actor);
  assert.equal(result.currentBalance, 250);
  assert.equal(s.captured.memberName, "小美");
  assert.equal(s.captured.accountName, "alice");
  assert.deepEqual(s.captured.invoices.map((entry) => entry.id), ["one"]);
  assert.deepEqual(s.captured.movements.map((entry) => entry.id), ["move"]);
  assert.deepEqual(s.captured.audits.map((entry) => entry.id), ["audit"]);
  assert.deepEqual(s.captured.events.map((entry) => entry.id), ["friday"]);
  assert.deepEqual([...s.documents], original);
  assert.equal(Object.hasOwn(result, "secret"), false);
});

function routeFor(reader, viewer = actor) {
  let stateCalls = 0;
  const response = { json: (body, options = {}) => new Response(JSON.stringify(body), { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } }) };
  const { BalanceHistoryError } = setup();
  const route = load("src/app/api/club/route.ts", {
    "next/server": { NextResponse: response },
    "@/lib/device-auth": { DEVICE_COOKIE: "device", viewerForDeviceToken: async () => viewer },
    "@/lib/firestore-database": { readState() { stateCalls += 1; throw new Error("Full state should not be loaded"); } },
    "@/lib/member-balance-history": { readMemberBalanceHistory: reader, BalanceHistoryError },
  });
  return { route, BalanceHistoryError, stateCalls: () => stateCalls };
}
const request = (id) => ({ nextUrl: new URL("http://localhost/api/club?balanceHistoryMemberId=" + encodeURIComponent(id)), cookies: { get: () => ({ value: "opaque-device-credential" }) } });
test("history API returns a private uncached response without invoking full-state readers", async () => {
  const r = routeFor(async (id, viewer) => { assert.equal(id, "alice"); assert.equal(viewer.id, "admin"); return { memberId: id, currentBalance: 12, entries: [] }; });
  const response = await r.route.GET(request("alice"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal((await response.json()).memberId, "alice");
  assert.equal(r.stateCalls(), 0);
});
test("history API retains authorization errors and hides unexpected infrastructure details", async () => {
  let r;
  r = routeFor(async () => { throw new r.BalanceHistoryError("拒絕存取", 403); });
  let response = await r.route.GET(request("alice"));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "拒絕存取" });
  r = routeFor(async () => { throw new Error("private-project-key-secret"); });
  response = await r.route.GET(request("alice"));
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private-project/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
