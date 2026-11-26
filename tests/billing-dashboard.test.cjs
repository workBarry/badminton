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

function render(viewerId, admin, selectedTab = "people", props = {}, state = {}) {
  const Dashboard = load("src/app/billing-dashboard.tsx", {
    "@/lib/billing-view": billingView,
    react: { ...React, useState: (initial) => React.useState(initial === "people" ? selectedTab : Object.hasOwn(state, initial) ? state[initial] : initial) },
  }).default;
  const noop = () => {};
  return renderToStaticMarkup(React.createElement(Dashboard, { admin, invoices, events, viewer: { id: viewerId, creditBalance: 0 },
    saving: false, reportPayment: noop, remindPayment: noop, openRates: noop, manage: async () => null, ...props }));
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
    assert.match(html, new RegExp(`待確認 1 筆 · NT\\$ ${reported}`));
    assert.match(html, new RegExp(`含逾期未繳 NT\\$ ${overdue}`));
    assert.match(html, /回報已轉帳（選用）/);
    assert.doesNotMatch(html, /確認收款/);
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
  assert.equal((queue.match(/>確認收款<span/g) ?? []).length, 5);
  assert.equal((queue.match(/type="checkbox"/g) ?? []).length, 5);
  assert.match(queue, /待確認/);
  assert.match(queue, /<button[^>]+class="billing-more-trigger"[^>]+popoverTarget=/i);
  assert.match(queue, /popover="auto" class="billing-more-actions"/);
  assert.doesNotMatch(queue, /<details class="billing-more">/);
  const html = render("admin", true, "activities");
  assert.match(html, /未繳 2 人/);
});


