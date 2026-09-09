export type InvoiceSchedule = { id: string; starts_at: string | null; ends_at: string | null; courts: string; status?: string };
export type InvoiceAdjustment = { kind: string; reason: string; eventId?: string; eventDate?: string; amount: number; actorName: string; createdAt: string };
export type ManagedInvoice = {
  id: string; member_id: string; memberName: string; type: string; status: string;
  gross_amount: number; credit_applied: number; amount: number;
  event_id?: string | null; event_ids?: string[]; event_amounts?: number[]; event_schedules?: InvoiceSchedule[];
  original_gross_amount?: number; original_amount?: number; baseline_event_count?: number;
  period_id?: string | null; period_label?: string; period_start?: string | null; period_end?: string | null;
  due_at?: string | null; created_at?: string | null; adjustments?: InvoiceAdjustment[];
  related_invoice_id?: string | null; replacement_of_id?: string | null; replaced_by_id?: string | null;
  void_reason?: string | null; cancellation_reason?: string | null; refundable_amount?: number;
};
export type BillingActivity = {
  id: string; startsAt?: string; endsAt?: string; courts: string; memberBilling?: string;
  bookings: { memberId: string; name: string; kind: string; transferred?: boolean }[];
};
export const PRINCIPAL_TYPES = ["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED", "SINGLE_EVENT", "MEMBER_EXTRA"];
export const isPrincipal = (invoice: Pick<ManagedInvoice, "type">) => PRINCIPAL_TYPES.includes(invoice.type);
export const isOpen = (invoice: ManagedInvoice) => isPrincipal(invoice) && ["PENDING", "REPORTED"].includes(invoice.status);
export const includesEvent = (invoice: ManagedInvoice, eventId: string) => invoice.event_id === eventId || invoice.event_ids?.includes(eventId) === true;
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
  return { unpaidPeople: new Set(pending.map((invoice) => invoice.member_id)).size,
    unpaidAmount: pending.reduce((sum, invoice) => sum + invoice.amount, 0),
    reportedCount: reported.length, reportedAmount: reported.reduce((sum, invoice) => sum + invoice.amount, 0),
    overdueAmount: pending.filter((invoice) => invoice.due_at && new Date(invoice.due_at) < now).reduce((sum, invoice) => sum + invoice.amount, 0) };
}
export function groupByPerson(invoices: ManagedInvoice[]) {
  const groups = new Map<string, { id: string; name: string; invoices: ManagedInvoice[] }>();
  for (const invoice of invoices.filter(isPrincipal).filter((entry) => !["VOID", "REFUNDED", "CREDITED"].includes(entry.status))) {
    const group = groups.get(invoice.member_id) ?? { id: invoice.member_id, name: invoice.memberName, invoices: [] };
    group.invoices.push(invoice); groups.set(group.id, group);
  }
  return [...groups.values()].map((group) => ({ ...group, ...billingSummary(group.invoices) }))
    .sort((a, b) => (b.unpaidAmount + b.reportedAmount) - (a.unpaidAmount + a.reportedAmount) || a.name.localeCompare(b.name, "zh-Hant"));
}
export function activityPayments(event: BillingActivity, invoices: ManagedInvoice[]) {
  const participants = new Map(event.bookings.map((booking) => [booking.memberId, booking]));
  // Include bill payers whose place was transferred: their quarterly debt must remain visible.
  for (const invoice of invoices.filter((entry) => isPrincipal(entry) && includesEvent(entry, event.id) && ["PENDING", "REPORTED", "CONFIRMED"].includes(entry.status))) {
    if (!participants.has(invoice.member_id)) participants.set(invoice.member_id, { memberId: invoice.member_id, name: invoice.memberName, kind: "帳單付款人" });
  }
  const rows = [...participants.values()].map((person) => {
    const bills = invoices.filter((invoice) => invoice.member_id === person.memberId && isPrincipal(invoice) && includesEvent(invoice, event.id) && !["VOID", "REFUNDED", "CREDITED"].includes(invoice.status));
    const status = bills.some((invoice) => invoice.status === "PENDING") ? "PENDING"
      : bills.some((invoice) => invoice.status === "REPORTED") ? "REPORTED"
      : bills.length && bills.every((invoice) => invoice.status === "CONFIRMED") ? "SETTLED"
      : person.transferred ? "TRANSFER"
      : person.kind === "社員" && event.memberBilling === "NO_CHARGE" ? "EXEMPT" : "UNBILLED";
    return { ...person, status, bills, quarterly: bills.some((invoice) => ["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED"].includes(invoice.type)) };
  });
  const count = (status: string) => rows.filter((row) => row.status === status).length;
  return { rows, settled: count("SETTLED"), unpaid: count("PENDING"), reported: count("REPORTED"), unbilled: count("UNBILLED"),
    exempt: count("EXEMPT") + count("TRANSFER"), complete: rows.length > 0 && rows.every((row) => ["SETTLED", "EXEMPT", "TRANSFER"].includes(row.status)) };
}
