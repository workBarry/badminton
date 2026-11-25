/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { randomUUID } = require("node:crypto");

function loadTs(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, "..", relative);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", code)((id) => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    if (id.startsWith(".")) {
      const base = path.resolve(path.dirname(filename), id);
      const resolved = [base, base + ".ts", base + ".tsx", base + ".mjs", base + ".js"].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (resolved) return loadTs(path.relative(path.resolve(__dirname, ".."), resolved), dependencies);
    }
    return require(id);
  }, loaded, loaded.exports);
  return loaded.exports;
}
const planning = loadTs("src/lib/quarter-planning.ts");
const clubRoles = loadTs("src/lib/club-roles.ts");
const memberNames = loadTs("src/lib/member-names.mjs");
const balanceLedger = loadTs("src/lib/balance-ledger.ts");
const billingView = loadTs("src/lib/billing-view.ts");
const shuttleArt = loadTs("src/app/shuttle-art.tsx");
const loadingScreen = loadTs("src/app/loading-screen.tsx");
const balanceHistoryDialog = loadTs("src/app/balance-history-dialog.tsx");
test("loading screen renders deterministic accessible text", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const render = () => renderToStaticMarkup(React.createElement(loadingScreen.default));
  assert.equal(render(), render());
  assert.match(render(), /<main class="loading-screen"/);
  assert.match(render(), /role="status"/);
  assert.match(render(), /<strong[^>]*>loading<\/strong>/);
});
test("compact login loading avoids a nested main landmark", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(loadingScreen.default, { compact: true, title: "正在處理登入…" }));
  assert.match(html, /<strong[^>]*>loading<\/strong>/);
  assert.doesNotMatch(html, /<main/);
});
test("loading failure offers retry", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const html = renderToStaticMarkup(React.createElement(loadingScreen.default, { error: true, title: "暫時無法載入", onRetry() {} }));
  assert.match(html, /role="alert"/);
  assert.match(html, /重新載入/);

});
function managementInput(s, id = "quarter-test-plan-member", extra = {}) {
 const invoice = s.db.data("invoices/" + id);
 return { invoiceId: id, expectedStatus: invoice.status, expectedAmount: String(planning.effectiveInvoiceAmounts(invoice).amount), reason: "更正測試帳單", ...extra };
}
test("voiding a bill restores applied credit once, keeps history and does not cancel bookings", async () => {
 const s=setup(100); await s.confirm(); await s.bill();
 const input=managementInput(s); await s.mutate("voidInvoice",input); await s.mutate("voidInvoice",input);
 const old=s.db.data(s.invoicePath);
 assert.equal(old.status,"VOID"); assert.equal(old.grossAmount,1500);
 assert.equal(s.db.data("members/member").creditBalance,100);
 assert.equal(s.db.data("events/quarter-test-plan-0").status,"SCHEDULED");
 assert.equal(s.db.data("events/quarter-test-plan-0/bookings/member").status,"REGULAR");
 assert.equal(old.adjustments.at(-1).actorName,admin.name);
});
test("reissue is atomic, recalculates credit, links bills and preserves quarter baseline", async () => {
 const s=setup(100); await s.confirm(); await s.bill();
 const input=managementInput(s,undefined,{eventAmounts:JSON.stringify(Array(10).fill(100)),dueDate:s.rules.endDate});
 const result=await s.mutate("reissueInvoice",input);
 const retry=await s.mutate("reissueInvoice",input);
 assert.equal(result.invoiceId,retry.invoiceId);
 const old=s.db.data(s.invoicePath), fresh=s.db.data("invoices/"+result.invoiceId);
 assert.equal(old.status,"VOID"); assert.equal(old.amount,1400); assert.equal(old.replacedById,result.invoiceId);
 assert.equal(fresh.amount,900); assert.equal(fresh.creditApplied,100);
 assert.equal(fresh.replacementOfId,"quarter-test-plan-member");
 assert.equal(s.db.data("billingPeriods/quarter-test-plan").grossAmount,1500);
 await s.mutate("cancelEvent",{eventId:"quarter-test-plan-0"});
 assert.equal(planning.effectiveInvoiceAmounts(s.db.data("invoices/"+result.invoiceId)).amount,800);
 assert.equal(s.db.data("members/member").creditBalance,0);
});
test("reopening a previously voided invoice must not restore credit twice", async () => {
 const s=setup(100); await s.confirm(); await s.bill();
 await s.mutate("voidInvoice",managementInput(s));
 const result=await s.mutate("reissueInvoice",managementInput(s,undefined,{eventAmounts:JSON.stringify(Array(10).fill(150)),dueDate:s.rules.endDate}));
 assert.equal(s.db.data("members/member").creditBalance,0);
 assert.equal(s.db.data("invoices/"+result.invoiceId).amount,1400);
});
test("reissue rejects cancelled-event charges and stale invoice totals without writes", async () => {
 const s=setup(); await s.confirm(); await s.bill();
 const stale=managementInput(s);
 await s.mutate("cancelEvent",{eventId:"quarter-test-plan-0"});
 await assert.rejects(s.mutate("voidInvoice",stale),/已變更/);
 await assert.rejects(s.mutate("reissueInvoice",managementInput(s,undefined,{eventAmounts:JSON.stringify(Array(10).fill(150)),dueDate:s.rules.endDate})),/取消/);
 assert.equal(s.db.data(s.invoicePath).status,"PENDING");
});
test("refund subtracts prior credits and is not repeated by retries or subsequent cancellation", async () => {
 const s=setup(100); await s.confirm(); await s.bill();
 await s.mutate("confirmPayment",{invoiceId:"quarter-test-plan-member"});
 await s.mutate("cancelEvent",{eventId:"quarter-test-plan-0"});
 const input=managementInput(s,undefined,{refundMode:"BALANCE",expectedRefundable:"1350"});
 await s.mutate("refundInvoice",input); await s.mutate("refundInvoice",input);
 assert.equal(s.db.data("members/member").creditBalance,1500);
 assert.equal(s.db.data(s.invoicePath).status,"REFUNDED");
 assert.equal(s.db.data(s.invoicePath).amount,1400);
 await s.mutate("cancelEvent",{eventId:"quarter-test-plan-1"});
 assert.equal(s.db.data("members/member").creditBalance,1500);
});
test("offline refund requires acknowledgment and restores original applied balance separately", async () => {
 const s=setup(100); await s.confirm(); await s.bill();
 await s.mutate("confirmPayment",{invoiceId:"quarter-test-plan-member"});
 const input=managementInput(s,undefined,{refundMode:"OFFLINE",expectedRefundable:"1500"});
 await assert.rejects(s.mutate("refundInvoice",input),/人工退款/);
 const result=await s.mutate("refundInvoice",{...input,offlineRefunded:"true"});
 assert.equal(result.cashRefund,1400); assert.equal(result.balanceRefund,100);
 assert.equal(s.db.data("members/member").creditBalance,100);
});
test("reported transfers cannot be voided; reject after checking reverses pending credit into reduction", async () => {
 const s=setup(); await s.confirm(); await s.bill();
 await s.mutate("reportPayment",{invoiceId:"quarter-test-plan-member"},member);
 await assert.rejects(s.mutate("voidInvoice",managementInput(s)),/未繳/);
 await s.mutate("cancelEvent",{eventId:"quarter-test-plan-0"});
 await s.mutate("rejectPaymentReport",managementInput(s,undefined,{checkedNotReceived:"true"}));
 assert.equal(s.db.data(s.invoicePath).status,"PENDING");
 assert.equal(planning.effectiveInvoiceAmounts(s.db.data(s.invoicePath)).amount,1350);
 assert.equal(s.db.data("members/member").creditBalance,0);
 await s.mutate("confirmPayment",{invoiceId:"quarter-test-plan-member"});
 assert.equal(s.db.data("members/member").creditBalance,0);
});
test("bulk void reports per-item failures and refuses paid items", async () => {
 const s=setup(); s.db.seed("members/admin",{displayName:"社長",membershipStatus:"MEMBER",role:"ADMIN",creditBalance:0});
 await s.confirm(); await s.bill();
 await s.mutate("reportPayment",{invoiceId:"quarter-test-plan-admin"},admin);
 const result=await s.mutate("voidInvoiceBatch",{reason:"批次更正",invoices:JSON.stringify([{id:"quarter-test-plan-member",amount:1500},{id:"quarter-test-plan-admin",amount:1500}])});
 assert.equal(result.results.filter(entry=>entry.success).length,1);
 assert.equal(result.results.filter(entry=>!entry.success).length,1);
 assert.equal(s.db.data("invoices/quarter-test-plan-admin").status,"REPORTED");
});
test("invoice management requires administrator and rejects ledger entries", async () => {
 const s=setup(); await s.confirm(); await s.bill();
 for (const action of ["voidInvoice","reissueInvoice","refundInvoice","rejectPaymentReport","voidInvoiceBatch"]) await assert.rejects(s.mutate(action,managementInput(s),member),/只有幹部/);
 s.db.seed("invoices/credit-test",{type:"CREDIT",status:"CONFIRMED",amount:-100,memberId:"member"});
 await assert.rejects(s.mutate("voidInvoice",managementInput(s,"credit-test")),/調整紀錄/);
});
test("summary counts distinct people, excludes refunds/void bills and separates pending from reported",()=>{
 const base={id:"one",member_id:"member",memberName:"小明",type:"QUARTERLY_MEMBER",status:"PENDING",gross_amount:1500,credit_applied:0,amount:1500};
 const invoices=[base,{...base,id:"two",type:"SINGLE_EVENT",amount:180},{...base,id:"reported",member_id:"second",status:"REPORTED",amount:200},{...base,id:"credit",type:"CREDIT",status:"CONFIRMED",amount:-150},{...base,id:"void",status:"VOID",amount:999}];
 const summary=billingView.billingSummary(invoices);
 assert.equal(summary.unpaidPeople,1);assert.equal(summary.unpaidAmount,1680);assert.equal(summary.reportedAmount,200);
 assert.equal(billingView.groupByPerson(invoices)[0].invoices.length,2);
});
test("event counts are not settled for missing bills or reported transfers; shared quarterly bill counted once per payer",()=>{
 const event={id:"event",courts:"A",bookings:[{memberId:"member",name:"小明",kind:"社員"},{memberId:"guest",name:"小王",kind:"非社員",transferred:true}]};
 const invoice={id:"one",member_id:"member",memberName:"小明",type:"QUARTERLY_MEMBER",status:"REPORTED",gross_amount:1500,credit_applied:0,amount:1500,event_ids:["event","event2"]};
 assert.equal(billingView.activityPayments(event,[]).complete,false);
 const progress=billingView.activityPayments(event,[invoice]);assert.equal(progress.reported,1);assert.equal(progress.exempt,1);assert.equal(progress.complete,false);
 assert.equal(billingView.activityPayments(event,[{...invoice,status:"CONFIRMED"}]).complete,true);
 assert.equal(billingView.activityPayments({...event,bookings:[]},[]).complete,false);
});
test("period filter keeps full quarterly bill in its own period and can identify out-of-range unpaid bills",()=>{
 const invoice={id:"one",member_id:"member",memberName:"小明",type:"QUARTERLY_MEMBER",status:"PENDING",gross_amount:1500,credit_applied:0,amount:1500,period_start:"2026-01-01",period_end:"2026-03-31"};
 assert.equal(billingView.invoiceInRange(invoice,"2026-04-01","2026-06-30"),false);
 assert.equal(billingView.isOpen(invoice),true);
 assert.equal(billingView.invoiceInRange(invoice,"2026-01-01","2026-03-31"),true);
});
test("administrator can report and confirm their own membership payment", async () => {
  const s = setup();
  s.db.seed("members/admin", { displayName: "社長", membershipStatus: "MEMBER", role: "ADMIN", creditBalance: 0 });
  await s.confirm(); await s.bill();
  await s.mutate("reportPayment", { invoiceId: "quarter-test-plan-admin" }, admin);
  assert.equal(s.db.data("invoices/quarter-test-plan-admin").status, "REPORTED");
  await s.mutate("confirmPayment", { invoiceId: "quarter-test-plan-admin" }, admin);
  assert.equal(s.db.data("invoices/quarter-test-plan-admin").status, "CONFIRMED");
});
test("billing shows direct receipt for both pending and reported bills, while optional actions stay scoped", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const source = fs.readFileSync(path.resolve(__dirname, "../src/app/page.tsx"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  const dashboard = loadTs("src/app/billing-dashboard.tsx", { "@/lib/billing-view": billingView });
  const dependencies = { "@simplewebauthn/browser": {}, "@/app/quarter-planner": { default: () => null }, "@/app/billing-dashboard": dashboard, "@/lib/billing-view": billingView, "@/lib/quarter-planning": planning };
  dependencies["@/app/loading-screen"] = loadingScreen;
  dependencies["@/app/floating-notifications"] = { default: () => null };
  dependencies["@/app/balance-history-dialog"] = balanceHistoryDialog;
  dependencies["@/app/shuttle-art"] = shuttleArt;
  dependencies["@/lib/club-roles"] = clubRoles;
  new Function("require", "module", "exports", code + "\nmodule.exports.BillingForTest = Billing;")((id) => dependencies[id] ?? require(id), loaded, loaded.exports);
  const props = { admin: true, viewer: { ...admin, creditBalance: 0 }, saving: false, reportPayment() {}, remindPayment() {}, openRates() {}, async manage() { return null; } };
  const invoice = { id: "invoice", member_id: admin.id, memberName: admin.name, type: "QUARTERLY_MEMBER", gross_amount: 1500, credit_applied: 0, amount: 1500, status: "PENDING" };
  const render = (entry) => renderToStaticMarkup(React.createElement(loaded.exports.BillingForTest, { ...props, invoices: [entry] }));
  const own = render(invoice);
  assert.match(own, /回報已轉帳（選用）/);
  assert.match(own, /登記收款/);
  assert.doesNotMatch(own, /提醒繳費/);
  const others = render({ ...invoice, member_id: "someone-else" });
  assert.match(others, /提醒繳費/);
  assert.doesNotMatch(others, /回報已轉帳/);
  assert.match(render({ ...invoice, status: "REPORTED" }), /登記收款/);
  assert.doesNotMatch(render({ ...invoice, status: "CONFIRMED" }), /回報已轉帳|提醒繳費|登記收款/);
});
const admin = { id: "admin", name: "社長", role: "ADMIN" };
const member = { id: "member", name: "社員", role: "MEMBER" };
const transforms = {
  increment: (value) => ({ operation: "increment", value }),
  arrayUnion: (...value) => ({ operation: "union", value }),
};
class FakeTimestamp {}
// An in-memory Firestore adapter: checks all reads precede writes and rolls the whole transaction back on failure.
// This exercises application behavior; it does not emulate distributed contention or production Firestore limits.
function database() {
  let records = new Map();
  const snapshot = (ref) => ({ id: ref.id, ref, exists: records.has(ref.path), data: () => structuredClone(records.get(ref.path)) });
  const apply = (op) => {
    if (op.kind === "delete") { records.delete(op.ref.path); return; }
    const previous = records.get(op.ref.path);
    if (op.kind === "create" && previous) throw new Error("ALREADY_EXISTS");
    if (op.kind === "update" && !previous) throw new Error("NOT_FOUND");
    const next = op.kind === "set" && !op.merge ? {} : structuredClone(previous ?? {});
    for (const [key, value] of Object.entries(op.data)) {
      if (value?.operation === "increment") next[key] = Number(next[key] ?? 0) + value.value;
      else if (value?.operation === "union") next[key] = [...(next[key] ?? []), ...value.value.filter((entry) => !(next[key] ?? []).some((old) => JSON.stringify(old) === JSON.stringify(entry)))];
      else next[key] = structuredClone(value);
    }
    records.set(op.ref.path, next);
  };
  const reference = (pathname) => ({
    path: pathname, id: pathname.split("/").at(-1),
    get: async () => snapshot(reference(pathname)),
    collection: (name) => query(pathname + "/" + name),
    create: async (data) => apply({ kind: "create", ref: reference(pathname), data }),
    update: async (data) => apply({ kind: "update", ref: reference(pathname), data }),
    set: async (data, options) => apply({ kind: "set", ref: reference(pathname), data, merge: options?.merge }),
  });
  const query = (pathname, filters = []) => ({
    doc: (id = randomUUID()) => reference(pathname + "/" + id),
    where: (field, op, value) => query(pathname, [...filters, { field, op, value }]),
    get: async () => {
      const docs = [...records.entries()].filter(([key, data]) => key.startsWith(pathname + "/") && key.split("/").length === pathname.split("/").length + 1 && filters.every(({ field, op, value }) => {
        if (op === "array-contains") return data[field]?.includes(value);
        if (op === ">=") return data[field] >= value;
        if (op === "<=") return data[field] <= value;
        return data[field] === value;
      })).map(([key]) => snapshot(reference(key)));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });
  const db = {
    collection: query,
    collectionGroup: (name) => ({ get: async () => ({
      docs: [...records.keys()].filter((key) => key.split("/").at(-2) === name).map((key) => snapshot(reference(key))),
    }) }),
    getAll: async (...refs) => refs.map(snapshot),
    runTransaction: async (callback) => {
      if (db.beforeNextTransaction) {
        const hook = db.beforeNextTransaction;
        db.beforeNextTransaction = null;
        await hook();
      }
      const operations = [];
      const read = async (ref) => { if (operations.length) throw new Error("Firestore read after write"); return ref.get(); };
      const transaction = { get: read, getAll: async (...refs) => Promise.all(refs.map(read)) };
      for (const kind of ["create", "update", "set", "delete"]) transaction[kind] = (ref, data, options) => operations.push({ kind, ref, data, merge: options?.merge });
      const result = await callback(transaction);
      const before = structuredClone(records);
      try {
        for (const operation of operations) apply(operation);
        const movements = [...records.entries()].filter(([key]) => key.startsWith("balanceMovements/") && !before.has(key)).map(([, value]) => value);
        const memberKeys = new Set([...before.keys(), ...records.keys()].filter((key) => key.startsWith("members/") && key.split("/").length === 2));
        for (const key of memberKeys) {
          const delta = Number(records.get(key)?.creditBalance ?? 0) - Number(before.get(key)?.creditBalance ?? 0);
          const recorded = movements.filter((entry) => entry.memberId === key.split("/")[1]).reduce((sum, entry) => sum + entry.amount, 0);
          assert.equal(recorded, delta, "Atomic balance ledger must match the actual member balance change: " + key);
        }
      } catch (error) { records = before; throw error; }
      return result;
    },
    data: (key) => structuredClone(records.get(key)),
    entries: (prefix) => [...records.entries()].filter(([key]) => key.startsWith(prefix)),
    seed: (key, value) => records.set(key, structuredClone(value)),
  };
  return db;
}
function setup(balance = 0, fetchOfficialClosures = async () => []) {
  const db = database();
  db.seed("members/member", { displayName: "社員", membershipStatus: "MEMBER", role: "MEMBER", creditBalance: balance });
  db.seed("members/admin", { displayName: "社長", membershipStatus: "GUEST", role: "ADMIN", creditBalance: 0 });
  const invoiceManagement = loadTs("src/lib/invoice-management.ts", { "@/lib/balance-ledger": balanceLedger, "firebase-admin/firestore": { Timestamp: FakeTimestamp, FieldValue: transforms }, "@/lib/firebase-admin": { getAdminFirestore: () => db }, "@/lib/quarter-planning": planning });
  const backend = loadTs("src/lib/firestore-database.ts", {
    "@/lib/invoice-management": invoiceManagement,
    "@/lib/balance-ledger": balanceLedger,
    "@/lib/member-names.mjs": memberNames,
    "firebase-admin/firestore": { Timestamp: FakeTimestamp, FieldValue: transforms },
    "@/lib/firebase-admin": { getAdminFirestore: () => db },
    "@/lib/device-auth": { createClaimCodeRecord: () => ({ code: "test-claim-code", salt: "test-salt", hash: "test-hash" }), viewerFromMember: (id, data) => ({ id, name: data.displayName, role: data.role, membershipStatus: data.membershipStatus, primaryAdmin: clubRoles.isClubPresident(data), creditBalance: data.creditBalance ?? 0, accountType: data.accountType }) },
    "@/lib/club-roles": clubRoles,
    "@/lib/quarter-planning": planning,
    "@/lib/official-closures": { fetchOfficialClosures },
  });
  const year = new Date().getUTCFullYear() + 1;
  const rules = { label: "第一季", startDate: year + "-01-01", endDate: year + "-03-31", weekday: 5, startTime: "19:00", endTime: "21:00", courts: "A 場", regularCapacity: 10, standbyCapacity: 4, excludedDates: [] };
  const activities = planning.suggestActivities(rules).slice(0, 10);
  const mutate = (action, input = {}, actor = admin) => backend.mutate(action, input, actor);
  const readState = (actor) => backend.readState(actor);
  const confirm = (schedule = { rules, activities }, planId = "test-plan", actor = admin) => mutate("confirmQuarterPlan", { planId, schedule: JSON.stringify(schedule) }, actor);
  const bill = () => mutate("createQuarterlyInvoices", { planId: "test-plan", dueDate: year + "-01-15" });
  const invoicePath = "invoices/quarter-test-plan-member";
  return { db, mutate, readState, rules, activities, confirm, bill, invoicePath };
}

function receiptRequest(invoices, overrides = {}) {
  return { invoices: JSON.stringify(invoices), method: "CASH", receivedDate: "2025-01-02", note: "活動現場收款", ...overrides };
}

test("manual receipt records exact cash from pending and reported bills atomically and preserves staff-only details", async () => {
  const s = setup();
  const billed = { memberId: member.id, memberNameSnapshot: member.name, type: "QUARTERLY_MEMBER", grossAmount: 150, creditApplied: 20, amount: 130 };
  s.db.seed("invoices/manual-a", { ...billed, status: "PENDING" });
  s.db.seed("invoices/manual-b", { ...billed, type: "SINGLE_EVENT", status: "REPORTED", reportedAt: new Date("2025-01-01T00:00:00Z") });
  const input = receiptRequest([{ id: "manual-a", amount: 130 }, { id: "manual-b", amount: 130 }]);
  assert.deepEqual(await s.mutate("recordInvoiceReceipts", input), { recorded: 2, alreadyRecorded: 0, totalAmount: 260 });
  for (const id of ["manual-a", "manual-b"]) {
    const entry = s.db.data("invoices/" + id);
    assert.equal(entry.status, "CONFIRMED");
    assert.equal(entry.confirmedBy, admin.id);
    assert.ok(entry.confirmedAt instanceof Date);
    assert.deepEqual(entry.receipt, { method: "CASH", receivedDate: input.receivedDate, amount: 130, note: input.note, recordedBy: admin.id, recordedByName: admin.name, recordedAt: entry.confirmedAt });
  }
  assert.ok(s.db.data("invoices/manual-b").reportedAt instanceof Date);
  assert.equal(s.db.entries("notifications/").length, 2);
  const audits = s.db.entries("auditLogs/").map(([, entry]) => entry);
  assert.deepEqual(audits.map((entry) => [entry.action, entry.totalAmount, entry.invoices.length]), [["RECORD_INVOICE_RECEIPTS", 260, 2]]);
  const beforeRetry = s.db.entries("");
  assert.deepEqual(await s.mutate("recordInvoiceReceipts", input), { recorded: 0, alreadyRecorded: 2, totalAmount: 0 });
  await assert.rejects(s.mutate("recordInvoiceReceipts", { ...input, method: "BANK" }), /已變更/);
  assert.deepEqual(s.db.entries(""), beforeRetry);
  const ownInvoice = (await s.readState(member)).invoices.find((entry) => entry.id === "manual-a");
  assert.deepEqual([ownInvoice.receipt_method, ownInvoice.receipt_received_date, ownInvoice.receipt_amount], ["CASH", input.receivedDate, 130]);
  assert.deepEqual([ownInvoice.receipt_note, ownInvoice.receipt_recorded_by, ownInvoice.receipt_recorded_at], [undefined, undefined, undefined]);
  const staffInvoice = (await s.readState(admin)).invoices.find((entry) => entry.id === "manual-a");
  assert.deepEqual([staffInvoice.receipt_note, staffInvoice.receipt_recorded_by_name, staffInvoice.receipt_recorded_at], [input.note, admin.name, s.db.data("invoices/manual-a").confirmedAt.toISOString()]);
});

test("manual receipt refuses stale total, invalid date, foreign status, and demoted staff without posting any partial payments", async () => {
  const s = setup();
  const eligible = { memberId: member.id, memberNameSnapshot: member.name, type: "MEMBER_EXTRA", grossAmount: 200, creditApplied: 50, amount: 150, status: "PENDING" };
  s.db.seed("invoices/valid-receipt", eligible);
  s.db.seed("invoices/stale-receipt", { ...eligible, adjustedAmount: 100 });
  s.db.seed("invoices/closed-receipt", { ...eligible, status: "VOID" });
  const one = { id: "valid-receipt", amount: 150 };
  const submit = (rows, overrides, actor) => s.mutate("recordInvoiceReceipts", receiptRequest(rows, overrides), actor);
  const before = s.db.entries("");
  await assert.rejects(submit([one, { id: "stale-receipt", amount: 150 }]), /已變更/);
  await assert.rejects(submit([one, { id: "closed-receipt", amount: 150 }]), /已變更/);
  for (const receivedDate of ["2025-02-30", "9999-12-31"]) await assert.rejects(submit([one], { receivedDate }), /收款日期/);
  await assert.rejects(submit([one, one]), /不重複/);
  await assert.rejects(submit([one], {}, member), /只有幹部/);
  assert.deepEqual(s.db.entries(""), before);
  s.db.beforeNextTransaction = () => s.db.seed("members/admin", { ...s.db.data("members/admin"), role: "MEMBER" });
  await assert.rejects(submit([one]), /幹部權限已變更/);
  assert.equal(s.db.data("invoices/valid-receipt").status, "PENDING");
  assert.deepEqual(s.db.entries("notifications/"), []);
});

test("manual receipt and the original confirmation route settle held old credits only once", async () => {
  const s = setup();
  const bill = "old-guest-receipt";
  const effect = "old-credit-release";
  s.db.seed("invoices/" + bill, { memberId: member.id, memberNameSnapshot: member.name, type: "SINGLE_EVENT", grossAmount: 180, creditApplied: 50, amount: 130, status: "REPORTED" });
  s.db.seed("invoices/" + effect, { memberId: member.id, relatedInvoiceId: bill, type: "CREDIT", amount: -180, status: "AWAITING_PAYMENT_CONFIRMATION" });
  const input = receiptRequest([{ id: bill, amount: 130 }], { method: "BANK", note: "" });
  assert.deepEqual(await s.mutate("recordInvoiceReceipts", input), { recorded: 1, alreadyRecorded: 0, totalAmount: 130 });
  assert.equal(s.db.data("members/" + member.id).creditBalance, 180);
  assert.equal(s.db.data("invoices/" + effect).status, "CONFIRMED");
  assert.equal(s.db.entries("balanceMovements/").length, 1);
  const beforeRetry = s.db.entries("");
  await s.mutate("confirmPayment", { invoiceId: bill });
  assert.deepEqual(await s.mutate("recordInvoiceReceipts", input), { recorded: 0, alreadyRecorded: 1, totalAmount: 0 });
  assert.deepEqual(s.db.entries(""), beforeRetry);
});

test("guest booking reserves a place without creating a bill or deducting balance", async () => {
  const s = setup();
  const guest = { id: "guest-booking", name: "零打球友", role: "MEMBER" };
  s.db.seed("members/" + guest.id, { displayName: guest.name, membershipStatus: "GUEST", creditBalance: 60 });
  const startsAt = new Date(Date.now() + 3_600_000);
  s.db.seed("events/guest-booking-event", { startsAt, endsAt: new Date(+startsAt + 3_600_000), status: "SCHEDULED", regularCapacity: 10, guestFeeSnapshot: 180 });
  await s.mutate("join", { eventId: "guest-booking-event" }, guest);
  assert.equal(s.db.data("events/guest-booking-event/bookings/" + guest.id).status, "REGULAR");
  assert.equal(s.db.entries("invoices/").length, 0);
  assert.equal(s.db.entries("balanceMovements/").length, 0);
  assert.equal(s.db.data("members/" + guest.id).creditBalance, 60);
});

test("post-event guest settlement requires a complete staff decision, preserves legacy bills, and issues once", async () => {
  const s = setup();
  const eventId = "guest-settlement-event";
  const eventPath = "events/" + eventId;
  const past = { startsAt: new Date(Date.now() - 7_200_000), endsAt: new Date(Date.now() - 3_600_000), status: "SCHEDULED", guestFeeSnapshot: 190 };
  // Include a future event and records that must never be issued post-event:
  // legacy invoice, no-show, standby, member, and privately transferred booking.
  s.db.seed(eventPath, { ...past, endsAt: new Date(Date.now() + 3_600_000) });
  const guestBalance = 60;
  for (const [id, booking] of [
    ["billed", {}], ["skipped", {}], ["legacy", {}], ["standby", { status: "STANDBY" }],
    ["member", { kindSnapshot: "MEMBER" }], ["private", { transferredFromMemberId: "someone" }],
  ]) {
    s.db.seed("members/" + id, { displayName: id, membershipStatus: "GUEST", creditBalance: id === "billed" ? guestBalance : 0 });
    s.db.seed(eventPath + "/bookings/" + id, { eventId, memberId: id, kindSnapshot: "GUEST", status: "REGULAR", ...booking });
  }
  s.db.seed("invoices/legacy-guest-bill", { eventId, memberId: "legacy", type: "SINGLE_EVENT", status: "PENDING", amount: 170 });
  const choices = [{ memberId: "billed", decision: "BILL" }, { memberId: "skipped", decision: "SKIP" }];
  const publish = (decisions, actor) => s.mutate("publishGuestEventBills", { eventId, decisions: JSON.stringify(decisions) }, actor);
  const before = s.db.entries("");
  await assert.rejects(publish(choices), /活動結束後/);
  await assert.rejects(publish(choices, member), /只有幹部/);
  assert.deepEqual(s.db.entries(""), before);
  s.db.seed(eventPath, past);
  await assert.rejects(s.mutate("cancel", { eventId }, { id: "billed", name: "billed", role: "MEMBER" }), /不能自行取消/);
  const afterDates = s.db.entries("");
  await assert.rejects(publish(choices.slice(0, 1)), /名單已變更/);
  for (const id of ["legacy", "standby", "member", "private"]) {
    await assert.rejects(publish([...choices, { memberId: id, decision: "BILL" }]), /名單已變更/);
  }
  assert.deepEqual(s.db.entries(""), afterDates);
  assert.deepEqual(await publish(choices), { issued: 1, skipped: 1 });
  const invoices = s.db.entries("invoices/").map(([, bill]) => bill);
  assert.equal(invoices.length, 2);
  const invoice = invoices.find((bill) => bill.memberId === "billed");
  assert.equal(invoice.grossAmount, 190);
  assert.equal(invoice.creditApplied, guestBalance);
  assert.equal(invoice.amount, 190 - guestBalance);
  assert.equal(invoice.status, "PENDING");
  assert.ok(invoice.dueAt > new Date());
  assert.equal(s.db.data("members/billed").creditBalance, 0);
  assert.equal(s.db.entries("balanceMovements/").length, 1);
  assert.deepEqual(s.db.data(eventPath).guestSettlements, [
    { memberId: "billed", status: "ISSUED", amount: 130 },
    { memberId: "skipped", status: "SKIPPED", amount: null },
  ]);
  const after = s.db.entries("");
  assert.deepEqual(await publish(choices.toReversed()), { issued: 0, skipped: 0 });
  await assert.rejects(publish([{ ...choices[0], decision: "SKIP" }, choices[1]]), /名單已變更/);
  assert.deepEqual(s.db.entries(""), after);
});

test("cancelled legacy guest charges never release unconfirmed funds", async () => {
  for (const mode of ["cancel", "cancelEvent"]) {
    const s = setup();
    const guest = { id: "guest-cancellation", name: "零打球友", role: "MEMBER" };
    const eventId = "guest-cancellation-event";
    const invoiceId = "legacy-reported-guest-bill";
    const startsAt = new Date(Date.now() + 3_600_000);
    s.db.seed("members/" + guest.id, { displayName: guest.name, membershipStatus: "GUEST", creditBalance: 5 });
    s.db.seed("events/" + eventId, { startsAt, endsAt: new Date(+startsAt + 3_600_000), status: "SCHEDULED", regularCount: 1, standbyCount: 0 });
    s.db.seed("events/" + eventId + "/bookings/" + guest.id, { eventId, memberId: guest.id, kindSnapshot: "GUEST", status: "REGULAR" });
    s.db.seed("invoices/" + invoiceId, { eventId, memberId: guest.id, memberNameSnapshot: guest.name, type: "SINGLE_EVENT", status: "REPORTED", grossAmount: 180, creditApplied: 20, amount: 160 });
    await s.mutate(mode, { eventId }, mode === "cancel" ? guest : admin);
    assert.equal(s.db.data("members/" + guest.id).creditBalance, 5);
    assert.equal(s.db.data("invoices/" + invoiceId).status, "REPORTED");
    assert.equal(s.db.data(`invoices/credit-${eventId}-${invoiceId}`).status, "AWAITING_PAYMENT_CONFIRMATION");
    if (mode === "cancel") {
      await s.mutate("rejectPaymentReport", { invoiceId, expectedStatus: "REPORTED", expectedAmount: "160", reason: "測試未入帳", checkedNotReceived: "true" });
      assert.equal(s.db.data("members/" + guest.id).creditBalance, 25);
    } else {
      await s.mutate("confirmPayment", { invoiceId });
      await s.mutate("confirmPayment", { invoiceId });
      assert.equal(s.db.data("members/" + guest.id).creditBalance, 185);
    }
  }
});

test("a later event cancellation leaves previously settled guest credit unchanged", async () => {
  const s = setup();
  const guest = { id: "guest-credit", name: "零打球友", role: "MEMBER" };
  const eventId = "guest-credit-event";
  const invoiceId = "legacy-guest-credit-bill";
  const startsAt = new Date(Date.now() + 3_600_000);
  s.db.seed("members/" + guest.id, { displayName: guest.name, membershipStatus: "GUEST", creditBalance: 0 });
  s.db.seed("events/" + eventId, { startsAt, endsAt: new Date(+startsAt + 3_600_000), status: "SCHEDULED", regularCount: 1, standbyCount: 0 });
  s.db.seed("events/" + eventId + "/bookings/" + guest.id, { eventId, memberId: guest.id, kindSnapshot: "GUEST", status: "REGULAR" });
  s.db.seed("invoices/" + invoiceId, { eventId, memberId: guest.id, memberNameSnapshot: guest.name, type: "SINGLE_EVENT", status: "REPORTED", grossAmount: 180, creditApplied: 50, amount: 130 });
  await s.mutate("cancel", { eventId }, guest);
  await s.mutate("confirmPayment", { invoiceId });
  assert.equal(s.db.data("members/" + guest.id).creditBalance, 180);
  await s.mutate("cancelEvent", { eventId });
  assert.equal(s.db.data("events/" + eventId).status, "CANCELLED");
  assert.equal(s.db.data("members/" + guest.id).creditBalance, 180);
  assert.equal(s.db.entries("balanceMovements/").length, 1);
});

test("suggestions follow the selected weekday, including weekends, and honor explicit exclusions", () => {
  const { rules } = setup();
  const suggestions = planning.suggestActivities(rules);
  assert.ok(suggestions.every((entry) => new Date(entry.date).getUTCDay() === 5));
  assert.equal(planning.suggestActivities({ ...rules, excludedDates: [suggestions[0].date] }).length, suggestions.length - 1);
  for (const weekday of [0, 6]) {
    // Legacy rules can still contain the retired flag.
    const weekendSuggestions = planning.suggestActivities({ ...rules, weekday, excludeWeekends: true });
    assert.ok(weekendSuggestions.length > 0);
    assert.ok(weekendSuggestions.every((entry) => new Date(entry.date).getUTCDay() === weekday));
  }
  assert.doesNotThrow(() => planning.validateQuarterSchedule(rules, [suggestions[0], suggestions[0]]));
  assert.equal(planning.validCalendarDate("2027-02-30"), false);
  assert.throws(() => planning.validateQuarterSchedule(rules, [{ ...suggestions[0], date: "2027-02-30" }]));
});
test("unpaid reduction preserves original values and returns excess previously applied credit", () => {
  const original = { grossAmount: 1500, creditApplied: 1450, amount: 50 };
  const result = planning.reduceUnpaidInvoice(original, 150);
  assert.deepEqual(result, { adjustedGrossAmount: 1350, adjustedCreditApplied: 1350, adjustedAmount: 0, restoredCredit: 100 });
  assert.equal(original.grossAmount, 1500);
});
test("direct confirmation publishes one schedule and accepts an equivalent retry", async () => {
  const s = setup();
  assert.equal(s.db.entries("quarterPlans/").length, 0);
  assert.equal(s.db.entries("events/").length, 0);
  const confirmed = await s.confirm();
  const after = s.db.entries("");
  assert.deepEqual(confirmed, { planId: "test-plan", eventCount: 10, totalAmount: 1500, skippedDates: [] });
  assert.deepEqual(await s.confirm({ activities: s.activities.toReversed(), rules: s.rules }), confirmed);
  await assert.rejects(s.confirm({ rules: s.rules, activities: s.activities.slice(1) }));
  assert.deepEqual(s.db.entries(""), after);
  assert.equal(s.db.data("quarterPlans/test-plan").status, "CONFIRMED");
  assert.equal(s.db.entries("events/").filter(([key]) => key.split("/").length === 2).length, 10);
  assert.equal(s.db.data("billingPeriods/quarter-test-plan").eventCount, 10);
  assert.equal(s.db.data("billingPeriods/quarter-test-plan").grossAmount, 1500);
});
test("legacy drafts cannot be published and the draft save action no longer exists", async () => {
  const s = setup();
  s.db.seed("quarterPlans/old-draft", { id: "old-draft", ...s.rules, activities: s.activities, status: "DRAFT", revision: 1 });
  const before = s.db.entries("");
  await assert.rejects(s.confirm({ rules: s.rules, activities: s.activities }, "old-draft"));
  await assert.rejects(s.mutate("saveQuarterDraft", { planId: "new-draft", revision: "0", draft: JSON.stringify({ rules: s.rules, activities: s.activities }) }), /不支援/);
  assert.deepEqual(s.db.entries(""), before);
});
test("direct confirmation rejects missing or invalid input without official lookup or writes", async () => {
  let checks = 0;
  const s = setup(0, async () => { checks++; return []; });
  const schedule = JSON.stringify({ rules: s.rules, activities: s.activities });
  const before = s.db.entries("");
  for (const payload of [
    { planId: "test-plan" },
    { planId: "bad/id", schedule },
    { planId: "test-plan", schedule: "{" },
    { planId: "test-plan", schedule: JSON.stringify({ rules: s.rules, activities: [] }) },
  ]) {
    await assert.rejects(s.mutate("confirmQuarterPlan", payload));
  }
  assert.equal(checks, 0);
  assert.deepEqual(s.db.entries(""), before);
});
test("confirmation checks the proposed activities for national holidays and New Taipei closures", async () => {
  const calls = [];
  const s = setup(0, async (...range) => { calls.push(range); return officialDates; });
  const officialDates = [
    { date: s.activities[0].date, name: "國定假日", kind: "holiday" },
    { date: s.activities[2].date, name: "新北市停班停課", kind: "closure" },
  ];
  const before = s.db.entries("");
  await assert.rejects(s.confirm(), (error) => {
    assert.match(error.message, /國定假日或新北市停班停課/);
    for (const { date } of officialDates) assert.ok(error.message.includes(date));
    return true;
  });
  assert.deepEqual(calls, [[s.rules.startDate, s.rules.endDate]]);
  assert.deepEqual(s.db.entries(""), before);
});
test("an official feed failure writes nothing and a confirmed retry avoids the feed", async () => {
  let available = false;
  let checks = 0;
  const s = setup(0, async () => {
    checks++;
    if (!available) throw new Error("官方行事曆暫時無法讀取");
    return [];
  });
  const before = s.db.entries("");
  await assert.rejects(s.confirm(), /官方行事曆暫時無法讀取/);
  assert.deepEqual(s.db.entries(""), before);
  available = true;
  const confirmed = await s.confirm();
  available = false;
  assert.deepEqual(await s.confirm(), confirmed);
  assert.equal(checks, 2);
});
test("an overlapping retry returns a concurrent confirmation even if its own calendar read fails", async () => {
  const enteredCalendar = Promise.withResolvers();
  const calendar = Promise.withResolvers();
  let checks = 0;
  const s = setup(0, async () => {
    checks++;
    if (checks === 1) {
      enteredCalendar.resolve();
      return calendar.promise;
    }
    return [];
  });
  const first = s.confirm();
  try {
    await Promise.race([enteredCalendar.promise, first]);
    assert.equal(checks, 1);
    const confirmed = await s.confirm();
    const after = s.db.entries("");
    calendar.reject(new Error("官方行事曆暫時無法讀取"));
    assert.deepEqual(await first, confirmed);
    assert.deepEqual(s.db.entries(""), after);
  } finally {
    calendar.resolve([]);
    await first.catch(() => {});
  }
});
test("confirmation rechecks administrator permissions after loading closures", async () => {
  const s = setup(0, async () => {
    s.db.seed("members/admin", { ...s.db.data("members/admin"), role: "MEMBER" });
    return [];
  });
  const otherRecords = () => s.db.entries("").filter(([key]) => key !== "members/admin");
  const before = otherRecords();
  await assert.rejects(s.confirm(), /幹部權限已變更/);
  assert.equal(s.db.data("members/admin").role, "MEMBER");
  assert.deepEqual(otherRecords(), before);
});
test("quarter confirmation only creates and bills new Taipei activity dates", async () => {
  const s = setup();
  const indexedDate = s.activities[5].date;
  const legacyDate = s.activities[6].date;
  const repeatedDate = s.activities[0].date;
  s.db.seed("events/legacy-without-index", { status: "SCHEDULED", startsAt: new Date(legacyDate + "T00:30:00+08:00"), courts: "既有場地" });
  // A separately created booking reserve arrives after the suggested list was built.
  s.db.beforeNextTransaction = () => s.db.seed("eventDates/" + indexedDate, { eventId: "existing" });
  const input = { rules: s.rules, activities: [...s.activities, { ...s.activities[0], courts: "第二筆重複" }] };
  const result = await s.confirm(input);
  assert.deepEqual(result, { planId: "test-plan", eventCount: 8, totalAmount: 1200, skippedDates: [repeatedDate, indexedDate, legacyDate].sort() });
  const plan = s.db.data("quarterPlans/test-plan");
  assert.equal(plan.activities.filter((event) => event.date === repeatedDate).length, 1);
  assert.equal(plan.activities.find((event) => event.date === repeatedDate).courts, s.activities[0].courts);
  assert.ok(plan.activities.every((event) => ![indexedDate, legacyDate].includes(event.date)));
  assert.equal(s.db.data("events/legacy-without-index").courts, "既有場地");
  assert.equal(s.db.data("eventDates/" + indexedDate).eventId, "existing");
  assert.equal(s.db.data("eventDates/" + legacyDate), undefined);
  assert.deepEqual(await s.confirm(input), result);
  const period = s.db.data("billingPeriods/quarter-test-plan");
  assert.equal(period.eventCount, 8);
  assert.equal(period.grossAmount, 1200);
  assert.ok(!period.eventIds.includes("legacy-without-index"));
  await s.bill();
  assert.equal(s.db.data(s.invoicePath).amount, 1200);
  assert.equal(s.db.data(s.invoicePath).eventIds.length, 8);
});
test("a duplicate-only quarter does not create another plan, period or notification", async () => {
  const s = setup();
  await s.confirm();
  const before = s.db.entries("");
  assert.deepEqual(await s.confirm(undefined, "all-duplicates"), {
    planId: "all-duplicates", eventCount: 0, totalAmount: 0, skippedDates: s.activities.map((event) => event.date).sort(),
  });
  assert.deepEqual(s.db.entries(""), before);
});
test("quarter confirmation still blocks a new overlapping charge period", async () => {
  const s = setup();
  await s.confirm({ rules: s.rules, activities: s.activities.slice(0, 1) });
  const before = s.db.entries("");
  await assert.rejects(s.confirm(undefined, "overlapping-period"), /計費期間重疊/);
  assert.deepEqual(s.db.entries(""), before);
});
test("non-admin cannot confirm a quarter or generate invoices", async () => {
  const s = setup();
  await assert.rejects(s.confirm(undefined, undefined, member), /只有幹部/);
  await assert.rejects(s.mutate("createQuarterlyInvoices", {}, member), /只有幹部/);
});
test("cancel before billing preserves ten-event baseline and adds visible reduction; no duplicate bills", async () => {
  const s = setup(); await s.confirm();
  await s.mutate("cancelEvent", { eventId: "quarter-test-plan-0" });
  await s.bill();
  const invoice = s.db.data(s.invoicePath);
  assert.equal(invoice.eventIds.length, 10);
  assert.equal(invoice.grossAmount, 1500);
  assert.equal(invoice.amount, 1500);
  assert.equal(invoice.adjustedAmount, 1350);
  assert.equal(invoice.adjustments.length, 1);
  assert.equal(s.db.data("billingPeriods/quarter-test-plan").eventCount, 10);
  await assert.rejects(s.bill(), /已經建立/);
});
test("cancel unpaid bill records delta, preserves baseline and is idempotent", async () => {
  const s = setup(1450); await s.confirm(); await s.bill();
  await s.mutate("cancelEvent", { eventId: "quarter-test-plan-0" });
  await s.mutate("cancelEvent", { eventId: "quarter-test-plan-0" });
  const invoice = s.db.data(s.invoicePath);
  assert.equal(invoice.grossAmount, 1500);
  assert.equal(invoice.eventIds.length, 10);
  assert.equal(invoice.adjustedAmount, 0);
  assert.equal(invoice.adjustments.length, 1);
  assert.equal(s.db.data("members/member").creditBalance, 100);
});
test("reported transfer cancellation does not release credit until administrator confirms; repeat confirmation does not refund twice", async () => {
  const s = setup(); await s.confirm(); await s.bill();
  await s.mutate("reportPayment", { invoiceId: "quarter-test-plan-member" }, member);
  await s.mutate("cancelEvent", { eventId: "quarter-test-plan-0" });
  assert.equal(s.db.data("members/member").creditBalance, 0);
  assert.equal(s.db.data(s.invoicePath).amount, 1500);
  await s.mutate("confirmPayment", { invoiceId: "quarter-test-plan-member" });
  await s.mutate("confirmPayment", { invoiceId: "quarter-test-plan-member" });
  assert.equal(s.db.data("members/member").creditBalance, 150);
  assert.equal(s.db.data(s.invoicePath).eventIds.length, 10);
});
test("confirmed payment cancellation credits account and keeps paid invoice immutable", async () => {
  const s = setup(); await s.confirm(); await s.bill();
  await s.mutate("confirmPayment", { invoiceId: "quarter-test-plan-member" });
  await s.mutate("cancelEvent", { eventId: "quarter-test-plan-0" });
  assert.equal(s.db.data("members/member").creditBalance, 150);
  assert.equal(s.db.data(s.invoicePath).amount, 1500);
  assert.equal(s.db.data(s.invoicePath).adjustments[0].kind, "CREDIT");
});
test("fee changes after confirmation do not reprice the quarter", async () => {
  const s = setup(); await s.confirm();
  s.db.seed("feeRates/future", { kind: "MEMBER_VISIT", amount: 999, effectiveFrom: new Date("2020-01-01") });
  await s.bill();
  assert.equal(s.db.data(s.invoicePath).grossAmount, 1500);
});
test("extra activity creates separate invoice and never increases quarterly baseline", async () => {
  const s = setup(); await s.confirm(); await s.bill();
  const date = s.rules.endDate;
  await s.mutate("createEvent", { startsAt: date + "T19:00:00+08:00", endsAt: date + "T21:00:00+08:00", courts: "B", regularCapacity: "10", standbyCapacity: "4", memberBilling: "EXTRA", billingReason: "加租場地" });
  assert.equal(s.db.data(s.invoicePath).eventIds.length, 10);
  assert.equal(s.db.data(s.invoicePath).amount, 1500);
  const extras = s.db.entries("invoices/").filter(([, value]) => value.type === "MEMBER_EXTRA");
  assert.equal(extras.length, 1);
  assert.equal(extras[0][1].amount, 150);
  assert.equal(extras[0][1].adjustments[0].reason, "加租場地");
  assert.equal(s.db.data("billingPeriods/quarter-test-plan").eventCount, 10);
});

function presidentSetup() {
  const s = setup(80);
  s.db.seed("members/admin", { displayName: "Current President", role: "ADMIN", primaryAdmin: true, membershipStatus: "MEMBER", accountType: "recoverable", creditBalance: 210, department: "A", recoveryCodeHash: "preserved-president-hash", memberSince: new Date("2025-01-01") });
  s.db.seed("members/member", { ...s.db.data("members/member"), accountType: "recoverable", department: "B", recoveryCodeHash: "preserved-member-hash", memberSince: new Date("2025-02-01") });
  return s;
}
function pendingExit(s, memberId = "admin") {
  const requestId = "exit-" + memberId;
  s.db.seed("membershipRequests/" + requestId, { memberId, memberNameSnapshot: "Test Member", kind: "EXIT", status: "PENDING", requestedAt: new Date() });
  s.db.seed("membershipRequestLocks/" + memberId, { memberId, kind: "EXIT", requestId });
  return requestId;
}
test("president identification requires an admin role and respects explicit transfer demotion", () => {
  const check = clubRoles.isClubPresident;
  assert.equal(check({ role: "ADMIN", primaryAdmin: true, displayName: "Someone" }), true);
  assert.equal(check({ role: "ADMIN", displayName: "BaRrYaDmIn" }), true);
  assert.equal(check({ role: "ADMIN", primaryAdmin: false, displayName: "BarryAdmin" }), false);
  assert.equal(check({ role: "MEMBER", primaryAdmin: true, displayName: "BarryAdmin" }), false);
  assert.equal(check({ role: "MEMBER", displayName: "BarryAdmin" }), false);
  assert.equal(check({ role: "ADMIN", displayName: "Another Admin" }), false);
});
test("president cannot request exit even when other administrators exist", async () => {
  const s = presidentSetup();
  s.db.seed("members/helper", { role: "ADMIN", membershipStatus: "MEMBER", displayName: "Helper", primaryAdmin: false });
  const before = s.db.entries("");
  await assert.rejects(s.mutate("requestMembershipChange", { kind: "EXIT" }), /社長|轉交|轉移/);
  assert.deepEqual(s.db.entries(""), before);
});
test("legacy president cannot exit but same-name ordinary member can request exit", async () => {
  const s = presidentSetup();
  const legacy = s.db.data("members/admin");
  delete legacy.primaryAdmin;
  legacy.displayName = "BaRrYaDmIn";
  s.db.seed("members/admin", legacy);
  await assert.rejects(s.mutate("requestMembershipChange", { kind: "EXIT" }), /社長|轉交|轉移/);
  s.db.seed("members/member", { ...s.db.data("members/member"), displayName: "BarryAdmin" });
  await s.mutate("requestMembershipChange", { kind: "EXIT" }, member);
  assert.equal(s.db.data("membershipRequestLocks/member").kind, "EXIT");
});
test("presidency transfer changes both roles atomically and preserves account, billing and activity data", async () => {
  const s = presidentSetup();
  await s.confirm(); await s.bill();
  const eventsBefore = s.db.entries("events/");
  const invoicesBefore = s.db.entries("invoices/");
  const adminBefore = s.db.data("members/admin");
  const memberBefore = s.db.data("members/member");
  const notificationsBefore = s.db.entries("notifications/").length;
  await s.mutate("transferPresident", { memberId: "member", confirmed: "true" });
  const former = s.db.data("members/admin");
  const successor = s.db.data("members/member");
  assert.equal(former.role, "MEMBER");
  assert.equal(former.primaryAdmin, false);
  assert.equal(former.membershipStatus, "MEMBER");
  assert.equal(former.endingAt, null);
  assert.equal(successor.role, "ADMIN");
  assert.equal(successor.primaryAdmin, true);
  assert.equal(successor.membershipStatus, "MEMBER");
  for (const key of ["creditBalance", "department", "recoveryCodeHash", "memberSince", "accountType"]) {
    assert.deepEqual(former[key], adminBefore[key]);
    assert.deepEqual(successor[key], memberBefore[key]);
  }
  assert.deepEqual(s.db.entries("events/"), eventsBefore);
  assert.deepEqual(s.db.entries("invoices/"), invoicesBefore);
  assert.equal(s.db.entries("members/").filter(([, value]) => clubRoles.isClubPresident(value)).length, 1);
  const audits = s.db.entries("auditLogs/").filter(([, value]) => value.action === "TRANSFER_PRESIDENT");
  assert.equal(audits.length, 1);
  assert.equal(audits[0][1].actorId, "admin");
  const notifications = s.db.entries("notifications/").slice(notificationsBefore);
  assert.equal(notifications.length, 2);
  assert.deepEqual(new Set(notifications.map(([, value]) => value.recipientId)), new Set(["admin", "member"]));
  await s.mutate("requestMembershipChange", { kind: "EXIT" });
  assert.equal(s.db.data("membershipRequestLocks/admin").kind, "EXIT");
  await assert.rejects(s.mutate("requestMembershipChange", { kind: "EXIT" }, { ...member, role: "ADMIN" }), /社長|轉交|轉移/);
});
test("former president cannot reuse a stale admin session or repeat a transfer", async () => {
  const s = presidentSetup();
  await s.mutate("transferPresident", { memberId: "member", confirmed: "true" });
  const after = s.db.entries("");
  for (const action of ["transferPresident", "updateMember", "reviewMembershipRequest", "setFeeRates", "confirmQuarterPlan", "confirmPayment"]) {
    await assert.rejects(s.mutate(action, { memberId: "member", confirmed: "true" }), /幹部|權限|社長/);
  }
  assert.deepEqual(s.db.entries(""), after);
});
test("ordinary admin and name-only impostor cannot transfer the presidency", async () => {
  const s = presidentSetup();
  s.db.seed("members/helper", { displayName: "Helper", role: "ADMIN", primaryAdmin: false, membershipStatus: "MEMBER", accountType: "recoverable" });
  await assert.rejects(s.mutate("transferPresident", { memberId: "member", confirmed: "true" }, { id: "helper", name: "Helper", role: "ADMIN" }));
  s.db.seed("members/member", { ...s.db.data("members/member"), displayName: "BarryAdmin" });
  await assert.rejects(s.mutate("transferPresident", { memberId: "helper", confirmed: "true" }, { ...member, name: "BarryAdmin", role: "ADMIN" }));
  assert.equal(s.db.data("members/admin").primaryAdmin, true);
});
test("presidency transfer requires explicit confirmation and a different existing member", async () => {
  for (const input of [{ memberId: "member" }, { memberId: "member", confirmed: "false" }, { memberId: "admin", confirmed: "true" }, { memberId: "missing", confirmed: "true" }, { memberId: "", confirmed: "true" }]) {
    const s = presidentSetup();
    const before = s.db.entries("");
    await assert.rejects(s.mutate("transferPresident", input));
    assert.deepEqual(s.db.entries(""), before);
  }
});
test("presidency transfer rejects guests, exiting, unclaimed and pending-exit successors without writes", async () => {
  const candidates = [
    { membershipStatus: "GUEST" },
    { membershipStatus: "EXITING", endingAt: new Date("2099-12-31") },
    { endingAt: new Date("2099-12-31") },
    { accountType: "unclaimed" },
    { accountType: undefined },
    { pendingExit: "lock" },
    { pendingExit: "request-only" },
  ];
  for (const candidate of candidates) {
    const s = presidentSetup();
    const { pendingExit: exit, ...overrides } = candidate;
    s.db.seed("members/member", { ...s.db.data("members/member"), ...overrides });
    if (exit === "lock") s.db.seed("membershipRequestLocks/member", { memberId: "member", kind: "EXIT", requestId: "pending" });
    if (exit === "request-only") s.db.seed("membershipRequests/pending", { memberId: "member", kind: "EXIT", status: "PENDING" });
    const before = s.db.entries("");
    await assert.rejects(s.mutate("transferPresident", { memberId: "member", confirmed: "true" }), JSON.stringify(candidate));
    assert.deepEqual(s.db.entries(""), before);
  }
});
test("claimed member accounts may receive presidency regardless of recovery method", async () => {
  for (const accountType of ["guest", "recoverable", "verified"]) {
    const s = presidentSetup();
    s.db.seed("members/member", { ...s.db.data("members/member"), accountType });
    await s.mutate("transferPresident", { memberId: "member", confirmed: "true" });
    assert.equal(s.db.data("members/member").primaryAdmin, true);
  }
});
test("pending president exit cannot be approved but can be rejected to clear old requests", async () => {
  const s = presidentSetup();
  const requestId = pendingExit(s);
  const before = s.db.entries("");
  await assert.rejects(s.mutate("reviewMembershipRequest", { requestId, decision: "APPROVE" }), /社長|轉交|轉移/);
  assert.deepEqual(s.db.entries(""), before);
  await s.mutate("reviewMembershipRequest", { requestId, decision: "REJECT" });
  assert.equal(s.db.data("membershipRequests/" + requestId).status, "REJECTED");
  assert.equal(s.db.data("membershipRequestLocks/admin"), undefined);
  assert.equal(s.db.data("members/admin").primaryAdmin, true);
  assert.equal(s.db.data("members/admin").membershipStatus, "MEMBER");
});
test("member-edit endpoint cannot remove presidency or membership, even with another admin present", async () => {
  for (const input of [{ role: "MEMBER", membershipStatus: "MEMBER" }, { role: "ADMIN", membershipStatus: "GUEST" }, { role: "ADMIN", membershipStatus: "EXITING" }]) {
    const s = presidentSetup();
    s.db.seed("members/helper", { role: "ADMIN", displayName: "Helper", membershipStatus: "MEMBER", primaryAdmin: false });
    const before = s.db.entries("");
    await assert.rejects(s.mutate("updateMember", { memberId: "admin", ...input }, { id: "helper", role: "ADMIN", name: "Helper" }), /社長|轉交|轉移/);
    assert.deepEqual(s.db.entries(""), before);
  }
});
test("explicitly demoted BarryAdmin does not regain presidency after later ordinary-admin promotion", async () => {
  const s = presidentSetup();
  s.db.seed("members/admin", { ...s.db.data("members/admin"), displayName: "BarryAdmin" });
  await s.mutate("transferPresident", { memberId: "member", confirmed: "true" });
  await s.mutate("updateMember", { memberId: "admin", role: "ADMIN", membershipStatus: "MEMBER" }, { ...member, role: "ADMIN" });
  assert.equal(s.db.data("members/admin").primaryAdmin, false);
  assert.equal(clubRoles.isClubPresident(s.db.data("members/admin")), false);
  await s.mutate("requestMembershipChange", { kind: "EXIT" });
  assert.equal(s.db.data("membershipRequestLocks/admin").kind, "EXIT");
});
test("sensitive mutations recheck the actor inside the transaction after an intervening demotion", async () => {
  for (const [action, input] of [
    ["transferPresident", { memberId: "member", confirmed: "true" }],
    ["updateMember", { memberId: "member", role: "ADMIN", membershipStatus: "MEMBER" }],
    ["reviewMembershipRequest", { requestId: "exit-member", decision: "APPROVE" }],
  ]) {
    const s = presidentSetup();
    pendingExit(s, "member");
    s.db.beforeNextTransaction = () => s.db.seed("members/admin", { ...s.db.data("members/admin"), role: "MEMBER", primaryAdmin: false });
    await assert.rejects(s.mutate(action, input), /幹部|權限|社長/);
    assert.equal(s.db.data("members/member").role, "MEMBER");
    assert.equal(s.db.data("members/member").membershipStatus, "MEMBER");
    assert.equal(s.db.data("membershipRequests/exit-member").status, "PENDING");
    assert.equal(s.db.entries("auditLogs/").length, 0);
  }
});
function accountComponentsForTest(rosterState) {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/app/page.tsx"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  const dependencies = {
    "@simplewebauthn/browser": {},
    "@/app/quarter-planner": { default: () => null },
    "@/app/billing-dashboard": loadTs("src/app/billing-dashboard.tsx", { "@/lib/billing-view": billingView }),
    "@/app/loading-screen": loadingScreen,
    "@/app/floating-notifications": { default: () => null },
    "@/app/balance-history-dialog": balanceHistoryDialog,
    "@/app/shuttle-art": shuttleArt,
    "@/lib/billing-view": billingView,
    "@/lib/quarter-planning": planning,
    "@/lib/club-roles": clubRoles,
  };
  if (rosterState) {
    const React = require("react");
    dependencies.react = { ...React, useState(initial) {
      return React.useState(initial === "member" ? rosterState.group : initial === "" ? rosterState.query : initial);
    } };
  }
  new Function("require", "module", "exports", code + "\nmodule.exports.AccountProfileForTest = AccountProfile; module.exports.MemberManagerForTest = MemberManagerModal; module.exports.MembersForTest = Members;")((id) => dependencies[id] ?? require(id), loaded, loaded.exports);
  return loaded.exports;
}
function accountProfileProps(primaryAdmin = false) {
  return {
    viewer: { id: "admin", name: "Account Owner", role: "ADMIN", primaryAdmin, membershipStatus: "MEMBER", creditBalance: 0, accountType: "recoverable", hasRecoveryCode: true, hasPasskey: false },
    user: { id: "admin", name: "Account Owner", role: "admin", member: true, primaryAdmin, membershipStatus: "MEMBER" },
    recoverySaving: false, passkeySaving: false, membershipSaving: false, presidencySaving: false,
    membershipRequests: [], members: [],
    createRecoveryCode() {}, registerPasskey() {}, requestMembershipChange() {}, transferPresidency() {}, logout() {},
  };
}
test("president profile replaces exit action with an explained presidency transfer entry", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { AccountProfileForTest } = accountComponentsForTest();
  const html = renderToStaticMarkup(React.createElement(AccountProfileForTest, accountProfileProps(true)));
  assert.match(html, /轉交社長權限/);
  assert.match(html, /社長須先轉交權限才能退社/);
  assert.doesNotMatch(html, /申請退出社員/);
  assert.match(html, /aria-expanded="false"/);
});
test("ordinary administrator profile shows own exit action and ignores another user's pending request", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { AccountProfileForTest } = accountComponentsForTest();
  const props = accountProfileProps(false);
  props.membershipRequests = [{ id: "other-request", memberId: "other", memberName: "Other Person", kind: "EXIT", status: "PENDING", requestedAt: "2026-01-01T00:00:00Z", reviewedAt: null }];
  const html = renderToStaticMarkup(React.createElement(AccountProfileForTest, props));
  const exitButton = html.match(/<button[^>]*>申請退出社員<\/button>/)?.[0];
  assert.ok(exitButton);
  assert.doesNotMatch(exitButton, /disabled/);
  assert.doesNotMatch(html, /轉交社長權限|退出申請審核中|等待審核/);
  props.membershipRequests.push({ ...props.membershipRequests[0], id: "own-request", memberId: "admin" });
  const ownPending = renderToStaticMarkup(React.createElement(AccountProfileForTest, props));
  assert.match(ownPending, /退出申請審核中/);
  assert.match(ownPending, /<button[^>]*disabled[^>]*>等待審核<\/button>/);
});
test("personal profile prioritizes three sections, states exactly when membership ends, and collapses detail", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { AccountProfileForTest } = accountComponentsForTest();
  const props = accountProfileProps();
  props.viewer = { ...props.viewer, membershipStatus: "EXITING", membershipEndingAt: "2026-11-24T18:00:00Z" };
  props.membershipRequests = [{ id: "own-approved", memberId: "admin", kind: "EXIT", status: "APPROVED", requestedAt: "2026-11-20T00:00:00Z" }];
  const html = renderToStaticMarkup(React.createElement(AccountProfileForTest, props));
  assert.match(html, /個人資料<\/h2>[\s\S]*我的會籍<\/h2>[\s\S]*登入與安全<\/h2>/);
  assert.match(html, /社員身分有效至 2026\/11\/25/);
  assert.doesNotMatch(html, /申請退出社員|還沒設定取回帳號的方式|原本的復原碼會立即失效/);
  assert.match(html, /<details class="account-disclosure"><summary>更多帳號資訊<\/summary>/);
  assert.match(html, /<details class="account-disclosure"><summary>申請紀錄<\/summary>/);
  assert.match(html, /修改顯示名稱|重新產生復原碼/);
  assert.match(html, /<footer[^>]*><button[^>]*>登出<\/button><\/footer>/);
});

