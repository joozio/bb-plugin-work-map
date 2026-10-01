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
/** Strongest first: what a tile standing for several pieces of work wears. */
const TONE_ORDER: HeatTone[] = [
  "input",
  "error",
  "review",
  "followup",
  "unread",
  "working",
  "quiet",
];
export function toneRank(tone: HeatTone) {
  return TONE_ORDER.indexOf(tone);
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
/** The five depths a tile can wear, coldest to hottest. */
export type Step = 1 | 2 | 3 | 4 | 5;
/**
 * Where each step starts, as a share of the map's tiles ranked by pull: the
 * hottest tenth wears 5, the next 15% 4, the next quarter 3, then three
 * tenths at 2 and the coldest fifth at 1. Rank, not an absolute score, so a
 * map where every date is past still has a visible top, middle and bottom.
 * Only the top half carries a colour; the eye lands on a few hot spots.
 */
export const STEP_SHARES: readonly [Step, number][] = [
  [5, 0.1],
  [4, 0.25],
  [3, 0.5],
  [2, 0.8],
];
/**
 * How much of its size a tile lends to its area, by step: an area of cold
 * work shrinks and an area holding the hot spots grows, so the map's big
 * picture reads at area level too.
 */
export const STEP_GAIN: Record<Step, number> = {
  5: 1,
  4: 0.8,
  3: 0.5,
  2: 0.25,
  1: 0.15,
};
/** The step for a place `at` (0 = hottest, 1 = coldest) in the ranking. */
export function stepAt(at: number): Step {
  for (const [step, share] of STEP_SHARES) if (at < share) return step;
  return 1;
}
/**
 * Steps for `weights` by rank: the heaviest is always 5, the lightest 1,
 * and a tie shares one step, so identical work never reads as two depths.
 * One tile alone is the hottest thing on the map.
 */
export function rankSteps(
  weights: readonly Weighted[],
): Map<string, Step> {
  const ordered = heatOrder(weights);
  const out = new Map<string, Step>();
  const n = ordered.length;
  let index = 0;
  while (index < n) {
    let end = index;
    while (end + 1 < n && ordered[end + 1].weight === ordered[index].weight)
      end++;
    const at = n === 1 ? 0 : (index + end) / 2 / (n - 1);
    // The first place is 5 and the last 1 even when the shares would not
    // reach them: a map of three tiles still reads hottest, middle, coldest.
    const step: Step =
      index === 0 ? 5 : end === n - 1 && n > 1 ? 1 : stepAt(at);
    for (let i = index; i <= end; i++) out.set(ordered[i].id, step);
    index = end + 1;
  }
  return out;
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
 * never cut; "running" is a word or only the dot, never a clipped word. The
 * ask tag ("· draft") and the timing label share what is left, each whole or
 * not at all, in this order: both with the full label, both with the compact
 * one ("38d" for "38d overdue"), then the label alone, full or compact, then
 * the ask alone. What drops is still on the edge, hatch, title and
 * accessible description.
 */
export function labelRow(
  width: number,
  lead: string,
  label: string,
  running: boolean,
  options: { compact?: string; ask?: string } = {},
): { lead: string; label: string; ask: string } {
  const room = width - LABEL_CHROME;
  const word =
    lead === "running" && RUN_DOT + labelWidth(lead) > room ? "" : lead;
  const used = (running ? RUN_DOT : 0) + labelWidth(word);
  const ask = options.ask ?? "";
  // The tag is drawn as "· draft" a gap after the key.
  const askWidth = ask ? LABEL_GAP + labelWidth(`· ${ask}`) : 0;
  const fits = (withAsk: boolean, text: string) =>
    used + (withAsk ? askWidth : 0) + (text ? LABEL_GAP + labelWidth(text) : 0) <=
    room;
  const labels = [label, options.compact ?? label].filter(
    (text, index, all) => text && all.indexOf(text) === index,
  );
  for (const withAsk of ask ? [true, false] : [false])
    for (const text of labels)
      if (fits(withAsk, text))
        return { lead: word, label: text, ask: withAsk ? ask : "" };
  return { lead: word, label: "", ask: ask && fits(true, "") ? ask : "" };
}
/** Whether a card this wide holds the word "agent running" whole. */
export function fitsWord(width: number, word: string) {
  return labelWidth(word) <= width - LABEL_CHROME;
}
/**
 * What the work needs, as a multiplier. An explicit request for your hands
 * and a failed run pull far ahead of a review; a result to read and a running
 * agent sit under it; quiet work keeps a little pull so it still has a size.
 */
const NEED: Record<HeatTone, number> = {
  input: 3,
  error: 2.6,
  review: 1,
  followup: 1,
  unread: 0.7,
  working: 0.55,
  quiet: 0.3,
};
/** Priority multiplies: urgent is over twice a medium task, low and unset are well under it. */
const PRIORITY: Record<string, number> = {
  urgent: 2.4,
  high: 1.6,
  medium: 1,
  low: 0.6,
  none: 0.6,
};
const FOCUS = 1.6;
const WORKING = 1.15;
/** Timing of work with no date and no age: a session, or a task whose date cannot be read. */
const UNTIMED_NEAR = 0.45;
/**
 * An explicit request for your hands or a failed run is current whatever
 * the task's date says: its nearness is at least that of a date four days out.
 */
const NOW_NEAR = 0.6;
/** A long wait on you adds to that, up to the pull of a date a few days out. */
const WAIT_NEAR = 0.3;
const WAIT_SPAN = 60;
/** Area weight grows with pull faster than one to one, so the hottest tile is several times the coldest. */
export const SIZE_POWER = 1.4;
const round = (value: number) => Math.round(value * 10000) / 10000;
export function priorityPull(priority: string | undefined) {
  return PRIORITY[priority ?? "none"] ?? PRIORITY.none;
}
/**
 * How hard one item pulls on you, in one sentence: what it needs, times its
 * priority, times how near its date is (peaking this week and fading when
 * long past), and more when it is in focus. Every factor multiplies, so a
 * low-priority draft two months past due sits clearly under a high-priority
 * task due this week, and an urgent task cannot hide behind a stale date.
 */
export function heatPull(item: WorkItem, now: number) {
  const tone = heatTone(item);
  const timing = heatTiming(item, now);
  // Sessions and tasks with unreadable dates keep their attention signals;
  // an invalid date never silently becomes a creation age or a date bonus.
  const timed =
    timing?.near ??
    UNTIMED_NEAR +
      WAIT_NEAR * Math.min(1, waitDays(item, now) / WAIT_SPAN);
  const near =
    tone === "input" || tone === "error" ? Math.max(timed, NOW_NEAR) : timed;
  const priority = item.task ? priorityPull(item.task.priority) : 1;
  return round(
    NEED[tone] *
      priority *
      near *
      (item.focus ? FOCUS : 1) *
      (tone !== "working" && heatWorking(item) ? WORKING : 1),
  );
}
/** The area a pull takes: a curve, so size separates the hot from the cold. */
export function heatSize(pull: number) {
  return round(Math.max(0, pull) ** SIZE_POWER);
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
  /** How hard it pulls, before the size curve. */
  pull: number;
  /** Colour depth by rank across the whole map, 1 coldest to 5 hottest. */
  step: Step;
  /** 1, 2 or 3 on the map's three hottest tiles; unset elsewhere. */
  rank?: number;
  timing: HeatTiming | null;
  /** Stands for tiles too small to read, folded into one "+N more". */
  overflow?: boolean;
  /** Agents running here: 1 for running work, the total for a fold. */
  running?: number;
  /** Folded work that needs you; only a fold counts it. */
  waiting?: number;
}
export interface HeatArea {
  id: string;
  title: string;
  scope: string;
  /** The project or container this area opens; sessions have no single root. */
  root: WorkItem | null;
  weight: number;
  /** The hottest step among the area's own tiles; 1 when nothing is drawn. */
  step: Step;
  waiting: number;
  running: number;
  /** The one agent handling this whole area, while it runs. */
  orchestrator: AreaOrchestrator | null;
  items: WorkItem[];
  tiles: HeatTile[];
  /** The step of every item drawn as its own tile; grouped work reads 1. */
  steps: ReadonlyMap<string, Step>;
}
/** The most a pile of quiet work can weigh: about two quiet tiles. */
const QUIET_CAP = 0.3;
const AREA_FLOOR = 0.05;
const TILE_FLOOR = 0.035;
function quietTile(id: string, members: WorkItem[]): HeatTile {
  return {
    id,
    weight: round(Math.min(QUIET_CAP, 0.06 + members.length * 0.012)),
    tone: "quiet",
    item: null,
    members,
    stale: 0,
    waited: 0,
    pull: 0,
    step: 1,
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
    items.map((item): HeatTile => {
      const pull = heatPull(item, now);
      return {
        id: item.id,
        weight: heatSize(pull),
        pull,
        tone: heatTone(item),
        item,
        members: [] as WorkItem[],
        stale: staleDays(item, now),
        waited: waitingSince(item, now) ? waitDays(item, now) : null,
        step: 1,
        timing: heatTiming(item, now),
        running: heatWorking(item) ? 1 : 0,
      };
    }),
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
  const drawn = withFloor(heatOrder(shown), TILE_FLOOR);
  return {
    id,
    title,
    scope,
    root,
    items,
    tiles: drawn,
    weight: areaWeight(drawn, false),
    step: 1,
    waiting: items.filter((item) => needsYou(heatTone(item))).length,
    running: items.filter(heatWorking).length,
    orchestrator: root?.orchestrator ?? null,
    steps: new Map(),
  };
}
/** Pins, imminent dates and aged undated tasks stay outside the quiet cap. */
const active = (tile: HeatTile) =>
  tile.tone !== "quiet" || !!tile.item?.focus || !!tile.timing?.prominent;
/**
 * An area weighs what its tiles lend it: each tile's size through its step's
 * gain, so the hot spots carry the area and cold work barely does. Before the
 * ranking every tile lends its whole size; quiet work is capped as a pile.
 */
export function areaWeight(tiles: readonly HeatTile[], ranked = true) {
  const lent = (tile: HeatTile) =>
    Math.max(0, tile.weight) * (ranked && tile.item ? STEP_GAIN[tile.step] : 1);
  const loud = tiles.filter(active);
  return round(
    loud.reduce((sum, tile) => sum + lent(tile), 0) +
      Math.min(
        QUIET_CAP,
        tiles
          .filter((tile) => !active(tile))
          .reduce((sum, tile) => sum + lent(tile), 0),
      ),
  );
}
/**
 * Depth by rank across the map: every tile drawn on its own is ranked by
 * pull against every other, whatever its area, and the three hottest are
 * numbered. Pull, not the floored size: tiles lifted to the readable minimum
 * share a size but keep their order. Grouped work is not in the ranking and
 * reads as the coldest. Once the steps are known each area weighs what its
 * tiles lend it and wears its hottest step.
 */
export function withSteps(areas: readonly HeatArea[]): HeatArea[] {
  const drawn = areas.flatMap((area) =>
    area.tiles.filter((tile) => tile.item).map((tile) => ({ id: tile.id, weight: tile.pull })),
  );
  const steps = rankSteps(drawn);
  const top = heatOrder(drawn).slice(0, 3).map((tile) => tile.id);
  return areas.map((area) => {
    const tiles = area.tiles.map((tile) => {
      if (!tile.item) return tile;
      const rank = top.indexOf(tile.id);
      return {
        ...tile,
        step: steps.get(tile.id) ?? 1,
        ...(rank >= 0 ? { rank: rank + 1 } : {}),
      };
    });
    return {
      ...area,
      tiles,
      weight: areaWeight(tiles),
      step: tiles.reduce<Step>(
        (top, tile) => (tile.item && tile.step > top ? tile.step : top),
        1,
      ),
      steps: new Map(
        tiles.flatMap((tile) =>
          tile.item ? [[tile.item.id, tile.step] as const] : [],
        ),
      ),
    };
  });
}
/** A drawn tile must hold its key and one title line; below this it folds. */
export const MIN_TILE = { w: 64, h: 42 };
/** Running agents a tile stands for; fixtures without the count read their tone. */
const runningIn = (tile: HeatTile) =>
  tile.running ?? (tile.tone === "working" ? 1 : 0);
/**
 * How much folding a tile would hide: what needs you, then running work,
 * then a result to read, then quiet work. The quietest folds first.
 */
function loudness(tile: HeatTile) {
  if (needsYou(tile.tone)) return 3;
  if (runningIn(tile)) return 2;
  return tile.tone === "unread" ? 1 : 0;
}
/**
 * The fold wears its strongest member: a pile hiding running agents or work
 * that needs you must never read as an inactive block.
 */
function moreTile(id: string, folded: readonly HeatTile[]): HeatTile {
  const strongest = [...folded].sort(
    (a, b) => toneRank(a.tone) - toneRank(b.tone) || b.step - a.step,
  )[0];
  return {
    id,
    weight: round(total(folded)),
    tone: strongest?.tone ?? "quiet",
    item: null,
    members: folded.flatMap((tile) => (tile.item ? [tile.item] : tile.members)),
    stale: 0,
    waited: 0,
    pull: 0,
    step: strongest?.step ?? 1,
    timing: null,
    overflow: true,
    running: folded.reduce((sum, tile) => sum + runningIn(tile), 0),
    waiting: folded.filter((tile) => needsYou(tile.tone)).length,
  };
}
/**
 * Squarify at the real pixel size, fold every tile under `min` into one
 * "+N more" tile, and squarify again until nothing left is too small. The
 * fold carries its members' summed weight, but never more than the room of
 * a readable tile and a half: the rest goes back to the work still drawn,
 * which is how folding a quiet tile makes room for a running one. Folding
 * changes sizes, so a pass can expose a new small tile; each pass folds at
 * least one more, so it ends. `keep` (an expanded tile, grown to `share`)
 * never folds, and neither does the fold.
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
  const cap =
    total(tiles) * Math.min(1, (1.5 * min.w * min.h) / (size.w * size.h));
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
    // The quietest go first. Running work and work that needs you never fold
    // while a quieter tile is still drawn: that tile folds instead, and the
    // room it frees is what the loud one was missing.
    const floor = Math.min(...small.map(loudness));
    const quieter =
      floor >= 2
        ? shown.filter(
            (tile) =>
              tile.id !== moreId &&
              tile.id !== options.keep &&
              loudness(tile) < floor,
          )
        : [];
    const pool = quieter.length ? quieter : small;
    const level = Math.min(...pool.map(loudness));
    const candidates = pool.filter((tile) => loudness(tile) === level);
    // Then the lightest half: once they are out of the way the rest usually
    // fit, and an area keeps its heaviest tiles instead of only "+N more".
    const lightest = [...candidates]
      .sort((a, b) => a.weight - b.weight)
      .slice(0, Math.max(1, Math.ceil(candidates.length / 2)));
    folded = [...folded, ...lightest];
    const current = shown.find((tile) => tile.id === moreId);
    const fold = moreTile(moreId, folded);
    const next = { ...fold, weight: round(Math.min(fold.weight, cap)) };
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
    withCeiling(withFloor(heatOrder(withSteps(areas)), AREA_FLOOR), (area) =>
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
