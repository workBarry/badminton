"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { activityPayments, billingSummary, invoiceEventLines, invoiceInRange, isOpen, isPrincipal, referencesEvent, taipeiDay, type BillingActivity, type ManagedInvoice } from "@/lib/billing-view";

type ActionResult = { results?: { id: string; success: boolean; error?: string }[]; status?: string; invoiceId?: string; recorded?: number; alreadyRecorded?: number; totalAmount?: number };
export type BillingProps = {
  admin: boolean; invoices: ManagedInvoice[]; viewer: { id: string; name?: string; creditBalance: number }; saving: boolean;
  events?: BillingActivity[];
  focusEventId?: string | null;
  clearFocusEvent?: () => void;
  openEvent?: (eventId: string) => void;
  reportPayment: (id: string) => void; remindPayment: (id: string) => void; openRates: () => void;
  manage?: (action: string, input: Record<string, string>) => Promise<ActionResult | null>;
};
const labels: Record<string, string> = { PENDING: "待繳", REPORTED: "已回報，待對帳", CONFIRMED: "已結清", VOID: "已作廢", CREDITED: "已退回餘額", REFUNDED: "已退款", AWAITING_PAYMENT_CONFIRMATION: "原付款待核對", AWAITING_OFFLINE_REFUND: "待退款" };
const types: Record<string, string> = { QUARTERLY_MEMBER: "季度社員費", MEMBERSHIP_PRORATED: "中途加入社員費", MEMBER_EXTRA: "社員加場費", SINGLE_EVENT: "零打活動費", CREDIT: "退款／餘額紀錄" };
const money = (amount: number) => "NT$ " + amount.toLocaleString("zh-TW");
const receiptMax = 20;
const collectable = (invoice: ManagedInvoice) => isOpen(invoice) && Number.isSafeInteger(invoice.amount) && invoice.amount > 0;
const overdue = (invoice: ManagedInvoice) => invoice.status === "PENDING" && invoice.due_at && Date.parse(invoice.due_at) < Date.now();
const invoiceStatusLabel = (invoice: ManagedInvoice) => invoice.refund_completed_date ? "已退款"
  : invoice.type === "CREDIT" && (invoice.refund_wallet_amount ?? 0) > 0 && invoice.status === "CONFIRMED" ? "已退回餘額"
  : labels[invoice.status] ?? invoice.status;
const receiptMethod = (method?: string | null) => method === "CASH" ? "現金" : method === "BANK" ? "轉帳" : "";
function schedule(value?: string | null) { return value ? new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "日期未設定"; }
type Operation = "voidInvoice" | "reissueInvoice" | "refundInvoice" | "rejectPaymentReport";
type Selection = { operation: Operation; invoice: ManagedInvoice } | { operation: "voidInvoiceBatch"; invoices: ManagedInvoice[]; excluded: number };
const operationLabels = { voidInvoice: "作廢帳單", reissueInvoice: "作廢並重開", refundInvoice: "辦理退款", rejectPaymentReport: "核對未入帳，退回待繳", voidInvoiceBatch: "批次作廢未繳帳單" };

