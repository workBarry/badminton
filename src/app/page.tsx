"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

type Role = "admin" | "member";
type Tab = "總覽" | "活動" | "公告" | "社員名單" | "費用管理" | "個人資訊";
type ActivityManagerTab = "single" | "weekly" | "rest";
type Person = { id: string; name: string; department?: string; role: Role; member: boolean };
type Booking = { memberId: string; name: string; kind: "社員" | "非社員"; rank: "正取" | "候補"; transferred?: boolean };
type NewsItem = { title: string; content: string; date: string; linkUrl?: string };
type Invoice = { id: string; member_id: string; memberName: string; type: string; amount: number; status: string; period_label?: string };
type Viewer = {
  id: string;
  name: string;
  department: string | null;
  role: "ADMIN" | "MEMBER";
  membershipStatus: string;
  accountType: "guest" | "recoverable" | "verified" | "unclaimed";
  hasRecoveryCode: boolean;
  hasPasskey: boolean;
};
type ActionResult = { recoveryCode?: string; claimCode?: string; recipientName?: string };
type DeviceAccount = { id: string; name: string; role: "ADMIN" | "MEMBER"; membershipStatus: string };
type ClubEvent = {
  id: string;
  startsAt?: string;
  endsAt?: string;
  date: string;
  weekday: string;
  time: string;
  courts: string;
  regular: number;
  wait: number;
  bookings: Booking[];
};

type ApiState = {
  viewer: Viewer | null;
  members: { id: string; name: string; department?: string; role: string; membershipStatus: string }[];
  events: { id: string; starts_at: string; ends_at: string; courts: string; regular_capacity: number; standby_capacity: number; bookings: { memberId: string; name: string; kind: string; status: string }[] }[];
  announcements: { title: string; content: string; publishedAt: string; linkUrl?: string }[];
  invoices: Invoice[];
  quickAccounts: DeviceAccount[];
  actionResult?: ActionResult;
};

const people: Person[] = [
  { id: "seed-admin-1", name: "王小芸", department: "人資", role: "admin", member: true },
  { id: "seed-admin-2", name: "陳韋廷", department: "工程", role: "admin", member: true },
  { id: "seed-member-1", name: "林子晴", department: "設計", role: "member", member: true },
  { id: "seed-member-2", name: "周昱安", department: "業務", role: "member", member: true },
  { id: "seed-guest-1", name: "許庭維", department: "財務", role: "member", member: false },
  { id: "seed-member-3", name: "徐佩珊", department: "產品", role: "member", member: true },
  { id: "seed-member-4", name: "郭明軒", department: "工程", role: "member", member: true },
];

const eventsSeed: ClubEvent[] = [
  {
    id: "seed-1",
    date: "9月4日",
    weekday: "週五",
    time: "19:00 – 21:00",
    courts: "公司體育館 A 場",
    regular: 10,
    wait: 4,
    bookings: [
      { memberId: "seed-admin-1", name: "王小芸", kind: "社員", rank: "正取" },
      { memberId: "seed-admin-2", name: "陳韋廷", kind: "社員", rank: "正取" },
      { memberId: "seed-member-1", name: "林子晴", kind: "社員", rank: "正取" },
      { memberId: "seed-member-2", name: "周昱安", kind: "社員", rank: "正取" },
      { memberId: "seed-member-3", name: "徐佩珊", kind: "社員", rank: "正取" },
      { memberId: "seed-member-4", name: "郭明軒", kind: "社員", rank: "正取" },
      { memberId: "seed-guest-1", name: "許庭維", kind: "非社員", rank: "候補" },
    ],
  },
  {
    id: "seed-2",
    date: "9 月 11 日",
    weekday: "週五",
    time: "19:00 – 21:00",
    courts: "公司體育館 A 場",
    regular: 10,
    wait: 4,
    bookings: [
      { memberId: "seed-admin-1", name: "王小芸", kind: "社員", rank: "正取" },
      { memberId: "seed-admin-2", name: "陳韋廷", kind: "社員", rank: "正取" },
    ],
  },
  {
    id: "seed-3",
    date: "9 月 18 日",
    weekday: "週五",
    time: "19:00 – 21:00",
    courts: "公司體育館 A、B 場",
    regular: 20,
    wait: 8,
    bookings: [],
  },
];

const initialNews: NewsItem[] = [
  {
    title: "九月活動時段與場地",
    date: "2026.08.29",
    content: "九月固定於週五 19:00 開打；9/18 將使用 A、B 兩場。",
  },
  {
    title: "第三季社員費預收通知",
    date: "2026.08.25",
    content: "本季共 12 次活動，社員預收費用為 NT$1,800。請於 9/6 前完成轉帳。",
  },
];

