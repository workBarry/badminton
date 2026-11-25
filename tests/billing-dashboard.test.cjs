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
  assert.match(renderCard(true), /activity-detail-hit[^>]+aria-label="查看活動：羽球 · 測試球場 18:00–20:00"[^>]*aria-haspopup="dialog"/);
  assert.doesNotMatch(renderCard(true), /<input type="checkbox"/);
  assert.match(dateCell(renderCard(true)), /role="checkbox" aria-checked="false".*加入季費.*calendar-checked-mark/);
  const checkedCard = renderCard(true, event, [], true, [], [event.id]);
  assert.match(dateCell(checkedCard), /role="checkbox" aria-checked="true".*calendar-checked-mark/);
  assert.doesNotMatch(dateCell(checkedCard), /已選|calendar-date-tag/);
  assert.match(checkedCard, /季費已選 1 場/);
  assert.doesNotMatch(card, /calendar-checked-mark/);
  assert.doesNotMatch(renderCard(true, { ...event, memberBilling: "FREE" }), /calendar-checked-mark/);
  assert.doesNotMatch(renderCard(true), /社員加場費|開零打帳單|加到季費帳單/);
  assert.match(renderCard(true), /<dt>社員<\/dt><dd>未開單<\/dd>.*<dt>非社員<\/dt><dd>未開單<\/dd>/);
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
  assert.match(payerDialog, /測試球友<\/span><span class="badge orange">未繳費/);
  assert.match(payerDialog, /社員<\/span><span class="badge blue">待確認/);
  assert.match(payerDialog, /未報名的季費付款人<\/span><span class="badge orange">未繳費/);
  assert.doesNotMatch(payerDialog, /已作廢的人|本場金額為零|已繳清的人/);
  assert.match(renderDialog({ billingInvoices: payerBills, initialBillingOpen: false }), /測試球友.*未繳費/);
  assert.doesNotMatch(renderDialog({ billingInvoices: payerBills, isAdmin: false, initialBillingOpen: false }), /未繳費|待確認|未報名的季費付款人/);
  const paid = { ...bills[1], status: "CONFIRMED" };
  assert.match(renderCard(true, event, [bills[0], paid]), /<dt>社員<\/dt><dd>已結清<\/dd>.*<dt>非社員<\/dt><dd>未收齊<\/dd>/);
  const noCharge = { ...event, bookings: [], quarterEligible: false };
  assert.doesNotMatch(dateCell(renderCard(true, noCharge, [{ ...bills[0], status: "VOID" }, { ...bills[1], event_amounts: [0] }])), /calendar-fee-tag|data-fee-tone/);
  const panel = renderToStaticMarkup(React.createElement(GuestSettlementPanel, { event, publish: noop, refresh: noop }));
  assert.match(panel, /<option value="BILL">收費<\/option>/);
  assert.match(panel, />預覽開單</);
  assert.doesNotMatch(panel, /活動結束後/);
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
    openQuarter: (ids) => calls.previewed.push([...ids]),
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
  calendar.button("管理本場帳單").props.onClick();
  assert.deepEqual(calendar.calls.opened, [[event.id], [event.id, true]]);
  assert.deepEqual(calendar.calls.toggled, []);
  calendar.render({ list: [{ ...event, quarterEligible: false }] });
  hit = calendar.one(isCardHit, calendar.card(event.id));
  assert.equal(hit.props["aria-haspopup"], "dialog");
  assert.equal(calendar.all(isSelectionInput).length, 0);
  hit.props.onClick();
  assert.deepEqual(calendar.calls.opened, [[event.id], [event.id, true], [event.id]]);
  assert.deepEqual(calendar.calls.toggled, []);
});

test("選取失敗會顯示原因，成功後可預覽並清除已選活動", () => {
  const event = todayActivity();
  const calendar = calendarInteraction([event]);
  assert.equal(calendar.button("預覽季費 →").props.disabled, true);
  calendar.rejectSelection("請選同一個計費期間內的場次。");
  const dateButton = () => calendar.one((node) => node.type === "button" && node.props["aria-label"]?.startsWith(event.date + "，"));
  dateButton().props.onClick();
  calendar.render();
  assert.equal(elementText(calendar.one((node) => node.props.role === "alert")), "請選同一個計費期間內的場次。");
  assert.deepEqual(calendar.pickedIds(), []);
  assert.equal(calendar.button("預覽季費 →").props.disabled, true);

  calendar.rejectSelection("");
  dateButton().props.onClick();
  calendar.render();
  assert.equal(calendar.all((node) => node.props.role === "alert").length, 0);
  assert.equal(calendar.button("預覽季費 →").props.disabled, false);
  calendar.button("預覽季費 →").props.onClick();
  assert.deepEqual(calendar.calls.previewed, [[event.id]]);
  calendar.button("清除").props.onClick();
  calendar.render();
  assert.deepEqual(calendar.pickedIds(), []);
  assert.equal(dateButton().props["aria-checked"], false);
  assert.equal(calendar.button("預覽季費 →").props.disabled, true);
  assert.equal(calendar.all((node) => node.type === "button" && elementText(node) === "清除").length, 0);
});
