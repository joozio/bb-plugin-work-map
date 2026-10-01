import type { AreaOrchestrator, WorkItem } from "./model";
import { isWorking, needsReview, localDay } from "./model";
import { heatTiming, type HeatTiming } from "./heat-timing";

const DAY = 86400000;
export const STALE_DAYS = 30;
export const SESSIONS_AREA = "heat:sessions";
/** Tones are the map's existing attention channels, not a second vocabulary. */
export type HeatTone =
  "input" | "error" | "review" | "followup" | "unread" | "working" | "quiet";
const ACTION: HeatTone[] = ["input", "error", "review", "followup"];
export const HEAT_LABEL: Record<HeatTone, string> = {
  input: "Needs your input",
  error: "Run failed",
  review: "Needs review",
  followup: "Follow-up due",
  unread: "Ready to read",
  working: "Agent working",
  quiet: "Quiet",
};
export function needsYou(tone: HeatTone) {
  return ACTION.includes(tone);
}
/**
 * A task marked done or canceled reads as closed however its sessions look:
 * an orchestrator stays attached to tasks its children already closed, and
 * its running thread must not paint them as live work.
 */
export function closedStatus(item: WorkItem): "done" | "canceled" | null {
  const status = item.task?.status;
  return status === "done" || status === "canceled" ? status : null;
}
/** Working as Heat shows it: an agent is running and the work is still open. */
export function heatWorking(item: WorkItem) {
  return !closedStatus(item) && isWorking(item);
}
export function heatTone(item: WorkItem): HeatTone {
  if (closedStatus(item)) return "quiet";
  if (item.attention) return item.attention;
  if (needsReview(item)) return "review";
  if (item.unreadResults > 0) return "unread";
  if (heatWorking(item)) return "working";
  return "quiet";
}
/**
 * Age of the current request, never the task's creation or migration date.
 * Reviews use the current status transition; follow-ups use CHECK AFTER.
 * Unknown history has no age rather than an invented start date.
 */
export function waitingSince(item: WorkItem, now: number) {
  const tone = heatTone(item);
  if (!needsYou(tone)) return 0;
  const valid = (at: number) => Number.isFinite(at) && at > 0 && at <= now;
  const task = item.task;
  if (tone === "input" || tone === "error") {
    const requests = item.threads
      .filter((thread) =>
        tone === "input"
          ? thread.hasPendingInteraction ||
            thread.indicator === "waiting-for-input"
          : thread.indicator === "unread-error",
      )
      .map((thread) => thread.latestAttentionAt)
      .filter(valid);
    return requests.length ? Math.min(...requests) : 0;
  }
  if (!task) return 0;
  const since =
    tone === "followup"
      ? Date.parse(`${task.checkAfter}T00:00:00`)
      : Date.parse(task.statusSince ?? "");
  // Date.parse normalizes impossible dates such as February 30.
  if (
    tone === "followup" &&
    (!valid(since) || localDay(since) !== task.checkAfter)
  )
    return 0;
  return valid(since) ? since : 0;
}
/** Whole days this work has waited on you; 0 when it does not need you. */
export function waitDays(item: WorkItem, now: number) {
  const since = waitingSince(item, now);
  return since ? Math.max(0, Math.floor((now - since) / DAY)) : 0;
}
/** The wait once it is past the stale mark, else 0. */
export function staleDays(item: WorkItem, now: number) {
  const days = waitDays(item, now);
  return days > STALE_DAYS ? days : 0;
}
/**
 * How deep the tile's colour goes: 1 to 4. Hue says what the work needs;
 * depth follows the task's current due date, or creation age when undated.
 * Explicit input/error requests and focus remain visible attention signals.
 */
