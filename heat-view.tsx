import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, ReactNode } from "react";
import type { WorkItem, AreaOrchestrator } from "./model";
import { activityLabel, dueLabel } from "./model";
import {
  HEAT_LABEL,
  cardLayout,
  closedStatus,
  evenOut,
  expandedWeights,
  fitsWord,
  foldSmall,
  heatOrder,
  heatWorking,
  openAreaShare,
  openAreaWant,
  labelRow,
  needsYou,
  partition,
  place,
  tileText,
  toneRank,
  type HeatArea,
  type HeatTile,
  type Rect,
  heatTone,
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
/** Pixels of slack on a card's minimum height against sub-pixel rounding. */
const ROUNDING = 2;
const LINE_ROW = 15.5;
const LINE_MORE = 13.5;
const FACTS_ROW = 14.8;
/** Widths at which the act row keeps every label, only the lead label, or none.
    Measured: the lead label needs 93px beside two 23px icons and 22px of chrome. */
const ACTS_FULL = 240;
const ACTS_LEAD = 166;
const FALLBACK = { width: 1280, height: 720 };
const RUNNING = "agent running";
/** The rank numeral and its gap, taken from the label row's room. */
const RANK_W = 19;
/** One row of date fixes: 24px buttons, 3px padding each side, a 1px edge. */
const FIX_ROW = 24 + 6 + 1;
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
  /** Tidy mode: slipped dates are the work; everything else dims. */
  tidy?: boolean;
  /** The date-fix row a slipped tile wears in tidy mode. */
  dateFixes?: (item: WorkItem) => ReactNode;
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
  tidy,
  dateFixes,
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
    // Two title lines and the measured act row: the least a card can be,
    // plus a margin so rounding never leaves the second line a hair short.
    const minCard = {
      w: MIN_CARD_W,
      h: CARD_CHROME + actRow + 2 * TITLE_LINE + ROUNDING,
    };
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
      data-tidy={tidy ? "true" : undefined}
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
            data-tier={area.tier}
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
                {/* The area's hottest tier, so the big picture reads at area level. */}
                <i
                  className="wm-heat-key wm-heat-swatch"
                  data-tier={area.tier}
                  aria-hidden="true"
                />
                <strong>{area.title}</strong>
                <em
                  className={
                    area.orchestrator
                      ? `wm-heat-orchestrated ${overCap(area.orchestrator) ? "wm-heat-over-cap" : ""}`
                      : undefined
                  }
                >
                  {/* A narrow header shortens its counts, never drops them. */}
                  {areaState(area, width < TIGHT)}
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
                      fixes={tidy ? dateFixes : undefined}
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
 * `tight` is the narrow header: the same counts in fewer letters, because a
 * count hidden at small widths is exactly the running work you lose.
 */
export function areaState(area: HeatArea, tight = false) {
  const { orchestrator } = area;
  const orchestrated = orchestrator
    ? tight
      ? `${area.waiting ? "orch" : "orchestrator ·"} ${orchestrator.running}/${orchestrator.limit}`
      : overCap(orchestrator)
        ? `orchestrator · ${orchestrator.running} running, over the cap of ${orchestrator.limit}`
        : `orchestrator · ${orchestrator.running} of ${orchestrator.limit} running`
    : "";
  return (
    [
      area.waiting ? `${area.waiting} ${tight ? "need" : "need you"}` : "",
      orchestrated ||
        (area.running ? `${area.running} ${tight ? "run" : "running"}` : ""),
    ]
      .filter(Boolean)
      .join(" · ") || `${area.items.length} quiet`
  );
}
/**
 * The head of a fold: how many it holds and, ahead of everything else, how
 * many of them need you or are running. Short words when the full ones do
 * not fit; the count of hidden work never drops.
 */
export function foldHead(tile: HeatTile, width: number) {
  const count = tile.members.length;
  const counts = (tight: boolean) =>
    [
      tile.waiting ? `${tile.waiting} ${tight ? "need" : "need you"}` : "",
      tile.running ? `${tile.running} ${tight ? "run" : "running"}` : "",
    ].filter(Boolean);
  // When the whole fold is one kind of work, its count is that kind.
  const whole =
    tile.waiting === count
      ? ["need you", "need"]
      : tile.running === count
        ? ["running", "run"]
        : null;
  const options = whole
    ? whole.map((word) => `+${count} ${word}`)
    : [
        [`+${count} more`, ...counts(false)].join(" · "),
        [`+${count} more`, ...counts(true)].join(" · "),
        [`+${count}`, ...counts(true)].join(" · "),
      ];
  return options.find((text) => fitsWord(width, text)) ?? options.at(-1)!;
}
/** The head line of a group tile, then one row per member, then the rest. */
const GROUP_HEAD = 20;
const GROUP_ROW = 18;
const GROUP_PAD = 10;
/** How many member rows a group tile this tall can list under its head. */
export function groupRows(height: number, members: number) {
  const fit = Math.floor((height - GROUP_HEAD - GROUP_PAD) / GROUP_ROW);
  // One row alone would only repeat the head; two or more are worth listing.
  return fit < 2 ? 0 : Math.min(members, fit);
}
/**
 * A tile that stands for several pieces of work: the quiet pile, finished
 * agents, or what folded because it was too small to read. It is never an
 * empty box: as many of its members as fit are listed as rows, each one a
 * way in, and only the remainder is a count.
 */
function GroupTile({
  tile,
  rect,
  width,
  height,
  area,
  now,
  tiny,
  onOpen,
  onOpenArea,
}: {
  tile: HeatTile;
  rect: Rect;
  width: number;
  height: number;
  area: HeatArea;
  now: number;
  tiny: boolean;
  onOpen: (item: WorkItem) => void;
  onOpenArea: (area: HeatArea) => void;
}) {
  // A fold lists, and opens, its strongest member first: what needs you, then
  // running work, then by score.
  const members = [...tile.members].sort(
    (a, b) =>
      (tile.overflow
        ? toneRank(heatTone(a)) - toneRank(heatTone(b)) ||
          Number(heatWorking(b)) - Number(heatWorking(a))
        : 0) || b.score - a.score,
  );
  const count = members.length;
  const finished =
    !tile.overflow && members.every((member) => member.kind === "thread");
  const noun = tile.overflow
    ? "more"
    : finished
      ? `agent${count === 1 ? "" : "s"} finished`
      : `quiet task${count === 1 ? "" : "s"}`;
  const head = tile.overflow ? foldHead(tile, width) : `${count} ${noun}`;
  const names = members.map((member) => member.task?.key ?? member.title);
  // Rows need a key beside the dot, and a few words of title from 110px;
  // narrower than 60px, the head alone.
  const keysOnly = width < 110;
  const fit = tiny || width < 60 ? 0 : groupRows(height, count);
  const shown = fit >= count ? members : members.slice(0, Math.max(0, fit - 1));
  const rest = count - shown.length;
  // A project opens as its card grid. The Sessions area has no grid, so its
  // "+N more" opens the strongest folded session in place (members are
  // sorted so); its quiet pile of finished agents still opens the area.
  const openGroup = () =>
    !tile.overflow || area.root || !members[0]
      ? onOpenArea(area)
      : onOpen(members[0]);
  return (
    <div className="wm-heat-slot" data-layout-id={tile.id} style={box(rect)}>
      <div
        className={`wm-heat-tile wm-heat-${tile.overflow ? tile.tone : "quiet"} wm-heat-group ${tile.overflow ? "wm-heat-more" : ""} ${tile.running ? "wm-heat-running" : ""} ${shown.length ? "wm-heat-group-list" : ""}`}
        data-tier={tile.overflow ? tile.tier : undefined}
        role="group"
        aria-label={`${tile.overflow ? foldHead(tile, Infinity) : head} in ${area.title}`}
        title={tile.overflow ? names.join(", ") : undefined}
      >
        <button
          type="button"
          className="wm-heat-group-head"
          onClick={openGroup}
          title={names.join(", ")}
          aria-label={`${tile.overflow && !area.root && members[0] ? `Open ${members[0].title}, the strongest of` : "Show"} ${count} ${noun} in ${area.title}${tile.overflow ? `${tile.waiting ? `, ${tile.waiting} need you` : ""}${tile.running ? `, ${tile.running} running` : ""}: ${names.join(", ")}` : ""}`}
        >
          <span className="wm-heat-meta">
            <span>{head}</span>
          </span>
        </button>
        {shown.length > 0 && (
          <ul className={`wm-heat-rows ${keysOnly ? "wm-heat-rows-keys" : ""}`}>
            {shown.map((member) => (
              <li key={member.id}>
                <button
                  type="button"
                  className="wm-heat-row"
                  onClick={() => onOpen(member)}
                  title={member.title}
                  aria-label={`Open ${member.title}`}
                >
                  <i
                    className={`wm-heat-row-dot wm-heat-${heatTone(member)}`}
                    data-tier={area.tiers.get(member.id) ?? "later"}
                    aria-hidden="true"
                  />
                  {member.task?.key ? <b>{member.task.key}</b> : null}
                  {(!keysOnly || !member.task?.key) && (
                    <span>{member.title}</span>
                  )}
                </button>
              </li>
            ))}
            {rest > 0 && (
              <li>
                <button
                  type="button"
                  className="wm-heat-row wm-heat-row-rest"
                  onClick={openGroup}
                >
                  +{rest} more
                </button>
              </li>
            )}
          </ul>
        )}
        {!shown.length && !tiny && !tile.overflow && (
          <span className="wm-heat-dots" aria-hidden="true">
            {members.slice(0, 60).map((member) => (
              <i key={member.id} />
            ))}
          </span>
        )}
      </div>
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
  fixes,
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
  /** In tidy mode, the date-fix row a slipped tile wears. */
  fixes?: (item: WorkItem) => ReactNode;
}) {
  const item = tile.item;
  // Title from 30px of height; a key alone down to 30px of width; below that, colour only.
  const tiny = !open && (width < 52 || height < 30);
  const sliver = !open && (width < 44 || height < 18);
  const roomy = open || (height > 92 && width > 150);
  if (!item)
    return (
      <GroupTile
        tile={tile}
        rect={rect}
        width={width}
        height={height}
        area={area}
        now={now}
        tiny={tiny}
        onOpen={onOpen}
        onOpenArea={onOpenArea}
      />
    );
  const { ask, title } = tileText(item.title);
  const due = item.task ? dueLabel(item.task, now) : "";
  const age = activityLabel(item, now);
  // Narrow tiles cannot hold "Active 2h ago", and a clipped label reads as a bug.
  const shortAge = age.replace(/^Active /, "").replace(/ ago$/, "");
  // Closed status wins over any attached agent: no ring, no "running".
  const closed = closedStatus(item);
  const working = heatWorking(item);
  const waiting = needsYou(tile.tone);
  // Tasks name their timing driver; session wait ages remain separate.
  const lead = item.task?.key ?? (working ? "running" : shortAge);
  const timingLabel = tile.timing
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
  // A coloured tile says why in words: the reason line takes the label's
  // place, falling back to its compact words, then to the date alone. A
  // Later tile keeps the plain date.
  const label = tile.reason || timingLabel;
  const shorter = tile.reason
    ? [tile.compact, tile.timing?.compact ?? ""]
    : [tile.timing?.compact ?? ""];
  // The key never gives way; the label shows whole or not at all, and the
  // accessible description keeps it either way.
  // The ask tag is hidden on a narrow tile (below 118px), so it is not budgeted there.
  // One of the map's three hottest wears its number ahead of the key.
  // A request for your hands or a failed run keeps its shape on any heat:
  // a ring and a glyph ahead of the key. Dates speak through the label and
  // the heat; no edge or hatch repeats them.
  const flag = tile.tone === "input" ? "!" : tile.tone === "error" ? "✕" : "";
  const rank = tiny ? undefined : tile.rank;
  const row = open
    ? { lead, label, ask }
    : labelRow(width - (rank ? RANK_W : 0) - (flag ? RANK_W : 0), lead, label, working, {
        compact: shorter,
        ask: width < 118 ? "" : ask,
      });
  // In tidy mode a slipped tile wears its date-fix row where it has the room:
  // one row of four from 160px, two rows of two from 92px; below that the
  // area opens to its cards, which always have the room.
  const fixRows =
    fixes && tile.slipped && !tiny && !closed
      ? width >= 160 && height >= 60
        ? 1
        : width >= 92 && height >= 86
          ? 2
          : 0
      : 0;
  const fixHeight = fixRows * FIX_ROW;
  // Inside an expanded area a tile is a small card: it spends its room on the
  // state of the work rather than on empty fill. Tiles too small to hold a
  // title cannot hold facts either, so they keep exactly what they had.
  const inside = !!actions && !tiny && height > 74 && width > 104;
  // A slipped card in tidy mode spends its footer on the date fixes.
  const footer: "acts" | "fixes" | null = inside
    ? fixes && tile.slipped && !closed
      ? "fixes"
      : "acts"
    : fixRows
      ? "fixes"
      : null;
  const status = item.task?.nextAction || item.task?.summary || "";
  const attached = item.task?.sessionLinks?.length ?? item.threads.length;
  // The hue already says what the work needs; a fact repeats it only when it
  // adds something the legend does not: who it waits on, what it asked for.
  const reason =
    closed ||
    item.reason === HEAT_LABEL[tile.tone] ||
    item.reason === "Inactive"
      ? ""
      : item.reason;
  const facts = inside
    ? [
        closed ?? "",
        reason,
        item.task && item.task.priority !== "none"
          ? `${item.task.priority} priority`
          : "",
        closed
          ? ""
          : working
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
    let room =
      height - CARD_CHROME - (footer === "fixes" ? FIX_ROW : actRow) - TITLE_LINE;
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
    const spent = 27 + (roomy ? 16 : 0) + fixHeight;
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
      data-fixes={footer === "fixes" ? (fixRows === 2 ? "grid" : "row") : undefined}
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
        data-tier={tile.tier}
        data-slipped={tile.slipped ? "true" : undefined}
        data-timing={tile.timing?.kind}
        aria-expanded={open}
        aria-controls={open ? `detail-${item.id}` : undefined}
        className={`wm-heat-tile wm-heat-${tile.tone} ${working ? "wm-heat-running" : ""} ${item.focus ? "wm-heat-focused" : ""} ${tiny ? "wm-heat-tiny" : ""} ${sliver ? "wm-heat-sliver" : ""} ${!open && width < 118 ? "wm-heat-narrow" : ""} ${!open && width < 72 ? "wm-heat-keyonly" : ""} ${picked ? "wm-heat-picked" : ""} ${inside ? "wm-heat-inside" : ""}`}
        draggable
        onDragStart={(event) => onDragStart(event, item)}
        onDragEnd={onDragEnd}
        onClick={() => onOpen(item)}
        title={label && row.label !== label ? label : undefined}
        aria-label={[
          `Preview ${item.title}`,
          closed
            ? closed === "done"
              ? "Done"
              : "Canceled"
            : HEAT_LABEL[tile.tone],
          tile.tier === "now"
            ? `Now${tile.rank ? `, ${tile.rank} of 3` : ""}: ${tile.reason}`
            : tile.tier === "next"
              ? `Next: ${tile.reason}`
              : "Later",
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
            {rank && (
              <b className="wm-heat-rank" aria-hidden="true">
                {rank}
              </b>
            )}
            {flag && !tiny && (
              <b className="wm-heat-flag" aria-hidden="true">
                {flag}
              </b>
            )}
            {row.lead && <span className="wm-heat-key-text">{row.lead}</span>}
            {row.ask && <em className="wm-heat-ask">{row.ask}</em>}
          </span>
          {row.label && <span>{row.label}</span>}
        </span>
        {!tiny && <span className="wm-heat-title">{title}</span>}
        {roomy && !inside && (
          <span className="wm-heat-reason">
            {closed ? (closed === "done" ? "Done" : "Canceled") : item.reason}
          </span>
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
      {footer === "acts" && actions?.(item)}
      {footer === "fixes" && (
        <div className="wm-tile-acts wm-tile-fixes">{fixes?.(item)}</div>
      )}
      {open && details}
    </div>
  );
}