function Badge({
  children,
  tone = "gray",
}: {
  children: ReactNode;
  tone?: "green" | "orange" | "blue" | "gray";
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export default function Home() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [input, setInput] = useState("");
  const [authSaving, setAuthSaving] = useState(false);
  const [passkeySaving, setPasskeySaving] = useState(false);
  const [recoverySaving, setRecoverySaving] = useState(false);
  const [quickAccounts, setQuickAccounts] = useState<DeviceAccount[]>([]);
  const [codeNotice, setCodeNotice] = useState<{ title: string; body: string; code: string } | null>(null);
  const [tab, setTab] = useState<Tab>("總覽");
  const [events, setEvents] = useState<ClubEvent[]>(eventsSeed);
  const [news, setNews] = useState(initialNews);
  const [members, setMembers] = useState<Person[]>(people);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [transfer, setTransfer] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [editingEvent, setEditingEvent] = useState<ClubEvent | null>(null);
  const [managerTab, setManagerTab] = useState<ActivityManagerTab>("single");
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerSaving, setManagerSaving] = useState(false);
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  const [announcementSaving, setAnnouncementSaving] = useState(false);

  useEffect(() => {
    if (!managerOpen && !announcementOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setManagerOpen(false);
        setAnnouncementOpen(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [managerOpen, announcementOpen]);

  const applyState = useCallback((state: ApiState) => {
    setViewer(state.viewer);
    setQuickAccounts(state.quickAccounts ?? []);
    setMembers(state.members.map((member) => ({ id: member.id, name: member.name, department: member.department, role: member.role === "ADMIN" ? "admin" : "member", member: member.membershipStatus === "MEMBER" })));
    setEvents(state.events.map((item) => {
      const startsAt = new Date(item.starts_at);
      const endsAt = new Date(item.ends_at);
      const date = `${startsAt.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric" })} ${startsAt.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", day: "numeric" })}`;
      const time = `${startsAt.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false })} – ${endsAt.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false })}`;
      return { id: item.id, startsAt: item.starts_at, endsAt: item.ends_at, date, weekday: startsAt.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", weekday: "short" }), time, courts: item.courts, regular: item.regular_capacity, wait: item.standby_capacity, bookings: item.bookings.map((booking) => ({ memberId: booking.memberId, name: booking.name, kind: booking.kind === "MEMBER" ? "社員" : "非社員", rank: booking.status === "REGULAR" ? "正取" : "候補" })) };
    }));
    setNews(state.announcements.map((item) => ({
      title: item.title,
      content: item.content,
      date: new Date(item.publishedAt).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).replaceAll("/", "."),
      linkUrl: item.linkUrl,
    })));
    setInvoices(state.invoices ?? []);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/club", { cache: "no-store" });
      if (response.ok) applyState(await response.json() as ApiState);
    } finally {
      setSessionReady(true);
    }
  }, [applyState]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const execute = async (action: string, data: Record<string, string>) => {
    const response = await fetch("/api/club", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...data }) });
    const payload = await response.json() as ApiState & { error?: string };
    if (!response.ok) {
      if (response.status === 401) setViewer(null);
      window.alert(payload.error ?? "資料庫操作失敗");
      return null;
    }
    applyState(payload);
    return payload;
  };

  const passkeyRequest = async <T,>(action: string, response?: RegistrationResponseJSON | AuthenticationResponseJSON) => {
    const request = await fetch("/api/passkey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...(response ? { response } : {}) }),
    });
    const payload = await request.json() as T & { error?: string };
    if (!request.ok) throw new Error(payload.error ?? "Passkey 操作失敗");
    return payload;
  };

  const user = useMemo<Person>(
    () => viewer
      ? { id: viewer.id, name: viewer.name, department: viewer.department ?? undefined, role: viewer.role === "ADMIN" ? "admin" : "member", member: viewer.membershipStatus === "MEMBER" }
      : { id: "", name: "", role: "member", member: false },
    [viewer],
  );
  const event = events.find((item) => !item.endsAt || new Date(item.endsAt) > new Date());
  const booking = event?.bookings.find((item) => item.memberId === viewer?.id);
  const invoice = invoices.find((item) => item.member_id === viewer?.id && item.status !== "VOID");
  const createGuest = async (candidate: string) => {
    const clean = candidate.trim();
    if (!clean) return;
    setAuthSaving(true);
    try {
      await execute("createGuest", { name: clean });
      setInput("");
    } finally {
      setAuthSaving(false);
    }
  };
  const recover = async (candidate: string, code: string) => {
    setAuthSaving(true);
    try {
      const payload = await execute("recover", { name: candidate.trim(), code: code.trim() });
      if (payload?.actionResult?.recoveryCode) {
        setCodeNotice({ title: "請保存新的復原碼", body: "舊的認領碼或復原碼已失效。這組新碼只會顯示一次，請放在安全的地方。", code: payload.actionResult.recoveryCode });
      }
    } finally {
      setAuthSaving(false);
    }
  };
  const quickLogin = async (userId: string) => {
    setAuthSaving(true);
    try {
      await execute("quickLogin", { userId });
    } finally {
      setAuthSaving(false);
    }
  };
  const loginWithPasskey = async () => {
    if (typeof PublicKeyCredential === "undefined") {
      window.alert("這個瀏覽器或裝置不支援 Passkey");
      return;
    }
    setPasskeySaving(true);
    try {
      const start = await passkeyRequest<{ options: PublicKeyCredentialRequestOptionsJSON }>("authenticationOptions");
      const credential = await startAuthentication({ optionsJSON: start.options });
      const state = await passkeyRequest<ApiState>("verifyAuthentication", credential);
      applyState(state);
    } catch (error) {
      window.alert(error instanceof Error && error.name === "NotAllowedError" ? "已取消 Passkey 登入" : error instanceof Error ? error.message : "Passkey 登入失敗");
    } finally {
      setPasskeySaving(false);
    }
  };
  const registerPasskey = async () => {
    if (typeof PublicKeyCredential === "undefined") {
      window.alert("這個瀏覽器或裝置不支援 Passkey");
      return;
    }
    setPasskeySaving(true);
    try {
      const start = await passkeyRequest<{ options: PublicKeyCredentialCreationOptionsJSON }>("registrationOptions");
      const credential = await startRegistration({ optionsJSON: start.options });
      const state = await passkeyRequest<ApiState>("verifyRegistration", credential);
      applyState(state);
      window.alert("Passkey 已建立，之後可在其他支援的裝置快速登入");
    } catch (error) {
      window.alert(error instanceof Error && error.name === "NotAllowedError" ? "已取消建立 Passkey" : error instanceof Error ? error.message : "建立 Passkey 失敗");
    } finally {
      setPasskeySaving(false);
    }
  };
  const logout = async () => { await execute("logout", {}); setTab("總覽"); };
  const makeRecoveryCode = async (replaceExisting: boolean) => {
    if (replaceExisting && !window.confirm("重新產生後，原本的復原碼會立即失效。確定要繼續嗎？")) return;
    setRecoverySaving(true);
    try {
      const payload = await execute("createRecoveryCode", {});
      if (payload?.actionResult?.recoveryCode) {
        setCodeNotice({
          title: replaceExisting ? "請保存新的復原碼" : "請保存你的復原碼",
          body: replaceExisting
            ? "原本的復原碼已失效。這組新碼只會顯示一次，請立即複製並放在安全的地方。"
            : "這組碼只會顯示一次。清除瀏覽器資料或更換裝置時，可用姓名與此碼取回帳號。",
          code: payload.actionResult.recoveryCode,
        });
      }
    } finally {
      setRecoverySaving(false);
    }
  };
  const issueClaimCode = async (person: Person) => {
    const payload = await execute("issueClaimCode", { memberId: person.id });
    if (payload?.actionResult?.claimCode) {
      setCodeNotice({
        title: `請將認領碼交給${person.name}`,
        body: "使用者可在登入頁選擇「取回既有帳號」，輸入姓名與此碼。代碼只會顯示一次，請透過可信任的方式交付。",
        code: payload.actionResult.claimCode,
      });
    }
  };
  const join = (eventId: string) => { if (viewer) void execute("join", { eventId }); };
  const cancel = (eventId: string) => { if (viewer) void execute("cancel", { eventId }); };
  const submitTransfer = async () => {
    const clean = recipient.trim();
    if (!clean || !viewer || !event) return;
    const payload = await execute("transfer", { eventId: event.id, recipient: clean });
    if (payload) {
      setRecipient("");
      setTransfer(false);
      if (payload.actionResult?.claimCode) {
        setCodeNotice({ title: "請將認領碼交給接手者", body: `${payload.actionResult.recipientName ?? clean} 可在登入頁用姓名與這組認領碼開啟帳號。此碼只會顯示一次。`, code: payload.actionResult.claimCode });
      }
    }
  };
  const publish = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    const element = form.currentTarget;
    const data = new FormData(element);
    const title = String(data.get("title") ?? "").trim();
    const content = String(data.get("content") ?? "").trim();
    const linkUrl = String(data.get("linkUrl") ?? "").trim();
    if (!title || !content) return;
    if (linkUrl) {
      try {
        const url = new URL(linkUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
      } catch {
        window.alert("外部連結必須是完整的 http:// 或 https:// 網址");
        return;
      }
    }
    setAnnouncementSaving(true);
    try {
      if (await execute("publish", { title, content, linkUrl })) {
        element.reset();
        setAnnouncementOpen(false);
      }
    } finally {
      setAnnouncementSaving(false);
    }
  };
  const eventTimes = (data: FormData) => {
    const date = String(data.get("date") ?? "");
    const start = String(data.get("start") ?? "");
    const end = String(data.get("end") ?? "");
    const startsAt = new Date(`${date}T${start}:00+08:00`);
    const endsAt = new Date(`${date}T${end}:00+08:00`);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      window.alert("請填寫正確的活動日期與時間");
      return null;
    }
    if (endsAt <= startsAt) {
      window.alert("結束時間必須晚於開始時間");
      return null;
    }
    return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
  };
  const createEvent = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    const element = form.currentTarget;
    const data = new FormData(element);
    const times = eventTimes(data);
    if (!times) return;
    setManagerSaving(true);
    try {
      if (await execute("createEvent", { ...times, courts: String(data.get("courts")), regularCapacity: String(data.get("regular")), standbyCapacity: String(data.get("standby")) })) {
        element.reset();
        setManagerOpen(false);
      }
    } finally {
      setManagerSaving(false);
    }
  };
  const updateEvent = (form: FormEvent<HTMLFormElement>) => { form.preventDefault(); if (!editingEvent) return; const data = new FormData(form.currentTarget); void execute("updateEvent", { eventId: editingEvent.id, startsAt: new Date(`${data.get("date")}T${data.get("start")}:00+08:00`).toISOString(), endsAt: new Date(`${data.get("date")}T${data.get("end")}:00+08:00`).toISOString(), courts: String(data.get("courts")), regularCapacity: String(data.get("regular")), standbyCapacity: String(data.get("standby")) }); setEditingEvent(null); };
  const addRestDay = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    const element = form.currentTarget;
    const data = new FormData(element);
    setManagerSaving(true);
    try {
      if (await execute("addRestDay", { date: new Date(`${data.get("date")}T00:00:00.000Z`).toISOString(), label: String(data.get("label")).trim() })) {
        element.reset();
        setManagerOpen(false);
      }
    } finally {
      setManagerSaving(false);
    }
  };
  const generateWeeklyEvents = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    const element = form.currentTarget;
    const data = new FormData(element);
    const start = String(data.get("start") ?? "");
    const end = String(data.get("end") ?? "");
    if (end <= start) {
      window.alert("結束時間必須晚於開始時間");
      return;
    }
    setManagerSaving(true);
    try {
      if (await execute("generateWeeklyEvents", { startDate: String(data.get("startDate")), weeks: String(data.get("weeks")), startTime: start, endTime: end, courts: String(data.get("courts")), regularCapacity: String(data.get("regular")), standbyCapacity: String(data.get("standby")) })) {
        element.reset();
        setManagerOpen(false);
      }
    } finally {
      setManagerSaving(false);
    }
  };

  if (!sessionReady) return <main className="login"><section className="session-loading"><div className="login-logo">羽</div><h1>正在確認此裝置…</h1><span>請稍候，系統正在安全地恢復登入狀態。</span></section></main>;
  if (!viewer) return <Login input={input} setInput={setInput} createGuest={createGuest} recover={recover} passkeyLogin={loginWithPasskey} quickAccounts={quickAccounts} quickLogin={quickLogin} saving={authSaving || passkeySaving} />;
  const isAdmin = user.role === "admin";
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <b>羽</b>
          <span>
            <strong>球友會</strong>
            <small>BADMINTON CLUB</small>
          </span>
        </div>
        <nav>
          {(["總覽", "活動", "公告", "社員名單", "費用管理", "個人資訊"] as Tab[]).map((item, index) => (
            <button key={item} className={tab === item ? "nav-active" : ""} onClick={() => setTab(item)}>
              <i>{["⌂", "◷", "✦", "♙", "◫", "●"][index]}</i>
              {item}
            </button>
          ))}
        </nav>
        <div className="profile">
          <b>{user.name[0]}</b>
          <span>
            <strong>{user.name}</strong>
            <small>{isAdmin ? "幹部管理者" : user.member ? "社員" : "非社員"}</small>
          </span>
          <button onClick={() => void logout()} title="登出">
            ↪
          </button>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p>2026 · SEPTEMBER</p>
            <h1>{tab}</h1>
          </div>
          <div className="header-actions">
            <button className="bell">
              🔔<em>2</em>
            </button>
            {isAdmin && (tab === "活動" || tab === "公告") && (
              <button
                className="primary small"
                onClick={() => {
                  if (tab === "活動") {
                    setManagerTab("single");
                    setManagerOpen(true);
                  } else {
                    setTab("公告");
                    setAnnouncementOpen(true);
                  }
                }}
              >
                {tab === "活動" ? "＋ 新增活動" : "＋ 發布公告"}
              </button>
            )}
          </div>
        </header>
        {tab === "總覽" && (
          <Overview
            event={event}
            booking={booking}
            user={user}
            invoice={invoice}
            join={() => event && join(event.id)}
            cancel={() => event && cancel(event.id)}
            transfer={() => setTransfer(true)}
            showEvents={() => setTab("活動")}
            showBilling={() => setTab("費用管理")}
          />
        )}
        {tab === "活動" && (
          <Events
            list={events}
            viewerId={viewer.id}
            user={user}
            join={join}
            cancel={cancel}
            transfer={() => setTransfer(true)}
            isAdmin={isAdmin}
            cancelEvent={(eventId) => void execute("cancelEvent", { eventId })}
            editEvent={setEditingEvent}
          />
        )}
        {tab === "公告" && <News news={news} />}
        {tab === "社員名單" && <Members members={members} admin={isAdmin} issueClaimCode={issueClaimCode} />}
        {tab === "費用管理" && <Billing admin={isAdmin} member={user.member} />}
        {tab === "個人資訊" && (
          <AccountProfile
            viewer={viewer}
            user={user}
            recoverySaving={recoverySaving}
            passkeySaving={passkeySaving}
            createRecoveryCode={() => void makeRecoveryCode(viewer.hasRecoveryCode)}
            registerPasskey={() => void registerPasskey()}
            logout={() => void logout()}
          />
        )}
      </main>
      {transfer && (
        <div className="modal-cover">
          <section className="modal">
            <button className="close" onClick={() => setTransfer(false)}>
              ×
            </button>
            <p>名額轉讓</p>
            <h2>指定本次接手者</h2>
            <span>接手者會列為非社員，並記錄為「私下結清」。</span>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="輸入接手者姓名"
            />
            <button className="primary" onClick={submitTransfer}>
              確認轉讓
            </button>
          </section>
        </div>
      )}
      {isAdmin && managerOpen && (
        <ActivityManagerModal
          tab={managerTab}
          saving={managerSaving}
          setTab={setManagerTab}
          onClose={() => setManagerOpen(false)}
          createEvent={createEvent}
          generateWeeklyEvents={generateWeeklyEvents}
          addRestDay={addRestDay}
        />
      )}
      {isAdmin && announcementOpen && (
        <AnnouncementModal
          saving={announcementSaving}
          onClose={() => setAnnouncementOpen(false)}
          publish={publish}
        />
      )}
      {editingEvent && <div className="modal-cover"><section className="modal"><button className="close" onClick={() => setEditingEvent(null)}>×</button><p>活動管理</p><h2>編輯活動</h2><form onSubmit={updateEvent}><input name="date" type="date" defaultValue={editingEvent.startsAt?.slice(0, 10)} required /><div className="time-pair"><input name="start" type="time" defaultValue={editingEvent.startsAt?.slice(11, 16)} required /><input name="end" type="time" defaultValue={editingEvent.endsAt?.slice(11, 16)} required /></div><input name="courts" defaultValue={editingEvent.courts} required /><div className="time-pair"><input name="regular" type="number" min="1" defaultValue={editingEvent.regular} /><input name="standby" type="number" min="0" defaultValue={editingEvent.wait} /></div><button className="primary">儲存變更</button></form></section></div>}
      {codeNotice && <CodeNotice notice={codeNotice} onClose={() => setCodeNotice(null)} />}
    </div>
  );
}

