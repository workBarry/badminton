"use client";
import { useRef, useState } from "react";
import type { OfficialClosure } from "@/lib/official-closures";
import { suggestActivities, validateQuarterSchedule, validateQuarterRules, type QuarterPlan, type QuarterRules, type SuggestedActivity } from "@/lib/quarter-planning";

type Result = { planId?: string; eventCount?: number; totalAmount?: number };
type Props = {
  plans: QuarterPlan[];
  saving: boolean;
  confirmPlan: (input: { planId: string; schedule: string }) => Promise<Result | null>;
};
function defaultRules(): QuarterRules {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date());
  const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
  const end = new Date(Date.UTC(year, month - 1 + 3, 0)).toISOString().slice(0, 10);
  return { label: year + " 年 " + month + " 月起季度", startDate: today, endDate: end, weekday: 5, startTime: "19:00", endTime: "21:00", courts: "公司體育館 A 場", regularCapacity: 10, standbyCapacity: 4, excludedDates: [] };
}
export default function QuarterPlanner({ plans, saving, confirmPlan }: Props) {
  const [planId, setPlanId] = useState("");
  const pendingPlanId = useRef<string | null>(null);
  const [rules, setRules] = useState<QuarterRules>(defaultRules);
  const [activities, setActivities] = useState<SuggestedActivity[]>([]);
  const [officialClosures, setOfficialClosures] = useState<OfficialClosure[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState("");
  const [needsGenerate, setNeedsGenerate] = useState(true);
  const [message, setMessage] = useState("");
  const selectedPlan = plans.find((plan) => plan.id === planId);
  const busy = saving || generating;
  const closureNames = new Map(officialClosures?.map((closure) => [closure.date, closure.name]));
  const choosePlan = (id: string) => {
    if (!selectedPlan && activities.length && !window.confirm("切換季度會清除目前的建議場次，確定繼續？")) return;
    pendingPlanId.current = null;
    setPlanId(id);
    setRules(defaultRules());
    setActivities([]);
    setOfficialClosures(null);
    setGenerationError("");
    setNeedsGenerate(true); setMessage("");
  };
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
      const next = suggestActivities(values);
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
    if (busy || needsGenerate || !activities.length) return;
    setMessage("");
    try {
      validateQuarterSchedule(rules, activities);
      if (!window.confirm("確認建立 " + activities.length + " 場正式活動？場次與各場費率會保存為本季計費基準，後續增減須保留帳單調整紀錄。")) return;
      pendingPlanId.current ??= crypto.randomUUID();
      const result = await confirmPlan({ planId: pendingPlanId.current, schedule: JSON.stringify({ rules, activities }) });
      if (result?.planId) {
        setPlanId(result.planId);
        setActivities([]);
        setNeedsGenerate(true);
        setMessage("已確認 " + result.eventCount + " 場；每位社員本季基準 NT$" + Number(result.totalAmount).toLocaleString("zh-TW") + "。請至費用管理建立季度帳單。");
      }
    } catch (error) {
      setMessage(error instanceof TypeError ? "連線中斷，請重試確認建立。" : error instanceof Error ? error.message : "確認建立失敗");
    }
  };
  return <div className="quarter-planner">
    <label className="quarter-select">季度計畫<select value={planId} onChange={(event) => choosePlan(event.target.value)} disabled={busy}>
      <option value="">新增季度規劃</option>
      {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.label} · 已確認</option>)}
    </select></label>
    {selectedPlan ? <section className="quarter-summary">
      <strong>{selectedPlan.label} · 已確認 {selectedPlan.eventCount} 場</strong>
      <span>{selectedPlan.startDate} ～ {selectedPlan.endDate}</span>
      <span>社員本季計費基準 NT$ {Number(selectedPlan.grossAmount).toLocaleString("zh-TW")}／人</span>
      <small>場次與費率已保存；後續活動增減會保留原始基準及調整紀錄。</small>
      {selectedPlan.activities.map((entry, index) => <span key={entry.date}>{entry.date} {entry.startTime}–{entry.endTime} · {entry.courts} · NT$ {selectedPlan.eventAmounts?.[index]}</span>)}
    </section> : <>
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
        <header><strong>建議活動 · {activities.length} 場</strong><span>尚未發布，確認後才會出現在月曆</span></header>
        {activities.length === 0 && <p className="form-note">請新增至少一場活動，才能確認建立。</p>}
        {!!rules.excludedDates.length && <details className="quarter-exclusions">
          <summary>政府公告排除日期 · {rules.excludedDates.length} 天</summary>
          <ul>{rules.excludedDates.map((date) => <li key={date}>{date}{closureNames.has(date) && ` · ${closureNames.get(date)}`}</li>)}</ul>
        </details>}
        {officialClosures?.length === 0 && <p className="form-note">此季度範圍目前沒有適用的政府公告排除日期。</p>}
        <fieldset disabled={busy}>
          {activities.map((entry, index) => <article key={index} className="quarter-activity">
            <div className="quarter-activity-heading"><strong>場次 {index + 1}</strong><button type="button" className="link danger" onClick={() => setActivities((current) => current.filter((_, position) => position !== index))}>刪除</button></div>
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
        <button type="button" className="primary" disabled={busy || needsGenerate || !activities.length} onClick={confirm}>{saving ? "確認建立中…" : "確認並建立 " + activities.length + " 場"}</button>
      </div>
    </>}
    {message && <p className="quarter-feedback" role="status">{message}</p>}
  </div>;
}
