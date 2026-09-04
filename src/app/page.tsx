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
type BillingManagerTab = "quarterly" | "rates";
type Person = { id: string; name: string; department?: string; role: Role; member: boolean; membershipStatus?: string; creditBalance?: number; primaryAdmin?: boolean };
type Booking = { memberId: string; name: string; kind: "社員" | "非社員"; rank: "正取" | "候補"; transferred?: boolean };
type NewsItem = { id: string; title: string; content: string; date: string; linkUrl?: string; pinned: boolean };
type Invoice = { id: string; member_id: string; memberName: string; type: string; gross_amount: number; credit_applied: number; amount: number; status: string; period_label?: string; due_at?: string | null };
type RestDay = { id: string; date: string; label: string };
type FeeRate = { id: string; kind: string; amount: number; effective_from: string | null; effective_to: string | null };
type MembershipRequest = { id: string; memberId: string; memberName: string; kind: "JOIN" | "EXIT"; status: "PENDING" | "APPROVED" | "REJECTED"; requestedAt: string | null; reviewedAt: string | null };
type ClubNotification = { id: string; title: string; message: string; type: string; tab: string; createdAt: string | null; read: boolean };
type Viewer = {
  id: string;
  name: string;
  department: string | null;
  role: "ADMIN" | "MEMBER";
  membershipStatus: string;
  creditBalance: number;
  accountType: "guest" | "recoverable" | "verified" | "unclaimed";
  hasRecoveryCode: boolean;
  hasPasskey: boolean;
};
type ActionResult = { recoveryCode?: string; claimCode?: string; recipientName?: string; invoiceCount?: number; eventCount?: number; totalAmount?: number; periodLabel?: string; createdCount?: number };
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
  regularBooked: number;
  waitBooked: number;
  memberFee: number;
  guestFee: number;
  bookings: Booking[];
};

