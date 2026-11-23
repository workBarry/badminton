"use client";

import { useEffect, useRef, useState } from "react";
import type { MemberBalanceHistory } from "@/lib/balance-history";

type HistoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; history: MemberBalanceHistory };

const integerFormat = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
const dateTimeFormat = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function currency(amount: number) {
  return `NT$ ${integerFormat.format(amount)}`;
}

function signedCurrency(amount: number) {
  return `${amount > 0 ? "+" : amount < 0 ? "−" : ""}NT$ ${integerFormat.format(Math.abs(amount))}`;
}

function displayTime(value: string | null) {
  if (!value) return "時間未記錄";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "時間未記錄" : dateTimeFormat.format(date);
}

export default function BalanceHistoryDialog({
  member,
  onClose,
}: {
  member: { id: string; name: string; accountName?: string };
  onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function loadHistory() {
      try {
        const response = await fetch(`/api/club?balanceHistoryMemberId=${encodeURIComponent(member.id)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const payload: MemberBalanceHistory | { error: string } = await response.json();
        if (!response.ok || "error" in payload) {
          throw new Error("error" in payload ? payload.error : "無法載入餘額紀錄，請稍後重試。");
        }
        if (!controller.signal.aborted) setState({ status: "ready", history: payload });
      } catch (error) {
        if (!controller.signal.aborted) {
          setState({ status: "error", message: error instanceof Error ? error.message : "無法載入餘額紀錄，請稍後重試。" });
        }
      }
    }
    void loadHistory();
    return () => controller.abort();
  }, [member.id, attempt]);

  const history = state.status === "ready" ? state.history : null;
  const accountName = history?.accountName ?? member.accountName;

  return (
    <div className="modal-cover balance-history-cover" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        ref={dialog}
        id="member-balance-history"
        className="modal balance-history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="balance-history-title"
        aria-describedby="balance-history-description"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const controls = dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])");
          if (!controls?.length) {
            event.preventDefault();
            dialog.current?.focus();
            return;
          }
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="balance-history-header">
          <div>
            <p>社員帳戶</p>
            <h2 id="balance-history-title">餘額異動紀錄</h2>
            <p className="balance-history-member">{history?.memberName ?? member.name}{accountName && <span>帳號：{accountName}</span>}</p>
          </div>
          <button ref={closeButton} type="button" className="close" onClick={onClose} aria-label="關閉餘額異動紀錄">×</button>
        </header>

        <div className="balance-history-content" tabIndex={0} role="region" aria-label="餘額紀錄內容" aria-busy={state.status === "loading"}>
          <p id="balance-history-description" className="balance-history-note">關閉後可繼續編輯尚未儲存的社員資料。時間以台北時間顯示。</p>
          {state.status === "loading" && <p className="balance-history-state" role="status">正在載入餘額紀錄…</p>}
          {state.status === "error" && (
            <div className="balance-history-state balance-history-error">
              <p role="alert">{state.message}</p>
              <button type="button" className="secondary" onClick={() => {
                closeButton.current?.focus();
                setState({ status: "loading" });
                setAttempt((value) => value + 1);
              }}>重新載入</button>
            </div>
          )}
          {history && (
            <>
              <dl className="balance-history-totals">
                <div className="balance-history-current"><dt>目前帳戶餘額</dt><dd>{currency(history.currentBalance)}</dd></div>
                <div><dt>已記錄增加</dt><dd className="balance-history-increase">{signedCurrency(Math.abs(history.totalIncreases))}</dd></div>
                <div><dt>已記錄扣抵</dt><dd className="balance-history-decrease">{signedCurrency(-Math.abs(history.totalDecreases))}</dd></div>
              </dl>
              {history.unreconciledAmount !== 0 && (
                <div className="balance-history-gap" role="note">
                  <strong>舊資料紀錄差額：{signedCurrency(history.unreconciledAmount)}</strong>
                  <p>目前餘額與已記錄收支存在差額。較早資料可能未完整保留，以下僅顯示可查詢的異動紀錄。</p>
                </div>
              )}
              <div className="balance-history-list-heading"><h3>異動明細</h3><span>{history.entries.length} 筆</span></div>
              {history.entries.length === 0 ? (
                <p className="balance-history-state" role="status">目前沒有可查詢的餘額異動紀錄。</p>
              ) : (
                <ol className="balance-history-list">
                  {history.entries.map((entry) => (
                    <li key={entry.id}>
                      <div className="balance-history-entry-top">
                        <time dateTime={entry.occurredAt ?? undefined}>{displayTime(entry.occurredAt)}</time>
                        <strong className={entry.amount < 0 ? "balance-history-decrease" : "balance-history-increase"}>{signedCurrency(entry.amount)}</strong>
                      </div>
                      <p className="balance-history-reason">{entry.reason}</p>
                      <dl className="balance-history-entry-details">
                        {(entry.invoiceId || entry.invoiceLabel) && <div><dt>關聯帳單</dt><dd>{entry.invoiceLabel ?? "帳單"}{entry.invoiceId && <small>帳單編號：{entry.invoiceId}</small>}</dd></div>}
                        {entry.eventDates.length > 0 && <div><dt>活動日期</dt><dd>{entry.eventDates.map((date) => date.replace(/-/g, "/")).join("、")}</dd></div>}
                        <div><dt>操作者</dt><dd>{entry.actorName ?? "未記錄"}</dd></div>
                      </dl>
                      {entry.source === "legacy" && <span className="balance-history-legacy">舊紀錄</span>}
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