export function heatLevel(item: WorkItem, now: number): 1 | 2 | 3 | 4 {
  const tone = heatTone(item);
  const timing = heatTiming(item, now);
  if (timing) {
    const level = Math.max(
      timing.level,
      tone === "input" || tone === "error" ? 3 : 1,
    );
    return Math.min(4, level + (item.focus ? 1 : 0)) as 1 | 2 | 3 | 4;
  }
  if (tone === "quiet") return 1;
  const priority = item.task?.priority ?? "";
  let level =
    tone === "input" || tone === "error"
      ? 3
      : priority === "urgent" || priority === "high"
        ? 3
        : priority === "medium"
          ? 2
          : 1;
  if (needsYou(tone) && waitDays(item, now) > STALE_DAYS) level += 1;
  if (item.focus) level += 1;
  return Math.min(4, level) as 1 | 2 | 3 | 4;
}
/**
 * The verb Wiz puts in front of a title is the kind of act it asks for.
 * Move it to the label line so the title keeps its words. Only these exact
 * prefixes are read; anything else stays in the title untouched.
 */
const ASK_PREFIX: [RegExp, string][] = [
  [/^review draft:\s+/i, "draft"],
  [/^review:\s+/i, "review"],
  [/^decide:\s+/i, "decide"],
  [/^approve:\s+/i, "approve"],
  [/^confirm:\s+/i, "confirm"],
  [/^check:\s+/i, "check"],
  [/^read:\s+/i, "read"],
  [/^fix:\s+/i, "fix"],
  [/^test:\s+/i, "test"],
];
export function tileText(title: string): { ask: string; title: string } {
  for (const [pattern, ask] of ASK_PREFIX) {
    const rest = title.replace(pattern, "").trim();
    if (rest !== title.trim() && rest) return { ask, title: rest };
  }
  return { ask: "", title: title.trim() };
}
/**
 * Rough width of a label at the tile's 9.5px label size. It errs wide on
 * purpose: a label judged too long is dropped whole rather than cut.
 */
export function labelWidth(text: string) {
  let width = 0;
  for (const char of text)
    width += /[A-Z]/.test(char)
      ? 6.8
      : /[0-9]/.test(char)
        ? 6
        : /[a-z]/.test(char)
          ? 5.4
          : char === " "
            ? 2.8
            : 3.6;
  return width;
}
/** Slot padding, tile padding and a 2px edge on both sides. */
const LABEL_CHROME = 22;
const LABEL_GAP = 5;
/** The running dot and its gap. */
const RUN_DOT = 11;
/**
 * What a tile's label row can say at this width. The key is identity and is
 * never cut; "running" is a word or only the dot, never a clipped word; the
 * timing label shows only when it fits whole beside the lead, otherwise the
 * edge, hatch and accessible description carry it.
 */
export function labelRow(
  width: number,
  lead: string,
  label: string,
  running: boolean,
): { lead: string; label: string } {
  const room = width - LABEL_CHROME;
  const word =
    lead === "running" && RUN_DOT + labelWidth(lead) > room ? "" : lead;
  const used = (running ? RUN_DOT : 0) + labelWidth(word);
  return {
    lead: word,
    label: label && used + LABEL_GAP + labelWidth(label) <= room ? label : "",
  };
}
/** Whether a card this wide holds the word "agent running" whole. */
export function fitsWord(width: number, word: string) {
  return labelWidth(word) <= width - LABEL_CHROME;
}
const TONE_PULL: Record<HeatTone, number> = {
  input: 6,
  error: 5.4,
  review: 3.4,
  followup: 3.4,
  unread: 2.8,
  working: 2.6,
  quiet: 0,
};
const round = (value: number) => Math.round(value * 10000) / 10000;
/**
 * How hard one item pulls on you. Bounded on purpose: ranking score separates
 * first place from second, area size has to keep the quietest work readable.
 */