test("待收款用會員 ID 分組，同名不同帳號不合併；篩選後重算人數與小計", () => {
  const first = { ...invoices[0], memberName: "同名球友", memberAccountName: "first", event_schedules: [{ id: "practice", starts_at: "2026-11-30T10:00:00.000Z", courts: "第二球場" }] };
  const second = { ...invoices[2], memberName: "同名球友", memberAccountName: "first" };
  const other = { ...invoices[3], memberName: "同名球友", memberAccountName: "other" };
  const props = { invoices: [first, other, second] };
  const all = render("admin", true, "people", props);
  assert.match(all, /2 人 · 3 筆帳單/);
  assert.match(all, /billing-queue-item"><strong>季度社員費<\/strong><small>2026\/11\/30\s+18:00 · 第二球場<\/small>/);
  assert.equal((all.match(/class="billing-person-group"/g) ?? []).length, 2);
  assert.match(all, /<strong>同名球友<\/strong><small>first<\/small>.*?<strong>NT\$ 180<\/strong><small>2 筆/);
  assert.match(all, /<strong>同名球友<\/strong><small>other<\/small>.*?<strong>NT\$ 300<\/strong><small>1 筆/);
  const reported = render("admin", true, "people", props, { ALL: "REPORTED" });
  assert.match(reported, /1 人 · 1 筆帳單/);
  assert.match(reported, /billing-person-group" open=""/);
  assert.match(reported, /<strong>NT\$ 60<\/strong><small>1 筆/);
  assert.doesNotMatch(reported, /<small>other<\/small>/);
  const member = render("club-member", false, "people", props);
  assert.doesNotMatch(member, /billing-person-group|<small>other<\/small>/);
});

test("幹部的退款與帳務紀錄按人分組，指定帳單不必展開分組", () => {
  const open = invoices[0];
  const refund = { ...invoice(open.member_id, "CREDIT", "AWAITING_OFFLINE_REFUND", -40, 0), pending_refund_amount: 40 };
  const unconfirmed = { ...refund, id: "refund-2", status: "AWAITING_PAYMENT_CONFIRMATION", pending_refund_amount: 60 };
  const props = { invoices: [open, refund, unconfirmed, invoices[3]] };
  const refunds = render("admin", true, "refunds", props);
  assert.match(refunds, /class="billing-person-group" open=""/);
  assert.match(refunds, /<strong>NT\$ 40<\/strong><small>2 筆/);
  assert.match(refunds, /確認退款/);
  assert.match(refunds, /核對原付款/);
  const records = render("admin", true, "records", props);
  assert.equal((records.match(/class="billing-person-group"/g) ?? []).length, 2);
  assert.match(records, /按活動查看/);
  const focused = render("admin", true, "people", { ...props, focusInvoiceIds: [open.id], focusInvoice: { invoiceId: open.id } });
  assert.match(focused, /billing-invoice-target/);
  assert.doesNotMatch(focused, /billing-person-group/);
});


test("活動收費模式可從月曆直接選季費，單場帳務只有一個入口", () => {
  const { ActivityCalendar, EventDetailsDialog, CalendarIssueDialog, calendarBillingOptions } = load("src/app/page.tsx", {
    "@/lib/billing-view": billingView,
    "@/lib/club-roles": load("src/lib/club-roles.ts"),
    ...Object.fromEntries(["quarter-planner", "loading-screen", "shuttle-art", "billing-dashboard", "balance-history-dialog", "floating-notifications"].map((name) => ["@/app/" + name, {}])),
    "@/app/quarter-planner": { defaultBillingPeriod: () => ({ label: "本季社費", startDate: "2000-01-01", endDate: "2999-12-31" }) },
  }, "\nexport { ActivityCalendar, EventDetailsDialog, CalendarIssueDialog, calendarBillingOptions };");
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const start = new Date(date + "T18:00:00+08:00");
  const court = "測試球場";
  const event = { id: "activity-card", date, time: "18:00–20:00", startsAt: start.toISOString(), endsAt: new Date(+start + 3_600_000).toISOString(), status: "SCHEDULED",
    courts: court, guestFee: 180, quarterEligible: true, bookings: [{ rank: "正取", kind: "非社員", name: "測試球友", memberId: "guest" }] };
  const noop = () => {};
  const renderCard = (quarterMode, activity = event, existingBills = [], admin = true, periods = [], pickedIds = []) => renderToStaticMarkup(React.createElement(ActivityCalendar,
    { list: activity ? [activity] : [], invoices: existingBills, openEvent: noop, openIssue: admin ? noop : undefined, quarterMode, pickedIds, setPickedIds: noop, toggleQuarterEvent: noop, periods }));
  const dateCell = (markup) => markup.match(new RegExp('<button[^>]*class="calendar-day calendar-date-picker[^"]*"[^>]*aria-label="' + date + '，.*?</button>'))?.[0] ?? "";
  const draft = { id: "draft", status: "PLANNED", revision: "1", startDate: date, endDate: date, eventIds: [event.id] };
  const draftCalendar = renderCard(true, { ...event, bookings: [] }, [], true, [draft], [event.id]);
  assert.doesNotMatch(draftCalendar, />繼續編輯季費</);
  assert.match(dateCell(draftCalendar), /role="checkbox" aria-checked="true".*選取開單/);
  assert.match(draftCalendar, />核對帳單 →</);
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
  assert.doesNotMatch(renderCard(true), />管理本場帳單</);
  assert.match(dateCell(renderCard(true, { ...event, quarterEligible: false })), /role="checkbox".*選取開單/);
  assert.match(renderCard(true), /activity-detail-hit[^>]+aria-label="查看活動：羽球 · 測試球場 18:00–20:00"[^>]*aria-haspopup="dialog"/);
  assert.doesNotMatch(renderCard(true), /<input type="checkbox"/);
  assert.match(dateCell(renderCard(true)), /role="checkbox" aria-checked="false".*選取開單.*calendar-checked-mark/);
  const checkedCard = renderCard(true, event, [], true, [], [event.id]);
  assert.match(dateCell(checkedCard), /role="checkbox" aria-checked="true".*calendar-checked-mark/);
  assert.doesNotMatch(dateCell(checkedCard), /已選|calendar-date-tag/);
  assert.match(checkedCard, /已選 1 場/);
  assert.doesNotMatch(card, /calendar-checked-mark/);
  assert.doesNotMatch(renderCard(true, { ...event, memberBilling: "FREE" }), /calendar-checked-mark/);
  assert.doesNotMatch(renderCard(true), /社員加場費|開零打帳單|加到季費帳單/);
  assert.match(renderCard(true), /<dt>社員<\/dt><dd>未開單<\/dd>.*<dt>非社員<\/dt><dd>未開單<\/dd>/);
  const tabletop = { ...event, courts: "桌遊", eventKind: "OTHER", memberBilling: "NORMAL", memberFee: 150, quarterEligible: false };
  assert.match(renderCard(true, tabletop), /<dt>社員<\/dt><dd>無<\/dd>.*<dt>非社員<\/dt><dd>未開單<\/dd>/);
  assert.doesNotMatch(card, /calendar-payment-summary/);
  assert.doesNotMatch(renderCard(true, event, [], false), /calendar-payment-summary/);
  assert.doesNotMatch(renderCard(true, { ...event, memberBilling: "FREE" }), />管理本場帳單</);
  const paused = { ...event, memberBilling: "FREE", billingPaused: true };
  for (const [status, label] of [["PENDING", "未收齊"], ["REPORTED", "待確認"]]) {
    const bill = invoice("guest", "SINGLE_EVENT", status, 180, 7);
    const markup = renderCard(true, paused, [{ ...bill, event_id: event.id }]);
    assert.match(dateCell(markup), /data-fee-tone="outstanding"/);
    assert.match(markup, new RegExp("<dt>非社員</dt><dd>" + label + "</dd>"));
    assert.match(markup, /<dt>社員<\/dt><dd>不再開單<\/dd>/);
    assert.doesNotMatch(dateCell(markup), /role="checkbox"|未開單/);
  }
  const renderDialog = (options) => renderToStaticMarkup(React.createElement(EventDetailsDialog, {
    event: { ...event, startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 7_200_000).toISOString(),
      bookings: [...event.bookings, { rank: "正取", kind: "社員", name: "社員", memberId: "member" }] },
    viewerId: "admin", user: { member: true }, isAdmin: true, ...options,
  }));
  assert.match(renderDialog({}), /參加名單/);
  assert.doesNotMatch(renderDialog({ showEventBills: noop }), /管理本場帳單|開零打帳單|另開本場帳單/);
  assert.match(dateCell(renderCard(true)), /data-fee-tone="unbilled".*aria-label="[^"]*，未開單[^"]*"/);
  assert.doesNotMatch(dateCell(renderCard(true)), /calendar-fee-tag|收費標示圖例|>未開單</);
  assert.doesNotMatch(dateCell(card), /calendar-fee-tag|data-fee-tone/);
  assert.doesNotMatch(dateCell(renderCard(true, event, [], false)), /calendar-fee-tag|data-fee-tone/);
  assert.doesNotMatch(dateCell(renderCard(true, { ...event, memberBilling: "FREE" })), /calendar-fee-tag|data-fee-tone/);
  assert.doesNotMatch(dateCell(renderCard(true, { ...event, quarterEligible: false, bookings: [{ ...event.bookings[0], rank: "候補" }] })), /calendar-fee-tag|data-fee-tone/);
  assert.doesNotMatch(dateCell(renderCard(true, { ...event, quarterEligible: false, guestSettlements: [{ memberId: "guest", status: "SKIPPED" }] })), /calendar-fee-tag|data-fee-tone/);
  const bills = [
    { ...invoice("guest", "SINGLE_EVENT", "PENDING", 180, 7), event_id: event.id },
    { ...invoice("another", "MEMBER_EXTRA", "REPORTED", 150, 7), event_id: event.id },
  ];
  assert.match(dateCell(renderCard(true, event, bills)), /data-fee-tone="outstanding".*aria-label="[^"]*，未收齊，待確認[^"]*"/);
  assert.doesNotMatch(dateCell(renderCard(true, event, bills)), /未開單|>未收齊<|>待確認</);
  assert.match(renderCard(true, event, bills), /<dt>社員<\/dt><dd>待確認<\/dd>.*<dt>非社員<\/dt><dd>未收齊<\/dd>/);
  assert.match(dateCell(renderCard(true, event, [bills[0]])), /data-fee-tone="unbilled".*title="未開單、未收齊"/);
  assert.match(dateCell(renderCard(true, { ...event, bookings: [] })), /data-fee-tone="unbilled"/);
  assert.match(dateCell(renderCard(true, { ...event, quarterEligible: false }, [{ ...bills[0], status: "REPORTED" }])), /data-fee-tone="outstanding"/);
  const payerBills = [
    { ...bills[0], memberName: "零打付款人" },
    { ...bills[1], member_id: "member", memberName: "社員付款人" },
    { ...bills[1], member_id: "former", memberName: "未報名的季費付款人", type: "QUARTERLY_MEMBER",
      status: "PENDING", event_id: undefined, event_ids: [event.id], event_amounts: [150] },
    { ...bills[0], member_id: "void", memberName: "已作廢的人", status: "VOID" },
    { ...bills[0], member_id: "zero", memberName: "本場金額為零", event_ids: [event.id], event_amounts: [0] },
    { ...bills[0], member_id: "paid", memberName: "已繳清的人", status: "CONFIRMED" },
  ];
  const payerDialog = renderDialog({ billingInvoices: payerBills });
  assert.match(payerDialog, /測試球友.*未繳費/);
  assert.match(payerDialog, /社員.*待確認/);
  const attendeeRoster = payerDialog.match(/<section[^>]+aria-label="參加名單"[^>]*>.*?<\/section>/)?.[0] ?? "";
  const otherPayers = payerDialog.match(/<section[^>]+aria-label="其他待收款人"[^>]*>.*?<\/section>/)?.[0] ?? "";
  assert.match(attendeeRoster, /測試球友.*未繳費/);
  assert.match(attendeeRoster, /社員.*待確認/);
  assert.doesNotMatch(attendeeRoster, /未報名的季費付款人/);
  assert.match(otherPayers, /未報名的季費付款人<\/span>.*<span class="badge orange">未繳費/);
  assert.doesNotMatch(payerDialog, /已作廢的人|本場金額為零|已繳清的人/);
  assert.match(renderDialog({ billingInvoices: payerBills, initialBillingOpen: false }), /測試球友.*未繳費/);
  assert.doesNotMatch(renderDialog({ billingInvoices: payerBills, isAdmin: false, initialBillingOpen: false }), /未繳費|待確認|未報名的季費付款人/);
  const reported = renderDialog({ billingInvoices: payerBills, openInvoice: noop });
  assert.match(reported, /aria-label="社員，待確認，前往帳單"/);
  assert.doesNotMatch(reported, /aria-label="測試球友，待確認，前往帳單"/);
  const ended = renderDialog({
    event: { ...event, startsAt: new Date(Date.now() - 7_200_000).toISOString(),
      endsAt: new Date(Date.now() - 3_600_000).toISOString(),
      bookings: [...event.bookings, { ...event.bookings[0], rank: "候補", memberId: "wait" }] },
    viewerId: "guest", billingInvoices: payerBills, openInvoice: noop,
  });
  assert.doesNotMatch(ended, />正取</);
  assert.match(ended, />候補<\/span>/);
  assert.match(ended, />已報名<\/span>/);
  assert.match(ended, />未繳費<\/span>/);
  const paidRoster = (bills, isAdmin = true) => renderDialog({ billingInvoices: bills, isAdmin });
  assert.match(paidRoster([{ ...bills[0], status: "CONFIRMED" }]), /測試球友[^]*<span class="badge green">已繳費<\/span>/);
  assert.match(paidRoster([{ ...bills[0], status: "CONFIRMED", amount: 0, credit_applied: 180 }]), />已繳費</);
  assert.doesNotMatch(paidRoster([{ ...bills[0], status: "CONFIRMED", amount: 0 }]), />已繳費</);
  assert.doesNotMatch(paidRoster([{ ...bills[0], status: "CONFIRMED", event_ids: [event.id], event_amounts: [0] }]), />已繳費</);
  assert.doesNotMatch(paidRoster([{ ...bills[0], status: "CONFIRMED" }, bills[0]]), />已繳費</);
  assert.doesNotMatch(paidRoster([{ ...bills[0], status: "CONFIRMED" }], false), />已繳費</);
  const withMember = { ...event, startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    bookings: [{ memberId: "member-on-roster", kind: "社員", rank: "正取" }] };
  assert.equal(calendarBillingOptions(withMember, [], [], Date.now()).quarter, true);
  assert.equal(calendarBillingOptions(withMember, [], [], Date.now()).extra, false);
  assert.equal(calendarBillingOptions({ ...withMember, quarterEligible: false, memberBilling: "NO_CHARGE" }, [], [], Date.now()).extra, true);
  const day = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date(withMember.startsAt));
  const active = [{ ...draft, status: "ACTIVE", startDate: day, endDate: day, eventIds: [] }];
  const unlisted = { ...withMember, billingLabel: "尚未納入季度社費" };
  assert.equal(calendarBillingOptions(unlisted, [], active, Date.now()).supplement, true);
  const existingMemberCharge = { ...bills[0], type: "MEMBER_SINGLE", member_id: "member-on-roster" };
  assert.equal(calendarBillingOptions(unlisted, [existingMemberCharge], active, Date.now()).supplement, false);
  assert.equal(calendarBillingOptions({ ...unlisted, memberBilling: "FREE", billingPaused: true }, [], active, Date.now()).supplement, false);
  const mixed = { ...event, id: "mixed" };
  const guestOnly = { ...event, id: "guest-only", quarterEligible: false, memberBilling: "NO_CHARGE" };
  const fullyBilled = { ...guestOnly, id: "fully-billed" };
  const settledBill = { ...bills[0], event_id: fullyBilled.id, status: "CONFIRMED" };
  const mixedExisting = { ...bills[0], event_id: mixed.id };
  assert.equal(calendarBillingOptions(mixed, [mixedExisting], [], Date.now()).guests.length, 0);
  assert.equal(calendarBillingOptions(guestOnly, [], [], Date.now()).guests.length, 1);
  assert.equal(calendarBillingOptions(fullyBilled, [settledBill], [], Date.now()).guests.length, 0);
  const issue = renderToStaticMarkup(React.createElement(CalendarIssueDialog, {
    events: [event, mixed, guestOnly, fullyBilled], invoices: [settledBill, mixedExisting], periods: [], request: noop,
  }));
  assert.match(issue, />核對帳單<\/h2>/);
  assert.match(issue, /<summary>.*?<strong>季費<\/strong>.*?2 場<\/span><\/summary>/);
  assert.match(issue, /<summary><span><strong>零打<\/strong><\/span>.*?>2 場 · 1 人<\/span><\/summary>/);
  assert.equal((issue.match(/>確認開單<\/button>/g) ?? []).length, 1);
  assert.doesNotMatch(issue, /<details[^>]+ open|預覽季費|核對零打名單|改為單場補收|本次開季費|繳費期限/);
  const paid = { ...bills[1], status: "CONFIRMED" };
  assert.match(renderCard(true, event, [bills[0], paid]), /<dt>社員<\/dt><dd>已結清<\/dd>.*<dt>非社員<\/dt><dd>未收齊<\/dd>/);
  const noCharge = { ...event, bookings: [], quarterEligible: false };
  assert.doesNotMatch(dateCell(renderCard(true, noCharge, [{ ...bills[0], status: "VOID" }, { ...bills[1], event_amounts: [0] }])), /calendar-fee-tag|data-fee-tone/);

});

