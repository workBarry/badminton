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
 const s=setup(100); await s.draft(); await s.confirm(); await s.bill();
 const input=managementInput(s); await s.mutate("voidInvoice",input); await s.mutate("voidInvoice",input);
 const old=s.db.data(s.invoicePath);
 assert.equal(old.status,"VOID"); assert.equal(old.grossAmount,1500);
 assert.equal(s.db.data("members/member").creditBalance,100);
 assert.equal(s.db.data("events/quarter-test-plan-0").status,"SCHEDULED");
 assert.equal(s.db.data("events/quarter-test-plan-0/bookings/member").status,"REGULAR");
 assert.equal(old.adjustments.at(-1).actorName,admin.name);
});
test("reissue is atomic, recalculates credit, links bills and preserves quarter baseline", async () => {
 const s=setup(100); await s.draft(); await s.confirm(); await s.bill();
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
 const s=setup(100); await s.draft(); await s.confirm(); await s.bill();
 await s.mutate("voidInvoice",managementInput(s));
 const result=await s.mutate("reissueInvoice",managementInput(s,undefined,{eventAmounts:JSON.stringify(Array(10).fill(150)),dueDate:s.rules.endDate}));
 assert.equal(s.db.data("members/member").creditBalance,0);
 assert.equal(s.db.data("invoices/"+result.invoiceId).amount,1400);
});
test("reissue rejects cancelled-event charges and stale invoice totals without writes", async () => {
 const s=setup(); await s.draft(); await s.confirm(); await s.bill();
 const stale=managementInput(s);
 await s.mutate("cancelEvent",{eventId:"quarter-test-plan-0"});
 await assert.rejects(s.mutate("voidInvoice",stale),/已變更/);
 await assert.rejects(s.mutate("reissueInvoice",managementInput(s,undefined,{eventAmounts:JSON.stringify(Array(10).fill(150)),dueDate:s.rules.endDate})),/取消/);
 assert.equal(s.db.data(s.invoicePath).status,"PENDING");
});
test("refund subtracts prior credits and is not repeated by retries or subsequent cancellation", async () => {
 const s=setup(100); await s.draft(); await s.confirm(); await s.bill();
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
 const s=setup(100); await s.draft(); await s.confirm(); await s.bill();
 await s.mutate("confirmPayment",{invoiceId:"quarter-test-plan-member"});
 const input=managementInput(s,undefined,{refundMode:"OFFLINE",expectedRefundable:"1500"});
 await assert.rejects(s.mutate("refundInvoice",input),/人工退款/);
 const result=await s.mutate("refundInvoice",{...input,offlineRefunded:"true"});
 assert.equal(result.cashRefund,1400); assert.equal(result.balanceRefund,100);
 assert.equal(s.db.data("members/member").creditBalance,100);
});
test("reported transfers cannot be voided; reject after checking reverses pending credit into reduction", async () => {
 const s=setup(); await s.draft(); await s.confirm(); await s.bill();
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
 await s.draft(); await s.confirm(); await s.bill();
 await s.mutate("reportPayment",{invoiceId:"quarter-test-plan-admin"},admin);
 const result=await s.mutate("voidInvoiceBatch",{reason:"批次更正",invoices:JSON.stringify([{id:"quarter-test-plan-member",amount:1500},{id:"quarter-test-plan-admin",amount:1500}])});
 assert.equal(result.results.filter(entry=>entry.success).length,1);
 assert.equal(result.results.filter(entry=>!entry.success).length,1);
 assert.equal(s.db.data("invoices/quarter-test-plan-admin").status,"REPORTED");
});
test("invoice management requires administrator and rejects ledger entries", async () => {
 const s=setup(); await s.draft(); await s.confirm(); await s.bill();
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
  await s.draft(); await s.confirm(); await s.bill();
  await s.mutate("reportPayment", { invoiceId: "quarter-test-plan-admin" }, admin);
  assert.equal(s.db.data("invoices/quarter-test-plan-admin").status, "REPORTED");
  await s.mutate("confirmPayment", { invoiceId: "quarter-test-plan-admin" }, admin);
  assert.equal(s.db.data("invoices/quarter-test-plan-admin").status, "CONFIRMED");
});
test("billing renders self-payment for admin's own bill, reminders for others and confirmation for reported bills", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const source = fs.readFileSync(path.resolve(__dirname, "../src/app/page.tsx"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  const dashboard = loadTs("src/app/billing-dashboard.tsx", { "@/lib/billing-view": billingView });
  const dependencies = { "@simplewebauthn/browser": {}, "@/app/quarter-planner": { default: () => null }, "@/app/billing-dashboard": dashboard, "@/lib/billing-view": billingView, "@/lib/quarter-planning": planning };
  dependencies["@/app/loading-screen"] = loadingScreen;
  dependencies["@/app/balance-history-dialog"] = balanceHistoryDialog;
  dependencies["@/app/shuttle-art"] = shuttleArt;
  dependencies["@/lib/club-roles"] = clubRoles;
  new Function("require", "module", "exports", code + "\nmodule.exports.BillingForTest = Billing;")((id) => dependencies[id] ?? require(id), loaded, loaded.exports);
  const props = { admin: true, viewer: { ...admin, creditBalance: 0 }, saving: false, reportPayment() {}, confirmPayment() {}, remindPayment() {}, openRates() {} };
  const invoice = { id: "invoice", member_id: admin.id, memberName: admin.name, type: "QUARTERLY_MEMBER", gross_amount: 1500, credit_applied: 0, amount: 1500, status: "PENDING" };
  const render = (entry) => renderToStaticMarkup(React.createElement(loaded.exports.BillingForTest, { ...props, invoices: [entry] }));
  const own = render(invoice);
  assert.match(own, /我已轉帳/);
  assert.doesNotMatch(own, /催款/);
  const others = render({ ...invoice, member_id: "someone-else" });
  assert.match(others, /催款/);
  assert.doesNotMatch(others, /我已轉帳/);
  assert.match(render({ ...invoice, status: "REPORTED" }), /確認收款/);
  assert.doesNotMatch(render({ ...invoice, status: "CONFIRMED" }), /我已轉帳|催款|確認收款/);
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
      const docs = [...records.entries()].filter(([key, data]) => key.startsWith(pathname + "/") && key.split("/").length === pathname.split("/").length + 1 && filters.every(({ field, op, value }) => op === "array-contains" ? data[field]?.includes(value) : data[field] === value)).map(([key]) => snapshot(reference(key)));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  });
  const db = {
    collection: query,
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
    "@/lib/device-auth": { viewerFromMember: (id, data) => ({ id, name: data.displayName, role: data.role, membershipStatus: data.membershipStatus, primaryAdmin: clubRoles.isClubPresident(data), creditBalance: data.creditBalance ?? 0, accountType: data.accountType }) },
    "@/lib/club-roles": clubRoles,
    "@/lib/quarter-planning": planning,
    "@/lib/official-closures": { fetchOfficialClosures },
  });
  const year = new Date().getUTCFullYear() + 1;
  const rules = { label: "第一季", startDate: year + "-01-01", endDate: year + "-03-31", weekday: 5, startTime: "19:00", endTime: "21:00", courts: "A 場", regularCapacity: 10, standbyCapacity: 4, excludedDates: [] };
  const activities = planning.suggestActivities(rules).slice(0, 10);
  const mutate = (action, input = {}, actor = admin) => backend.mutate(action, input, actor);
  const draft = () => mutate("saveQuarterDraft", { planId: "test-plan", revision: "0", draft: JSON.stringify({ rules, activities }) });
  const confirm = () => mutate("confirmQuarterPlan", { planId: "test-plan", revision: "1" });
  const bill = () => mutate("createQuarterlyInvoices", { planId: "test-plan", dueDate: year + "-01-15" });
  const invoicePath = "invoices/quarter-test-plan-member";
  return { db, mutate, rules, activities, draft, confirm, bill, invoicePath };
}