export function heatPull(item: WorkItem, now: number) {
  const tone = heatTone(item);
  const timing = heatTiming(item, now);
  if (timing) {
    const attention =
      tone === "input"
        ? 2.5
        : tone === "error"
          ? 2
          : tone === "review" || tone === "followup"
            ? 0.5
            : tone === "unread"
              ? 0.4
              : 0;
    const priority =
      item.task?.priority === "urgent"
        ? 0.4
        : item.task?.priority === "high"
          ? 0.2
          : 0;
    return round(
      timing.weight +
        attention +
        priority +
        (heatWorking(item) ? 0.3 : 0) +
        (item.focus ? 2 : 0),
    );
  }
  let pull = 0.8 + TONE_PULL[tone];
  if (tone !== "working" && heatWorking(item)) pull += 1.2;
  if (item.focus) pull += 2;
  // Sessions and tasks with unavailable timing retain their attention signals.
  // Invalid task dates never silently fall back to creation or a date bonus.
  // A long wait pulls harder, up to the weight of a high priority and a bit.
  pull += Math.min(1.5, (waitDays(item, now) / 60) * 1.5);
  return round(Math.max(0.8, Math.min(14, pull)));
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Weighted {
  id: string;
  weight: number;
}
/** One squarified strip. `alongHeight` strips stack their items down the y axis. */
export interface HeatRow {
  alongHeight: boolean;
  ids: string[];
}
const total = (items: readonly Weighted[]) =>
  items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
/** Weight order is the reading order: heaviest first, then id, so it never drifts. */
export function heatOrder<T extends Weighted>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) => b.weight - a.weight || a.id.localeCompare(b.id),
  );
}
/**
 * Squarified treemap, split into two halves. `partition` decides which items
 * share a strip; `place` turns strips into rectangles. Expanding re-runs only
 * `place`, so a growing area never moves its neighbours into other strips.
 */
export function partition(items: readonly Weighted[], rect: Rect): HeatRow[] {
  const rows: HeatRow[] = [];
  let rest = [...items].filter((item) => item.weight > 0);
  let left = total(rest);
  let { w, h } = rect;
  while (rest.length && left > 0 && w > 0 && h > 0) {
    const alongHeight = w >= h;
    const side = Math.min(w, h);
    const scale = (w * h) / left;
    let row: Weighted[] = [];
    let best = Infinity;
    while (rest.length) {
      const candidate = [...row, rest[0]];
      const areas = candidate.map((item) => item.weight * scale);
      const sum = areas.reduce((a, b) => a + b, 0);
      const worst = Math.max(
        (side * side * Math.max(...areas)) / (sum * sum),
        (sum * sum) / (side * side * Math.min(...areas)),
      );
      if (!row.length || worst <= best) {
        best = worst;
        row = candidate;
        rest.shift();
      } else break;
    }
    rows.push({ alongHeight, ids: row.map((item) => item.id) });
    const used = total(row);
    if (alongHeight) w -= (w * used) / left;
    else h -= (h * used) / left;
    left -= used;
  }
  if (rest.length)
    rows.push({ alongHeight: w >= h, ids: rest.map((item) => item.id) });
  return rows;
}
/** Fill `rect` exactly: the last strip and each strip's last item take the remainder. */
export function place(
  rows: readonly HeatRow[],
  weights: ReadonlyMap<string, number>,
  rect: Rect,
): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const weight = (id: string) => Math.max(0, weights.get(id) ?? 0);
  const rowWeight = (row: HeatRow) =>
    row.ids.reduce((sum, id) => sum + weight(id), 0);
  let { x, y, w, h } = rect;
  let left = rows.reduce((sum, row) => sum + rowWeight(row), 0);
  rows.forEach((row, index) => {
    if (!row.ids.length) return;
    const used = rowWeight(row);
    const last = index === rows.length - 1;
    const share = left > 0 ? used / left : 0;
    const strip = row.alongHeight
      ? last
        ? w
        : w * share
      : last
        ? h
        : h * share;
    const span = row.alongHeight ? h : w;
    let cursor = row.alongHeight ? y : x;
    const end = cursor + span;
    row.ids.forEach((id, position) => {
      const size =
        position === row.ids.length - 1
          ? end - cursor
          : used > 0
            ? (span * weight(id)) / used
            : span / row.ids.length;
      out.set(
        id,
        row.alongHeight
          ? { x, y: cursor, w: strip, h: size }
          : { x: cursor, y, w: size, h: strip },
      );
      cursor += size;
    });
    if (row.alongHeight) {
      x += strip;
      w -= strip;
    } else {
      y += strip;
      h -= strip;
    }
    left -= used;
  });
  return out;
}
/**
 * The weight one item needs so it takes `share` of the whole, leaving the rest
 * in proportion. Expansion changes sizes only; strips and order stay put.
 */
