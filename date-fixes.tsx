import { useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { localDay } from "./model";
import type { MapTask, rpcContract } from "./server";
import type { SettleInput, Settlement } from "./settlement-contract";

export type DateFix = "today" | "week" | "month" | "none";
export const DATE_FIX_LABEL: Record<DateFix, string> = {
  today: "Today",
  week: "+1 week",
  month: "+1 month",
  none: "No date",
};
const CHOICES: DateFix[] = ["today", "week", "month", "none"];

/**
 * The due date a fix writes. Weeks and months move on the local calendar, not
 * by adding milliseconds, so a DST change or a short month never shifts the day.
 */
export function dateFix(choice: DateFix, now: number): string | null {
  if (choice === "none") return null;
  if (choice === "today") return localDay(now);
  const d = new Date(now);
  const [year, month, day] = [d.getFullYear(), d.getMonth(), d.getDate()];
  if (choice === "week")
    return localDay(new Date(year, month, day + 7, 12).getTime());
  // Day 0 of the month after next is the last day of next month.
  const last = new Date(year, month + 2, 0).getDate();
  return localDay(new Date(year, month + 1, Math.min(day, last), 12).getTime());
}

/**
 * One-click fixes for a slipped date. Each writes the task's due date through a
 * `date` settlement, so it lands in Settled today with the same Undo.
 */
export function DateFixes({
  task,
  now,
  disabled,
  onBusy,
  onSettled,
}: {
  task: MapTask;
  now: number;
  disabled: boolean;
  onBusy?: (busy: boolean) => void;
  onSettled: (result: Settlement) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState<DateFix | null>(null);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const attempt = useRef<{ key: string; input: SettleInput } | null>(null);

  async function settle(choice: DateFix) {
    if (lock.current || disabled) return;
    const dueDate = dateFix(choice, now);
    // A retry of the same fix after a failure reuses its id, so a write whose
    // response was lost is recovered rather than repeated.
    const key = JSON.stringify({ taskId: task.id, dueDate });
    if (attempt.current?.key !== key)
      attempt.current = {
        key,
        input: {
          id: `${Date.now()}-${crypto.randomUUID()}`,
          action: "date",
          taskId: task.id,
          expectedUpdatedAt: task.updatedAt,
          dueDate,
          nextAction: task.nextAction ?? "",
          reviewBy: "me",
          reviewer: "",
        },
      };
    attempt.current.input.expectedUpdatedAt = task.updatedAt;
    lock.current = true;
    setBusy(choice);
    onBusy?.(true);
    setError("");
    try {
      const result = await rpc.call("settle", attempt.current.input);
      attempt.current = null;
      if (result.taskUpdated) onSettled(result);
      else setError(result.warning || "The date was not changed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lock.current = false;
      setBusy(null);
      onBusy?.(false);
    }
  }

  return (
    <>
      <div
        className="wm-date-fixes"
        role="group"
        aria-label={`Fix the date on ${task.key}`}
        aria-busy={busy !== null}
      >
        {CHOICES.map((choice) => {
          const date = dateFix(choice, now);
          const outcome = date
            ? `Move ${task.key} to ${date}`
            : `Clear the date on ${task.key}`;
          return (
            <button
              key={choice}
              type="button"
              className={`wm-date-fix wm-date-fix-${choice}`}
              disabled={disabled || busy !== null}
              title={outcome}
              aria-label={outcome}
              onClick={(event) => {
                // The tile underneath opens the task; these act on it instead.
                event.stopPropagation();
                void settle(choice);
              }}
            >
              {busy === choice ? "…" : DATE_FIX_LABEL[choice]}
            </button>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="wm-settle-error">
          {error}
        </p>
      )}
    </>
  );
}