function elementText(element) {
  if (Array.isArray(element)) return element.map(elementText).join("");
  if (React.isValidElement(element)) return elementText(element.props.children);
  return typeof element === "string" || typeof element === "number" ? String(element) : "";
}

function calendarInteraction(list, quarterMode = true) {
  const state = [];
  let hookIndex = 0;
  let selectionError = "";
  let tree;
  const calls = { toggled: [], opened: [], previewed: [] };
  let props = {
    list, quarterMode, invoices: [], periods: [], pickedIds: [],
    openEvent: (...args) => calls.opened.push(args),
    openIssue: () => calls.previewed.push([...props.pickedIds]),
    setPickedIds: (ids) => { props.pickedIds = ids; },
    toggleQuarterEvent: (event) => {
      calls.toggled.push(event.id);
      if (selectionError) return selectionError;
      props.pickedIds = props.pickedIds.includes(event.id)
        ? props.pickedIds.filter((id) => id !== event.id) : [...props.pickedIds, event.id];
      return "";
    },
  };
  const { ActivityCalendar } = load("src/app/page.tsx", {
    react: {
      ...React,
      useEffect: () => {},
      useState: (initial) => {
        const index = hookIndex++;
        if (!Object.hasOwn(state, index)) state[index] = typeof initial === "function" ? initial() : initial;
        return [state[index], (value) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
      },
    },
    "@/lib/billing-view": billingView,
    "@/lib/club-roles": load("src/lib/club-roles.ts"),
    ...Object.fromEntries(["quarter-planner", "loading-screen", "shuttle-art", "billing-dashboard", "balance-history-dialog", "floating-notifications"].map((name) => ["@/app/" + name, {}])),
  }, "\nexport { ActivityCalendar };\n");
  function render(overrides = {}) {
    props = { ...props, ...overrides };
    hookIndex = 0;
    tree = ActivityCalendar(props);
  }
  function all(predicate, node = tree) {
    if (Array.isArray(node)) return node.flatMap((child) => all(predicate, child ?? null));
    if (!React.isValidElement(node)) return [];
    if (typeof node.type === "function" && node.type.name === "BillingSelectionBar") return all(predicate, node.type(node.props));
    return [...(predicate(node) ? [node] : []), ...all(predicate, node.props.children ?? null)];
  }
  function one(predicate, node = tree) {
    const matches = all(predicate, node);
    assert.equal(matches.length, 1, "Expected exactly one matching calendar control");
    return matches[0];
  }
  render();
  return {
    calls, render, all, one,
    rejectSelection: (message) => { selectionError = message; },
    pickedIds: () => props.pickedIds,
    card: (id) => one((node) => node.type === "article" && node.key === id),
    button: (label) => one((node) => node.type === "button" && elementText(node) === label),
  };
}

function todayActivity(id = "first") {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return {
    id, date, startsAt: date + "T18:00:00+08:00", endsAt: date + "T20:00:00+08:00",
    time: "18:00–20:00", courts: id + " 球場", status: "SCHEDULED", eventKind: "BADMINTON",
    memberBilling: "NORMAL", quarterEligible: true, guestFee: 180, bookings: [],
  };
}

const isCardHit = (node) => node.type === "button" && node.props.className === "activity-detail-hit";
const isSelectionInput = (node) => node.type === "input" && node.props.type === "checkbox";

test("單場日期格勾選季費，收費模式的卡片只開詳情", () => {
  const event = todayActivity();
  const calendar = calendarInteraction([event]);
  const dateButton = () => calendar.one((node) => node.type === "button" && node.props["aria-label"]?.startsWith(event.date + "，"));
  dateButton().props.onClick();
  calendar.render();
  assert.deepEqual(calendar.pickedIds(), [event.id]);
  assert.equal(dateButton().props["aria-checked"], true);
  const hit = calendar.one(isCardHit, calendar.card(event.id));
  assert.equal(hit.props.role, undefined);
  assert.equal(hit.props["aria-haspopup"], "dialog");
  assert.equal(calendar.all(isSelectionInput).length, 0);
  hit.props.onClick();
  assert.deepEqual(calendar.calls.opened, [[event.id]]);
  assert.deepEqual(calendar.calls.toggled, [event.id]);
  assert.deepEqual(calendar.pickedIds(), [event.id]);
  dateButton().props.onClick();
  calendar.render();
  assert.deepEqual(calendar.pickedIds(), []);
  assert.equal(dateButton().props["aria-checked"], false);
});

test("同日多場用各自的勾選框，卡片仍可看詳情", () => {
  const first = todayActivity("first");
  const second = todayActivity("second");
  const calendar = calendarInteraction([first, second]);
  calendar.one((node) => node.type === "button" && node.props["aria-label"]?.startsWith(first.date + "，")).props.onClick();
  calendar.render();
  calendar.one(isCardHit, calendar.card(first.id)).props.onClick();
  assert.deepEqual(calendar.calls.opened, [[first.id]]);
  assert.deepEqual(calendar.calls.toggled, []);
  const checkbox = (id) => calendar.one(isSelectionInput, calendar.card(id));
  checkbox(first.id).props.onChange();
  calendar.render();
  checkbox(second.id).props.onChange();
  calendar.render();
  assert.deepEqual(calendar.pickedIds(), [first.id, second.id]);
  assert.equal(checkbox(first.id).props.checked, true);
  assert.equal(checkbox(second.id).props.checked, true);
  checkbox(first.id).props.onChange();
  calendar.render();
  assert.deepEqual(calendar.pickedIds(), [second.id]);
  assert.deepEqual(calendar.calls.toggled, [first.id, second.id, first.id]);
});

test("一般模式與不可納入季費的活動維持開啟詳情，管理帳單不改變選擇", () => {
  const event = todayActivity();
  const calendar = calendarInteraction([event], false);
  let hit = calendar.one(isCardHit, calendar.card(event.id));
  assert.equal(hit.props["aria-haspopup"], "dialog");
  assert.equal(hit.props.role, undefined);
  assert.equal(calendar.all(isSelectionInput).length, 0);
  hit.props.onClick();
  assert.deepEqual(calendar.calls.opened, [[event.id]]);
  assert.deepEqual(calendar.calls.toggled, []);

  calendar.render({ quarterMode: true });
  assert.equal(calendar.all((node) => node.type === "button" && elementText(node) === "管理本場帳單").length, 0);
  calendar.one(isCardHit, calendar.card(event.id)).props.onClick();
  assert.deepEqual(calendar.calls.opened, [[event.id], [event.id]]);
  assert.deepEqual(calendar.calls.toggled, []);
  calendar.render({ list: [{ ...event, quarterEligible: false }] });
  hit = calendar.one(isCardHit, calendar.card(event.id));
  assert.equal(hit.props["aria-haspopup"], "dialog");
  assert.equal(calendar.all(isSelectionInput).length, 0);
  hit.props.onClick();
  assert.deepEqual(calendar.calls.opened, [[event.id], [event.id], [event.id]]);
  assert.deepEqual(calendar.calls.toggled, []);
});

test("選取失敗會顯示原因，成功後可預覽並清除已選活動", () => {
  const event = todayActivity();
  const calendar = calendarInteraction([event]);
  assert.equal(calendar.button("核對帳單 →").props.disabled, true);
  calendar.rejectSelection("請選同一個計費期間內的場次。");
  const dateButton = () => calendar.one((node) => node.type === "button" && node.props["aria-label"]?.startsWith(event.date + "，"));
  dateButton().props.onClick();
  calendar.render();
  assert.equal(elementText(calendar.one((node) => node.props.role === "alert")), "請選同一個計費期間內的場次。");
  assert.deepEqual(calendar.pickedIds(), []);
  assert.equal(calendar.button("核對帳單 →").props.disabled, true);

  calendar.rejectSelection("");
  dateButton().props.onClick();
  calendar.render();
  assert.equal(calendar.all((node) => node.props.role === "alert").length, 0);
  assert.equal(calendar.button("核對帳單 →").props.disabled, false);
  calendar.button("核對帳單 →").props.onClick();
  assert.deepEqual(calendar.calls.previewed, [[event.id]]);
  calendar.button("清除").props.onClick();
  calendar.render();
  assert.deepEqual(calendar.pickedIds(), []);
  assert.equal(dateButton().props["aria-checked"], false);
  assert.equal(calendar.button("核對帳單 →").props.disabled, true);
  assert.equal(calendar.all((node) => node.type === "button" && elementText(node) === "清除").length, 0);
});

test("新增羽球活動只提供收費與不收費，不會自動開單", () => {
  const { ActivityManagerModal } = load("src/app/page.tsx", {
    "@/lib/billing-view": billingView,
    "@/lib/club-roles": load("src/lib/club-roles.ts"),
    ...Object.fromEntries(["quarter-planner", "loading-screen", "shuttle-art", "billing-dashboard", "balance-history-dialog", "floating-notifications"].map((name) => ["@/app/" + name, {}])),
  }, "\nexport { ActivityManagerModal };");
  const props = { initialDate: "2027-01-08", tab: "single", saving: false, plans: [], existingDates: [], periods: [],
    currentFees: { member: 150, guest: 180 }, feeRates: [
      { kind: "MEMBER_VISIT", amount: 220, effective_from: "2027-01-08T17:00:00+08:00", effective_to: null },
      { kind: "GUEST_VISIT", amount: 250, effective_from: "2027-01-08T19:00:00+08:00", effective_to: null },
    ] };
  const markup = (overrides) => renderToStaticMarkup(React.createElement(ActivityManagerModal, { ...props, ...overrides }));
  const html = markup({});
  assert.match(html, /name="memberAmount"[^>]*value="220"/);
  assert.match(html, /name="guestAmount"[^>]*value="180"/);
  assert.match(markup({ periods: [{ status: "ACTIVE", startDate: "2027-01-01", endDate: "2027-03-31" }] }), /本場的社員費會另開，不改既有季費/);
  assert.match(markup({ initialDate: "", currentFees: { member: 155, guest: 185 } }), /name="guestAmount"[^>]*value="185"/);
  const choices = html.match(/<select[^>]+name="memberBilling"[^>]*>(.*?)<\/select>/)?.[1];
  assert.match(choices, /value="NORMAL" selected="">收費<\/option><option value="FREE">不收費<\/option>/);
  assert.equal((choices.match(/<option/g) ?? []).length, 2);
  assert.doesNotMatch(html, /先帶入目前費率|建立活動不會開單/);
  assert.doesNotMatch(markup({ initialDate: "" }), /先帶入目前費率|建立活動不會開單/);
});

test("編輯活動只鎖定已開單的價格，免費場不顯示金額", () => {
  const { EditEventBillingFields } = load("src/app/page.tsx", {
    "@/lib/billing-view": billingView,
    "@/lib/club-roles": load("src/lib/club-roles.ts"),
    ...Object.fromEntries(["quarter-planner", "loading-screen", "shuttle-art", "billing-dashboard", "balance-history-dialog", "floating-notifications"].map((name) => ["@/app/" + name, {}])),
  }, "\nexport { EditEventBillingFields };");
  const markup = (event, invoices = [], periods = []) => renderToStaticMarkup(React.createElement(EditEventBillingFields, { event, invoices, periods, currentFees: { member: 150, guest: 180 } }));
  const event = { id: "practice", eventKind: "BADMINTON", memberBilling: "NORMAL", memberFee: 215, guestFee: 240 };
  const html = markup(event, [invoice("guest", "SINGLE_EVENT", "PENDING", 240, 2)]);
  assert.doesNotMatch(html.match(/<select[^>]+name="memberBilling"[^>]*>/)[0], /disabled/);
  assert.doesNotMatch(html.match(/<input[^>]+name="memberAmount"[^>]*>/)[0], /disabled/);
  assert.match(html.match(/<input[^>]+name="guestAmount"[^>]*>/)[0], /disabled/);
  assert.match(html, /value="215"/);
  assert.match(markup(event, [], [{ status: "GENERATING", eventIds: [event.id] }]).match(/<input[^>]+name="memberAmount"[^>]*>/)[0], /disabled/);
  assert.doesNotMatch(markup({ ...event, memberBilling: "FREE" }), /name="(?:memberAmount|guestAmount)"/);
  const paused = markup({ ...event, memberBilling: "FREE", billingPaused: true, billingLocks: { member: true, guest: true } });
  assert.match(paused, /value="FREE" selected="">不收費/);
  assert.match(paused, /不再開新帳單，既有帳單不變/);
  assert.doesNotMatch(paused.match(/<select[^>]+name="memberBilling"[^>]*>/)[0], /disabled/);
  assert.match(markup({ ...event, memberBilling: "FREE" }, [], [{ status: "GENERATING", eventIds: [event.id] }]), /已確認的季費開單會繼續/);
});


test("總覽的下一場活動以台北日期顯示今日或明日，跨年也正確", () => {
  const { Overview } = load("src/app/page.tsx", {
    "@/lib/billing-view": billingView,
    "@/lib/club-roles": load("src/lib/club-roles.ts"),
    ...Object.fromEntries(["quarter-planner", "loading-screen", "shuttle-art", "billing-dashboard", "balance-history-dialog", "floating-notifications"].map((name) => ["@/app/" + name, {}])),
    react: { ...React, useState: () => [Date.parse("2026-12-31T15:50:00Z"), () => {}] },
  }, "\nexport { Overview };");
  const renderOverview = (startsAt) => renderToStaticMarkup(React.createElement(Overview, {
    event: { id: "next", startsAt, courts: "球場", time: "18:00–20:00", bookings: [] },
    user: { member: true },
  }));
  const today = renderOverview("2026-12-31T15:59:00Z");
  assert.match(today, /下一場活動<\/span><span class="badge green">今日<\/span>/);
  assert.match(today, /<strong>31<\/strong><span>12月<\/span>/);
  assert.match(renderOverview("2026-12-31T16:00:00Z"), /下一場活動<\/span><span class="badge blue">明日<\/span>/);
  assert.doesNotMatch(renderOverview("2027-01-01T16:00:00Z"), /今日|明日/);
});

test("公告跑馬燈沒有公告時不佔空間，副本不重複朗讀", () => {
  const { AnnouncementTicker } = load("src/app/page.tsx", {
    "@/lib/billing-view": billingView,
    "@/lib/club-roles": load("src/lib/club-roles.ts"),
    ...Object.fromEntries(["quarter-planner", "loading-screen", "shuttle-art", "billing-dashboard", "balance-history-dialog", "floating-notifications"].map((name) => ["@/app/" + name, {}])),
  }, "\nexport { AnnouncementTicker };");
  const news = ["置頂通知", "最新活動", "場地調整", "球友聚餐", "本週提醒", "較早的公告"].map((title, id) => ({ id: String(id), title }));
  const show = (props) => renderToStaticMarkup(React.createElement(AnnouncementTicker, props));
  assert.equal(show({ news: [] }), "");
  const html = show({ news, placement: "desktop" });
  assert.match(html, /aria-label="最新公告"/);
  assert.match(html, /data-paused="false"/);
  assert.match(html, /aria-description="按住跑馬燈或空白鍵可暫停"/);
  assert.match(html, /announcement-ticker-set" aria-hidden="true"/);
  assert.match(html, /置頂通知.*最新活動.*場地調整/);
  assert.doesNotMatch(html, /較早的公告/);
  for (const placement of ["desktop", "mobile", undefined]) {
    assert.doesNotMatch(show({ news, placement }), /查看公告|暫停跑馬燈|<a\s|<button/);
  }

  const initial = [];
  let hook = 0;
  const InteractiveTicker = load("src/app/page.tsx", {
    "@/lib/billing-view": billingView,
    "@/lib/club-roles": load("src/lib/club-roles.ts"),
    ...Object.fromEntries(["quarter-planner", "loading-screen", "shuttle-art", "billing-dashboard", "balance-history-dialog", "floating-notifications"].map((name) => ["@/app/" + name, {}])),
    react: { ...React, useState: (value) => {
      const i = hook++;
      if (!(i in initial)) initial[i] = value;
      return [initial[i], (next) => { initial[i] = typeof next === "function" ? next(initial[i]) : next; }];
    } },
  }, "\nexport { AnnouncementTicker };").AnnouncementTicker;
  const draw = () => { hook = 0; return InteractiveTicker({ news }).props; };
  const touch = { isPrimary: true, button: 0, pointerId: 7, currentTarget: {
    setPointerCapture: (id) => assert.equal(id, 7),
  } };
  draw().onPointerDown(touch);
  assert.equal(draw()["data-paused"], true);
  draw().onPointerUp({ pointerId: 9 });
  assert.equal(draw()["data-paused"], true);
  draw().onPointerUp(touch);
  assert.equal(draw()["data-paused"], false);
  for (const handler of ["onPointerCancel", "onLostPointerCapture"]) {
    draw().onPointerDown(touch);
    draw()[handler](touch);
    assert.equal(draw()["data-paused"], false);
  }
  draw().onKeyDown({ key: " ", preventDefault() {} });
  assert.equal(draw()["data-paused"], true);
  draw().onKeyUp({ key: " " });
  assert.equal(draw()["data-paused"], false);
});

test("即將到來清單只列未開始且未取消的活動，依日期排列", () => {
  const { UpcomingActivities } = load("src/app/page.tsx", {
    "@/lib/billing-view": billingView,
    "@/lib/club-roles": load("src/lib/club-roles.ts"),
    ...Object.fromEntries(["quarter-planner", "loading-screen", "shuttle-art", "billing-dashboard", "balance-history-dialog", "floating-notifications"].map((name) => ["@/app/" + name, {}])),
  }, "\nexport { UpcomingActivities };");
  const event = (courts, offset, status = "SCHEDULED") => ({ id: courts, courts, time: "18:00 – 20:00", startsAt: new Date(Date.now() + offset * 86_400_000).toISOString(), status });
  const renderList = (list) => renderToStaticMarkup(React.createElement(UpcomingActivities, { list, openEvent() {} }));
  const html = renderList([event("第二球館", 2), event("已開始球館", -1), event("已取消球館", 1, "CANCELLED"), event("第一球館", 1)]);
  assert.match(html, /aria-label="即將到來的活動"/);
  assert.match(html, /第一球館.*第二球館/);
  assert.match(html, /<time[^>]+dateTime="[^"]+"[^>]*><span>\d+\/\d+<\/span><span>\([一二三四五六日]\)<\/span>/i);
  assert.equal((html.match(/aria-haspopup="dialog"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /已開始球館|已取消球館/);
  assert.match(renderList([event("已開始球館", -1)]), /目前沒有即將到來的活動/);
});

test("活動收費列表共用可開單規則，可勾選已結束場次但不重開既有帳單", () => {
  const { ActivityBillingList } = load("src/app/page.tsx", {
    "@/lib/billing-view": billingView,
    "@/lib/club-roles": load("src/lib/club-roles.ts"),
    ...Object.fromEntries(["quarter-planner", "loading-screen", "shuttle-art", "billing-dashboard", "balance-history-dialog", "floating-notifications"].map((name) => ["@/app/" + name, {}])),
  }, "\nexport { ActivityBillingList };");
  const first = { id: "past-event", status: "SCHEDULED", eventKind: "OTHER", courts: "已結束桌遊", startsAt: "2020-11-27T10:00:00.000Z", time: "18:00 – 20:00", memberBilling: "NORMAL", memberFee: 150, guestFee: 180,
    bookings: [{ memberId: "payer", kind: "非社員", rank: "正取" }] };
  const billed = { ...first, id: "billed-event", courts: "已開單活動", startsAt: "2020-11-28T10:00:00.000Z" };
  const already = { ...invoice("payer", "SINGLE_EVENT", "PENDING", 180, 1), event_id: billed.id };
  const cancelled = { ...first, id: "cancelled-event", status: "CANCELLED", courts: "已取消活動" };
  const future = { ...first, id: "free-event", courts: "未來免費活動", memberBilling: "FREE", startsAt: new Date(Date.now() + 86_400_000).toISOString() };
  const html = renderToStaticMarkup(React.createElement(ActivityBillingList,
    { list: [first, billed, cancelled, future], invoices: [already], periods: [], pickedIds: [first.id, billed.id], toggleEvent: () => "", clear() {}, openIssue() {} }));
  assert.match(html, /aria-label="活動收費列表"/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 1);
  assert.match(html, /選取開單：已結束桌遊/);
  assert.match(html, /<span>11\/27<\/span><span>\(五\)<\/span>/);
  assert.match(html, /已選 1 場/);
  assert.match(html, /data-fee-tone="outstanding".*未收齊/);
  assert.match(html, /未來免費活動.*已開單活動/);
  assert.match(html, /<label class="mobile-activity-list-card mobile-billing-check">.*已結束桌遊.*type="checkbox".*<\/label>/);
  assert.doesNotMatch(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /已取消活動/);
});

test("總覽時鐘顯示台北日期到分鐘，午夜後不沿用上一天", () => {
  let now = "2026-12-31T15:59:59.000Z";
  const { OverviewClock } = load("src/app/page.tsx", {
    react: { ...React, useState: () => React.useState(Date.parse(now)) },
    "@/lib/billing-view": billingView,
    "@/lib/club-roles": load("src/lib/club-roles.ts"),
    ...Object.fromEntries(["quarter-planner", "loading-screen", "shuttle-art", "billing-dashboard", "balance-history-dialog", "floating-notifications"].map((name) => ["@/app/" + name, {}])),
  }, "\nexport { OverviewClock };");
  const markup = () => renderToStaticMarkup(React.createElement(OverviewClock));
  assert.match(markup(), /2026年12月31日 23:59/);
  now = "2026-12-31T16:00:00.000Z";
  assert.match(markup(), /2027年1月1日 00:00/);
});
