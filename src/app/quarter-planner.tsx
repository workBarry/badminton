"use client";
import { useState } from "react";
import { suggestActivities, validateQuarterDraft, type QuarterPlan, type QuarterRules, type SuggestedActivity } from "@/lib/quarter-planning";

type Result = { planId?: string; revision?: number; eventCount?: number; totalAmount?: number };
type Props = {
  plans: QuarterPlan[];
  saving: boolean;
  perform: (action: string, input: Record<string, string>) => Promise<Result | null>;
};
function defaultRules(): QuarterRules {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date());
  const year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
  const end = new Date(Date.UTC(year, month - 1 + 3, 0)).toISOString().slice(0, 10);
  return { label: year + " 年 " + month + " 月起季度", startDate: today, endDate: end, weekday: 5, startTime: "19:00", endTime: "21:00", courts: "公司體育館 A 場", regularCapacity: 10, standbyCapacity: 4, excludedDates: [], excludeWeekends: false };
}
export default function QuarterPlanner({ plans, saving, perform }: Props) {
  const [planId, setPlanId] = useState("");
  const [revision, setRevision] = useState(0);
  const [rules, setRules] = useState<QuarterRules>(defaultRules);
  const [activities, setActivities] = useState<SuggestedActivity[]>([]);
  const [excludedText, setExcludedText] = useState("");
  const [dirty, setDirty] = useState(true);
  const [needsGenerate, setNeedsGenerate] = useState(true);
  const [message, setMessage] = useState("");
  const selectedPlan = plans.find((plan) => plan.id === planId);
  const confirmed = selectedPlan?.status === "CONFIRMED";
  const choosePlan = (id: string) => {
    if (dirty && activities.length && !window.confirm("尚有未儲存的修改，確定切換季度？")) return;
    const plan = plans.find((entry) => entry.id === id);
    setPlanId(id); setRevision(plan?.revision ?? 0);
    setRules(plan ?? defaultRules()); setActivities(plan?.activities ?? []);
    setExcludedText(plan?.excludedDates.join("\n") ?? "");
    setDirty(!plan); setNeedsGenerate(!plan); setMessage("");
  };
  const updateRules = <K extends keyof QuarterRules>(key: K, value: QuarterRules[K]) => {
    setRules((current) => ({ ...current, [key]: value }));
    setDirty(true); setNeedsGenerate(true); setMessage("");
  };
  const draftRules = () => ({ ...rules, excludedDates: excludedText.split(/[\s,，、]+/).map((date) => date.trim()).filter(Boolean) });
  const generate = () => {
    try {
      const values = draftRules();
      const next = suggestActivities(values);
      if (activities.length && !window.confirm("重新產生會取代目前建議清單，包含手動調整，確定繼續？")) return;
      setRules(values); setActivities(next); setNeedsGenerate(false); setDirty(true);
      setMessage("已產生 " + next.length + " 場建議活動，尚未建立正式活動。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "產生失敗"); }
  };
  const updateActivity = (index: number, value: Partial<SuggestedActivity>) => {
    setActivities((current) => current.map((entry, position) => position === index ? { ...entry, ...value } : entry));
    setDirty(true);
  };
  const save = async () => {
    try {
      const values = draftRules();
      validateQuarterDraft(values, activities);
      if (needsGenerate) throw new Error("規則已修改，請先重新產生建議活動");
      const result = await perform("saveQuarterDraft", { planId, revision: String(revision), draft: JSON.stringify({ rules: values, activities }) });
      if (result?.planId) { setPlanId(result.planId); setRevision(result.revision ?? 1); setDirty(false); setMessage("草稿已儲存，可繼續調整或確認建立。"); }
    } catch (error) { setMessage(error instanceof Error ? error.message : "儲存失敗"); }
  };
  const confirm = async () => {
    if (!window.confirm("確認建立 " + activities.length + " 場正式活動？場次與各場費率會保存為本季計費基準，後續增減須保留帳單調整紀錄。")) return;
    const result = await perform("confirmQuarterPlan", { planId, revision: String(revision) });
    if (result) setMessage("已確認 " + result.eventCount + " 場；每位社員本季基準 NT$" + Number(result.totalAmount).toLocaleString("zh-TW") + "。請至費用管理建立季度帳單。");
  };
  return <div className="quarter-planner">
    <label className="quarter-select">季度計畫<select value={planId} onChange={(event) => choosePlan(event.target.value)} disabled={saving}>
      <option value="">新增季度草稿</option>
      {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.label} · {plan.status === "CONFIRMED" ? "已確認" : "草稿"}</option>)}
    </select></label>
    {confirmed ? <section className="quarter-summary">
      <strong>{selectedPlan.label} · 已確認 {selectedPlan.eventCount} 場</strong>
      <span>{selectedPlan.startDate} ～ {selectedPlan.endDate}</span>
      <span>社員本季計費基準 NT$ {Number(selectedPlan.grossAmount).toLocaleString("zh-TW")}／人</span>
      <small>場次與費率已保存；後續活動增減會保留原始基準及調整紀錄。</small>
      {selectedPlan.activities.map((entry, index) => <span key={entry.date}>{entry.date} {entry.startTime}–{entry.endTime} · {entry.courts} · NT$ {selectedPlan.eventAmounts?.[index]}</span>)}
    </section> : <>
      <form className="manager-form" onSubmit={(event) => { event.preventDefault(); generate(); }}>
        <fieldset disabled={saving}>
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
          <label className="quarter-check"><input type="checkbox" checked={rules.excludeWeekends} onChange={(event) => updateRules("excludeWeekends", event.target.checked)} />排除星期六、日</label>
          <label>指定假日／公司休假排除日期<textarea rows={3} value={excludedText} placeholder="YYYY-MM-DD，每行一個日期" onChange={(event) => { setExcludedText(event.target.value); setDirty(true); setNeedsGenerate(true); }} /><small>依這裡輸入的日期排除，尚未串接國定假日行事曆。</small></label>
          <button className="secondary" type="submit">{activities.length ? "重新產生建議活動" : "產生建議活動"}</button>
        </fieldset>
      </form>
      {!needsGenerate && <section className="quarter-suggestions">
        <header><strong>建議活動 · {activities.length} 場</strong><span>尚未發布，確認後才會出現在月曆</span></header>
        <fieldset disabled={saving}>
          {activities.map((entry, index) => <article key={index} className="quarter-activity">
            <div className="quarter-activity-heading"><strong>場次 {index + 1}</strong><button type="button" className="link danger" onClick={() => { setActivities((current) => current.filter((_, position) => position !== index)); setDirty(true); }}>刪除</button></div>
            <label>活動日期<input type="date" aria-label={"場次 " + (index + 1) + " 日期"} min={rules.startDate} max={rules.endDate} value={entry.date} onChange={(event) => updateActivity(index, { date: event.target.value })} /></label>
            <div className="time-pair"><label>開始<input type="time" value={entry.startTime} onChange={(event) => updateActivity(index, { startTime: event.target.value })} /></label><label>結束<input type="time" value={entry.endTime} onChange={(event) => updateActivity(index, { endTime: event.target.value })} /></label></div>
            <label>場地<input value={entry.courts} onChange={(event) => updateActivity(index, { courts: event.target.value })} /></label>
            <small>正取 {entry.regularCapacity} 人 · 候補可參加 {entry.standbyCapacity} 人</small>
          </article>)}
          <button type="button" className="secondary" disabled={activities.length >= 32} onClick={() => { setActivities((current) => [...current, { date: rules.startDate, startTime: rules.startTime, endTime: rules.endTime, courts: rules.courts, regularCapacity: rules.regularCapacity, standbyCapacity: rules.standbyCapacity }]); setDirty(true); }}>新增建議場次</button>
        </fieldset>
        <p className="form-note">可手動移到其他星期或假日。確認 {activities.length} 場後，這個場數即為本季原始計費基準；費率依各場活動日期於確認時保存。</p>
      </section>}
      <div className="quarter-actions">
        <button type="button" className="secondary" disabled={saving || needsGenerate || !dirty} onClick={save}>儲存草稿</button>
        <button type="button" className="primary" disabled={saving || dirty || needsGenerate || !planId || !activities.length} onClick={confirm}>{saving ? "處理中…" : "確認並建立 " + activities.length + " 場"}</button>
      </div>
    </>}
    {message && <p className="quarter-feedback" role="status">{message}</p>}
  </div>;
}