export function expandedWeights(
  items: readonly Weighted[],
  id: string | undefined,
  share: number,
): Map<string, number> {
  const weights = new Map(items.map((item) => [item.id, item.weight]));
  if (id === undefined || items.length < 2) return weights;
  const target = weights.get(id);
  if (target === undefined) return weights;
  const rest = total(items) - target;
  const grown = (share * rest) / (1 - share);
  if (grown > target) weights.set(id, grown);
  return weights;
}
/**
 * Raise the lightest entries to a minimum share. A squarified map of a busy
 * project beside a one-task area otherwise squeezes the small one to a sliver
 * you cannot read, which is worse than slightly overstating it.
 */
export function withFloor<T extends Weighted>(
  items: readonly T[],
  minShare: number,
): T[] {
  if (!items.length) return [];
  const share = Math.min(minShare, 0.6 / items.length);
  let out = items.map((entry) => ({ ...entry }));
  for (let pass = 0; pass < 8; pass++) {
    const floor = total(out) * share;
    let raised = false;
    out = out.map((entry) => {
      if (entry.weight >= floor) return entry;
      raised = true;
      return { ...entry, weight: round(floor) };
    });
    if (!raised) break;
  }
  return out;
}
/**
 * The most of the map an area with `tiles` tiles can use: one readable tile
 * needs only a small share, so a single heavy task cannot flood the map.
 */
export function areaCeiling(tiles: number) {
  return Math.min(1, 0.15 + 0.07 * Math.max(1, tiles));
}
/**
 * The floor's counterpart: lower any area above its ceiling share, but keep
 * it a little ahead of the heaviest other area, so rank order survives.
 */
export function withCeiling<T extends Weighted>(
  items: readonly T[],
  ceiling: (item: T) => number,
): T[] {
  let out = items.map((entry) => ({ ...entry }));
  for (let pass = 0; pass < 8; pass++) {
    let lowered = false;
    out = out.map((entry) => {
      const rest = total(out) - entry.weight;
      const share = Math.min(0.99, ceiling(entry));
      const next = Math.max(
        ...out.filter((o) => o !== entry).map((o) => o.weight),
        0,
      );
      const cap = Math.max((share * rest) / (1 - share), next * 1.05);
      if (!rest || entry.weight <= cap + 1e-9) return entry;
      lowered = true;
      return { ...entry, weight: round(cap) };
    });
    if (!lowered) break;
  }
  return out;
}
/**
 * Inside an expanded area every tile is a card you can read and act on, so
 * the pull range is compressed: nothing lighter than `ratio` of the heaviest.
 * Order still carries the rank; size stops deciding which tiles get an act row.
 */
export function evenOut<T extends Weighted>(
  items: readonly T[],
  ratio: number,
): T[] {
  const top = Math.max(0, ...items.map((item) => item.weight));
  if (!top) return [...items];
  const floor = top * ratio;
  return items.map((item) =>
    item.weight >= floor ? { ...item } : { ...item, weight: round(floor) },
  );
}
/**
 * An expanded area lays its tiles out as cards in rank order, row by row, so
 * every one of them is readable and can be acted on. Columns are chosen so a
 * card comes closest to `aspect` wide for its height; the last row shares its
 * width among whatever is left, so the map has no hole. Rects are percentages.
 */
