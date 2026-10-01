import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const duration = 320;
const EDITABLE =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * Whether a keydown can move the map, so measuring every tile first is worth
 * it: Escape steps back, Enter and Space activate a map control. Typing never
 * can, and a reply in the chat editor must not measure the map per keystroke.
 */
export function keyMovesLayout(event: {
  key: string;
  target: EventTarget | null;
}) {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(EDITABLE)) return false;
  if (event.key === "Escape" || event.key === "Enter") return true;
  return (
    event.key === " " && !!target?.closest("button, [role='button'], summary")
  );
}

/**
 * How far a scrolling box must move so `inner`'s bottom edge, and with it the
 * chat composer and its controls, sits inside the box above its padding.
 * Never negative: what already shows whole is left where it is.
 */
export function revealBottom(
  outer: { bottom: number },
  inner: { bottom: number },
  padding = 0,
) {
  return Math.max(0, Math.ceil(inner.bottom - (outer.bottom - padding)));
}

// Measure around the React update so grid reflow is visible, including collapse.
export function useMapMotion(
  canvas: RefObject<HTMLElement | null>,
  layoutKey: string,
  zoom = 1,
) {
  type Bounds = { left: number; top: number; width: number; height: number };
  const before = useRef<Map<string, Bounds> | null>(null);
  const last = useRef<Map<string, Bounds>>(new Map());
  const lastKey = useRef(layoutKey);
  const lastZoom = useRef(zoom);
  const animations = useRef<Animation[]>([]);
  const reducedMotion = () =>
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const elements = () =>
    Array.from(
      canvas.current?.querySelectorAll<HTMLElement>("[data-layout-id]") ?? [],
    );
  const bounds = (element: HTMLElement): Bounds => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left + (canvas.current?.scrollLeft ?? 0),
      top: rect.top + (canvas.current?.scrollTop ?? 0),
      width: rect.width,
      height: rect.height,
    };
  };
  const measure = () =>
    new Map(
      elements().map((element) => [element.dataset.layoutId!, bounds(element)]),
    );
  const cancel = () => {
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
  };
  const capture = () => {
    before.current = reducedMotion() ? null : measure();
    // Capture the current visual positions before interrupting a rapid second click.
    cancel();
  };
  useLayoutEffect(() => {
    const previous = before.current ?? last.current;
    const changed = lastKey.current !== layoutKey;
    const zooming = lastZoom.current !== zoom;
    lastZoom.current = zoom;
    lastKey.current = layoutKey;
    before.current = null;
    if (!changed) {
      if (
        !animations.current.some(
          (animation) => animation.playState === "running",
        )
      )
        last.current = measure();
      return;
    }
    cancel();
    const changes = elements().map((element) => ({
      element,
      from: previous.get(element.dataset.layoutId!),
      to: bounds(element),
    }));
    last.current = new Map(
      changes.map(({ element, to }) => [element.dataset.layoutId!, to]),
    );
    if (zooming || reducedMotion()) return;
    for (const { element, from, to } of changes) {
      if (
        !from?.width ||
        !from.height ||
        !to.width ||
        !to.height ||
        !element.animate
      )
        continue;
      const dx = from.left - to.left,
        dy = from.top - to.top;
      if (
        Math.abs(dx) +
          Math.abs(dy) +
          Math.abs(from.width - to.width) +
          Math.abs(from.height - to.height) <
        1
      )
        continue;
      animations.current.push(
        element.animate(
          [
            {
              transform: `translate(${dx}px, ${dy}px)`,
              clipPath: `inset(-5px ${Math.max(-5, to.width - from.width - 5)}px ${Math.max(-5, to.height - from.height - 5)}px -5px round 18px)`,
              opacity: 0.85,
            },
            {
              transform: "none",
              clipPath: "inset(-5px -5px -5px -5px round 18px)",
              opacity: 1,
            },
          ],
          { duration, easing: "cubic-bezier(.2,.8,.2,1)" },
        ),
      );
    }
  });
  useLayoutEffect(() => {
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const change = () => {
      if (media?.matches) cancel();
    };
    media?.addEventListener?.("change", change);
    return () => {
      cancel();
      media?.removeEventListener?.("change", change);
    };
  }, []);
  return capture;
}

/**
 * Keep an open chat's composer in view. An open card's details can be shorter
 * than the chat's floor; they scroll then, and this scrolls them so the reply
 * editor and its controls are never under the card's edge. It runs when the
 * chat opens and whenever the details or the chat change size, never on a
 * scroll, so reading back up through the details is never fought. `where`
 * names the surface, so moving the chat between card and pane re-runs it.
 */
export function useRevealChat(chatId: string | null, where = "") {
  useEffect(() => {
    if (!chatId) return;
    const live = document.getElementById(chatId);
    const detail = live?.closest<HTMLElement>(".wm-inline-detail");
    if (!live || !detail) return;
    const reveal = () => {
      const padding = parseFloat(getComputedStyle(detail).paddingBottom) || 0;
      detail.scrollTop += revealBottom(
        detail.getBoundingClientRect(),
        live.getBoundingClientRect(),
        padding,
      );
    };
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(detail);
    observer.observe(live);
    return () => observer.disconnect();
  }, [chatId, where]);
}