function ActivityManagerModal({
  tab,
  saving,
  setTab,
  onClose,
  createEvent,
  generateWeeklyEvents,
  addRestDay,
}: {
  tab: ActivityManagerTab;
  saving: boolean;
  setTab: (tab: ActivityManagerTab) => void;
  onClose: () => void;
  createEvent: (form: FormEvent<HTMLFormElement>) => void;
  generateWeeklyEvents: (form: FormEvent<HTMLFormElement>) => void;
  addRestDay: (form: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div
      className="modal-cover"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section className="modal manager-modal" role="dialog" aria-modal="true" aria-labelledby="activity-manager-title">
        <button type="button" className="close" onClick={onClose} disabled={saving} aria-label="關閉活動管理視窗">
          ×
        </button>
        <p>幹部工具</p>
        <h2 id="activity-manager-title">活動管理</h2>
        <div className="manager-tabs" role="tablist" aria-label="活動管理功能">
          <button type="button" role="tab" aria-selected={tab === "single"} className={tab === "single" ? "active" : ""} onClick={() => setTab("single")}>
            建立活動
          </button>
          <button type="button" role="tab" aria-selected={tab === "weekly"} className={tab === "weekly" ? "active" : ""} onClick={() => setTab("weekly")}>
            未來場次
          </button>
          <button type="button" role="tab" aria-selected={tab === "rest"} className={tab === "rest" ? "active" : ""} onClick={() => setTab("rest")}>
            休團日
          </button>
        </div>

        {tab === "single" && (
          <form className="manager-form" onSubmit={createEvent}>
            <label>
              活動日期
              <input name="date" type="date" required autoFocus />
            </label>
            <div className="time-pair">
              <label>
                開始時間
                <input name="start" type="time" defaultValue="19:00" required />
              </label>
              <label>
                結束時間
                <input name="end" type="time" defaultValue="21:00" required />
              </label>
            </div>
            <label>
              集合／活動場地
              <input name="courts" defaultValue="公司體育館 A 場" placeholder="例如：公司體育館 A 場" required />
            </label>
            <div className="capacity-fields">
              <label>
                正取可參加人數
                <input name="regular" type="number" min="1" max="100" defaultValue="10" required />
              </label>
              <label>
                候補可參加人數
                <input name="standby" type="number" min="0" max="100" defaultValue="4" required />
              </label>
            </div>
            <p className="form-note">候補名額也可到場，正取與候補都會依社員／非社員身分計費。</p>
            <button className="primary" disabled={saving}>{saving ? "建立中…" : "建立活動"}</button>
          </form>
        )}

        {tab === "weekly" && (
          <form className="manager-form" onSubmit={generateWeeklyEvents}>
            <label>
              起始日期
              <input name="startDate" type="date" required autoFocus />
            </label>
            <label>
              建立週數
              <input name="weeks" type="number" min="1" max="16" defaultValue="12" required />
              <small>系統會從起始日期往後尋找週五，最多一次建立 16 週。</small>
            </label>
            <div className="time-pair">
              <label>
                每場開始時間
                <input name="start" type="time" defaultValue="19:00" required />
              </label>
              <label>
                每場結束時間
                <input name="end" type="time" defaultValue="21:00" required />
              </label>
            </div>
            <label>
              預設活動場地
              <input name="courts" defaultValue="公司體育館 A 場" required />
            </label>
            <div className="capacity-fields">
              <label>
                每場正取人數
                <input name="regular" type="number" min="1" max="100" defaultValue="10" required />
              </label>
              <label>
                每場候補人數
                <input name="standby" type="number" min="0" max="100" defaultValue="4" required />
              </label>
            </div>
            <p className="form-note">已存在的活動與休團日會自動略過，不會重複建立。</p>
            <button className="primary" disabled={saving}>{saving ? "建立中…" : "建立未來場次"}</button>
          </form>
        )}

        {tab === "rest" && (
          <form className="manager-form" onSubmit={addRestDay}>
            <label>
              休團日期
              <input name="date" type="date" required autoFocus />
            </label>
            <label>
              休團原因
              <input name="label" placeholder="例如：國定假日、公司休假" required />
            </label>
            <p className="form-note">之後批次建立週五活動時，系統會略過這一天。</p>
            <button className="primary" disabled={saving}>{saving ? "儲存中…" : "儲存休團日"}</button>
          </form>
        )}
      </section>
    </div>
  );
}

function AnnouncementModal({
  saving,
  onClose,
  publish,
}: {
  saving: boolean;
  onClose: () => void;
  publish: (form: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div
      className="modal-cover"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section className="modal manager-modal announcement-modal" role="dialog" aria-modal="true" aria-labelledby="announcement-modal-title">
        <button type="button" className="close" onClick={onClose} disabled={saving} aria-label="關閉發布公告視窗">
          ×
        </button>
        <p>幹部工具</p>
        <h2 id="announcement-modal-title">發布公告</h2>
        <span>公告發布後會立即顯示給所有使用者。</span>
        <form className="manager-form" onSubmit={publish}>
          <label>
            公告標題
            <input name="title" maxLength={80} placeholder="例如：本週場地異動通知" required autoFocus />
          </label>
          <label>
            公告內容
            <textarea name="content" maxLength={2000} rows={6} placeholder="輸入公告內容…" required />
          </label>
          <label>
            外部連結（選填）
            <input name="linkUrl" type="url" inputMode="url" placeholder="https://example.com" />
            <small>可附上 Teams、公司內網或其他完整網址。</small>
          </label>
          <p className="form-note">目前支援純文字與外部連結；圖片與檔案上傳將留到下一階段。</p>
          <button className="primary" disabled={saving}>{saving ? "發布中…" : "發布公告"}</button>
        </form>
      </section>
    </div>
  );
}

function Login({
  input,
  setInput,
  createGuest,
  recover,
  passkeyLogin,
  quickAccounts,
  quickLogin,
  saving,
}: {
  input: string;
  setInput: (value: string) => void;
  createGuest: (name: string) => void;
  recover: (name: string, code: string) => void;
  passkeyLogin: () => void;
  quickAccounts: DeviceAccount[];
  quickLogin: (userId: string) => void;
  saving: boolean;
}) {
  const [mode, setMode] = useState<"new" | "recover">("new");
  const [code, setCode] = useState("");
  return (
    <main className="login">
      <section>
        <div className="login-logo">羽</div>
        <p>COMPANY BADMINTON CLUB</p>
        <h1>下班，一起上場。</h1>
        <span>{mode === "new" ? "第一次使用只需輸入顯示名稱，系統會為這台裝置建立一個新的訪客帳號。" : "輸入原帳號姓名與認領碼或復原碼，即可在這台裝置取回帳號。"}</span>
        {quickAccounts.length > 0 && (
          <aside className="quick-accounts">
            <strong>這台裝置的快速登入</strong>
            <div>
              {quickAccounts.map((account) => (
                <button type="button" key={account.id} disabled={saving} onClick={() => quickLogin(account.id)}>
                  <i>{account.name.slice(0, 1)}</i>
                  <span>
                    <b>{account.name}</b>
                    <small>{account.role === "ADMIN" ? "幹部" : account.membershipStatus === "MEMBER" ? "社員" : "非社員"} · {account.id.slice(0, 6)}</small>
                  </span>
                  <em>登入</em>
                </button>
              ))}
            </div>
            <small>共享裝置上的其他人也能使用快速登入；共用電腦請使用獨立瀏覽器設定檔。</small>
          </aside>
        )}
        {quickAccounts.length > 0 && <div className="login-divider"><span>使用其他帳號</span></div>}
        <div className="login-tabs" role="tablist" aria-label="登入方式">
          <button type="button" role="tab" aria-selected={mode === "new"} className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>第一次使用</button>
          <button type="button" role="tab" aria-selected={mode === "recover"} className={mode === "recover" ? "active" : ""} onClick={() => setMode("recover")}>取回既有帳號</button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === "new") createGuest(input);
            else recover(input, code);
          }}
        >
          <label>使用者名稱</label>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="例如：林子晴" maxLength={40} required autoComplete="nickname" />
          {mode === "recover" && (
            <>
              <label>認領碼或復原碼</label>
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX" maxLength={19} required autoComplete="one-time-code" />
            </>
          )}
          <button className="primary" disabled={saving}>{saving ? "處理中…" : mode === "new" ? "建立這台裝置的帳號" : "取回帳號"}</button>
        </form>
        <div className="login-divider"><span>或</span></div>
        <button type="button" className="passkey-button" disabled={saving} onClick={passkeyLogin}>
          <strong>使用 Passkey 登入</strong>
          <span>Windows Hello、Face ID 或裝置 PIN</span>
        </button>
        <aside className="notice">
          <strong>測試版帳號提醒</strong>
          <span>相同姓名也會建立成不同帳號。未建立復原碼前，清除瀏覽器資料或更換裝置可能導致帳號無法取回。</span>
        </aside>
      </section>
    </main>
  );
}

