"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MemberBalanceHistory } from "@/lib/balance-history";

export type BalanceAdjustmentInput = {
  memberId: string;
  balanceAdjustment: string;
  adjustmentNote: string;
  expectedBalance: string;
  requestId: string;
};

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
const shortDateTimeFormat = new Intl.DateTimeFormat("zh-TW", {
  timeZone: "Asia/Taipei",
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

function displayTime(value: string | null, format = dateTimeFormat) {
  if (!value) return "時間未記錄";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "時間未記錄" : format.format(date);
}

export default function BalanceHistoryDialog({
  member,
  adjustBalance,
  onClose,
}: {
  member: { id: string; name: string; accountName?: string };
  adjustBalance: (input: BalanceAdjustmentInput) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const settings = useRef<HTMLDivElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const adjustmentDialog = useRef<HTMLDialogElement>(null);
  const adjustmentTitle = useRef<HTMLHeadingElement>(null);
  const adjustmentInput = useRef<HTMLInputElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [adjustment, setAdjustment] = useState("");
  const [adjustmentNote, setAdjustmentNote] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const pendingRequest = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const [adjustmentError, setAdjustmentError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const focusAfterSave = useRef<"history" | "adjustment" | null>(null);

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  useEffect(() => {
    if (saving || !focusAfterSave.current) return;
    const target = focusAfterSave.current === "history" ? closeButton : adjustmentInput;
    focusAfterSave.current = null;
    target.current?.focus();
  }, [saving, savedNotice, adjustmentError]);

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
  const parsedAdjustment = adjustment.trim() ? Number(adjustment) : NaN;
  const previewBalance = history && Number.isSafeInteger(parsedAdjustment) && Math.abs(parsedAdjustment) <= 100000 ? history.currentBalance + parsedAdjustment : null;
  const openAdjustment = () => {
    if (!history || !adjustmentDialog.current || adjustmentDialog.current.open) return;
    setSettingsOpen(false);
    adjustmentDialog.current.showModal();
    adjustmentInput.current?.focus();
  };
  const cancelAdjustment = () => {
    if (savingRef.current) return;
    adjustmentDialog.current?.close();
    setAdjustment("");
    setAdjustmentNote("");
    setAdjustmentError(null);
    (settingsButton.current?.disabled ? closeButton.current : settingsButton.current)?.focus();
  };

  const submitAdjustment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!history || savingRef.current) return;
    setAdjustmentError(null);
    setSavedNotice(null);
    const delta = Number(adjustment);
    const note = adjustmentNote.trim();
    if (!adjustment.trim() || !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 100000) {
      setAdjustmentError("請輸入非 0、介於 -100,000 至 100,000 的整數金額。");
      return;
    }
    if (!note || note.length > 200) {
      setAdjustmentError("請填寫餘額調整原因（最多 200 字）。");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    adjustmentTitle.current?.focus();
    let saved = false;
    try {
      const fingerprint = JSON.stringify([member.id, delta, note]);
      if (pendingRequest.current?.fingerprint !== fingerprint) pendingRequest.current = { fingerprint, requestId: crypto.randomUUID() };
      await adjustBalance({ memberId: member.id, balanceAdjustment: String(delta), adjustmentNote: note, expectedBalance: String(history.currentBalance), requestId: pendingRequest.current.requestId });
      saved = true;
      pendingRequest.current = null;
      adjustmentDialog.current?.close();
      setAdjustment("");
      setAdjustmentNote("");
      setSavedNotice("餘額調整已儲存。");
      setState({ status: "loading" });
      setAttempt((value) => value + 1);
    } catch (error) {
      setAdjustmentError(error instanceof Error && !(error instanceof TypeError) && !(error instanceof SyntaxError) ? error.message : "無法確認儲存結果，請先重新載入紀錄；重試相同內容不會重複調整。");
    } finally {
      savingRef.current = false;
      focusAfterSave.current = saved ? "history" : "adjustment";
      setSaving(false);
    }
  };

  const reloadHistory = () => {
    if (savingRef.current) return;
    setSettingsOpen(false);
    (adjustmentDialog.current?.open ? adjustmentTitle.current : closeButton.current)?.focus();
    setAdjustmentError(null);
    setState({ status: "loading" });
    setAttempt((value) => value + 1);
  };

  const historyDialog = (
    <div className="modal-cover balance-history-cover" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !savingRef.current) onClose();
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
        onClick={(event) => {
          if (!settingsOpen || settings.current?.contains(event.target as Node)) return;
          const activeElement = document.activeElement;
          if (!dialog.current?.contains(activeElement) || settings.current?.contains(activeElement)) {
            settingsButton.current?.focus();
          }
          setSettingsOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (savingRef.current) return;
            if (settingsOpen) {
              setSettingsOpen(false);
              settingsButton.current?.focus();
            } else {
              onClose();
            }
            return;
          }
          if (event.key !== "Tab") return;
          const controls = dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]), summary, [tabindex='0']");
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
          <div className="balance-history-actions">
            <div className="balance-history-settings" ref={settings}>
              <button
                ref={settingsButton}
                type="button"
                className="balance-history-settings-button"
                aria-label="餘額設定"
                title="餘額設定"
                aria-expanded={settingsOpen}
                aria-controls={settingsOpen ? "balance-history-settings-panel" : undefined}
                disabled={!history || saving}
                onClick={() => setSettingsOpen((open) => !open)}
              >
                <span aria-hidden="true">⋯</span>
              </button>
              {settingsOpen && (
                <div className="balance-history-settings-panel" id="balance-history-settings-panel">
                  <button type="button" className="link" aria-haspopup="dialog" onClick={openAdjustment}>調整餘額</button>
                </div>
              )}
            </div>
            <button ref={closeButton} type="button" className="close" onClick={() => { if (!savingRef.current) onClose(); }} disabled={saving} aria-label="關閉餘額異動紀錄">×</button>
          </div>
        </header>

        <div className="balance-history-content" tabIndex={0} role="region" aria-label="餘額紀錄內容" aria-busy={state.status === "loading"}>
          <p id="balance-history-description" className="balance-history-note">時間以台北時間顯示。</p>
          {savedNotice && <p className="balance-adjustment-success" role="status">{savedNotice}{state.status === "error" ? " 異動紀錄暫時無法載入，請重新載入紀錄。" : ""}</p>}
          {state.status === "loading" && <p className="balance-history-state" role="status">正在載入餘額紀錄…</p>}
          {state.status === "error" && (
            <div className="balance-history-state balance-history-error">
              <p role="alert">{state.message}</p>
              <button type="button" className="secondary" onClick={reloadHistory}>重新載入</button>
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
              <div className="balance-history-list-heading"><h3>異動明細</h3><span>{history.entries.length} 筆</span><button type="button" className="secondary small" disabled={saving} onClick={reloadHistory}>重新載入紀錄</button></div>
              {history.entries.length === 0 ? (
                <p className="balance-history-state" role="status">目前沒有可查詢的餘額異動紀錄。</p>
              ) : (
                <ol className="balance-history-list">
                  {history.entries.map((entry) => (
                    <li key={entry.id}>
                      <details name="balance-history-entries">
                        <summary className="balance-history-entry-summary">
                          <span className="balance-history-entry-copy">
                            <strong className="balance-history-entry-reason">{entry.reason}</strong>
                            <span className="balance-history-entry-meta">
                              <time dateTime={entry.occurredAt ?? undefined}>
                                <span className="balance-history-entry-time-short">{displayTime(entry.occurredAt, shortDateTimeFormat)}</span>
                                <span className="balance-history-entry-time-full">{displayTime(entry.occurredAt)}</span>
                              </time>
                              {" · "}{entry.actorName ?? "操作者未記錄"}
                            </span>
                          </span>
                          <strong className={`balance-history-entry-amount ${entry.amount < 0 ? "balance-history-decrease" : "balance-history-increase"}`}>
                            {signedCurrency(entry.amount)}
                          </strong>
                          <span className="balance-history-entry-chevron" aria-hidden="true" />
                        </summary>
                        {(entry.invoiceId || entry.invoiceLabel || entry.eventDates.length > 0 || entry.source === "legacy") && (
                          <dl className="balance-history-entry-details">
                            {(entry.invoiceId || entry.invoiceLabel) && (
                              <div>
                                <dt>關聯帳單</dt>
                                <dd>
                                  {entry.invoiceLabel ?? entry.invoiceId}
                                  {entry.invoiceLabel && entry.invoiceId && <small>帳單編號：{entry.invoiceId}</small>}
                                </dd>
                              </div>
                            )}
                            {entry.eventDates.length > 0 && <div><dt>活動日期</dt><dd>{entry.eventDates.map((date) => date.replace(/-/g, "/")).join("、")}</dd></div>}
                            {entry.source === "legacy" && <div><dt>資料來源</dt><dd>舊紀錄</dd></div>}
                          </dl>
                        )}
                      </details>
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

  return (
    <>
      {historyDialog}
      <dialog
        ref={adjustmentDialog}
        className="modal balance-adjustment-dialog"
        aria-labelledby="balance-adjustment-title"
        onCancel={(event) => {
          event.preventDefault();
          cancelAdjustment();
        }}
      >
        <button type="button" className="close" onClick={cancelAdjustment} disabled={saving} aria-label="關閉調整餘額">×</button>
        <h2 ref={adjustmentTitle} id="balance-adjustment-title" tabIndex={-1}>調整餘額</h2>
        <span>{history?.memberName ?? member.name}{history && ` · 目前餘額 ${currency(history.currentBalance)}`}</span>
        <form className="balance-adjustment-form" onSubmit={(event) => void submitAdjustment(event)} aria-busy={saving}>
          <label htmlFor="balance-adjustment-amount">餘額調整</label>
          <input ref={adjustmentInput} id="balance-adjustment-amount" name="balanceAdjustment" type="number" step="1" min="-100000" max="100000" value={adjustment} onChange={(event) => setAdjustment(event.target.value)} placeholder="例如：150 或 -150" required disabled={saving} aria-describedby="balance-adjustment-help" />
          <small id="balance-adjustment-help">正數增加、負數扣除。每次最多 NT$100,000，金額為整數元。</small>
          <label htmlFor="balance-adjustment-note">餘額調整原因</label>
          <input id="balance-adjustment-note" name="adjustmentNote" maxLength={200} value={adjustmentNote} onChange={(event) => setAdjustmentNote(event.target.value)} placeholder="必填，例如：特殊退款" required disabled={saving} />
          {previewBalance !== null && parsedAdjustment !== 0 && <p className="balance-adjustment-preview">預計調整後餘額：<strong>{currency(previewBalance)}</strong></p>}
          {state.status === "loading" && <p className="balance-adjustment-preview" role="status">正在重新載入餘額…</p>}
          {(adjustmentError || state.status === "error") && (
            <>
              <p className="balance-adjustment-error" role="alert">{adjustmentError ?? (state.status === "error" ? state.message : "")}</p>
              <button type="button" className="link balance-adjustment-reload" onClick={reloadHistory}>重新載入餘額</button>
            </>
          )}
          <div>
            <button type="button" className="secondary" onClick={cancelAdjustment} disabled={saving}>取消</button>
            <button type="submit" className="primary" disabled={saving || !history}>{saving ? "儲存中…" : "儲存餘額調整"}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
