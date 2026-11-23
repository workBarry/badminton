import ShuttleJuggle from "./shuttle-juggle";

type LoadingScreenProps = {
  title?: string;
  description?: string;
  compact?: boolean;
  error?: boolean;
  onRetry?: () => void;
};

export default function LoadingScreen({
  title = "loading",
  description = "",
  compact = false,
  error = false,
  onRetry,
}: LoadingScreenProps) {
  const content = (
    <section className={`serve-loading${compact ? " serve-loading--compact" : ""}${error ? " serve-loading--error" : ""}`}>
      <div className="serve-loading__scene" aria-hidden="true">
        {error ? (
          <svg viewBox="0 0 200 200" fill="none" focusable="false">
            <circle cx="100" cy="100" r="78" fill="#fff3e5" />
            <circle cx="100" cy="100" r="32" stroke="currentColor" strokeWidth="3" />
            <path d="M100 82v23" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
            <circle cx="100" cy="116" r="2.5" fill="currentColor" />
          </svg>
        ) : (
          <ShuttleJuggle compact={compact} />
        )}
      </div>
      <div className="serve-loading__text" role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"} aria-atomic="true">
        <strong className="serve-loading__title">{error ? title : "loading"}</strong>
        {error && description && <p>{description}</p>}
      </div>
      {error && onRetry && <button type="button" className="serve-loading__retry" onClick={onRetry}>重新載入</button>}
    </section>
  );
  return compact ? content : <main className="loading-screen">{content}</main>;
}
