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
  new Function("require", "module", "exports", code)((id) => dependencies[id] ?? require(id), loaded, loaded.exports);
  return loaded.exports;
}
const planning = loadTs("src/lib/quarter-planning.ts");
const billingView = loadTs("src/lib/billing-view.ts");
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
      const operations = [];
      const read = async (ref) => { if (operations.length) throw new Error("Firestore read after write"); return ref.get(); };
      const transaction = { get: read, getAll: async (...refs) => Promise.all(refs.map(read)) };
      for (const kind of ["create", "update", "set", "delete"]) transaction[kind] = (ref, data, options) => operations.push({ kind, ref, data, merge: options?.merge });
      const result = await callback(transaction);
      const before = structuredClone(records);
      try { for (const operation of operations) apply(operation); } catch (error) { records = before; throw error; }
      return result;
    },
    data: (key) => structuredClone(records.get(key)),
    entries: (prefix) => [...records.entries()].filter(([key]) => key.startsWith(prefix)),
    seed: (key, value) => records.set(key, structuredClone(value)),
  };
  return db;
}
function setup(balance = 0) {
  const db = database();
  db.seed("members/member", { displayName: "社員", membershipStatus: "MEMBER", role: "MEMBER", creditBalance: balance });
  db.seed("members/admin", { displayName: "社長", membershipStatus: "GUEST", role: "ADMIN", creditBalance: 0 });
  const invoiceManagement = loadTs("src/lib/invoice-management.ts", { "firebase-admin/firestore": { Timestamp: FakeTimestamp, FieldValue: transforms }, "@/lib/firebase-admin": { getAdminFirestore: () => db }, "@/lib/quarter-planning": planning });
  const backend = loadTs("src/lib/firestore-database.ts", {
    "@/lib/invoice-management": invoiceManagement,
    "firebase-admin/firestore": { Timestamp: FakeTimestamp, FieldValue: transforms },
    "@/lib/firebase-admin": { getAdminFirestore: () => db },
    "@/lib/device-auth": {},
    "@/lib/quarter-planning": planning,
  });
  const year = new Date().getUTCFullYear() + 1;
  const rules = { label: "第一季", startDate: year + "-01-01", endDate: year + "-03-31", weekday: 5, startTime: "19:00", endTime: "21:00", courts: "A 場", regularCapacity: 10, standbyCapacity: 4, excludedDates: [], excludeWeekends: false };
  const activities = planning.suggestActivities(rules).slice(0, 10);
  const mutate = (action, input = {}, actor = admin) => backend.mutate(action, input, actor);
  const draft = () => mutate("saveQuarterDraft", { planId: "test-plan", revision: "0", draft: JSON.stringify({ rules, activities }) });
  const confirm = () => mutate("confirmQuarterPlan", { planId: "test-plan", revision: "1" });
  const bill = () => mutate("createQuarterlyInvoices", { planId: "test-plan", dueDate: year + "-01-15" });
  const invoicePath = "invoices/quarter-test-plan-member";
  return { db, mutate, rules, activities, draft, confirm, bill, invoicePath };
}

test("suggestions obey weekday, explicit holidays and weekends, and allow manual date overrides", () => {
  const { rules } = setup();
  const suggestions = planning.suggestActivities(rules);
  assert.ok(suggestions.every((entry) => new Date(entry.date).getUTCDay() === 5));
  assert.equal(planning.suggestActivities({ ...rules, excludedDates: [suggestions[0].date] }).length, suggestions.length - 1);
  assert.equal(planning.suggestActivities({ ...rules, weekday: 6, excludeWeekends: true }).length, 0);
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
