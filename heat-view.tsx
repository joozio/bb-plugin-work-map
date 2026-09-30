import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, ReactNode } from "react";
import type { WorkItem } from "./model";
import { activityLabel, dueLabel, isWorking } from "./model";
import {
  HEAT_LABEL,
  expandedWeights,
  heatOrder,
  needsYou,
  partition,
  place,
  tileText,
  type HeatArea,
  type HeatTile,
  type Rect,
} from "./heat";

const UNIT: Rect = { x: 0, y: 0, w: 100, h: 100 };
const AREA_SHARE = 0.66;
const TILE_SHARE = 0.78;
const FALLBACK = { width: 1280, height: 720 };
/** The area header and the body padding are not available to the tiles. */
const HEADER = 31;
const BODY_PAD = 6;
const box = (rect: Rect): CSSProperties => ({
  left: `${rect.x}%`,
  top: `${rect.y}%`,
  width: `${rect.w}%`,
  height: `${rect.h}%`,
});
export interface HeatProps {
  areas: HeatArea[];
  expandedAreaId?: string;
  expandedItemId?: string;
  now: number;
  /** 0 at actual size, 1 fully zoomed in: more label detail, same geometry. */
  detail: number;
  onOpenArea: (area: HeatArea) => void;
  onOpen: (item: WorkItem) => void;
  onDragStart: (event: DragEvent, item: WorkItem) => void;
  onDragEnd: () => void;
  areaActions?: (area: HeatArea) => ReactNode;
  tileDetails?: ReactNode;
  /** Rendered on each tile of the expanded area, beneath its text. */
  tileActions?: (item: WorkItem) => ReactNode;
  /** One line of live agent text for a tile, when the map already has it. */
  excerpt?: (item: WorkItem) => string;
  selected?: string[];
}
export function HeatMap({
  areas,
  expandedAreaId,
  expandedItemId,
  now,
  detail,
  onOpenArea,
  onOpen,
  onDragStart,
  onDragEnd,
  areaActions,
  tileDetails,
  tileActions,
  excerpt,
  selected,
}: HeatProps) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(FALLBACK);
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [actionsHeight, setActionsHeight] = useState(0);
  useEffect(() => {
    const node = actionsRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      setActionsHeight(0);
      return;
    }
    const observer = new ResizeObserver(([entry]) =>
      setActionsHeight(entry.contentRect.height),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [expandedAreaId]);
  const ordered = useMemo(() => heatOrder(areas), [areas]);
  const layout = useMemo(() => {
    const rects = place(
      partition(ordered, { ...UNIT, w: size.width, h: size.height }),
      expandedWeights(ordered, expandedAreaId, AREA_SHARE),
      UNIT,
    );
    return ordered.map((area) => {
      const rect = rects.get(area.id) ?? UNIT;
      const tiles = heatOrder(area.tiles);
      const bodyHeight = Math.max(
        1,
        (rect.h / 100) * size.height -
          HEADER -
          BODY_PAD -
          (area.id === expandedAreaId ? actionsHeight : 0),
      );
      const inner = place(
        partition(tiles, {
          ...UNIT,
          w: (rect.w / 100) * size.width,
          h: bodyHeight,
        }),
        expandedWeights(
          tiles,
          area.id === expandedAreaId ? expandedItemId : undefined,
          TILE_SHARE,
        ),
        UNIT,
      );
      return { area, rect, tiles, inner, bodyHeight };
    });
  }, [
    ordered,
    expandedAreaId,
    expandedItemId,
    size.width,
    size.height,
    actionsHeight,
  ]);
  return (
    <div
      className="wm-heat"
      ref={frame}
      style={{ "--wm-heat-areas": ordered.length } as CSSProperties}
    >
      {layout.map(({ area, rect, tiles, inner, bodyHeight }) => {
        const open = area.id === expandedAreaId;
        const width = (rect.w / 100) * size.width;
        const height = (rect.h / 100) * size.height;
        return (
          <section
            key={area.id}
            data-layout-id={area.id}
            className={`wm-heat-area ${open ? "wm-heat-area-open" : ""} ${width < 200 ? "wm-heat-area-tight" : ""}`}
            style={box(rect)}
            aria-label={`${area.title} · ${area.waiting} need you · ${area.running} running`}
          >
            <header className="wm-heat-head">
              <button
                type="button"
                className="wm-heat-name"
                data-work-id={area.root?.id}
                aria-expanded={open}
                onClick={() => onOpenArea(area)}
                aria-label={`${area.root ? "Open project" : "Show every session in"} ${area.title}. ${area.waiting} need you. ${area.running} running.`}
              >
                <strong>{area.title}</strong>
                <em>
                  {[
                    area.waiting ? `${area.waiting} need you` : "",
                    area.running ? `${area.running} running` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ") || `${area.items.length} quiet`}
                </em>
              </button>
            </header>
            {open && (
              <div className="wm-heat-actions-frame" ref={actionsRef}>
                {areaActions?.(area)}
              </div>
            )}
            <div className="wm-heat-body">
              {tiles.map((tile) => {
                const cell = inner.get(tile.id) ?? UNIT;
                return (
                  <Tile
                    key={tile.id}
                    tile={tile}
                    rect={cell}
                    width={(cell.w / 100) * Math.max(0, width - BODY_PAD)}
                    height={(cell.h / 100) * bodyHeight}
                    area={area}
                    now={now}
                    detail={detail}
                    open={open && tile.id === expandedItemId}
                    onOpen={onOpen}
                    onOpenArea={onOpenArea}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    details={tileDetails}
                    actions={open ? tileActions : undefined}
                    excerpt={open ? excerpt : undefined}
                    picked={!!selected?.includes(tile.item?.id ?? "")}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
function Tile({
  tile,
  rect,
  width,
  height,
  area,
  now,
  detail,
  open,
  onOpen,
  onOpenArea,
  onDragStart,
  onDragEnd,
  details,
  actions,
  excerpt,
  picked,
}: {
  tile: HeatTile;
  rect: Rect;
  width: number;
  height: number;
  area: HeatArea;
  now: number;
  detail: number;
  open: boolean;
  onOpen: (item: WorkItem) => void;
  onOpenArea: (area: HeatArea) => void;
  onDragStart: (event: DragEvent, item: WorkItem) => void;
  onDragEnd: () => void;
  details?: ReactNode;
  actions?: (item: WorkItem) => ReactNode;
  excerpt?: (item: WorkItem) => string;
  picked?: boolean;
}) {
  const item = tile.item;
  // Title from 30px of height; a key alone down to 30px of width; below that, colour only.
  const tiny = !open && (width < 52 || height < 30);
  const sliver = !open && (width < 44 || height < 18);
  const roomy = open || (height > 92 && width > 150);
  if (!item) {
    const finished = tile.members.every((member) => member.kind === "thread");
    const noun = finished
      ? `agent${tile.members.length === 1 ? "" : "s"} finished`
      : `quiet task${tile.members.length === 1 ? "" : "s"}`;
    return (
      <div className="wm-heat-slot" data-layout-id={tile.id} style={box(rect)}>
        <button
          type="button"
          className="wm-heat-tile wm-heat-quiet wm-heat-group"
          onClick={() => onOpenArea(area)}
          aria-label={`Show ${tile.members.length} ${noun} in ${area.title}`}
        >
          <span className="wm-heat-meta">
            <span>
              {tile.members.length} {noun}
            </span>
          </span>
          {!tiny && (
            <span className="wm-heat-dots" aria-hidden="true">
              {tile.members.slice(0, 60).map((member) => (
                <i key={member.id} />
              ))}
            </span>
          )}
        </button>
      </div>
    );
  }
  const { ask, title } = tileText(item.title);
  const due = item.task ? dueLabel(item.task, now) : "";
  const age = activityLabel(item, now);
  // Narrow tiles cannot hold "Active 2h ago", and a clipped label reads as a bug.
  const shortAge = age.replace(/^Active /, "").replace(/ ago$/, "");
  const working = isWorking(item);
  const waiting = needsYou(tile.tone);
  // Left: what it is. Right: how long it has waited on you, else a date still
  // ahead, else how fresh it is. A passed date is already inside the wait.
  // A session has no key: running says so, otherwise its age takes the line.
  const left = item.task?.key ?? (working ? "running" : shortAge);
  const right = waiting
    ? tile.waited
      ? `${tile.waited}d`
      : "today"
    : due && !due.endsWith("passed")
      ? due.replace(/^(Due|Planned) /, (word) => word.toLowerCase())
      : item.task && detail > 0
        ? shortAge
        : "";
  // Inside an expanded area a tile is a small card: it spends its room on the
  // state of the work rather than on empty fill. Tiles too small to hold a
  // title cannot hold facts either, so they keep exactly what they had.
  const inside = !!actions && !tiny && height > 74 && width > 104;
  const dense = inside && height > 104 && width > 132;
  const status = item.task?.nextAction || item.task?.summary || "";
  const attached = item.task?.sessionLinks?.length ?? item.threads.length;
  const facts = dense
    ? [
        item.reason,
        item.task && item.task.priority !== "none"
          ? `${item.task.priority} priority`
          : "",
        working
          ? "agent running"
          : attached
            ? `${attached} session${attached === 1 ? "" : "s"}`
            : "",
        item.task?.waitingOn && item.task.waitingOn !== "none"
          ? `waiting on ${item.task.waitingOn}`
          : "",
      ].filter(Boolean)
    : [];
  // One line only: the agent's latest word if the map has it, else the next step.
  const line =
    (dense && height > 86 && (excerpt?.(item) || status).trim()) || "";
  // Clamp the title to the lines that actually fit, so nothing is cut mid-word.
  const rows = (roomy && !facts.length ? 1 : 0) + (facts.length ? 1 : 0) + (line ? 1 : 0);
  const spent =
    27 +
    (roomy && !facts.length ? 14 : 0) +
    (facts.length ? 14 : 0) +
    (line ? 16 : 0) +
    rows * 2;
  const lines = Math.max(
    1,
    Math.min(4, Math.floor((height - spent - (inside ? 22 : 0)) / 14)),
  );
  return (
    <div
      className={`wm-heat-slot ${open ? "wm-heat-slot-open" : ""}`}
      data-layout-id={tile.id}
      style={{ ...box(rect), "--wm-heat-lines": lines } as CSSProperties}
    >
      <button
        type="button"
        data-work-id={item.id}
        data-level={tile.level}
        aria-expanded={open}
        aria-controls={open ? `detail-${item.id}` : undefined}
        className={`wm-heat-tile wm-heat-${tile.tone} ${working ? "wm-heat-running" : ""} ${item.focus ? "wm-heat-focused" : ""} ${tile.stale ? "wm-heat-stale" : ""} ${tiny ? "wm-heat-tiny" : ""} ${sliver ? "wm-heat-sliver" : ""} ${!open && width < 118 ? "wm-heat-narrow" : ""} ${!open && width < 72 ? "wm-heat-keyonly" : ""} ${picked ? "wm-heat-picked" : ""} ${inside ? "wm-heat-inside" : ""}`}
        draggable
        onDragStart={(event) => onDragStart(event, item)}
        onDragEnd={onDragEnd}
        onClick={() => onOpen(item)}
        aria-label={[
          `Preview ${item.title}`,
          HEAT_LABEL[tile.tone],
          item.focus ? "In focus" : "",
          waiting
            ? tile.waited
              ? `Waiting ${tile.waited} days`
              : "Waiting since today"
            : age,
          item.task ? `${item.task.priority} priority` : "",
          due,
        ]
          .filter(Boolean)
          .join(". ")}
      >
        <span className="wm-heat-meta">
          <span>
            {left}
            {ask && <em className="wm-heat-ask">{ask}</em>}
          </span>
          <span>{right}</span>
        </span>
        {!tiny && <span className="wm-heat-title">{title}</span>}
        {roomy && !facts.length && (
          <span className="wm-heat-reason">{item.reason}</span>
        )}
        {dense && facts.length > 0 && (
          <span className="wm-heat-facts">
            {facts.map((fact) => (
              <em key={fact}>{fact}</em>
            ))}
          </span>
        )}
        {dense && line && <span className="wm-heat-line">{line}</span>}
      </button>
      {inside && actions?.(item)}
      {open && details}
    </div>
  );
}
