import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, ReactNode } from "react";
import type { WorkItem, AreaOrchestrator } from "./model";
import { activityLabel, dueLabel, isWorking } from "./model";
import {
  HEAT_LABEL,
  cardLayout,
  evenOut,
  expandedWeights,
  fitsWord,
  foldSmall,
  heatOrder,
  openAreaShare,
  openAreaWant,
  labelRow,
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
/** Inside an expanded area no tile is lighter than this share of the heaviest. */
const EVEN_RATIO = 0.8;
/** Pixels a card spends before its title besides its act row: slot padding,
    tile chrome, key line. The act row itself is measured from the page. */
const CARD_CHROME = 4 + 12 + 14.35;
/** Until the first measurement: a 24px button, 3px padding each side, a 1px edge. */
const ACT_ROW = 24 + 6 + 1;
/** A card in an open area is never narrower than this; the grid scrolls instead. */
const MIN_CARD_W = 150;
const TITLE_LINE = 14.03;
const LINE_ROW = 15.5;
const LINE_MORE = 13.5;
const FACTS_ROW = 14.8;
/** Widths at which the act row keeps every label, only the lead label, or none.
    Measured: the lead label needs 93px beside two 23px icons and 22px of chrome. */
const ACTS_FULL = 240;
const ACTS_LEAD = 166;
const FALLBACK = { width: 1280, height: 720 };
const RUNNING = "agent running";
/** The area header and the body padding are not available to the tiles. */
const HEADER = 31;
/** Below this area width the header keeps only the name and an orchestrator. */
const TIGHT = 200;
const BODY_PAD = 6;
/** The gap between rows of the bulk bar. */
const BULK_GAP = 6;
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
  const [transient, setTransient] = useState(0);
  useEffect(() => {
    const node = actionsRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      setActionsHeight(0);
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      setActionsHeight(entry.contentRect.height);
      // The picker and its hint come and go; the cards keep their width.
      let passing = 0;
      node
        .querySelectorAll<HTMLElement>(".wm-bulk-transient")
        .forEach((part) => {
          if (part.offsetHeight > 0) passing += part.offsetHeight + BULK_GAP;
        });
      setTransient(passing);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [expandedAreaId]);
  // The card footer's height is read from the rendered act row, never assumed:
  // its buttons grow to touch size on phones and the row budget must follow.
  const [actRow, setActRow] = useState(ACT_ROW);
  useEffect(() => {
    const node = frame.current?.querySelector<HTMLElement>(
      ".wm-heat-area-open .wm-tile-actions",
    );
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const height =
        entry.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight ?? 0;
      if (height > 0) setActRow(height);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [expandedAreaId, expandedItemId, areas]);
  const ordered = useMemo(() => heatOrder(areas), [areas]);
  // Narrow screens stack areas as bands; the open one grows per card it holds.
  const openTiles =
    ordered.find((area) => area.id === expandedAreaId)?.tiles.length ?? 0;
  const layout = useMemo(() => {
    const rows = partition(ordered, { ...UNIT, w: size.width, h: size.height });
    const opened = ordered.find((area) => area.id === expandedAreaId);
    // An open area grows for its cards (or fully for an open card), and never
    // so far that a neighbour loses its name.
    const share = opened
      ? openAreaShare(
          ordered,
          opened.id,
          rows,
          { w: size.width, h: size.height },
          expandedItemId
            ? AREA_SHARE
            : openAreaWant(opened.tiles.length, AREA_SHARE),
        )
      : 0;
    const rects = place(
      rows,
      expandedWeights(ordered, expandedAreaId, share),
      UNIT,
    );
    // Two title lines and the measured act row: the least a card can be.
    const minCard = { w: MIN_CARD_W, h: CARD_CHROME + actRow + 2 * TITLE_LINE };
    return ordered.map((area) => {
      const rect = rects.get(area.id) ?? UNIT;
      const open = area.id === expandedAreaId;
      const ranked = heatOrder(area.tiles);
      const bodyHeight = Math.max(
        1,
        (rect.h / 100) * size.height -
          HEADER -
          BODY_PAD -
          (open ? actionsHeight : 0),
      );
      const bodyWidth = Math.max(1, (rect.w / 100) * size.width - BODY_PAD);
      // An open area with nothing expanded inside it is a grid of cards in
      // rank order, each at least readable; the body scrolls past that.
      if (open && !expandedItemId) {
        // Columns are chosen as if the picker were shut, so opening it
        // scrolls the cards rather than narrowing them into icon-only acts.
        const grid = cardLayout(
          ranked.map((tile) => tile.id),
          { w: bodyWidth, h: bodyHeight + transient },
          minCard,
        );
        return {
          area,
          rect,
          tiles: ranked,
          inner: grid.rects,
          bodyHeight: grid.height,
          scroll: grid.height > bodyHeight + 0.5,
        };
      }
      // Every tile in an expanded area is a card to read and act on, so the
      // pull range is evened out; order still carries the rank. Anything the
      // squarified map would draw too small for its key and a title line
      // folds into one "+N more" tile instead of a blank sliver.
      const keep = open ? expandedItemId : undefined;
      const tiles = foldSmall(
        open ? evenOut(ranked, EVEN_RATIO) : ranked,
        { w: bodyWidth, h: bodyHeight },
        { id: area.id, keep, share: TILE_SHARE },
      );
      const inner = place(
        partition(tiles, { ...UNIT, w: bodyWidth, h: bodyHeight }),
        expandedWeights(tiles, keep, TILE_SHARE),
        UNIT,
      );
      return { area, rect, tiles, inner, bodyHeight, scroll: false };
    });
  }, [
    ordered,
    expandedAreaId,
    expandedItemId,
    size.width,
    size.height,
    actionsHeight,
    transient,
    actRow,
  ]);
  return (
    <div
      className="wm-heat"
      ref={frame}
      style={
        {
          "--wm-heat-areas": ordered.length,
          "--wm-heat-open-tiles": openTiles,
        } as CSSProperties
      }
    >
      {layout.map(({ area, rect, tiles, inner, bodyHeight, scroll }) => {
        const open = area.id === expandedAreaId;
        const width = (rect.w / 100) * size.width;
        const height = (rect.h / 100) * size.height;
        return (
          <section
            key={area.id}
            data-layout-id={area.id}
            className={`wm-heat-area ${open ? "wm-heat-area-open" : ""} ${width < TIGHT ? "wm-heat-area-tight" : ""}`}
            style={box(rect)}
            aria-label={`${area.title} · ${areaState(area)}`}
          >
            <header className="wm-heat-head">
              <button
                type="button"
                className="wm-heat-name"
                data-work-id={area.root?.id}
                aria-expanded={open}
                onClick={() => onOpenArea(area)}
                aria-label={`${area.root ? "Open project" : "Show every session in"} ${area.title}. ${areaState(area)}.`}
              >
                <strong>{area.title}</strong>
                <em
                  className={
                    area.orchestrator
                      ? `wm-heat-orchestrated ${overCap(area.orchestrator) ? "wm-heat-over-cap" : ""}`
                      : undefined
                  }
                >
                  {/* A narrow header drops its counts but keeps who has taken the area. */}
                  {width < TIGHT && area.orchestrator
                    ? `orchestrator · ${area.orchestrator.running}/${area.orchestrator.limit}`
                    : areaState(area)}
                </em>
              </button>
            </header>
            {open && (
              <div className="wm-heat-actions-frame" ref={actionsRef}>
                {areaActions?.(area)}
              </div>
            )}
            <div
              className={`wm-heat-body ${scroll ? "wm-heat-body-scroll" : ""}`}
            >
              <div
                className="wm-heat-cards"
                style={scroll ? { height: bodyHeight } : undefined}
              >
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
                      open={open && tile.id === expandedItemId}
                      onOpen={onOpen}
                      onOpenArea={onOpenArea}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                      details={tileDetails}
                      actions={open ? tileActions : undefined}
                      excerpt={open ? excerpt : undefined}
                      picked={!!selected?.includes(tile.item?.id ?? "")}
                      actRow={actRow}
                    />
                  );
                })}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
function overCap(orchestrator: AreaOrchestrator) {
  return orchestrator.running > orchestrator.limit;
}
/**
 * What one line under the area name says. An orchestrator replaces the
 * running count: the reader needs "one agent has this area", not the number
 * of threads it spawned, until that number breaks the cap it was given.
 */
export function areaState(area: HeatArea) {
  const { orchestrator } = area;
  const orchestrated = orchestrator
    ? overCap(orchestrator)
      ? `orchestrator · ${orchestrator.running} running, over the cap of ${orchestrator.limit}`
      : `orchestrator · ${orchestrator.running} of ${orchestrator.limit} running`
    : "";
  return (
    [
      area.waiting ? `${area.waiting} need you` : "",
      orchestrated || (area.running ? `${area.running} running` : ""),
    ]
      .filter(Boolean)
      .join(" · ") || `${area.items.length} quiet`
  );
}
function Tile({
  tile,
  rect,
  width,
  height,
  area,
  now,
  open,
  onOpen,
  onOpenArea,
  onDragStart,
  onDragEnd,
  details,
  actions,
  excerpt,
  picked,
  actRow,
}: {
  tile: HeatTile;
  rect: Rect;
  width: number;
  height: number;
  area: HeatArea;
  now: number;
  open: boolean;
  onOpen: (item: WorkItem) => void;
  onOpenArea: (area: HeatArea) => void;
  onDragStart: (event: DragEvent, item: WorkItem) => void;
  onDragEnd: () => void;
  details?: ReactNode;
  actions?: (item: WorkItem) => ReactNode;
  excerpt?: (item: WorkItem) => string;
  picked?: boolean;
  actRow: number;
}) {
  const item = tile.item;
  // Title from 30px of height; a key alone down to 30px of width; below that, colour only.
  const tiny = !open && (width < 52 || height < 30);
  const sliver = !open && (width < 44 || height < 18);
  const roomy = open || (height > 92 && width > 150);
  if (!item && tile.overflow) {
    const names = tile.members.map(
      (member) => member.task?.key ?? member.title,
    );
    const count = tile.members.length;
    return (
      <div className="wm-heat-slot" data-layout-id={tile.id} style={box(rect)}>
        <button
          type="button"
          className="wm-heat-tile wm-heat-quiet wm-heat-group wm-heat-more"
          // A project opens as its card grid; the Sessions area has no grid, so
          // its "+N more" opens the heaviest folded session in place.
          onClick={() =>
            area.root || !tile.members[0]
              ? onOpenArea(area)
              : onOpen(tile.members[0])
          }
          title={names.join(", ")}
          aria-label={`Show ${count} more in ${area.title}: ${names.join(", ")}`}
        >
          <span className="wm-heat-meta">
            <span>+{count} more</span>
          </span>
        </button>
      </div>
    );
  }
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
  // Tasks name their timing driver; session wait ages remain separate.
  const lead = item.task?.key ?? (working ? "running" : shortAge);
  const label = tile.timing
    ? tile.timing.label
    : waiting
      ? tile.waited === null
        ? ""
        : tile.waited
          ? `${tile.waited}d`
          : "<1d"
      : due && !due.endsWith("passed")
        ? due.replace(/^(Due|Planned) /, (word) => word.toLowerCase())
        : "";
  // The key never gives way; the label shows whole or not at all, and the
  // accessible description keeps it either way.
  const row = open ? { lead, label } : labelRow(width, lead, label, working);
  // Past due up to two weeks is urgent; longer past due reads as stale.
  const late = !!tile.timing?.overdue && tile.timing.late;
  const overdue = !!tile.timing?.overdue && !late;
  // Inside an expanded area a tile is a small card: it spends its room on the
  // state of the work rather than on empty fill. Tiles too small to hold a
  // title cannot hold facts either, so they keep exactly what they had.
  const inside = !!actions && !tiny && height > 74 && width > 104;
  const status = item.task?.nextAction || item.task?.summary || "";
  const attached = item.task?.sessionLinks?.length ?? item.threads.length;
  // The hue already says what the work needs; a fact repeats it only when it
  // adds something the legend does not: who it waits on, what it asked for.
  const reason =
    item.reason === HEAT_LABEL[tile.tone] || item.reason === "Inactive"
      ? ""
      : item.reason;
  const facts = inside
    ? [
        reason,
        item.task && item.task.priority !== "none"
          ? `${item.task.priority} priority`
          : "",
        working
          ? RUNNING
          : attached
            ? `${attached} session${attached === 1 ? "" : "s"}`
            : "",
        item.task?.waitingOn && item.task.waitingOn !== "none"
          ? `waiting on ${item.task.waitingOn}`
          : "",
      ].filter(Boolean)
    : [];
  // One line only: the agent's latest word if the map has it, else the next step.
  const line = inside ? (excerpt?.(item) || status).trim() : "";
  // The card is budgeted in whole rows from its real height, so nothing is
  // ever cut mid-line: two title lines first, then the latest word, then the
  // facts, then a third title line if room is left.
  let lines = 1;
  let lineRows = 0;
  let showFacts = false;
  if (inside) {
    let room = height - CARD_CHROME - actRow - TITLE_LINE;
    if (room >= TITLE_LINE) {
      lines = 2;
      room -= TITLE_LINE;
    }
    if (line && room >= LINE_ROW) {
      lineRows = 1;
      room -= LINE_ROW;
    }
    if (facts.length && room >= FACTS_ROW) {
      showFacts = true;
      room -= FACTS_ROW;
    }
    // Spare rows go to the title and the latest word in turn, so a tall card
    // reads its whole title and more of the agent's word instead of blank fill.
    for (const [row, cost] of [
      ["title", TITLE_LINE],
      ["line", LINE_MORE],
      ["title", TITLE_LINE],
      ["line", LINE_MORE],
      ["title", TITLE_LINE],
    ] as const) {
      if (room < cost) break;
      if (row === "title") lines += 1;
      else if (lineRows) lineRows += 1;
      else continue;
      room -= cost;
    }
  } else {
    // Clamp the title to the lines that actually fit, so nothing is cut mid-word.
    const spent = 27 + (roomy ? 16 : 0);
    lines = Math.max(1, Math.min(4, Math.floor((height - spent) / 14)));
  }
  // The act row keeps its labels only where they fit whole: every tile of a
  // similar width reads the same, and a label is never cut to an ellipsis.
  const acts = inside
    ? width >= ACTS_FULL
      ? "full"
      : width >= ACTS_LEAD
        ? "lead"
        : "icons"
    : undefined;
  return (
    <div
      className={`wm-heat-slot ${open ? "wm-heat-slot-open" : ""}`}
      data-layout-id={tile.id}
      data-acts={acts}
      style={
        {
          ...box(rect),
          "--wm-heat-lines": lines,
          "--wm-heat-line-rows": lineRows,
        } as CSSProperties
      }
    >
      <button
        type="button"
        data-work-id={item.id}
        data-level={tile.level}
        data-timing={tile.timing?.kind}
        aria-expanded={open}
        aria-controls={open ? `detail-${item.id}` : undefined}
        className={`wm-heat-tile wm-heat-${tile.tone} ${working ? "wm-heat-running" : ""} ${item.focus ? "wm-heat-focused" : ""} ${overdue ? "wm-heat-overdue" : ""} ${late ? "wm-heat-late" : ""} ${tile.timing?.aged ? "wm-heat-aged" : ""} ${!tile.timing && tile.stale ? "wm-heat-stale" : ""} ${tiny ? "wm-heat-tiny" : ""} ${sliver ? "wm-heat-sliver" : ""} ${!open && width < 118 ? "wm-heat-narrow" : ""} ${!open && width < 72 ? "wm-heat-keyonly" : ""} ${picked ? "wm-heat-picked" : ""} ${inside ? "wm-heat-inside" : ""}`}
        draggable
        onDragStart={(event) => onDragStart(event, item)}
        onDragEnd={onDragEnd}
        onClick={() => onOpen(item)}
        title={label && !row.label ? label : undefined}
        aria-label={[
          `Preview ${item.title}`,
          HEAT_LABEL[tile.tone],
          item.focus ? "In focus" : "",
          tile.timing?.description ?? "",
          waiting
            ? tile.waited === null
              ? ""
              : tile.waited
                ? `Waiting ${tile.waited} ${tile.waited === 1 ? "day" : "days"}`
                : "Waiting less than a day"
            : age,
          item.task ? `${item.task.priority} priority` : "",
          due,
        ]
          .filter(Boolean)
          .join(". ")}
      >
        <span className="wm-heat-meta">
          <span>
            {row.lead && <span className="wm-heat-key-text">{row.lead}</span>}
            {ask && <em className="wm-heat-ask">{ask}</em>}
          </span>
          {row.label && <span>{row.label}</span>}
        </span>
        {!tiny && <span className="wm-heat-title">{title}</span>}
        {roomy && !inside && (
          <span className="wm-heat-reason">{item.reason}</span>
        )}
        {showFacts && (
          <span className="wm-heat-facts">
            {facts.map((fact) =>
              fact === RUNNING ? (
                // The word whole, or only the green dot: never a clipped word.
                <em key={fact} className="wm-heat-run-fact">
                  {fitsWord(width, fact) && fact}
                </em>
              ) : (
                <em key={fact}>{fact}</em>
              ),
            )}
          </span>
        )}
        {lineRows > 0 && <span className="wm-heat-line">{line}</span>}
      </button>
      {inside && actions?.(item)}
      {open && details}
    </div>
  );
}