export default function BillingDashboard(props: BillingProps) {
  const { admin, viewer, saving, events = [], manage } = props;
  const invoices = admin ? props.invoices : props.invoices.filter((invoice) => invoice.member_id === viewer.id);
  const [tab, setTab] = useState<"people" | "activities" | "records" | "refunds">("people");
  const [refundIds, setRefundIds] = useState<string[]>([]);
  const [refundRows, setRefundRows] = useState<ManagedInvoice[] | null>(null);
  const [period, setPeriod] = useState("ALL");
  const [search, setSearch] = useState("");
  const [queueFilter, setQueueFilter] = useState<"ALL" | "REPORTED">("ALL");
  const [ledgerType, setLedgerType] = useState("CHARGES");
  const [showVoided, setShowVoided] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [receiptRows, setReceiptRows] = useState<ManagedInvoice[] | null>(null);
  const [feedback, setFeedback] = useState("");
  const periods = [...new Map(invoices.filter((invoice) => invoice.period_id && invoice.period_start && invoice.period_end).map((invoice) => [invoice.period_id!, { id: invoice.period_id!, label: invoice.period_label ?? "季度", start: invoice.period_start!, end: invoice.period_end! }])).values()].sort((a, b) => b.start.localeCompare(a.start));
  const today = taipeiDay(new Date());
  const currentPeriod = periods.find((entry) => entry.start <= today && entry.end >= today);
  const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
  const startMonth = Math.floor((month - 1) / 3) * 3;
  const fallback = { start: new Date(Date.UTC(year, startMonth, 1)).toISOString().slice(0, 10), end: new Date(Date.UTC(year, startMonth + 3, 0)).toISOString().slice(0, 10) };
  const range = period === "ALL" ? null : period === "CURRENT" ? currentPeriod ?? fallback : periods.find((entry) => entry.id === period) ?? fallback;
  const inRange = (invoice: ManagedInvoice) => !range || invoiceInRange(invoice, range.start, range.end);
  const scoped = invoices.filter(inRange);
  const filtered = scoped.filter((invoice) => (invoice.memberName + " " + (invoice.memberAccountName ?? "") + " " + invoice.period_label + " " + (invoice.event_schedules?.map((entry) => taipeiDay(entry.starts_at ?? "")).join(" ") ?? "")).toLowerCase().includes(search.toLowerCase().trim()));
  const summary = billingSummary(scoped);
  const outside = invoices.filter((invoice) => !inRange(invoice) && isOpen(invoice));
  const queue = filtered.filter((invoice) => isOpen(invoice) && (queueFilter === "ALL" || invoice.status === "REPORTED"))
    .sort((a, b) => Number(b.status === "REPORTED") - Number(a.status === "REPORTED") || String(a.due_at ?? "9999").localeCompare(String(b.due_at ?? "9999")));
  const selected = queue.filter((invoice) => selectedIds.includes(invoice.id) && collectable(invoice));
  const totalPending = summary.unpaidAmount + summary.reportedAmount;
  const refunds = filtered.filter((invoice) => ["AWAITING_OFFLINE_REFUND", "AWAITING_PAYMENT_CONFIRMATION"].includes(invoice.status));
  const selectedRefunds = refunds.filter((invoice) => refundIds.includes(invoice.id) && invoice.status === "AWAITING_OFFLINE_REFUND");
  const refundEventId = selectedRefunds[0]?.event_id;
  const refundSum = scoped.filter((invoice) => invoice.status === "AWAITING_OFFLINE_REFUND").reduce((sum, invoice) => sum + (invoice.pending_refund_amount ?? 0), 0);
  const recordRefunds = async (input: Record<string, string>) => {
    const eventId = refundRows?.[0]?.event_id;
    if (!admin || !eventId || !refundRows || !manage || saving) return;
    const result = await manage("recordEventRefunds", { ...input, offlineRefunded: "true", eventId, refunds: JSON.stringify(refundRows.map((invoice) => ({ id: invoice.id, amount: invoice.pending_refund_amount }))) });
    if (!result || typeof result.recorded !== "number") return;
    setRefundRows(null);
    setRefundIds([]);
    setFeedback(result.recorded ? `已登記 ${result.recorded} 筆退款 · ${money(result.totalAmount ?? 0)}。` : "這些退款已登記，沒有重複處理。");
  };
  const ledger = filtered.filter((invoice) => (admin || !isPrincipal(invoice) || !isOpen(invoice)) && (showVoided || invoice.status !== "VOID") && (ledgerType === "ALL" || (ledgerType === "CHARGES" ? isPrincipal(invoice) : !isPrincipal(invoice))));
  const activityList = events.filter((event) => (!range || (taipeiDay(event.startsAt ?? "") >= range.start && taipeiDay(event.startsAt ?? "") <= range.end)) && (event.courts + " " + taipeiDay(event.startsAt ?? "") + " " + event.bookings.map((booking) => booking.name + " " + (booking.accountName ?? "")).join(" ")).toLowerCase().includes(search.toLowerCase().trim())).sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)));
  const openOperation = (operation: Operation, invoice: ManagedInvoice) => { setSelection({ operation, invoice }); setFeedback(""); };
  const openReceipt = (rows: ManagedInvoice[]) => { setReceiptRows(rows); setFeedback(""); };
  const recordReceipts = async (input: Record<string, string>) => {
    if (!admin || !manage || !receiptRows || saving) return;
    const result = await manage("recordInvoiceReceipts", {
      ...input,
      invoices: JSON.stringify(receiptRows.map(({ id, amount }) => ({ id, amount }))),
    });
    if (!result || typeof result.recorded !== "number") return;
    setReceiptRows(null);
    setSelectedIds([]);
    setFeedback(result.recorded ? `已登記 ${result.recorded} 筆收款 · ${money(result.totalAmount ?? 0)}。${result.alreadyRecorded ? `另有 ${result.alreadyRecorded} 筆已登記，未重複處理。` : ""}` : "這些款項已登記，沒有重複入帳。");
  };
  const submit = async (input: Record<string, string>) => {
    if (!selection || !manage) return;
    const result = await manage(selection.operation, input);
    if (!result) return;
    setSelection(null);
    if (result.results) {
      const failed = result.results.filter((entry) => !entry.success);
      setFeedback("已作廢 " + result.results.filter((entry) => entry.success).length + " 筆。" + (failed.length ? "未完成：" + failed.map((entry) => entry.id + "（" + entry.error + "）").join("、") : ""));
    } else setFeedback(operationLabels[selection.operation] + "已完成。");
  };
  const renderMore = (invoice: ManagedInvoice) => {
    const mayReport = invoice.status === "PENDING" && invoice.member_id === viewer.id && isPrincipal(invoice);
    const mayRemind = admin && invoice.status === "PENDING" && invoice.member_id !== viewer.id;
    const mayReject = admin && manage && isPrincipal(invoice) && invoice.status === "REPORTED";
    const mayVoid = admin && manage && isPrincipal(invoice) && invoice.status === "PENDING";
    const mayReissue = admin && manage && isPrincipal(invoice) && !invoice.replaced_by_id && (invoice.status === "PENDING" || (invoice.status === "VOID" && invoice.cancellation_reason === "ADMIN_VOID"));
    const mayRefund = admin && manage && isPrincipal(invoice) && !invoices.some((entry) => entry.related_invoice_id === invoice.id && ["AWAITING_OFFLINE_REFUND", "AWAITING_PAYMENT_CONFIRMATION"].includes(entry.status)) && invoice.status === "CONFIRMED" && (invoice.refundable_amount ?? 0) > 0;
    return (mayReport || mayRemind || mayReject || mayVoid || mayReissue || mayRefund) && <details className="billing-more">
      <summary>更多<span className="billing-sr-only">：{invoice.memberName}的帳單</span></summary>
      <div className="billing-more-actions">
        {mayReport && <button className="link" disabled={saving} onClick={() => props.reportPayment(invoice.id)}>回報已轉帳（選用）</button>}
        {mayRemind && <button className="link" disabled={saving} onClick={() => props.remindPayment(invoice.id)}>提醒繳費</button>}
        {mayReject && <button className="link" disabled={saving} onClick={() => openOperation("rejectPaymentReport", invoice)}>核對未入帳</button>}
        {mayVoid && <button className="link danger" disabled={saving} onClick={() => openOperation("voidInvoice", invoice)}>作廢</button>}
        {mayReissue && <button className="link" disabled={saving} onClick={() => openOperation("reissueInvoice", invoice)}>{invoice.status === "VOID" ? "重新開單" : "作廢並重開"}</button>}
        {mayRefund && <button className="link danger" disabled={saving} onClick={() => openOperation("refundInvoice", invoice)}>退款／轉餘額</button>}
      </div>
    </details>;
  };
  const renderDetails = (invoice: ManagedInvoice) => <details><summary>帳單明細{invoice.event_ids?.length ? " · " + invoice.event_ids.length + " 場" : ""}</summary>
      <div className="billing-invoice-detail">
        <small>帳單編號：{invoice.id}</small>
        {invoice.type === "QUARTERLY_MEMBER" && <p>本季確認基準 {invoice.baseline_event_count ?? invoice.event_ids?.length} 場；原單金額 {money(invoice.original_gross_amount ?? invoice.gross_amount)}</p>}
        {invoiceEventLines(invoice).map(({ id, event, amount, adjustments }) => {
          const linked = invoices.filter((entry) => entry.related_invoice_id === invoice.id && referencesEvent(entry, id));
          return <div className="billing-event-line" key={id}>
            <div><strong>{schedule(event?.starts_at)}{event?.courts ? " · " + event.courts : ""}</strong>{amount !== undefined && amount >= 0 && <span>{money(amount)}</span>}</div>
            {event?.status === "CANCELLED" && <small>已取消{event.cancellation_reason ? " · " + event.cancellation_reason : ""}</small>}
            {adjustments.some((entry) => entry.kind === "REDUCTION") && <small>已減收 {money(adjustments.filter((entry) => entry.kind === "REDUCTION").reduce((sum, entry) => sum + Math.abs(entry.amount), 0))}</small>}
            {linked.filter((entry) => entry.status !== "VOID").map((entry) => <div className="billing-adjustment-money" key={entry.id}>
              {entry.status === "AWAITING_PAYMENT_CONFIRMATION" ? <small>原付款待核對</small> : <>
                {(entry.refund_wallet_amount ?? 0) > 0 && <small>已退回社內餘額 · {money(entry.refund_wallet_amount ?? 0)}</small>}
                {(entry.pending_refund_amount ?? 0) > 0 && <small>待退款 · {money(entry.pending_refund_amount ?? 0)}</small>}
                {(entry.refund_completed_amount ?? 0) > 0 && <small>已退款 · {money(entry.refund_completed_amount ?? 0)}</small>}
                {entry.refund_wallet_amount === undefined && <small>{entry.status === "CONFIRMED" ? "已退回社內餘額" : labels[entry.status] ?? "帳務調整"} · {money(Math.abs(entry.amount))}</small>}
              </>}
            </div>)}
            {event && props.openEvent && !props.focusEventId && <button type="button" className="link" onClick={() => props.openEvent?.(id)}>查看活動詳情</button>}
          </div>;
        })}
        {invoice.pending_refund_amount ? <p>待退實收款：{money(invoice.pending_refund_amount)}{invoice.original_receipt_method ? " · 原收款：" + receiptMethod(invoice.original_receipt_method) : " · 原收款方式未記錄"}</p> : null}
        {(invoice.refund_wallet_amount ?? 0) > 0 && <p>已退回社內餘額：{money(invoice.refund_wallet_amount ?? 0)}</p>}
        {invoice.refund_completed_date && <p>已退款：{invoice.refund_completed_date} · {receiptMethod(invoice.refund_method)} · {money(invoice.refund_completed_amount ?? Math.abs(invoice.amount))}{admin && invoice.refund_recorded_by_name ? " · 登記：" + invoice.refund_recorded_by_name : ""}</p>}
        {invoice.void_reason && <p>作廢原因：{invoice.void_reason}</p>}
        {invoice.replacement_of_id && <small>重開自：{invoice.replacement_of_id}</small>}{invoice.replaced_by_id && <small>新帳單：{invoice.replaced_by_id}</small>}
        {invoice.related_invoice_id && <small>關聯帳單：{invoice.related_invoice_id}</small>}
        {receiptMethod(invoice.receipt_method) && <p><strong>收款紀錄：{invoice.receipt_received_date} · {receiptMethod(invoice.receipt_method)} · {money(invoice.receipt_amount ?? invoice.amount)}</strong>{admin && invoice.receipt_recorded_by_name && <small>登記：{invoice.receipt_recorded_by_name} · {schedule(invoice.receipt_recorded_at)}</small>}{admin && invoice.receipt_note && <small>備註：{invoice.receipt_note}</small>}</p>}
        {(invoice.adjustments ?? []).map((entry, index) => <p key={index}>{entry.eventDate} {entry.reason} · {money(entry.amount)}<small>{entry.actorName} · {schedule(entry.createdAt)}</small></p>)}
      </div>
    </details>;
  const renderInvoice = (invoice: ManagedInvoice) => <article className="billing-invoice" key={invoice.id}>
    <div className="billing-invoice-title"><div><strong>{types[invoice.type] ?? "帳務調整"}{invoice.period_label && " · " + invoice.period_label}</strong>{admin && <small>{invoice.memberName}{invoice.memberAccountName ? " · 帳號：" + invoice.memberAccountName : ""}</small>}</div><span className={"billing-pill " + (overdue(invoice) ? "overdue" : invoice.status.toLowerCase())}>{overdue(invoice) ? "逾期待繳" : invoiceStatusLabel(invoice)}</span></div>
    <div className="billing-invoice-money"><strong>{money(invoice.type === "CREDIT" ? (invoice.pending_refund_amount || invoice.refund_completed_amount || Math.abs(invoice.amount)) : invoice.amount)}</strong>{invoice.credit_applied > 0 && <small>已抵扣餘額 {money(invoice.credit_applied)}</small>}{invoice.due_at && <small>期限：{taipeiDay(invoice.due_at)}</small>}</div>
    {renderDetails(invoice)}
    {(admin && manage && collectable(invoice)) ? <div className="billing-actions"><button className="secondary receipt-action" disabled={saving} onClick={() => openReceipt([invoice])}>登記收款</button>{renderMore(invoice)}</div> : renderMore(invoice)}
  </article>;
  const exportLedger = () => {
    const rows = [["顯示名稱", "帳號名稱", "項目", "季度", "活動日期", "原單金額", "應付", "狀態", "收款日期", "收款方式", "實收金額", "登記人", "收款備註", "作廢原因", "重開自", "新帳單", "調整紀錄"], ...ledger.map((invoice) => [invoice.memberName, invoice.memberAccountName ?? "", types[invoice.type] ?? invoice.type, invoice.period_label ?? "", invoice.event_schedules?.map((entry) => schedule(entry.starts_at)).join("；") ?? "", invoice.original_gross_amount ?? invoice.gross_amount, invoice.amount, invoiceStatusLabel(invoice), invoice.receipt_received_date ?? "", receiptMethod(invoice.receipt_method), invoice.receipt_amount ?? "", invoice.receipt_recorded_by_name ?? "", invoice.receipt_note ?? "", invoice.void_reason ?? "", invoice.replacement_of_id ?? "", invoice.replaced_by_id ?? "", invoice.adjustments?.map((entry) => entry.reason + " " + entry.amount + " " + entry.actorName + " " + entry.createdAt).join("；") ?? ""])];
    const escape = (value: unknown) => {
      const raw = String(value);
      const safe = typeof value === "string" && /^\s*[=+@-]/.test(raw) ? "'" + raw : raw;
      return '"' + safe.replaceAll('"', '""') + '"';
    };
    const url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map((row) => row.map(escape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "羽球帳單-" + today + ".csv"; anchor.click(); URL.revokeObjectURL(url);
  };
  if (props.focusEventId) {
    const eventId = props.focusEventId;
    const eventInvoices = invoices.filter((invoice) => referencesEvent(invoice, eventId));
    const entry = events.find((event) => event.id === eventId);
    const archived = eventInvoices.flatMap((invoice) => invoice.event_schedules ?? []).find((event) => event.id === eventId);
    return <div className="billing-workspace">
      <div className="billing-outstanding"><strong>本場帳單 · {schedule(entry?.startsAt ?? archived?.starts_at)}</strong><button type="button" className="link" onClick={props.clearFocusEvent}>查看所有帳務</button></div>
      {props.openEvent && (entry || archived) && <button type="button" className="link" onClick={() => props.openEvent?.(eventId)}>查看本場活動</button>}
      {feedback && <p className="billing-outstanding billing-receipt-feedback" role="status">{feedback}</p>}
      <section className="billing-personal-list">{eventInvoices.length ? eventInvoices.map(renderInvoice) : <p className="billing-empty">本場沒有帳單。</p>}</section>
      {receiptRows && <ReceiptDialog invoices={receiptRows} saving={saving} submit={recordReceipts} close={() => setReceiptRows(null)} />}
      {selection && <InvoiceOperationModal selection={selection} saving={saving} submit={submit} close={() => setSelection(null)} />}
    </div>;
  }
  return <div className="billing-workspace">
    <div className="billing-balance">
      <div><span>{admin ? "待收款總額" : "待結清金額"}</span><strong>{money(totalPending)}</strong></div>
      <div className="billing-balance-notes">
        {summary.reportedCount > 0 && <span>含已回報、待對帳 {summary.reportedCount} 筆 · {money(summary.reportedAmount)}</span>}
        {summary.overdueAmount > 0 && <span>含逾期未繳 {money(summary.overdueAmount)}</span>}
        {refundSum > 0 && <span>待退款 {money(refundSum)}</span>}
        {!admin && <span>我的帳戶餘額 {money(viewer.creditBalance)}</span>}
      </div>
    </div>
    {!!outside.length && <div className="billing-outstanding" role="status">其他期間仍有 {outside.length} 筆待結清（{money(outside.reduce((sum, invoice) => sum + invoice.amount, 0))}）<button className="link" onClick={() => { setPeriod("ALL"); setTab("people"); setQueueFilter("ALL"); setSearch(""); setSelectedIds([]); }}>查看全部</button></div>}
    <div className="manager-tabs" role="tablist" aria-label="費用查看方式">{([["people", admin ? "待收款" : "我的待繳"], ["refunds", admin ? "待退款" : "我的退款"], ["records", admin ? "帳務紀錄" : "繳費紀錄"]] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} onClick={() => { setTab(value); setSelectedIds([]); setRefundIds([]); }}>{label}</button>)}</div>
    {feedback && <p className="billing-outstanding billing-receipt-feedback" role="status">{feedback}</p>}
    <div className="billing-filters">
      <label>查看期間<select value={period} onChange={(event) => { setPeriod(event.target.value); setSelectedIds([]); setRefundIds([]); }}><option value="ALL">全部期間</option><option value="CURRENT">本季{currentPeriod ? " · " + currentPeriod.label : ""}</option>{periods.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}（{entry.start}～{entry.end}）</option>)}</select></label>
      <label>搜尋<input type="search" placeholder={admin ? "姓名、帳號或日期" : "日期或季度"} value={search} onChange={(event) => { setSearch(event.target.value); setSelectedIds([]); setRefundIds([]); }} /></label>
      {tab === "records" && <><button type="button" className="secondary" onClick={() => setTab("activities")}>按活動查看</button>{admin && <button className="secondary" onClick={props.openRates}>費率設定</button>}</>}
      {tab === "activities" && <button type="button" className="secondary" onClick={() => setTab("records")}>返回帳務紀錄</button>}
    </div>
    {tab === "people" && (admin ? <section className="billing-collection" aria-label="待收款清單">
      <div className="billing-queue-top">
        <div className="billing-queue-filter" role="group" aria-label="待收款篩選">
          <button type="button" aria-pressed={queueFilter === "ALL"} onClick={() => { setQueueFilter("ALL"); setSelectedIds([]); }}>全部待收</button>
          <button type="button" aria-pressed={queueFilter === "REPORTED"} onClick={() => { setQueueFilter("REPORTED"); setSelectedIds([]); }}>已回報{summary.reportedCount > 0 && ` ${summary.reportedCount}`}</button>
        </div>
        <span>{queue.length} 筆帳單</span>
      </div>
      {manage && selected.length > 0 && <div className="billing-batch-bar">
        <strong>已選 {selected.length} 筆 · {money(selected.reduce((sum, invoice) => sum + invoice.amount, 0))}</strong>
        <button className="link" disabled={saving} onClick={() => setSelectedIds([])}>清除</button>
        <button className="primary" disabled={saving} onClick={() => openReceipt(selected)}>登記這 {selected.length} 筆</button>
      </div>}
      {!queue.length ? <p className="billing-empty">目前沒有符合條件的待收款。</p> : <ul className="billing-queue" role="list">{queue.map((invoice) => <li className="billing-queue-row" key={invoice.id}>
        {manage && <label className="billing-receipt-check"><input type="checkbox" checked={selectedIds.includes(invoice.id)} disabled={saving || !collectable(invoice) || (!selectedIds.includes(invoice.id) && selectedIds.length >= receiptMax)} onChange={(event) => { const checked = event.target.checked; setSelectedIds((ids) => checked ? [...ids, invoice.id].slice(0, receiptMax) : ids.filter((id) => id !== invoice.id)); }} /><span className="billing-sr-only">選取 {invoice.memberName} · {types[invoice.type] ?? "帳單"} · {money(invoice.amount)}</span></label>}
        <div className="billing-queue-person"><strong>{invoice.memberName}</strong>{invoice.memberAccountName && <small>帳號：{invoice.memberAccountName}</small>}<span>{types[invoice.type] ?? "帳單"}{invoice.period_label && " · " + invoice.period_label}</span></div>
        <div className="billing-queue-amount"><strong>{money(invoice.amount)}</strong><span className={"billing-pill " + (overdue(invoice) ? "overdue" : invoice.status.toLowerCase())}>{overdue(invoice) ? "逾期待繳" : invoiceStatusLabel(invoice)}</span></div>
        <div className="billing-queue-actions">{manage && collectable(invoice) && <button className="primary receipt-action" disabled={saving} onClick={() => openReceipt([invoice])}>登記收款<span className="billing-sr-only">：{invoice.memberName}</span></button>}{renderMore(invoice)}</div>
        <div className="billing-queue-detail">{renderDetails(invoice)}</div>
      </li>)}</ul>}
      {selected.length >= receiptMax && <p className="form-note">每次最多登記 {receiptMax} 筆。不同日期或方式請分批。</p>}
    </section> : <section aria-label="我的待繳帳單" className="billing-personal-list">
      {queue.length ? queue.map(renderInvoice) : <p className="billing-empty">目前沒有待結清的帳單。</p>}
    </section>)}
    {tab === "refunds" && <section aria-label="待退款清單">
      {selectedRefunds.length > 0 && <div className="billing-batch-bar">
        <strong>已選 {selectedRefunds.length} 筆 · {money(selectedRefunds.reduce((sum, invoice) => sum + (invoice.pending_refund_amount ?? 0), 0))}</strong>
        <button type="button" className="link" onClick={() => setRefundIds([])}>清除</button>
        <button type="button" className="primary" disabled={saving} onClick={() => setRefundRows(selectedRefunds)}>登記這 {selectedRefunds.length} 筆</button>
      </div>}
      {!refunds.length && <p className="billing-empty">目前沒有待退款或待核對款項。</p>}
      <div className="billing-personal-list">{refunds.map((invoice) => {
        const canRecord = admin && manage && invoice.status === "AWAITING_OFFLINE_REFUND" && Boolean(invoice.event_id) && (invoice.pending_refund_amount ?? 0) > 0;
        const original = invoice.status === "AWAITING_PAYMENT_CONFIRMATION" ? invoices.find((entry) => entry.id === invoice.related_invoice_id) : null;
        return <div className="billing-refund-item" key={invoice.id}>{renderInvoice(invoice)}
          {canRecord && <div className="billing-actions">
            <label className="billing-checkbox"><input type="checkbox" checked={refundIds.includes(invoice.id)} disabled={saving || Boolean(refundEventId && refundEventId !== invoice.event_id) || (!refundIds.includes(invoice.id) && refundIds.length >= receiptMax)} onChange={(event) => { const checked = event.target.checked; setRefundIds((ids) => checked ? [...ids, invoice.id] : ids.filter((id) => id !== invoice.id)); }} />加入批次 · {invoice.memberName}</label>
            <button type="button" className="primary" disabled={saving} onClick={() => { setFeedback(""); setRefundRows([invoice]); }}>登記已退</button>
          </div>}
          {invoice.status === "AWAITING_PAYMENT_CONFIRMATION" && <p className="form-note">先核對原付款是否入帳，再結算退款。</p>}
          {original && admin && <details className="billing-queue-detail"><summary>核對原帳單</summary>{renderInvoice(original)}</details>}
        </div>;
      })}</div>
    </section>}
    {tab === "activities" && <section><p className="form-note">{admin ? "人數依付款人計算，含轉讓後仍負擔季度費者。季度費只標示結清狀態，不重複加總為各場欠款。" : "只顯示自己的活動費用，不會顯示他人的付款狀態。"}</p>{!activityList.length && <p className="billing-empty">此期間沒有活動</p>}{activityList.map((event) => {
      const scopedEvent = admin ? event : { ...event, bookings: event.bookings.filter((booking) => booking.memberId === viewer.id) };
      const progress = activityPayments(scopedEvent, invoices);
      if (!admin && !progress.rows.length) return null;
      return <details className="billing-person" key={event.id}><summary><strong>{schedule(event.startsAt)} · {event.courts}</strong><span className={"billing-pill " + (progress.complete ? "confirmed" : "pending")}>{progress.complete ? "全數結清" : !progress.rows.length ? "尚無報名" : "尚未結清"}</span>{admin && <small>已結清 {progress.settled} 人 · 未繳 {progress.unpaid} 人 · 待確認 {progress.reported} 人 · 未開單 {progress.unbilled} 人 · 免收／轉讓 {progress.exempt} 人</small>}</summary><div className="billing-detail-list">{progress.rows.map((row) => <div className="billing-activity-person" key={row.memberId}><strong>{row.name}{row.accountName && <small className="account-name">帳號：{row.accountName}</small>}</strong><span>{row.quarterly ? "季度費 · " : ""}{{ PENDING: "未繳", REPORTED: "待確認", SETTLED: "已結清", TRANSFER: "私人轉讓，社團免收", EXEMPT: "本場免收社員費", UNBILLED: "尚未開單" }[row.status]}</span>{row.bills.map(renderInvoice)}</div>)}</div></details>;
    })}</section>}
    {tab === "records" && <section><div className="billing-section-tools"><label>紀錄類型<select value={ledgerType} onChange={(event) => setLedgerType(event.target.value)}><option value="CHARGES">{admin ? "收費帳單" : "已結案帳單"}</option><option value="ADJUSTMENTS">退款與餘額紀錄</option><option value="ALL">全部紀錄</option></select></label><label className="billing-checkbox"><input type="checkbox" checked={showVoided} onChange={(event) => setShowVoided(event.target.checked)} />包含已作廢</label>{admin && <><button className="secondary" disabled={!ledger.length} onClick={exportLedger}>匯出紀錄</button>{manage && <details className="billing-more"><summary>更多操作</summary><div className="billing-more-actions"><button className="link danger" disabled={saving || !filtered.some((invoice) => isPrincipal(invoice) && invoice.status === "PENDING")} onClick={() => setSelection({ operation: "voidInvoiceBatch", invoices: filtered.filter((invoice) => isPrincipal(invoice) && invoice.status === "PENDING").slice(0, 100), excluded: filtered.filter((invoice) => isPrincipal(invoice) && invoice.status !== "PENDING" && invoice.status !== "VOID").length })}>批次作廢未繳帳單</button></div></details>}</>}</div><div className="billing-personal-list">{ledger.length ? ledger.map(renderInvoice) : <p className="billing-empty">沒有符合條件的紀錄</p>}</div></section>}
    {receiptRows && <ReceiptDialog invoices={receiptRows} saving={saving} submit={recordReceipts} close={() => setReceiptRows(null)} />}
    {refundRows && <OfflineRefundDialog invoices={refundRows} saving={saving} submit={recordRefunds} close={() => setRefundRows(null)} />}
    {selection && <InvoiceOperationModal selection={selection} saving={saving} submit={submit} close={() => setSelection(null)} />}
  </div>;
}

