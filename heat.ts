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
/** The three tiers a tile can wear: your focus now, what comes next, the rest. */
export type Tier = "now" | "next" | "later";
const TIER_ORDER: Tier[] = ["now", "next", "later"];
export function tierRank(tier: Tier) {
  return TIER_ORDER.indexOf(tier);
}
/** Absolute caps: at most five Now tiles on the whole map, at most eight Next. */
export const NOW_CAP = 5;
export const NEXT_CAP = 8;
/**
 * How many tiles the two hot tiers may hold on a map of `n` drawn tiles: a
 * third each at most, under the absolute caps, and Now is never empty. Three
 * tiles read one of each; a map of 37 reads five and eight. If everything is
 * important, nothing is: most of the map is Later whatever the data says.
 */
export function tierCaps(n: number) {
  const third = Math.floor(n / 3);
  return {
    now: Math.min(NOW_CAP, Math.max(1, third)),
    next: Math.min(NEXT_CAP, third),
  };
}
/**
 * How much of its size a tile lends to its area, by tier: an area of Later
 * work shrinks and an area holding Now tiles grows, so the map's big picture
 * reads at area level too.
 */
export const TIER_GAIN: Record<Tier, number> = { now: 1, next: 0.6, later: 0.35 };
/**
 * Now tiles are the biggest on the map, by a margin and not by a landslide:
 * five hot spots on a calm map, not a red continent. Later keeps its size by pull.
 */
export const TIER_SIZE: Record<Tier, number> = { now: 1.1, next: 1, later: 0.8 };
const PRIORITY_RANK: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 3,
};
/** What the tier rules read about one tile. */
export interface Prospect {
  id: string;
  pull: number;
  focus: boolean;
  tone: HeatTone;
  timing: HeatTiming | null;
  priority: string;
  /** Closed or snoozed work never enters Now or Next. */
  resting: boolean;
  /** A task, or a standalone session (which has no date or priority to tier by). */
  task: boolean;
}
/** Due today or tomorrow, or late by a week at most: a date that is current. */
const dueNow = (p: Prospect) =>
  p.timing?.kind === "due" && p.timing.days >= -7 && p.timing.days <= 1;
/** Due within the week, or late within the fortnight: not slipped. */
const dueSoon = (p: Prospect) =>
  p.timing?.kind === "due" && !p.timing.slipped && p.timing.days <= 7;
const hotPriority = (p: Prospect) =>
  p.priority === "urgent" || p.priority === "high";
/** Equal pulls break by the nearer date (a date 19 days past before one 40 days past), then by id. */
const byPull = (a: Prospect, b: Prospect) =>
  b.pull - a.pull ||
  Math.abs(a.timing?.days ?? Infinity) - Math.abs(b.timing?.days ?? Infinity) ||
  a.id.localeCompare(b.id);
const byPriority = (a: Prospect, b: Prospect) =>
  (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) ||
  byPull(a, b);
type Stage = [(p: Prospect) => boolean, (a: Prospect, b: Prospect) => number];
/** Takes from `pool` stage by stage, each stage in its own order, up to `cap`. */
function fill(pool: readonly Prospect[], cap: number, stages: Stage[]) {
  const taken: Prospect[] = [];
  for (const [test, order] of stages)
    for (const p of pool.filter((p) => !taken.includes(p) && test(p)).sort(order)) {
      if (taken.length >= cap) return taken;
      taken.push(p);
    }
  return taken;
}
export interface Tiered {
  tier: Tier;
  /** 1, 2 or 3 on the first three Now tiles; unset elsewhere. */
  rank?: number;
}
/**
 * Now, in fill order: what you put in focus; a request for your hands or a
 * failed run; a date that is current (today, tomorrow, or late by a week at
 * most), by priority; then the highest pull. Next, from what is left: due
 * this week or late within the fortnight, then high or urgent priority, then
 * what follows by pull. Everything else is Later. Closed and snoozed work
 * stays Later whatever it pulls, and so does a standalone session unless it
 * asks for your hands or failed: a pinned running agent is not your focus,
 * its green outline already says what it is.
 */
