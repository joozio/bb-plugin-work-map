import type { WorkItem } from "./model";
import { localDay, snoozeDays } from "./model";

const DAY = 86400000;
/**
 * Days past due after which a date has slipped: it no longer says urgency,
 * only that the date needs tidying. The task then ranks by its priority and
 * what it needs alone, and wears a quiet "slipped Nd" label.
 */
export const SLIPPED_DAYS = 14;
/** The least any dated or aged task pulls from its timing alone. */
const NEAR_FLOOR = 0.2;
/**
 * What a slipped date pulls: flat, whatever the count of days, so a date
 * three weeks past and one three months past rank the same, by priority and
 * need. Under any date this week, over a date a month out.
 */
export const SLIPPED_NEAR = 0.3;
/**
 * Straight lines between the named points: `[days, near]` in rising day
 * order; outside the span the ends hold.
 */
export function ramp(points: readonly (readonly [number, number])[], x: number) {
  if (x <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index++) {
    const [x1, y1] = points[index];
    if (x <= x1) {
      const [x0, y0] = points[index - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}
/**
 * Pull by days past due (positive), up to the slipped mark. The first week
 * past due is the peak, as hot as today; by two weeks it is still most of
 * that. Past the mark the date has slipped and pulls SLIPPED_NEAR, flat.
 */
const PAST: readonly (readonly [number, number])[] = [
  [0, 1],
  [7, 1],
  [SLIPPED_DAYS, 0.85],
];
/** Pull by days until due: tomorrow is nearly today, a month out is the floor. */
const AHEAD: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0.92],
  [3, 0.7],
  [7, 0.48],
  [14, 0.32],
  [30, NEAR_FLOOR],
];
/** Pull by age of an undated task: a slow climb, never the peak of a date. */
const AGE: readonly (readonly [number, number])[] = [
  [0, NEAR_FLOOR],
  [7, 0.23],
  [30, 0.3],
  [60, 0.38],
  [90, 0.44],
  [180, 0.5],
];
export function dueNear(days: number) {
  if (days < -SLIPPED_DAYS) return SLIPPED_NEAR;
  return days < 0 ? ramp(PAST, -days) : ramp(AHEAD, days);
}
export function ageNear(days: number) {
  return ramp(AGE, days);
}
export interface HeatTiming {
  kind: "due" | "age" | "snooze";
  days: number;
  /**
   * How near the date pulls, 0 to 1: 1 from today through the first week past
   * due, falling both ways: a date weeks ahead and a date months past both
   * sit low. Undated work climbs slowly with age and never reaches the peak.
   */
  near: number;
  label: string;
  /** The label in fewest letters, for a tile too narrow for the full one. */
  compact: string;
  description: string;
  /** Past its date, slipped or not. */
  overdue: boolean;
  /** Past due by more than SLIPPED_DAYS: a date to tidy, not urgency. */
  slipped: boolean;
  aged: boolean;
  prominent: boolean;
}

/** Date-only comparisons use local calendar days, without DST-length days. */
function calendarDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(at) &&
    new Date(at).toISOString().slice(0, 10) === value
    ? at / DAY
    : null;
}
function localCalendarDay(at: number) {
  const date = new Date(at);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

/** The current due date wins. Only an undated open task uses creation age. */
export function heatTiming(item: WorkItem, now: number): HeatTiming | null {
  const task = item.task;
  if (
    !task ||
    ["done", "canceled"].includes(task.status) ||
    !Number.isFinite(now)
  )
    return null;
  // A snooze speaks for the task until it ends: quiet, and it says so.
  if (item.snoozedUntil && item.snoozedUntil > now) {
    // The same count Overview shows, from the one shared function.
    const days = snoozeDays(item.snoozedUntil, now);
    return {
      kind: "snooze",
      days,
      label: `snoozed ${days}d`,
      compact: `snoozed ${days}d`,
      description: `Snoozed until ${localDay(item.snoozedUntil)}${task.dueDate ? `; due ${task.dueDate}` : ""}`,
      near: 0.1,
      overdue: false,
      slipped: false,
      aged: false,
      prominent: false,
    };
  }
  if (task.dueDate) {
    const day = calendarDay(task.dueDate);
    if (day === null) return null;
    const days = day - localCalendarDay(now);
    const past = -days;
    const plan = task.dateKind === "plan";
    const slipped = past > SLIPPED_DAYS;
    const prefix = plan ? "Planned" : "Due";
    // "2d late" is urgency; "slipped 21d" is a date to tidy. Both say the count.
    const label = slipped
      ? `slipped ${past}d`
      : days < 0
        ? `${past}d ${plan ? "past plan" : "late"}`
        : days === 0
          ? `${prefix} today`
          : days === 1
            ? `${prefix} tomorrow`
            : `${prefix} in ${days}d`;
    return {
      kind: "due",
      days,
      label,
      compact: slipped
        ? `slip ${past}d`
        : days < 0
          ? `${past}d late`
          : days === 0
            ? "today"
            : days === 1
              ? "tmrw"
              : `in ${days}d`,
      description: `${label} (${task.dueDate})`,
      near: dueNear(days),
      overdue: days < 0,
      slipped,
      aged: false,
      // A slipped date is not imminent: it no longer keeps a quiet task out
      // of the quiet pile on its own.
      prominent: days <= 3 && !slipped,
    };
  }
  const created = Date.parse(task.createdAt ?? "");
  if (
    !Number.isFinite(created) ||
    created > now ||
    calendarDay((task.createdAt ?? "").slice(0, 10)) === null
  )
    return null;
  const days = Math.max(0, localCalendarDay(now) - localCalendarDay(created));
  return {
    kind: "age",
    days,
    label: `${days}d old`,
    compact: `${days}d old`,
    description: `Created ${days} ${days === 1 ? "day" : "days"} ago; no due date`,
    near: ageNear(days),
    overdue: false,
    slipped: false,
    aged: days >= 30,
    prominent: days >= 30,
  };
}