function OfflineRefundDialog({ invoices, saving, submit, close }: { invoices: ManagedInvoice[]; saving: boolean; submit: (input: Record<string, string>) => Promise<void>; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const today = taipeiDay(new Date());
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  return <dialog ref={dialog} className="modal billing-receipt-modal" aria-labelledby="billing-refund-title" onCancel={(event) => { event.preventDefault(); if (!saving) close(); }}>
    <button type="button" className="close" disabled={saving} aria-label="關閉登記退款" onClick={close}>×</button>
    <h2 id="billing-refund-title">登記已退款</h2>
    <p className="form-note">{invoices.length} 筆 · {money(invoices.reduce((sum, invoice) => sum + (invoice.pending_refund_amount ?? 0), 0))}。只登記已在系統外退回的款項，不會發起轉帳。</p>
    <form className="manager-form" onSubmit={(event) => {
      event.preventDefault();
      if (saving) return;
      const data = new FormData(event.currentTarget);
      void submit({ method: String(data.get("method") ?? ""), refundedDate: String(data.get("refundedDate") ?? ""), note: String(data.get("note") ?? "") });
    }}>
      <label>實際退款方式<select required name="method" defaultValue={invoices.length === 1 ? invoices[0].original_receipt_method ?? "" : ""}><option value="" disabled>選擇方式</option><option value="CASH">現金</option><option value="BANK">轉帳</option></select></label>
      <label>退款日期<input required type="date" name="refundedDate" defaultValue={today} max={today} /></label>
      <label>備註（選填）<input name="note" maxLength={200} /></label>
      <label className="billing-checkbox"><input type="checkbox" required />我已在系統外完成這些退款</label>
      <button className="primary" disabled={saving}>{saving ? "登記中…" : "確認登記已退款"}</button>
    </form>
  </dialog>;
}

function ReceiptDialog({ invoices, saving, submit, close }: { invoices: ManagedInvoice[]; saving: boolean; submit: (input: Record<string, string>) => Promise<void>; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [method, setMethod] = useState<"CASH" | "BANK" | "">("");
  const today = taipeiDay(new Date());
  const total = invoices.reduce((sum, invoice) => sum + invoice.amount, 0);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  const record = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!method || saving) return;
    const data = new FormData(event.currentTarget);
    await submit({ method, receivedDate: String(data.get("receivedDate") ?? ""), note: String(data.get("note") ?? "") });
  };
  return <dialog ref={dialog} className="modal billing-receipt-modal" aria-labelledby="billing-receipt-title" onCancel={(event) => { event.preventDefault(); if (!saving) close(); }}>
    <button type="button" className="close" disabled={saving} aria-label="關閉登記收款" onClick={close}>×</button>
    <h2 id="billing-receipt-title">{invoices.length === 1 ? "登記收款" : "批次登記收款"}</h2>
    <p className="billing-receipt-lead">只登記你已實際收到的全額款項，不會發起轉帳。若金額不足，先勿登記為結清。</p>
    <div className="billing-receipt-total"><span>實收合計 · {invoices.length} 筆</span><strong>{money(total)}</strong></div>
    <ul className="billing-receipt-list" role="list">{invoices.map((invoice) => <li key={invoice.id}><span><strong>{invoice.memberName}</strong><small>{types[invoice.type] ?? "帳單"}{invoice.memberAccountName ? " · " + invoice.memberAccountName : ""}</small></span><strong>{money(invoice.amount)}</strong></li>)}</ul>
    <form className="manager-form billing-receipt-form" onSubmit={(event) => void record(event)}>
      <fieldset disabled={saving}>
        <legend>收款方式</legend>
        <div className="billing-receipt-method">
          {([["CASH", "現金"], ["BANK", "轉帳"]] as const).map(([value, label]) => <label key={value}><input type="radio" name="receiptMethod" value={value} checked={method === value} required onChange={() => setMethod(value)} />{label}</label>)}
        </div>
        <label>收款日期<input name="receivedDate" type="date" defaultValue={today} max={today} required /></label>
        <label>備註（選填）<input name="note" type="text" maxLength={200} placeholder="例如：球場現場收款" /></label>
      </fieldset>
      {invoices.length > 1 && <p className="form-note">這批帳單使用同一收款方式和日期。不同方式或日期請分開登記。</p>}
      <button type="submit" className="primary" disabled={!method || saving}>{saving ? "登記中…" : "確認登記 · " + money(total)}</button>
    </form>
  </dialog>;
}

