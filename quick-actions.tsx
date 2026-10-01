import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { AreaMenuItem } from "./management-ui";
import type { WorkItem } from "./model";
import {
  ACTION_LABEL,
  type ActionContext,
  blockedReason,
  bulkPlan,
  confirmHeading,
  confirmNote,
  eligible,
  SNOOZE_DAYS,
  type QuickAction,
} from "./delegation";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";

const ICON: Record<QuickAction, string> = {
  delegate: "Bot",
  done: "CircleCheck",
  snooze: "Clock",
  unsnooze: "ArrowTurnBackward",
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
  orchestrated,
  onAct,
  onDismissError,
}: {
  item: WorkItem;
  disabled: boolean;
  busy: QuickAction | null;
  context?: ActionContext;
  /** What went wrong on this card's own act, shown where it was clicked. */
  error?: string;
  /**
   * The area's own header already says one orchestrator holds this work, so
   * the card does not repeat the reason; the disabled act still carries it.
   */
  orchestrated?: boolean;
  onAct: (action: QuickAction, item: WorkItem) => void;
  onDismissError?: () => void;
}) {
  // A snoozed card offers to end its snooze where Snooze was, so recovery
  // never depends on the Undo of the session that snoozed it.
  const actions: QuickAction[] = [
    "delegate",
    "done",
    item.snoozedUntil ? "unsnooze" : "snooze",
  ];
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
  // Only the handover explains itself here; a snoozed task's own label says why.
  const stopped = offered.find((row) => row.action === "delegate")?.why;
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
        stopped &&
        !orchestrated && (
          <p className="wm-tile-note">{`Cannot hand over: ${stopped}`}</p>
        )
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
            title={
              why ? `${ACTION_LABEL[action]}: ${why}` : ACTION_LABEL[action]
            }
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

/**
 * Area-level acts: they always name their count and list what they will touch.
 * The bar is one row, so a small screen keeps its cards: `lead` (the area's
 * own buttons), the primary handover, the picker and the count sit in it, and
 * Snooze all and Mark all done move into the area menu `tools` draws. They
 * open the same confirmation from there.
 */
export function AreaBulkActions({
  title,
  lead,
  tools,
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
  lead?: ReactNode;
  tools: (extra: AreaMenuItem[]) => ReactNode;
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
  // Mark all done sits last in the menu: it is one click from closing
  // everything here, so it is never the neighbour of the primary act.
  const menuActs: QuickAction[] = ["snooze", "done"];
  // The picker stays shut by default: an expanded area is mostly for reading
  // its tiles, and a list of every task would take the room they need.
  const [picking, setPicking] = useState(false);
  // The pick list shows whole rows and fades its last one while more wait below.
  const picksRef = useRef<HTMLUListElement>(null);
  const [more, setMore] = useState(false);
  const measureMore = () => {
    const list = picksRef.current;
    setMore(
      !!list && list.scrollHeight - list.scrollTop - list.clientHeight > 1,
    );
  };
  useEffect(measureMore, [picking, items.length]);
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
  const open = (action: QuickAction, opener: HTMLButtonElement | null) => {
    openerRef.current = opener;
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
        {lead}
        {offer("delegate") && (
          <Button
            size="sm"
            variant="default"
            className="wm-bulk-primary"
            disabled={disabled || !!running}
            onClick={(event) => open("delegate", event.currentTarget)}
          >
            <Icon name={ICON.delegate} />
            {running === "delegate" ? "Working…" : label("delegate")}
          </Button>
        )}
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
          className="wm-bulk-picker"
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
        {tools(
          menuActs.filter(offer).map((action) => ({
            key: action,
            label: running === action ? "Working…" : label(action),
            hint:
              action === "done"
                ? "Asks first, listing what closes."
                : `Asks first. Quiet ${SNOOZE_DAYS} days, Tasks unchanged.`,
            className: action === "done" ? "wm-menu-separated" : undefined,
            disabled: disabled || !!running,
            onSelect: (trigger) => open(action, trigger),
          })),
        )}
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
        <p className="wm-bulk-hint wm-bulk-transient">
          {selected.length
            ? "Acts apply to your pick."
            : `Nothing picked: acts apply to all ${items.length} in ${title}.`}
        </p>
      )}
      <div className="wm-bulk-transient" hidden={!picking}>
        <ul
          ref={picksRef}
          className={`wm-bulk-picks ${more ? "wm-bulk-picks-more" : ""}`}
          aria-label={`Pick work in ${title}`}
          onScroll={measureMore}
        >
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
