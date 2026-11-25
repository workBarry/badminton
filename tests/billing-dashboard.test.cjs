/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");

function load(relative, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  });
  const loaded = { exports: {} };
  new Function("require", "module", "exports", outputText)((id) =>
    Object.hasOwn(dependencies, id) ? dependencies[id] : require(id), loaded, loaded.exports);
  return loaded.exports;
}

const billingView = load("src/lib/billing-view.ts");
const invoice = (memberId, type, status, amount, daysUntilDue) => ({
  id: `${memberId}-${status}-${amount}`, member_id: memberId, memberName: memberId, type, status,
  amount, gross_amount: amount, credit_applied: 0, event_id: "practice",
  period_start: "2000-01-01", period_end: "2999-12-31",
  due_at: new Date(Date.now() + daysUntilDue * 86_400_000).toISOString(),
});
const invoices = [
  invoice("club-member", "QUARTERLY_MEMBER", "PENDING", 120, -7),
  invoice("club-member", "QUARTERLY_MEMBER", "PENDING", 80, 7),
  invoice("club-member", "QUARTERLY_MEMBER", "REPORTED", 60, -7),
  invoice("club-guest", "SINGLE_EVENT", "PENDING", 300, -7),
  invoice("club-guest", "SINGLE_EVENT", "REPORTED", 400, 7),
];
const events = [{ id: "practice", startsAt: new Date().toISOString(), courts: "球場",
  bookings: [{ memberId: "club-member", name: "club-member", kind: "社員" }, { memberId: "club-guest", name: "club-guest", kind: "非社員" }] }];

function render(viewerId, admin, selectedTab = "people") {
  const Dashboard = load("src/app/billing-dashboard.tsx", {
    "@/lib/billing-view": billingView,
    react: { ...React, useState: (initial) => React.useState(initial === "people" ? selectedTab : initial) },
  }).default;
  const noop = () => {};
  return renderToStaticMarkup(React.createElement(Dashboard, { admin, invoices, events, viewer: { id: viewerId, creditBalance: 0 },
    saving: false, reportPayment: noop, remindPayment: noop, openRates: noop, manage: async () => null }));
}

for (const [role, viewer, other, amount, reported, overdue] of [
  ["社員", "club-member", "club-guest", 200, 60, 120],
  ["非社員", "club-guest", "club-member", 300, 400, 300],
]) {
  test(`${role}只看到自己的待結清金額和選用回報，活動不顯示人數`, () => {
    const html = render(viewer, false);
    assert.doesNotMatch(html, /未繳人數/);
    assert.doesNotMatch(html, new RegExp(other));
    assert.match(html, new RegExp(`待結清金額</span><strong>NT\\$ ${amount + reported}`));
    assert.match(html, new RegExp(`待對帳 1 筆 · NT\\$ ${reported}`));
    assert.match(html, new RegExp(`含逾期未繳 NT\\$ ${overdue}`));
    assert.match(html, /回報已轉帳（選用）/);
    assert.doesNotMatch(html, /登記收款/);
    const activity = render(viewer, false, "activities");
    assert.match(activity, /球場/);
    assert.match(activity, new RegExp(viewer));
    assert.doesNotMatch(activity, new RegExp(other));
    assert.doesNotMatch(activity, /未繳 \d+ 人/);
  });
}

test("幹部以同一清單直接登記未回報與已回報的款，活動檢視保留人數", () => {
  const queue = render("admin", true);
  assert.match(queue, /待收款總額<\/span><strong>NT\$ 960/);
  assert.equal((queue.match(/>登記收款<span/g) ?? []).length, 5);
  assert.equal((queue.match(/type="checkbox"/g) ?? []).length, 5);
  assert.match(queue, /已回報，待對帳/);
  assert.match(queue, /<details class="billing-more">/);
  const html = render("admin", true, "activities");
  assert.match(html, /未繳 2 人/);
});