test("profile warns only without an account recovery method and retains guest join and both security actions", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { AccountProfileForTest } = accountComponentsForTest();
  const props = accountProfileProps();
  props.viewer = { ...props.viewer, role: "MEMBER", membershipStatus: "GUEST", hasRecoveryCode: false };
  props.user = { ...props.user, role: "member", member: false, membershipStatus: "GUEST" };
  const render = () => renderToStaticMarkup(React.createElement(AccountProfileForTest, props));
  const html = render();
  assert.match(html, /還沒設定取回帳號的方式/);
  assert.match(html, />申請加入社員<\/button>/);
  assert.match(html, />建立 Passkey<\/button>/);
  assert.match(html, />建立復原碼<\/button>/);
  props.viewer.hasPasskey = true;
  const recovered = render();
  assert.doesNotMatch(recovered, /還沒設定取回帳號的方式/);
  assert.match(recovered, />新增 Passkey<\/button>/);
});

test("president management form fixes role and membership instead of offering a bypass", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { MemberManagerForTest } = accountComponentsForTest();
  const html = renderToStaticMarkup(React.createElement(MemberManagerForTest, { member: accountProfileProps(true).user, saving: false, issueClaimCode() {}, async adjustBalance() {}, save() {}, onClose() {} }));
  assert.match(html, /<input type="hidden" name="role" value="ADMIN"/);
  assert.match(html, /<input type="hidden" name="membershipStatus" value="MEMBER"/);
  assert.equal((html.match(/<select[^>]*disabled/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<option value="GUEST"/);
});

test("president member row shows one president badge without an extra member badge", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { MembersForTest } = accountComponentsForTest();
  const president = { ...accountProfileProps(true).user, name: "BarryAdmin" };
  const html = renderToStaticMarkup(React.createElement(MembersForTest, {
    members: [president], requests: [], currentUser: president, admin: true, saving: false,
    requestMembership() {}, issueClaimCode() {}, reviewRequest() {}, manageMember() {},
  }));
  const badges = html.match(/<span class="badge [^"]*">[^<]*<\/span>/g) ?? [];
  assert.equal(badges.filter((badge) => />社長<\/span>/.test(badge)).length, 1);
  assert.equal(badges.filter((badge) => />社員<\/span>/.test(badge)).length, 0);
  assert.doesNotMatch(html, /primary-admin-label/);
  assert.match(html, /編輯/);
  assert.doesNotMatch(html, /認領碼/);
});