function InvoiceOperationModal({ selection, saving, submit, close }: { selection: Selection; saving: boolean; submit: (input: Record<string, string>) => Promise<void>; close: () => void }) {
  const invoice = "invoice" in selection ? selection.invoice : null;
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState("BALANCE");
  const [acknowledged, setAcknowledged] = useState(false);
  const [amounts, setAmounts] = useState<number[]>(invoice?.event_amounts?.length ? invoice.event_amounts : [invoice?.gross_amount ?? 0]);
  const [due, setDue] = useState(() => taipeiDay(new Date(Date.now() + 14 * 86400000)));
  useEffect(() => {
    const previous = document.body.style.overflow; document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopImmediatePropagation(); if (!saving) close(); } };
    window.addEventListener("keydown", onKey, true);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", onKey, true); };
  }, [saving, close]);
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input: Record<string, string> = { reason };
    if (invoice) Object.assign(input, { invoiceId: invoice.id, expectedStatus: invoice.status, expectedAmount: String(invoice.amount), expectedRefundable: String(invoice.refundable_amount ?? 0), refundMode: mode, offlineRefunded: String(acknowledged), checkedNotReceived: String(acknowledged), eventAmounts: JSON.stringify(amounts), dueDate: due });
    else if ("invoices" in selection) input.invoices = JSON.stringify(selection.invoices.map((entry) => ({ id: entry.id, amount: entry.amount })));
    await submit(input);
  };
  return <div className="modal-cover" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) close(); }}><section className="modal manager-modal" role="dialog" aria-modal="true" aria-labelledby="invoice-operation-title"><button className="close" disabled={saving} aria-label="關閉帳單操作" onClick={close}>×</button><h2 id="invoice-operation-title">{operationLabels[selection.operation]}</h2><form className="manager-form" onSubmit={handleSubmit}><fieldset disabled={saving}>
    {invoice && <p>{invoice.memberName}{invoice.memberAccountName ? "（帳號：" + invoice.memberAccountName + "）" : ""} · {invoice.period_label}<br />目前應付 {money(invoice.amount)} · 已抵扣餘額 {money(invoice.credit_applied)}</p>}
    {"invoices" in selection && <><p>將作廢 {selection.invoices.length} 筆、{new Set(selection.invoices.map((entry) => entry.member_id)).size} 人，取消應收 {money(selection.invoices.reduce((sum, entry) => sum + entry.amount, 0))}，退回抵扣餘額 {money(selection.invoices.reduce((sum, entry) => sum + entry.credit_applied, 0))}。</p><p>另有 {selection.excluded} 筆非未繳帳單不會作廢，須個別核對或退款。</p><details><summary>查看本次影響名單</summary>{selection.invoices.map((entry) => <p key={entry.id}>{entry.memberName}{entry.memberAccountName ? "（帳號：" + entry.memberAccountName + "）" : ""} · {entry.period_label} · {money(entry.amount)}</p>)}</details></>}
    {selection.operation === "reissueInvoice" && <><p className="form-note">原單會保留並連結新單。請逐項確認重開金額；季度原始計畫不變。</p>{amounts.map((amount, index) => <label key={index}>{invoice?.event_schedules?.[index] ? schedule(invoice.event_schedules[index].starts_at) : "帳單項目"} 金額（元）<input type="number" min="0" max="1000000" step="1" required value={amount} disabled={invoice?.event_schedules?.[index]?.status === "CANCELLED"} onChange={(event) => setAmounts((current) => current.map((value, position) => position === index ? Number(event.target.value) : value))} /></label>)}<strong>重開原價合計 {money(amounts.reduce((sum, value) => sum + value, 0))}，再依目前餘額抵扣</strong><label>新繳費期限<input type="date" value={due} required min={taipeiDay(new Date())} onChange={(event) => setDue(event.target.value)} /></label></>}
    {selection.operation === "refundInvoice" && <><p>可退金額 {money(invoice?.refundable_amount ?? 0)}（已扣除先前退款）。</p><label>退款方式<select value={mode} onChange={(event) => { setMode(event.target.value); setAcknowledged(false); }}><option value="BALANCE">全部轉回帳戶餘額</option><option value="OFFLINE">登記已完成人工退款</option></select></label><p className="form-note">人工退款僅登記結果，不會發起轉帳；原先使用的餘額仍退回帳戶。</p>{mode === "OFFLINE" && <label className="billing-checkbox"><input type="checkbox" required checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />我已完成現金／轉帳退款；現金退款 {money(Math.min(invoice?.refundable_amount ?? 0, invoice?.amount ?? 0))}，其餘退回餘額。</label>}</>}
    {selection.operation === "rejectPaymentReport" && <label className="billing-checkbox"><input type="checkbox" required checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />已核對收款紀錄，確認尚未收到這筆轉帳。</label>}
    <label>原因<textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} required rows={3} /></label><p className="form-note">操作會保留原因、時間與操作者；活動及報名保持不變。</p><button className="primary" disabled={saving}>{saving ? "處理中…" : "確認" + operationLabels[selection.operation]}</button>
  </fieldset></form></section></div>;
}
