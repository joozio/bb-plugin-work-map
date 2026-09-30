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
export function heatTone(item: WorkItem): HeatTone {
  if (item.attention) return item.attention;
  if (needsReview(item)) return "review";
  if (item.unreadResults > 0) return "unread";
  if (isWorking(item)) return "working";
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
        (isWorking(item) ? 0.3 : 0) +
        (item.focus ? 2 : 0),
    );
  }
  let pull = 0.8 + TONE_PULL[tone];
  if (tone !== "working" && isWorking(item)) pull += 1.2;
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
  const out = new Map<string, Rect>();
  const n = ids.length;
  if (!n) return out;
  let cols = 1;
  let best = Infinity;
  for (let candidate = 1; candidate <= n; candidate++) {
    const rows = Math.ceil(n / candidate);
    const ratio = size.w / candidate / (size.h / rows);
    const miss = Math.abs(Math.log(ratio / aspect));
    if (miss < best) {
      best = miss;
      cols = candidate;
    }
  }
  const rows = Math.ceil(n / cols);
  const h = 100 / rows;
  ids.forEach((id, index) => {
    const row = Math.floor(index / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const w = 100 / inRow;
    out.set(id, {
      x: round((index - row * cols) * w),
      y: round(row * h),
      w: round(w),
      h: round(h),
    });
  });
  return out;
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
    running: items.filter(isWorking).length,
    orchestrator: root?.orchestrator ?? null,
  };
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
  return withFloor(heatOrder(areas), AREA_FLOOR);
}
export function heatStats(areas: readonly HeatArea[], now: number) {
  const items = areas.flatMap((area) => area.items);
  return {
    waiting: items.filter((item) => needsYou(heatTone(item))).length,
    unread: items.filter((item) => heatTone(item) === "unread").length,
    running: items.filter(isWorking).length,
    stale: items.filter((item) => staleDays(item, now)).length,
    overdue: items.filter((item) => heatTiming(item, now)?.overdue).length,
    aged: items.filter((item) => heatTiming(item, now)?.aged).length,
  };
}