test("roster defaults to members and keeps guests and search results separate", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const member = { id: "member", name: "社員甲", role: "member", member: true, department: "共用部門" };
  const exiting = { ...member, id: "exiting", name: "社員乙", membershipStatus: "EXITING" };
  const guest = { ...member, id: "guest", name: "球友丙", member: false };
  const guest2 = { ...guest, id: "guest2", name: "球友丁", department: "另一部門" };
  const render = (state, admin = false) => {
    const { MembersForTest } = accountComponentsForTest(state);
    return renderToStaticMarkup(React.createElement(MembersForTest, {
      members: [member, exiting, guest, guest2], requests: [], currentUser: member, admin, saving: false,
      requestMembership() {}, reviewRequest() {}, manageMember() {},
    }));
  };
  const initial = render();
  assert.match(initial, /aria-pressed="true">社員/);
  assert.match(initial, /社員甲/);
  assert.match(initial, /社員乙/);
  assert.match(initial, /本期後退出/);
  assert.doesNotMatch(initial, /球友丙|球友丁|社員申請審核/);
  const guestResults = render({ group: "guest", query: " 共用部門 " }, true);
  assert.match(guestResults, /aria-pressed="true">非社員/);
  assert.match(guestResults, /球友丙/);
  assert.doesNotMatch(guestResults, /社員甲|社員乙|球友丁/);
  assert.match(guestResults, /社員申請審核/);
  assert.match(guestResults, /aria-label="編輯 球友丙"/);
  assert.match(render({ group: "guest", query: "社員甲" }), /找不到符合「社員甲」的非社員/);
});