export function cardGrid(
  ids: readonly string[],
  size: { w: number; h: number },
  aspect = 1.4,
): Map<string, Rect> {
  return cardLayout(ids, size, undefined, aspect).rects;
}
/**
 * The card grid with a minimum card size. Columns never make a card narrower
 * than `min.w`; rows never make one shorter than `min.h`, so the grid grows
 * taller than `size.h` instead and the area body scrolls. `height` is the
 * grid's height in pixels; rects are percentages of it.
 */
export function cardLayout(
  ids: readonly string[],
  size: { w: number; h: number },
  min?: { w: number; h: number },
  aspect = 1.4,
): { rects: Map<string, Rect>; height: number } {
  const rects = new Map<string, Rect>();
  const n = ids.length;
  if (!n) return { rects, height: size.h };
  const widest = min ? Math.max(1, Math.floor(size.w / min.w)) : n;
  const rowHeight = (rows: number) => Math.max(size.h / rows, min?.h ?? 0);
  let cols = 1;
  let best = Infinity;
  for (let candidate = 1; candidate <= Math.min(n, widest); candidate++) {
    const rows = Math.ceil(n / candidate);
    const ratio = size.w / candidate / rowHeight(rows);
    const miss = Math.abs(Math.log(ratio / aspect));
    if (miss < best) {
      best = miss;
      cols = candidate;
    }
  }
  // Rows share the cards evenly, the fuller rows first: 16 in four rows is
  // 4 by 4, 13 is 5, 4, 4, and no card is left alone under a full row.
  const rows = Math.ceil(n / cols);
  const base = Math.floor(n / rows);
  const fuller = n % rows;
  const h = 100 / rows;
  let index = 0;
  for (let row = 0; row < rows; row++) {
    const inRow = base + (row < fuller ? 1 : 0);
    const w = 100 / inRow;
    for (let column = 0; column < inRow; column++, index++)
      rects.set(ids[index], {
        x: round(column * w),
        y: round(row * h),
        w: round(w),
        h: round(h),
      });
  }
  return { rects, height: Math.max(size.h, rows * rowHeight(rows)) };
}
export function treemap(items: readonly Weighted[], rect: Rect) {
  const ordered = heatOrder(items);
  return place(
    partition(ordered, rect),
    new Map(ordered.map((item) => [item.id, item.weight])),
    rect,
  );
}
export interface HeatTile {
  id: string;
  weight: number;
  tone: HeatTone;
  /** A single piece of work, or null when this tile stands for a quiet group. */
  item: WorkItem | null;
  members: WorkItem[];
  stale: number;
  /** Days in the current wait, null when its start is unknown. */
  waited: number | null;
  level: 1 | 2 | 3 | 4;
  timing: HeatTiming | null;
  /** Stands for tiles too small to read, folded into one "+N more". */
  overflow?: boolean;
}
export interface HeatArea {
  id: string;
  title: string;
  scope: string;
  /** The project or container this area opens; sessions have no single root. */
  root: WorkItem | null;
  weight: number;
  waiting: number;
  running: number;
  /** The one agent handling this whole area, while it runs. */
  orchestrator: AreaOrchestrator | null;
  items: WorkItem[];
  tiles: HeatTile[];
}
const QUIET_CAP = 6;
const AREA_FLOOR = 0.05;
const TILE_FLOOR = 0.035;
function quietTile(id: string, members: WorkItem[]): HeatTile {
  return {
    id,
    weight: round(Math.min(QUIET_CAP, 0.7 + members.length * 0.2)),
    tone: "quiet",
    item: null,
    members,
    stale: 0,
    waited: 0,
    level: 1,
    timing: null,
  };
}
function areaFrom(
  id: string,
  title: string,
  scope: string,
  root: WorkItem | null,
  items: WorkItem[],
  now: number,
  keepQuiet: number,
): HeatArea {
  const tiles = heatOrder(
    items.map((item) => ({
      id: item.id,
      weight: heatPull(item, now),
      tone: heatTone(item),
      item,
      members: [] as WorkItem[],
      stale: staleDays(item, now),
      waited: waitingSince(item, now) ? waitDays(item, now) : null,
      level: heatLevel(item, now),
      timing: heatTiming(item, now),
    })),
  );
  const loud = tiles.filter(
    (tile) =>
      tile.tone !== "quiet" || tile.item!.focus || tile.timing?.prominent,
  );
  const quiet = tiles.filter((tile) => !loud.includes(tile));
  const shown =
    quiet.length - keepQuiet >= 2
      ? [
          ...loud,
          ...quiet.slice(0, keepQuiet),
          quietTile(
            `quiet:${id}`,
            quiet.slice(keepQuiet).map((tile) => tile.item!),
          ),
        ]
      : [...loud, ...quiet];
  // Pins, imminent dates and aged undated tasks stay outside the quiet cap.
  const active = shown.filter(
    (tile) =>
      tile.tone !== "quiet" || tile.item?.focus || tile.timing?.prominent,
  );
  return {
    id,
    title,
    scope,
    root,
    items,
    tiles: withFloor(heatOrder(shown), TILE_FLOOR),
    weight: round(
      total(active) +
        Math.min(QUIET_CAP, total(shown.filter((t) => !active.includes(t)))),
    ),
    waiting: items.filter((item) => needsYou(heatTone(item))).length,
    running: items.filter(heatWorking).length,
    orchestrator: root?.orchestrator ?? null,
  };
}
/** A drawn tile must hold its key and one title line; below this it folds. */
export const MIN_TILE = { w: 64, h: 42 };
function moreTile(id: string, folded: readonly HeatTile[]): HeatTile {
  return {
    id,
    weight: round(total(folded)),
    tone: "quiet",
    item: null,
    members: folded.flatMap((tile) => (tile.item ? [tile.item] : tile.members)),
    stale: 0,
    waited: 0,
    level: 1,
    timing: null,
    overflow: true,
  };
}
/**
 * Squarify at the real pixel size, fold every tile under `min` into one
 * "+N more" tile carrying their summed weight, and squarify again until
 * nothing left is too small. Folding changes sizes, so a pass can expose a
 * new small tile; each pass folds at least one more, so it ends. `keep` (an
 * expanded tile, grown to `share`) never folds, and neither does the fold.
 */
