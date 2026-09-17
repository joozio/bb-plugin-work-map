import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { MAX_ZOOM, MIN_ZOOM, snapZoom } from "./zoom";

type Anchor = {
  element: HTMLElement;
  id?: string;
  x: number;
  y: number;
  fractionX: number;
  fractionY: number;
};
const isEditor = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest(
    "input,textarea,select,[contenteditable=true],.wm-session-launcher,.wm-live-session,.wm-settle",
  );

export function useMapZoom(
  canvas: RefObject<HTMLElement | null>,
  world: RefObject<HTMLDivElement | null>,
  preferredId: string | undefined,
  disabled: boolean,
) {
  const [zoom, setZoom] = useState(1);
  const [anchorId, setAnchorId] = useState<string>();
  const [anchorWorkId, setAnchorWorkId] = useState<string>();
  const value = useRef(1);
  const raw = useRef(1);
  const anchor = useRef<Anchor | null>(null);
  const latest = useRef({ preferredId, disabled });
  latest.current = { preferredId, disabled };
  const detentUntil = useRef(0);

  function capture(x?: number, y?: number) {
    const viewport = canvas.current,
      map = world.current;
    if (!viewport || !map) return;
    const rect = viewport.getBoundingClientRect();
    const pointX = x ?? rect.left + viewport.clientWidth / 2;
    const pointY = y ?? rect.top + viewport.clientHeight / 2;
    const cards = Array.from(
      map.querySelectorAll<HTMLElement>("[data-work-id]"),
    );
    const positions = new Map(
      cards.map((element) => [element, element.getBoundingClientRect()]),
    );
    const visible = cards.filter((element) => {
      const r = positions.get(element)!;
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > rect.top &&
        r.top < rect.bottom &&
        r.right > rect.left &&
        r.left < rect.right
      );
    });
    const preferred =
      x === undefined
        ? visible.find(
            (element) => element.dataset.workId === latest.current.preferredId,
          )
        : undefined;
    const underPointer = visible
      .filter((element) => {
        const r = positions.get(element)!;
        return (
          pointX >= r.left &&
          pointX <= r.right &&
          pointY >= r.top &&
          pointY <= r.bottom
        );
      })
      .at(-1);
    const nearest = [...visible].sort((a, b) => {
      const distance = (element: HTMLElement) => {
        const r = positions.get(element)!;
        return (
          (r.left + r.width / 2 - pointX) ** 2 +
          (r.top + r.height / 2 - pointY) ** 2
        );
      };
      return distance(a) - distance(b);
    })[0];
    const element = preferred ?? underPointer ?? nearest ?? map;
    const bounds = positions.get(element) ?? element.getBoundingClientRect();
    const px = Math.max(
      bounds.left,
      Math.min(
        bounds.right,
        preferred ? bounds.left + bounds.width / 2 : pointX,
      ),
    );
    const py = Math.max(
      bounds.top,
      Math.min(
        bounds.bottom,
        preferred ? bounds.top + bounds.height / 2 : pointY,
      ),
    );
    setAnchorId(
      element.closest<HTMLElement>("[data-layout-id]")?.dataset.layoutId,
    );
    setAnchorWorkId(element.dataset.workId);
    anchor.current = {
      element,
      id: element.dataset.workId,
      x: px - rect.left,
      y: py - rect.top,
      fractionX: bounds.width ? (px - bounds.left) / bounds.width : 0,
      fractionY: bounds.height ? (py - bounds.top) / bounds.height : 0,
    };
  }
  function change(
    next: number,
    point?: { x: number; y: number },
    step = false,
  ) {
    if (latest.current.disabled) return;
    const crossing =
      (value.current < 1 && next > 1) || (value.current > 1 && next < 1);
    raw.current = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
    const target = step && crossing ? 1 : snapZoom(raw.current);
    if (target === value.current) return;
    capture(point?.x, point?.y);
    value.current = target;
    if (step) raw.current = target;
    setZoom(target);
  }
  // Runs before paint. Preserve the point within the same card despite detail reflow.
  useLayoutEffect(() => {
    const saved = anchor.current,
      viewport = canvas.current;
    anchor.current = null;
    if (!saved || !viewport) return;
    const element = saved.element.isConnected
      ? saved.element
      : Array.from(
          world.current?.querySelectorAll<HTMLElement>("[data-work-id]") ?? [],
        ).find((item) => item.dataset.workId === saved.id);
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const rect = viewport.getBoundingClientRect();
    viewport.scrollLeft +=
      bounds.left + bounds.width * saved.fractionX - rect.left - saved.x;
    viewport.scrollTop +=
      bounds.top + bounds.height * saved.fractionY - rect.top - saved.y;
  }, [zoom]);
  useEffect(() => {
    const viewport = canvas.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !world.current) return;
      event.preventDefault();
      if (
        isEditor(event.target) ||
        latest.current.disabled ||
        Date.now() < detentUntil.current
      )
        return;
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? viewport.clientHeight
            : 1);
      const next =
        raw.current * Math.exp(-Math.max(-120, Math.min(120, delta)) * 0.0025);
      const crossing =
        (value.current < 1 && next >= 1) || (value.current > 1 && next <= 1);
      const previous = value.current;
      change(crossing ? 1 : next, { x: event.clientX, y: event.clientY });
      if (value.current === 1 && previous !== 1) {
        raw.current = 1;
        detentUntil.current = Date.now() + 250;
      }
    };
    const key = (event: KeyboardEvent) => {
      if (
        isEditor(event.target) ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        !world.current?.contains(event.target as Node)
      )
        return;
      if (!["+", "=", "-", "0"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      change(
        event.key === "0"
          ? 1
          : value.current + (event.key === "-" ? -0.1 : 0.1),
        undefined,
        true,
      );
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    viewport.addEventListener("keydown", key);
    return () => {
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("keydown", key);
    };
  }, [canvas, world]);
  return {
    zoom,
    anchorId,
    anchorWorkId,
    set: (next: number) => {
      if (Date.now() < detentUntil.current) return;
      const previous = value.current;
      change(next, undefined, true);
      if (value.current === 1 && previous !== 1)
        detentUntil.current = Date.now() + 250;
    },
    step: (direction: number) =>
      change(value.current + direction * 0.1, undefined, true),
    reset: () => {
      change(1, undefined, true);
      setAnchorId(undefined);
      setAnchorWorkId(undefined);
    },
  };
}