type ApiState = {
  viewer: Viewer | null;
  members: { id: string; name: string; department?: string; role: string; membershipStatus: string; creditBalance?: number; primaryAdmin?: boolean }[];
  events: { id: string; starts_at: string; ends_at: string; courts: string; regular_capacity: number; standby_capacity: number; regular_count: number; standby_count: number; member_fee: number; guest_fee: number; bookings: { memberId: string; name: string; kind: string; status: string }[] }[];
  announcements: { id: string; title: string; content: string; publishedAt: string; linkUrl?: string; pinned: boolean }[];
  invoices: Invoice[];
  restDays: RestDay[];
  feeRates: FeeRate[];
  membershipRequests: MembershipRequest[];
  notifications: ClubNotification[];
  currentFees: { member: number; guest: number };
  quickAccounts: DeviceAccount[];
  actionResult?: ActionResult;
};

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
  const [events, setEvents] = useState<ClubEvent[]>([]);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [members, setMembers] = useState<Person[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [restDays, setRestDays] = useState<RestDay[]>([]);
  const [feeRates, setFeeRates] = useState<FeeRate[]>([]);
  const [membershipRequests, setMembershipRequests] = useState<MembershipRequest[]>([]);
  const [notifications, setNotifications] = useState<ClubNotification[]>([]);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [currentFees, setCurrentFees] = useState({ member: 150, guest: 180 });
  const [transferEventId, setTransferEventId] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [editingEvent, setEditingEvent] = useState<ClubEvent | null>(null);
  const [managerTab, setManagerTab] = useState<ActivityManagerTab>("single");
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerSaving, setManagerSaving] = useState(false);
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState<NewsItem | null>(null);
  const [announcementSaving, setAnnouncementSaving] = useState(false);
  const [billingManagerOpen, setBillingManagerOpen] = useState(false);
  const [billingManagerTab, setBillingManagerTab] = useState<BillingManagerTab>("quarterly");
  const [billingSaving, setBillingSaving] = useState(false);
  const [membershipSaving, setMembershipSaving] = useState(false);
  const [editingMember, setEditingMember] = useState<Person | null>(null);
  const [memberSaving, setMemberSaving] = useState(false);

  useEffect(() => {
    if (!managerOpen && !announcementOpen && !billingManagerOpen && !editingMember) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setManagerOpen(false);
        setAnnouncementOpen(false);
        setEditingAnnouncement(null);
        setBillingManagerOpen(false);
        setEditingMember(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [managerOpen, announcementOpen, billingManagerOpen, editingMember]);

  const applyState = useCallback((state: ApiState) => {
    setViewer(state.viewer);
    setQuickAccounts(state.quickAccounts ?? []);
    setMembers(state.members.map((member) => ({ id: member.id, name: member.name, department: member.department, role: member.role === "ADMIN" ? "admin" : "member", member: member.membershipStatus === "MEMBER" || member.membershipStatus === "EXITING", membershipStatus: member.membershipStatus, creditBalance: Number(member.creditBalance ?? 0), primaryAdmin: Boolean(member.primaryAdmin) })));
    setEvents(state.events.map((item) => {
      const startsAt = new Date(item.starts_at);
      const endsAt = new Date(item.ends_at);
      const date = `${startsAt.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric" })} ${startsAt.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", day: "numeric" })}`;
      const time = `${startsAt.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false })} – ${endsAt.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false })}`;
      return { id: item.id, startsAt: item.starts_at, endsAt: item.ends_at, date, weekday: startsAt.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", weekday: "short" }), time, courts: item.courts, regular: item.regular_capacity, wait: item.standby_capacity, regularBooked: item.regular_count, waitBooked: item.standby_count, memberFee: item.member_fee, guestFee: item.guest_fee, bookings: item.bookings.map((booking) => ({ memberId: booking.memberId, name: booking.name, kind: booking.kind === "MEMBER" ? "社員" : "非社員", rank: booking.status === "REGULAR" ? "正取" : "候補" })) };
    }));
    setNews(state.announcements.map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content,
      date: new Date(item.publishedAt).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).replaceAll("/", "."),
      linkUrl: item.linkUrl,
      pinned: item.pinned,
    })));
    setInvoices(state.invoices ?? []);
    setRestDays(state.restDays ?? []);
    setFeeRates(state.feeRates ?? []);
    setMembershipRequests(state.membershipRequests ?? []);
    setNotifications(state.notifications ?? []);
    setCurrentFees(state.currentFees ?? { member: 150, guest: 180 });
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
      ? { id: viewer.id, name: viewer.name, department: viewer.department ?? undefined, role: viewer.role === "ADMIN" ? "admin" : "member", member: viewer.membershipStatus === "MEMBER" || viewer.membershipStatus === "EXITING", membershipStatus: viewer.membershipStatus, creditBalance: viewer.creditBalance }
      : { id: "", name: "", role: "member", member: false },
    [viewer],
  );
  const event = events.find((item) => !item.endsAt || new Date(item.endsAt) > new Date());
  const headerDate = event?.startsAt ? new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "long" }).format(new Date(event.startsAt)) : "台北時間 · UTC+8";
  const booking = event?.bookings.find((item) => item.memberId === viewer?.id);
  const invoice = invoices.find((item) => item.member_id === viewer?.id && ["PENDING", "REPORTED", "CONFIRMED"].includes(item.status));
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
  const logout = async () => { await execute("logout", {}); setTab("總覽"); setNotificationOpen(false); };
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
    if (!clean || !viewer || !transferEventId) return;
    const payload = await execute("transfer", { eventId: transferEventId, recipient: clean });
    if (payload) {
      setRecipient("");
      setTransferEventId(null);
      if (payload.actionResult?.claimCode) {
        setCodeNotice({ title: "請將認領碼交給接手者", body: `${payload.actionResult.recipientName ?? clean} 可在登入頁用姓名與這組認領碼開啟帳號。此碼只會顯示一次。`, code: payload.actionResult.claimCode });
      }
    }
  };
  const saveAnnouncement = async (form: FormEvent<HTMLFormElement>) => {
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
      const action = editingAnnouncement ? "updateAnnouncement" : "publish";
      if (await execute(action, { ...(editingAnnouncement ? { announcementId: editingAnnouncement.id } : {}), title, content, linkUrl })) {
        element.reset();
        setAnnouncementOpen(false);
        setEditingAnnouncement(null);
      }
    } finally {
      setAnnouncementSaving(false);
    }
  };
  const deleteAnnouncement = async (announcement: NewsItem) => {
    if (!window.confirm(`確定要刪除公告「${announcement.title}」嗎？刪除後無法復原。`)) return;
    setAnnouncementSaving(true);
    try {
      await execute("deleteAnnouncement", { announcementId: announcement.id });
    } finally {
      setAnnouncementSaving(false);
    }
  };
  const toggleAnnouncementPinned = async (announcement: NewsItem) => {
    setAnnouncementSaving(true);
    try {
      await execute("setAnnouncementPinned", { announcementId: announcement.id, pinned: String(!announcement.pinned) });
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
  const updateEvent = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    if (!editingEvent) return;
    const data = new FormData(form.currentTarget);
    const times = eventTimes(data);
    if (!times) return;
    setManagerSaving(true);
    try {
      if (await execute("updateEvent", { eventId: editingEvent.id, ...times, courts: String(data.get("courts")), regularCapacity: String(data.get("regular")), standbyCapacity: String(data.get("standby")) })) {
        setEditingEvent(null);
      }
    } finally {
      setManagerSaving(false);
    }
  };
  const addRestDay = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    const element = form.currentTarget;
    const data = new FormData(element);
    setManagerSaving(true);
    try {
      if (await execute("addRestDay", { date: new Date(`${data.get("date")}T00:00:00.000Z`).toISOString(), label: String(data.get("label")).trim() })) {
        element.reset();
      }
    } finally {
      setManagerSaving(false);
    }
  };
  const removeRestDay = async (restDay: RestDay) => {
    if (!window.confirm(`確定要移除「${restDay.label}（${restDay.date}）」嗎？`)) return;
    setManagerSaving(true);
    try {
      await execute("removeRestDay", { restDayId: restDay.id });
    } finally {
      setManagerSaving(false);
    }
  };
  const cancelClubEvent = async (eventId: string) => {
    if (!window.confirm("確定要取消這場活動嗎？報名紀錄與相關單次帳單會一併處理。")) return;
    await execute("cancelEvent", { eventId });
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
      const payload = await execute("generateWeeklyEvents", { startDate: String(data.get("startDate")), weeks: String(data.get("weeks")), startTime: start, endTime: end, courts: String(data.get("courts")), regularCapacity: String(data.get("regular")), standbyCapacity: String(data.get("standby")) });
      if (payload) {
        element.reset();
        setManagerOpen(false);
        window.alert(payload.actionResult?.createdCount ? `已建立 ${payload.actionResult.createdCount} 場活動。` : "沒有建立新活動；所選期間可能已存在活動或休團日。");
      }
    } finally {
      setManagerSaving(false);
    }
  };
  const reportInvoicePayment = async (invoiceId: string) => {
    setBillingSaving(true);
    try {
      await execute("reportPayment", { invoiceId });
    } finally {
      setBillingSaving(false);
    }
  };
  const confirmInvoicePayment = async (invoiceId: string) => {
    setBillingSaving(true);
    try {
      await execute("confirmPayment", { invoiceId });
    } finally {
      setBillingSaving(false);
    }
  };
  const createQuarterlyInvoices = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    const data = new FormData(form.currentTarget);
    setBillingSaving(true);
    try {
      const payload = await execute("createQuarterlyInvoices", {
        startDate: String(data.get("startDate")),
        endDate: String(data.get("endDate")),
        dueDate: String(data.get("dueDate")),
        label: String(data.get("label")).trim(),
      });
      if (payload) {
        const result = payload.actionResult;
        window.alert(`已建立 ${result?.invoiceCount ?? 0} 筆社員帳單，共計 ${result?.eventCount ?? 0} 場活動、NT$${Number(result?.totalAmount ?? 0).toLocaleString("zh-TW")}。`);
        setBillingManagerOpen(false);
      }
    } finally {
      setBillingSaving(false);
    }
  };
  const saveFeeRates = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    const data = new FormData(form.currentTarget);
    setBillingSaving(true);
    try {
      if (await execute("setFeeRates", {
        memberAmount: String(data.get("memberAmount")),
        guestAmount: String(data.get("guestAmount")),
        effectiveDate: String(data.get("effectiveDate")),
      })) {
        window.alert("未來費率已儲存；既有活動與帳單金額不會改變。");
        setBillingManagerOpen(false);
      }
    } finally {
      setBillingSaving(false);
    }
  };
  const requestMembershipChange = async (kind: "JOIN" | "EXIT") => {
    const message = kind === "JOIN"
      ? "送出加入社員申請後，需由幹部核准才會生效。確定送出嗎？"
      : "退社核准後，會籍原則上維持到目前三個月週期結束且不退款。確定送出嗎？";
    if (!window.confirm(message)) return;
    setMembershipSaving(true);
    try {
      if (await execute("requestMembershipChange", { kind })) window.alert("申請已送出，請等待幹部審核。");
    } finally {
      setMembershipSaving(false);
    }
  };
  const reviewMembershipRequest = async (request: MembershipRequest, decision: "APPROVE" | "REJECT") => {
    const decisionText = decision === "APPROVE" ? "核准" : "拒絕";
    if (!window.confirm(`確定要${decisionText}${request.memberName}的${request.kind === "JOIN" ? "加入" : "退出"}申請嗎？`)) return;
    setMembershipSaving(true);
    try {
      if (await execute("reviewMembershipRequest", { requestId: request.id, decision })) window.alert(`已${decisionText}申請。`);
    } finally {
      setMembershipSaving(false);
    }
  };
  const updateMember = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    if (!editingMember) return;
    const data = new FormData(form.currentTarget);
    setMemberSaving(true);
    try {
      if (await execute("updateMember", {
        memberId: editingMember.id,
        department: String(data.get("department") ?? "").trim(),
        role: String(data.get("role") ?? "MEMBER"),
        membershipStatus: String(data.get("membershipStatus") ?? "GUEST"),
        balanceAdjustment: String(data.get("balanceAdjustment") ?? "0"),
        adjustmentNote: String(data.get("adjustmentNote") ?? "").trim(),
      })) {
        setEditingMember(null);
      }
    } finally {
      setMemberSaving(false);
    }
  };
  const markNotificationsRead = async (notificationIds: string[]) => {
    if (notificationIds.length === 0) return true;
    setNotificationSaving(true);
    try {
      return Boolean(await execute("markNotificationsRead", { notificationIds: notificationIds.join(",") }));
    } finally {
      setNotificationSaving(false);
    }
  };
  const openNotification = async (notification: ClubNotification) => {
    if (!notification.read) await markNotificationsRead([notification.id]);
    if ((["總覽", "活動", "公告", "社員名單", "費用管理", "個人資訊"] as string[]).includes(notification.tab)) setTab(notification.tab as Tab);
    setNotificationOpen(false);
  };
  const unreadNotifications = notifications.filter((notification) => !notification.read);

  if (!sessionReady) return <main className="login"><section className="session-loading"><div className="login-logo">羽</div><h1>正在確認此裝置…</h1><span>請稍候，系統正在安全地恢復登入狀態。</span></section></main>;
  if (!viewer) return <Login input={input} setInput={setInput} createGuest={createGuest} recover={recover} passkeyLogin={loginWithPasskey} quickAccounts={quickAccounts} quickLogin={quickLogin} saving={authSaving || passkeySaving} events={events} news={news} />;
  const isAdmin = user.role === "admin";
  return (
    <div className="app">
      <aside className={`sidebar${sidebarCollapsed ? " collapsed" : ""}`}>
        <button
          type="button"
          className="sidebar-toggle"
          aria-label={sidebarCollapsed ? "展開側邊欄" : "收合側邊欄"}
          title={sidebarCollapsed ? "展開側邊欄" : "收合側邊欄"}
          onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
        >
          {sidebarCollapsed ? "›" : "‹"}
        </button>
        <div className="brand">
          <b>羽</b>
          <span>
            <strong>球友會</strong>
            <small>BADMINTON CLUB</small>
          </span>
        </div>
        <nav>
          {(["總覽", "活動", "公告", "社員名單", "費用管理", "個人資訊"] as Tab[]).map((item, index) => (
            <button
              key={item}
              className={tab === item ? "nav-active" : ""}
              title={sidebarCollapsed ? item : undefined}
              onClick={() => { setTab(item); setNotificationOpen(false); }}
            >
              <i>{["⌂", "◷", "✦", "♙", "◫", "●"][index]}</i>
              <span>{item}</span>
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
            <p>{headerDate}</p>
            <h1>{tab}</h1>
          </div>
          <div className="header-actions">
            <button className="bell" aria-label={`通知，${unreadNotifications.length} 筆未讀`} aria-expanded={notificationOpen} onClick={() => setNotificationOpen((open) => !open)}>
              🔔{unreadNotifications.length > 0 && <em>{unreadNotifications.length > 99 ? "99+" : unreadNotifications.length}</em>}
            </button>
            {notificationOpen && (
              <NotificationPanel
                notifications={notifications}
                saving={notificationSaving}
                close={() => setNotificationOpen(false)}
                openNotification={(notification) => void openNotification(notification)}
                markAll={() => void markNotificationsRead(unreadNotifications.map((notification) => notification.id))}
              />
            )}
            {isAdmin && (tab === "活動" || tab === "公告" || tab === "費用管理") && (
              <button
                className="primary small"
                onClick={() => {
                  if (tab === "活動") {
                    setManagerTab("single");
                    setManagerOpen(true);
                  } else if (tab === "費用管理") {
                    setBillingManagerTab("quarterly");
                    setBillingManagerOpen(true);
                  } else {
                    setTab("公告");
                    setEditingAnnouncement(null);
                    setAnnouncementOpen(true);
                  }
                }}
              >
                {tab === "活動" ? "＋ 新增活動" : tab === "費用管理" ? "＋ 建立帳單" : "＋ 發布公告"}
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
            transfer={() => event && setTransferEventId(event.id)}
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
            transfer={setTransferEventId}
            isAdmin={isAdmin}
            cancelEvent={(eventId) => void cancelClubEvent(eventId)}
            editEvent={setEditingEvent}
          />
        )}
        {tab === "公告" && <News news={news} admin={isAdmin} saving={announcementSaving} edit={(announcement) => { setEditingAnnouncement(announcement); setAnnouncementOpen(true); }} remove={(announcement) => void deleteAnnouncement(announcement)} togglePinned={(announcement) => void toggleAnnouncementPinned(announcement)} />}
        {tab === "社員名單" && <Members members={members} requests={membershipRequests} admin={isAdmin} saving={membershipSaving || memberSaving} issueClaimCode={issueClaimCode} reviewRequest={reviewMembershipRequest} manageMember={setEditingMember} />}
        {tab === "費用管理" && (
          <Billing
            admin={isAdmin}
            invoices={invoices}
            viewer={viewer}
            saving={billingSaving}
            reportPayment={reportInvoicePayment}
            confirmPayment={confirmInvoicePayment}
            openRates={() => {
              setBillingManagerTab("rates");
              setBillingManagerOpen(true);
            }}
          />
        )}
        {tab === "個人資訊" && (
          <AccountProfile
            viewer={viewer}
            user={user}
            recoverySaving={recoverySaving}
            passkeySaving={passkeySaving}
            membershipSaving={membershipSaving}
            membershipRequests={membershipRequests}
            createRecoveryCode={() => void makeRecoveryCode(viewer.hasRecoveryCode)}
            registerPasskey={() => void registerPasskey()}
            requestMembershipChange={(kind) => void requestMembershipChange(kind)}
            logout={() => void logout()}
          />
        )}
      </main>
      {transferEventId && (
        <div className="modal-cover">
          <section className="modal">
            <button className="close" onClick={() => setTransferEventId(null)}>
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
          restDays={restDays}
          removeRestDay={removeRestDay}
        />
      )}
      {isAdmin && announcementOpen && (
        <AnnouncementModal
          saving={announcementSaving}
          announcement={editingAnnouncement}
          onClose={() => { setAnnouncementOpen(false); setEditingAnnouncement(null); }}
          save={saveAnnouncement}
        />
      )}
      {isAdmin && billingManagerOpen && (
        <BillingManagerModal
          tab={billingManagerTab}
          setTab={setBillingManagerTab}
          saving={billingSaving}
          currentFees={currentFees}
          feeRates={feeRates}
          onClose={() => setBillingManagerOpen(false)}
          createQuarterlyInvoices={createQuarterlyInvoices}
          saveFeeRates={saveFeeRates}
        />
      )}
      {editingEvent && (
        <div className="modal-cover">
          <section className="modal manager-modal">
            <button className="close" onClick={() => setEditingEvent(null)} disabled={managerSaving}>×</button>
            <p>活動管理</p>
            <h2>編輯活動</h2>
            <form className="manager-form" onSubmit={updateEvent}>
              <label>活動日期<input name="date" type="date" defaultValue={taipeiInputDate(editingEvent.startsAt)} required /></label>
              <div className="time-pair">
                <label>開始時間<input name="start" type="time" defaultValue={taipeiInputTime(editingEvent.startsAt)} required /></label>
                <label>結束時間<input name="end" type="time" defaultValue={taipeiInputTime(editingEvent.endsAt)} required /></label>
              </div>
              <label>集合／活動場地<input name="courts" defaultValue={editingEvent.courts} required /></label>
              <div className="capacity-fields">
                <label>正取基準人數<input name="regular" type="number" min="1" defaultValue={editingEvent.regular} required /></label>
                <label>候補可參加人數<input name="standby" type="number" min="0" defaultValue={editingEvent.wait} required /></label>
              </div>
              <p className="form-note">社員會自動列為正取並保證名額；社員超過基準人數時不會被排入候補。</p>
              <button className="primary" disabled={managerSaving}>{managerSaving ? "儲存中…" : "儲存變更"}</button>
            </form>
          </section>
        </div>
      )}
      {isAdmin && editingMember && (
        <MemberManagerModal member={editingMember} saving={memberSaving} onClose={() => setEditingMember(null)} save={updateMember} />
      )}
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
  restDays,
  removeRestDay,
}: {
  tab: ActivityManagerTab;
  saving: boolean;
  setTab: (tab: ActivityManagerTab) => void;
  onClose: () => void;
  createEvent: (form: FormEvent<HTMLFormElement>) => void;
  generateWeeklyEvents: (form: FormEvent<HTMLFormElement>) => void;
  addRestDay: (form: FormEvent<HTMLFormElement>) => void;
  restDays: RestDay[];
  removeRestDay: (restDay: RestDay) => void;
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
                正取基準人數
                <input name="regular" type="number" min="1" max="100" defaultValue="10" required />
              </label>
              <label>
                候補可參加人數
                <input name="standby" type="number" min="0" max="100" defaultValue="4" required />
              </label>
            </div>
            <p className="form-note">有效社員建立場次時會自動列為正取並保證名額；非社員使用剩餘正取名額，滿額後才列入候補，候補仍可到場。</p>
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
                每場正取基準人數
                <input name="regular" type="number" min="1" max="100" defaultValue="10" required />
              </label>
              <label>
                每場候補人數
                <input name="standby" type="number" min="0" max="100" defaultValue="4" required />
              </label>
            </div>
            <p className="form-note">已存在的活動與休團日會自動略過；每場都會先將有效社員預設列為正取。</p>
            <button className="primary" disabled={saving}>{saving ? "建立中…" : "建立未來場次"}</button>
          </form>
        )}

        {tab === "rest" && (
          <div className="rest-day-manager">
            <form className="manager-form" onSubmit={addRestDay}>
              <label>
                休團日期
                <input name="date" type="date" required autoFocus />
              </label>
              <label>
                休團原因
                <input name="label" placeholder="例如：國定假日、公司休假" required />
              </label>
              <p className="form-note">若當天已有活動，儲存休團日後會同步取消該活動並處理相關報名與單次帳單。</p>
              <button className="primary" disabled={saving}>{saving ? "儲存中…" : "儲存休團日"}</button>
            </form>
            <section className="rest-day-list" aria-label="已設定休團日">
              <div>
                <strong>已設定休團日</strong>
                <span>{restDays.length} 天</span>
              </div>
              {restDays.length === 0 ? (
                <p>目前沒有休團日</p>
              ) : restDays.map((restDay) => (
                <article key={restDay.id}>
                  <span><strong>{restDay.date}</strong><small>{restDay.label}</small></span>
                  <button type="button" className="link danger" disabled={saving} onClick={() => removeRestDay(restDay)}>移除</button>
                </article>
              ))}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

function AnnouncementModal({
  saving,
  announcement,
  onClose,
  save,
}: {
  saving: boolean;
  announcement: NewsItem | null;
  onClose: () => void;
  save: (form: FormEvent<HTMLFormElement>) => void;
}) {
  const editing = Boolean(announcement);
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
        <h2 id="announcement-modal-title">{editing ? "編輯公告" : "發布公告"}</h2>
        <span>{editing ? "儲存後會立即更新所有使用者看到的內容。" : "公告發布後會立即顯示給所有使用者。"}</span>
        <form className="manager-form" onSubmit={save}>
          <label>
            公告標題
            <input name="title" maxLength={80} defaultValue={announcement?.title ?? ""} placeholder="例如：本週場地異動通知" required autoFocus />
          </label>
          <label>
            公告內容
            <textarea name="content" maxLength={2000} rows={6} defaultValue={announcement?.content ?? ""} placeholder="輸入公告內容…" required />
          </label>
          <label>
            外部連結（選填）
            <input name="linkUrl" type="url" inputMode="url" defaultValue={announcement?.linkUrl ?? ""} placeholder="https://example.com" />
            <small>可附上 Teams、公司內網或其他完整網址。</small>
          </label>
          <p className="form-note">目前支援純文字與外部連結；圖片與檔案上傳將留到下一階段。</p>
          <button className="primary" disabled={saving}>{saving ? "儲存中…" : editing ? "儲存公告" : "發布公告"}</button>
        </form>
      </section>
    </div>
  );
}

function MemberManagerModal({
  member,
  saving,
  onClose,
  save,
}: {
  member: Person;
  saving: boolean;
  onClose: () => void;
  save: (form: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="modal-cover" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="modal manager-modal member-manager-modal" role="dialog" aria-modal="true" aria-labelledby="member-manager-title">
        <button type="button" className="close" onClick={onClose} disabled={saving} aria-label="關閉社員管理視窗">×</button>
        <p>幹部工具</p>
        <h2 id="member-manager-title">管理 {member.name}</h2>
        <span>身分異動立即生效；餘額調整會另外留下帳務與稽核紀錄。</span>
        <form className="manager-form" onSubmit={save}>
          <label>
            部門（選填）
            <input name="department" maxLength={60} defaultValue={member.department ?? ""} placeholder="例如：工程部" autoFocus />
          </label>
          <div className="time-pair">
            <label>
              系統角色
              {member.primaryAdmin ? (
                <><input type="hidden" name="role" value="ADMIN" /><select value="ADMIN" disabled><option value="ADMIN">主要幹部</option></select></>
              ) : (
                <select name="role" defaultValue={member.role === "admin" ? "ADMIN" : "MEMBER"}>
                  <option value="MEMBER">一般使用者</option>
                  <option value="ADMIN">幹部管理者</option>
                </select>
              )}
            </label>
            <label>
              社員身分
              <select name="membershipStatus" defaultValue={member.membershipStatus ?? (member.member ? "MEMBER" : "GUEST")}>
                <option value="GUEST">非社員</option>
                <option value="MEMBER">社員</option>
                {member.membershipStatus === "EXITING" && <option value="EXITING">本期後退出</option>}
              </select>
            </label>
          </div>
          <div className="member-balance-summary">
            <span>目前帳戶餘額</span>
            <strong>NT$ {Number(member.creditBalance ?? 0).toLocaleString("zh-TW")}</strong>
          </div>
          <label>
            餘額調整（選填）
            <input name="balanceAdjustment" type="number" step="1" min="-100000" max="100000" defaultValue="0" />
            <small>正數代表增加可抵扣餘額，負數代表扣除；不調整請維持 0。</small>
          </label>
          <label>
            餘額調整原因
            <input name="adjustmentNote" maxLength={200} placeholder="有調整餘額時必填，例如：特殊退款" />
          </label>
          <p className="form-note">直接改為非社員屬於幹部例外處理，不會自動退款；一般退出請優先使用申請審核流程。</p>
          <button className="primary" disabled={saving}>{saving ? "儲存中…" : "儲存社員資料"}</button>
        </form>
      </section>
    </div>
  );
}

function BillingManagerModal({
  tab,
  setTab,
  saving,
  currentFees,
  feeRates,
  onClose,
  createQuarterlyInvoices,
  saveFeeRates,
}: {
  tab: BillingManagerTab;
  setTab: (tab: BillingManagerTab) => void;
  saving: boolean;
  currentFees: { member: number; guest: number };
  feeRates: FeeRate[];
  onClose: () => void;
  createQuarterlyInvoices: (form: FormEvent<HTMLFormElement>) => void;
  saveFeeRates: (form: FormEvent<HTMLFormElement>) => void;
}) {
  const today = taipeiDateParts(new Date());
  const start = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const end = new Date(Date.UTC(today.year, today.month - 1 + 3, today.day));
  end.setUTCDate(end.getUTCDate() - 1);
  const due = new Date(start);
  due.setUTCDate(due.getUTCDate() + 14);
  const inputDate = (date: Date) => date.toISOString().slice(0, 10);
  const periodLabel = `${today.year} 年 ${today.month} 月起三個月`;

  return (
    <div className="modal-cover" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="modal manager-modal" role="dialog" aria-modal="true" aria-labelledby="billing-manager-title">
        <button type="button" className="close" onClick={onClose} disabled={saving} aria-label="關閉帳務管理視窗">×</button>
        <p>幹部工具</p>
        <h2 id="billing-manager-title">帳務管理</h2>
        <div className="manager-tabs" role="tablist" aria-label="帳務管理功能">
          <button type="button" role="tab" aria-selected={tab === "quarterly"} className={tab === "quarterly" ? "active" : ""} onClick={() => setTab("quarterly")}>建立三個月帳單</button>
          <button type="button" role="tab" aria-selected={tab === "rates"} className={tab === "rates" ? "active" : ""} onClick={() => setTab("rates")}>未來費率</button>
        </div>

        {tab === "quarterly" && (
          <form className="manager-form" onSubmit={createQuarterlyInvoices}>
            <label>帳單期間名稱<input name="label" defaultValue={periodLabel} maxLength={60} required /></label>
            <div className="time-pair">
              <label>開始日期<input name="startDate" type="date" defaultValue={inputDate(start)} required /></label>
              <label>結束日期<input name="endDate" type="date" defaultValue={inputDate(end)} required /></label>
            </div>
            <label>繳費期限<input name="dueDate" type="date" defaultValue={inputDate(due)} required /></label>
            <p className="form-note">系統會統計期間內已排程活動，依各場建立時保存的社員費率加總，為目前社員建立預收帳單，並自動抵扣帳戶餘額。</p>
            <button className="primary" disabled={saving}>{saving ? "建立中…" : "計算並建立帳單"}</button>
          </form>
        )}

        {tab === "rates" && (
          <div className="rate-manager">
            <form className="manager-form" onSubmit={saveFeeRates}>
              <div className="capacity-fields">
                <label>社員每次費用（NT$）<input name="memberAmount" type="number" min="1" max="10000" defaultValue={currentFees.member} required /></label>
                <label>非社員每次費用（NT$）<input name="guestAmount" type="number" min="1" max="10000" defaultValue={currentFees.guest} required /></label>
              </div>
              <label>生效日期<input name="effectiveDate" type="date" defaultValue={inputDate(start)} required /></label>
              <p className="form-note">新費率只套用到生效日之後新建立的活動與三個月帳單，既有活動及帳單維持原金額。</p>
              <button className="primary" disabled={saving}>{saving ? "儲存中…" : "儲存未來費率"}</button>
            </form>
            {feeRates.length > 0 && (
              <section className="rate-history">
                <strong>最近費率紀錄</strong>
                {feeRates.slice(0, 6).map((rate) => (
                  <span key={rate.id}>{rate.kind === "MEMBER_VISIT" ? "社員" : "非社員"} NT${rate.amount} · {rate.effective_from ? taipeiInputDate(rate.effective_from) : "—"} 生效</span>
                ))}
              </section>
            )}
          </div>
        )}
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
  events,
  news,
}: {
  input: string;
  setInput: (value: string) => void;
  createGuest: (name: string) => void;
  recover: (name: string, code: string) => void;
  passkeyLogin: () => void;
  quickAccounts: DeviceAccount[];
  quickLogin: (userId: string) => void;
  saving: boolean;
  events: ClubEvent[];
  news: NewsItem[];
}) {
  const [mode, setMode] = useState<"new" | "recover">("new");
  const [code, setCode] = useState("");
  const upcomingEvents = events.filter((event) => !event.endsAt || new Date(event.endsAt) > new Date()).slice(0, 3);
  return (
    <main className="login public-login">
      <div className="public-shell">
        <section className="public-preview">
          <section className="public-section">
            <div className="public-section-heading"><div><small>UPCOMING</small><h2>近期活動</h2></div><span>{upcomingEvents.length} 場</span></div>
            <div className="public-event-list">
              {upcomingEvents.length === 0 ? <p className="public-empty">目前尚未公布新活動</p> : upcomingEvents.map((event) => (
                <article key={event.id}>
                  <div><strong>{event.date}</strong><small>{event.weekday}</small></div>
                  <span><strong>{event.time}</strong><small>{event.courts}</small></span>
                  <Badge tone="green">尚有 {Math.max(0, event.regular - event.regularBooked) + Math.max(0, event.wait - event.waitBooked)} 位</Badge>
                </article>
              ))}
            </div>
          </section>
          <section className="public-section">
            <div className="public-section-heading"><div><small>NOTICE</small><h2>最新公告</h2></div></div>
            <div className="public-news-list">
              {news.length === 0 ? <p className="public-empty">目前沒有公告</p> : news.slice(0, 3).map((item) => (
                <article key={item.id}><span><strong>{item.title}</strong><small>{item.date}</small></span><p>{item.content}</p>{item.linkUrl && <a href={item.linkUrl} target="_blank" rel="noreferrer">開啟連結 →</a>}</article>
              ))}
            </div>
          </section>
        </section>
        <section className="login-card" id="guest-account">
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
      </div>
    </main>
  );
}

function NotificationPanel({
  notifications,
  saving,
  close,
  openNotification,
  markAll,
}: {
  notifications: ClubNotification[];
  saving: boolean;
  close: () => void;
  openNotification: (notification: ClubNotification) => void;
  markAll: () => void;
}) {
  const unreadCount = notifications.filter((notification) => !notification.read).length;
  const icon: Record<string, string> = { ANNOUNCEMENT: "✦", EVENT: "◷", PAYMENT: "＄", MEMBERSHIP: "♙", TRANSFER: "↔" };
  const displayTime = (value: string | null) => value
    ? new Date(value).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
  return (
    <section className="notification-panel" role="dialog" aria-label="網站通知">
      <header>
        <div><strong>通知中心</strong><span>{unreadCount > 0 ? `${unreadCount} 筆未讀` : "全部已讀"}</span></div>
        <button type="button" className="close-notifications" onClick={close} aria-label="關閉通知">×</button>
      </header>
      {notifications.length === 0 ? (
        <div className="notification-empty"><b>目前沒有通知</b><span>活動、帳單與社員申請異動會顯示在這裡。</span></div>
      ) : (
        <div className="notification-list">
          {notifications.map((notification) => (
            <button type="button" className={notification.read ? "" : "unread"} key={notification.id} onClick={() => openNotification(notification)}>
              <i aria-hidden="true">{icon[notification.type] ?? "•"}</i>
              <span><strong>{notification.title}</strong><small>{notification.message}</small><time>{displayTime(notification.createdAt)}</time></span>
              {!notification.read && <em aria-label="未讀" />}
            </button>
          ))}
        </div>
      )}
      {unreadCount > 0 && <footer><button type="button" className="link" disabled={saving} onClick={markAll}>{saving ? "處理中…" : "全部標示為已讀"}</button></footer>}
    </section>
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
  membershipSaving,
  membershipRequests,
  createRecoveryCode,
  registerPasskey,
  requestMembershipChange,
  logout,
}: {
  viewer: Viewer;
  user: Person;
  recoverySaving: boolean;
  passkeySaving: boolean;
  membershipSaving: boolean;
  membershipRequests: MembershipRequest[];
  createRecoveryCode: () => void;
  registerPasskey: () => void;
  requestMembershipChange: (kind: "JOIN" | "EXIT") => void;
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
  const pendingRequest = membershipRequests.find((request) => request.status === "PENDING");
  const membershipStatusLabel = viewer.membershipStatus === "MEMBER" ? "社員" : viewer.membershipStatus === "EXITING" ? "社員（本期結束後退出）" : "非社員";
  const requestStatus: Record<MembershipRequest["status"], string> = { PENDING: "待審核", APPROVED: "已核准", REJECTED: "未核准" };
  const requestDate = (value: string | null) => value ? new Date(value).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" }) : "—";

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
            <div><dt>社員身分</dt><dd>{membershipStatusLabel}</dd></div>
            <div><dt>系統角色</dt><dd>{user.role === "admin" ? "幹部管理者" : "一般使用者"}</dd></div>
            <div><dt>帳號類型</dt><dd>{accountTypeLabels[viewer.accountType]}</dd></div>
            <div><dt>帳戶餘額</dt><dd>NT$ {viewer.creditBalance.toLocaleString("zh-TW")}</dd></div>
            <div><dt>帳號識別碼</dt><dd><code title={viewer.id}>{shortId}</code></dd></div>
          </dl>
          <p className="account-note">姓名與部門目前由幹部管理；社員身分可在下方提出申請，經幹部審核後生效。</p>
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

      <section className="account-card membership-card">
        <div className="account-card-heading">
          <div>
            <p>社員身分</p>
            <h3>加入或退出申請</h3>
          </div>
          <Badge tone={user.member ? "green" : "gray"}>{membershipStatusLabel}</Badge>
        </div>
        <div className="membership-action">
          <div>
            <strong>{pendingRequest ? `${pendingRequest.kind === "JOIN" ? "加入" : "退出"}申請審核中` : viewer.membershipStatus === "EXITING" ? "會籍將於本期結束" : user.member ? "目前為有效社員" : "目前為非社員"}</strong>
            <span>{pendingRequest ? "幹部完成審核前，身分與計費方式都不會變更。" : user.member ? "退出原則上不退當期費用，核准後仍可使用至本期結束。" : "加入核准後立即生效；若當期已開始，依剩餘活動場次建立費用。"}</span>
          </div>
          {viewer.membershipStatus === "EXITING" ? (
            <button className="secondary" disabled>已排定退出</button>
          ) : (
            <button className={user.member ? "secondary" : "primary small"} disabled={membershipSaving || Boolean(pendingRequest)} onClick={() => requestMembershipChange(user.member ? "EXIT" : "JOIN")}>
              {membershipSaving ? "送出中…" : pendingRequest ? "等待審核" : user.member ? "申請退出社員" : "申請加入社員"}
            </button>
          )}
        </div>
        {membershipRequests.length > 0 && (
          <div className="membership-history">
            {membershipRequests.slice(0, 4).map((request) => (
              <div key={request.id}>
                <span>{requestDate(request.requestedAt)} · {request.kind === "JOIN" ? "加入社員" : "退出社員"}</span>
                <Badge tone={request.status === "APPROVED" ? "green" : request.status === "PENDING" ? "orange" : "gray"}>{requestStatus[request.status]}</Badge>
              </div>
            ))}
          </div>
        )}
      </section>

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
  const displayedRegularCapacity = Math.max(event.regular, regular);
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
  const capacityTitle = user.member && !booking
    ? "社員仍保有正取名額"
    : regularRemaining > 0
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
            <strong>{regular}<span>／{displayedRegularCapacity}</span></strong>
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
                ? "社員已預設列為正取，本次費用包含在三個月社員預收中。"
                : `非社員單次費 NT$${event.guestFee.toLocaleString("zh-TW")}，可到費用管理回報轉帳。`
              : user.member
                ? "社員預設參加並保證正取名額；若曾取消，可以重新恢復參加。"
                : "完成報名後會依剩餘名額列為正取或候補。"}
          </span>
          <div className="status-actions">
            {!booking ? (
              <button className="primary" onClick={join}>{user.member ? "恢復參加" : "我要報名"}</button>
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
              <span>社員均預設正取且保證名額；非社員在正取額滿後才列入候補，候補仍可參加。</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function taipeiInputParts(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

function taipeiInputDate(value?: string) {
  return taipeiInputParts(value)?.date ?? "";
}

function taipeiInputTime(value?: string) {
  return taipeiInputParts(value)?.time ?? "";
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
  transfer: (eventId: string) => void;
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
        const displayedRegularCapacity = Math.max(event.regular, regular);
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
                正取 {regular}/{displayedRegularCapacity} · 候補 {wait}/{event.wait}（社員保證正取，候補也可參加）
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
                    <button className="link" onClick={() => transfer(event.id)}>
                      轉讓
                    </button>
                  )}
                </>
              ) : (
                <button className="primary small" onClick={() => join(event.id)}>
                  {user.member ? "恢復參加" : "報名"}
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
function News({
  news,
  admin,
  saving,
  edit,
  remove,
  togglePinned,
}: {
  news: NewsItem[];
  admin: boolean;
  saving: boolean;
  edit: (announcement: NewsItem) => void;
  remove: (announcement: NewsItem) => void;
  togglePinned: (announcement: NewsItem) => void;
}) {
  return (
    <div className="news-layout">
      <section className="news-list">
        {news.length === 0 ? <div className="news-empty">目前沒有公告</div> : news.map((item) => (
          <article key={item.id}>
            <div>
              <Badge tone={item.pinned ? "green" : "gray"}>{item.pinned ? "置頂" : "公告"}</Badge>
              <small>{item.date}</small>
            </div>
            <h3>{item.title}</h3>
            <p>{item.content}</p>
            <footer className="announcement-footer">
              {item.linkUrl ? <a className="link" href={item.linkUrl} target="_blank" rel="noreferrer">開啟相關連結 →</a> : <span />}
              {admin && (
                <div className="announcement-actions">
                  <button className="link" disabled={saving} onClick={() => togglePinned(item)}>{item.pinned ? "取消置頂" : "置頂"}</button>
                  <button className="link" disabled={saving} onClick={() => edit(item)}>編輯</button>
                  <button className="link danger" disabled={saving} onClick={() => remove(item)}>刪除</button>
                </div>
              )}
            </footer>
          </article>
        ))}
      </section>
    </div>
  );
}
function Members({
  members,
  requests,
  admin,
  saving,
  issueClaimCode,
  reviewRequest,
  manageMember,
}: {
  members: Person[];
  requests: MembershipRequest[];
  admin: boolean;
  saving: boolean;
  issueClaimCode: (person: Person) => void;
  reviewRequest: (request: MembershipRequest, decision: "APPROVE" | "REJECT") => void;
  manageMember: (person: Person) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-Hant");
  const visibleMembers = members.filter((person) => !normalizedQuery || person.name.toLocaleLowerCase("zh-Hant").includes(normalizedQuery) || person.department?.toLocaleLowerCase("zh-Hant").includes(normalizedQuery));
  const pendingRequests = requests.filter((request) => request.status === "PENDING");
  const membershipLabel = (person: Person) => person.membershipStatus === "EXITING" ? "本期後退出" : person.member ? "社員" : "非社員";
  return (
    <div className="member-page">
      {admin && (
        <section className="membership-requests">
          <header>
            <div><p>待辦事項</p><h3>社員申請審核</h3></div>
            <Badge tone={pendingRequests.length > 0 ? "orange" : "green"}>{pendingRequests.length} 筆待處理</Badge>
          </header>
          {pendingRequests.length === 0 ? (
            <div className="membership-request-empty">目前沒有待審核申請</div>
          ) : pendingRequests.map((request) => (
            <article key={request.id}>
              <div>
                <strong>{request.memberName}</strong>
                <span>{request.kind === "JOIN" ? "申請加入社員" : "申請退出社員"} · {request.requestedAt ? new Date(request.requestedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}</span>
              </div>
              <div className="request-actions">
                <button className="secondary" disabled={saving} onClick={() => reviewRequest(request, "REJECT")}>拒絕</button>
                <button className="primary small" disabled={saving} onClick={() => reviewRequest(request, "APPROVE")}>核准</button>
              </div>
            </article>
          ))}
        </section>
      )}
      <section className="table">
        <header>
          <div>
            <p>社員名單</p>
            <h3>一起上場的夥伴</h3>
          </div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋姓名或部門" />
        </header>
        <div className="row head">
          <span>姓名</span>
          <span>部門</span>
          <span>身分</span>
          <span>{admin ? "管理" : "狀態"}</span>
        </div>
        {visibleMembers.length === 0 ? <div className="membership-request-empty">找不到符合的使用者</div> : visibleMembers.map((person) => (
          <div className="row" key={person.id}>
            <strong>
              <i>{person.name[0]}</i>
              {person.name}
            </strong>
            <span>{person.department ?? "—"}</span>
            <span>
              <Badge tone={person.member ? "green" : "gray"}>{membershipLabel(person)}</Badge>
              {person.primaryAdmin && <small className="primary-admin-label">主要幹部</small>}
            </span>
            <span>{admin ? <span className="member-row-actions"><button type="button" className="link" disabled={saving} onClick={() => manageMember(person)}>編輯</button><button type="button" className="link claim-button" disabled={saving} onClick={() => issueClaimCode(person)}>認領碼</button></span> : person.member ? "有效" : "—"}</span>
          </div>
        ))}
      </section>
    </div>
  );
}
function Billing({
  admin,
  invoices,
  viewer,
  saving,
  reportPayment,
  confirmPayment,
  openRates,
}: {
  admin: boolean;
  invoices: Invoice[];
  viewer: Viewer;
  saving: boolean;
  reportPayment: (invoiceId: string) => void;
  confirmPayment: (invoiceId: string) => void;
  openRates: () => void;
}) {
  const status: Record<string, { label: string; tone: "green" | "orange" | "blue" | "gray" }> = {
    PENDING: { label: "待轉帳", tone: "orange" },
    REPORTED: { label: "待幹部確認", tone: "blue" },
    CONFIRMED: { label: "已確認", tone: "green" },
    VOID: { label: "已作廢", tone: "gray" },
    CREDITED: { label: "已轉餘額", tone: "gray" },
  };
  const invoiceType = (invoice: Invoice) => invoice.type === "QUARTERLY_MEMBER" ? "三個月社員預收" : invoice.type === "MEMBERSHIP_PRORATED" ? "中途加入社員費" : invoice.type === "SINGLE_EVENT" ? "非社員單次活動" : "帳務調整";
  const confirmedTotal = invoices.filter((invoice) => invoice.status === "CONFIRMED").reduce((total, invoice) => total + invoice.amount, 0);
  const openInvoices = invoices.filter((invoice) => invoice.status === "PENDING" || invoice.status === "REPORTED");
  const amountDue = openInvoices.reduce((total, invoice) => total + invoice.amount, 0);
  const exportInvoices = () => {
    const escape = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
    const rows = [
      ["使用者", "類型", "期間", "原始金額", "餘額抵扣", "應付金額", "狀態"],
      ...invoices.map((invoice) => [invoice.memberName, invoiceType(invoice), invoice.period_label ?? "", invoice.gross_amount, invoice.credit_applied, invoice.amount, status[invoice.status]?.label ?? invoice.status]),
    ];
    const blob = new Blob([`\uFEFF${rows.map((row) => row.map(escape).join(",")).join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `badminton-invoices-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="billing">
      <section className="billing-top">
        <div>
          <p>{admin ? "帳務總覽" : "我的帳務"}</p>
          <h3>{admin ? "目前收款概況" : "待處理費用"}</h3>
        </div>
        <strong>NT$ {(admin ? confirmedTotal : amountDue).toLocaleString("zh-TW")}</strong>
        <span>{admin ? `${invoices.filter((invoice) => invoice.status === "CONFIRMED").length} 筆已確認 · ${openInvoices.length} 筆待處理` : `${openInvoices.length} 筆待處理 · 帳戶餘額 NT$${viewer.creditBalance.toLocaleString("zh-TW")}`}</span>
      </section>
      <section className="table">
        <header>
          <div>
            <p>{admin ? "帳務清單" : "帳單明細"}</p>
            <h3>{admin ? "付款確認" : "我的帳單紀錄"}</h3>
          </div>
          {admin && <div className="billing-tools"><button className="secondary" onClick={openRates}>費率設定</button><button className="secondary" disabled={invoices.length === 0} onClick={exportInvoices}>匯出 CSV</button></div>}
        </header>
        <div className="row head">
          <span>{admin ? "使用者" : "項目"}</span>
          <span>內容</span>
          <span>金額</span>
          <span>狀態</span>
        </div>
        {invoices.length === 0 ? <div className="billing-empty">目前沒有帳單</div> : invoices.map((invoice) => {
          const invoiceState = status[invoice.status] ?? { label: invoice.status, tone: "gray" as const };
          return (
          <div className="row" key={invoice.id}>
            <strong>{admin ? invoice.memberName : invoiceType(invoice)}</strong>
            <span className="invoice-description"><strong>{invoice.period_label ?? invoiceType(invoice)}</strong>{invoice.credit_applied > 0 && <small>已抵扣餘額 NT${invoice.credit_applied.toLocaleString("zh-TW")}</small>}</span>
            <strong>NT$ {invoice.amount.toLocaleString("zh-TW")}</strong>
            <span className="billing-status">
              <Badge tone={invoiceState.tone}>{invoiceState.label}</Badge>
              {!admin && invoice.status === "PENDING" && <button className="link" disabled={saving} onClick={() => reportPayment(invoice.id)}>我已轉帳</button>}
              {admin && invoice.status === "REPORTED" && <button className="link" disabled={saving} onClick={() => confirmPayment(invoice.id)}>確認收款</button>}
            </span>
          </div>
        );
        })}
      </section>
    </div>
  );
}
