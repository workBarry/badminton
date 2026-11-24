"use client";
import { useEffect, useState, type FormEvent } from "react";
import { activityPayments, billingSummary, groupByPerson, invoiceInRange, isOpen, isPrincipal, taipeiDay, type BillingActivity, type ManagedInvoice } from "@/lib/billing-view";

type ActionResult = { results?: { id: string; success: boolean; error?: string }[]; status?: string; invoiceId?: string };
export type BillingProps = {
  admin: boolean; invoices: ManagedInvoice[]; viewer: { id: string; name?: string; creditBalance: number }; saving: boolean;
  events?: BillingActivity[];
  reportPayment: (id: string) => void; confirmPayment: (id: string) => void; remindPayment: (id: string) => void; openRates: () => void;
  manage?: (action: string, input: Record<string, string>) => Promise<ActionResult | null>;
};
const labels: Record<string, string> = { PENDING: "未繳", REPORTED: "待確認", CONFIRMED: "已結清", VOID: "已作廢", CREDITED: "已退回餘額", REFUNDED: "已退款", AWAITING_PAYMENT_CONFIRMATION: "待原款確認後退回" };
const types: Record<string, string> = { QUARTERLY_MEMBER: "季度社員費", MEMBERSHIP_PRORATED: "中途加入社員費", MEMBER_EXTRA: "社員加場費", SINGLE_EVENT: "非社員單次費", CREDIT: "退款／餘額紀錄" };
const money = (amount: number) => "NT$ " + amount.toLocaleString("zh-TW");
function schedule(value?: string | null) { return value ? new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "日期未設定"; }
type Operation = "voidInvoice" | "reissueInvoice" | "refundInvoice" | "rejectPaymentReport";
type Selection = { operation: Operation; invoice: ManagedInvoice } | { operation: "voidInvoiceBatch"; invoices: ManagedInvoice[]; excluded: number };
const operationLabels = { voidInvoice: "作廢帳單", reissueInvoice: "作廢並重開", refundInvoice: "辦理退款", rejectPaymentReport: "核對未入帳，退回待繳", voidInvoiceBatch: "批次作廢未繳帳單" };

