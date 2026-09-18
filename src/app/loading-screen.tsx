import ShuttleArt from "@/app/shuttle-art";

type LoadingScreenProps = {
  title?: string;
  description?: string;
  compact?: boolean;
  error?: boolean;
  onRetry?: () => void;
};

export default function LoadingScreen({
  title = "正在準備球場…",
  description = "正在讀取活動與帳號資訊，請稍候。",
  compact = false,
  error = false,
  onRetry,
}: LoadingScreenProps) {
  const content = (
    <section className={`shuttle-loader${compact ? " shuttle-loader--compact" : ""}${error ? " shuttle-loader--error" : ""}`}>
      <div className="shuttle-loader__scene" aria-hidden="true">
        <div className="shuttle-loader__halo" />
        <svg className="shuttle-loader__court" viewBox="0 0 240 240" fill="none" focusable="false">
          <ellipse className="shuttle-loader__shadow" cx="120" cy="218" rx="60" ry="6" fill="currentColor" opacity=".1" />
          <g className="shuttle-loader__racket" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <path d="m144 167 52 29" strokeWidth="5" />
            <path d="m187 191 27 15" strokeWidth="12" />
            <path d="m193 191-3 6m10-2-3 6m10-2-3 6" stroke="#d5f168" strokeWidth="2" />
            <path d="M53 160c-1-27 102-28 104 0 1 27-103 27-104 0Z" fill="#d5f168" strokeWidth="3" />
            <path d="M59 160c0-20 91-21 92 0 0 20-92 20-92 0Z" fill="#f7fbf8" strokeWidth="1.5" />
            <path d="M69 154h72M63 160h84M69 166h72M77 151v18M91 149v22M105 148v24M119 149v22M133 151v18" strokeWidth="1" opacity=".45" />
          </g>
          <g className="shuttle-loader__bird">
            <g transform="translate(86 114.4) scale(0.6)">
              <ShuttleArt />
            </g>
          </g>
        </svg>
      </div>
      <div className="shuttle-loader__copy" role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"} aria-atomic="true">
        <strong className="shuttle-loader__title">{title}</strong>
        <p>{description}</p>
      </div>
      {!error && <div className="shuttle-loader__dots" aria-hidden="true"><i /><i /><i /></div>}
      {error && onRetry && <button type="button" className="primary" onClick={onRetry}>重新載入</button>}
    </section>
  );

  return compact ? content : <main className="loading-screen">{content}</main>;
}