export function foldSmall(
  tiles: readonly HeatTile[],
  size: { w: number; h: number },
  options: {
    id: string;
    min?: { w: number; h: number };
    keep?: string;
    share?: number;
  },
): HeatTile[] {
  const min = options.min ?? MIN_TILE;
  const moreId = `more:${options.id}`;
  const rect = { x: 0, y: 0, w: size.w, h: size.h };
  let shown = heatOrder(tiles);
  let folded: HeatTile[] = [];
  let bumps = 0;
  for (let pass = 0; pass <= tiles.length + 8; pass++) {
    const rects = place(
      partition(shown, rect),
      expandedWeights(shown, options.keep, options.share ?? 0.78),
      rect,
    );
    const under = (id: string) => {
      const cell = rects.get(id);
      return !cell || cell.w < min.w || cell.h < min.h;
    };
    const small = shown.filter(
      (tile) => tile.id !== moreId && tile.id !== options.keep && under(tile.id),
    );
    if (!small.length) {
      // The fold tile must be readable too. When it is the one below the
      // minimum it grows by weight, taking room from every tile in proportion
      // rather than swallowing a readable one.
      if (folded.length && under(moreId) && bumps < 8) {
        bumps++;
        shown = heatOrder(
          shown.map((tile) =>
            tile.id === moreId
              ? { ...tile, weight: round(tile.weight * 1.6 + 0.1) }
              : tile,
          ),
        );
        continue;
      }
      break;
    }
    // Fold the lightest half first: once they are out of the way the rest
    // usually fit, and an area keeps its heaviest tiles instead of showing
    // nothing but "+N more".
    const lightest = [...small]
      .sort((a, b) => a.weight - b.weight)
      .slice(0, Math.max(1, Math.ceil(small.length / 2)));
    folded = [...folded, ...lightest];
    const current = shown.find((tile) => tile.id === moreId);
    const next = moreTile(moreId, folded);
    shown = heatOrder([
      ...shown.filter((tile) => tile.id !== moreId && !lightest.includes(tile)),
      current && current.weight > next.weight
        ? { ...next, weight: current.weight }
        : next,
    ]);
  }
  return shown;
}
/** The least an area can be and still say its name over a row of tiles. */
export const MIN_AREA = { w: 120, h: 31 + 6 + MIN_TILE.h };
/**
 * How much of the map an open area takes. It wants room for its cards, more
 * for more cards, up to `max`; but it stops growing at the share where a
 * neighbour that was readable before it opened would drop below `MIN_AREA`.
 * `rows` is the map's fixed strip partition, so only sizes are compared.
 */
