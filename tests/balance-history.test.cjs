/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const filename = path.resolve(__dirname, "../src/lib/balance-history.ts");
const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", code)(() => { throw new Error("The balance history builder must not load runtime dependencies"); }, loaded, loaded.exports);
const { buildBalanceHistory } = loaded.exports;

const when = "2026-05-01T10:00:00.000Z";
const later = "2026-05-02T10:00:00.000Z";
function doc(id, data) { return { id, data: { memberId: "member", ...data } }; }
function history(overrides = {}) {
  return buildBalanceHistory({ memberId: "member", memberName: "社員", accountName: "member-account", currentBalance: 0, invoices: [], movements: [], audits: [], events: [], ...overrides });
}
function invoice(id, data = {}) { return doc(id, { type: "SINGLE_EVENT", status: "PENDING", grossAmount: 180, creditApplied: 0, amount: 180, createdAt: when, ...data }); }
function audit(id, delta, extra = {}) { return { id, data: { action: "UPDATE_MEMBER", targetMemberId: "member", before: { creditBalance: 100 }, after: { creditBalance: 100 + delta }, note: "補入款項", actorId: "admin", actorNameSnapshot: "幹部", createdAt: when, ...extra } }; }

test("pending, void, and offline-only refunds never become spendable balance", () => {
  const result = history({ invoices: [
    doc("pending", { type: "CREDIT", status: "AWAITING_PAYMENT_CONFIRMATION", amount: -150, createdAt: when }),
    doc("void", { type: "CREDIT", status: "VOID", amount: -150, createdAt: when }),
    doc("cash", { type: "CREDIT", status: "CONFIRMED", amount: -200, refundMode: "OFFLINE", cashRefund: 200, balanceRefund: 0, confirmedAt: when }),
    doc("unknown-split", { type: "CREDIT", status: "CONFIRMED", amount: -200, refundMode: "OFFLINE", confirmedAt: when }),
    doc("mixed", { type: "CREDIT", status: "CONFIRMED", amount: -200, refundMode: "OFFLINE", cashRefund: 150, balanceRefund: 50, confirmedAt: later }),
  ] });
  assert.deepEqual(result.entries.map((entry) => [entry.sourceKey, entry.amount]), [["invoice:mixed:credit", 50]]);
  assert.equal(result.entries[0].occurredAt, later);
});

test("administrator void restores only the recorded applied credit and keeps the original debit", () => {
  const result = history({ invoices: [invoice("bill", { status: "VOID", creditApplied: 80, amount: 100, updatedAt: "2030-01-01", adjustments: [{ kind: "VOID", restoredCredit: 80, amount: -100, createdAt: later, actorName: "幹部", reason: "重複開單" }] })] });
  assert.deepEqual(result.entries.map((entry) => [entry.sourceKey, entry.amount]), [["invoice:bill:void", 80], ["invoice:bill:apply", -80]]);
  assert.equal(result.entries[0].actorName, "幹部");
  assert.equal(result.totalIncreases, 80);
  assert.equal(result.totalDecreases, 80);
  assert.equal(result.unreconciledAmount, 0);
});

test("cancelled events already present at billing produce one net debit", () => {
  const result = history({ invoices: [invoice("quarter", { type: "QUARTERLY_MEMBER", creditApplied: 400, amount: 1100, adjustments: [
    { kind: "REDUCTION", eventId: "cancelled-before-billing", restoredCredit: 100, createdAt: when },
    { kind: "REDUCTION", eventId: "cancelled-after-billing", restoredCredit: 50, createdAt: later },
  ] })] });
  assert.deepEqual(result.entries.map((entry) => [entry.sourceKey, entry.amount]), [["invoice:quarter:reduction:cancelled-after-billing", 50], ["invoice:quarter:apply", -300]]);
  assert.equal(result.unreconciledAmount, 250);
});

test("stored movements take precedence by sourceKey and do not double count legacy invoices", () => {
  const result = history({ currentBalance: 20, invoices: [invoice("bill", { creditApplied: 80 })], movements: [
    doc("movement", { sourceKey: "invoice:bill:apply", amount: -80, createdAt: later, reason: "報名使用餘額", invoiceId: "bill", actorName: "社員" }),
    doc("duplicate", { sourceKey: "invoice:bill:apply", amount: -80, createdAt: later, reason: "重複輸入" }),
  ] });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].source, "ledger");
  assert.equal(result.entries[0].occurredAt, later);
  assert.equal(result.entries[0].reason, "報名使用餘額");
  assert.equal(result.currentBalance, 20);
  assert.equal(result.unreconciledAmount, 100);
  assert.equal("balanceAfter" in result.entries[0], false);
});

test("manual invoices match audits once and retain the audit actor; unmatched audits remain visible", () => {
  const result = history({ invoices: [doc("manual", { type: "ADJUSTMENT", status: "CONFIRMED", amount: -50, note: "補入款項", confirmedBy: "admin", createdAt: when })], audits: [audit("paired", 50), audit("fallback", -20, { createdAt: later, note: "更正" }), audit("no-money-change", 0)] });
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries.map((entry) => [entry.sourceKey, entry.amount]), [["audit:fallback:adjustment", -20], ["invoice:manual:adjustment", 50]]);
  assert.equal(result.entries[1].actorName, "幹部");
});