function membershipBillingFixture(status, dueDays = -1) {
  const s = setup();
  const date = (days) => new Date(Date.now() + days * 86400000);
  const day = (days) => billingView.taipeiDay(date(days));
  const visitor = { id: "visitor", name: "試用球友", role: "MEMBER" };
  s.db.seed("members/visitor", { displayName: visitor.name, role: "MEMBER", membershipStatus: "GUEST", creditBalance: 0 });
  for (const [id, offset] of [["past", -3], ["future", 3]]) {
    s.db.seed("events/" + id, { id, status: "SCHEDULED", startsAt: date(offset), endsAt: new Date(date(offset).getTime() + 3600000), regularCapacity: 10, standbyCapacity: 4, regularCount: 0, standbyCount: 0, memberFeeSnapshot: 150, guestFeeSnapshot: 180, memberDefaultsVersion: 1 });
  }
  s.db.seed("billingPeriods/quarter-current", { id: "quarter-current", label: "當期", startDate: day(-20), endDate: day(10), status, eventIds: ["past", "future"], eventAmounts: [150, 150], eventSnapshots: [], grossAmount: 300, dueAt: date(dueDays), recipientIds: ["member"] });
  const approve = async (actor, kind) => {
    await s.mutate("requestMembershipChange", { kind }, actor);
    const [key] = s.db.entries("membershipRequests/").find(([, entry]) => entry.memberId === actor.id && entry.status === "PENDING");
    return s.mutate("reviewMembershipRequest", { requestId: key.split("/").pop(), decision: "APPROVE" }, admin);
  };
  return { ...s, date, day, visitor, approve };
}

