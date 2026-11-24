export const FLOATING_BELL_SIZE = 48;
export type FloatingPoint = { x: number; y: number };
export type FloatingViewport = FloatingPoint & { width: number; height: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function floatingBounds(viewport: FloatingViewport) {
  const insetX = Math.min(16, Math.max(0, (viewport.width - FLOATING_BELL_SIZE) / 2));
  const insetY = Math.min(16, Math.max(0, (viewport.height - FLOATING_BELL_SIZE) / 2));
  return { left: viewport.x + insetX, top: viewport.y + insetY,
    right: viewport.x + viewport.width - FLOATING_BELL_SIZE - insetX,
    bottom: viewport.y + viewport.height - FLOATING_BELL_SIZE - insetY };
}

export function floatingPoint(relative: FloatingPoint, viewport: FloatingViewport): FloatingPoint {
  const bounds = floatingBounds(viewport);
  return { x: bounds.left + clamp(relative.x, 0, 1) * (bounds.right - bounds.left),
    y: bounds.top + clamp(relative.y, 0, 1) * (bounds.bottom - bounds.top) };
}

export function floatingRelative(point: FloatingPoint, viewport: FloatingViewport): FloatingPoint {
  const bounds = floatingBounds(viewport);
  return { x: clamp((point.x - bounds.left) / (bounds.right - bounds.left || 1), 0, 1),
    y: clamp((point.y - bounds.top) / (bounds.bottom - bounds.top || 1), 0, 1) };
}

export function floatingPanel(point: FloatingPoint, viewport: FloatingViewport) {
  const margin = Math.min(16, viewport.width / 4);
  const width = Math.min(390, viewport.width - margin * 2);
  const below = viewport.y + viewport.height - 16 - point.y - FLOATING_BELL_SIZE - 12;
  const above = point.y - 12 - viewport.y - 16;
  const openBelow = below >= 240 || below >= above;
  return {
    left: clamp(point.x + FLOATING_BELL_SIZE - width, viewport.x + margin,
      viewport.x + viewport.width - margin - width),
    top: openBelow ? point.y + FLOATING_BELL_SIZE + 12 : point.y - 12,
    width, maxHeight: Math.max(0, Math.min(560, openBelow ? below : above)),
    translateY: openBelow ? "0" : "-100%",
  };
}
