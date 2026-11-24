"use client";

import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { FLOATING_BELL_SIZE, floatingPanel, floatingPoint, floatingRelative, type FloatingPoint, type FloatingViewport } from "@/lib/floating-position";

const STORAGE_KEY = "badminton:notification-position";
type Layout = { viewport: FloatingViewport; point: FloatingPoint };
type Drag = { pointerId: number; x: number; y: number; origin: FloatingPoint; moved: boolean };

function viewport(): FloatingViewport {
  const visible = window.visualViewport;
  return { x: visible?.offsetLeft ?? 0, y: visible?.offsetTop ?? 0,
    width: Math.max(FLOATING_BELL_SIZE, visible?.width ?? window.innerWidth),
    height: Math.max(FLOATING_BELL_SIZE, visible?.height ?? window.innerHeight) };
}

export default function FloatingNotifications({ open, unreadCount, onToggle, onClose, children }: {
  open: boolean; unreadCount: number; onToggle: () => void; onClose: () => void; children: ReactNode;
}) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [dragging, setDragging] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<Layout | null>(null);
  const relative = useRef<FloatingPoint>({ x: 1, y: 1 });
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const helpId = useId();

  const refresh = useCallback(() => {
    const visible = viewport();
    const next = { viewport: visible, point: floatingPoint(relative.current, visible) };
    layoutRef.current = next;
    setLayout(next);
  }, []);
  const save = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(relative.current)); } catch { /* Storage may be disabled. */ }
  };
  const move = (point: FloatingPoint) => {
    const visible = viewport();
    relative.current = floatingRelative(point, visible);
    const next = { viewport: visible, point: floatingPoint(relative.current, visible) };
    layoutRef.current = next;
    setLayout(next);
  };

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
        relative.current = { x: Math.min(1, Math.max(0, stored.x)), y: Math.min(1, Math.max(0, stored.y)) };
      }
    } catch { /* Keep the default position when storage is missing or unavailable. */ }
    const frame = requestAnimationFrame(refresh);
    window.addEventListener("resize", refresh);
    window.visualViewport?.addEventListener("resize", refresh);
    window.visualViewport?.addEventListener("scroll", refresh);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", refresh);
      window.visualViewport?.removeEventListener("resize", refresh);
      window.visualViewport?.removeEventListener("scroll", refresh);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) onClose();
    };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("click", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onClose]);

  const beginDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.isPrimary || event.button !== 0 || !layoutRef.current) return;
    suppressClick.current = false;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      origin: layoutRef.current.point, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const updateDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.hypot(dx, dy) <= 5) return;
    current.moved = true;
    setDragging(true);
    move({ x: current.origin.x + dx, y: current.origin.y + dy });
  };
  const endDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    suppressClick.current = current.moved;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.moved) save();
  };
  const moveWithKeys = (event: KeyboardEvent<HTMLButtonElement>) => {
    const directions: Record<string, FloatingPoint> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
    const direction = directions[event.key];
    if (!direction || !layoutRef.current) return;
    event.preventDefault();
    const step = event.shiftKey ? 24 : 8;
    const point = layoutRef.current.point;
    move({ x: point.x + direction.x * step, y: point.y + direction.y * step });
    save();
  };

  const panel = layout ? floatingPanel(layout.point, layout.viewport) : null;
  const style = { visibility: layout ? "visible" : "hidden", "--floating-x": `${layout?.point.x ?? 0}px`,
    "--floating-y": `${layout?.point.y ?? 0}px`, "--notification-left": `${panel?.left ?? 0}px`,
    "--notification-top": `${panel?.top ?? 0}px`, "--notification-width": `${panel?.width ?? 0}px`,
    "--notification-max-height": `${panel?.maxHeight ?? 0}px`, "--notification-translate-y": panel?.translateY ?? "0" } as CSSProperties;
  return <div ref={wrapper} className={`floating-notifications${dragging ? " dragging" : ""}`} data-compact={panel ? panel.maxHeight < 200 : false} style={style}>
    <button type="button" className="bell floating-bell" aria-label={`通知，${unreadCount} 筆未讀，可拖曳移動`}
      aria-describedby={helpId} aria-expanded={open} title="通知（可拖曳移動）" onPointerDown={beginDrag}
      onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onKeyDown={moveWithKeys} onClick={(event) => {
        if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); return; }
        suppressClick.current = false;
        onToggle();
      }}>
      <span aria-hidden="true">🔔</span>{unreadCount > 0 && <em aria-hidden="true">{unreadCount > 99 ? "99+" : unreadCount}</em>}
    </button>
    <span id={helpId} className="sr-only">拖曳或使用方向鍵可移動鈴鐺，按 Enter 或空白鍵開啟通知。</span>
    {children}
  </div>;
}