export default function BillingDashboard(props: BillingProps) {
  const { admin, viewer, saving, events = [], manage } = props;
  const invoices = admin ? props.invoices : props.invoices.filter((invoice) => invoice.member_id === viewer.id);
  const [tab, setTab] = useState<"people" | "activities" | "records">("people");
  const [period, setPeriod] = useState("CURRENT");
  const [search, setSearch] = useState("");
  const [personFilter, setPersonFilter] = useState("OPEN");
  const [ledgerType, setLedgerType] = useState("CHARGES");
  const [showVoided, setShowVoided] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
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
  const people = groupByPerson(filtered).filter((person) => personFilter === "ALL" || (personFilter === "REPORTED" ? person.reportedCount > 0 : person.unpaidAmount > 0 || person.reportedCount > 0));
  const ledger = filtered.filter((invoice) => (showVoided || invoice.status !== "VOID") && (ledgerType === "ALL" || (ledgerType === "CHARGES" ? isPrincipal(invoice) : !isPrincipal(invoice))));
  const activityList = events.filter((event) => (!range || (taipeiDay(event.startsAt ?? "") >= range.start && taipeiDay(event.startsAt ?? "") <= range.end)) && (event.courts + " " + taipeiDay(event.startsAt ?? "") + " " + event.bookings.map((booking) => booking.name + " " + (booking.accountName ?? "")).join(" ")).toLowerCase().includes(search.toLowerCase().trim())).sort((a, b) => String(b.startsAt).localeCompare(String(a.startsAt)));
  const openOperation = (operation: Operation, invoice: ManagedInvoice) => { setSelection({ operation, invoice }); setFeedback(""); };
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
  const renderInvoice = (invoice: ManagedInvoice) => <article className="billing-invoice" key={invoice.id}>
    <div className="billing-invoice-title"><div><strong>{types[invoice.type] ?? "帳務調整"} · {invoice.period_label ?? ""}</strong><small>{invoice.memberName}{invoice.memberAccountName ? " · 帳號：" + invoice.memberAccountName : ""}</small></div><span className={"billing-pill " + invoice.status.toLowerCase()}>{labels[invoice.status] ?? invoice.status}</span></div>
    <div className="billing-invoice-money"><strong>{money(invoice.amount)}</strong>{invoice.credit_applied > 0 && <small>已抵扣餘額 {money(invoice.credit_applied)}</small>}{invoice.due_at && <small>期限：{taipeiDay(invoice.due_at)}</small>}</div>
    <details><summary>帳單明細{invoice.event_ids?.length ? " · " + invoice.event_ids.length + " 場" : ""}</summary>
      <div className="billing-invoice-detail">
        <small>帳單編號：{invoice.id}</small>
        {invoice.type === "QUARTERLY_MEMBER" && <p>本季確認基準 {invoice.baseline_event_count ?? invoice.event_ids?.length} 場；原單金額 {money(invoice.original_gross_amount ?? invoice.gross_amount)}</p>}
        {(invoice.event_schedules ?? []).map((event) => <span key={event.id}>{schedule(event.starts_at)} · {event.courts}{event.status === "CANCELLED" ? "（活動已取消）" : ""}</span>)}
        {invoice.void_reason && <p>作廢原因：{invoice.void_reason}</p>}
        {invoice.replacement_of_id && <small>重開自：{invoice.replacement_of_id}</small>}{invoice.replaced_by_id && <small>新帳單：{invoice.replaced_by_id}</small>}
        {invoice.related_invoice_id && <small>關聯帳單：{invoice.related_invoice_id}</small>}
        {(invoice.adjustments ?? []).map((entry, index) => <p key={index}>{entry.eventDate} {entry.reason} · {money(entry.amount)}<small>{entry.actorName} · {schedule(entry.createdAt)}</small></p>)}
      </div>
    </details>
    <div className="billing-actions">
      {invoice.status === "PENDING" && invoice.member_id === viewer.id && <button className="link" disabled={saving} onClick={() => props.reportPayment(invoice.id)}>我已轉帳</button>}
      {admin && invoice.status === "PENDING" && invoice.member_id !== viewer.id && <button className="link" disabled={saving} onClick={() => props.remindPayment(invoice.id)}>催款</button>}
      {admin && invoice.status === "REPORTED" && <><button className="link" disabled={saving} onClick={() => props.confirmPayment(invoice.id)}>確認收款</button>{manage && <button className="link" disabled={saving} onClick={() => openOperation("rejectPaymentReport", invoice)}>核對未入帳</button>}</>}
      {admin && manage && isPrincipal(invoice) && invoice.status === "PENDING" && <button className="link danger" disabled={saving} onClick={() => openOperation("voidInvoice", invoice)}>作廢</button>}
      {admin && manage && isPrincipal(invoice) && !invoice.replaced_by_id && (invoice.status === "PENDING" || (invoice.status === "VOID" && invoice.cancellation_reason === "ADMIN_VOID")) && <button className="link" disabled={saving} onClick={() => openOperation("reissueInvoice", invoice)}>{invoice.status === "VOID" ? "重新開單" : "作廢並重開"}</button>}
      {admin && manage && isPrincipal(invoice) && invoice.status === "CONFIRMED" && (invoice.refundable_amount ?? 0) > 0 && <button className="link danger" disabled={saving} onClick={() => openOperation("refundInvoice", invoice)}>退款／轉餘額</button>}
    </div>
  </article>;
  const exportLedger = () => {
    const rows = [["顯示名稱", "帳號名稱", "項目", "季度", "活動日期", "原單金額", "應付", "狀態", "作廢原因", "重開自", "新帳單", "調整紀錄"], ...ledger.map((invoice) => [invoice.memberName, invoice.memberAccountName ?? "", types[invoice.type] ?? invoice.type, invoice.period_label ?? "", invoice.event_schedules?.map((entry) => schedule(entry.starts_at)).join("；") ?? "", invoice.original_gross_amount ?? invoice.gross_amount, invoice.amount, labels[invoice.status] ?? invoice.status, invoice.void_reason ?? "", invoice.replacement_of_id ?? "", invoice.replaced_by_id ?? "", invoice.adjustments?.map((entry) => entry.reason + " " + entry.amount + " " + entry.actorName + " " + entry.createdAt).join("；") ?? ""])];
    const escape = (value: unknown) => '"' + String(value).replaceAll('"', '""') + '"';
    const url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map((row) => row.map(escape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "羽球帳單-" + today + ".csv"; anchor.click(); URL.revokeObjectURL(url);
  };
  return <div className="billing-workspace">
    <div className="billing-filters"><label>查看期間<select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="CURRENT">本季{currentPeriod ? " · " + currentPeriod.label : ""}</option><option value="ALL">全部期間</option>{periods.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}（{entry.start}～{entry.end}）</option>)}</select></label><label>搜尋<input placeholder="顯示名稱、帳號、日期或季度" value={search} onChange={(event) => setSearch(event.target.value)} /></label>{admin && <button className="secondary" onClick={props.openRates}>費率設定</button>}</div>
    <div className="billing-metrics"><div><span>未繳人數</span><strong>{summary.unpaidPeople} 人</strong></div><div><span>未繳金額</span><strong>{money(summary.unpaidAmount)}</strong></div><div><span>待確認 {summary.reportedCount} 筆</span><strong>{money(summary.reportedAmount)}</strong></div><div><span>逾期未繳</span><strong>{money(summary.overdueAmount)}</strong></div></div>
    {!!outside.length && <div className="billing-outstanding" role="status">其他期間仍有 {outside.length} 筆未清款項（{money(outside.reduce((sum, invoice) => sum + invoice.amount, 0))}）<button className="link" onClick={() => { setPeriod("ALL"); setTab("people"); setPersonFilter("OPEN"); setSearch(""); }}>查看全部未清</button></div>}
    {!admin && <p>我的帳戶餘額：{money(viewer.creditBalance)}</p>}
    <div className="manager-tabs" role="tablist" aria-label="費用查看方式">{([["people", admin ? "按人查看" : "我的費用"], ["activities", "按活動查看"], ["records", "帳單紀錄"]] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{label}</button>)}</div>
    {feedback && <p className="billing-outstanding" role="status">{feedback}</p>}
    {tab === "people" && <section><div className="billing-section-tools"><h3>{admin ? "依付款人追蹤" : "我的帳單"}</h3><label>顯示<select value={personFilter} onChange={(event) => setPersonFilter(event.target.value)}><option value="OPEN">未繳與待確認</option><option value="REPORTED">待確認</option><option value="ALL">全部收費狀態</option></select></label></div>{!people.length ? <p className="billing-empty">目前條件沒有待處理帳單</p> : people.map((person) => <details className="billing-person" key={person.id}><summary><strong>{person.name}{person.accountName && <small className="account-name">帳號：{person.accountName}</small>}</strong><span>未繳 {money(person.unpaidAmount)} · 待確認 {money(person.reportedAmount)}</span><small>{person.invoices.length} 筆{person.overdueAmount ? " · 逾期 " + money(person.overdueAmount) : ""}</small></summary><div className="billing-detail-list">{person.invoices.map(renderInvoice)}</div></details>)}</section>}
    {tab === "activities" && <section><p className="form-note">{admin ? "人數依付款人計算，含轉讓後仍負擔季度費者。季度費只標示結清狀態，不重複加總為各場欠款。" : "只顯示自己的活動費用，不會顯示他人的付款狀態。"}</p>{!activityList.length && <p className="billing-empty">此期間沒有活動</p>}{activityList.map((event) => {
      const scopedEvent = admin ? event : { ...event, bookings: event.bookings.filter((booking) => booking.memberId === viewer.id) };
      const progress = activityPayments(scopedEvent, invoices);
      if (!admin && !progress.rows.length) return null;
      return <details className="billing-person" key={event.id}><summary><strong>{schedule(event.startsAt)} · {event.courts}</strong><span className={"billing-pill " + (progress.complete ? "confirmed" : "pending")}>{progress.complete ? "全數結清" : !progress.rows.length ? "尚無報名" : "尚未結清"}</span><small>已結清 {progress.settled} 人 · 未繳 {progress.unpaid} 人 · 待確認 {progress.reported} 人 · 未開單 {progress.unbilled} 人 · 免收／轉讓 {progress.exempt} 人</small></summary><div className="billing-detail-list">{progress.rows.map((row) => <div className="billing-activity-person" key={row.memberId}><strong>{row.name}{row.accountName && <small className="account-name">帳號：{row.accountName}</small>}</strong><span>{row.quarterly ? "季度費 · " : ""}{{ PENDING: "未繳", REPORTED: "待確認", SETTLED: "已結清", TRANSFER: "私人轉讓，社團免收", EXEMPT: "本場免收社員費", UNBILLED: "尚未開單" }[row.status]}</span>{row.bills.map(renderInvoice)}</div>)}</div></details>;
    })}</section>}
    {tab === "records" && <section><div className="billing-section-tools"><label>紀錄類型<select value={ledgerType} onChange={(event) => setLedgerType(event.target.value)}><option value="CHARGES">收費帳單</option><option value="ADJUSTMENTS">退款與餘額紀錄</option><option value="ALL">全部紀錄</option></select></label><label className="billing-checkbox"><input type="checkbox" checked={showVoided} onChange={(event) => setShowVoided(event.target.checked)} />包含已作廢</label>{admin && <><button className="secondary" disabled={!ledger.length} onClick={exportLedger}>匯出目前清單</button>{manage && <button className="secondary" disabled={saving || !filtered.some((invoice) => isPrincipal(invoice) && invoice.status === "PENDING")} onClick={() => setSelection({ operation: "voidInvoiceBatch", invoices: filtered.filter((invoice) => isPrincipal(invoice) && invoice.status === "PENDING").slice(0, 100), excluded: filtered.filter((invoice) => isPrincipal(invoice) && invoice.status !== "PENDING" && invoice.status !== "VOID").length })}>批次作廢未繳帳單</button>}</>}</div><p className="form-note">作廢及退款保留原單；不會取消活動或報名。批次操作每次最多 100 筆。</p><div className="billing-detail-list">{ledger.length ? ledger.map(renderInvoice) : <p className="billing-empty">沒有符合條件的紀錄</p>}</div></section>}
    {selection && <InvoiceOperationModal selection={selection} saving={saving} submit={submit} close={() => setSelection(null)} />}
  </div>;
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
