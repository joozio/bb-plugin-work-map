import type { WorkItem } from "./model";

const DAY = 86400000;
export interface HeatTiming {
  kind: "due" | "age";
  days: number;
  weight: number;
  level: 1 | 2 | 3 | 4;
  label: string;
  description: string;
  overdue: boolean;
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
  if (task.dueDate) {
    const day = calendarDay(task.dueDate);
    if (day === null) return null;
    const days = day - localCalendarDay(now);
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
      weight:
        days < 0
          ? 10 + Math.min(3, -days / 7)
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
      level: days <= 0 ? 4 : days === 1 ? 3 : days <= 3 ? 2 : 1,
      overdue: days < 0,
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
    aged: days >= 30,
    prominent: days >= 30,
  };
}
