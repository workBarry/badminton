/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Reuse the existing Firestore transaction/ledger fixture without registering
// the quarter-planning tests a second time.
const harness = { exports: {} };
const fixture = fs.readFileSync(path.join(__dirname, "quarter-planning.test.cjs"), "utf8");
new Function("require", "__dirname", "module", "exports", fixture + "\nmodule.exports = { setup, billingView };")(
  (id) => id === "node:test" ? () => {} : require(id), __dirname, harness, harness.exports,
);
const { setup, billingView } = harness.exports;
const eventId = "refund-practice";
const creditId = (id) => "credit-" + eventId + "-" + id;
const today = () => billingView.taipeiDay(new Date());
function scenario() {
  const s = setup();
  for (const id of ["pending-member", "paid-member", "reported-member"]) {
    s.db.seed("members/" + id, { displayName: id, role: "MEMBER", membershipStatus: "GUEST", creditBalance: 0 });
    s.db.seed("events/" + eventId + "/bookings/" + id, { id, memberId: id, kindSnapshot: "GUEST", status: "REGULAR" });
  }
  s.db.seed("events/" + eventId, { id: eventId, startsAt: new Date(Date.now() + 2 * 86400000), endsAt: new Date(Date.now() + 3 * 86400000), courts: "測試場", status: "SCHEDULED", regularCount: 3, standbyCount: 0 });
  const seedInvoice = (id, status, grossAmount, creditApplied, rest = {}) => {
    s.db.seed("invoices/" + id, { id, memberId: id + "-member", memberNameSnapshot: id, eventId, type: "SINGLE_EVENT", status, amount: grossAmount - creditApplied, grossAmount, creditApplied, ...rest });
  };
  seedInvoice("pending", "PENDING", 150, 25);
  seedInvoice("paid", "CONFIRMED", 180, 20, { receipt: { amount: 160, method: "BANK", receivedDate: today() } });
  seedInvoice("reported", "REPORTED", 160, 10);
  return { ...s, seedInvoice };
}
async function cancel(s) {
  const quote = await s.mutate("previewCancelEvent", { eventId });
  return s.mutate("cancelEvent", { eventId, previewKey: quote.previewKey, reason: "場館取消" });
}

test("cancellation preview is read-only and rejects newly changed payment state before writes", async () => {
  const s = scenario();
  const quote = await s.mutate("previewCancelEvent", { eventId });
  assert.equal(quote.cancelledBookings, 3);
  assert.equal(quote.voidedInvoices, 1);
  assert.equal(quote.reducedAmount, 125);
  assert.equal(quote.creditedAmount, 45);
  assert.equal(quote.pendingCashRefundAmount, 160);
  assert.equal(quote.pendingCreditAmount, 160);
  assert.equal(s.db.data("events/" + eventId).status, "SCHEDULED");
  assert.equal(s.db.entries("balanceMovements/").length, 0);
  assert.equal(s.db.entries("notifications/").length, 0);
  s.seedInvoice("pending", "REPORTED", 150, 25);
  await assert.rejects(s.mutate("cancelEvent", { eventId, previewKey: quote.previewKey, reason: "場館取消" }), /重新預覽/);
  assert.equal(s.db.data("events/" + eventId).status, "SCHEDULED");
  assert.equal(s.db.entries("balanceMovements/").length, 0);
});

test("cancellation restores wallet once and sends previously paid cash to offline queue", async () => {
  const s = scenario();
  const quote = await s.mutate("previewCancelEvent", { eventId });
  const action = { eventId, previewKey: quote.previewKey, reason: "場館取消" };
  await s.mutate("cancelEvent", action);
  assert.equal(s.db.data("events/" + eventId).status, "CANCELLED");
  const reduced = s.db.data("invoices/pending");
  assert.equal(reduced.status, "VOID");
  assert.deepEqual([reduced.grossAmount, reduced.amount, reduced.adjustedGrossAmount, reduced.adjustedAmount], [150, 125, 0, 0]);
  assert.deepEqual([reduced.adjustments[0].kind, reduced.adjustments[0].amount, reduced.adjustments[0].reason], ["REDUCTION", -150, "場館取消"]);
  assert.equal(s.db.data("members/pending-member").creditBalance, 25);
  assert.equal(s.db.data("members/paid-member").creditBalance, 20);
  assert.deepEqual(
    ["status", "refundCashAmount", "refundWalletAmount", "originalReceiptMethod"].map((key) => s.db.data("invoices/" + creditId("paid"))[key]),
    ["AWAITING_OFFLINE_REFUND", 160, 20, "BANK"],
  );
  assert.equal(s.db.data("members/reported-member").creditBalance, 0);
  assert.equal(s.db.data("invoices/" + creditId("reported")).status, "AWAITING_PAYMENT_CONFIRMATION");
  const movementCount = s.db.entries("balanceMovements/").length;
  assert.deepEqual(await s.mutate("cancelEvent", action), quote);
  assert.equal(s.db.entries("balanceMovements/").length, movementCount);
});

