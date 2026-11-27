"use client";
import { useEffect, useId, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { billingSummary, groupInvoicesByMember, invoiceEventLines, invoiceInRange, isOpen, isPrincipal, referencesEvent, taipeiDay, type BillingActivity, type InvoiceSchedule, type ManagedInvoice } from "@/lib/billing-view";

type ActionResult = { results?: { id: string; success: boolean; error?: string }[]; status?: string; invoiceId?: string; recorded?: number; alreadyRecorded?: number; totalAmount?: number };
export type BillingProps = {
  admin: boolean; invoices: ManagedInvoice[]; viewer: { id: string; name?: string; creditBalance: number }; saving: boolean;
  events?: BillingActivity[];
  focusEventId?: string | null;
  focusInvoiceIds?: string[];
  focusInvoice?: { eventId?: string; invoiceId?: string } | null;
  clearFocusEvent?: () => void;
  openEvent?: (eventId: string) => void;
  reportPayment: (id: string) => void; remindPayment: (id: string) => void; openRates: () => void;
  manage?: (action: string, input: Record<string, string>) => Promise<ActionResult | null>;
};
const labels: Record<string, string> = { PENDING: "待繳", REPORTED: "待確認", CONFIRMED: "已結清", VOID: "已作廢", CREDITED: "已退回餘額", REFUNDED: "已退款", AWAITING_PAYMENT_CONFIRMATION: "原付款待核對", AWAITING_OFFLINE_REFUND: "待退款" };
const types: Record<string, string> = { QUARTERLY_MEMBER: "季度社員費", MEMBERSHIP_PRORATED: "中途加入社員費", MEMBER_EXTRA: "社員加場費", MEMBER_SINGLE: "社員單場費", SINGLE_EVENT: "零打活動費", CREDIT: "退款／餘額紀錄" };
const feeTypeLabel = (invoice: ManagedInvoice) => invoice.period_label === "單場活動費" && isPrincipal(invoice) ? "單場活動費" : types[invoice.type] ?? "帳單";
const feeTitle = (invoice: ManagedInvoice) => {
  const type = feeTypeLabel(invoice);
  return invoice.period_label && invoice.period_label !== type ? type + " · " + invoice.period_label : type;
};
const money = (amount: number) => "NT$ " + amount.toLocaleString("zh-TW");
const receiptMax = 20;
const voidBatchMax = 100;
const completedRecord = (invoice: ManagedInvoice) => ["CONFIRMED", "REFUNDED", "CREDITED", "VOID"].includes(invoice.status);
const collectable = (invoice: ManagedInvoice) => isOpen(invoice) && Number.isSafeInteger(invoice.amount) && invoice.amount > 0;
const overdue = (invoice: ManagedInvoice) => invoice.status === "PENDING" && invoice.due_at && Date.parse(invoice.due_at) < Date.now();
const invoiceStatusLabel = (invoice: ManagedInvoice) => invoice.refund_completed_date ? "已退款"
  : invoice.type === "CREDIT" && (invoice.refund_wallet_amount ?? 0) > 0 && invoice.status === "CONFIRMED" ? "已退回餘額"
  : labels[invoice.status] ?? invoice.status;
const receiptMethod = (method?: string | null) => method === "CASH" ? "現金" : method === "BANK" ? "轉帳" : "";
function schedule(value?: string | null) { return value ? new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "日期未設定"; }
function singleEventLabel(invoice: ManagedInvoice) {
  if (invoice.event_schedules?.length !== 1 || (invoice.event_ids?.length ?? 0) > 1) return "";
  const event = invoice.event_schedules[0];
  return [event.starts_at ? schedule(event.starts_at) : "", event.courts].filter(Boolean).join(" · ");
}
function scheduleDescription(event?: InvoiceSchedule) {
  if (!event) return "日期未設定";
  const { starts_at: start, ends_at: end, courts } = event;
  const until = end && (start && taipeiDay(start) === taipeiDay(end)
    ? new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(end))
    : schedule(end));
  return [start ? schedule(start) + (until ? " 至 " + until : "") : until ? "結束時間 " + until : "", courts].filter(Boolean).join(" · ") || "日期未設定";
}
type Operation = "voidInvoice" | "reissueInvoice" | "refundInvoice" | "rejectPaymentReport";
type Selection = { operation: Operation; invoice: ManagedInvoice } | { operation: "voidInvoiceBatch"; invoices: ManagedInvoice[] };
const operationLabels = { voidInvoice: "作廢帳單", reissueInvoice: "修改帳單", refundInvoice: "辦理退款", rejectPaymentReport: "核對未入帳，退回待繳", voidInvoiceBatch: "作廢未繳帳單" };

function BillingMore({ label = "更多", description, children }: { label?: string; description?: string; children: ReactNode }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const button = trigger.current, popup = menu.current;
      if (!button || !popup?.matches(":popover-open")) return;
      const rect = button.getBoundingClientRect();
      const width = document.documentElement.clientWidth;
      const height = document.documentElement.clientHeight;
      const gap = 6, edge = 10;
      if (rect.bottom < edge || rect.top > height - edge) { popup.hidePopover(); return; }
      const below = Math.max(0, height - rect.bottom - edge - gap);
      const above = Math.max(0, rect.top - edge - gap);
      const upward = below < popup.scrollHeight && above > below;
      popup.style.maxHeight = Math.max(1, upward ? above : below) + "px";
      popup.style.left = Math.max(edge, Math.min(rect.right - popup.offsetWidth, width - popup.offsetWidth - edge)) + "px";
      popup.style.top = Math.max(edge, upward ? rect.top - gap - popup.offsetHeight : rect.bottom + gap) + "px";
      popup.style.visibility = "visible";
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  return <div className="billing-more">
    <button ref={trigger} type="button" className="billing-more-trigger" popoverTarget={id} aria-expanded={open} aria-controls={id}>
      {label}{description && <span className="billing-sr-only">：{description}</span>}
    </button>
    <div ref={menu} id={id} popover="auto" className="billing-more-actions" role="group" aria-label={description ? description + "操作" : label}
      onToggle={(event) => {
        const shown = event.newState === "open";
        if (!shown) event.currentTarget.style.visibility = "";
        setOpen(shown);
      }}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button:not(:disabled)")) event.currentTarget.hidePopover();
      }}>
      {children}
    </div>
  </div>;
}

