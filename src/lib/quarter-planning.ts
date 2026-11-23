export type QuarterRules = {
  label: string;
  startDate: string;
  endDate: string;
  weekday: number;
  startTime: string;
  endTime: string;
  courts: string;
  regularCapacity: number;
  standbyCapacity: number;
  excludedDates: string[];
};
export type SuggestedActivity = { date: string; startTime: string; endTime: string; courts: string; regularCapacity: number; standbyCapacity: number };
export type QuarterPlan = QuarterRules & {
  id: string;
  revision: number;
  status: "DRAFT" | "CONFIRMED";
  activities: SuggestedActivity[];
  eventIds?: string[];
  eventAmounts?: number[];
  eventCount?: number;
  grossAmount?: number;
  confirmedAt?: string | null;
  billed?: boolean;
};

export function validCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validateQuarterDateRange(startDate: string, endDate: string) {
  if (!validCalendarDate(startDate) || !validCalendarDate(endDate) || endDate < startDate) throw new Error("請填寫正確的季度起訖日期");
  const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1;
  if (days > 100) throw new Error("每季日期範圍最多 100 天");
}
export function validateQuarterRules(rules: QuarterRules) {
  if (!rules || typeof rules.label !== "string" || !rules.label.trim() || rules.label.length > 60) throw new Error("請填寫季度名稱（最多 60 字）");
  validateQuarterDateRange(rules.startDate, rules.endDate);
  if (!Number.isInteger(rules.weekday) || rules.weekday < 0 || rules.weekday > 6) throw new Error("請選擇固定星期");
  if (!Array.isArray(rules.excludedDates) || rules.excludedDates.length > 100 || rules.excludedDates.some((date) => !validCalendarDate(date) || date < rules.startDate || date > rules.endDate)) throw new Error("假日排除日期必須是季度範圍內的有效日期");
  validateActivity({ ...rules, date: rules.startDate }, rules);
}
export function validateActivity(activity: SuggestedActivity, rules: Pick<QuarterRules, "startDate" | "endDate">) {
  if (!activity || !validCalendarDate(activity.date) || activity.date < rules.startDate || activity.date > rules.endDate) throw new Error("活動日期必須位於季度範圍內");
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!time.test(activity.startTime) || !time.test(activity.endTime) || activity.endTime <= activity.startTime) throw new Error("活動結束時間必須晚於開始時間");
  if (typeof activity.courts !== "string" || !activity.courts.trim() || activity.courts.length > 120) throw new Error("請填寫活動場地（最多 120 字）");
  if (!Number.isInteger(activity.regularCapacity) || activity.regularCapacity < 1 || !Number.isInteger(activity.standbyCapacity) || activity.standbyCapacity < 0 || activity.regularCapacity + activity.standbyCapacity > 100) throw new Error("正取至少 1 人，候補至少 0 人，合計最多 100 人");
}
export function suggestActivities(rules: QuarterRules): SuggestedActivity[] {
  validateQuarterRules(rules);
  const activities: SuggestedActivity[] = [];
  for (let timestamp = Date.parse(rules.startDate); timestamp <= Date.parse(rules.endDate); timestamp += 86400000) {
    const day = new Date(timestamp);
    const date = day.toISOString().slice(0, 10);
    if (day.getUTCDay() !== rules.weekday || rules.excludedDates.includes(date)) continue;
    activities.push({ date, startTime: rules.startTime, endTime: rules.endTime, courts: rules.courts.trim(), regularCapacity: rules.regularCapacity, standbyCapacity: rules.standbyCapacity });
  }
  return activities;
}
export function validateQuarterDraft(rules: QuarterRules, activities: SuggestedActivity[]) {
  validateQuarterRules(rules);
  if (!Array.isArray(activities) || activities.length > 32) throw new Error("每季最多 32 場活動");
  const dates = new Set<string>();
  for (const activity of activities) {
    validateActivity(activity, rules);
    if (dates.has(activity.date)) throw new Error("建議活動有重複日期：" + activity.date);
    dates.add(activity.date);
  }
}
export type InvoiceAmounts = {
  grossAmount?: number; creditApplied?: number; amount?: number;
  adjustedGrossAmount?: number; adjustedCreditApplied?: number; adjustedAmount?: number;
};
export function effectiveInvoiceAmounts(invoice: InvoiceAmounts) {
  return {
    grossAmount: Number(invoice.adjustedGrossAmount ?? invoice.grossAmount ?? invoice.amount ?? 0),
    creditApplied: Number(invoice.adjustedCreditApplied ?? invoice.creditApplied ?? 0),
    amount: Number(invoice.adjustedAmount ?? invoice.amount ?? 0),
  };
}
export function reduceUnpaidInvoice(invoice: InvoiceAmounts, reduction: number) {
  if (!Number.isSafeInteger(reduction) || reduction < 0) throw new Error("減收金額不正確");
  const before = effectiveInvoiceAmounts(invoice);
  const grossAmount = Math.max(0, before.grossAmount - reduction);
  const creditApplied = Math.min(before.creditApplied, grossAmount);
  return {
    adjustedGrossAmount: grossAmount,
    adjustedCreditApplied: creditApplied,
    adjustedAmount: grossAmount - creditApplied,
    restoredCredit: before.creditApplied - creditApplied,
  };
}
