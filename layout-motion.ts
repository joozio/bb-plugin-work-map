import { useLayoutEffect, useRef, type RefObject } from "react";

const duration = 320;

// Measure around the React update so grid reflow is visible, including collapse.
export function useMapMotion(
  canvas: RefObject<HTMLElement | null>,
  layoutKey: string,
  scale = 1,
) {
  type Bounds = { left: number; top: number; width: number; height: number };
  const before = useRef<Map<string, Bounds> | null>(null);
  const last = useRef<Map<string, Bounds>>(new Map());
  const lastKey = useRef(layoutKey);
  const lastScale = useRef(scale);
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
    const zooming = lastScale.current !== scale;
    lastScale.current = scale;
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
      const dx = (from.left - to.left) / scale,
        dy = (from.top - to.top) / scale;
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
              clipPath: `inset(-5px ${Math.max(-5, (to.width - from.width) / scale - 5)}px ${Math.max(-5, (to.height - from.height) / scale - 5)}px -5px round 18px)`,
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
