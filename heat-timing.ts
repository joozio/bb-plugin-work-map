import type { WorkItem } from "./model";
import { localDay, snoozeDays } from "./model";

const DAY = 86400000;
/** Days past due after which a date reads as stale rather than urgent. */
export const LATE_DAYS = 14;
export interface HeatTiming {
  kind: "due" | "age" | "snooze";
  days: number;
  weight: number;
  level: 1 | 2 | 3 | 4;
  label: string;
  description: string;
  overdue: boolean;
  /** Past due by more than two weeks: stale rather than urgent. */
  late: boolean;
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
      description: `Snoozed until ${localDay(item.snoozedUntil)}${task.dueDate ? `; due ${task.dueDate}` : ""}`,
      weight: 1,
      level: 1,
      overdue: false,
      late: false,
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
    const prefix = plan ? "Planned" : "Due";
    const label =
      days < 0
        ? `${-days}d ${plan ? "past plan" : "overdue"}`
        : days === 0
          ? `${prefix} today`
          : days === 1
            ? `${prefix} tomorrow`
            : `${prefix} in ${days}d`;
    return {
      kind: "due",
      days,
      label,
      description: `${label} (${task.dueDate})`,
      // Overdue pulls hardest in its first week, then decays: a date long
      // past is stale, not urgent, and must not bury this week's.
      weight:
        days < 0
          ? past <= 7
            ? 10 + 2 * (past / 7)
            : past <= 30
              ? 12 - (4 * (past - 8)) / 22
              : 7
          : days === 0
            ? 8
            : days === 1
              ? 6
              : days <= 3
                ? 4.5
                : days <= 7
                  ? 3
                  : days <= 14
                    ? 2
                    : 1.2,
      level:
        days < 0
          ? past <= LATE_DAYS
            ? 4
            : past <= 60
              ? 3
              : 2
          : days === 0
            ? 4
            : days === 1
              ? 3
              : days <= 3
                ? 2
                : 1,
      overdue: days < 0,
      late: past > LATE_DAYS,
      aged: false,
      prominent: days <= 3,
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
    description: `Created ${days} ${days === 1 ? "day" : "days"} ago; no due date`,
    weight:
      days >= 90
        ? 7 + Math.min(2, (days - 90) / 90)
        : days >= 60
          ? 5.5
          : days >= 30
            ? 4
            : days >= 7
              ? 2.4
              : 1.2,
    level: days >= 90 ? 4 : days >= 60 ? 3 : days >= 30 ? 2 : 1,
    overdue: false,
    late: false,
    aged: days >= 30,
    prominent: days >= 30,
  };
}