test("late opening starts charges on membership effective date and rejects a stale quarterly preview", async () => {
  const s = membershipBillingFixture("PLANNED");
  await s.approve(s.visitor, "JOIN");
  assert.equal(s.db.entries("invoices/").length, 0);
  const actions = { planId: "current", dueDate: s.day(9) };
  const first = await s.mutate("previewQuarterlyInvoices", actions);
  assert.equal(first.rows.find((row) => row.memberId === "visitor").amount, 150);
  assert.deepEqual(first.rows.find((row) => row.memberId === "visitor").eventIds, ["future"]);
  s.db.seed("members/visitor", { ...s.db.data("members/visitor"), creditBalance: 25 });
  await assert.rejects(s.mutate("createQuarterlyInvoices", { ...actions, previewKey: first.previewKey }), /重新預覽/);
  const fresh = await s.mutate("previewQuarterlyInvoices", actions);
  await s.mutate("createQuarterlyInvoices", { ...actions, previewKey: fresh.previewKey });
  assert.deepEqual(s.db.data("invoices/quarter-current-visitor").eventIds, ["future"]);
  assert.equal(s.db.data("invoices/quarter-current-visitor").amount, 125);
});

test("approval during billing generation prorates remaining sessions and never opens overdue", async () => {
  const s = membershipBillingFixture("GENERATING");
  s.db.seed("invoices/legacy-guest", { id: "legacy-guest", memberId: "visitor", memberNameSnapshot: s.visitor.name, eventId: "future", type: "SINGLE_EVENT", grossAmount: 180, creditApplied: 20, amount: 160, status: "PENDING" });
  await s.approve(s.visitor, "JOIN");
  const memberBill = s.db.entries("invoices/membership-").map(([, item]) => item)[0];
  assert.equal(s.db.data("invoices/legacy-guest").status, "VOID");
  assert.deepEqual(memberBill.eventIds, ["future"]);
  assert.equal(memberBill.amount, 130);
  assert.ok(memberBill.dueAt > s.date(13));
  await s.mutate("createQuarterlyInvoices", { planId: "current", dueDate: s.day(9) });
  assert.equal(s.db.entries("invoices/").filter(([, item]) => item.memberId === "visitor" && item.status === "PENDING").length, 1);
});