test("only verified receipt releases a reported refund, and manual registration is atomic and idempotent", async () => {
  const s = scenario();
  await cancel(s);
  const refunds = JSON.stringify([{ id: creditId("paid"), amount: 160 }, { id: creditId("reported"), amount: 150 }]);
  const input = { eventId, method: "BANK", refundedDate: today(), offlineRefunded: "true", refunds };
  await assert.rejects(s.mutate("recordEventRefunds", input), /尚未確認收款/);
  await assert.rejects(s.mutate("recordEventRefunds", { ...input, offlineRefunded: "false" }), /先確認/);
  assert.equal(s.db.data("invoices/" + creditId("paid")).status, "AWAITING_OFFLINE_REFUND");
  await s.mutate("recordInvoiceReceipts", { method: "BANK", receivedDate: today(), invoices: JSON.stringify([{ id: "reported", amount: 150 }]) });
  assert.equal(s.db.data("members/reported-member").creditBalance, 10);
  assert.equal(s.db.data("invoices/" + creditId("reported")).status, "AWAITING_OFFLINE_REFUND");
  await assert.rejects(s.mutate("recordEventRefunds", { ...input, eventId: "wrong" }), /只能登記/);
  const recorded = await s.mutate("recordEventRefunds", input);
  assert.deepEqual(recorded, { recorded: 2, alreadyRecorded: 0, totalAmount: 310 });
  assert.deepEqual(await s.mutate("recordEventRefunds", input), { recorded: 0, alreadyRecorded: 2, totalAmount: 0 });
  const receipt = s.db.data("invoices/" + creditId("reported")).offlineRefundReceipt;
  assert.deepEqual([receipt.amount, receipt.method, receipt.refundedDate, receipt.recordedBy], [150, "BANK", today(), "admin"]);
  assert.equal(s.db.entries("auditLogs/").filter(([, entry]) => entry.action === "RECORD_EVENT_REFUNDS").length, 1);
  assert.equal(s.db.data("members/paid-member").creditBalance, 20);
  assert.equal(s.db.data("members/reported-member").creditBalance, 10);
});


test("public cancel requires a current preview even when no reason is supplied", async () => {
  const s = scenario();
  await assert.rejects(s.mutate("cancelEvent", { eventId }), /重新預覽/);
  assert.equal(s.db.data("events/" + eventId).status, "SCHEDULED");
  assert.equal(s.db.entries("balanceMovements/").length, 0);
});

test("rejecting a reported quarterly transfer removes only the canceled line and restores applied wallet only once", async () => {
  const s = scenario();
  const other = "next-practice";
  const startsAt = new Date(Date.now() + 10 * 86400000);
  s.db.seed("events/" + other, { id: other, status: "SCHEDULED", startsAt, endsAt: new Date(+startsAt + 3600000), regularCount: 0 });
  s.db.seed("invoices/reported", { id: "reported", type: "QUARTERLY_MEMBER", memberId: "reported-member", status: "REPORTED",
    grossAmount: 300, creditApplied: 100, amount: 200, eventIds: [eventId, other], eventAmounts: [150, 150] });
  await cancel(s);
  assert.equal(s.db.data("members/reported-member").creditBalance, 0);
  const input = { invoiceId: "reported", expectedStatus: "REPORTED", expectedAmount: "200", reason: "未入帳", checkedNotReceived: "true" };
  await s.mutate("rejectPaymentReport", input);
  const invoice = s.db.data("invoices/reported");
  assert.deepEqual([invoice.status, invoice.adjustedGrossAmount, invoice.adjustedCreditApplied, invoice.adjustedAmount], ["PENDING", 150, 100, 50]);
  assert.deepEqual(invoice.eventIds, [eventId, other]);
  assert.equal(s.db.data("invoices/" + creditId("reported")).status, "VOID");
  await assert.rejects(s.mutate("rejectPaymentReport", input), /已變更/);
  assert.equal(s.db.data("members/reported-member").creditBalance, 0);
  const quote = await s.mutate("previewCancelEvent", { eventId: other });
  await s.mutate("cancelEvent", { eventId: other, previewKey: quote.previewKey, reason: "再次取消場地" });
  assert.equal(s.db.data("members/reported-member").creditBalance, 100);
});