export function assignTiers(prospects: readonly Prospect[]): Map<string, Tiered> {
  const caps = tierCaps(prospects.length);
  const open = prospects.filter(
    (p) => !p.resting && (p.task || p.tone === "input" || p.tone === "error"),
  );
  const now = fill(open, caps.now, [
    [(p) => p.focus, byPull],
    [(p) => p.tone === "input" || p.tone === "error", byPull],
    [dueNow, byPriority],
    [() => true, byPull],
  ]);
  const rest = open.filter((p) => !now.includes(p));
  const next = fill(rest, caps.next, [
    [dueSoon, byPull],
    [hotPriority, byPull],
    [() => true, byPull],
  ]);
  const out = new Map<string, Tiered>();
  for (const p of prospects) out.set(p.id, { tier: "later" });
  now.forEach((p, index) =>
    out.set(p.id, { tier: "now", ...(index < 3 ? { rank: index + 1 } : {}) }),
  );
  for (const p of next) out.set(p.id, { tier: "next" });
  return out;
}
/** The priority word a reason line carries; low and unset stay silent. */
export const PRIORITY_WORD: Record<string, string> = {
  urgent: "urgent",
  high: "high",
  medium: "medium",
};
/** The date in the reason's words: due tomorrow, 2d late, slipped 21d; an age only once it is aged. */
function timingWords(timing: HeatTiming | null, compact: boolean) {
  if (!timing) return "";
  if (timing.kind === "due")
    return compact
      ? timing.compact
      : timing.label.replace(/^(Due|Planned) /, (word) => word.toLowerCase());
  if (timing.kind === "age") return timing.aged ? timing.compact : "";
  return "";
}
/**
 * Why a tile wears its colour, in words, on the tile: "due tomorrow · high",
 * "2d late · medium", "in focus", "needs your input". Every factor that
 * drove the tier is named, priority included, so the colour has no hidden
 * cause. `compact` says the same in fewer letters for a narrow tile.
 */
export function tileReason(p: Prospect): { reason: string; compact: string } {
  const parts = (compact: boolean) =>
    [
      p.focus ? (compact ? "focus" : "in focus") : "",
      p.tone === "input"
        ? compact
          ? "input"
          : "needs your input"
        : p.tone === "error"
          ? compact
            ? "failed"
            : "run failed"
          : "",
      timingWords(p.timing, compact),
      PRIORITY_WORD[p.priority] ?? "",
    ].filter(Boolean);
  return { reason: parts(false).join(" · "), compact: parts(true).join(" · ") };
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
  options: { compact?: string | readonly string[]; ask?: string } = {},
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
  // The full label, then each shorter form in turn: a reason line falls back
  // to its compact words, then to the date alone.
  const labels = [
    label,
    ...(typeof options.compact === "string"
      ? [options.compact]
      : (options.compact ?? [])),
  ].filter((text, index, all) => text && all.indexOf(text) === index);
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
/** Size grows with pull a little faster than one to one: the hottest tile is several times the coldest, not a continent. */
export const SIZE_POWER = 1.2;
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
  /** Now, Next or Later, by the capped fill order across the whole map. */
  tier: Tier;
  /** 1, 2 or 3 on the first three Now tiles; unset elsewhere. */
  rank?: number;
  /** Why the tile wears its tier, in words; empty on Later tiles. */
  reason: string;
  /** The reason in fewer letters, for a narrow tile. */
  compact: string;
  /** The date is more than two weeks past: a date to tidy, not urgency. */
  slipped: boolean;
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
  /** The hottest tier among the area's own tiles; later when nothing is drawn. */
  tier: Tier;
  waiting: number;
  running: number;
  /** The one agent handling this whole area, while it runs. */
  orchestrator: AreaOrchestrator | null;
  items: WorkItem[];
  tiles: HeatTile[];
  /** The tier of every item drawn as its own tile; grouped work reads later. */
  tiers: ReadonlyMap<string, Tier>;
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
    tier: "later",
    reason: "",
    compact: "",
    slipped: false,
    timing: null,
  };
}
/** Pins, imminent dates and aged undated tasks stay outside the quiet cap. */
const active = (tile: HeatTile) =>
  tile.tone !== "quiet" || !!tile.item?.focus || !!tile.timing?.prominent;
function areaFrom(
  id: string,
  title: string,
  scope: string,
  root: WorkItem | null,
  items: WorkItem[],
  now: number,
  keepQuiet: number,
  tidy: boolean,
): HeatArea {
  const tiles = heatOrder(
    items.map((item): HeatTile => {
      const pull = heatPull(item, now);
      const timing = heatTiming(item, now);
      return {
        id: item.id,
        weight: heatSize(pull),
        pull,
        tone: heatTone(item),
        item,
        members: [] as WorkItem[],
        stale: staleDays(item, now),
        waited: waitingSince(item, now) ? waitDays(item, now) : null,
        tier: "later",
        reason: "",
        compact: "",
        slipped: !!timing?.slipped,
        timing,
        running: heatWorking(item) ? 1 : 0,
      };
    }),
  );
  // In tidy mode every slipped date is drawn on its own: it is the work.
  const loud = tiles.filter((tile) => active(tile) || (tidy && tile.slipped));
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
    tier: "later",
    waiting: items.filter((item) => needsYou(heatTone(item))).length,
    running: items.filter(heatWorking).length,
    orchestrator: root?.orchestrator ?? null,
    tiers: new Map(),
  };
}
/**
 * An area weighs what its tiles lend it: each tile's size through its tier's
 * gain, so the Now tiles carry the area and Later work barely does. Before
 * the tiers are known every tile lends its whole size; quiet work is capped
 * as a pile.
 */