export function ZoomControls({
  zoom,
  set,
  step,
  reset,
  disabled,
}: ReturnType<typeof useMapZoom> & { disabled: boolean }) {
  return (
    <div className="wm-zoom-controls" role="group" aria-label="Map zoom">
      <button
        aria-label="Zoom out"
        title="Zoom out: more work, less detail"
        disabled={disabled || zoom <= MIN_ZOOM}
        onClick={() => step(-1)}
      >
        −
      </button>
      <div className="wm-zoom-slider">
        <input
          type="range"
          aria-label="Map zoom level"
          aria-valuetext={`${Math.round(zoom * 100)} percent${zoom === 1 ? ", actual size" : ""}`}
          min={MIN_ZOOM * 100}
          max={MAX_ZOOM * 100}
          step={1}
          value={Math.round(zoom * 100)}
          disabled={disabled}
          onChange={(event) => set(Number(event.target.value) / 100)}
        />
        <i aria-hidden="true" />
      </div>
      <button
        aria-label="Zoom in"
        title="Zoom in: more detail"
        disabled={disabled || zoom >= MAX_ZOOM}
        onClick={() => step(1)}
      >
        +
      </button>
      <output aria-label="Current map zoom">{Math.round(zoom * 100)}%</output>
      {zoom !== 1 && (
        <button
          className="wm-zoom-reset"
          aria-label="Reset to actual size"
          title="Reset to actual size (100%)"
          disabled={disabled}
          onClick={reset}
        >
          100% ↺
        </button>
      )}
    </div>
  );
}