test("approved exit cancels future member slots and prevents charges even if next quarter was planned first", async () => {
  const s = membershipBillingFixture("ACTIVE", 4);
  await s.confirm();
  const bookingPath = "events/quarter-test-plan-0/bookings/member";
  assert.equal(s.db.data(bookingPath).status, "REGULAR");
  await s.approve(member, "EXIT");
  assert.equal(s.db.data(bookingPath).status, "CANCELLED");
  assert.equal(s.db.data("members/member").membershipStatus, "EXITING");
  await assert.rejects(s.bill(), /目前沒有可開單社員/);
  assert.equal(s.db.data(s.invoicePath), undefined);
});

test("membership exit preserves a privately transferred slot received before joining", async () => {
  const s = membershipBillingFixture("ACTIVE", 4);
  await s.confirm();
  const eventId = "quarter-test-plan-0";
  const eventPath = "events/" + eventId;
  const bookingPath = eventPath + "/bookings/visitor";
  await s.mutate("transfer", { eventId, recipient: s.visitor.name }, member);
  assert.equal(s.db.data(bookingPath).kindSnapshot, "GUEST");

  await s.approve(s.visitor, "JOIN");
  assert.equal(s.db.data(bookingPath).kindSnapshot, "MEMBER");
  const transferredBooking = s.db.data(bookingPath);
  const regularCount = s.db.data(eventPath).regularCount;
  await s.approve(s.visitor, "EXIT");

  assert.deepEqual(s.db.data(bookingPath), transferredBooking);
  assert.equal(s.db.data(bookingPath).status, "REGULAR");
  assert.equal(s.db.data(bookingPath).transferredFromMemberId, member.id);
  assert.equal(s.db.data(eventPath).regularCount, regularCount);
  assert.equal(s.db.data(eventPath + "/bookings/member").status, "TRANSFERRED");
  assert.equal(s.db.data("events/quarter-test-plan-1/bookings/visitor").status, "CANCELLED");
});

