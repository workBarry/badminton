"use client";
import { useRef, useState } from "react";
import type { OfficialClosure } from "@/lib/official-closures";
import { suggestActivities, validateQuarterDateRange, validateQuarterSchedule, validateQuarterRules, type QuarterBillingPeriod, type QuarterPeriodInput, type QuarterPeriodResult, type QuarterPlan, type QuarterRules, type SuggestedActivity } from "@/lib/quarter-planning";

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
      if (!window.confirm("預計建立 " + newCount + " 場正式活動" + (skipCount ? "，跳過 " + skipCount + " 筆重複場次" : "") + "。送出時會再次確認日期，這一步不會建立帳單。確定建立嗎？")) return;
      pendingPlanId.current ??= crypto.randomUUID();
      const result = await confirmPlan({ planId: pendingPlanId.current, schedule: JSON.stringify({ rules, activities }) });
      if (typeof result?.eventCount === "number") {
        const skipped = result.skippedDates?.length ? "已跳過： " + result.skippedDates.join("、") + "。" : "";
        if (result.eventCount === 0) {
          pendingPlanId.current = null;
          setMessage("這些日期已有活動，未建立新場次。" + skipped);
        } else {
          pendingPlanId.current = null;
          setActivities([]);
          setNeedsGenerate(true);
          setMessage("已建立 " + result.eventCount + " 場，未建立帳單。" + skipped);
        }
      }
    } catch (error) {
      setMessage(error instanceof TypeError ? "連線中斷，請重試確認建立。" : error instanceof Error ? error.message : "確認建立失敗");
    }
  };
  return <div className="quarter-planner">
      <form className="manager-form" onSubmit={(event) => { event.preventDefault(); void generate(); }}>
        <fieldset disabled={busy}>
          <label>排程名稱<input value={rules.label} maxLength={60} required onChange={(event) => updateRules("label", event.target.value)} /></label>
          <div className="time-pair">
            <label>排程開始日期<input type="date" value={rules.startDate} required onChange={(event) => updateRules("startDate", event.target.value)} /></label>
            <label>排程結束日期<input type="date" value={rules.endDate} required onChange={(event) => updateRules("endDate", event.target.value)} /></label>
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
        <header><strong>預計新增 {newCount} 場{skipCount ? " · 跳過 " + skipCount + " 筆" : ""}</strong><span>同日已有羽球活動就跳過；批次排程不會開單。</span></header>
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
        <p className="form-note">可逐場調整，離開視窗會清除未建立的清單。確認時會再查政府公告。社費另由「費用管理 → 季度社費」選擇活動。</p>
      </section>}
      <div className="quarter-actions">
        <button type="button" className="primary" disabled={busy || needsGenerate || !newCount} onClick={confirm}>{saving ? "確認建立中…" : newCount ? "確認並建立 " + newCount + " 場" : "確認並建立"}</button>
      </div>
    {message && <p className="quarter-feedback" role="status">{message}</p>}
    {plans.length > 0 && <details className="quarter-history">
      <summary>已建立批次（{plans.length}）</summary>
      {plans.map((plan) => <details className="quarter-summary" key={plan.id}>
        <summary>{plan.label} · {plan.eventCount ?? plan.activities.length} 場</summary>
        <span>{plan.startDate} ～ {plan.endDate}</span>
        <ul>{plan.activities.map((entry) => <li key={entry.date}>{entry.date} {entry.startTime}–{entry.endTime} · {entry.courts}</li>)}</ul>
      </details>)}
    </details>}
  </div>;
}

type QuarterPeriodEvent = { id: string; startsAt?: string; endsAt?: string; courts: string; quarterEligible?: boolean };

function defaultBillingPeriod() {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(new Date());
  const year = Number(today.slice(0, 4));
  const quarter = Math.floor((Number(today.slice(5, 7)) - 1) / 3);
  return {
    label: `${year} 年第 ${quarter + 1} 季社費`,
    startDate: new Date(Date.UTC(year, quarter * 3, 1)).toISOString().slice(0, 10),
    endDate: new Date(Date.UTC(year, quarter * 3 + 3, 0)).toISOString().slice(0, 10),
  };
}