test("a manual movement suppresses both its invoice reconstruction and paired audit", () => {
  const result = history({ invoices: [doc("manual", { type: "ADJUSTMENT", status: "CONFIRMED", amount: -50, note: "補入款項", confirmedBy: "admin", createdAt: when })], audits: [audit("paired", 50)], movements: [doc("stored", { sourceKey: "invoice:manual:adjustment", amount: 50, reason: "補入款項", createdAt: when, invoiceId: "manual", actorName: "幹部" })] });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].source, "ledger");
});

test("equal manual events still pair one-to-one when only one invoice and movement survive", () => {
  const result = history({ invoices: [doc("manual", { type: "ADJUSTMENT", status: "CONFIRMED", amount: -50, note: "補入款項", confirmedBy: "admin", createdAt: when })], audits: [audit("first", 50), audit("second", 50)], movements: [doc("stored", { sourceKey: "invoice:manual:adjustment", amount: 50, reason: "補入款項", createdAt: when, invoiceId: "manual", actorId: "admin" })] });
  assert.equal(result.entries.length, 2);
  assert.equal(result.totalIncreases, 100);
  assert.equal(result.entries.filter((entry) => entry.source === "ledger").length, 1);
  assert.equal(result.entries.filter((entry) => entry.sourceKey.startsWith("audit:")).length, 1);
});

test("records for other members and nonfinancial audits are excluded", () => {
  const result = history({ invoices: [invoice("other-bill", { memberId: "someone-else", creditApplied: 80 })], movements: [doc("other-movement", { memberId: "someone-else", sourceKey: "other", amount: 50, createdAt: when })], audits: [audit("other-audit", 50, { targetMemberId: "someone-else" }), audit("name-audit", 50, { action: "UPDATE_DISPLAY_NAME" })] });
  assert.deepEqual(result.entries, []);
});

test("Timestamp, Date and ISO dates normalize consistently; event dates use Taipei time", () => {
  const result = history({ invoices: [invoice("bill", { creditApplied: 80, eventId: "event", createdAt: { toDate: () => new Date(when) }, periodLabel: "五月活動" })], movements: [doc("movement", { sourceKey: "independent", amount: 20, createdAt: new Date(later), eventId: "event", reason: "補款" })], events: [{ id: "event", data: { startsAt: "2026-05-01T17:30:00.000Z" } }] });
  assert.deepEqual(result.entries.map((entry) => entry.occurredAt), [later, when]);
  assert.deepEqual(result.entries[0].eventDates, ["2026-05-02"]);
  assert.equal(result.entries[1].invoiceLabel, "五月活動");
});

test("unknown cancellation dates stay unknown and updatedAt never becomes a transaction date", () => {
  const result = history({ invoices: [invoice("cancelled", { status: "CREDITED", creditApplied: 30, updatedAt: later }), invoice("event-void", { status: "VOID", cancellationReason: "EVENT_CANCELLED", creditApplied: 20, updatedAt: later })] });
  const returns = result.entries.filter((entry) => entry.amount > 0);
  assert.deepEqual(returns.map((entry) => entry.occurredAt), [null, null]);
  assert.deepEqual(returns.map((entry) => [entry.sourceKey, entry.amount]), [["invoice:cancelled:cancel", 180], ["invoice:event-void:event-cancel", 20]]);
});

test("old reissue and report rejection do not invent undocumented restored-credit amounts", () => {
  const result = history({ invoices: [invoice("old", { status: "VOID", cancellationReason: "ADMIN_VOID", replacedById: "new", creditApplied: 80, adjustments: [{ kind: "REISSUED", amount: -100, createdAt: later }] }), invoice("new", { replacementOfId: "old", creditApplied: 40 }), invoice("rejected", { creditApplied: 20, adjustedCreditApplied: 10, adjustments: [{ kind: "REPORT_REJECTED", amount: -150, beforeAmount: 160, afterAmount: 20, createdAt: later }] })] });
  assert.deepEqual(result.entries.map((entry) => entry.amount).sort((a, b) => a - b), [-80, -40, -20]);
  assert.equal(result.entries.some((entry) => entry.sourceKey.includes("reissue-return") || entry.sourceKey.includes("report-rejected")), false);
});

test("ambiguous quarter voids and malformed refund splits do not invent credits", () => {
  const result = history({ invoices: [invoice("quarter", { type: "QUARTERLY_MEMBER", status: "VOID", creditApplied: 80 }), doc("bad-split", { type: "CREDIT", status: "CONFIRMED", amount: -100, balanceRefund: "unknown" })] });
  assert.deepEqual(result.entries.map((entry) => [entry.sourceKey, entry.amount]), [["invoice:quarter:apply", -80]]);
});

test("missing, invalid and zero amounts are ignored without mutating inputs", () => {
  const input = { invoices: [invoice("none", { creditApplied: 0 }), doc("invalid", { type: "CREDIT", status: "CONFIRMED", amount: "NaN" })], movements: [doc("zero", { sourceKey: "zero", amount: 0 }), doc("bad", { sourceKey: "bad", amount: Infinity }), doc("bad-time", { sourceKey: "good", amount: 25, createdAt: { toDate() { throw new Error("bad timestamp"); } } })] };
  const invoicesBefore = JSON.stringify(input.invoices);
  const result = history(input);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].occurredAt, null);
  assert.equal(JSON.stringify(input.invoices), invoicesBefore);
  assert.equal(result.unreconciledAmount, -25);
});
