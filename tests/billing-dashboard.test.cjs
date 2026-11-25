/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");

function load(relative, dependencies = {}, testExports = "") {
  const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8") + testExports;
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


test("活動收費模式可從月曆直接選季費，單場帳務只有一個入口", () => {
  const { ActivityCalendar, EventDetailsDialog, GuestSettlementPanel } = load("src/app/page.tsx", {
    "@/lib/billing-view": billingView,
    "@/lib/club-roles": load("src/lib/club-roles.ts"),
    ...Object.fromEntries(["quarter-planner", "loading-screen", "shuttle-art", "billing-dashboard", "balance-history-dialog", "floating-notifications"].map((name) => ["@/app/" + name, {}])),
  }, "\nexport { ActivityCalendar, EventDetailsDialog, GuestSettlementPanel };");
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const start = new Date(date + "T18:00:00+08:00");
  const court = "測試球場";
  const event = { id: "activity-card", date, time: "18:00–20:00", startsAt: start.toISOString(), endsAt: new Date(+start + 3_600_000).toISOString(), status: "SCHEDULED",
    courts: court, guestFee: 180, quarterEligible: true, bookings: [{ rank: "正取", kind: "非社員", name: "測試球友", memberId: "guest" }] };
  const noop = () => {};
  const renderCard = (quarterMode, activity = event, existingBills = [], admin = true, periods = [], pickedIds = []) => renderToStaticMarkup(React.createElement(ActivityCalendar,
    { list: activity ? [activity] : [], invoices: existingBills, openEvent: noop, openQuarter: admin ? noop : undefined, quarterMode, pickedIds, setPickedIds: noop, toggleQuarterEvent: noop, periods }));
  const dateCell = (markup) => markup.match(new RegExp('<button[^>]*class="calendar-day calendar-date-picker[^"]*"[^>]*aria-label="' + date + '，.*?</button>'))?.[0] ?? "";
  const draft = { id: "draft", status: "PLANNED", revision: "1", startDate: date, endDate: date, eventIds: [event.id] };
  assert.match(renderCard(true, event, [], true, [draft]), />繼續編輯季費</);
  assert.doesNotMatch(renderCard(true, event, [], true, [{ ...draft, status: "GENERATING" }]), />繼續編輯季費</);
  assert.doesNotMatch(renderCard(false, event, [], true, [draft]), />繼續編輯季費</);
  assert.doesNotMatch(renderCard(true), />繼續編輯季費</);
  const emptyMonth = renderCard(false, null);
  assert.match(emptyMonth, /本月共 0 場活動/);
  assert.doesNotMatch(emptyMonth, /本月尚無活動/);
  const card = renderCard(false);
  assert.match(card, /activity-detail-hit[^>]+aria-label="查看活動：羽球 · 測試球場 18:00–20:00"[^>]*aria-haspopup="dialog"/);
  assert.doesNotMatch(card, />活動詳情/);
  assert.doesNotMatch(card, /管理本場帳單|開零打帳單/);
  assert.match(renderCard(true), />管理本場帳單</);
  assert.match(dateCell(renderCard(true)), /role="checkbox" aria-checked="false".*加入季費.*calendar-checked-mark/);
  const checkedCard = renderCard(true, event, [], true, [], [event.id]);
  assert.match(dateCell(checkedCard), /role="checkbox" aria-checked="true".*calendar-checked-mark/);
  assert.doesNotMatch(dateCell(checkedCard), /已選|calendar-date-tag/);
  assert.match(checkedCard, /季費已選 1 場/);
  assert.doesNotMatch(card, /calendar-checked-mark/);
  assert.doesNotMatch(renderCard(true, { ...event, memberBilling: "FREE" }), /calendar-checked-mark/);
  assert.doesNotMatch(renderCard(true), /社員加場費|開零打帳單|加到季費帳單/);
  assert.match(renderCard(true), /<dt>社員<\/dt><dd>無應收帳單<\/dd>.*<dt>非社員<\/dt><dd>待開單<\/dd>/);
  assert.doesNotMatch(card, /calendar-payment-summary/);
  assert.doesNotMatch(renderCard(true, event, [], false), /calendar-payment-summary/);
  assert.doesNotMatch(renderCard(true, { ...event, memberBilling: "FREE" }), />管理本場帳單</);
  const renderDialog = (options) => renderToStaticMarkup(React.createElement(EventDetailsDialog, {
    event: { ...event, startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7_200_000).toISOString(),
      bookings: [...event.bookings, { rank: "正取", kind: "社員", name: "社員", memberId: "member" }] },
    viewerId: "admin", user: { member: true }, isAdmin: true, initialBillingOpen: true,
    hasMemberBill: false, hasLinkedPeriod: false, ...options,
  }));
  const billingDialog = renderDialog({});
  assert.doesNotMatch(billingDialog, /加入季費|加到季費帳單/);
  assert.match(billingDialog, />開零打帳單</);
  assert.match(billingDialog, />另開本場帳單</);
  assert.doesNotMatch(billingDialog, /參加名單|社員加場費/);
  assert.doesNotMatch(renderDialog({ hasLinkedPeriod: true }), />另開本場帳單</);
  assert.match(renderDialog({ showEventBills: noop }), />查看已開帳單</);
  assert.match(dateCell(renderCard(true)), /has-fee-task.*aria-label="[^"]*，待開單[^"]*"/);
  assert.doesNotMatch(dateCell(renderCard(true)), /calendar-fee-tag|收費標示圖例|>待開單</);
  assert.doesNotMatch(dateCell(card), /calendar-fee-tag|has-fee-task/);
  assert.doesNotMatch(dateCell(renderCard(true, event, [], false)), /calendar-fee-tag|has-fee-task/);
  assert.doesNotMatch(dateCell(renderCard(true, { ...event, memberBilling: "FREE" })), /calendar-fee-tag|has-fee-task/);
  assert.doesNotMatch(dateCell(renderCard(true, { ...event, bookings: [{ ...event.bookings[0], rank: "候補" }] })), /calendar-fee-tag|has-fee-task/);
  assert.doesNotMatch(dateCell(renderCard(true, { ...event, guestSettlements: [{ memberId: "guest", status: "SKIPPED" }] })), /calendar-fee-tag|has-fee-task/);
  const bills = [
    { ...invoice("guest", "SINGLE_EVENT", "PENDING", 180, 7), event_id: event.id },
    { ...invoice("another", "MEMBER_EXTRA", "REPORTED", 150, 7), event_id: event.id },
  ];
  assert.match(dateCell(renderCard(true, event, bills)), /has-fee-task.*aria-label="[^"]*，待收款，待核對[^"]*"/);
  assert.doesNotMatch(dateCell(renderCard(true, event, bills)), /待開單|>待收款<|>待核對</);
  assert.match(renderCard(true, event, bills), /<dt>社員<\/dt><dd>待核對<\/dd>.*<dt>非社員<\/dt><dd>待繳<\/dd>/);
  const paid = { ...bills[1], status: "CONFIRMED" };
  assert.match(renderCard(true, event, [bills[0], paid]), /<dt>社員<\/dt><dd>已結清<\/dd>.*<dt>非社員<\/dt><dd>待繳<\/dd>/);
  const noCharge = { ...event, bookings: [], quarterEligible: false };
  assert.doesNotMatch(dateCell(renderCard(true, noCharge, [{ ...bills[0], status: "VOID" }, { ...bills[1], event_amounts: [0] }])), /calendar-fee-tag|has-fee-task/);
  const panel = renderToStaticMarkup(React.createElement(GuestSettlementPanel, { event, publish: noop, refresh: noop }));
  assert.match(panel, /<option value="BILL">收費<\/option>/);
  assert.match(panel, />預覽開單</);
  assert.doesNotMatch(panel, /活動結束後/);
});