function CodeNotice({ notice, onClose }: { notice: { title: string; body: string; code: string }; onClose: () => void }) {
  const copyCode = async () => {
    await navigator.clipboard.writeText(notice.code);
    window.alert("已複製");
  };
  return (
    <div className="modal-cover" role="presentation">
      <section className="modal code-modal" role="dialog" aria-modal="true" aria-labelledby="code-notice-title">
        <p>帳號安全</p>
        <h2 id="code-notice-title">{notice.title}</h2>
        <span>{notice.body}</span>
        <strong className="recovery-code">{notice.code}</strong>
        <div className="code-actions">
          <button className="secondary" onClick={() => void copyCode()}>複製代碼</button>
          <button className="primary" onClick={onClose}>我已保存</button>
        </div>
      </section>
    </div>
  );
}

function AccountProfile({
  viewer,
  user,
  recoverySaving,
  passkeySaving,
  createRecoveryCode,
  registerPasskey,
  logout,
}: {
  viewer: Viewer;
  user: Person;
  recoverySaving: boolean;
  passkeySaving: boolean;
  createRecoveryCode: () => void;
  registerPasskey: () => void;
  logout: () => void;
}) {
  const accountTypeLabels: Record<Viewer["accountType"], string> = {
    guest: "裝置訪客帳號",
    recoverable: "可復原訪客帳號",
    verified: "已驗證帳號",
    unclaimed: "待認領帳號",
  };
  const securityLabel = viewer.hasPasskey ? "Passkey 已啟用" : viewer.hasRecoveryCode ? "可使用復原碼" : "僅限此裝置";
  const shortId = viewer.id.length > 16 ? `${viewer.id.slice(0, 8)}…${viewer.id.slice(-4)}` : viewer.id;

  return (
    <section className="account-page">
      <article className="account-hero">
        <div className="account-avatar" aria-hidden="true">{user.name.slice(0, 1)}</div>
        <div className="account-hero-copy">
          <p>MY PROFILE</p>
          <h2>{user.name}</h2>
          <span>{user.department || "尚未設定部門"} · {user.role === "admin" ? "幹部管理者" : user.member ? "社員" : "非社員"}</span>
        </div>
        <Badge tone={viewer.hasPasskey || viewer.hasRecoveryCode ? "green" : "orange"}>{securityLabel}</Badge>
      </article>

      <div className="account-panels">
        <section className="account-card identity-card">
          <div className="account-card-heading">
            <div>
              <p>基本資料</p>
              <h3>帳號資訊</h3>
            </div>
            <Badge tone="gray">唯讀</Badge>
          </div>
          <dl className="account-details">
            <div><dt>顯示名稱</dt><dd>{user.name}</dd></div>
            <div><dt>部門</dt><dd>{user.department || "未填寫"}</dd></div>
            <div><dt>社員身分</dt><dd>{user.member ? "社員" : "非社員"}</dd></div>
            <div><dt>系統角色</dt><dd>{user.role === "admin" ? "幹部管理者" : "一般使用者"}</dd></div>
            <div><dt>帳號類型</dt><dd>{accountTypeLabels[viewer.accountType]}</dd></div>
            <div><dt>帳號識別碼</dt><dd><code title={viewer.id}>{shortId}</code></dd></div>
          </dl>
          <p className="account-note">姓名、部門及社員身分目前由幹部管理，如需變更請聯絡社團幹部。</p>
        </section>

        <section className="account-card security-card">
          <div className="account-card-heading">
            <div>
              <p>帳號安全</p>
              <h3>登入與復原方式</h3>
            </div>
          </div>

          <article className="security-method">
            <div className="security-icon" aria-hidden="true">#</div>
            <div className="security-copy">
              <div><strong>復原碼</strong><Badge tone={viewer.hasRecoveryCode ? "green" : "orange"}>{viewer.hasRecoveryCode ? "已設定" : "尚未設定"}</Badge></div>
              <span>{viewer.hasRecoveryCode ? "系統只保存不可逆的驗證資料，因此無法再次顯示原本的復原碼。" : "換裝置或清除網站資料時，可用姓名與復原碼取回帳號。"}</span>
            </div>
            <button className="secondary" disabled={recoverySaving} onClick={createRecoveryCode}>
              {recoverySaving ? "產生中…" : viewer.hasRecoveryCode ? "重新產生復原碼" : "建立復原碼"}
            </button>
          </article>

          <article className="security-method">
            <div className="security-icon" aria-hidden="true">✓</div>
            <div className="security-copy">
              <div><strong>Passkey</strong><Badge tone={viewer.hasPasskey ? "green" : "gray"}>{viewer.hasPasskey ? "已啟用" : "未設定"}</Badge></div>
              <span>使用 Windows Hello、Face ID 或裝置 PIN 登入，不需要輸入復原碼。</span>
            </div>
            <button className={viewer.hasPasskey ? "secondary" : "primary small"} disabled={passkeySaving} onClick={registerPasskey}>
              {passkeySaving ? "處理中…" : viewer.hasPasskey ? "新增另一個 Passkey" : "建立 Passkey"}
            </button>
          </article>

          <article className="security-method">
            <div className="security-icon" aria-hidden="true">◇</div>
            <div className="security-copy">
              <div><strong>此裝置快速登入</strong><Badge tone="blue">已記住</Badge></div>
              <span>登出後仍可在這台裝置的登入頁選擇此帳號；清除網站資料後會失效。</span>
            </div>
          </article>

          <aside className="recovery-reminder">
            <strong>重新產生前請注意</strong>
            <span>建立新復原碼後，舊碼會立即失效；新碼也只顯示一次，請當下複製保存。</span>
          </aside>
        </section>
      </div>

      <section className="account-card account-session">
        <div>
          <p>目前工作階段</p>
          <h3>要離開這個帳號嗎？</h3>
          <span>登出不會刪除這台裝置保存的快速登入帳號，也不會刪除雲端資料。</span>
        </div>
        <button className="secondary" onClick={logout}>登出</button>
      </section>
    </section>
  );
}

