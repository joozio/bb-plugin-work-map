import { useEffect, useId, useRef, useState } from "react";
import type { WorkItem } from "./model";
import {
  ACTION_LABEL,
  type ActionContext,
  blockedReason,
  bulkPlan,
  confirmHeading,
  confirmNote,
  eligible,
  type QuickAction,
} from "./delegation";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";

const ICON: Record<QuickAction, string> = {
  delegate: "Bot",
  done: "CircleCheck",
  snooze: "Clock",
};

/**
 * The three acts a tile offers without being opened. They are deliberately the
 * whole set: anything needing a sentence typed belongs in the expanded details.
 */
export function TileActions({
  item,
  disabled,
  busy,
  context,
  error,
  onAct,
  onDismissError,
}: {
  item: WorkItem;
  disabled: boolean;
  busy: QuickAction | null;
  context?: ActionContext;
  /** What went wrong on this card's own act, shown where it was clicked. */
  error?: string;
  onAct: (action: QuickAction, item: WorkItem) => void;
  onDismissError?: () => void;
}) {
  const actions: QuickAction[] = ["delegate", "done", "snooze"];
  // Work that cannot be settled at all offers nothing. When only the handover
  // is blocked, the act stays on the card and says why, because a reason where
  // the click would have been is worth more than a button that disappeared.
  const settleable = !blockedReason(item, "done", context);
  if (!settleable && !error) return null;
  const offered = settleable
    ? actions.map((action) => ({
        action,
        why: blockedReason(item, action, context),
      }))
    : [];
  const stopped = offered.find((row) => row.why)?.why;
  return (
    <div className="wm-tile-acts">
      {error ? (
        <p className="wm-tile-error" role="alert">
          <span>{error}</span>
          {onDismissError && (
            <button
              type="button"
              aria-label={`Dismiss the error on ${item.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onDismissError();
              }}
            >
              Dismiss
            </button>
          )}
        </p>
      ) : (
        stopped && <p className="wm-tile-note">{`Cannot hand over: ${stopped}`}</p>
      )}
      <div
        className="wm-tile-actions"
        role="group"
        aria-label={`Act on ${item.title}`}
      >
        {offered.map(({ action, why }) => (
          <button
            key={action}
            type="button"
            className={`wm-tile-action wm-tile-${action}`}
            disabled={disabled || !!busy || !!why}
            title={why ? `${ACTION_LABEL[action]}: ${why}` : ACTION_LABEL[action]}
            aria-label={`${ACTION_LABEL[action]} · ${item.title}${why ? ` · unavailable: ${why}` : ""}`}
            onClick={(event) => {
              // The tile underneath opens the task; these act on it instead.
              event.stopPropagation();
              onAct(action, item);
            }}
          >
            <Icon name={ICON[action]} />
            <span>{busy === action ? "…" : ACTION_LABEL[action]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Area-level acts: they always name their count and list what they will touch. */
export function AreaBulkActions({
  title,
  items,
  selected,
  disabled,
  running,
  preset,
  context,
  error,
  onToggle,
  onClearSelection,
  onRun,
  onDismissError,
}: {
  title: string;
  items: WorkItem[];
  selected: string[];
  disabled: boolean;
  running: QuickAction | null;
  preset: string;
  context?: ActionContext;
  /** What went wrong on the last bulk run, shown in the bar that started it. */
  error?: string;
  onToggle: (id: string) => void;
  onClearSelection: () => void;
  onRun: (action: QuickAction, items: WorkItem[]) => void;
  onDismissError?: () => void;
}) {
  const [intent, setIntent] = useState<QuickAction | null>(null);
  // Mark all done sits last: it is one click from closing everything here,
  // so it is never the neighbour of the primary act.
  const order: QuickAction[] = ["delegate", "snooze", "done"];
  // The picker stays shut by default: an expanded area is mostly for reading
  // its tiles, and a list of every task would take the room they need.
  const [picking, setPicking] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const headingId = useId();
  // A subset the user picked wins over the whole area; nothing picked means all.
  const chosen = selected.length
    ? items.filter((item) => selected.includes(item.id))
    : items;
  const plan = intent ? bulkPlan(chosen, intent, context) : null;
  // Focus lands on the dialog itself, not on its act: Enter must never confirm
  // a bulk close before the list has been read. Tab reaches the act next.
  useEffect(() => {
    if (intent) dialogRef.current?.focus();
  }, [intent]);
  const close = () => {
    setIntent(null);
    openerRef.current?.focus({ preventScroll: true });
  };
  const open = (action: QuickAction, event: React.MouseEvent) => {
    openerRef.current = event.currentTarget as HTMLButtonElement;
    setIntent(action);
  };
  const offer = (action: QuickAction) =>
    chosen.some((item) => eligible(item, action, context));
  const label = (action: QuickAction) =>
    action === "delegate"
      ? selected.length
        ? `Let agents decide ${selected.length}`
        : "Let agents decide all"
      : action === "done"
        ? selected.length
          ? `Mark ${selected.length} done`
          : "Mark all done"
        : selected.length
          ? `Snooze ${selected.length}`
          : "Snooze all";
  return (
    <div className="wm-bulk">
      <div className="wm-bulk-row">
        {order
          .filter(offer)
          .map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === "delegate" ? "default" : "outline"}
              disabled={disabled || !!running}
              onClick={(event) => open(action, event)}
            >
              <Icon name={ICON[action]} />
              {running === action ? "Working…" : label(action)}
            </Button>
          ))}
        {selected.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || !!running}
            onClick={onClearSelection}
          >
            Clear {selected.length} selected
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={picking}
          disabled={disabled || !!running}
          onClick={() => setPicking((open) => !open)}
        >
          {picking ? "Hide picker" : "Pick tasks"}
        </Button>
        <span className="wm-bulk-count">
          {selected.length
            ? `${selected.length} of ${items.length} picked`
            : `${items.length} ${items.length === 1 ? "task" : "tasks"}`}
        </span>
      </div>
      {error && (
        <p className="wm-bulk-error" role="alert">
          <span>{error}</span>
          {onDismissError && (
            <button type="button" onClick={onDismissError}>
              Dismiss
            </button>
          )}
        </p>
      )}
      {(selected.length > 0 || picking) && (
        <p className="wm-bulk-hint">
          {selected.length
            ? "Acts apply to your pick."
            : `Nothing picked: acts apply to all ${items.length} in ${title}.`}
        </p>
      )}
      <div hidden={!picking}>
      <ul className="wm-bulk-picks" aria-label={`Pick work in ${title}`}>
        {items.map((item) => (
          <li key={item.id}>
            <label className="wm-bulk-pick">
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                disabled={disabled || !!running}
                onChange={() => onToggle(item.id)}
              />
              <span>
                {item.task?.key ? `${item.task.key} · ` : ""}
                {item.title}
              </span>
            </label>
          </li>
        ))}
      </ul>
      </div>
      {intent && plan && (
        <div className="wm-bulk-anchor">
        <div
          className={`wm-bulk-confirm wm-bulk-confirm-${intent}`}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          tabIndex={-1}
          ref={dialogRef}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.defaultPrevented) {
              event.stopPropagation();
              close();
            }
          }}
        >
          <h4 id={headingId}>{confirmHeading(intent, plan.take.length)}</h4>
          <ul className="wm-bulk-list">
            {plan.take.map((item) => (
              <li key={item.id}>
                {item.task?.key ? <b>{item.task.key}</b> : null} {item.title}
              </li>
            ))}
          </ul>
          {plan.skip.length > 0 && (
            <p className="wm-bulk-skip">
              Leaving out {plan.skip.length}:{" "}
              {plan.skip
                .map(
                  ({ item, why }) =>
                    `${item.task?.key ?? item.title} (${why})`,
                )
                .join(", ")}
            </p>
          )}
          <p className="wm-bulk-note">
            {confirmNote(intent, title, plan.take.length)}
          </p>
          {intent === "delegate" && (
            <p className="wm-bulk-note">
              The orchestrator runs on the <b>{preset}</b> preset.
            </p>
          )}
          <div className="wm-bulk-row">
            <Button
              size="sm"
              variant={intent === "done" ? "destructive" : "default"}
              disabled={!plan.take.length}
              onClick={() => {
                const take = plan.take;
                close();
                onRun(intent, take);
              }}
            >
              {confirmHeading(intent, plan.take.length).replace(/\?$/, "")}
            </Button>
            <Button size="sm" variant="ghost" onClick={close}>
              Cancel
            </Button>
          </div>
        </div>
        </div>
      )}
    </div>
  );
}