export function areaWeight(tiles: readonly HeatTile[], ranked = true) {
  const lent = (tile: HeatTile) =>
    Math.max(0, tile.weight) * (ranked && tile.item ? TIER_GAIN[tile.tier] : 1);
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
/** The pile's cap in tidy mode is lifted: the slipped tiles are the work. */
const TIDY_LIFT = 0.5;
const TIDY_DIM = 0.5;
/**
 * Tiers across the map: every tile drawn on its own is a prospect, whatever
 * its area, and the capped fill order picks the few Now and Next tiles; the
 * first three Now tiles are numbered. Each tile then says why in words, and
 * takes its tier's size; in tidy mode the slipped tiles grow to the room a
 * date-fix row needs and the rest shrink. Grouped work is Later. Once the
 * tiers are known each area weighs what its tiles lend it and wears its
 * hottest tier.
 */
export function withTiers(areas: readonly HeatArea[], tidy = false): HeatArea[] {
  const prospects = new Map<string, Prospect>();
  for (const area of areas)
    for (const tile of area.tiles)
      if (tile.item)
        prospects.set(tile.id, {
          id: tile.id,
          pull: tile.pull,
          focus: tile.item.focus,
          tone: tile.tone,
          timing: tile.timing,
          priority: tile.item.task?.priority ?? "none",
          resting:
            !!closedStatus(tile.item) || tile.timing?.kind === "snooze",
          task: !!tile.item.task,
        });
  const tiers = assignTiers([...prospects.values()]);
  return areas.map((area) => {
    let tiles = area.tiles.map((tile) => {
      const prospect = prospects.get(tile.id);
      if (!prospect) return tile;
      const { tier, rank } = tiers.get(tile.id) ?? { tier: "later" as Tier };
      const words = tier === "later" ? { reason: "", compact: "" } : tileReason(prospect);
      return {
        ...tile,
        tier,
        ...words,
        weight: round(tile.weight * TIER_SIZE[tier]),
        ...(rank ? { rank } : {}),
      };
    });
    if (tidy) {
      const top = Math.max(0, ...tiles.map((tile) => tile.weight));
      tiles = tiles.map((tile) =>
        tile.slipped
          ? { ...tile, weight: round(Math.max(tile.weight, top * TIDY_LIFT)) }
          : { ...tile, weight: round(tile.weight * TIDY_DIM) },
      );
    }
    tiles = withFloor(heatOrder(tiles), TILE_FLOOR);
    return {
      ...area,
      tiles,
      weight: areaWeight(tiles),
      tier: tiles.reduce<Tier>(
        (top, tile) =>
          tile.item && tierRank(tile.tier) < tierRank(top) ? tile.tier : top,
        "later",
      ),
      tiers: new Map(
        tiles.flatMap((tile) =>
          tile.item ? [[tile.item.id, tile.tier] as const] : [],
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
  // A Now tile is the point of the map: it folds after everything else, and
  // a Next tile after anything Later, however light its words made it.
  if (tile.tier === "now") return 5;
  if (tile.tier === "next") return 4;
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
    (a, b) =>
      toneRank(a.tone) - toneRank(b.tone) || tierRank(a.tier) - tierRank(b.tier),
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
    tier: strongest?.tier ?? "later",
    reason: "",
    compact: "",
    slipped: false,
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
/**
 * The most of the map the Now tiles may take together. Five hot spots that
 * each hold the title, the reason and the ask need about a quarter of a
 * 1440px map; past that they are empty fill, and the room comes out of the
 * Next tiles and the areas that were squeezed beside them.
 */
export const NOW_SHARE_CAP = 0.28;
/** The scale of the Now tiles never drops under this: they stay the biggest. */
const NOW_SCALE_FLOOR = 0.4;
const NOW_SCALE_STEP = 0.94;
/**
 * The share of the map the Now tiles take: each area's share of the whole,
 * times the Now tiles' share of that area. Areas and tiles both fill their
 * rectangles in proportion to weight, so this mirrors the drawn map.
 */
export function nowShare(areas: readonly HeatArea[]) {
  const whole = total(areas);
  if (!whole) return 0;
  return round(
    areas.reduce((sum, area) => {
      const inside = total(area.tiles);
      if (!inside) return sum;
      const now = area.tiles
        .filter((tile) => tile.tier === "now")
        .reduce((acc, tile) => acc + Math.max(0, tile.weight), 0);
      return sum + (area.weight / whole) * (now / inside);
    }, 0),
  );
}
/**
 * Shrink every Now tile by the same factor until the Now tiles together take
 * at most `cap` of the map as `finish` lays it out. Size still says what is
 * important: the factor never drops under NOW_SCALE_FLOOR, and the Now tiles
 * keep their weight order. The room given back goes to Next and to the areas
 * that were squeezed beside the hot ones.
 */
export function capNowShare(
  areas: readonly HeatArea[],
  finish: (areas: readonly HeatArea[]) => HeatArea[],
  cap = NOW_SHARE_CAP,
): HeatArea[] {
  let scale = 1;
  let current = [...areas];
  for (let pass = 0; pass < 40; pass++) {
    if (nowShare(finish(current)) <= cap + 1e-6) break;
    const next = scale * NOW_SCALE_STEP;
    if (next < NOW_SCALE_FLOOR) break;
    scale = next;
    current = areas.map((area) => {
      const tiles = area.tiles.map((tile) =>
        tile.tier === "now" && tile.item
          ? { ...tile, weight: round(tile.weight * scale) }
          : tile,
      );
      return { ...area, tiles, weight: areaWeight(tiles) };
    });
  }
  return current;
}
/**
 * The order of the cards in an open area: priority first (urgent, high,
 * medium, then low and unset), closed work last, then by weight within a
 * priority so colour and size still carry the pull. A session has no
 * priority and reads with the unset ones.
 */
export function priorityOrder<T extends Pick<HeatTile, "id" | "weight" | "item">>(
  tiles: readonly T[],
): T[] {
  const rank = (tile: T) =>
    PRIORITY_RANK[tile.item?.task?.priority ?? "none"] ?? 3;
  const closed = (tile: T) => (tile.item && closedStatus(tile.item) ? 1 : 0);
  return [...tiles].sort(
    (a, b) =>
      closed(a) - closed(b) ||
      rank(a) - rank(b) ||
      b.weight - a.weight ||
      a.id.localeCompare(b.id),
  );
}
/** The quiet label over a run of cards sharing a priority in an open area. */
export function priorityGroup(priority: string | undefined) {
  return priority === "urgent"
    ? "Urgent"
    : priority === "high"
      ? "High"
      : priority === "medium"
        ? "Medium"
        : "Low / none";
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
  options: {
    uncollapsed?: readonly string[];
    keepQuiet?: number;
    /** Tidy mode: slipped dates are the work; they grow and the rest shrinks. */
    tidy?: boolean;
  } = {},
): HeatArea[] {
  const open = new Set(options.uncollapsed ?? []);
  const keepQuiet = options.keepQuiet ?? 4;
  const tidy = !!options.tidy;
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
        tidy,
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
        tidy,
      ),
    );
  const finish = (ranked: readonly HeatArea[]) =>
    heatOrder(
      withCeiling(withFloor(heatOrder(ranked), AREA_FLOOR), (area) =>
        areaCeiling(area.tiles.length),
      ),
    );
  // Tidy mode has its own sizes: the slipped tiles are the work there.
  const tiered = withTiers(areas, tidy);
  return finish(tidy ? tiered : capNowShare(tiered, finish));
}
export function heatStats(areas: readonly HeatArea[], now: number) {
  const items = areas.flatMap((area) => area.items);
  return {
    waiting: items.filter((item) => needsYou(heatTone(item))).length,
    unread: items.filter((item) => heatTone(item) === "unread").length,
    running: items.filter(heatWorking).length,
    stale: items.filter((item) => staleDays(item, now)).length,
    /** Late by two weeks at most: urgency. Slipped dates are counted apart. */
    overdue: items.filter((item) => {
      const timing = heatTiming(item, now);
      return timing?.overdue && !timing.slipped;
    }).length,
    slipped: items.filter((item) => heatTiming(item, now)?.slipped).length,
    aged: items.filter((item) => heatTiming(item, now)?.aged).length,
  };
}
