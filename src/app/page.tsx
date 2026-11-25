"use client";

import { type ComponentProps, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import QuarterPlanner, { QuarterPeriodCreator } from "@/app/quarter-planner";
import LoadingScreen from "@/app/loading-screen";
import ShuttleArt from "@/app/shuttle-art";
import BillingDashboard, { type BillingProps } from "@/app/billing-dashboard";
import BalanceHistoryDialog, { type BalanceAdjustmentInput } from "@/app/balance-history-dialog";
import FloatingNotifications from "@/app/floating-notifications";
import { includesEvent, isPrincipal, referencesEvent, type ManagedInvoice, type InvoiceSchedule } from "@/lib/billing-view";
import type { CalendarNotices, OfficialClosure } from "@/lib/official-closures";
import type { QuarterPlan, QuarterBillingPeriod } from "@/lib/quarter-planning";
import { clubIdentityLabel } from "@/lib/club-roles";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

type Role = "admin" | "member";
type Tab = "總覽" | "活動" | "公告" | "球友名單" | "費用管理" | "個人資訊";
const sectionDescriptions: Record<Tab, string> = {
  總覽: "查看下一場活動、出席狀態與費用。",
  活動: "從月曆找場次，查看場地、名額與報名資訊。",
  公告: "查看球友會的最新消息與重要通知。",
  球友名單: "按社員身分查看球友，或搜尋姓名、帳號與部門。",
  費用管理: "查看付款狀態、應繳費用與帳單紀錄。",
  個人資訊: "管理顯示名稱、社員身分與帳號安全。",
};
const sidebarItems: { label: Exclude<Tab, "個人資訊">; icon: ReactNode }[] = [
  {
    label: "總覽",
    icon: <><path d="m3 10 9-6.5 9 6.5M5.5 9v9.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9" /><path d="M9.5 20v-5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v5" /></>,
  },
  {
    label: "活動",
    icon: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4m10-4v4M3 10h18M7.5 14h.5m3.75 0h.5m3.75 0h.5m-9 3.5h.5m3.75 0h.5m3.75 0h.5" /></>,
  },
  {
    label: "公告",
    icon: <><path d="M5 9.5h4l11-4v13l-11-4H5a2.5 2.5 0 0 1 0-5Zm4 0v5" /><path d="m5.5 14.5 1.25 4.6A1.9 1.9 0 0 0 8.6 20.5H10l-1.5-6" /></>,
  },
  {
    label: "球友名單",
    icon: <><circle cx="9" cy="8" r="3" /><circle cx="17.5" cy="9" r="2.5" /><path d="M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1m2-5h.5a3.5 3.5 0 0 1 3.5 3.5V20" /></>,
  },
  {
    label: "費用管理",
    icon: <><path d="M19 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-2M4 8h15a2 2 0 0 1 2 2v2" /><path d="M21 12h-5a2 2 0 0 0 0 4h5v-4Zm-5 2h.01" /></>,
  },
];
type ActivityManagerTab = "single" | "quarter";
type BillingManagerTab = "quarterly" | "rates";
type Person = { id: string; name: string; accountName?: string; department?: string; role: Role; member: boolean; membershipStatus?: string; membershipEndingAt?: string | null; creditBalance?: number; primaryAdmin?: boolean; canReceivePresidency?: boolean };
type Booking = { memberId: string; name: string; accountName?: string; kind: "社員" | "非社員"; rank: "正取" | "候補"; transferred?: boolean };
type NewsItem = { id: string; title: string; content: string; date: string; linkUrl?: string; pinned: boolean };
type Invoice = ManagedInvoice;
type FeeRate = { id: string; kind: string; amount: number; effective_from: string | null; effective_to: string | null };
type MembershipRequest = { id: string; memberId: string; memberName: string; accountName?: string; kind: "JOIN" | "EXIT"; status: "PENDING" | "APPROVED" | "REJECTED"; requestedAt: string | null; reviewedAt: string | null };
type ClubNotification = { id: string; title: string; message: string; type: string; tab: string; createdAt: string | null; read: boolean };
type Viewer = {
  id: string;
  name: string;
  accountName: string;
  department: string | null;
  role: "ADMIN" | "MEMBER";
  primaryAdmin: boolean;
  membershipStatus: string;
  membershipEndingAt?: string | null;
  creditBalance: number;
  accountType: "guest" | "recoverable" | "verified" | "unclaimed";
  hasRecoveryCode: boolean;
  hasPasskey: boolean;
};
type GuestSettlementDecision = { memberId: string; decision: "BILL" | "SKIP" };
type GuestSettlement = { memberId: string; status: "ISSUED" | "SKIPPED" | "LEGACY"; amount: number | null };
type GuestSettlementReceipt = { issued: number; skipped: number };
type QuarterInvoicePreviewRow = { memberId: string; name: string; eventCount: number; grossAmount: number; creditApplied: number; amount: number };
type QuarterInvoicePreview = { periodLabel: string; rows: QuarterInvoicePreviewRow[]; totalAmount: number; previewKey: string };
type EventCancellationPreview = {
  previewKey: string; cancelledBookings: number; reducedAmount: number; creditedAmount: number;
  pendingCreditAmount: number; pendingCashRefundAmount?: number; legacyReviewAmount?: number;
};
type ActionResult = Partial<GuestSettlementReceipt & QuarterInvoicePreview & EventCancellationPreview> & { creditBalance?: number; memberId?: string; adjustmentInvoiceId?: string; results?: { id: string; success: boolean; error?: string }[]; invoiceId?: string; planId?: string; recoveryCode?: string; claimCode?: string; recipientName?: string; invoiceCount?: number; eventCount?: number; totalAmount?: number; periodLabel?: string; createdDate?: string | null; targetDate?: string; status?: string; skippedDates?: string[]; skippedEventIds?: string[]; periodId?: string; recorded?: number; alreadyRecorded?: number };
type DeviceAccount = { id: string; name: string; accountName: string; role: "ADMIN" | "MEMBER"; membershipStatus: string; primaryAdmin: boolean };
type ClubEvent = {
  id: string;
  memberBilling?: string;
  eventKind?: string;
  quarterEligible?: boolean;
  status?: string;
  cancellationReason?: string | null;
  billingLabel?: string | null;
  guestSettlements?: GuestSettlement[];
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
  memberListRate?: number;
  guestFee: number;
  bookings: Booking[];
};

type ApiState = {
  viewer: Viewer | null;
  members: { id: string; name: string; accountName: string; department?: string; role: string; membershipStatus: string; membershipEndingAt?: string | null; creditBalance?: number; primaryAdmin?: boolean; canReceivePresidency?: boolean }[];
  events: { id: string; starts_at: string; ends_at: string; courts: string; regular_capacity: number; standby_capacity: number; regular_count: number; standby_count: number; member_fee: number; member_list_rate?: number; guest_fee: number; member_billing?: string; event_kind?: string; quarter_eligible?: boolean; status?: string; member_billing_label?: string | null; guest_settlements?: GuestSettlement[]; bookings: { memberId: string; name: string; accountName?: string; kind: string; status: string; transferred?: boolean }[] }[];
  announcements: { id: string; title: string; content: string; publishedAt: string; linkUrl?: string; pinned: boolean }[];
  invoices: Invoice[];
  quarterPlans: QuarterPlan[];
  quarterBillingPeriods?: QuarterBillingPeriod[];
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
  const [sessionError, setSessionError] = useState(false);
  const [input, setInput] = useState("");
  const [authSaving, setAuthSaving] = useState(false);
  const [passkeySaving, setPasskeySaving] = useState(false);
  const [recoverySaving, setRecoverySaving] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [quickAccounts, setQuickAccounts] = useState<DeviceAccount[]>([]);
  const [codeNotice, setCodeNotice] = useState<{ title: string; body: string; code: string } | null>(null);
  const [tab, setTab] = useState<Tab>("總覽");
  const [billingEventId, setBillingEventId] = useState<string | null>(null);
  const [events, setEvents] = useState<ClubEvent[]>([]);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [members, setMembers] = useState<Person[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [quarterPlans, setQuarterPlans] = useState<QuarterPlan[]>([]);
  const [quarterBillingPeriods, setQuarterBillingPeriods] = useState<QuarterBillingPeriod[]>([]);
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
  const [eventDetails, setEventDetails] = useState<{ eventId: string; viewerId: string } | null>(null);
  const [managerTab, setManagerTab] = useState<ActivityManagerTab>("quarter");
  const [managerOpen, setManagerOpen] = useState(false);
  const [managerDate, setManagerDate] = useState("");
  const [managerSaving, setManagerSaving] = useState(false);
  const [announcementOpen, setAnnouncementOpen] = useState(false);
  const [editingAnnouncement, setEditingAnnouncement] = useState<NewsItem | null>(null);
  const [announcementSaving, setAnnouncementSaving] = useState(false);
  const [billingManagerOpen, setBillingManagerOpen] = useState(false);
  const [calendarBillIds, setCalendarBillIds] = useState<string[]>([]);
  const [calendarQuarterMode, setCalendarQuarterMode] = useState(false);
  const [calendarPickedIds, setCalendarPickedIds] = useState<string[]>([]);
  const [calendarIssueOpen, setCalendarIssueOpen] = useState(false);
  const [billingManagerTab, setBillingManagerTab] = useState<BillingManagerTab>("quarterly");
  const [billingSaving, setBillingSaving] = useState(false);
  const [membershipSaving, setMembershipSaving] = useState(false);
  const [presidencySaving, setPresidencySaving] = useState(false);
  const [editingMember, setEditingMember] = useState<Person | null>(null);
  const [memberSaving, setMemberSaving] = useState(false);
  const [claimCodeSaving, setClaimCodeSaving] = useState(false);

  useEffect(() => {
    if (!managerOpen && !announcementOpen && !billingManagerOpen && !editingMember && !codeNotice) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.getElementById("member-balance-history") && !(managerOpen && managerSaving) && !memberSaving && !claimCodeSaving && !codeNotice) {
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
  }, [managerOpen, managerSaving, announcementOpen, billingManagerOpen, editingMember, memberSaving, claimCodeSaving, codeNotice]);

  const applyState = useCallback((state: ApiState) => {
    setViewer(state.viewer);
    setQuickAccounts(state.quickAccounts ?? []);
    setMembers(state.members.map((member) => ({ id: member.id, name: member.name, accountName: member.accountName, department: member.department, role: member.role === "ADMIN" ? "admin" : "member", member: member.membershipStatus === "MEMBER" || member.membershipStatus === "EXITING", membershipStatus: member.membershipStatus, membershipEndingAt: member.membershipEndingAt, creditBalance: Number(member.creditBalance ?? 0), primaryAdmin: Boolean(member.primaryAdmin), canReceivePresidency: Boolean(member.canReceivePresidency) })));
    setEvents(state.events.map((item) => {
      const startsAt = new Date(item.starts_at);
      const endsAt = new Date(item.ends_at);
      const date = `${startsAt.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric" })} ${startsAt.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", day: "numeric" })}`;
      const time = `${startsAt.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false })} – ${endsAt.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false })}`;
      return { id: item.id, memberBilling: item.member_billing, quarterEligible: item.quarter_eligible, eventKind: item.event_kind, billingLabel: item.member_billing_label, status: item.status, guestSettlements: item.guest_settlements, startsAt: item.starts_at, endsAt: item.ends_at, date, weekday: startsAt.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", weekday: "short" }), time, courts: item.courts, regular: item.regular_capacity, wait: item.standby_capacity, regularBooked: item.regular_count, waitBooked: item.standby_count, memberFee: item.member_fee, memberListRate: item.member_list_rate, guestFee: item.guest_fee, bookings: item.bookings.map((booking) => ({ memberId: booking.memberId, name: booking.name, accountName: booking.accountName, transferred: booking.transferred, kind: booking.kind === "MEMBER" ? "社員" : "非社員", rank: booking.status === "REGULAR" ? "正取" : "候補" })) };
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
    setQuarterPlans(state.quarterPlans ?? []);
    setQuarterBillingPeriods(state.quarterBillingPeriods ?? []);
    setFeeRates(state.feeRates ?? []);
    setMembershipRequests(state.membershipRequests ?? []);
    setNotifications(state.notifications ?? []);
    setCurrentFees(state.currentFees ?? { member: 150, guest: 180 });
  }, []);

  const refresh = useCallback((signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(20000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return fetch("/api/club", { cache: "no-store", signal: requestSignal }).then(async (response) => {
      if (!response.ok) throw new Error("Unable to load club data");
      return await response.json() as ApiState;
    }).then((state) => {
      if (signal?.aborted) return;
      applyState(state);
      setSessionReady(true);
    }).catch(() => {
      if (!signal?.aborted) setSessionError(true);
    });
  }, [applyState]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const execute = async (action: string, data: Record<string, string>) => {
    const response = await fetch("/api/club", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...data }) });
    const payload = await response.json() as ApiState & { error?: string };
    if (!response.ok) {
      if (response.status === 401) setViewer(null);
      window.alert(payload.error ?? "資料庫操作失敗");
      return null;
    }
    if (action !== "previewCancelEvent" && action !== "previewQuarterlyInvoices" && action !== "previewMemberExtraBills") applyState(payload);
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
      ? { id: viewer.id, name: viewer.name, accountName: viewer.accountName, department: viewer.department ?? undefined, role: viewer.role === "ADMIN" ? "admin" : "member", member: viewer.membershipStatus === "MEMBER" || viewer.membershipStatus === "EXITING", membershipStatus: viewer.membershipStatus, creditBalance: viewer.creditBalance, primaryAdmin: viewer.primaryAdmin }
      : { id: "", name: "", role: "member", member: false },
    [viewer],
  );
  const event = events.find((item) => !item.endsAt || new Date(item.endsAt) > new Date());
  const headerDate = event?.startsAt ? new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "long" }).format(new Date(event.startsAt)) : "台北時間 · UTC+8";
  const booking = event?.bookings.find((item) => item.memberId === viewer?.id);
  const personalInvoices = invoices.filter((item) => item.member_id === viewer?.id && isPrincipal(item));
  const invoice = personalInvoices.find((item) => item.status === "PENDING")
    ?? personalInvoices.find((item) => item.status === "REPORTED")
    ?? personalInvoices.find((item) => item.status === "CONFIRMED");
  const createGuest = async (candidate: string) => {
    const clean = candidate.trim();
    if (!clean) return;
    setAuthSaving(true);
    try {
      const created = await execute("createGuest", { accountName: clean });
      if (created) setInput("");
    } finally {
      setAuthSaving(false);
    }
  };
  const recover = async (candidate: string, code: string) => {
    setAuthSaving(true);
    try {
      const payload = await execute("recover", { accountName: candidate.trim(), code: code.trim() });
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
    if (replaceExisting && !window.confirm("重新產生後，原本的復原碼會立即失效，新碼也只顯示一次。確定要繼續嗎？")) return;
    setRecoverySaving(true);
    try {
      const payload = await execute("createRecoveryCode", {});
      if (payload?.actionResult?.recoveryCode) {
        setCodeNotice({
          title: replaceExisting ? "請保存新的復原碼" : "請保存你的復原碼",
          body: replaceExisting
            ? "原本的復原碼已失效。這組新碼只會顯示一次，請立即複製並放在安全的地方。"
            : "這組碼只會顯示一次。清除瀏覽器資料或更換裝置時，可用固定的帳號名稱與此碼取回帳號。",
          code: payload.actionResult.recoveryCode,
        });
      }
    } finally {
      setRecoverySaving(false);
    }
  };
  const saveDisplayName = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    if (!viewer || profileSaving) return false;
    const displayName = String(new FormData(form.currentTarget).get("displayName") ?? "").trim();
    if (!displayName) {
      window.alert("請輸入顯示名稱");
      return false;
    }
    setProfileSaving(true);
    try {
      return Boolean(await execute("updateDisplayName", { displayName }));
    } catch {
      window.alert("無法儲存顯示名稱，請稍後再試。");
      return false;
    } finally {
      setProfileSaving(false);
    }
  };
  const issueClaimCode = async (person: Person) => {
    if (claimCodeSaving || memberSaving) return;
    setClaimCodeSaving(true);
    try {
      const payload = await execute("issueClaimCode", { memberId: person.id });
      if (payload?.actionResult?.claimCode) {
        setCodeNotice({
          title: `請將認領碼交給${person.name}`,
          body: `使用者可在登入頁選擇「取回既有帳號」，輸入帳號名稱「${person.accountName ?? person.name}」與此碼。代碼只會顯示一次，請透過可信任的方式交付。`,
          code: payload.actionResult.claimCode,
        });
      }
    } catch {
      window.alert("無法產生認領碼，請稍後再試。");
    } finally {
      setClaimCodeSaving(false);
    }
  };
  const join = async (eventId: string) => { if (viewer) await execute("join", { eventId }); };
  const cancel = async (eventId: string) => { if (viewer) await execute("cancel", { eventId }); };
  const submitTransfer = async () => {
    const clean = recipient.trim();
    if (!clean || !viewer || !transferEventId) return;
    const payload = await execute("transfer", { eventId: transferEventId, recipient: clean });
    if (payload) {
      setRecipient("");
      setTransferEventId(null);
      if (payload.actionResult?.claimCode) {
        setCodeNotice({ title: "請將認領碼交給接手者", body: `請在登入頁輸入帳號名稱「${clean}」與這組認領碼開啟帳號。此碼只會顯示一次。`, code: payload.actionResult.claimCode });
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
      if (await execute("createEvent", { ...times, eventKind: String(data.get("eventKind") ?? "BADMINTON"), memberBilling: String(data.get("memberBilling") ?? "FREE"), memberAmount: String(data.get("memberAmount") ?? ""), guestAmount: String(data.get("guestAmount") ?? ""), courts: String(data.get("courts")), regularCapacity: String(data.get("regular")), standbyCapacity: String(data.get("standby")) })) {
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
      if (await execute("updateEvent", { eventId: editingEvent.id, ...times, memberBilling: String(data.get("memberBilling") ?? ""), memberAmount: String(data.get("memberAmount") ?? ""), guestAmount: String(data.get("guestAmount") ?? ""), courts: String(data.get("courts")), regularCapacity: String(data.get("regular")), standbyCapacity: String(data.get("standby")) })) {
        setEditingEvent(null);
      }
    } finally {
      setManagerSaving(false);
    }
  };
  const previewClubEventCancellation = async (eventId: string): Promise<EventCancellationPreview | null> => {
    const result = (await execute("previewCancelEvent", { eventId }))?.actionResult;
    return result && typeof result.previewKey === "string" && typeof result.cancelledBookings === "number"
      ? { previewKey: result.previewKey, cancelledBookings: result.cancelledBookings, reducedAmount: result.reducedAmount ?? 0,
          creditedAmount: result.creditedAmount ?? 0, pendingCreditAmount: result.pendingCreditAmount ?? 0,
          pendingCashRefundAmount: result.pendingCashRefundAmount, legacyReviewAmount: result.legacyReviewAmount }
      : null;
  };

  const confirmQuarter = async (input: { planId: string; schedule: string }) => {
    setManagerSaving(true);
    try {
      const payload = await execute("confirmQuarterPlan", input);
      return payload?.actionResult ?? null;
    } finally { setManagerSaving(false); }
  };
  const reportInvoicePayment = async (invoiceId: string) => {
    setBillingSaving(true);
    try {
      await execute("reportPayment", { invoiceId });
    } finally {
      setBillingSaving(false);
    }
  };

  const manageInvoiceAction = async (action: string, input: Record<string, string>) => {
    setBillingSaving(true);
    try { const payload = await execute(action, input); return payload?.actionResult ?? null; }
    finally { setBillingSaving(false); }
  };
  const remindInvoicePayment = async (invoiceId: string) => {
    setBillingSaving(true);
    try {
      const payload = await execute("remindPayment", { invoiceId });
      if (payload) window.alert("已發送站內催款通知。");
    } finally {
      setBillingSaving(false);
    }
  };
  const previewQuarterlyInvoices = async (input: { planId: string; dueDate: string }): Promise<QuarterInvoicePreview | null> => {
    const result = await manageInvoiceAction("previewQuarterlyInvoices", input);
    return result && Array.isArray(result.rows) && typeof result.previewKey === "string"
      && typeof result.periodLabel === "string" && typeof result.totalAmount === "number"
      ? { rows: result.rows, previewKey: result.previewKey, periodLabel: result.periodLabel, totalAmount: result.totalAmount } : null;
  };
  const createQuarterlyInvoices = async (input: { planId: string; dueDate: string; previewKey: string }): Promise<boolean> => {
    setBillingSaving(true);
    try {
      const payload = await execute("createQuarterlyInvoices", input);
      if (payload) {
        const result = payload.actionResult;
        window.alert(`已建立 ${result?.invoiceCount ?? 0} 筆社員帳單，共計 ${result?.eventCount ?? 0} 場活動、NT$${Number(result?.totalAmount ?? 0).toLocaleString("zh-TW")}。`);
        setBillingManagerOpen(false);
        return true;
      }
      return false;
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
  const transferPresidency = async (memberId: string) => {
    const target = members.find((member) => member.id === memberId && member.canReceivePresidency);
    if (!viewer?.primaryAdmin || !target || presidencySaving) return;
    if (!window.confirm("確定要將社長權限轉交給「" + target.name + "」（" + (target.accountName ? "帳號：" + target.accountName : target.id.slice(0, 8)) + "）嗎？\n轉交後你將成為一般社員，無法再使用幹部功能。")) return;
    setPresidencySaving(true);
    try {
      if (await execute("transferPresident", { memberId, confirmed: "true" })) {
        window.alert("社長權限已轉交，你目前為一般社員。如需退出，可在個人資訊提出退社申請。");
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "轉交失敗，請重新整理確認目前社長後再試。");
    } finally {
      setPresidencySaving(false);
    }
  };
  const requestMembershipChange = async (kind: "JOIN" | "EXIT") => {
    if (kind === "EXIT" && viewer?.primaryAdmin) {
      window.alert("您目前是社長，請先在個人資訊轉交社長權限，再提出退社申請。");
      return;
    }
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
    if (!editingMember || memberSaving || claimCodeSaving || codeNotice) return;
    const data = new FormData(form.currentTarget);
    setMemberSaving(true);
    try {
      if (await execute("updateMember", {
        memberId: editingMember.id,
        department: String(data.get("department") ?? "").trim(),
        role: String(data.get("role") ?? "MEMBER"),
        membershipStatus: String(data.get("membershipStatus") ?? "GUEST"),
      })) {
        setEditingMember(null);
      }
    } finally {
      setMemberSaving(false);
    }
  };
  const adjustMemberBalance = async (input: BalanceAdjustmentInput) => {
    const response = await fetch("/api/club", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "adjustMemberBalance", ...input }),
    });
    const payload = await response.json() as ApiState & { error?: string };
    if (!response.ok) {
      if (response.status === 401) setViewer(null);
      throw new Error(payload.error ?? "無法儲存餘額調整，請稍後重試。");
    }
    applyState(payload);
    const balance = payload.actionResult?.creditBalance ?? payload.members.find((member) => member.id === input.memberId)?.creditBalance;
    if (typeof balance === "number" && Number.isSafeInteger(balance)) {
      setEditingMember((current) => current?.id === input.memberId ? { ...current, creditBalance: balance } : current);
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
    const destination = notification.tab === "社員名單" ? "球友名單" : notification.tab;
    if (Object.hasOwn(sectionDescriptions, destination)) setTab(destination as Tab);
  };
  const unreadNotifications = notifications.filter((notification) => !notification.read);

  if (!sessionReady) return <LoadingScreen
    error={sessionError}
    title={sessionError ? "暫時無法載入" : "正在準備球場…"}
    description={sessionError ? "連線逾時或暫時無法取得資料，請檢查網路後再試一次。" : "正在讀取活動與帳號資訊，請稍候。"}
    onRetry={() => { setSessionError(false); void refresh(); }}
  />;
  if (!viewer) return <Login input={input} setInput={setInput} createGuest={createGuest} recover={recover} passkeyLogin={loginWithPasskey} quickAccounts={quickAccounts} quickLogin={quickLogin} saving={authSaving || passkeySaving} events={events} news={news} />;
  const isAdmin = user.role === "admin";
  const detailId = eventDetails?.viewerId === viewer.id ? eventDetails.eventId : null;
  const detailInvoices = detailId ? invoices.filter((invoice) => isPrincipal(invoice) && (isAdmin || invoice.member_id === viewer.id) && (invoice.event_id === detailId || invoice.event_ids?.includes(detailId))) : [];
  const selectedEvent = detailId ? events.find((item) => item.id === detailId)
    ?? archivedClubEvent(detailInvoices.flatMap((invoice) => invoice.event_schedules ?? []).find((entry) => entry.id === detailId)) : undefined;
  const openEventDetails = (eventId: string) => setEventDetails({ eventId, viewerId: viewer.id });
  const toggleQuarterBillingEvent = (event: ClubEvent) => {
    const eligible = (item: ClubEvent) => hasBillToIssue(calendarBillingOptions(item, invoices, quarterBillingPeriods, Date.now()));
    const selection = calendarPickedIds.filter((id) => events.some((item) => item.id === id && eligible(item)));
    if (selection.includes(event.id)) { setCalendarPickedIds(selection.filter((id) => id !== event.id)); return ""; }
    if (!eligible(event)) return "本場目前沒有可開立的帳單。";
    setCalendarPickedIds([...selection, event.id]);
    return "";
  };
  const openCalendarBilling = (ids: string[]) => { setCalendarBillIds(ids); setBillingManagerTab("quarterly"); setBillingManagerOpen(true); };
  const closeEventDetails = () => setEventDetails(null);
  return (
    <div className="app">
      <a className="skip-to-content" href="#club-main">跳至主要內容</a>
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
          <b role="img" aria-label="羽球">
            <svg viewBox="-8 -4 84 88" fill="none" aria-hidden="true" focusable="false">
              <g transform="rotate(-18 32 40)">
                <ShuttleArt />
              </g>
            </svg>
          </b>
          <span>
            <strong>球友會</strong>
            <small>BADMINTON CLUB</small>
          </span>
        </div>
        <nav aria-label="球友會導覽">
          {sidebarItems.map(({ label, icon }) => (
            <button
              key={label}
              type="button"
              className={tab === label ? "nav-active" : ""}
              aria-label={label}
              aria-current={tab === label ? "page" : undefined}
              title={sidebarCollapsed ? label : undefined}
              onClick={() => { setTab(label); setNotificationOpen(false); }}
            >
              <svg className="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                {icon}
              </svg>
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="profile">
          <button
            type="button"
            className="profile-link"
            aria-label={`個人資訊，${user.name}`}
            aria-current={tab === "個人資訊" ? "page" : undefined}
            title="個人資訊"
            onClick={() => { setTab("個人資訊"); setNotificationOpen(false); }}
          >
            <b className="profile-avatar" aria-hidden="true">{user.name[0]}</b>
            <span className="profile-copy">
              <strong title={user.name}>{user.name}</strong>
              <small>{clubIdentityLabel(user)}</small>
            </span>
            <span className="profile-mobile-label" aria-hidden="true">帳號</span>
          </button>
        </div>
      </aside>
      <main id="club-main" tabIndex={-1}>
        <header>
          <div className="page-heading">
            <p className="page-eyebrow">{headerDate}</p>
            <h1>{tab}</h1>
            <p className="page-description">{sectionDescriptions[tab]}</p>
          </div>
          <div className="header-actions">
            {tab === "總覽" && event && <button type="button" className="link view-all-activities" onClick={() => setTab("活動")}>查看全部活動 →</button>}
            {isAdmin && tab === "活動" && <button type="button" className="secondary small calendar-quarter-toggle" aria-pressed={calendarQuarterMode} onClick={() => {
              setCalendarQuarterMode(!calendarQuarterMode);
              setCalendarPickedIds([]);
            }}>{calendarQuarterMode ? "離開收費模式" : "活動收費"}</button>}
            {isAdmin && (tab === "活動" || tab === "公告") && (
              <button
                className="primary small"
                onClick={() => {
                  if (tab === "活動") {
                    setManagerDate("");
                    setManagerTab("quarter");
                    setManagerOpen(true);
                  } else {
                    setTab("公告");
                    setEditingAnnouncement(null);
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
            showEvents={() => setTab("活動")}
            showEventDetails={openEventDetails}
            showBilling={() => setTab("費用管理")}
          />
        )}
        {tab === "活動" && (
          <div className="activities-page">
            <ActivityCalendar
              list={events}
              invoices={invoices}
              openEvent={openEventDetails}
              openIssue={isAdmin ? () => setCalendarIssueOpen(true) : undefined}
              quarterMode={isAdmin && calendarQuarterMode}
              pickedIds={calendarPickedIds}
              setPickedIds={setCalendarPickedIds}
              toggleQuarterEvent={toggleQuarterBillingEvent}
              periods={isAdmin ? quarterBillingPeriods : []}
              createOnDate={isAdmin ? (date) => { setManagerDate(date); setManagerTab("single"); setManagerOpen(true); } : undefined}
            />
          </div>
        )}
        {tab === "公告" && <News news={news} admin={isAdmin} saving={announcementSaving} edit={(announcement) => { setEditingAnnouncement(announcement); setAnnouncementOpen(true); }} remove={(announcement) => void deleteAnnouncement(announcement)} togglePinned={(announcement) => void toggleAnnouncementPinned(announcement)} />}
        {tab === "球友名單" && <Members members={members} requests={membershipRequests} currentUser={user} admin={isAdmin} saving={membershipSaving || memberSaving || claimCodeSaving} requestMembership={() => void requestMembershipChange("JOIN")} reviewRequest={reviewMembershipRequest} manageMember={setEditingMember} />}
        {tab === "費用管理" && (
          <Billing
            admin={isAdmin}
            invoices={invoices}
            events={events}
            focusEventId={billingEventId}
            clearFocusEvent={() => setBillingEventId(null)}
            openEvent={openEventDetails}
            manage={manageInvoiceAction}
            viewer={viewer}
            saving={billingSaving}
            reportPayment={reportInvoicePayment}
            remindPayment={remindInvoicePayment}
            openRates={() => {
              setCalendarBillIds([]);
              setBillingManagerTab("rates");
              setBillingManagerOpen(true);
            }}
          />
        )}
        {tab === "個人資訊" && (
          <AccountProfile
            key={viewer.id}
            viewer={viewer}
            user={user}
            profileSaving={profileSaving}
            saveDisplayName={saveDisplayName}
            recoverySaving={recoverySaving}
            passkeySaving={passkeySaving}
            membershipSaving={membershipSaving}
            presidencySaving={presidencySaving}
            members={members}
            transferPresidency={(memberId) => void transferPresidency(memberId)}
            membershipRequests={membershipRequests}
            createRecoveryCode={() => void makeRecoveryCode(viewer.hasRecoveryCode)}
            registerPasskey={() => void registerPasskey()}
            requestMembershipChange={(kind) => void requestMembershipChange(kind)}
            logout={() => void logout()}
          />
        )}
      </main>
      <FloatingNotifications
        open={notificationOpen}
        unreadCount={unreadNotifications.length}
        onToggle={() => setNotificationOpen((open) => !open)}
        onClose={() => setNotificationOpen(false)}
      >
        {notificationOpen && <NotificationPanel
          notifications={notifications}
          saving={notificationSaving}
          close={() => setNotificationOpen(false)}
          openNotification={(notification) => void openNotification(notification)}
          markAll={() => void markNotificationsRead(unreadNotifications.map((notification) => notification.id))}
        />}
      </FloatingNotifications>
      {selectedEvent && (
        <EventDetailsDialog
          key={selectedEvent.id}
          event={selectedEvent}
          billingInvoices={isAdmin ? detailInvoices : undefined}
          viewerId={viewer.id}
          user={user}
          isAdmin={isAdmin}
          close={closeEventDetails}
          join={join}
          cancel={cancel}
          transfer={() => { closeEventDetails(); setTransferEventId(selectedEvent.id); }}
          edit={() => { closeEventDetails(); setEditingEvent(selectedEvent); }}
          invoiceLabel={detailInvoices.some((invoice) => !["VOID", "CREDITED", "REFUNDED"].includes(invoice.status) && ["QUARTERLY_MEMBER", "MEMBERSHIP_PRORATED"].includes(invoice.type)) ? "已納入季度社費" : detailInvoices.some((invoice) => !["VOID", "CREDITED", "REFUNDED"].includes(invoice.status) && invoice.type === "MEMBER_EXTRA") ? "加場費已開單" : detailInvoices.some((invoice) => !["VOID", "CREDITED", "REFUNDED"].includes(invoice.status)) ? "已開單" : null}
          showEventBills={detailInvoices.length ? () => { setBillingEventId(selectedEvent.id); setTab("費用管理"); closeEventDetails(); } : undefined}
          previewCancellation={() => previewClubEventCancellation(selectedEvent.id)}
          cancelEvent={async (reason, previewKey) => {
            if (!await execute("cancelEvent", { eventId: selectedEvent.id, reason, previewKey })) return false;
            closeEventDetails();
            return true;
          }}
        />
      )}
      {transferEventId && (
        <div className="modal-cover">
          <section className="modal">
            <button className="close" onClick={() => setTransferEventId(null)}>
              ×
            </button>
            <p>名額轉讓</p>
            <h2>指定本次接手者</h2>
            <span>請輸入接手者固定的帳號名稱；顯示名稱可重複，無法用來查找帳號。接手者會列為非社員，並記錄為「私下結清」。</span>
            <input
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="輸入接手者帳號名稱"
              aria-label="接手者帳號名稱"
            />
            <button className="primary" onClick={submitTransfer}>
              確認轉讓
            </button>
          </section>
        </div>
      )}
      {isAdmin && managerOpen && (
        <ActivityManagerModal
          initialDate={managerDate}
          currentFees={currentFees}
          feeRates={feeRates}
          periods={quarterBillingPeriods}
          tab={managerTab}
          saving={managerSaving}
          setTab={setManagerTab}
          onClose={() => setManagerOpen(false)}
          createEvent={createEvent}
          plans={quarterPlans}
          existingDates={events.flatMap((event) => event.startsAt && event.eventKind !== "OTHER" ? [taipeiInputDate(event.startsAt)] : [])}
          confirmQuarter={confirmQuarter}
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
      {isAdmin && tab === "活動" && calendarIssueOpen && !billingManagerOpen && (
        <CalendarIssueDialog
          events={events.filter((item) => calendarPickedIds.includes(item.id))}
          invoices={invoices} periods={quarterBillingPeriods}
          close={() => setCalendarIssueOpen(false)}
          openQuarter={openCalendarBilling}
          refresh={async () => { await refresh(); }}
          publishGuest={async (eventId, decisions) => {
            const result = (await execute("publishGuestEventBills", { eventId, decisions: JSON.stringify(decisions) }))?.actionResult;
            return typeof result?.issued === "number" && typeof result.skipped === "number" ? { issued: result.issued, skipped: result.skipped } : null;
          }}
          previewExtra={async (eventId) => {
            const result = (await execute("previewMemberExtraBills", { eventId }))?.actionResult;
            return result && Array.isArray(result.rows) && typeof result.previewKey === "string" && typeof result.totalAmount === "number"
              ? { rows: result.rows, previewKey: result.previewKey, totalAmount: result.totalAmount, periodLabel: result.periodLabel ?? "社員加場費" }
              : null;
          }}
          publishExtra={async (eventId, previewKey, reason) => Boolean(await execute("publishMemberExtraBills", { eventId, previewKey, reason }))}
        />
      )}
      {isAdmin && billingManagerOpen && (
        <BillingManagerModal
          tab={billingManagerTab}
          setTab={setBillingManagerTab}
          saving={billingSaving}
          currentFees={currentFees}
          feeRates={feeRates}
          periods={quarterBillingPeriods}
          calendarBillIds={calendarBillIds}
          events={events}
          createBillingPeriod={async (input) => {
            const result = await manageInvoiceAction("createQuarterBillingPeriod", input);
            return result && typeof result.periodId === "string" && typeof result.eventCount === "number"
              ? { periodId: result.periodId, eventCount: result.eventCount, totalAmount: result.totalAmount ?? 0, skippedEventIds: result.skippedEventIds ?? [] }
              : null;
          }}
          onClose={() => setBillingManagerOpen(false)}
          previewQuarterlyInvoices={previewQuarterlyInvoices} createQuarterlyInvoices={createQuarterlyInvoices}
          saveFeeRates={saveFeeRates}
        />
      )}
      {editingEvent && (
        <div className="modal-cover">
          <section className="modal manager-modal" role="dialog" aria-modal="true" aria-labelledby="edit-event-title">
            <button type="button" className="close" aria-label="關閉編輯活動" onClick={() => setEditingEvent(null)} disabled={managerSaving}>×</button>
            <p>活動管理</p>
            <h2 id="edit-event-title">編輯活動</h2>
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
              <EditEventBillingFields key={editingEvent.id} event={editingEvent} invoices={invoices} periods={quarterBillingPeriods} currentFees={currentFees} />
              <p className="form-note">社員會自動列為正取並保證名額；社員超過基準人數時不會被排入候補。</p>
              <button className="primary" disabled={managerSaving}>{managerSaving ? "儲存中…" : "儲存變更"}</button>
            </form>
          </section>
        </div>
      )}
      {isAdmin && editingMember && (
        <MemberManagerModal member={editingMember} saving={memberSaving} covered={Boolean(codeNotice)} claimCodeSaving={claimCodeSaving} issueClaimCode={issueClaimCode} adjustBalance={adjustMemberBalance} onClose={() => setEditingMember(null)} save={updateMember} />
      )}
      {codeNotice && <CodeNotice notice={codeNotice} onClose={() => {
        setCodeNotice(null);
        if (editingMember) requestAnimationFrame(() => document.querySelector<HTMLElement>(".member-account-menu summary")?.focus());
      }} />}
    </div>
  );
}

function EditEventBillingFields({ event, invoices, periods, currentFees }: {
  event: ClubEvent;
  invoices: Invoice[];
  periods: QuarterBillingPeriod[];
  currentFees: { member: number; guest: number };
}) {
  const [mode, setMode] = useState(event.memberBilling === "FREE" || event.eventKind === "OTHER" ? "FREE" : "NORMAL");
  const [memberPrice, setMemberPrice] = useState(String(event.memberListRate ?? (event.memberFee > 0 ? event.memberFee : currentFees.member)));
  const [guestPrice, setGuestPrice] = useState(String(event.guestFee > 0 ? event.guestFee : currentFees.guest));

  const relevant = invoices.filter((bill) => isPrincipal(bill) && isLiveInvoice(bill) && referencesEvent(bill, event.id));
  const memberLocked = event.memberBilling === "EXTRA" || relevant.some((bill) => bill.type !== "SINGLE_EVENT")
    || periods.some((period) => period.status !== "PLANNED" && period.eventIds.includes(event.id));
  const guestLocked = relevant.some((bill) => bill.type === "SINGLE_EVENT")
    || event.guestSettlements?.some((entry) => entry.status === "LEGACY" || entry.status === "ISSUED");
  const modeLocked = memberLocked || guestLocked || event.eventKind === "OTHER";
  return <>
    <label>活動收費<select name="memberBilling" disabled={modeLocked} value={mode} onChange={(event) => setMode(event.target.value)}>
      <option value="NORMAL">收費</option><option value="FREE">不收費</option>
    </select></label>
    {mode === "NORMAL" && <div className="new-event-fee-preview">
      <div className="new-event-fee-fields" role="group" aria-label="每人費用">
        <label>社員（NT$／人）<input name="memberAmount" type="number" min={1} max={10000} step={1} inputMode="numeric" required disabled={memberLocked}
          value={memberPrice} onChange={(event) => setMemberPrice(event.target.value)} /></label>
        <label>非社員（NT$／人）<input name="guestAmount" type="number" min={1} max={10000} step={1} inputMode="numeric" required disabled={guestLocked}
          value={guestPrice} onChange={(event) => setGuestPrice(event.target.value)} /></label>
      </div>
      {(memberLocked || guestLocked) && <p className="form-note">{memberLocked && guestLocked ? "本場已開單，價格不可修改。"
        : memberLocked ? "社員費已開單或正在開單。非社員費仍可修改。" : "非社員費已開單。社員費仍可修改。"}</p>}
      {!memberLocked && event.memberBilling === "NO_CHARGE" && <p className="form-note">社員金額只會用在另開的單場帳單。</p>}
    </div>}
  </>;
}

function ActivityManagerModal({
  initialDate,
  currentFees,
  feeRates,
  periods,
  tab,
  saving,
  setTab,
  onClose,
  createEvent,
  plans,
  existingDates,
  confirmQuarter,
}: {
  initialDate: string;
  currentFees: { member: number; guest: number };
  feeRates: FeeRate[];
  periods: QuarterBillingPeriod[];
  tab: ActivityManagerTab;
  saving: boolean;
  setTab: (tab: ActivityManagerTab) => void;
  onClose: () => void;
  createEvent: (form: FormEvent<HTMLFormElement>) => void;
  plans: QuarterPlan[];
  existingDates: string[];
  confirmQuarter: (input: { planId: string; schedule: string }) => Promise<ActionResult | null>;
}) {
  const [eventKind, setEventKind] = useState("BADMINTON");
  const [memberBilling, setMemberBilling] = useState("NORMAL");
  const [eventDate, setEventDate] = useState(initialDate);
  const [startTime, setStartTime] = useState("18:00");
  const [customMemberAmount, setCustomMemberAmount] = useState<string>();
  const [customGuestAmount, setCustomGuestAmount] = useState<string>();
  const startsAt = eventDate && startTime ? Date.parse(`${eventDate}T${startTime}:00+08:00`) : NaN;
  const dated = Number.isFinite(startsAt);
  const rateFor = (kind: "MEMBER_VISIT" | "GUEST_VISIT", fallback: number) => feeRates
    .filter((rate) => rate.kind === kind && rate.effective_from && Date.parse(rate.effective_from) <= startsAt &&
      (!rate.effective_to || startsAt < Date.parse(rate.effective_to)))
    .sort((a, b) => Date.parse(b.effective_from!) - Date.parse(a.effective_from!))[0]?.amount ?? fallback;
  const memberCovered = dated && periods.some((period) =>
    ["ACTIVE", "GENERATING"].includes(period.status) && period.startDate <= eventDate && eventDate <= period.endDate);
  const memberAmount = dated ? rateFor("MEMBER_VISIT", 150) : currentFees.member;
  const guestAmount = dated ? rateFor("GUEST_VISIT", 180) : currentFees.guest;

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
          <button type="button" role="tab" aria-selected={tab === "single"} className={tab === "single" ? "active" : ""} onClick={() => setTab("single")} disabled={saving}>
            單次加場
          </button>
          <button type="button" role="tab" aria-selected={tab === "quarter"} className={tab === "quarter" ? "active" : ""} onClick={() => setTab("quarter")} disabled={saving}>
            季度規劃
          </button>
        </div>

        {tab === "single" && (
          <form className="manager-form" onSubmit={createEvent}>
            <label>
              活動日期
              <input name="date" type="date" value={eventDate} onChange={(event) => setEventDate(event.target.value)} required autoFocus />
            </label>
            <div className="time-pair">
              <label>
                開始時間
                <input name="start" type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} required />
              </label>
              <label>
                結束時間
                <input name="end" type="time" defaultValue="20:00" required />
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
            <label>活動類型<select name="eventKind" value={eventKind} onChange={(event) => setEventKind(event.target.value)}><option value="BADMINTON">羽球</option><option value="OTHER">其他免費活動（例如桌遊）</option></select></label>
            {eventKind === "BADMINTON" && <p className="form-note">有效社員預設列為正取。非社員額滿後列候補。</p>}
            {eventKind === "BADMINTON" ? <>
              <label>活動收費
                <select name="memberBilling" value={memberBilling} onChange={(event) => setMemberBilling(event.target.value)} aria-describedby={memberBilling === "FREE" ? "new-event-fee-note" : undefined}>
                  <option value="NORMAL">收費</option>
                  <option value="FREE">不收費</option>
                </select>
              </label>
              {memberBilling === "NORMAL" && <div className="new-event-fee-preview" aria-live="polite">
                <div className="new-event-fee-fields" role="group" aria-label="每人費用">
                  <label>社員（NT$／人）<input name="memberAmount" type="number" inputMode="numeric" min={1} max={10000} step={1} required value={customMemberAmount ?? memberAmount} onChange={(event) => setCustomMemberAmount(event.target.value)} /></label>
                  <label>非社員（NT$／人）<input name="guestAmount" type="number" inputMode="numeric" min={1} max={10000} step={1} required value={customGuestAmount ?? guestAmount} onChange={(event) => setCustomGuestAmount(event.target.value)} /></label>
                </div>
                {memberCovered && <p className="form-note">該季已開單或正在開單，社員金額只會用在另開的單場帳單。</p>}
              </div>}
              {memberBilling === "FREE" && <p id="new-event-fee-note" className="form-note">社員、非社員都不收費。</p>}
            </> : <input type="hidden" name="memberBilling" value="FREE" />}
            <button className="primary" disabled={saving}>{saving ? "建立中…" : "建立活動"}</button>
          </form>
        )}

        {tab === "quarter" && <QuarterPlanner plans={plans} existingDates={existingDates} saving={saving} confirmPlan={confirmQuarter} />}
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
  claimCodeSaving = false,
  covered = false,
  issueClaimCode,
  adjustBalance,
  onClose,
  save,
}: {
  member: Person;
  saving: boolean;
  claimCodeSaving?: boolean;
  covered?: boolean;
  issueClaimCode: (person: Person) => void;
  adjustBalance: (input: BalanceAdjustmentInput) => Promise<void>;
  onClose: () => void;
  save: (form: FormEvent<HTMLFormElement>) => void;
}) {
  const balanceTrigger = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeBalanceHistory = () => {
    setHistoryOpen(false);
    requestAnimationFrame(() => balanceTrigger.current?.focus());
  };
  const accountMenu = useRef<HTMLDetailsElement>(null);
  const accountEntry = useRef<HTMLButtonElement>(null);
  const claimAction = useRef<HTMLButtonElement>(null);
  const [accountMenuPage, setAccountMenuPage] = useState<"settings" | "account">("settings");
  const busy = saving || claimCodeSaving || covered;
  return (
    <>
    <div className="modal-cover" role="presentation" inert={covered || historyOpen} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="modal manager-modal member-manager-modal" role="dialog" aria-modal="true" aria-labelledby="member-manager-title" onKeyDown={(event) => {
        if (event.key === "Escape" && accountMenu.current?.open) {
          event.preventDefault();
          event.stopPropagation();
          accountMenu.current.open = false;
          accountMenu.current.querySelector("summary")?.focus();
        }
      }}>
        <div className="member-manager-actions">
          <details className="member-account-menu" ref={accountMenu} onToggle={(event) => { if (!event.currentTarget.open) setAccountMenuPage("settings"); }}>
            <summary aria-label="社員設定" title="社員設定" aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
            </summary>
            <div className="member-account-menu-panel">
              {accountMenuPage === "settings" ? (
                <button ref={accountEntry} type="button" className="link member-account-entry" disabled={busy} onClick={() => {
                  setAccountMenuPage("account");
                  requestAnimationFrame(() => claimAction.current?.focus());
                }}>帳號管理<span aria-hidden="true">›</span></button>
              ) : (
                <>
                  <button type="button" className="link member-account-back" disabled={busy} onClick={() => {
                    setAccountMenuPage("settings");
                    requestAnimationFrame(() => accountEntry.current?.focus());
                  }}><span aria-hidden="true">‹</span> 帳號管理</button>
                  <button ref={claimAction} type="button" className="link" disabled={busy} onClick={() => {
                    if (accountMenu.current) {
                      accountMenu.current.open = false;
                      accountMenu.current.querySelector("summary")?.focus();
                    }
                    void issueClaimCode(member);
                  }}>{claimCodeSaving ? "產生中…" : "產生認領碼"}</button>
                  <small>供使用者在其他裝置找回帳號。新碼會取代舊認領碼，只顯示一次。</small>
                </>
              )}
            </div>
          </details>
          <button type="button" className="close" onClick={onClose} disabled={busy} aria-label="關閉社員管理視窗">×</button>
        </div>
        <p>幹部工具</p>
        <h2 id="member-manager-title">管理 {member.name}</h2>
        {member.accountName && <p className="account-name">帳號：{member.accountName}</p>}
        <span>可管理部門與社員身分；餘額調整請點選下方的目前帳戶餘額。</span>

        <form className="manager-form" onSubmit={save}>
          <label>
            部門（選填）
            <input name="department" maxLength={60} defaultValue={member.department ?? ""} placeholder="例如：工程部" autoFocus />
          </label>
          <div className="time-pair">
            <label>
              系統角色
              {member.primaryAdmin ? (
                <><input type="hidden" name="role" value="ADMIN" /><select value="ADMIN" disabled><option value="ADMIN">社長（須先轉交權限）</option></select></>
              ) : (
                <select name="role" defaultValue={member.role === "admin" ? "ADMIN" : "MEMBER"}>
                  <option value="MEMBER">一般使用者</option>
                  <option value="ADMIN">幹部管理者</option>
                </select>
              )}
            </label>
            <label>
              社員身分
              {member.primaryAdmin ? (
                <><input type="hidden" name="membershipStatus" value="MEMBER" /><select value="MEMBER" disabled><option value="MEMBER">社員（社長不可直接退社）</option></select></>
              ) : (
                <select name="membershipStatus" defaultValue={member.membershipStatus ?? (member.member ? "MEMBER" : "GUEST")}>
                  <option value="GUEST">非社員</option>
                  <option value="MEMBER">社員</option>
                  {member.membershipStatus === "EXITING" && <option value="EXITING">本期後退出</option>}
                </select>
              )}
            </label>
          </div>
          <button ref={balanceTrigger} type="button" className="member-balance-summary" disabled={busy} aria-haspopup="dialog" aria-expanded={historyOpen} aria-controls="member-balance-history" onClick={() => setHistoryOpen(true)}>
            <span><span>目前帳戶餘額</span><small>查看紀錄與調整 ›</small></span>
            <strong>NT$ {Number(member.creditBalance ?? 0).toLocaleString("zh-TW")}</strong>
          </button>
          <p className="form-note">直接改為非社員屬於幹部例外處理，不會自動退款；一般退出請優先使用申請審核流程。</p>
          <button className="primary" disabled={busy}>{saving ? "儲存中…" : "儲存社員資料"}</button>
        </form>
      </section>
    </div>
    {historyOpen && <BalanceHistoryDialog key={member.id} member={member} adjustBalance={adjustBalance} onClose={closeBalanceHistory} />}
    </>
  );
}

function BillingManagerModal({
  tab,
  setTab,
  saving,
  currentFees,
  feeRates,
  periods,
  calendarBillIds,
  events,
  createBillingPeriod,
  onClose,
  previewQuarterlyInvoices,
  createQuarterlyInvoices,
  saveFeeRates,
}: {
  tab: BillingManagerTab;
  setTab: (tab: BillingManagerTab) => void;
  saving: boolean;
  currentFees: { member: number; guest: number };
  feeRates: FeeRate[];
  periods: QuarterBillingPeriod[];
  calendarBillIds: string[];
  events: ClubEvent[];
  createBillingPeriod: ComponentProps<typeof QuarterPeriodCreator>["onCreate"];
  onClose: () => void;
  previewQuarterlyInvoices: (input: { planId: string; dueDate: string }) => Promise<QuarterInvoicePreview | null>;
  createQuarterlyInvoices: (input: { planId: string; dueDate: string; previewKey: string }) => Promise<boolean>;
  saveFeeRates: (form: FormEvent<HTMLFormElement>) => void;
}) {
  const today = taipeiDateParts(new Date());
  const start = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const due = new Date(start);
  due.setUTCDate(due.getUTCDate() + 14);
  const inputDate = (date: Date) => date.toISOString().slice(0, 10);
  const billablePlans = periods.filter((period) => period.status === "PLANNED" || period.status === "GENERATING");
  const pickedDate = events.find((event) => event.id === calendarBillIds[0])?.startsAt;
  const pickedDay = pickedDate ? taipeiInputDate(pickedDate) : "";
  const matchingDraft = billablePlans.find((period) => period.status === "PLANNED" && period.revision
    && period.startDate <= pickedDay && pickedDay <= period.endDate);
  const [selectedPlanId, setSelectedPlanId] = useState(matchingDraft?.id ?? (calendarBillIds.length ? "" : billablePlans[0]?.id ?? ""));
  const selectedPlan = billablePlans.find((plan) => plan.id === selectedPlanId);
  const [dueDate, setDueDate] = useState(() => inputDate(due));
  const [quarterPreview, setQuarterPreview] = useState<(QuarterInvoicePreview & { planId: string; dueDate: string }) | null>(null);
  const [quarterError, setQuarterError] = useState("");
  const [draftEditor, setDraftEditor] = useState<"new" | "edit" | null>(() => matchingDraft ? "edit" : calendarBillIds.length || !billablePlans.length ? "new" : null);
  const matchingPreview = quarterPreview?.planId === selectedPlanId && quarterPreview.dueDate === dueDate ? quarterPreview : null;
  const money = (amount: number) => "NT$ " + amount.toLocaleString("zh-TW");

  const submitQuarter = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    if (saving || draftEditor || !selectedPlan || !dueDate) return;
    setQuarterError("");
    const input = { planId: selectedPlanId, dueDate };
    try {
      if (!matchingPreview) {
        const result = await previewQuarterlyInvoices(input);
        if (result) setQuarterPreview({ ...result, ...input });
        else setQuarterError("無法產生預覽，請檢查季度與期限後重試。");
        return;
      }
      if (!matchingPreview.rows.length) return;
      const success = await createQuarterlyInvoices({ ...input, previewKey: matchingPreview.previewKey });
      if (!success) {
        setQuarterPreview(null);
        setQuarterError("未完成開單，請重新預覽後再確認。");
      }
    } catch {
      setQuarterPreview(null);
      setQuarterError("無法核對帳單結果。請重新預覽並確認是否已開單。");
    }
  };

  return (
    <div className="modal-cover" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="modal manager-modal" role="dialog" aria-modal="true" aria-labelledby="billing-manager-title">
        <button type="button" className="close" onClick={onClose} disabled={saving} aria-label="關閉帳務管理視窗">×</button>
        <p>幹部工具</p>
        <h2 id="billing-manager-title">帳務管理</h2>
        <div className="manager-tabs" role="tablist" aria-label="帳務管理功能">
          <button type="button" role="tab" aria-selected={tab === "quarterly"} className={tab === "quarterly" ? "active" : ""} onClick={() => setTab("quarterly")}>季度社費</button>
          <button type="button" role="tab" aria-selected={tab === "rates"} className={tab === "rates" ? "active" : ""} onClick={() => setTab("rates")}>未來費率</button>
        </div>

        {tab === "quarterly" && <>
          <div className="event-dialog-actions">
            <button type="button" className="secondary" aria-expanded={draftEditor === "new"} disabled={saving} onClick={() => setDraftEditor((current) => current === "new" ? null : "new")}>{draftEditor === "new" ? "收合新增期間" : "＋ 新增社費期間"}</button>
            {selectedPlan?.status === "PLANNED" && selectedPlan.revision && <button type="button" className="link" aria-expanded={draftEditor === "edit"} disabled={saving} onClick={() => setDraftEditor((current) => current === "edit" ? null : "edit")}>{draftEditor === "edit" ? "收合編輯" : "調整本期場次"}</button>}
          </div>
          {draftEditor && <QuarterPeriodCreator key={draftEditor === "edit" ? selectedPlan?.id : "new"} initialPeriod={draftEditor === "edit" ? selectedPlan : undefined} initialEventIds={calendarBillIds} initialDate={pickedDay} events={events} saving={saving} onCreate={createBillingPeriod} onCreated={async (id) => {
            setSelectedPlanId(id); setQuarterPreview(null); setQuarterError(""); setDraftEditor(null);
            if (calendarBillIds.length && dueDate) {
              const result = await previewQuarterlyInvoices({ planId: id, dueDate });
              if (result) setQuarterPreview({ ...result, planId: id, dueDate });
              else setQuarterError("草稿已儲存，請重新預覽。");
            }
          }} />}
          <form className="manager-form" onSubmit={(event) => void submitQuarter(event)}>
            <label>待開單的社費期間<select name="planId" value={selectedPlanId} disabled={saving} onChange={(event) => { setSelectedPlanId(event.target.value); setQuarterPreview(null); setQuarterError(""); setDraftEditor(null); }} required>
              <option value="">選擇季度</option>
              {billablePlans.map((plan) => <option key={plan.id} value={plan.id}>{plan.label} · {plan.eventCount} 場</option>)}
            </select></label>
            {selectedPlan && <div className="quarter-summary"><strong>{selectedPlan.startDate} ～ {selectedPlan.endDate}</strong><span>季度原始基準：{selectedPlan.eventCount} 場 · {money(Number(selectedPlan.grossAmount))}（全季）</span></div>}
            <label>繳費期限<input name="dueDate" type="date" min={inputDate(start)} value={dueDate} disabled={saving} onChange={(event) => { setDueDate(event.target.value); setQuarterPreview(null); setQuarterError(""); }} required /></label>
            <p className="form-note">先核對每位社員的計費場次與餘額抵扣。預覽不會開單；確認後才正式建立帳單。</p>
            {!selectedPlan && <p className="form-note">選擇已有的社費期間，或先建立含收費場次的草稿。</p>}
            {matchingPreview && (
              <section className="quarter-invoice-review" aria-labelledby="quarter-invoice-preview-title">
                <strong id="quarter-invoice-preview-title">{matchingPreview.periodLabel} · 開單預覽</strong>
                {matchingPreview.rows.length ? (
                  <>
                    <p className="guest-settlement-review" role="status">{matchingPreview.rows.length} 筆 · 抵扣後合計 {money(matchingPreview.totalAmount)}</p>
                    <ul>{matchingPreview.rows.map((row) => <li key={row.memberId}>
                      <span><strong>{row.name}</strong><small>{row.eventCount} 場 · 原始 {money(row.grossAmount)}{row.creditApplied > 0 && " · 抵扣 " + money(row.creditApplied)}</small></span>
                      <strong>{money(row.amount)}</strong>
                    </li>)}</ul>
                  </>
                ) : <p className="form-note" role="status">沒有符合計費條件的社員，無須開單。</p>}
              </section>
            )}
            {quarterError && <p className="guest-settlement-error" role="alert">{quarterError}</p>}
            <button className="primary guest-settlement-trigger" disabled={saving || !!draftEditor || !selectedPlan || Boolean(matchingPreview && !matchingPreview.rows.length)}>{saving ? "處理中…" : matchingPreview ? "確認開立社員帳單" : "預覽社員帳單"}</button>
          </form>
          {periods.some((period) => period.status === "ACTIVE") && <details className="billing-more"><summary>已開單期間</summary><ul>
            {periods.filter((period) => period.status === "ACTIVE").map((period) => <li key={period.id}>{period.label} · {period.startDate} ～ {period.endDate} · {period.eventCount} 場</li>)}
          </ul></details>}
        </>}

        {tab === "rates" && (
          <div className="rate-manager">
            <form className="manager-form" onSubmit={saveFeeRates}>
              <div className="capacity-fields">
                <label>社員每次費用（NT$）<input name="memberAmount" type="number" min="1" max="10000" defaultValue={currentFees.member} required /></label>
                <label>非社員零打費（NT$）<input name="guestAmount" type="number" min="1" max="10000" defaultValue={currentFees.guest} required /></label>
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
  createGuest: (accountName: string) => void;
  recover: (accountName: string, code: string) => void;
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
        <span>{mode === "new" ? "第一次使用只需設定一個不重複的帳號名稱，建立後固定不變。顯示名稱初始相同，登入後可自行修改。" : "輸入原本固定的帳號名稱與認領碼或復原碼，即可在這台裝置取回帳號。"}</span>
        {quickAccounts.length > 0 && (
          <aside className="quick-accounts">
            <strong>這台裝置的快速登入</strong>
            <div>
              {quickAccounts.map((account) => (
                <button type="button" key={account.id} disabled={saving} onClick={() => quickLogin(account.id)}>
                  <i>{account.name.slice(0, 1)}</i>
                  <span>
                    <b>{account.name}</b>
                    <small>帳號：{account.accountName ?? account.name}</small>
                    <small>{clubIdentityLabel(account)}</small>
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
          <label htmlFor="login-account-name">帳號名稱</label>
          <input id="login-account-name" value={input} onChange={(e) => setInput(e.target.value)} placeholder="輸入固定的帳號名稱" maxLength={40} required autoComplete="username" />
          {mode === "recover" && (
            <>
              <label htmlFor="login-recovery-code">認領碼或復原碼</label>
              <input id="login-recovery-code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX" maxLength={19} required autoComplete="one-time-code" />
            </>
          )}
          <button className="primary" disabled={saving}>{saving ? "處理中…" : mode === "new" ? "建立這台裝置的帳號" : "取回帳號"}</button>
        </form>
        <div className="login-divider"><span>或</span></div>
        <button type="button" className="passkey-button" disabled={saving} onClick={passkeyLogin}>
          <strong>使用 Passkey 登入</strong>
          <span>使用指紋、臉部辨識或裝置 PIN</span>
        </button>
        {saving && <LoadingScreen compact title="正在處理登入…" description="若出現裝置驗證視窗，請依提示完成。" />}
        <aside className="notice">
          <strong>測試版帳號提醒</strong>
          <span>帳號名稱固定且不得重複（英文大小寫、全半形與多餘空白視為相同）；顯示名稱可自行修改，也可與他人相同。已有帳號請使用快速登入、Passkey 或復原碼。建議先在「個人資訊 → 登入與安全」設定至少一種復原方式。</span>
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
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected && previousFocus !== document.body) previousFocus.focus();
    };
  }, []);
  const copyCode = async () => {
    await navigator.clipboard.writeText(notice.code);
    window.alert("已複製");
  };
  return (
    <div className="modal-cover" role="presentation">
      <section ref={dialog} className="modal code-modal" role="dialog" aria-modal="true" aria-labelledby="code-notice-title" onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
        if (!buttons?.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}>
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
  profileSaving = false,
  saveDisplayName = (form: FormEvent<HTMLFormElement>) => { form.preventDefault(); return false; },
  recoverySaving,
  passkeySaving,
  membershipSaving,
  presidencySaving,
  members,
  transferPresidency,
  membershipRequests,
  createRecoveryCode,
  registerPasskey,
  requestMembershipChange,
  logout,
}: {
  viewer: Viewer;
  user: Person;
  profileSaving?: boolean;
  saveDisplayName?: (form: FormEvent<HTMLFormElement>) => boolean | Promise<boolean>;
  recoverySaving: boolean;
  passkeySaving: boolean;
  membershipSaving: boolean;
  presidencySaving: boolean;
  members: Person[];
  transferPresidency: (memberId: string) => void;
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
  const shortId = viewer.id.length > 16 ? `${viewer.id.slice(0, 8)}…${viewer.id.slice(-4)}` : viewer.id;
  const [editingName, setEditingName] = useState(false);
  const editNameButton = useRef<HTMLButtonElement>(null);
  const finishNameEdit = () => {
    setEditingName(false);
    requestAnimationFrame(() => editNameButton.current?.focus());
  };
  const [transferOpen, setTransferOpen] = useState(false);
  const [successorId, setSuccessorId] = useState("");
  const ownRequests = membershipRequests.filter((request) => request.memberId === viewer.id);
  const pendingRequest = ownRequests.find((request) => request.status === "PENDING");
  const successors = members.filter((member) => member.id !== viewer.id && member.canReceivePresidency);
  const exiting = viewer.membershipStatus === "EXITING";
  const requestDate = (value?: string | null) => {
    const date = new Date(value ?? "");
    return Number.isFinite(date.getTime()) ? date.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" }) : null;
  };
  const endingDate = exiting ? requestDate(viewer.membershipEndingAt) : null;
  const requestStatus: Record<MembershipRequest["status"], string> = { PENDING: "待審核", APPROVED: "已核准", REJECTED: "未核准" };

  return (
    <section className="account-page">
      <section className="account-card identity-card" aria-labelledby="profile-identity-title">
        <h2 id="profile-identity-title" className="account-card-title">個人資料</h2>
        {editingName ? (
          <form className="display-name-form" onSubmit={async (form) => { if (await saveDisplayName(form)) finishNameEdit(); }}>
            <label htmlFor="profile-display-name">顯示名稱</label>
            <input key={viewer.id + ":" + viewer.name} id="profile-display-name" name="displayName" defaultValue={viewer.name} maxLength={40} required autoComplete="nickname" autoFocus aria-describedby="profile-display-name-help" disabled={profileSaving} />
            <small id="profile-display-name-help">最多 40 字，不會變更固定的帳號名稱。</small>
            <div className="display-name-actions">
              <button type="button" className="secondary" disabled={profileSaving} onClick={finishNameEdit}>取消</button>
              <button type="submit" className="primary" disabled={profileSaving}>{profileSaving ? "儲存中…" : "儲存"}</button>
            </div>
          </form>
        ) : (
          <div className="account-hero">
            <span className="account-avatar" aria-hidden="true">{Array.from(viewer.name)[0] ?? "球"}</span>
            <div className="account-hero-copy">
              <strong>{viewer.name}</strong>
              <span>{clubIdentityLabel(viewer)}</span>
            </div>
            <button ref={editNameButton} type="button" className="link display-name-edit" aria-label="修改顯示名稱" onClick={() => setEditingName(true)}>改顯示名稱</button>
          </div>
        )}
        <dl className="account-details">
          <div><dt>帳號名稱 <span>（固定）</span></dt><dd><code>{viewer.accountName ?? viewer.name}</code></dd></div>
          <div><dt>部門</dt><dd>{user.department || "未填寫"}</dd></div>
          <div><dt>帳戶餘額</dt><dd>NT$ {viewer.creditBalance.toLocaleString("zh-TW")}</dd></div>
        </dl>
        <details className="account-disclosure">
          <summary>更多帳號資訊</summary>
          <dl className="account-details">
            <div><dt>帳號類型</dt><dd>{accountTypeLabels[viewer.accountType]}</dd></div>
            <div><dt>帳號識別碼</dt><dd><code title={viewer.id}>{shortId}</code></dd></div>
          </dl>
          <p className="account-note">帳號名稱用於取回帳號與名額轉讓。部門由幹部管理。</p>
        </details>
      </section>

      <section className="account-card membership-card" aria-labelledby="profile-membership-title">
          <h2 id="profile-membership-title" className="account-card-title">我的會籍</h2>
          <div className="membership-action">
            <div>
              <strong>{viewer.primaryAdmin ? "社長須先轉交權限才能退社" : pendingRequest ? `${pendingRequest.kind === "JOIN" ? "加入" : "退出"}申請審核中` : exiting ? "會籍即將結束" : user.member ? "目前為社員" : "目前為非社員"}</strong>
              {exiting ? <span>{endingDate ? `社員身分有效至 ${endingDate}。` : "社員身分有效至本期結束。"}</span> : pendingRequest ? <span>審核前，身分與計費方式不變。</span> : null}
            </div>
            {viewer.primaryAdmin ? (
              <button type="button" className="secondary" disabled={presidencySaving} aria-expanded={transferOpen} aria-controls="presidency-transfer-form" onClick={() => setTransferOpen((open) => !open)}>轉交社長權限</button>
            ) : exiting ? (
              <Badge tone="orange">已排定退出</Badge>
            ) : (
              <button className={user.member ? "secondary" : "primary small"} disabled={membershipSaving || Boolean(pendingRequest)} onClick={() => requestMembershipChange(user.member ? "EXIT" : "JOIN")}>
                {membershipSaving ? "送出中…" : pendingRequest ? "等待審核" : user.member ? "申請退出社員" : "申請加入社員"}
              </button>
            )}
          </div>
          {viewer.primaryAdmin && transferOpen && (
            <form className="manager-form" id="presidency-transfer-form" onSubmit={(event) => { event.preventDefault(); transferPresidency(successorId); }}>
              {successors.length === 0 ? (
                <p className="form-note">目前沒有可接任的社員，暫時不能退社。請先新增或核准其他社員加入、完成帳號認領，並處理其待審核退出申請。</p>
              ) : (
                <>
                  <label>接任社員
                    <select value={successorId} onChange={(event) => setSuccessorId(event.target.value)} required disabled={presidencySaving}>
                      <option value="">請選擇接任社員</option>
                      {successors.map((member) => <option key={member.id} value={member.id}>{member.name}{member.department ? " · " + member.department : ""} · {member.accountName ? "帳號：" + member.accountName : member.id.slice(0, 8)}</option>)}
                    </select>
                  </label>
                  <p className="form-note">轉交後立即生效，你將成為一般社員。原有活動與帳單不變。</p>
                  <button className="primary" disabled={presidencySaving || !successors.some((member) => member.id === successorId)}>{presidencySaving ? "轉交中…" : "確認轉交社長權限"}</button>
                </>
              )}
            </form>
          )}
          {ownRequests.length > 0 && (
            <details className="account-disclosure">
              <summary>申請紀錄</summary>
              <ul className="membership-history">
                {ownRequests.slice(0, 4).map((request) => (
                  <li key={request.id}>
                    <span>{requestDate(request.requestedAt) ?? "日期未記錄"} · {request.kind === "JOIN" ? "加入社員" : "退出社員"}</span>
                    <Badge tone={request.status === "APPROVED" ? "green" : request.status === "PENDING" ? "orange" : "gray"}>{requestStatus[request.status]}</Badge>
                  </li>
                ))}
              </ul>
            </details>
          )}
      </section>

      <section className="account-card security-card" aria-labelledby="profile-security-title">
        <h2 id="profile-security-title" className="account-card-title">登入與安全</h2>
        {!viewer.hasRecoveryCode && !viewer.hasPasskey && (
          <p className="recovery-reminder">還沒設定取回帳號的方式。建議先建立 Passkey 或復原碼，以免換裝置後無法登入。</p>
        )}

        <article className="security-method">
          <div className="security-copy">
            <div><strong>Passkey</strong><Badge tone={viewer.hasPasskey ? "green" : "gray"}>{viewer.hasPasskey ? "已啟用" : "未設定"}</Badge></div>
            <p>用指紋、臉部辨識或裝置 PIN 登入。</p>
          </div>
          <button className={viewer.hasPasskey ? "secondary" : "primary small"} disabled={passkeySaving} onClick={registerPasskey}>
            {passkeySaving ? "處理中…" : viewer.hasPasskey ? "新增 Passkey" : "建立 Passkey"}
          </button>
        </article>

        <article className="security-method">
          <div className="security-copy">
            <div><strong>復原碼</strong><Badge tone={viewer.hasRecoveryCode ? "green" : "gray"}>{viewer.hasRecoveryCode ? "已設定" : "未設定"}</Badge></div>
            <p>搭配固定的帳號名稱，可在換裝置時取回帳號。</p>
          </div>
          <button className="secondary" disabled={recoverySaving} onClick={createRecoveryCode}>
            {recoverySaving ? "產生中…" : viewer.hasRecoveryCode ? "重新產生復原碼" : "建立復原碼"}
          </button>
        </article>

        <article className="security-method">
          <div className="security-copy">
            <div><strong>此裝置快速登入</strong><Badge tone="blue">已記住</Badge></div>
            <p>登出後仍可在這台裝置選擇此帳號。</p>
          </div>
        </article>
      </section>

      <footer className="account-session">
        <button type="button" className="secondary" onClick={logout}>登出</button>
      </footer>
    </section>
  );
}

function Overview({
  event,
  booking,
  user,
  invoice,
  join,
  showEvents,
  showEventDetails,
  showBilling,
}: {
  event?: ClubEvent;
  booking?: Booking;
  user: Person;
  invoice?: Invoice;
  join: () => void;
  showEvents: () => void;
  showEventDetails: (eventId: string) => void;
  showBilling: () => void;
}) {
  const regular = event?.bookings.filter((entry) => entry.rank === "正取").length ?? 0;
  const wait = event?.bookings.filter((entry) => entry.rank === "候補").length ?? 0;
  const displayedRegularCapacity = Math.max(event?.regular ?? 0, regular);
  const nextEventDate = event?.startsAt ? taipeiDateParts(new Date(event.startsAt)) : null;
  const invoiceState: { label: string; tone: "green" | "orange" | "blue" } = invoice?.status === "CONFIRMED"
    ? { label: "已確認", tone: "green" }
    : invoice?.status === "REPORTED"
      ? { label: "已回報轉帳", tone: "blue" }
      : { label: "待轉帳", tone: "orange" };
  const invoiceLabel = !invoice ? "費用概況" : ({ SINGLE_EVENT: "零打單次費", MEMBER_EXTRA: "社員加場費", MEMBERSHIP_PRORATED: "中途入社社費", QUARTERLY_MEMBER: "季度社員費" }[invoice.type] ?? "待辦費用");

  return (
    <div className="dashboard overview-dashboard">
      {event ? <section className="next-event-card activity-detail-card" aria-labelledby="next-event-title">
        <button type="button" className="activity-detail-hit" aria-label={`查看下一場活動：${event.time} ${event.courts}`} aria-haspopup="dialog" onClick={() => showEventDetails(event.id)} />
        <div className="next-event-main">
          <div className="overview-date">
            <strong>{nextEventDate?.day ?? event.date}</strong>
            {nextEventDate && <span>{nextEventDate.month}月</span>}
            <small>{event.weekday}</small>
          </div>
          <div className="next-event-detail">
            <span className="next-event-kicker">下一場活動</span>
            <h2 id="next-event-title">{event.time}</h2>
            <p>⌖ {event.courts}</p>
          </div>
          <div className="attendance-summary" role="group" aria-label="本場參加人數">
            <div>
              <small>正取</small>
              <strong>{regular}<span>／{displayedRegularCapacity}</span></strong>
            </div>
            <div>
              <small>候補</small>
              <strong>{wait}<span>／{event.wait}</span></strong>
            </div>
          </div>
        </div>
        <div className="next-event-footer">
          <div className="next-event-status">
            <span>我的參加狀態</span>
            <Badge tone={booking ? (booking.rank === "正取" ? "green" : "orange") : "gray"}>{booking?.rank ?? "未參加"}</Badge>
          </div>
          {!booking && <div className="next-event-actions"><button type="button" className="primary small activity-detail-action" onClick={join}>{user.member ? "參加" : "我要報名"}</button></div>}
        </div>
      </section> : <section className="overview-empty" aria-labelledby="next-event-title">
        <b aria-hidden="true">◷</b>
        <h2 id="next-event-title">目前沒有已排程的活動</h2>
        <span>幹部建立下一場活動後，日期、場地與報名狀態會顯示在這裡。</span>
        <button type="button" className="secondary" onClick={showEvents}>查看活動月曆</button>
      </section>}

      <section className="payment-summary" aria-labelledby="overview-fees-title">
        <div className="payment-summary-content">
          <div className="payment-summary-heading">
            <h2 id="overview-fees-title">{invoiceLabel}</h2>
            {invoice && <Badge tone={invoiceState.tone}>{invoiceState.label}</Badge>}
          </div>
          <strong>{invoice ? `NT$ ${invoice.amount.toLocaleString("zh-TW")}` : "無待處理費用"}</strong>
          {invoice?.period_label && <span>{invoice.period_label}</span>}
        </div>
        <button type="button" className="link" onClick={showBilling}>查看費用明細 →</button>
      </section>
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

function allowsGuestBilling(event: ClubEvent) {
  return (event.status ?? "SCHEDULED") === "SCHEDULED" && event.memberBilling !== "FREE" && event.eventKind !== "OTHER";
}

const calendarFeeStatuses = [
  { id: "unbilled", label: "未開單" },
  { id: "unpaid", label: "未收齊" },
  { id: "reported", label: "待確認" },
] as const;

function isLiveInvoice(invoice: Invoice) {
  return !["VOID", "CREDITED", "REFUNDED"].includes(invoice.status);
}

function billCoversCalendarEvent(invoice: Invoice, eventId: string) {
  if (!isPrincipal(invoice) || !isLiveInvoice(invoice) || !includesEvent(invoice, eventId)) return false;
  const index = invoice.event_ids?.length ? invoice.event_ids.indexOf(eventId) : 0;
  return index < 0 || invoice.event_amounts?.[index] !== 0;
}

function outstandingEventPayers(event: ClubEvent, invoices: Invoice[]) {
  const names = new Map(event.bookings.map((booking) => [booking.memberId, booking.name]));
  const people = new Map<string, { id: string; name: string; status: "PENDING" | "REPORTED" }>();
  for (const bill of invoices) {
    const { status, member_id: id } = bill;
    if (bill.amount <= 0 || (status !== "PENDING" && status !== "REPORTED") || !billCoversCalendarEvent(bill, event.id)) continue;
    if (people.get(id)?.status === "PENDING") continue;
    people.set(id, { id, name: names.get(id) || bill.memberName, status });
  }
  return [...people.values()].sort((a, b) => Number(a.status === "REPORTED") - Number(b.status === "REPORTED") || a.name.localeCompare(b.name, "zh-Hant"));
}

function canSelectQuarterEvent(event: ClubEvent, periods: QuarterBillingPeriod[]) {
  const day = taipeiInputDate(event.startsAt);
  const period = periods.find((item) => item.startDate <= day && day <= item.endDate);
  return Boolean(day && allowsGuestBilling(event) && event.quarterEligible && (!period || period.status === "PLANNED" && period.revision));
}

function quarterKeyForEvent(event: ClubEvent, periods: QuarterBillingPeriod[]) {
  const day = taipeiInputDate(event.startsAt);
  const period = periods.find((item) => item.startDate <= day && day <= item.endDate);
  const [year, month] = day.split("-").map(Number);
  return period?.id ?? year + "-Q" + (1 + Math.floor((month - 1) / 3));
}

function calendarBillingOptions(event: ClubEvent, invoices: Invoice[], periods: QuarterBillingPeriod[], now: number) {
  const bills = invoices.filter((bill) => billCoversCalendarEvent(bill, event.id));
  const covered = new Set(bills.map((bill) => bill.member_id));
  const canBill = allowsGuestBilling(event);
  const hasMemberBill = bills.some((bill) => bill.type !== "SINGLE_EVENT");
  const guests = canBill && event.guestFee > 0 ? event.bookings.filter((booking) =>
    booking.kind === "非社員" && booking.rank === "正取" && !booking.transferred && !covered.has(booking.memberId)
    && !event.guestSettlements?.some((item) => item.memberId === booking.memberId)) : [];
  const quarter = canSelectQuarterEvent(event, periods) && event.memberBilling !== "NO_CHARGE" && !hasMemberBill;
  const extra = canBill && !hasMemberBill && Boolean(event.startsAt && Date.parse(event.startsAt) > now)
    && !periods.some((period) => period.eventIds.includes(event.id))
    && !event.billingLabel?.includes("季度社費") && ["NORMAL", "NO_CHARGE"].includes(event.memberBilling ?? "NORMAL")
    && event.bookings.some((booking) => booking.kind === "社員" && booking.rank === "正取" && !booking.transferred);
  return { bills, quarter, extra, guests };
}

function hasBillToIssue(options?: ReturnType<typeof calendarBillingOptions>) {
  return Boolean(options && (options.quarter || options.extra || options.guests.length));
}

function ActivityCalendar({ list, invoices, openEvent, openIssue, quarterMode, pickedIds, setPickedIds, toggleQuarterEvent, periods, createOnDate }: {
  list: ClubEvent[];
  invoices: Invoice[];
  openEvent: (id: string) => void;
  openIssue?: () => void;
  quarterMode: boolean;
  pickedIds: string[];
  setPickedIds: (ids: string[]) => void;
  toggleQuarterEvent: (event: ClubEvent) => string;
  periods: QuarterBillingPeriod[];
  createOnDate?: (date: string) => void;
}) {
  const [calendarNow, setCalendarNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setCalendarNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  const today = taipeiDateParts(new Date(calendarNow));
  const [visibleMonth, setVisibleMonth] = useState({ year: today.year, month: today.month });
  const [quarterSelectionError, setQuarterSelectionError] = useState("");
  const [pickedDate, setPickedDate] = useState(() => taipeiInputDate(new Date().toISOString()));
  const [noticeResult, setNoticeResult] = useState<(CalendarNotices & { month: string }) | null>(null);
  const [noticeAttempt, setNoticeAttempt] = useState(0);
  const monthKey = `${visibleMonth.year}-${String(visibleMonth.month).padStart(2, "0")}`;
  useEffect(() => {
    const controller = new AbortController();
    async function loadNotices() {
      try {
        const response = await fetch(`/api/club/calendar-notices?month=${monthKey}`, { signal: controller.signal });
        if (!response.ok) throw new Error("Calendar notices request failed");
        const result = await response.json() as CalendarNotices;
        if (!controller.signal.aborted) setNoticeResult({ ...result, month: monthKey });
      } catch {
        if (!controller.signal.aborted) setNoticeResult({ month: monthKey, notices: [], unavailable: ["holiday", "closure"] });
      }
    }
    void loadNotices();
    return () => controller.abort();
  }, [monthKey, noticeAttempt]);
  const currentNotices = noticeResult?.month === monthKey ? noticeResult : null;
  const notices = currentNotices?.notices ?? [];
  const unavailable = currentNotices?.unavailable ?? [];
  const noticesByDate = new Map<string, OfficialClosure[]>();
  for (const notice of notices) {
    const dateNotices = noticesByDate.get(notice.date);
    if (dateNotices) dateNotices.push(notice);
    else noticesByDate.set(notice.date, [notice]);
  }
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
  const todayKey = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;

  const admin = Boolean(openIssue);
  const selectedDate = pickedDate.startsWith(monthKey + "-") ? pickedDate : isCurrentMonth ? todayKey : monthKey + "-01";
  const selectedEvents = eventsByDay.get(Number(selectedDate.slice(-2))) ?? [];
  const options = new Map(admin && quarterMode ? list.map((item) => [item.id, calendarBillingOptions(item, invoices, periods, calendarNow)]) : []);
  const selectable = (event: ClubEvent) => hasBillToIssue(options.get(event.id));
  const selection = pickedIds.filter((id) => hasBillToIssue(options.get(id)));
  const eventName = (event: ClubEvent) => event.eventKind === "OTHER"
    ? event.courts || "其他活動"
    : event.courts ? "羽球 · " + event.courts : "羽球活動";
  type FeeStatus = (typeof calendarFeeStatuses)[number]["id"];
  const feeStatusByEvent = new Map<string, Set<FeeStatus>>();
  const paymentByEvent = new Map<string, { member: string; guest: string }>();
  if (admin && quarterMode) {
    for (const dayEvents of eventsByDay.values()) for (const entry of dayEvents) {
      const statuses = new Set<FeeStatus>();
      feeStatusByEvent.set(entry.id, statuses);
      if (!allowsGuestBilling(entry)) {
        const label = entry.status === "CANCELLED" || entry.status === "ARCHIVED" ? "不適用" : "免費";
        paymentByEvent.set(entry.id, { member: label, guest: label });
        continue;
      }
      const plan = options.get(entry.id)!;
      const bills = plan.bills;
      const linked = periods.find((period) => period.eventIds.includes(entry.id));
      const memberBills = bills.filter((bill) => bill.type !== "SINGLE_EVENT");
      const guestBills = bills.filter((bill) => bill.type === "SINGLE_EVENT");
      const pendingMemberBill = plan.quarter || plan.extra;
      const pendingGuestBill = plan.guests.length > 0;
      if (pendingGuestBill || pendingMemberBill) statuses.add("unbilled");
      for (const bill of bills) {
        if (bill.amount <= 0) continue;
        if (bill.status === "PENDING") statuses.add("unpaid");
        if (bill.status === "REPORTED") statuses.add("reported");
      }
      const paymentLabel = (group: Invoice[], unbilled: boolean, fallback: string) => [
        unbilled && "未開單",
        group.some((bill) => bill.status === "PENDING" && bill.amount > 0) && "未收齊",
        group.some((bill) => bill.status === "REPORTED" && bill.amount > 0) && "待確認",
        group.some((bill) => bill.status === "CONFIRMED") && "已結清",
      ].filter(Boolean).join("、") || fallback;
      const memberFallback = linked?.status === "GENERATING" ? "開單中"
        : linked?.status === "ACTIVE" ? "已納入季費"
        : entry.memberBilling === "NO_CHARGE" ? "本場不另收"
        : linked?.status === "PLANNED" ? "季費草稿"
        : memberBills.length ? "已開單" : "無應收帳單";
      const guestFallback = guestBills.length || entry.guestSettlements?.some((item) => item.status !== "SKIPPED") ? "有帳務紀錄"
        : entry.guestSettlements?.length ? "免收" : "無應收名單";
      paymentByEvent.set(entry.id, {
        member: paymentLabel(memberBills, pendingMemberBill, memberFallback),
        guest: paymentLabel(guestBills, pendingGuestBill, guestFallback),
      });
    }
  }
  return (
    <div className="activity-month-workspace">
    <section className="activity-calendar" aria-label={`${visibleMonth.year} 年 ${visibleMonth.month} 月活動月曆`}>
      <div className="calendar-heading">
        <div>
          <p>活動月曆</p>
          <h2>{visibleMonth.year} 年 {visibleMonth.month} 月</h2>
          <span>本月共 {eventCount} 場活動 · 點選日期查看當天場次</span>
        </div>
        <div className="calendar-controls">
          <button type="button" onClick={() => changeMonth(-1)} aria-label="上個月">‹</button>
          <button type="button" className="calendar-today" disabled={isCurrentMonth} onClick={() => setVisibleMonth({ year: today.year, month: today.month })}>本月</button>
          <button type="button" onClick={() => changeMonth(1)} aria-label="下個月">›</button>
        </div>
      </div>
      {unavailable.length > 0 && <div className="calendar-notice-status">
        <span role="status">{unavailable.map((kind) => kind === "holiday" ? "國定假日" : "停班停課公告").join("、")}暫時無法載入</span>
        <button type="button" className="link" onClick={() => setNoticeAttempt((attempt) => attempt + 1)}>重試</button>
      </div>}
      <div className="calendar-weekdays" aria-hidden="true">
        {["日", "一", "二", "三", "四", "五", "六"].map((weekday) => <span key={weekday}>{weekday}</span>)}
      </div>
      <div className="calendar-days">
        {Array.from({ length: firstWeekday }, (_, index) => <span className="calendar-day empty" key={`empty-${index}`} aria-hidden="true" />)}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const day = index + 1;
          const dayEvents = eventsByDay.get(day) ?? [];
          const isToday = isCurrentMonth && day === today.day;
          const dateKey = `${monthKey}-${String(day).padStart(2, "0")}`;
          const dayNotices = noticesByDate.get(dateKey) ?? [];
          const noticeLabels = dayNotices.map((notice) => (
            <span key={notice.kind} className={`calendar-notice calendar-notice-${notice.kind}`} title={notice.name}>
              {notice.kind === "closure" ? "停班停課" : notice.name}
            </span>
          ));
          const firstEvent = dayEvents[0];
          const feeStatuses = new Set(dayEvents.flatMap((event) => [...(feeStatusByEvent.get(event.id) ?? [])]));
          const daySummary = [...dayEvents.map((event) => eventName(event) + " " + event.time),
            ...calendarFeeStatuses.filter(({ id }) => feeStatuses.has(id)).map(({ label }) => label)];
          const singleCandidate = admin && quarterMode ? dayEvents.filter(selectable) : [];
          const directSelection = singleCandidate.length === 1 ? singleCandidate[0] : undefined;
          const hasUnbilled = feeStatuses.has("unbilled");
          const hasOutstanding = feeStatuses.has("unpaid") || feeStatuses.has("reported");
          const feeTone = hasUnbilled ? "unbilled" : hasOutstanding ? "outstanding" : undefined;
          return <button type="button" key={day} className={`calendar-day calendar-date-picker${dayEvents.length ? " has-event" : ""}${isToday ? " today" : ""}`}
            data-fee-tone={feeTone}
            title={feeTone ? [hasUnbilled && "未開單", hasOutstanding && "未收齊"].filter(Boolean).join("、") : undefined}
            role={directSelection ? "checkbox" : undefined}
            aria-checked={directSelection ? selection.includes(directSelection.id) : undefined}
            aria-pressed={directSelection ? undefined : selectedDate === dateKey}
            data-active-date={selectedDate === dateKey}
            aria-label={[dateKey, ...daySummary, ...dayNotices.map((notice) => notice.name), directSelection && "選取開單"].filter(Boolean).join("，")}
            onClick={() => {
              setPickedDate(dateKey);
              setQuarterSelectionError(directSelection ? toggleQuarterEvent(directSelection) : "");
            }}>
            {directSelection && <span aria-hidden="true" className="calendar-checked-mark" />}
            <span className="calendar-day-number">{day}{isToday && <i>今天</i>}</span>{noticeLabels}
            {firstEvent && <span className="calendar-day-event">
              <span className="calendar-day-event-name" title={eventName(firstEvent)}>{eventName(firstEvent)}</span>
              <span className="calendar-day-event-time">{firstEvent.time.replace(/\s*[–—]\s*/g, "–")}</span>
              {dayEvents.length > 1 && <span className="calendar-day-event-more">另有 {dayEvents.length - 1} 場</span>}
            </span>}
          </button>;
        })}
      </div>
      {notices.length > 0 && <details className="calendar-notice-details">
        <summary>本月國定假日與停班停課</summary>
        <ul>{notices.map((notice) => <li key={`${notice.date}-${notice.kind}`}><time dateTime={notice.date}>{visibleMonth.month}/{Number(notice.date.slice(-2))}</time> {notice.name}</li>)}</ul>
      </details>}
    </section>
    <aside className="calendar-day-panel" aria-labelledby="calendar-day-title">
      <p>當天場次</p>
      <h2 id="calendar-day-title"><time dateTime={selectedDate}>{new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "long", day: "numeric", weekday: "short" }).format(new Date(selectedDate + "T12:00:00+08:00"))}</time></h2>
      {!selectedEvents.length && <p className="calendar-panel-note">這天沒有活動。</p>}
      {!selectedEvents.length && !quarterMode && createOnDate && selectedDate >= todayKey && <button type="button" className="secondary" onClick={() => createOnDate(selectedDate)}>新增當天活動</button>}
      {selectedEvents.map((event) => {
        const payment = paymentByEvent.get(event.id);
        const chooseInCard = admin && quarterMode && selectable(event) && selectedEvents.filter(selectable).length > 1;
        return <article key={event.id} className="calendar-session activity-detail-card">
          <button type="button" className="activity-detail-hit" aria-label={`查看活動：${eventName(event)} ${event.time}`} aria-haspopup="dialog" onClick={() => openEvent(event.id)} />
          <div className="calendar-session-heading"><h3>{eventName(event)}</h3></div>
          <p>{event.time}</p>
          {payment && <dl className="calendar-payment-summary" aria-label="本場繳費狀態">
            <div><dt>社員</dt><dd>{payment.member}</dd></div>
            <div><dt>非社員</dt><dd>{payment.guest}</dd></div>
          </dl>}
          {chooseInCard && <label className="calendar-session-check activity-detail-action">
            <input type="checkbox" checked={selection.includes(event.id)} onChange={() => setQuarterSelectionError(toggleQuarterEvent(event))} />選取開單
          </label>}
        </article>;
      })}
    </aside>
    {quarterMode && <div className="calendar-selection-bar">
      {quarterSelectionError && <p className="guest-settlement-error calendar-selection-error" role="alert">{quarterSelectionError}</p>}
      <strong aria-live="polite">已選 {selection.length} 場</strong>
      {selection.length > 0 && <button type="button" className="link" onClick={() => { setPickedIds([]); setQuarterSelectionError(""); }}>清除</button>}
      <button type="button" className="primary" disabled={!selection.length} onClick={openIssue}>預覽開單 →</button>
    </div>}
    </div>
  );
}

function archivedClubEvent(entry?: InvoiceSchedule): ClubEvent | undefined {
  if (!entry) return undefined;
  return { id: entry.id, startsAt: entry.starts_at ?? undefined, endsAt: entry.ends_at ?? undefined,
    status: entry.status ?? "ARCHIVED", cancellationReason: entry.cancellation_reason, date: entry.starts_at ? taipeiInputDate(entry.starts_at) : "日期未記錄",
    weekday: entry.starts_at ? new Date(entry.starts_at).toLocaleDateString("zh-TW", { weekday: "short", timeZone: "Asia/Taipei" }) : "",
    time: entry.starts_at && entry.ends_at ? taipeiTime(entry.starts_at) + "–" + taipeiTime(entry.ends_at) : "時間未記錄",
    courts: entry.courts, regular: 0, wait: 0, regularBooked: 0, waitBooked: 0, memberFee: 0, guestFee: 0, bookings: [],
  };
}
function taipeiTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function EventDetailsDialog({ event, billingInvoices = [], viewerId, user, isAdmin, close, join, cancel, transfer, edit, invoiceLabel, showEventBills, previewCancellation, cancelEvent }: {
  event: ClubEvent;
  billingInvoices?: Invoice[];
  viewerId: string;
  user: Person;
  isAdmin: boolean;
  close: () => void;
  join: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  transfer: () => void;
  edit: () => void;
  invoiceLabel: string | null;
  showEventBills?: () => void;
  previewCancellation: () => Promise<EventCancellationPreview | null>;
  cancelEvent: (reason: string, previewKey: string) => Promise<boolean>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const settingsRef = useRef<HTMLDetailsElement>(null);
  const attendanceRef = useRef<HTMLDivElement>(null);
  const [attendanceOpen, setAttendanceOpen] = useState(false);
  const [cancelPreview, setCancelPreview] = useState<EventCancellationPreview | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const cancelPanelRef = useRef<HTMLElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearInterval(timer);
      dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  const outstanding = isAdmin ? outstandingEventPayers(event, billingInvoices) : [];
  const paymentStatus = new Map(outstanding.map((person) => [person.id, person.status]));
  const paymentBadge = (status: "PENDING" | "REPORTED") => <Badge tone={status === "PENDING" ? "orange" : "blue"}>{status === "PENDING" ? "未繳費" : "待確認"}</Badge>;
  const entry = event.bookings.find((booking) => booking.memberId === viewerId);
  const started = Boolean(event.startsAt && new Date(event.startsAt).getTime() <= now);
  const ended = Boolean(event.endsAt && new Date(event.endsAt).getTime() <= now);
  const archived = event.status === "CANCELLED" || event.status === "ARCHIVED";
  const canManage = isAdmin && !ended && !archived;
  const openCancelPreview = async () => {
    setSaving(true);
    setError("");
    if (settingsRef.current) settingsRef.current.open = false;
    try {
      const preview = await previewCancellation();
      setCancelPreview(preview);
      if (preview) requestAnimationFrame(() => cancelPanelRef.current?.focus());
    } catch { setError("無法預覽取消影響，請重試。"); }
    finally { setSaving(false); }
  };
  const submitCancellation = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    if (!cancelPreview || !cancelReason.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      if (!await cancelEvent(cancelReason.trim(), cancelPreview.previewKey)) {
        setCancelPreview(null);
        setError("未取消活動，請重新預覽後確認。");
      }
    } catch { setError("無法確認取消結果，請重新整理活動後再試。"); }
    finally { setSaving(false); }
  };
  const canChangeAttendance = Boolean(entry && !started && !archived);
  const attendanceStatus = <>
    <strong>我的狀態</strong>
    <Badge tone={entry?.rank === "正取" ? "green" : entry ? "orange" : "gray"}>{entry?.rank ?? "未參加"}</Badge>
    {started && <Badge tone="gray">{ended ? "已結束" : "進行中"}</Badge>}
  </>;
  const full = event.regularBooked >= event.regular && event.waitBooked >= event.wait;
  const updateAttendance = async (action: (id: string) => Promise<void>) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try { await action(event.id); }
    catch { setError("操作失敗，請稍後再試。"); }
    finally { setSaving(false); }
  };
  const cancelAttendance = async () => {
    await updateAttendance(cancel);
    setAttendanceOpen(false);
    requestAnimationFrame(() => {
      const status = attendanceRef.current;
      (status?.querySelector("button") ?? status)?.focus();
    });
  };
  return (
    <dialog
      ref={dialogRef}
      className={`modal event-dialog${canManage ? " has-settings" : ""}`}
      aria-labelledby="event-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        const settings = settingsRef.current;
        if (settings?.open) {
          settings.open = false;
          settings.querySelector("summary")?.focus();
        } else if (canChangeAttendance && attendanceOpen && !saving) {
          setAttendanceOpen(false);
          attendanceRef.current?.querySelector("button")?.focus();
        } else if (!saving) {
          close();
        }
      }}
      onClick={(event) => {
        const settings = settingsRef.current;
        if (settings?.open && event.target instanceof Node && !settings.contains(event.target)) settings.open = false;
        if (attendanceOpen && !saving && event.target instanceof Node && !attendanceRef.current?.contains(event.target)) setAttendanceOpen(false);
        if (event.target === event.currentTarget && !saving) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
        }
      }}
    >
      <div className="event-dialog-controls">
        {canManage && <details className="event-settings" ref={settingsRef}>
          <summary aria-label="活動設定" title="活動設定" aria-controls="event-settings-panel" aria-disabled={saving} onClick={(event) => { if (saving) event.preventDefault(); }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
          </summary>
          <div className="event-settings-panel" id="event-settings-panel">
            <button type="button" className="link" aria-haspopup="dialog" disabled={saving} onClick={edit}>編輯活動</button>
            <button type="button" className="link danger" disabled={saving} onClick={() => void openCancelPreview()}>取消活動</button>
          </div>
        </details>}
        <button type="button" className="close" aria-label="關閉活動詳情" disabled={saving} onClick={close} autoFocus>×</button>
      </div>
      <p>活動詳情</p>
      <h2 id="event-dialog-title">{event.startsAt ? taipeiInputDate(event.startsAt) : event.date}（{event.weekday}）</h2>
      <dl className="event-dialog-facts">
        <div><dt>時間</dt><dd>{event.time}</dd></div>
        <div><dt>場地</dt><dd>{event.courts}</dd></div>
        <div><dt>收費歸屬</dt><dd>{archived ? "活動已取消／封存" : invoiceLabel ?? event.billingLabel ?? (event.memberBilling === "FREE" ? "全員免費" : event.memberBilling === "NO_CHARGE" ? "本場不另計社員費" : "尚未出帳")}</dd></div>
        {!archived && event.memberBilling !== "FREE" && <div><dt>零打費</dt><dd>NT$ {event.guestFee.toLocaleString("zh-TW")}／人</dd></div>}
      </dl>
      {event.cancellationReason && <p className="form-note">取消原因：{event.cancellationReason}</p>}
      {!isAdmin && showEventBills && <button type="button" className="link" disabled={saving} onClick={showEventBills}>查看我的本場帳單 →</button>}
      {cancelPreview && <section ref={cancelPanelRef} tabIndex={-1} className="event-cancel-review" aria-label="取消活動影響">
        <h3>取消活動 · 帳務影響</h3>
        <p>取消 {cancelPreview.cancelledBookings} 筆報名。只調整這一場，不會自動轉帳。</p>
        <dl className="event-dialog-facts">
          <div><dt>減收</dt><dd>NT$ {cancelPreview.reducedAmount.toLocaleString("zh-TW")}</dd></div>
          <div><dt>退回社內餘額</dt><dd>NT$ {cancelPreview.creditedAmount.toLocaleString("zh-TW")}</dd></div>
          <div><dt>實收款待退</dt><dd>NT$ {(cancelPreview.pendingCashRefundAmount ?? 0).toLocaleString("zh-TW")}</dd></div>
          <div><dt>待核對款項</dt><dd>NT$ {(cancelPreview.pendingCreditAmount + (cancelPreview.legacyReviewAmount ?? 0)).toLocaleString("zh-TW")}</dd></div>
        </dl>
        <form className="manager-form" onSubmit={(form) => void submitCancellation(form)}>
          <label>取消原因<input required maxLength={200} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="例如：場館維修" disabled={saving} /></label>
          <div className="event-dialog-actions">
            <button type="button" className="secondary" disabled={saving} onClick={() => setCancelPreview(null)}>返回</button>
            <button type="submit" className="primary" disabled={saving || !cancelReason.trim()}>{saving ? "處理中…" : "確認取消活動"}</button>
          </div>
        </form>
      </section>}
      {!archived && !cancelPreview && <><div className="event-dialog-status" ref={attendanceRef} tabIndex={-1}>
        {canChangeAttendance ? (
          <button
            type="button"
            className="event-status-toggle"
            aria-expanded={attendanceOpen}
            aria-controls={attendanceOpen ? "event-status-actions" : undefined}
            disabled={saving}
            onClick={() => setAttendanceOpen((open) => !open)}
          >
            {attendanceStatus}
            <span className="event-status-chevron" aria-hidden="true" />
          </button>
        ) : <div className="event-status-label">{attendanceStatus}</div>}
        {canChangeAttendance && attendanceOpen && (
          <div className="event-status-actions" id="event-status-actions">
            <button type="button" className="secondary" disabled={saving} onClick={() => void cancelAttendance()}>{saving ? "處理中…" : "取消參加"}</button>
            {entry?.kind === "社員" && event.eventKind !== "OTHER" && <button type="button" className="primary" aria-haspopup="dialog" disabled={saving} onClick={transfer}>轉讓名額</button>}
          </div>
        )}
      </div>
      <section className="event-dialog-roster" aria-label="參加名單">
        <h3>參加名單（{event.bookings.length} 人）</h3>
        {event.bookings.length === 0 ? <p>目前尚無人報名。</p> : (
          <ul>{[...event.bookings].sort((a, b) => Number(a.rank === "候補") - Number(b.rank === "候補")).map((booking) => (
            <li key={booking.memberId}>
              <span>{booking.name}{booking.memberId === viewerId ? "（我）" : ""}<small>{booking.accountName ? `帳號：${booking.accountName} · ` : ""}{booking.kind}</small></span>
              <span className="event-roster-badges">
                <Badge tone={booking.rank === "正取" ? "green" : "orange"}>{booking.rank}</Badge>
                {paymentStatus.has(booking.memberId) && paymentBadge(paymentStatus.get(booking.memberId)!)}
              </span>
            </li>
          ))}</ul>
        )}
      </section>
      </>}
      {outstanding.some((person) => !event.bookings.some((booking) => booking.memberId === person.id)) && <section className="event-dialog-roster" aria-label="其他待收款人">
        <h3>其他待收款人</h3>
        <ul>{outstanding.filter((person) => !event.bookings.some((booking) => booking.memberId === person.id)).map((person) => <li key={person.id}><span>{person.name}</span>{paymentBadge(person.status)}</li>)}</ul>
      </section>}
      {error && <p role="alert">{error}</p>}
      {!archived && !cancelPreview && !started && !entry && <div className="event-dialog-actions">
        <button type="button" className="primary" disabled={saving || ((!user.member || event.eventKind === "OTHER") && full)} onClick={() => void updateAttendance(join)}>
          {saving ? "處理中…" : full && (!user.member || event.eventKind === "OTHER") ? "本場已額滿" : "參加"}
        </button>
      </div>}
    </dialog>
  );
}

function CalendarIssueDialog({ events, invoices, periods, close, openQuarter, refresh, publishGuest, previewExtra, publishExtra }: {
  events: ClubEvent[];
  invoices: Invoice[];
  periods: QuarterBillingPeriod[];
  close: () => void;
  openQuarter: (ids: string[]) => void;
  refresh: () => Promise<void>;
  publishGuest: (id: string, decisions: GuestSettlementDecision[]) => Promise<GuestSettlementReceipt | null>;
  previewExtra: (id: string) => Promise<QuarterInvoicePreview | null>;
  publishExtra: (id: string, key: string, reason: string) => Promise<boolean>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [active, setActive] = useState<{ id: string; kind: "guest" | "extra" } | null>(null);
  const [quote, setQuote] = useState<QuarterInvoicePreview | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  useEffect(() => {
    const node = dialog.current;
    const trigger = document.activeElement;
    if (!node) return;
    node.showModal();
    return () => { node.close(); if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus(); };
  }, []);
  const rows = events.map((event) => ({ event, ...calendarBillingOptions(event, invoices, periods, Date.now()) }))
    .filter(hasBillToIssue).sort((a, b) => (a.event.startsAt ?? "").localeCompare(b.event.startsAt ?? ""));
  const quarters = new Map<string, ClubEvent[]>();
  for (const row of rows.filter((row) => row.quarter)) {
    const group = quarterKeyForEvent(row.event, periods);
    quarters.set(group, [...(quarters.get(group) ?? []), row.event]);
  }
  const chosen = active && rows.find((row) => row.event.id === active.id);
  const label = (event: ClubEvent) => [taipeiInputDate(event.startsAt) || event.date, event.time, event.courts].join(" · ");
  const open = async (id: string, kind: "guest" | "extra") => {
    setActive({ id, kind }); setQuote(null); setReason(""); setFeedback("");
    if (kind !== "extra") return;
    setBusy(true);
    try {
      const result = await previewExtra(id);
      setQuote(result);
      if (!result?.rows.length) setFeedback("本場沒有可加收的社員，請確認名單和費率。");
    } catch { setFeedback("無法預覽補收，請重新整理後再試。"); }
    finally { setBusy(false); }
  };
  const saveExtra = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    if (!active || !quote?.rows.length || !reason.trim() || busy) return;
    setBusy(true);
    try {
      if (await publishExtra(active.id, quote.previewKey, reason.trim())) {
        setActive(null); setQuote(null); setFeedback("本場社員補收已開單。");
      } else { setQuote(null); setFeedback("未開單。名單可能已變動，請重新預覽。"); }
    } catch { setQuote(null); setFeedback("無法確認開單結果，重新整理後再試。"); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="modal event-dialog" aria-labelledby="calendar-issue-title"
    onCancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
    <button type="button" className="close" aria-label="關閉開單預覽" disabled={busy} onClick={close}>×</button>
    <p>活動收費</p><h2 id="calendar-issue-title">開單預覽</h2>
    {feedback && <p role="status">{feedback}</p>}
    {!chosen && !rows.length && <p>所選場次沒有待開帳單。</p>}
    {!chosen && <>
      {quarters.size > 0 && <section className="guest-settlement" aria-label="季費">
        <h3>季費 · 依計費期間開立</h3>
        {[...quarters].map(([key, group]) => <div key={key} className="calendar-issue-group">
          <ul>{group.map((event) => <li key={event.id}>{label(event)}</li>)}</ul>
          <button type="button" className="secondary" disabled={group.length > 32} onClick={() => openQuarter(group.map((event) => event.id))}>預覽季費（{group.length} 場）</button>
          {group.length > 32 && <p className="form-note">每期最多 32 場，請返回調整選取。</p>}
        </div>)}
      </section>}
      {rows.some((row) => row.guests.length) && <section className="guest-settlement" aria-label="零打費">
        <h3>零打費 · 依場次開立</h3>
        {rows.filter((row) => row.guests.length).map(({ event, guests }) => <div key={event.id} className="calendar-issue-group">
          <span>{label(event)}</span>
          <button type="button" className="secondary" onClick={() => void open(event.id, "guest")}>核對零打名單（{guests.length} 人）</button>
        </div>)}
      </section>}
      {rows.some((row) => row.extra) && <section className="guest-settlement" aria-label="社員單場補收">
        <h3>社員單場補收 · 不併入季費</h3><p className="form-note">同一場社員費可選季費或單場補收，不會重複開單。</p>
        {rows.filter((row) => row.extra).map(({ event }) => <div key={event.id} className="calendar-issue-group">
          <span>{label(event)}</span>
          <button type="button" className="secondary" onClick={() => void open(event.id, "extra")}>預覽單場補收</button>
        </div>)}
      </section>}
    </>}
    {chosen && <>
      <p className="form-note">{label(chosen.event)}</p>
      <button type="button" className="link" disabled={busy} onClick={() => { setActive(null); setFeedback(""); }}>返回所選場次</button>
      {active?.kind === "guest" && <GuestSettlementPanel key={chosen.event.id} event={{ ...chosen.event, bookings: chosen.guests }}
        busy={busy} refresh={refresh} publish={async (decisions) => {
          setBusy(true);
          try {
            const result = await publishGuest(chosen.event.id, decisions);
            if (result) {
              setFeedback(`零打已開單 ${result.issued} 筆，免收 ${result.skipped} 人。`);
              setActive(null);
            }
            return result;
          } finally { setBusy(false); }
        }} />}
      {active?.kind === "extra" && (busy && !quote ? <p role="status">正在核對名單…</p> : quote && quote.rows.length > 0 && <section className="guest-settlement" aria-label="單場補收預覽">
        <h3>社員單場補收</h3>
        <p>抵扣後合計 NT$ {quote.totalAmount.toLocaleString("zh-TW")}</p>
        <ul className="billing-receipt-list">{quote.rows.map((row) => <li key={row.memberId}><span>{row.name}</span><strong>NT$ {row.amount.toLocaleString("zh-TW")}</strong></li>)}</ul>
        <form className="manager-form" onSubmit={(event) => void saveExtra(event)}>
          <label>補收原因<input required maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} /></label>
          <button type="submit" className="primary" disabled={busy || !reason.trim()}>確認開單</button>
        </form>
      </section>)}
    </>}
  </dialog>;
}


function GuestSettlementPanel({
  event,
  busy,
  publish,
  refresh,
}: {
  event: ClubEvent;
  busy: boolean;
  publish: (decisions: GuestSettlementDecision[]) => Promise<{ issued: number; skipped: number } | null>;
  refresh: () => Promise<void>;
}) {
  const [decisions, setDecisions] = useState<Partial<Record<string, GuestSettlementDecision["decision"]>>>({});
  const [review, setReview] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState("");
  const settled = new Map(event.guestSettlements?.map((settlement) => [settlement.memberId, settlement]) ?? []);
  const eligible = event.bookings.filter((booking) => booking.kind === "非社員" && !booking.transferred && (booking.rank === "正取" || settled.has(booking.memberId)));
  const open = eligible.filter((booking) => !settled.has(booking.memberId));
  const pendingDecisions = open.flatMap(({ memberId }) => { const decision = decisions[memberId]; return decision ? [{ memberId, decision }] : []; });
  const billCount = pendingDecisions.filter(({ decision }) => decision === "BILL").length;
  const ready = open.length > 0 && open.length === pendingDecisions.length;
  const money = (amount: number) => "NT$ " + amount.toLocaleString("zh-TW");
  const submit = async (form: FormEvent<HTMLFormElement>) => {
    form.preventDefault();
    if (!ready || busy) return;
    if (!review) { setReview(true); return; }
    setError("");
    setReceipt("");
    try {
      const result = await publish(pendingDecisions);
      if (!result) { setError("未能儲存，請重新整理名單後再確認。"); setReview(false); return; }
      setReceipt("已開單 " + result.issued + " 筆 · 免收 " + result.skipped + " 人");
      setDecisions({});
      setReview(false);
    } catch {
      setError("暫時無法確認開單結果。請先重新整理名單，不要重複開單。");
      setReview(false);
    }
  };
  return (
    <section className="guest-settlement" aria-labelledby="guest-settlement-title">
      <div className="guest-settlement-heading">
        <div><h3 id="guest-settlement-title">零打開單</h3><p>本場零打：{money(event.guestFee)}／人</p></div>
        <Badge tone={open.length ? "orange" : "gray"}>{open.length ? `${open.length} 人待處理` : "無待開單名單"}</Badge>
      </div>
      <p className="form-note">核對正取名單後，選「收費」或「免收」。候補未遞補不列入，報名不會自動開單。</p>
      {!eligible.length ? <p className="guest-settlement-empty">目前沒有符合開單條件的零打球友。</p> : (
        <form className="guest-settlement-form" onSubmit={(event) => void submit(event)}>
          <ul className="guest-settlement-list">{eligible.map((booking) => {
            const result = settled.get(booking.memberId);
            const stateText = result?.status === "LEGACY" ? "已有帳單" : result?.status === "ISSUED" ? "已開單" : result?.status === "SKIPPED" ? "已免收" : "";
            return <li key={booking.memberId}>
              <span><strong>{booking.name}</strong>{booking.accountName && <small>帳號：{booking.accountName}</small>}</span>
              {result ? <span>{stateText}{result.amount !== null && result.status !== "SKIPPED" ? " · " + money(result.amount) : ""}</span> : (
                <select aria-label={booking.name + "零打收費"} disabled={busy || review} value={decisions[booking.memberId] ?? ""} onChange={(change) => { const value = change.target.value; setDecisions((current) => ({ ...current, [booking.memberId]: value === "BILL" || value === "SKIP" ? value : undefined })); }}>
                  <option value="">請選擇</option><option value="BILL">收費</option><option value="SKIP">免收</option>
                </select>
              )}
            </li>;
          })}</ul>
          {open.length > 0 && (
            <>
              {review && <p className="guest-settlement-review" role="status">收費 {billCount} 人 · 免收 {open.length - billCount} 人{billCount > 0 && " · 抵扣前合計 " + money(event.guestFee * billCount)}</p>}
              <div className="guest-settlement-actions">
                {review && <button type="button" className="secondary" disabled={busy} onClick={() => setReview(false)}>返回修改</button>}
                <button className="primary" disabled={!ready || busy}>{busy ? "處理中…" : review ? billCount ? "確認開單" : "確認免收" : "預覽開單"}</button>
              </div>
            </>
          )}
        </form>
      )}
      {receipt && <p className="guest-settlement-review" role="status">{receipt}</p>}
      {error && <div className="guest-settlement-error" role="alert">{error} <button type="button" className="link" onClick={() => { setReview(false); setDecisions({}); void refresh(); }}>重新整理名單</button></div>}
    </section>
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
  currentUser,
  admin,
  saving,
  requestMembership,
  reviewRequest,
  manageMember,
}: {
  members: Person[];
  requests: MembershipRequest[];
  currentUser: Person;
  admin: boolean;
  saving: boolean;
  requestMembership: () => void;
  reviewRequest: (request: MembershipRequest, decision: "APPROVE" | "REJECT") => void;
  manageMember: (person: Person) => void;
}) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<"member" | "guest">("member");
  const reviewDialog = useRef<HTMLDialogElement>(null);
  const reviewTrigger = useRef<HTMLButtonElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-Hant");
  const memberCount = members.filter((person) => person.member).length;
  const activeLabel = group === "member" ? "社員" : "非社員";
  const visibleMembers = members.filter((person) => person.member === (group === "member") && (!normalizedQuery || [person.name, person.accountName, person.department].some((value) => value?.toLocaleLowerCase("zh-Hant").includes(normalizedQuery))));
  const pendingRequests = requests.filter((request) => request.status === "PENDING");
  const myPendingRequest = pendingRequests.find((request) => request.memberId === currentUser.id);
  return (
    <div className="member-page">
      {!currentUser.member && (
        <section className="membership-join-cta">
          <div className="membership-join-icon" aria-hidden="true">＋</div>
          <div>
            <p>加入羽球社</p>
            <h3>{myPendingRequest ? "入社申請審核中" : "想固定參加每週活動？"}</h3>
            <span>{myPendingRequest ? "幹部完成審核前仍維持非社員身分，請留意站內通知。" : "送出後由幹部審核；核准後立即成為社員，並依剩餘活動場次計費。"}</span>
          </div>
          <button type="button" className="primary small" disabled={saving || Boolean(myPendingRequest)} onClick={requestMembership}>
            {saving ? "送出中…" : myPendingRequest ? "等待審核" : "申請入社"}
          </button>
        </section>
      )}
      <section className="roster" aria-labelledby="roster-title">
        <header className="roster-header">
          <div>
            <h2 id="roster-title">一起上場的球友</h2>
            <p>查看現任社員或尚未入社的球友。</p>
          </div>
            {admin && (
              <button
                ref={reviewTrigger}
                type="button"
                className="secondary member-review-trigger"
                aria-haspopup="dialog"
                aria-controls="membership-review-dialog"
                aria-label={`社員申請審核，${pendingRequests.length} 筆待審核`}
                onClick={() => reviewDialog.current?.showModal()}
              >
                社員申請審核
                <Badge tone={pendingRequests.length > 0 ? "orange" : "gray"}>{pendingRequests.length}</Badge>
              </button>
            )}
        </header>
        <div className="roster-controls">
          <div className="roster-switch" role="group" aria-label="依會籍切換名單">
            <button type="button" aria-pressed={group === "member"} onClick={() => setGroup("member")}>社員 <span>{memberCount}</span></button>
            <button type="button" aria-pressed={group === "guest"} onClick={() => setGroup("guest")}>非社員 <span>{members.length - memberCount}</span></button>
          </div>
          <label className="roster-search">
            <span>搜尋{activeLabel}</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="姓名、帳號或部門" />
          </label>
        </div>
        <div className="roster-results">
          <h3>{activeLabel}名單</h3>
          <span role="status">{visibleMembers.length} 位</span>
        </div>
        {visibleMembers.length === 0 ? (
          <div className="roster-empty">{normalizedQuery ? `找不到符合「${query.trim()}」的${activeLabel}` : `目前沒有${activeLabel}`}</div>
        ) : (
          <ul className="roster-grid" aria-label={`${activeLabel}名單`} role="list">
            {visibleMembers.map((person) => (
              <li className="roster-card" key={person.id}>
                <span className="roster-avatar" aria-hidden="true">{Array.from(person.name)[0] ?? "球"}</span>
                <div className="roster-person">
                  <strong>{person.name}{person.id === currentUser.id && <small>（你）</small>}</strong>
                  {person.department && <span>{person.department}</span>}
                  {person.accountName && <small>帳號：{person.accountName}</small>}
                </div>
                <div className="roster-card-actions">
                  <Badge tone={person.role === "admin" ? "blue" : person.member ? "green" : "gray"}>{person.membershipStatus === "EXITING" ? person.membershipEndingAt ? `會籍至 ${taipeiInputDate(person.membershipEndingAt)}` : "本期後退出" : clubIdentityLabel(person)}</Badge>
                  {admin && <button type="button" className="link" disabled={saving} aria-label={`編輯 ${person.name}`} onClick={() => manageMember(person)}>編輯</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {admin && (
        <dialog
          ref={reviewDialog}
          id="membership-review-dialog"
          className="modal membership-requests"
          aria-labelledby="membership-review-title"
          onClose={() => reviewTrigger.current?.focus()}
        >
          <header>
            <h2 id="membership-review-title">社員申請審核</h2>
            <button type="button" className="close" onClick={() => reviewDialog.current?.close()} aria-label="關閉社員申請審核">×</button>
          </header>
          {pendingRequests.length === 0 ? (
            <div className="membership-request-empty" role="status">目前沒有待審核申請</div>
          ) : pendingRequests.map((request) => (
            <article key={request.id}>
              <div>
                <strong>{request.memberName}</strong>
                {request.accountName && <small className="account-name">帳號：{request.accountName}</small>}
                <span>
                  {request.kind === "JOIN" ? "申請加入社員" : "申請退出社員"}
                  {request.requestedAt && <> · {new Date(request.requestedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>}
                </span>
              </div>
              <div className="request-actions">
                <button type="button" className="secondary" disabled={saving} onClick={() => reviewRequest(request, "REJECT")}>拒絕</button>
                <button type="button" className="primary small" disabled={saving} onClick={() => reviewRequest(request, "APPROVE")}>核准</button>
              </div>
            </article>
          ))}
        </dialog>
      )}
    </div>
  );
}
function Billing(props: BillingProps) {
  return <BillingDashboard {...props} />;
}