function Overview({
  event,
  booking,
  user,
  invoice,
  join,
  cancel,
  transfer,
  showEvents,
  showBilling,
}: {
  event?: ClubEvent;
  booking?: Booking;
  user: Person;
  invoice?: Invoice;
  join: () => void;
  cancel: () => void;
  transfer: () => void;
  showEvents: () => void;
  showBilling: () => void;
}) {
  if (!event) {
    return (
      <div className="dashboard overview-dashboard">
        <section className="overview-heading">
          <div>
            <p>歡迎回來，{user.name}</p>
            <h2>下一場活動</h2>
          </div>
        </section>
        <section className="overview-empty">
          <b>◷</b>
          <h3>目前沒有已排程的活動</h3>
          <span>幹部建立下一場活動後，日期、場地與報名狀態會顯示在這裡。</span>
          <button className="primary" onClick={showEvents}>查看活動</button>
        </section>
      </div>
    );
  }

  const regular = event.bookings.filter((entry) => entry.rank === "正取").length;
  const wait = event.bookings.filter((entry) => entry.rank === "候補").length;
  const regularRemaining = Math.max(0, event.regular - regular);
  const waitRemaining = Math.max(0, event.wait - wait);
  const dateParts = event.date.match(/(\d+)\s*月\s*(\d+)/);
  const invoiceState: { label: string; tone: "green" | "orange" | "blue" | "gray" } = !invoice
    ? { label: "目前無帳單", tone: "gray" }
    : invoice.status === "CONFIRMED"
      ? { label: "已確認", tone: "green" }
      : invoice.status === "REPORTED"
        ? { label: "已回報轉帳", tone: "blue" }
        : { label: "待轉帳", tone: "orange" };
  const invoiceLabel = invoice?.type === "SINGLE_EVENT" ? "本次活動費" : "三個月社員費";
  const capacityTitle = regularRemaining > 0
    ? `尚有 ${regularRemaining} 個正取名額`
    : waitRemaining > 0
      ? `正取已滿，候補尚有 ${waitRemaining} 位`
      : "本場正取與候補皆已額滿";

  return (
    <div className="dashboard overview-dashboard">
      <section className="overview-heading">
        <div>
          <p>歡迎回來，{user.name}</p>
          <h2>下一場活動</h2>
        </div>
        <button className="link" onClick={showEvents}>查看全部活動 →</button>
      </section>

      <section className="next-event-card">
        <div className="overview-date">
          <strong>{dateParts?.[2] ?? event.date}</strong>
          <span>{dateParts ? `${dateParts[1]}月` : ""}</span>
          <small>{event.weekday}</small>
        </div>
        <div className="next-event-detail">
          <Badge tone="green">下一場</Badge>
          <h3>{event.time}</h3>
          <p>⌖ {event.courts}</p>
        </div>
        <div className="attendance-summary" aria-label="本場參加人數">
          <div>
            <small>正取</small>
            <strong>{regular}<span>／{event.regular}</span></strong>
          </div>
          <div>
            <small>候補</small>
            <strong>{wait}<span>／{event.wait}</span></strong>
          </div>
        </div>
      </section>

      <div className="overview-lower">
        <section className="my-status overview-status">
          <div className="status-heading">
            <div>
              <p>我的參加狀態</p>
              <h3>{booking ? `已列為${booking.rank}` : "尚未確認參加"}</h3>
            </div>
            <Badge tone={booking ? (booking.rank === "正取" ? "green" : "orange") : "gray"}>{booking?.rank ?? "待確認"}</Badge>
          </div>
          <span>
            {booking
              ? booking.kind === "社員"
                ? "本次費用已包含在三個月社員預收中。"
                : "非社員單次費 NT$180，可到費用管理回報轉帳。"
              : user.member
                ? "請確認是否參加；正取額滿後才會排入候補。"
                : "完成報名後會依剩餘名額列為正取或候補。"}
          </span>
          <div className="status-actions">
            {!booking ? (
              <button className="primary" onClick={join}>{user.member ? "確認參加" : "我要報名"}</button>
            ) : (
              <>
                <button className="secondary" onClick={cancel}>取消參加</button>
                {booking.kind === "社員" && <button className="link" onClick={transfer}>轉讓本次名額 →</button>}
              </>
            )}
          </div>
        </section>

        <div className="overview-side">
          <section className="overview-card payment-summary">
            <div>
              <p>{invoiceLabel}</p>
              <Badge tone={invoiceState.tone}>{invoiceState.label}</Badge>
            </div>
            <strong>{invoice ? `NT$ ${invoice.amount.toLocaleString("zh-TW")}` : "無待處理費用"}</strong>
            <span>{invoice?.period_label ?? "目前沒有需要處理的付款項目"}</span>
            <button className="link" onClick={showBilling}>查看費用明細 →</button>
          </section>

          <section className="overview-card capacity-note">
            <b>✦</b>
            <div>
              <p>名額提醒</p>
              <h3>{capacityTitle}</h3>
              <span>候補也可參加；正取取消時，社員候補會優先依確認時間遞補。</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function taipeiDateParts(value: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(value);
  const number = (type: "year" | "month" | "day") => Number(parts.find((part) => part.type === type)?.value);
  return { year: number("year"), month: number("month"), day: number("day") };
}

function ActivityCalendar({ list }: { list: ClubEvent[] }) {
  const today = taipeiDateParts(new Date());
  const [visibleMonth, setVisibleMonth] = useState({ year: today.year, month: today.month });
  const firstWeekday = new Date(Date.UTC(visibleMonth.year, visibleMonth.month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(visibleMonth.year, visibleMonth.month, 0)).getUTCDate();
  const eventsByDay = new Map<number, ClubEvent[]>();

  for (const event of list) {
    if (!event.startsAt) continue;
    const date = taipeiDateParts(new Date(event.startsAt));
    if (date.year !== visibleMonth.year || date.month !== visibleMonth.month) continue;
    eventsByDay.set(date.day, [...(eventsByDay.get(date.day) ?? []), event]);
  }

  const changeMonth = (offset: number) => {
    setVisibleMonth((current) => {
      const next = new Date(Date.UTC(current.year, current.month - 1 + offset, 1));
      return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1 };
    });
  };
  const isCurrentMonth = visibleMonth.year === today.year && visibleMonth.month === today.month;
  const eventCount = [...eventsByDay.values()].reduce((total, events) => total + events.length, 0);

  return (
    <section className="activity-calendar" aria-label={`${visibleMonth.year} 年 ${visibleMonth.month} 月活動月曆`}>
      <div className="calendar-heading">
        <div>
          <p>活動月曆</p>
          <h2>{visibleMonth.year} 年 {visibleMonth.month} 月</h2>
          <span>本月共 {eventCount} 場活動</span>
        </div>
        <div className="calendar-controls">
          <button type="button" onClick={() => changeMonth(-1)} aria-label="上個月">‹</button>
          {!isCurrentMonth && <button type="button" className="calendar-today" onClick={() => setVisibleMonth({ year: today.year, month: today.month })}>本月</button>}
          <button type="button" onClick={() => changeMonth(1)} aria-label="下個月">›</button>
        </div>
      </div>
      <div className="calendar-weekdays" aria-hidden="true">
        {['日', '一', '二', '三', '四', '五', '六'].map((weekday) => <span key={weekday}>{weekday}</span>)}
      </div>
      <div className="calendar-days">
        {Array.from({ length: firstWeekday }, (_, index) => <span className="calendar-day empty" key={`empty-${index}`} aria-hidden="true" />)}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const day = index + 1;
          const dayEvents = eventsByDay.get(day) ?? [];
          const firstEvent = dayEvents[0];
          const isToday = isCurrentMonth && day === today.day;
          const content = (
            <>
              <span className="calendar-day-number">{day}{isToday && <i>今天</i>}</span>
              {firstEvent && <strong>{firstEvent.time.split(" – ")[0]}</strong>}
              {firstEvent && <small title={firstEvent.courts}>{firstEvent.courts}</small>}
              {dayEvents.length > 1 && <em>另有 {dayEvents.length - 1} 場</em>}
            </>
          );
          return firstEvent ? (
            <button
              type="button"
              className={`calendar-day has-event${isToday ? " today" : ""}`}
              key={day}
              aria-label={`${visibleMonth.month} 月 ${day} 日，${dayEvents.length} 場活動`}
              onClick={() => document.getElementById(`event-${firstEvent.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
            >
              {content}
            </button>
          ) : (
            <span className={`calendar-day${isToday ? " today" : ""}`} key={day}>{content}</span>
          );
        })}
      </div>
    </section>
  );
}

function Events({
  list,
  viewerId,
  user,
  join,
  cancel,
  transfer,
  isAdmin,
  cancelEvent,
  editEvent,
}: {
  list: ClubEvent[];
  viewerId: string;
  user: Person;
  join: (id: string) => void;
  cancel: (id: string) => void;
  transfer: () => void;
  isAdmin: boolean;
  cancelEvent: (id: string) => void;
  editEvent: (event: ClubEvent) => void;
}) {
  return (
    <div className="activities-page">
      <ActivityCalendar list={list} />
      <div className="event-list-heading">
        <div>
          <p>活動明細</p>
          <h2>全部場次</h2>
        </div>
        <span>共 {list.length} 場</span>
      </div>
      <section className="event-list">
        {list.map((event) => {
        const entry = event.bookings.find((item) => item.memberId === viewerId);
        const regular = event.bookings.filter((item) => item.rank === "正取").length;
        const wait = event.bookings.filter((item) => item.rank === "候補").length;
        const dateParts = event.date.match(/(\d+)\s*月\s*(\d+)/);
        return (
          <article key={event.id} id={`event-${event.id}`}>
            <div className="calendar">
              <b>{dateParts?.[2] ?? event.date}</b>
              <span>{dateParts ? `${dateParts[1]}月` : ""}</span>
              <small>{event.weekday}</small>
            </div>
            <div className="event-detail">
              <h3>
                {event.time} <Badge tone="blue">{event.courts}</Badge>
              </h3>
              <p>
                正取 {regular}/{event.regular} · 候補 {wait}/{event.wait}（候補也可參加）
              </p>
              <div className="chips">
                {event.bookings.slice(0, 5).map((item) => (
                  <span key={item.memberId}>
                    {item.name}
                    <i className={item.rank === "正取" ? "green-dot" : "orange-dot"} />
                  </span>
                ))}
              </div>
            </div>
            <div className="event-buttons">
              {entry ? (
                <>
                  <Badge tone={entry.rank === "正取" ? "green" : "orange"}>{entry.rank}</Badge>
                  <button className="link" onClick={() => cancel(event.id)}>
                    取消
                  </button>
                  {entry.kind === "社員" && (
                    <button className="link" onClick={transfer}>
                      轉讓
                    </button>
                  )}
                </>
              ) : (
                <button className="primary small" onClick={() => join(event.id)}>
                  {user.member ? "確認參加" : "報名"}
                </button>
              )}
              {isAdmin && <button className="link" onClick={() => editEvent(event)}>編輯</button>}
              {isAdmin && <button className="link danger" onClick={() => cancelEvent(event.id)}>取消活動</button>}
            </div>
          </article>
        );
        })}
      </section>
    </div>
  );
}
function News({ news }: { news: NewsItem[] }) {
  return (
    <div className="news-layout">
      <section className="news-list">
        {news.map((item, index) => (
          <article key={`${item.title}-${index}`}>
            <div>
              <Badge tone={index === 0 ? "green" : "gray"}>{index === 0 ? "置頂" : "公告"}</Badge>
              <small>{item.date}</small>
            </div>
            <h3>{item.title}</h3>
            <p>{item.content}</p>
            {item.linkUrl && (
              <a className="link" href={item.linkUrl} target="_blank" rel="noreferrer">
                開啟相關連結 →
              </a>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}
function Members({ members, admin, issueClaimCode }: { members: Person[]; admin: boolean; issueClaimCode: (person: Person) => void }) {
  return (
    <section className="table">
      <header>
        <div>
          <p>社員名單</p>
          <h3>一起上場的夥伴</h3>
        </div>
        <input placeholder="搜尋姓名或部門" />
      </header>
      <div className="row head">
        <span>姓名</span>
        <span>部門</span>
        <span>身分</span>
        <span>{admin ? "帳號恢復" : "本週狀態"}</span>
      </div>
      {members.map((person) => (
        <div className="row" key={person.id}>
          <strong>
            <i>{person.name[0]}</i>
            {person.name}
          </strong>
          <span>{person.department ?? "—"}</span>
          <span>
            <Badge tone={person.member ? "green" : "gray"}>{person.member ? "社員" : "非社員"}</Badge>
          </span>
          <span>{admin ? <button type="button" className="link claim-button" onClick={() => issueClaimCode(person)}>產生認領碼</button> : person.member ? "已確認" : "—"}</span>
        </div>
      ))}
    </section>
  );
}
function Billing({ admin, member }: { admin: boolean; member: boolean }) {
  const data = admin
    ? [
        ["王小芸", "社員 · 2026 Q3", "NT$ 1,800", "已確認"],
        ["林子晴", "社員 · 2026 Q3", "NT$ 1,800", "待確認"],
        ["許庭維", "非社員 · 9/4 活動", "NT$ 180", "待轉帳"],
        ["周昱安", "社員 · 2026 Q3", "NT$ 1,800", "已確認"],
      ]
    : [["本期社員預收", "2026 Q3 · 12 次活動", member ? "NT$ 1,800" : "NT$ 180", "待確認"]];
  return (
    <div className="billing">
      <section className="billing-top">
        <div>
          <p>2026 · 第三季</p>
          <h3>{admin ? "本季收款概況" : "你的費用"}</h3>
        </div>
        <strong>{admin ? "NT$ 5,580" : member ? "NT$ 1,800" : "NT$ 180"}</strong>
        <span>{admin ? "3 人已確認 · 2 筆待處理" : "請轉帳後點選「已轉帳」"}</span>
      </section>
      <section className="table">
        <header>
          <div>
            <p>{admin ? "帳務清單" : "帳單明細"}</p>
            <h3>{admin ? "付款確認" : "目前待處理"}</h3>
          </div>
          {admin && <button className="secondary">匯出 CSV</button>}
        </header>
        <div className="row head">
          <span>{admin ? "使用者" : "項目"}</span>
          <span>內容</span>
          <span>金額</span>
          <span>狀態</span>
        </div>
        {data.map((line) => (
          <div className="row" key={line[0]}>
            <strong>{line[0]}</strong>
            <span>{line[1]}</span>
            <strong>{line[2]}</strong>
            <span>
              <Badge tone={line[3] === "已確認" ? "green" : "orange"}>{line[3]}</Badge>
            </span>
          </div>
        ))}
        {!admin && <button className="primary pay">我已轉帳</button>}
      </section>
    </div>
  );
}