type InvoiceGroup = ReturnType<typeof groupInvoicesByMember>[number];
function PersonGroups({ groups, renderRow, total }: {
  groups: InvoiceGroup[];
  renderRow: (invoice: ManagedInvoice) => ReactNode;
  total?: (invoices: ManagedInvoice[]) => string | null;
}) {
  return <div className="billing-person-groups">
    {groups.map((group) => {
      const subtotal = total?.(group.invoices);
      return <details className="billing-person-group" key={group.id} open={groups.length === 1}>
        <summary>
          <span className="billing-person-identity"><strong>{group.name}</strong>{group.accountName && <small>{group.accountName}</small>}</span>
          <span className="billing-person-totals">{subtotal && <strong>{subtotal}</strong>}<small>{group.invoices.length} 筆</small></span>
        </summary>
        <div className="billing-person-bills">{group.invoices.map(renderRow)}</div>
      </details>;
    })}
  </div>;
}

function useBillingScrollBuffer(view: string, focused: boolean) {
  const workspace = useRef<HTMLDivElement>(null);
  const reserved = useRef(0);
  const frame = useRef(0);

  useEffect(() => {
    const node = workspace.current;
    reserved.current = 0;
    node?.style.removeProperty("--billing-scroll-buffer");

    const releaseWhenSafe = () => {
      if (!reserved.current || frame.current) return;
      const page = document.scrollingElement;
      if (!page || page.scrollHeight - page.clientHeight - reserved.current < page.scrollTop) return;
      reserved.current = 0;
      node?.style.removeProperty("--billing-scroll-buffer");
    };
    window.addEventListener("scroll", releaseWhenSafe, { passive: true });
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      window.removeEventListener("scroll", releaseWhenSafe);
    };
  }, [view, focused]);

  const beforeToggle = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const details = target?.closest("summary")?.parentElement;
    const queue = target?.closest('.billing-queue-filter button[aria-pressed="false"]')?.closest(".billing-collection");
    const toggle = details instanceof HTMLDetailsElement && !details.closest('dialog, [role="dialog"]') &&
      !target?.closest("button, a, input, select, textarea") ? details : null;
    const source = queue ?? toggle;
    const page = document.scrollingElement;
    const node = workspace.current;
    if (!source || !page || !node?.contains(source)) return;

    const scrollTop = page.scrollTop;
    const naturalEnd = page.scrollHeight - page.clientHeight - reserved.current;
    const mightShrink = Boolean(queue || toggle?.open);
    const height = Math.ceil(source.getBoundingClientRect().height);
    if (mightShrink && scrollTop > 0 && scrollTop > naturalEnd - height) {
      // Reserve room before a collapse or filter update so the browser cannot clamp the viewport.
      reserved.current = Math.max(reserved.current, Math.ceil(scrollTop - naturalEnd + height) + 1);
      node.style.setProperty("--billing-scroll-buffer", reserved.current + "px");
    }
    if (!reserved.current) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (!node.isConnected) return;
      const keepPosition = Boolean(queue || (mightShrink && toggle && !toggle.open));
      const position = keepPosition ? scrollTop : page.scrollTop;
      const endWithoutBuffer = page.scrollHeight - page.clientHeight - reserved.current;
      reserved.current = Math.max(0, Math.ceil(position - endWithoutBuffer));
      if (reserved.current) node.style.setProperty("--billing-scroll-buffer", reserved.current + "px");
      else node.style.removeProperty("--billing-scroll-buffer");
      if (keepPosition && page.scrollTop !== position) page.scrollTop = position;
    });
  };

  return { ref: workspace, onClickCapture: beforeToggle };
}

