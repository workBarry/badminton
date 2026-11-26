export type InvoiceSchedule = { id: string; starts_at: string | null; ends_at: string | null; courts: string; status?: string; cancellation_reason?: string | null };
export type InvoiceAdjustment = { kind: string; reason: string; eventId?: string; eventDate?: string; amount: number; actorName: string; createdAt: string };
export type ManagedInvoice = {
  id: string; member_id: string; memberName: string; memberAccountName?: string; type: string; status: string;
  gross_amount: number; credit_applied: number; amount: number;
  event_id?: string | null; event_ids?: string[]; event_amounts?: number[]; original_event_amounts?: number[]; event_schedules?: InvoiceSchedule[];
  original_event_schedules?: InvoiceSchedule[];
  original_gross_amount?: number; original_amount?: number; baseline_event_count?: number;
  period_id?: string | null; period_label?: string; period_start?: string | null; period_end?: string | null;
  due_at?: string | null; created_at?: string | null; adjustments?: InvoiceAdjustment[];
  related_invoice_id?: string | null; replacement_of_id?: string | null; replaced_by_id?: string | null;
  void_reason?: string | null; cancellation_reason?: string | null; refundable_amount?: number;
  pending_refund_amount?: number; refund_method?: "CASH" | "BANK"; original_receipt_method?: "CASH" | "BANK" | null;
  refund_wallet_amount?: number; refund_completed_amount?: number;
  refund_completed_date?: string | null; refund_recorded_by_name?: string | null; refund_note?: string | null;
  receipt_method?: "CASH" | "BANK"; receipt_received_date?: string | null; receipt_amount?: number | null;
  receipt_recorded_by?: string | null; receipt_recorded_by_name?: string | null; receipt_recorded_at?: string | null; receipt_note?: string | null;
};
export type BillingActivity = {
  id: string; startsAt?: string; endsAt?: string; courts: string; memberBilling?: string; eventKind?: string;
  guestSettlements?: { memberId: string; status: string }[];
  bookings: { memberId: string; name: string; accountName?: string; kind: string; rank?: string; transferred?: boolean }[];
};
export const PRINCIPAL_TYPES = ["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "SINGLE_EVENT", "MEMBER_EXTRA", "MEMBER_SINGLE"];
export const isPrincipal = (invoice: Pick<ManagedInvoice, "type">) => PRINCIPAL_TYPES.includes(invoice.type);
export const isOpen = (invoice: ManagedInvoice) => isPrincipal(invoice) && ["PENDING", "REPORTED"].includes(invoice.status);
export const includesEvent = (invoice: ManagedInvoice, eventId: string) =>
  (invoice.event_id === eventId || invoice.event_ids?.includes(eventId) === true) &&
  !invoice.adjustments?.some((entry) => entry.eventId === eventId && ["MEMBERSHIP_END_REDUCTION", "MEMBERSHIP_END_CREDIT"].includes(entry.kind));
export function isPaidForEvent(invoice: ManagedInvoice, eventId: string) {
  if (invoice.status !== "CONFIRMED" || !isPrincipal(invoice) || !includesEvent(invoice, eventId) ||
    invoice.event_schedules?.some((event) => event.id === eventId && event.status === "CANCELLED")) return false;
  const index = invoice.event_ids?.length ? invoice.event_ids.indexOf(eventId) : 0;
  return (invoice.event_amounts?.[index] ?? (invoice.amount + (invoice.credit_applied ?? 0))) > 0;
}

export function taipeiDay(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(date);
}
export function invoiceInRange(invoice: ManagedInvoice, start: string, end: string) {
  if (invoice.period_start && invoice.period_end) return invoice.period_start <= end && invoice.period_end >= start;
  const days = invoice.event_schedules?.map((event) => event.starts_at ? taipeiDay(event.starts_at) : "").filter(Boolean) ?? [];
  if (days.length) return days.some((date) => date >= start && date <= end);
  if (!invoice.created_at && !invoice.due_at) return true;
  const fallback = taipeiDay(invoice.created_at ?? invoice.due_at ?? "");
  return fallback >= start && fallback <= end;
}
export function billingSummary(invoices: ManagedInvoice[], now = new Date()) {
  const pending = invoices.filter((invoice) => isPrincipal(invoice) && invoice.status === "PENDING");
  const reported = invoices.filter((invoice) => isPrincipal(invoice) && invoice.status === "REPORTED");
  return { unpaidAmount: pending.reduce((sum, invoice) => sum + invoice.amount, 0),
    reportedCount: reported.length, reportedAmount: reported.reduce((sum, invoice) => sum + invoice.amount, 0),
    overdueAmount: pending.filter((invoice) => invoice.due_at && new Date(invoice.due_at) < now).reduce((sum, invoice) => sum + invoice.amount, 0) };
}
export function activityPayments(event: BillingActivity, invoices: ManagedInvoice[]) {
  const participants = new Map(event.bookings.map((booking) => [booking.memberId, booking]));
  // Include bill payers whose place was transferred: their quarterly debt must remain visible.
  for (const invoice of invoices.filter((entry) => isPrincipal(entry) && includesEvent(entry, event.id) && ["PENDING", "REPORTED", "CONFIRMED"].includes(entry.status))) {
    if (!participants.has(invoice.member_id)) participants.set(invoice.member_id, { memberId: invoice.member_id, name: invoice.memberName, accountName: invoice.memberAccountName, kind: "帳單付款人" });
  }
  const rows = [...participants.values()].map((person) => {
    const bills = invoices.filter((invoice) => invoice.member_id === person.memberId && isPrincipal(invoice) && includesEvent(invoice, event.id) && !["VOID", "REFUNDED", "CREDITED"].includes(invoice.status));
    const status = bills.some((invoice) => invoice.status === "PENDING") ? "PENDING"
      : bills.some((invoice) => invoice.status === "REPORTED") ? "REPORTED"
      : bills.length && bills.every((invoice) => invoice.status === "CONFIRMED") ? "SETTLED"
      : person.transferred ? "TRANSFER"
      : (event.memberBilling === "FREE" || person.kind === "社員" && event.memberBilling === "NO_CHARGE" || event.eventKind === "OTHER" && (person.rank === "候補" || event.guestSettlements?.some((item) => item.memberId === person.memberId && item.status === "SKIPPED"))) ? "EXEMPT" : "UNBILLED";
    return { ...person, status, bills, quarterly: bills.some((invoice) => ["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED"].includes(invoice.type)) };
  });
  const count = (status: string) => rows.filter((row) => row.status === status).length;
  return { rows, settled: count("SETTLED"), unpaid: count("PENDING"), reported: count("REPORTED"), unbilled: count("UNBILLED"),
    exempt: count("EXEMPT") + count("TRANSFER"), complete: rows.length > 0 && rows.every((row) => ["SETTLED", "EXEMPT", "TRANSFER"].includes(row.status)) };
}

export function referencesEvent(invoice: ManagedInvoice, eventId: string) {
  return invoice.event_id === eventId || invoice.event_ids?.includes(eventId) === true;
}

export function invoiceEventLines(invoice: ManagedInvoice) {
  const ids = invoice.event_ids?.length ? invoice.event_ids : invoice.event_id ? [invoice.event_id] : (invoice.event_schedules ?? []).map((entry) => entry.id);
  const schedules = new Map(invoice.event_schedules?.map((event) => [event.id, event]));
  const originals = new Map(invoice.original_event_schedules?.map((event) => [event.id, event]));
  return ids.map((id, index) => {
    const event = schedules.get(id);
    const original = originals.get(id);
    const timeChanged = Boolean(event && original && (
      (original.starts_at && event.starts_at && original.starts_at !== event.starts_at) ||
      (original.ends_at && event.ends_at && original.ends_at !== event.ends_at)
    ));
    const venueChanged = Boolean(event && original?.courts && event.courts && original.courts !== event.courts);
    const adjustments = (invoice.adjustments ?? []).filter((entry) => entry.eventId === id);
    const showsOriginal = invoice.original_event_amounts?.[index] ?? (ids.length === 1 ? invoice.original_gross_amount : undefined);
    const listed = invoice.event_amounts?.[index];
    // Older records may omit the original amount of a cancelled line; never guess.
    const amount = showsOriginal ?? (event?.status === "CANCELLED" && !listed ? undefined : listed);
    return { id, event, original, timeChanged, venueChanged, amount, adjustments };
  });
}