test("approved exit adjusts already issued future charges without paying an unconfirmed report", async () => {
  const s = membershipBillingFixture("ACTIVE", 4);
  await s.confirm();
  await s.bill();
  await s.mutate("reportPayment", { invoiceId: s.invoicePath.split("/").pop() }, member);
  await s.approve(member, "EXIT");
  const held = s.db.entries("invoices/membership-end-").map(([, item]) => item);
  assert.equal(held.length, 10);
  assert.ok(held.every((item) => item.status === "AWAITING_PAYMENT_CONFIRMATION"));
  assert.equal(s.db.data("members/member").creditBalance, 0);
  await s.mutate("confirmPayment", { invoiceId: s.invoicePath.split("/").pop() });
  assert.equal(s.db.data("members/member").creditBalance, 1500);
});

test("existing reported guest split payment is not released or double-billed when membership changes", async () => {
  const s = membershipBillingFixture("PLANNED");
  s.db.seed("invoices/reported-old-guest", { id: "reported-old-guest", memberId: "visitor", eventId: "future", type: "SINGLE_EVENT", grossAmount: 180, creditApplied: 50, amount: 130, status: "REPORTED" });
  await s.approve(s.visitor, "JOIN");
  const actions = { planId: "current", dueDate: s.day(9) };
  const quote = await s.mutate("previewQuarterlyInvoices", actions);
  assert.ok(!quote.rows.some((row) => row.memberId === "visitor"));
  await s.mutate("createQuarterlyInvoices", { ...actions, previewKey: quote.previewKey });
  assert.equal(s.db.entries("invoices/").filter(([, item]) => item.memberId === "visitor").length, 1);
  assert.equal(s.db.data("invoices/reported-old-guest").status, "REPORTED");
  assert.equal(s.db.data("members/visitor").creditBalance, 0);
});