test("suggestions follow the selected weekday, including weekends, and honor explicit exclusions", () => {
  const { rules } = setup();
  const suggestions = planning.suggestActivities(rules);
  assert.ok(suggestions.every((entry) => new Date(entry.date).getUTCDay() === 5));
  assert.equal(planning.suggestActivities({ ...rules, excludedDates: [suggestions[0].date] }).length, suggestions.length - 1);
  for (const weekday of [0, 6]) {
    // Old drafts can still contain the retired flag.
    const weekendSuggestions = planning.suggestActivities({ ...rules, weekday, excludeWeekends: true });
    assert.ok(weekendSuggestions.length > 0);
    assert.ok(weekendSuggestions.every((entry) => new Date(entry.date).getUTCDay() === weekday));
  }
  assert.throws(() => planning.validateQuarterDraft(rules, [suggestions[0], suggestions[0]]), /重複/);
  assert.equal(planning.validCalendarDate("2027-02-30"), false);
  assert.throws(() => planning.validateQuarterDraft(rules, [{ ...suggestions[0], date: "2027-02-30" }]));
});
test("unpaid reduction preserves original values and returns excess previously applied credit", () => {
  const original = { grossAmount: 1500, creditApplied: 1450, amount: 50 };
  const result = planning.reduceUnpaidInvoice(original, 150);
  assert.deepEqual(result, { adjustedGrossAmount: 1350, adjustedCreditApplied: 1350, adjustedAmount: 0, restoredCredit: 100 });
  assert.equal(original.grossAmount, 1500);
});
test("draft has no events; revision conflicts rejected; confirmation is idempotent", async () => {
  const s = setup(); await s.draft();
  assert.equal(s.db.entries("events/").length, 0);
  await assert.rejects(s.mutate("saveQuarterDraft", { planId: "test-plan", revision: "0", draft: JSON.stringify({ rules: s.rules, activities: s.activities }) }), /其他幹部/);
  await s.confirm(); await s.confirm();
  assert.equal(s.db.entries("events/").filter(([key]) => key.split("/").length === 2).length, 10);
  assert.equal(s.db.data("billingPeriods/quarter-test-plan").eventCount, 10);
  assert.equal(s.db.data("billingPeriods/quarter-test-plan").grossAmount, 1500);
});
test("confirmation rechecks saved activities for national holidays and New Taipei closures", async () => {
  let officialDates = [];
  const calls = [];
  const s = setup(0, async (...range) => { calls.push(range); return officialDates; });
  await s.draft();
  assert.equal(calls.length, 0);
  officialDates = [
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
test("feed failure keeps a draft intact and an already confirmed retry avoids the feed", async () => {
  let available = false;
  let checks = 0;
  const s = setup(0, async () => {
    checks++;
    if (!available) throw new Error("官方行事曆暫時無法讀取");
    return [];
  });
  await s.draft();
  const before = s.db.entries("");
  await assert.rejects(s.confirm(), /官方行事曆暫時無法讀取/);
  assert.deepEqual(s.db.entries(""), before);
  available = true;
  const confirmed = await s.confirm();
  available = false;
  assert.deepEqual(await s.confirm(), confirmed);
  assert.equal(checks, 2);
});
test("confirmation rechecks draft revision and administrator after loading closures", async () => {
  const revisionRace = setup(0, async () => {
    await revisionRace.mutate("saveQuarterDraft", { planId: "test-plan", revision: "1", draft: JSON.stringify({ rules: revisionRace.rules, activities: revisionRace.activities.slice(1) }) });
    throw new Error("官方行事曆暫時無法讀取");
  });
  await revisionRace.draft();
  await assert.rejects(revisionRace.confirm(), /草稿版本已變更/);
  assert.equal(revisionRace.db.data("quarterPlans/test-plan").revision, 2);
  assert.equal(revisionRace.db.entries("events/").length, 0);

  const permissionRace = setup(0, async () => {
    permissionRace.db.seed("members/admin", { role: "MEMBER" });
    return [];
  });
  await permissionRace.draft();
  await assert.rejects(permissionRace.confirm(), /幹部權限已變更/);
  assert.equal(permissionRace.db.data("quarterPlans/test-plan").status, "DRAFT");
  assert.equal(permissionRace.db.entries("events/").length, 0);
});
test("date conflict rolls back the entire quarter confirmation", async () => {
  const s = setup(); await s.draft();
  s.db.seed("eventDates/" + s.activities[5].date, { eventId: "existing" });
  await assert.rejects(s.confirm(), /已有活動/);
  assert.equal(s.db.entries("events/").length, 0);
  assert.equal(s.db.data("quarterPlans/test-plan").status, "DRAFT");
  assert.equal(s.db.entries("billingPeriods/").length, 0);
});
test("non-admin cannot save, confirm, or generate invoices", async () => {
  const s = setup();
  for (const action of ["saveQuarterDraft", "confirmQuarterPlan", "createQuarterlyInvoices"]) await assert.rejects(s.mutate(action, {}, member), /只有幹部/);
});
test("cancel before billing preserves ten-event baseline and adds visible reduction; no duplicate bills", async () => {
  const s = setup(); await s.draft(); await s.confirm();
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
  const s = setup(1450); await s.draft(); await s.confirm(); await s.bill();
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
  const s = setup(); await s.draft(); await s.confirm(); await s.bill();
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
  const s = setup(); await s.draft(); await s.confirm(); await s.bill();
  await s.mutate("confirmPayment", { invoiceId: "quarter-test-plan-member" });
  await s.mutate("cancelEvent", { eventId: "quarter-test-plan-0" });
  assert.equal(s.db.data("members/member").creditBalance, 150);
  assert.equal(s.db.data(s.invoicePath).amount, 1500);
  assert.equal(s.db.data(s.invoicePath).adjustments[0].kind, "CREDIT");
});
test("fee changes after confirmation do not reprice the quarter", async () => {
  const s = setup(); await s.draft(); await s.confirm();
  s.db.seed("feeRates/future", { kind: "MEMBER_VISIT", amount: 999, effectiveFrom: new Date("2020-01-01") });
  await s.bill();
  assert.equal(s.db.data(s.invoicePath).grossAmount, 1500);
});
test("extra activity creates separate invoice and never increases quarterly baseline", async () => {
  const s = setup(); await s.draft(); await s.confirm(); await s.bill();
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
  await s.draft(); await s.confirm(); await s.bill();
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
  for (const action of ["transferPresident", "updateMember", "reviewMembershipRequest", "setFeeRates", "saveQuarterDraft", "confirmPayment"]) {
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
function accountComponentsForTest() {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/app/page.tsx"), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const loaded = { exports: {} };
  const dependencies = {
    "@simplewebauthn/browser": {},
    "@/app/quarter-planner": { default: () => null },
    "@/app/billing-dashboard": loadTs("src/app/billing-dashboard.tsx", { "@/lib/billing-view": billingView }),
    "@/app/loading-screen": loadingScreen,
    "@/app/balance-history-dialog": balanceHistoryDialog,
    "@/app/shuttle-art": shuttleArt,
    "@/lib/billing-view": billingView,
    "@/lib/quarter-planning": planning,
    "@/lib/club-roles": clubRoles,
  };
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
test("president management form fixes role and membership instead of offering a bypass", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { MemberManagerForTest } = accountComponentsForTest();
  const html = renderToStaticMarkup(React.createElement(MemberManagerForTest, { member: accountProfileProps(true).user, saving: false, issueClaimCode() {}, save() {}, onClose() {} }));
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