export function openAreaShare(
  areas: readonly Weighted[],
  id: string,
  rows: readonly HeatRow[],
  size: { w: number; h: number },
  want: number,
): number {
  const rect = { x: 0, y: 0, w: size.w, h: size.h };
  const readable = (cell: Rect | undefined) =>
    !!cell && cell.w >= MIN_AREA.w - 0.5 && cell.h >= MIN_AREA.h - 0.5;
  const base = place(rows, expandedWeights(areas, undefined, 0), rect);
  const guarded = areas
    .filter((area) => area.id !== id && readable(base.get(area.id)))
    .map((area) => area.id);
  for (let share = want; share > 0; share -= 0.02) {
    const rects = place(rows, expandedWeights(areas, id, share), rect);
    if (guarded.every((other) => readable(rects.get(other)))) return share;
  }
  return 0;
}
/** An open area wants a quarter of the map plus a little per card. */
/** The least an open area asks for: room for its act bar and one whole card. */
export const OPEN_AREA_FLOOR = 0.4;
export function openAreaWant(cards: number, max: number) {
  return Math.min(max, Math.max(OPEN_AREA_FLOOR, 0.25 + 0.04 * cards));
}
/**
 * Areas are the map's own roots: a project area per project, and one Sessions
 * area for standalone sessions, which Work Map never attaches to a project.
 */
export function buildHeat(
  roots: readonly WorkItem[],
  now: number,
  options: { uncollapsed?: readonly string[]; keepQuiet?: number } = {},
): HeatArea[] {
  const open = new Set(options.uncollapsed ?? []);
  const keepQuiet = options.keepQuiet ?? 4;
  const loose = roots.filter((root) => root.kind !== "project");
  const areas = roots
    .filter((root) => root.kind === "project")
    .map((root) =>
      areaFrom(
        root.id,
        root.title,
        root.scope,
        root,
        root.children,
        now,
        open.has(root.id) ? Infinity : keepQuiet,
      ),
    );
  if (loose.length)
    areas.push(
      areaFrom(
        SESSIONS_AREA,
        "Sessions",
        "Standalone",
        null,
        loose,
        now,
        open.has(SESSIONS_AREA) ? Infinity : 0,
      ),
    );
  return heatOrder(
    withCeiling(withFloor(heatOrder(areas), AREA_FLOOR), (area) =>
      areaCeiling(area.tiles.length),
    ),
  );
}
export function heatStats(areas: readonly HeatArea[], now: number) {
  const items = areas.flatMap((area) => area.items);
  return {
    waiting: items.filter((item) => needsYou(heatTone(item))).length,
    unread: items.filter((item) => heatTone(item) === "unread").length,
    running: items.filter(heatWorking).length,
    stale: items.filter((item) => staleDays(item, now)).length,
    overdue: items.filter((item) => heatTiming(item, now)?.overdue).length,
    aged: items.filter((item) => heatTiming(item, now)?.aged).length,
  };
}