export function QuarterPeriodCreator({ events, saving, initialPeriod, onCreate, onCreated }: {
  events: QuarterPeriodEvent[];
  saving: boolean;
  initialPeriod?: QuarterBillingPeriod;
  onCreate: (input: QuarterPeriodInput) => Promise<QuarterPeriodResult | null>;
  onCreated?: (id: string) => void;
}) {
  const [period, setPeriod] = useState(() => initialPeriod
    ? { label: initialPeriod.label, startDate: initialPeriod.startDate, endDate: initialPeriod.endDate }
    : defaultBillingPeriod());
  const [selected, setSelected] = useState<string[]>(() => initialPeriod?.eventIds ?? []);
  const [error, setError] = useState("");
  const pendingId = useRef<string | null>(null);
  const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" });
  const timeFormat = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const previouslySelected = new Set(initialPeriod?.eventIds);
  const candidates = events
    .flatMap((event) => {
      const start = new Date(event.startsAt ?? "");
      if ((!event.quarterEligible && !previouslySelected.has(event.id)) || !Number.isFinite(start.getTime())) return [];
      const date = dateFormat.format(start);
      return date >= period.startDate && date <= period.endDate ? [{ ...event, date, start }] : [];
    }).sort((a, b) => a.start.getTime() - b.start.getTime());
  const available = new Set(candidates.map((event) => event.id));
  const selectedIds = selected.filter((id) => available.has(id));
  const update = (key: keyof typeof period, value: string) => {
    setPeriod((current) => ({ ...current, [key]: value }));
    if (key !== "label") setSelected([]);
    setError("");
    pendingId.current = null;
  };
  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => checked ? [...current, id] : current.filter((entry) => entry !== id));
    setError("");
    pendingId.current = null;
  };
  return (
    <form className="manager-form" onSubmit={async (event) => {
      event.preventDefault();
      if (saving || !selectedIds.length) return;
      setError("");
      try {
        validateQuarterDateRange(period.startDate, period.endDate);
        pendingId.current ??= crypto.randomUUID();
        const result = await onCreate({ ...period, periodId: initialPeriod?.id ?? pendingId.current, expectedRevision: initialPeriod?.revision, eventIds: JSON.stringify(selectedIds) });
        if (result?.eventCount) {
          pendingId.current = null;
          if (!initialPeriod) setSelected([]);
          onCreated?.(result.periodId);
        } else setError("未建立季度社費期間，請重試。");
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "未建立季度社費期間，請重試。");
      }
    }}>
      <fieldset disabled={saving}>
        <label>期間名稱<input required maxLength={60} value={period.label} onChange={(event) => update("label", event.target.value)} /></label>
        <div className="time-pair">
          <label>開始日期<input required type="date" value={period.startDate} onChange={(event) => update("startDate", event.target.value)} /></label>
          <label>結束日期<input required type="date" value={period.endDate} onChange={(event) => update("endDate", event.target.value)} /></label>
        </div>
        <p className="form-note">選擇本期要計費的羽球場次。已取消、免費、另收加場費或已納入其他季度者不列入。儲存期間不會開單。</p>
        {candidates.length ? <div className="quarter-invoice-review" aria-label="可納入的活動">
          <strong>選擇活動 · 已選 {selectedIds.length} 場</strong>
          <ul>{candidates.map((event) => <li key={event.id}>
            <label><input type="checkbox" checked={selectedIds.includes(event.id)} disabled={selectedIds.length >= 32 && !selectedIds.includes(event.id)} onChange={(change) => toggle(event.id, change.target.checked)} /> {event.date} {timeFormat.format(event.start)} · {event.courts}</label>
          </li>)}</ul>
        </div> : <p className="form-note" role="status">這個日期範圍目前沒有可納入的活動。</p>}
        {error && <p className="guest-settlement-error" role="alert">{error}</p>}
        <button className="primary" disabled={!selectedIds.length}>{saving ? "儲存中…" : initialPeriod ? "儲存草稿變更" : "儲存期間"}</button>
      </fieldset>
    </form>
  );
}