export default function BillingDashboard(props: BillingProps) {
  const { admin, viewer, saving, events = [], manage } = props;
  const invoices = admin ? props.invoices : props.invoices.filter((invoice) => invoice.member_id === viewer.id);
  const [tab, setTab] = useState<"people" | "activities" | "records" | "refunds">("people");
  const activeTab = tab === "activities" ? "records" : tab;
  const scrollBuffer = useBillingScrollBuffer(tab, Boolean(props.focusEventId || props.focusInvoiceIds?.length));
  const [refundIds, setRefundIds] = useState<string[]>([]);
  const [refundRows, setRefundRows] = useState<ManagedInvoice[] | null>(null);
  const [period, setPeriod] = useState("ALL");
  const [search, setSearch] = useState("");
  const [queueFilter, setQueueFilter] = useState<"PENDING" | "REPORTED">("PENDING");
  const [ledgerType, setLedgerType] = useState("CHARGES");
  const [showVoided, setShowVoided] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [voidPickerOpen, setVoidPickerOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [receiptRows, setReceiptRows] = useState<ManagedInvoice[] | null>(null);
  const [feedback, setFeedback] = useState("");
  const activeInvoice = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!props.focusInvoice?.invoiceId) return;
    const frame = requestAnimationFrame(() => {
      activeInvoice.current?.focus({ preventScroll: true });
      activeInvoice.current?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [props.focusInvoice]);
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
  const queue = filtered.filter((invoice) => isOpen(invoice) && (!admin || invoice.status === queueFilter))
    .sort((a, b) => Number(b.status === "REPORTED") - Number(a.status === "REPORTED") || String(a.due_at ?? "9999").localeCompare(String(b.due_at ?? "9999")));
  const queueGroups = admin ? groupInvoicesByMember(queue) : [];
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
  const ledger = filtered.filter((invoice) => completedRecord(invoice) && (showVoided || invoice.status !== "VOID") && (ledgerType === "ALL" || (ledgerType === "CHARGES" ? isPrincipal(invoice) : !isPrincipal(invoice))));
  const voidCandidates = queue.filter((invoice) => invoice.status === "PENDING");
  const activityGroups = new Map<string | null, { id: string | null; startsAt?: string | null; courts?: string; rows: ManagedInvoice[] }>();
  const eventsById = new Map(events.map((event) => [event.id, event]));
  if (tab === "activities") {
    const invoicesById = new Map(invoices.map((invoice) => [invoice.id, invoice]));
    for (const invoice of ledger) {
      const direct = invoiceEventLines(invoice);
      const original = invoice.related_invoice_id ? invoicesById.get(invoice.related_invoice_id) : undefined;
      const lines = direct.length ? direct : original ? invoiceEventLines(original) : [];
      if (!lines.length) {
        const group = activityGroups.get(null) ?? { id: null, rows: [] };
        group.rows.push(invoice);
        activityGroups.set(null, group);
        continue;
      }
      for (const line of new Map(lines.map((line) => [line.id, line])).values()) {
        const current = eventsById.get(line.id);
        const group = activityGroups.get(line.id) ?? { id: line.id, rows: [] };
        group.startsAt ||= current?.startsAt || line.event?.starts_at || line.original?.starts_at;
        group.courts ||= current?.courts || line.event?.courts || line.original?.courts;
        group.rows.push(invoice);
        activityGroups.set(line.id, group);
      }
    }
  }
  const activityList = [...activityGroups.values()].sort((a, b) => Number(!a.id) - Number(!b.id) || (b.startsAt ?? "").localeCompare(a.startsAt ?? ""));
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
    setFeedback(result.recorded ? `已確認 ${result.recorded} 筆收款 · ${money(result.totalAmount ?? 0)}。${result.alreadyRecorded ? `另有 ${result.alreadyRecorded} 筆已登記，未重複處理。` : ""}` : "這些款項已登記，沒有重複入帳。");
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
  const renderMore = (invoice: ManagedInvoice, showCopy = false) => {
    const mayReport = invoice.status === "PENDING" && invoice.member_id === viewer.id && isPrincipal(invoice);
    const mayRemind = admin && invoice.status === "PENDING" && invoice.member_id !== viewer.id;
    const mayReject = admin && manage && isPrincipal(invoice) && invoice.status === "REPORTED";
    const mayVoid = admin && manage && isPrincipal(invoice) && invoice.status === "PENDING";
    const mayReissue = admin && manage && isPrincipal(invoice) && !invoice.replaced_by_id && (invoice.status === "PENDING" || (invoice.status === "VOID" && invoice.cancellation_reason === "ADMIN_VOID"));
    const mayRefund = admin && manage && isPrincipal(invoice) && !invoices.some((entry) => entry.related_invoice_id === invoice.id && ["AWAITING_OFFLINE_REFUND", "AWAITING_PAYMENT_CONFIRMATION"].includes(entry.status)) && invoice.status === "CONFIRMED" && (invoice.refundable_amount ?? 0) > 0;
    return (mayReport || mayRemind || mayReject || mayVoid || mayReissue || mayRefund || showCopy) && <BillingMore description={invoice.memberName + "的帳單"}>
        {mayReport && <button className="link" disabled={saving} onClick={() => props.reportPayment(invoice.id)}>回報已轉帳（選用）</button>}
        {mayRemind && <button className="link" disabled={saving} onClick={() => props.remindPayment(invoice.id)}>提醒繳費</button>}
        {mayReject && <button className="link" disabled={saving} onClick={() => openOperation("rejectPaymentReport", invoice)}>核對未入帳</button>}
        {mayVoid && <button className="link danger" disabled={saving} onClick={() => openOperation("voidInvoice", invoice)}>作廢</button>}
        {mayReissue && <button className="link" disabled={saving} onClick={() => openOperation("reissueInvoice", invoice)}>{invoice.status === "VOID" ? "重新開單" : operationLabels.reissueInvoice}</button>}
        {mayRefund && <button className="link danger" disabled={saving} onClick={() => openOperation("refundInvoice", invoice)}>退款／轉餘額</button>}
        {showCopy && <button type="button" className="link" onClick={async () => {
          try {
            await navigator.clipboard.writeText(invoice.id);
            setFeedback("已複製帳單編號。");
          } catch {
            setFeedback("無法自動複製。帳單編號：" + invoice.id);
          }
        }}>複製帳單編號</button>}
    </BillingMore>;
  };
  const detailLabel = (invoice: ManagedInvoice) => "帳單明細" + (invoice.event_ids?.length ? " · " + invoice.event_ids.length + " 場" : "");
  const renderDetailBody = (invoice: ManagedInvoice, historyOnly = false) =>
      <div className="billing-invoice-detail">
        <small>帳單編號：{invoice.id}</small>
        {invoice.type === "QUARTERLY_MEMBER" && <p>本季確認基準 {invoice.baseline_event_count ?? invoice.event_ids?.length} 場；原單金額 {money(invoice.original_gross_amount ?? invoice.gross_amount)}</p>}
        {invoiceEventLines(invoice).map(({ id, event, original, timeChanged, venueChanged, amount, adjustments }) => {
          const linked = invoices.filter((entry) => entry.related_invoice_id === invoice.id && referencesEvent(entry, id) && (!historyOnly || completedRecord(entry)));
          const showOriginal = original && (!event || timeChanged || venueChanged);
          return <div className="billing-event-line" key={id}>
            <div><strong>{showOriginal ? "原訂：" + scheduleDescription(original) : schedule(event?.starts_at) + (event?.courts ? " · " + event.courts : "")}</strong>{amount !== undefined && amount >= 0 && <span>{money(amount)}</span>}</div>
            {timeChanged && <small>改期至：{scheduleDescription(event)}</small>}
            {!timeChanged && venueChanged && <small>場地改為：{event?.courts}</small>}
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
        {!historyOnly && invoice.pending_refund_amount ? <p>待退實收款：{money(invoice.pending_refund_amount)}{invoice.original_receipt_method ? " · 原收款：" + receiptMethod(invoice.original_receipt_method) : " · 原收款方式未記錄"}</p> : null}
        {(invoice.refund_wallet_amount ?? 0) > 0 && <p>已退回社內餘額：{money(invoice.refund_wallet_amount ?? 0)}</p>}
        {invoice.refund_completed_date && <p>已退款：{invoice.refund_completed_date} · {receiptMethod(invoice.refund_method)} · {money(invoice.refund_completed_amount ?? Math.abs(invoice.amount))}{admin && invoice.refund_recorded_by_name ? " · 登記：" + invoice.refund_recorded_by_name : ""}</p>}
        {invoice.void_reason && <p>作廢原因：{invoice.void_reason}</p>}
        {invoice.replacement_of_id && <small>重開自：{invoice.replacement_of_id}</small>}{invoice.replaced_by_id && <small>新帳單：{invoice.replaced_by_id}</small>}
        {invoice.related_invoice_id && <small>關聯帳單：{invoice.related_invoice_id}</small>}
        {receiptMethod(invoice.receipt_method) && <p><strong>收款紀錄：{invoice.receipt_received_date} · {receiptMethod(invoice.receipt_method)} · {money(invoice.receipt_amount ?? invoice.amount)}</strong>{admin && invoice.receipt_recorded_by_name && <small>登記：{invoice.receipt_recorded_by_name} · {schedule(invoice.receipt_recorded_at)}</small>}{admin && invoice.receipt_note && <small>備註：{invoice.receipt_note}</small>}</p>}
        {(invoice.adjustments ?? []).map((entry, index) => <p key={index}>{entry.eventDate} {entry.reason} · {money(entry.amount)}<small>{entry.actorName} · {schedule(entry.createdAt)}</small></p>)}
      </div>;
  const renderDetails = (invoice: ManagedInvoice, historyOnly = false) =>
    <details><summary>{detailLabel(invoice)}</summary>{renderDetailBody(invoice, historyOnly)}</details>;
  const renderInvoice = (invoice: ManagedInvoice, grouped = false, historyOnly = false) => {
    const focused = props.focusInvoice?.invoiceId === invoice.id;
    const activity = grouped ? singleEventLabel(invoice) : "";
    return <article className={focused ? "billing-invoice billing-invoice-target" : "billing-invoice"} key={invoice.id}
      ref={focused ? activeInvoice : undefined} tabIndex={focused ? -1 : undefined}
      aria-label={focused ? "定位帳單：" + invoice.memberName : undefined}>
    <div className="billing-invoice-title"><div><strong>{feeTitle(invoice)}</strong>{activity && <small>{activity}</small>}{admin && !grouped && <small>{invoice.memberName}{invoice.memberAccountName ? " · 帳號：" + invoice.memberAccountName : ""}</small>}</div><span className={"billing-pill " + (overdue(invoice) ? "overdue" : invoice.status.toLowerCase())}>{overdue(invoice) ? "逾期待繳" : invoiceStatusLabel(invoice)}</span></div>
    <div className="billing-invoice-money"><strong>{money(invoice.type === "CREDIT" ? (invoice.pending_refund_amount || invoice.refund_completed_amount || Math.abs(invoice.amount)) : invoice.amount)}</strong>{historyOnly && tab === "activities" && invoiceEventLines(invoice).length > 1 && <small>整張帳單金額</small>}{invoice.credit_applied > 0 && <small>已抵扣餘額 {money(invoice.credit_applied)}</small>}{invoice.due_at && <small>期限：{taipeiDay(invoice.due_at)}</small>}</div>
    {renderDetails(invoice, historyOnly)}
    {(admin && manage && collectable(invoice)) ? <div className="billing-actions"><button className="secondary receipt-action" disabled={saving} onClick={() => openReceipt([invoice])}>確認收款</button>{renderMore(invoice)}</div> : renderMore(invoice)}
  </article>;
  };
  const renderQueueRow = (invoice: ManagedInvoice) => {
    const activity = singleEventLabel(invoice);
    const links = [...new Map(invoiceEventLines(invoice).map((line) => [line.id, line])).values()].flatMap((line) => {
      const live = eventsById.get(line.id);
      if (!live && !line.event) return [];
      const starts = live?.startsAt ?? line.event?.starts_at;
      const courts = live?.courts || line.event?.courts;
      return [{ id: line.id, label: [starts ? schedule(starts) : "", courts].filter(Boolean).join(" · ") || "活動詳情" }];
    });
    return <div className={"billing-queue-row" + (manage ? "" : " no-selection")} key={invoice.id}>
    {manage && <label className="billing-receipt-check"><input type="checkbox" checked={selectedIds.includes(invoice.id)} disabled={saving || !collectable(invoice) || (!selectedIds.includes(invoice.id) && selectedIds.length >= receiptMax)} onChange={(event) => { const checked = event.target.checked; setSelectedIds((ids) => checked ? [...ids, invoice.id].slice(0, receiptMax) : ids.filter((id) => id !== invoice.id)); }} /><span className="billing-sr-only">選取 {invoice.memberName} · {feeTypeLabel(invoice)} · {money(invoice.amount)}{activity && " · " + activity}</span></label>}
    <div className="billing-queue-item">
      <div className="billing-queue-title"><strong>{feeTitle(invoice)}</strong><span className={"billing-pill " + (overdue(invoice) ? "overdue" : invoice.status.toLowerCase())}>{overdue(invoice) ? "逾期待繳" : invoiceStatusLabel(invoice)}</span></div>
      {activity && <small>{activity}</small>}
      <QueueActivityLink activities={links} openEvent={props.openEvent} />
    </div>
    <div className="billing-queue-amount"><strong>{money(invoice.amount)}</strong>{renderMore(invoice, true)}</div>
  </div>;
  };
  const exportLedger = () => {
    const rows = [["顯示名稱", "帳號名稱", "項目", "季度", "活動日期", "原單金額", "應付", "狀態", "收款日期", "收款方式", "實收金額", "登記人", "收款備註", "作廢原因", "重開自", "新帳單", "調整紀錄"], ...ledger.map((invoice) => [invoice.memberName, invoice.memberAccountName ?? "", feeTypeLabel(invoice), invoice.period_label ?? "", invoice.event_schedules?.map((entry) => schedule(entry.starts_at)).join("；") ?? "", invoice.original_gross_amount ?? invoice.gross_amount, invoice.amount, invoiceStatusLabel(invoice), invoice.receipt_received_date ?? "", receiptMethod(invoice.receipt_method), invoice.receipt_amount ?? "", invoice.receipt_recorded_by_name ?? "", invoice.receipt_note ?? "", invoice.void_reason ?? "", invoice.replacement_of_id ?? "", invoice.replaced_by_id ?? "", invoice.adjustments?.map((entry) => entry.reason + " " + entry.amount + " " + entry.actorName + " " + entry.createdAt).join("；") ?? ""])];
    const escape = (value: unknown) => {
      const raw = String(value);
      const safe = typeof value === "string" && /^\s*[=+@-]/.test(raw) ? "'" + raw : raw;
      return '"' + safe.replaceAll('"', '""') + '"';
    };
    const url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map((row) => row.map(escape).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "羽球帳單-" + today + ".csv"; anchor.click(); URL.revokeObjectURL(url);
  };
  const canRecordRefund = (invoice: ManagedInvoice) => admin && Boolean(manage) && invoice.status === "AWAITING_OFFLINE_REFUND" && Boolean(invoice.event_id) && (invoice.pending_refund_amount ?? 0) > 0;
  const renderFocusedInvoice = (invoice: ManagedInvoice) => <div key={invoice.id}>
    {renderInvoice(invoice)}
    {canRecordRefund(invoice) && <div className="billing-actions"><button type="button" className="primary" disabled={saving} onClick={() => { setFeedback(""); setRefundRows([invoice]); }}>確認退款</button></div>}
    {admin && invoice.status === "AWAITING_PAYMENT_CONFIRMATION" && <p className="form-note">先核對原付款是否入帳，再結算退款。</p>}
  </div>;
  const renderRefundRow = (invoice: ManagedInvoice, grouped = false) => {
    const canRecord = canRecordRefund(invoice);
    const original = invoice.status === "AWAITING_PAYMENT_CONFIRMATION" ? invoices.find((entry) => entry.id === invoice.related_invoice_id) : null;
    return <div className="billing-refund-item" key={invoice.id}>{renderInvoice(invoice, grouped)}
      {canRecord && <div className="billing-actions">
        <label className="billing-checkbox"><input type="checkbox" checked={refundIds.includes(invoice.id)} disabled={saving || Boolean(refundEventId && refundEventId !== invoice.event_id) || (!refundIds.includes(invoice.id) && refundIds.length >= receiptMax)} onChange={(event) => { const checked = event.target.checked; setRefundIds((ids) => checked ? [...ids, invoice.id] : ids.filter((id) => id !== invoice.id)); }} />加入批次<span className="billing-sr-only">：{invoice.memberName}</span></label>
        <button type="button" className="primary" disabled={saving} onClick={() => { setFeedback(""); setRefundRows([invoice]); }}>確認退款</button>
      </div>}
      {invoice.status === "AWAITING_PAYMENT_CONFIRMATION" && <p className="form-note">先核對原付款是否入帳，再結算退款。</p>}
      {original && admin && <details className="billing-queue-detail"><summary>核對原帳單</summary>{renderInvoice(original)}</details>}
    </div>;
  };
  if (props.focusEventId || props.focusInvoiceIds?.length) {
    const eventId = props.focusEventId;
    const eventInvoices = invoices.filter((invoice) => eventId ? referencesEvent(invoice, eventId) : props.focusInvoiceIds?.includes(invoice.id));
    const entry = events.find((event) => event.id === eventId);
    const archived = eventInvoices.flatMap((invoice) => invoice.event_schedules ?? []).find((event) => event.id === eventId);
    return <div className="billing-workspace" {...scrollBuffer}>
      <div className="billing-outstanding"><strong>{eventId ? "本場帳單 · " + schedule(entry?.startsAt ?? archived?.starts_at) : props.focusInvoice?.invoiceId ? "指定帳單" : "本批帳單"}</strong><button type="button" className="link" onClick={props.clearFocusEvent}>查看所有帳務</button></div>
      {eventId && props.openEvent && (entry || archived) && <button type="button" className="link" onClick={() => props.openEvent?.(eventId)}>查看本場活動</button>}
      {feedback && <p className="billing-outstanding billing-receipt-feedback" role="status">{feedback}</p>}
      <section className="billing-personal-list">{eventInvoices.length ? eventInvoices.map(renderFocusedInvoice) : <p className="billing-empty">沒有符合條件的帳單。</p>}</section>
      {refundRows && <OfflineRefundDialog invoices={refundRows} saving={saving} submit={recordRefunds} close={() => setRefundRows(null)} />}
      {receiptRows && <ReceiptDialog invoices={receiptRows} saving={saving} submit={recordReceipts} close={() => setReceiptRows(null)} />}
      {selection && <InvoiceOperationModal selection={selection} saving={saving} submit={submit} close={() => setSelection(null)} />}
    </div>;
  }
  return <div className="billing-workspace" {...scrollBuffer}>
    <div className="billing-balance">
      <div><span>{admin ? "待收款總額" : "待結清金額"}</span><strong>{money(totalPending)}</strong></div>
      <div className="billing-balance-notes">
        {summary.reportedCount > 0 && <span>含待確認 {summary.reportedCount} 筆 · {money(summary.reportedAmount)}</span>}
        {summary.overdueAmount > 0 && <span>含逾期未繳 {money(summary.overdueAmount)}</span>}
        {refundSum > 0 && <span>待退款 {money(refundSum)}</span>}
        {!admin && <span>我的帳戶餘額 {money(viewer.creditBalance)}</span>}
      </div>
    </div>
    {!!outside.length && <div className="billing-outstanding" role="status">其他期間仍有 {outside.length} 筆待結清（{money(outside.reduce((sum, invoice) => sum + invoice.amount, 0))}）<button className="link" onClick={() => { setPeriod("ALL"); setTab("people"); setQueueFilter("PENDING"); setSearch(""); setSelectedIds([]); }}>查看全部</button></div>}
    <div className="manager-tabs" role="tablist" aria-label="費用查看方式">{([["people", admin ? "待收款" : "我的待繳"], ["refunds", admin ? "待退款" : "我的退款"], ["records", admin ? "帳務紀錄" : "繳費紀錄"]] as const).map(([value, label]) => <button key={value} role="tab" aria-selected={activeTab === value} className={activeTab === value ? "active" : ""} onClick={() => { setTab(value); setSelectedIds([]); setRefundIds([]); }}>{label}</button>)}</div>
    {feedback && <p className="billing-outstanding billing-receipt-feedback" role="status">{feedback}</p>}
    <div className="billing-filters">
      <label>查看期間<select value={period} onChange={(event) => { setPeriod(event.target.value); setSelectedIds([]); setRefundIds([]); }}><option value="ALL">全部期間</option><option value="CURRENT">本季{currentPeriod ? " · " + currentPeriod.label : ""}</option>{periods.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}（{entry.start}～{entry.end}）</option>)}</select></label>
      <label>搜尋<input type="search" placeholder={admin ? "姓名、帳號或日期" : "日期或季度"} value={search} onChange={(event) => { setSearch(event.target.value); setSelectedIds([]); setRefundIds([]); }} /></label>
      {(tab === "records" || tab === "activities") && <div className="billing-filter-actions">
        {tab === "records" ? <>
          <button type="button" className="secondary" onClick={() => setTab("activities")}>按活動查看</button>
          {admin && <button type="button" className="secondary" onClick={props.openRates}>費率設定</button>}
        </> : <button type="button" className="secondary" onClick={() => setTab("records")}>返回帳務紀錄</button>}
      </div>}
    </div>
    {tab === "people" && (admin ? <section className="billing-collection" aria-label="待收款清單" data-receipt-dock={Boolean(manage && queue.some(collectable)) || undefined}>
      <div className="billing-queue-top">
        <div className="billing-queue-filter" role="group" aria-label="待收款篩選">
          <button type="button" aria-pressed={queueFilter === "PENDING"} onClick={() => { setQueueFilter("PENDING"); setSelectedIds([]); }}>待繳</button>
          <button type="button" aria-pressed={queueFilter === "REPORTED"} onClick={() => { setQueueFilter("REPORTED"); setSelectedIds([]); }}>待確認{summary.reportedCount > 0 && ` ${summary.reportedCount}`}</button>
        </div>
        <div className="billing-queue-controls">
          <span>{queueGroups.length} 人 · {queue.length} 筆帳單</span>
          {manage && voidCandidates.length > 0 && <BillingMore>
            <button type="button" className="link danger" disabled={saving} onClick={() => setVoidPickerOpen(true)}>{operationLabels.voidInvoiceBatch}</button>
          </BillingMore>}
        </div>
      </div>
      {!queue.length ? <p className="billing-empty">目前沒有符合條件的待收款。</p> : <PersonGroups groups={queueGroups} renderRow={renderQueueRow}
        total={(rows) => money(rows.reduce((sum, invoice) => sum + invoice.amount, 0))} />}
      {manage && selected.length > 0 && <div className="billing-batch-bar billing-receipt-dock" role="region" aria-label="已選帳單操作">
        <strong aria-live="polite">已選 {selected.length} 筆 · {money(selected.reduce((sum, invoice) => sum + invoice.amount, 0))}</strong>
        <div className="billing-receipt-dock-actions">
          <button type="button" className="link" disabled={saving} onClick={() => setSelectedIds([])}>清除</button>
          <button type="button" className="primary" disabled={saving} onClick={() => openReceipt(selected)}>確認收款（{selected.length} 筆）</button>
        </div>
        {selected.length >= receiptMax && <small className="billing-receipt-dock-limit">每次最多登記 {receiptMax} 筆。不同日期或方式請分批。</small>}
      </div>}
    </section> : <section aria-label="我的待繳帳單" className="billing-personal-list">
      {queue.length ? queue.map((invoice) => renderInvoice(invoice)) : <p className="billing-empty">目前沒有待結清的帳單。</p>}
    </section>)}
    {tab === "refunds" && <section aria-label="待退款清單">
      {selectedRefunds.length > 0 && <div className="billing-batch-bar">
        <strong>已選 {selectedRefunds.length} 筆 · {money(selectedRefunds.reduce((sum, invoice) => sum + (invoice.pending_refund_amount ?? 0), 0))}</strong>
        <button type="button" className="link" onClick={() => setRefundIds([])}>清除</button>
        <button type="button" className="primary" disabled={saving} onClick={() => setRefundRows(selectedRefunds)}>登記這 {selectedRefunds.length} 筆</button>
      </div>}
      {!refunds.length && <p className="billing-empty">目前沒有待退款或待核對款項。</p>}
      {refunds.length > 0 && (admin
        ? <PersonGroups groups={groupInvoicesByMember(refunds)} renderRow={(invoice) => renderRefundRow(invoice, true)}
            total={(rows) => {
              const amount = rows.reduce((sum, invoice) => sum + (invoice.status === "AWAITING_OFFLINE_REFUND" ? invoice.pending_refund_amount ?? 0 : 0), 0);
              return amount > 0 ? money(amount) : null;
            }} />
        : <div className="billing-personal-list">{refunds.map((invoice) => renderRefundRow(invoice))}</div>)}
    </section>}
    {(tab === "records" || tab === "activities") && <section>
      <div className="billing-section-tools billing-record-tools">
        <label className="billing-record-type">紀錄類型
          <select value={ledgerType} onChange={(event) => setLedgerType(event.target.value)}>
            <option value="CHARGES">{admin ? "收費帳單" : "已結案帳單"}</option>
            <option value="ADJUSTMENTS">退款與餘額紀錄</option>
            <option value="ALL">全部紀錄</option>
          </select>
        </label>
        <div className="billing-record-actions">
          <label className="billing-checkbox"><input type="checkbox" checked={showVoided} onChange={(event) => setShowVoided(event.target.checked)} />包含已作廢</label>
          {admin && <button type="button" className="secondary" disabled={!ledger.length} onClick={exportLedger}>匯出紀錄</button>}
        </div>
      </div>
      {!ledger.length ? <p className="billing-empty">沒有符合條件的紀錄</p> : tab === "activities"
      ? activityList.map(({ id, startsAt, courts, rows }) => <details className="billing-person" key={id ?? "unlinked"}>
        <summary>
          <strong>{id ? [startsAt ? schedule(startsAt) : "", courts].filter(Boolean).join(" · ") || "活動資料已封存" : "未關聯活動"}</strong>
          <small>{rows.length} 筆紀錄</small>
        </summary>
        <div className="billing-detail-list">{rows.map((invoice) => renderInvoice(invoice, false, true))}</div>
      </details>) : admin
      ? <PersonGroups groups={groupInvoicesByMember(ledger)} renderRow={(invoice) => renderInvoice(invoice, true, true)} />
      : <div className="billing-personal-list">{ledger.map((invoice) => renderInvoice(invoice, false, true))}</div>}</section>}
    {admin && manage && tab === "people" && voidPickerOpen && <VoidBatchPicker invoices={voidCandidates} close={() => setVoidPickerOpen(false)}
      review={(selected) => { setVoidPickerOpen(false); setSelection({ operation: "voidInvoiceBatch", invoices: selected }); }} />}
    {receiptRows && <ReceiptDialog invoices={receiptRows} saving={saving} submit={recordReceipts} close={() => setReceiptRows(null)} />}
    {refundRows && <OfflineRefundDialog invoices={refundRows} saving={saving} submit={recordRefunds} close={() => setRefundRows(null)} />}
    {selection && <InvoiceOperationModal selection={selection} saving={saving} submit={submit} close={() => setSelection(null)} />}
  </div>;
}

function QueueActivityLink({ activities, openEvent }: {
  activities: { id: string; label: string }[];
  openEvent?: (id: string) => void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  if (!openEvent || !activities.length) return null;
  return <div className="billing-queue-activity">
    {activities.length === 1
      ? <button type="button" className="billing-queue-detail-trigger" aria-haspopup="dialog" onClick={() => openEvent(activities[0].id)}>查看活動詳情</button>
      : <>
        <button type="button" className="billing-queue-detail-trigger" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((open) => !open)}>查看活動詳情</button>
        <ul id={id} className="billing-queue-activity-links" hidden={!expanded}>
          {activities.map((activity) => <li key={activity.id}><button type="button" className="link" aria-haspopup="dialog" onClick={() => openEvent(activity.id)}>{activity.label}</button></li>)}
        </ul>
      </>}
  </div>;
}

function VoidBatchPicker({ invoices, close, review }: { invoices: ManagedInvoice[]; close: () => void; review: (invoices: ManagedInvoice[]) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [ids, setIds] = useState<string[]>([]);
  const picked = invoices.filter((invoice) => ids.includes(invoice.id));
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  return <dialog ref={dialog} className="modal billing-receipt-modal" aria-labelledby="billing-void-picker-title" onCancel={(event) => { event.preventDefault(); close(); }}>
    <button type="button" className="close" aria-label="關閉帳單選擇" onClick={close}>×</button>
    <h2 id="billing-void-picker-title">選擇要作廢的帳單</h2>
    {invoices.length ? <ul className="billing-receipt-list billing-void-list">{invoices.map((invoice) =>
      <li key={invoice.id}><label>
        <input type="checkbox" checked={ids.includes(invoice.id)} disabled={!ids.includes(invoice.id) && picked.length >= voidBatchMax}
          onChange={(event) => {
            const checked = event.target.checked;
            setIds((previous) => {
              const active = previous.filter((id) => invoices.some((row) => row.id === id) && id !== invoice.id);
              return checked && active.length < voidBatchMax ? [...active, invoice.id] : active;
            });
          }} />
        <span><strong>{invoice.memberName}</strong><small>{[invoice.memberAccountName, feeTitle(invoice)].filter(Boolean).join(" · ")}</small>{singleEventLabel(invoice) && <small>{singleEventLabel(invoice)}</small>}</span>
        <strong>{money(invoice.amount)}</strong>
      </label></li>)}</ul> : <p className="billing-empty">沒有可作廢的未繳帳單。</p>}
    {picked.length >= voidBatchMax && <p className="form-note">每批最多選擇 {voidBatchMax} 筆。</p>}
    <div className="billing-void-picker-footer">
      <span aria-live="polite">已選 {picked.length} 筆 · {money(picked.reduce((sum, invoice) => sum + invoice.amount, 0))}</span>
      <button type="button" className="primary" disabled={!picked.length} onClick={() => { if (picked.length) review(picked); }}>核對作廢帳單</button>
    </div>
  </dialog>;
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
    <button type="button" className="close" disabled={saving} aria-label="關閉確認收款" onClick={close}>×</button>
    <h2 id="billing-receipt-title">{invoices.length === 1 ? "確認收款" : "批次確認收款"}</h2>
    <p className="billing-receipt-lead">收到全額後再確認。這個操作不會發起轉帳。</p>
    <div className="billing-receipt-total"><span>實收合計 · {invoices.length} 筆</span><strong>{money(total)}</strong></div>
    <ul className="billing-receipt-list" role="list">{invoices.map((invoice) => <li key={invoice.id}><span><strong>{invoice.memberName}</strong><small>{feeTitle(invoice)}{invoice.memberAccountName ? " · " + invoice.memberAccountName : ""}</small>{singleEventLabel(invoice) && <small>{singleEventLabel(invoice)}</small>}</span><strong>{money(invoice.amount)}</strong></li>)}</ul>
    <form className="manager-form billing-receipt-form" onSubmit={(event) => void record(event)}>
      <fieldset disabled={saving}>
        <legend>收款方式</legend>
        <div className="billing-receipt-method">
          {([["CASH", "現金"], ["BANK", "轉帳"]] as const).map(([value, label]) => <label key={value}><input type="radio" name="receiptMethod" value={value} checked={method === value} required onChange={() => setMethod(value)} />{label}</label>)}
        </div>
        <label>收款日期<input name="receivedDate" type="date" defaultValue={today} max={today} required /></label>
        <label>備註（選填）<input name="note" type="text" maxLength={200} placeholder="例如：球場現場收款" /></label>
      </fieldset>
      {invoices.length > 1 && <p className="form-note">這批帳單使用同一收款方式和日期。不同方式或日期請分開確認。</p>}
      <button type="submit" className="primary" disabled={!method || saving}>{saving ? "確認中…" : "確認收款 · " + money(total)}</button>
    </form>
  </dialog>;
}

function InvoiceOperationModal({ selection, saving, submit, close }: { selection: Selection; saving: boolean; submit: (input: Record<string, string>) => Promise<void>; close: () => void }) {
  const invoice = "invoice" in selection ? selection.invoice : null;
  const title = selection.operation === "reissueInvoice" && invoice?.status === "VOID" ? "重新開單" : operationLabels[selection.operation];
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
    if (saving || (selection.operation === "voidInvoiceBatch" && (!reason.trim() || !selection.invoices.length))) return;
    const input: Record<string, string> = { reason };
    if (invoice) Object.assign(input, { invoiceId: invoice.id, expectedStatus: invoice.status, expectedAmount: String(invoice.amount), expectedRefundable: String(invoice.refundable_amount ?? 0), refundMode: mode, offlineRefunded: String(acknowledged), checkedNotReceived: String(acknowledged), eventAmounts: JSON.stringify(amounts), dueDate: due });
    else if ("invoices" in selection) input.invoices = JSON.stringify(selection.invoices.map((entry) => ({ id: entry.id, amount: entry.amount })));
    await submit(input);
  };
  return <div className="modal-cover" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) close(); }}><section className="modal manager-modal" role="dialog" aria-modal="true" aria-labelledby="invoice-operation-title"><button className="close" disabled={saving} aria-label="關閉帳單操作" onClick={close}>×</button><h2 id="invoice-operation-title">{title}</h2><form className="manager-form" onSubmit={handleSubmit}><fieldset disabled={saving}>
    {invoice && <p>{invoice.memberName}{invoice.memberAccountName ? "（帳號：" + invoice.memberAccountName + "）" : ""} · {invoice.period_label}<br />目前應付 {money(invoice.amount)} · 已抵扣餘額 {money(invoice.credit_applied)}</p>}
    {"invoices" in selection && <><p>將作廢 {selection.invoices.length} 筆、{new Set(selection.invoices.map((entry) => entry.member_id)).size} 人，取消應收 {money(selection.invoices.reduce((sum, entry) => sum + entry.amount, 0))}，退回抵扣餘額 {money(selection.invoices.reduce((sum, entry) => sum + entry.credit_applied, 0))}。</p><p>只會作廢你勾選的帳單。</p><details><summary>查看本次影響名單</summary>{selection.invoices.map((entry) => <p key={entry.id}>{entry.memberName}{entry.memberAccountName ? "（帳號：" + entry.memberAccountName + "）" : ""} · {feeTitle(entry)}{singleEventLabel(entry) && " · " + singleEventLabel(entry)} · {money(entry.amount)}</p>)}</details></>}
    {selection.operation === "reissueInvoice" && <><p className="form-note">{invoice?.status === "VOID" ? "會開立新帳單並保留原作廢紀錄。" : "確認後會作廢原帳單，並以修改後的金額開立新帳單。原單紀錄會保留。"}</p>{amounts.map((amount, index) => <label key={index}>{invoice?.event_schedules?.[index] ? schedule(invoice.event_schedules[index].starts_at) : "帳單項目"} 金額（元）<input type="number" min="0" max="1000000" step="1" required value={amount} disabled={invoice?.event_schedules?.[index]?.status === "CANCELLED"} onChange={(event) => setAmounts((current) => current.map((value, position) => position === index ? Number(event.target.value) : value))} /></label>)}<strong>重開原價合計 {money(amounts.reduce((sum, value) => sum + value, 0))}，再依目前餘額抵扣</strong><label>新繳費期限<input type="date" value={due} required min={taipeiDay(new Date())} onChange={(event) => setDue(event.target.value)} /></label></>}
    {selection.operation === "refundInvoice" && <><p>可退金額 {money(invoice?.refundable_amount ?? 0)}（已扣除先前退款）。</p><label>退款方式<select value={mode} onChange={(event) => { setMode(event.target.value); setAcknowledged(false); }}><option value="BALANCE">全部轉回帳戶餘額</option><option value="OFFLINE">登記已完成人工退款</option></select></label><p className="form-note">人工退款僅登記結果，不會發起轉帳；原先使用的餘額仍退回帳戶。</p>{mode === "OFFLINE" && <label className="billing-checkbox"><input type="checkbox" required checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />我已完成現金／轉帳退款；現金退款 {money(Math.min(invoice?.refundable_amount ?? 0, invoice?.amount ?? 0))}，其餘退回餘額。</label>}</>}
    {selection.operation === "rejectPaymentReport" && <label className="billing-checkbox"><input type="checkbox" required checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />已核對收款紀錄，確認尚未收到這筆轉帳。</label>}
    <label>原因<textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} required rows={3} /></label><p className="form-note">操作會保留原因、時間與操作者；活動及報名保持不變。</p><button className="primary" disabled={saving || (selection.operation === "voidInvoiceBatch" && !reason.trim())}>{saving ? "處理中…" : "確認" + title}</button>
  </fieldset></form></section></div>;
}
