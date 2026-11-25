"use client";
import { useRef, useState } from "react";
import type { OfficialClosure } from "@/lib/official-closures";
import { suggestActivities, validateQuarterSchedule, validateQuarterRules, type QuarterPlan, type QuarterRules, type SuggestedActivity } from "@/lib/quarter-planning";

type Result = { planId?: string; eventCount?: number; totalAmount?: number; skippedDates?: string[] };
type Props = {
  plans: QuarterPlan[];
  existingDates: string[];
  saving: boolean;
  confirmPlan: (input: { planId: string; schedule: string }) => Promise<Result | null>;
};
function defaultRules(): QuarterRules {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date());
  const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
  const end = new Date(Date.UTC(year, month - 1 + 3, 0)).toISOString().slice(0, 10);
  return { label: year + " 年 " + month + " 月起季度", startDate: today, endDate: end, weekday: 5, startTime: "18:00", endTime: "20:00", courts: "公司體育館 A 場", regularCapacity: 10, standbyCapacity: 4, excludedDates: [] };
}
export default function QuarterPlanner({ plans, existingDates, saving, confirmPlan }: Props) {
  const pendingPlanId = useRef<string | null>(null);
  const [rules, setRules] = useState<QuarterRules>(defaultRules);
  const [activities, setActivities] = useState<SuggestedActivity[]>([]);
  const [officialClosures, setOfficialClosures] = useState<OfficialClosure[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [needsGenerate, setNeedsGenerate] = useState(true);
  const [message, setMessage] = useState("");
  const busy = saving || generating;
  const closureNames = new Map(officialClosures?.map((closure) => [closure.date, closure.name]));
  const occupied = new Set(existingDates);
  const seen = new Set<string>();
  const rowReasons = activities.map((entry) => {
    if (occupied.has(entry.date)) return "已有活動，將跳過";
    if (seen.has(entry.date)) return "草稿日期重複，將跳過";
    seen.add(entry.date);
    return "";
  });
  const newCount = rowReasons.filter((reason) => !reason).length;
  const skipCount = activities.length - newCount;
  const updateRules = <K extends keyof QuarterRules>(key: K, value: QuarterRules[K]) => {
    setRules((current) => ({ ...current, [key]: value }));
    setGenerationError("");
    setNeedsGenerate(true); setMessage("");
  };
  const generate = async () => {
    if (busy) return;
    setGenerationError("");
    try {
      validateQuarterRules({ ...rules, excludedDates: [] });
      if (activities.length && !window.confirm("重新產生會取代目前建議清單，包含手動調整，確定繼續？")) return;
      setGenerating(true);
      setMessage("");
      const params = new URLSearchParams({ startDate: rules.startDate, endDate: rules.endDate });
      const response = await fetch("/api/club/quarter-exclusions?" + params).catch(() => null);
      const data = await response?.json().catch(() => null) as { closures?: OfficialClosure[]; error?: string } | null | undefined;
      if (!response?.ok || !Array.isArray(data?.closures)) throw new Error(data?.error ?? "無法取得政府假日資料，請稍後再試");
      const values = { ...rules, excludedDates: data.closures.map((closure) => closure.date) };
      const now = Date.now();
      const next = suggestActivities(values).filter((entry) => Date.parse(entry.date + "T" + entry.startTime + ":00+08:00") > now);
      setOfficialClosures(data.closures);
      setRules(values); setActivities(next); setNeedsGenerate(false);
      setMessage("已產生 " + next.length + " 場建議活動，尚未建立正式活動。");
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "產生失敗");
    } finally {
      setGenerating(false);
    }
  };
  const updateActivity = (index: number, value: Partial<SuggestedActivity>) => {
    setActivities((current) => current.map((entry, position) => position === index ? { ...entry, ...value } : entry));
  };
  const confirm = async () => {
    if (busy || needsGenerate || !newCount) return;
    setMessage("");
    try {
      validateQuarterSchedule(rules, activities);
      if (!window.confirm("預計建立 " + newCount + " 場正式活動" + (skipCount ? "，跳過 " + skipCount + " 筆重複場次" : "") + "。送出時會再次確認日期；只有新場次會納入此次計費基準。確定建立嗎？")) return;
      pendingPlanId.current ??= crypto.randomUUID();
      const result = await confirmPlan({ planId: pendingPlanId.current, schedule: JSON.stringify({ rules, activities }) });
      if (typeof result?.eventCount === "number") {
        const skipped = result.skippedDates?.length ? "已跳過： " + result.skippedDates.join("、") + "。" : "";
        if (result.eventCount === 0) {
          pendingPlanId.current = null;
          setMessage("這些日期已有活動，未建立新場次或新的計費期間。" + skipped);
        } else {
          pendingPlanId.current = null;
          setActivities([]);
          setNeedsGenerate(true);
          setMessage("已建立 " + result.eventCount + " 場；季度原始計費基準 NT$" + Number(result.totalAmount ?? 0).toLocaleString("zh-TW") + "。" + skipped + " 可至費用管理預覽各社員的實際帳單。");
        }
      }
    } catch (error) {
      setMessage(error instanceof TypeError ? "連線中斷，請重試確認建立。" : error instanceof Error ? error.message : "確認建立失敗");
    }
  };
  return <div className="quarter-planner">
      <form className="manager-form" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
        <fieldset disabled={busy}>
          <label>季度名稱<input value={rules.label} maxLength={60} required onChange={(event) => updateRules("label", event.target.value)} /></label>
          <div className="time-pair">
            <label>季度開始日期<input type="date" value={rules.startDate} required onChange={(event) => updateRules("startDate", event.target.value)} /></label>
            <label>季度結束日期<input type="date" value={rules.endDate} required onChange={(event) => updateRules("endDate", event.target.value)} /></label>
          </div>
          <label>固定星期<select value={rules.weekday} onChange={(event) => updateRules("weekday", Number(event.target.value))}>{["日", "一", "二", "三", "四", "五", "六"].map((day, index) => <option key={index} value={index}>星期{day}</option>)}</select></label>
          <div className="time-pair">
            <label>開始時間<input type="time" value={rules.startTime} required onChange={(event) => updateRules("startTime", event.target.value)} /></label>
            <label>結束時間<input type="time" value={rules.endTime} required onChange={(event) => updateRules("endTime", event.target.value)} /></label>
          </div>
          <label>預設場地<input value={rules.courts} required maxLength={120} onChange={(event) => updateRules("courts", event.target.value)} /></label>
          <div className="capacity-fields">
            <label>正取基準人數<input type="number" min="1" max="100" required value={rules.regularCapacity} onChange={(event) => updateRules("regularCapacity", Number(event.target.value))} /></label>
            <label>候補可參加上限<input type="number" min="0" max="99" required value={rules.standbyCapacity} onChange={(event) => updateRules("standbyCapacity", Number(event.target.value))} /></label>
          </div>
          <p className="form-note">自動排除國定假日、政府公告補假或調整放假日，以及已公告的新北市全市停班停課日期。</p>
          {generationError && <p className="quarter-feedback" role="alert">{generationError}</p>}
          <button className="secondary" type="submit">{generating ? "查詢政府公告中…" : activities.length ? "重新產生建議活動" : "產生建議活動"}</button>
        </fieldset>
      </form>
      {!needsGenerate && <section className="quarter-suggestions">
        <header><strong>預計新增 {newCount} 場{skipCount ? " · 跳過 " + skipCount + " 筆" : ""}</strong><span>已經有活動的日期不會重建，也不納入這次開單</span></header>
        {activities.length === 0 && <p className="form-note">請新增至少一場活動，才能確認建立。</p>}
        {activities.length > 0 && newCount === 0 && <p className="quarter-feedback">沒有可新增的日期。原有活動與帳單不會變更。</p>}
        {!!rules.excludedDates.length && <details className="quarter-exclusions">
          <summary>政府公告排除日期 · {rules.excludedDates.length} 天</summary>
          <ul>{rules.excludedDates.map((date) => <li key={date}>{date}{closureNames.has(date) && ` · ${closureNames.get(date)}`}</li>)}</ul>
        </details>}
        {officialClosures?.length === 0 && <p className="form-note">此季度範圍目前沒有適用的政府公告排除日期。</p>}
        <fieldset disabled={busy}>
          {activities.map((entry, index) => <article key={index} className="quarter-activity">
            <div className="quarter-activity-heading"><strong>場次 {index + 1}</strong>{rowReasons[index] && <span className="quarter-skip">{rowReasons[index]}</span>}<button type="button" className="link danger" onClick={() => setActivities((current) => current.filter((_, position) => position !== index))}>刪除</button></div>
            <label>活動日期<input type="date" aria-label={"場次 " + (index + 1) + " 日期"} min={rules.startDate} max={rules.endDate} value={entry.date} onChange={(event) => updateActivity(index, { date: event.target.value })} /></label>
            <div className="time-pair"><label>開始<input type="time" value={entry.startTime} onChange={(event) => updateActivity(index, { startTime: event.target.value })} /></label><label>結束<input type="time" value={entry.endTime} onChange={(event) => updateActivity(index, { endTime: event.target.value })} /></label></div>
            <label>場地<input value={entry.courts} onChange={(event) => updateActivity(index, { courts: event.target.value })} /></label>
            <small>正取 {entry.regularCapacity} 人 · 候補可參加 {entry.standbyCapacity} 人</small>
          </article>)}
          <button type="button" className="secondary" disabled={activities.length >= 32} onClick={() => setActivities((current) => [...current, { date: rules.startDate, startTime: rules.startTime, endTime: rules.endTime, courts: rules.courts, regularCapacity: rules.regularCapacity, standbyCapacity: rules.standbyCapacity }])}>新增建議場次</button>
        </fieldset>
        <p className="form-note">可逐場調整，離開視窗會清除未建立的清單。確認時會再查政府公告，並保存本季計費基準。</p>
      </section>}
      <div className="quarter-actions">
        <button type="button" className="primary" disabled={busy || needsGenerate || !newCount} onClick={confirm}>{saving ? "確認建立中…" : newCount ? "確認並建立 " + newCount + " 場" : "確認並建立"}</button>
      </div>
    {message && <p className="quarter-feedback" role="status">{message}</p>}
    {plans.length > 0 && <details className="quarter-history">
      <summary>已確認季度（{plans.length}）</summary>
      {plans.map((plan) => <details className="quarter-summary" key={plan.id}>
        <summary>{plan.label} · {plan.eventCount ?? plan.activities.length} 場</summary>
        <span>{plan.startDate} ～ {plan.endDate} · 每人基準 NT$ {Number(plan.grossAmount ?? 0).toLocaleString("zh-TW")}</span>
        <ul>{plan.activities.map((entry, index) => <li key={entry.date}>{entry.date} {entry.startTime}–{entry.endTime} · {entry.courts}{plan.eventAmounts?.[index] !== undefined && " · NT$ " + plan.eventAmounts[index]}</li>)}</ul>
      </details>)}
    </details>}
  </div>;
}
