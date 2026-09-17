import { useEffect, useId, useRef, useState } from "react";
import { useRpc, UrlLink } from "@get-bb/plugin-sdk/app";
import type { MapTask, rpcContract } from "./server";
import type { SettleInput, Settlement } from "./settlement-contract";
import { Button } from "./components/ui/button";

const DISMISSED_SETTLEMENTS = "work-map:dismissed-settlements";
function readDismissedSettlements(): string[] {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(DISMISSED_SETTLEMENTS) || "[]",
    );
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

export function SettlementActions({
  task,
  thread,
  disabled,
  onBusy,
  onSettled,
}: {
  task?: MapTask;
  thread?: { id: string; title: string; running: boolean; archived: boolean };
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onSettled: (result: Settlement) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [nextAction, setNextAction] = useState(task?.nextAction ?? "");
  const [reviewBy, setReviewBy] = useState<"me" | "other">("me");
  const [reviewer, setReviewer] = useState("");
  const [checkAfter, setCheckAfter] = useState("");
  const [archive, setArchive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [archiveHelp, setArchiveHelp] = useState(false);
  const [intent, setIntent] = useState<"pause" | "review" | null>(null);
  const handoffId = useId();
  const handoffRef = useRef<HTMLFormElement>(null);
  const pauseRef = useRef<HTMLButtonElement>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const archiveHelpId = useId();
  const lock = useRef(false);
  const attempt = useRef<{ key: string; input: SettleInput } | null>(null);
  const openTask = task && !["done", "canceled"].includes(task.status);
  const canArchive = thread && !thread.archived;
  useEffect(() => setArchive(true), [thread?.id]);
  useEffect(() => {
    if (intent)
      handoffRef.current?.querySelector<HTMLElement>("input, select")?.focus();
  }, [intent]);
  function cancelHandoff() {
    (intent === "review" ? reviewRef : pauseRef).current?.focus();
    setIntent(null);
    setNextAction(task?.nextAction ?? "");
    setReviewBy("me");
    setReviewer("");
    setCheckAfter("");
    setError("");
  }

  async function settle(action: SettleInput["action"]) {
    if (lock.current || disabled) return;
    if (
      action === "review" &&
      reviewBy === "other" &&
      (!reviewer.trim() || !checkAfter)
    ) {
      setError("Name the reviewer and choose a follow-up date.");
      return;
    }
    const fields = {
      action,
      ...(action !== "archive" && task ? { taskId: task.id } : {}),
      ...(canArchive && (archive || action === "archive")
        ? { threadId: thread.id }
        : {}),
      nextAction:
        action === "pause" || action === "review"
          ? nextAction
          : (task?.nextAction ?? ""),
      reviewBy: action === "review" ? reviewBy : ("me" as const),
      reviewer: action === "review" ? reviewer : "",
      ...(action === "review" && checkAfter ? { checkAfter } : {}),
    };
    const key = JSON.stringify(fields);
    if (attempt.current?.key !== key)
      attempt.current = {
        key,
        input: {
          ...fields,
          id: `${Date.now()}-${crypto.randomUUID()}`,
          ...(task ? { expectedUpdatedAt: task.updatedAt } : {}),
        },
      };
    if (task) attempt.current.input.expectedUpdatedAt = task.updatedAt;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const result = await rpc.call("settle", attempt.current.input);
      attempt.current = null;
      if (
        result.taskUpdated ||
        result.archivedThreadIds.length ||
        (result.action === "pause" && !result.warning)
      )
        onSettled(result);
      else
        setError(
          result.warning || "The session is already archived. Refresh the map.",
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  if (!openTask && !canArchive) return null;
  return (
    <section
      className="wm-settle wm-settle-compact"
      aria-label="Settle this work"
      aria-busy={busy}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          intent &&
          !busy &&
          !event.defaultPrevented
        ) {
          // Let the browser close a native select popup without losing the draft.
          if ((event.target as HTMLElement).tagName === "SELECT") {
            event.stopPropagation();
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          cancelHandoff();
        }
      }}
    >
      <fieldset disabled={busy || disabled}>
        {openTask && <legend className="sr-only">Update task</legend>}
        {openTask && (
          <div className="wm-settle-buttons">
            <Button
              ref={pauseRef}
              size="sm"
              variant="ghost"
              aria-expanded={intent === "pause"}
              aria-controls={intent === "pause" ? handoffId : undefined}
              onClick={() =>
                intent === "pause" ? cancelHandoff() : setIntent("pause")
              }
            >
              Pause here
            </Button>
            <Button
              ref={reviewRef}
              size="sm"
              variant="ghost"
              aria-expanded={intent === "review"}
              aria-controls={intent === "review" ? handoffId : undefined}
              onClick={() =>
                intent === "review" ? cancelHandoff() : setIntent("review")
              }
            >
              Ready for review
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void settle("done")}
            >
              Task done
            </Button>
          </div>
        )}
        {openTask && intent && (
          <form
            id={handoffId}
            ref={handoffRef}
            className="wm-handoff-form"
            onSubmit={(event) => {
              event.preventDefault();
              void settle(intent);
            }}
          >
            <label className="wm-handoff-step">
              {intent === "review" && reviewBy === "other"
                ? "Review request"
                : "Next step"}
              <input
                value={nextAction}
                onChange={(event) => setNextAction(event.target.value)}
                maxLength={700}
                placeholder="What should happen next?"
              />
            </label>
            {intent === "review" && (
              <div className="wm-review-options">
                <label>
                  Review by
                  <select
                    value={reviewBy}
                    onChange={(event) =>
                      setReviewBy(event.target.value as "me" | "other")
                    }
                  >
                    <option value="me">Me</option>
                    <option value="other">Someone else</option>
                  </select>
                </label>
                {reviewBy === "other" && (
                  <>
                    <label>
                      Reviewer
                      <input
                        value={reviewer}
                        onChange={(event) => setReviewer(event.target.value)}
                        maxLength={150}
                        placeholder="Name"
                      />
                    </label>
                    <label>
                      Follow up on
                      <input
                        type="date"
                        value={checkAfter}
                        onChange={(event) => setCheckAfter(event.target.value)}
                      />
                    </label>
                  </>
                )}
              </div>
            )}
            {intent === "review" && reviewBy === "other" && (
              <p>
                The task stays open. It returns to Waiting for you on the
                follow-up date. This records the handoff; it does not send a
                message.
              </p>
            )}
            <div className="wm-handoff-submit">
              <Button size="sm" type="submit">
                {intent === "review" ? "Save review" : "Save and pause"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={cancelHandoff}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {canArchive && openTask && (
          <label className="wm-archive-choice">
            <input
              type="checkbox"
              checked={archive}
              onChange={(event) => setArchive(event.target.checked)}
            />
            Archive viewed session: {thread.title}
          </label>
        )}
        {canArchive && openTask && archive && (
          <p className="wm-archive-note">
            {thread.running ? "Stops this session's running work. " : ""}
            Other sessions stay open. Undo reopens this session without
            restarting it.
          </p>
        )}
        {!openTask && (
          <div className="wm-settle-buttons">
            <span
              className="wm-archive-control"
              onMouseEnter={() => setArchiveHelp(true)}
              onMouseLeave={() => setArchiveHelp(false)}
            >
              <Button
                size="sm"
                variant="outline"
                aria-describedby={archiveHelpId}
                onFocus={() => setArchiveHelp(true)}
                onBlur={() => setArchiveHelp(false)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && archiveHelp) {
                    setArchiveHelp(false);
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                onClick={() => void settle("archive")}
              >
                Archive session
              </Button>
              <span
                id={archiveHelpId}
                role="tooltip"
                className="wm-archive-tooltip"
                hidden={!archiveHelp}
              >
                Archives this session and stops its running work. Other attached
                sessions stay open. Undo reopens it without restarting the
                agent.
              </span>
            </span>
          </div>
        )}
        {busy && <span role="status">Saving…</span>}
      </fieldset>
      {error && (
        <p role="alert" className="wm-settle-error">
          {error}
        </p>
      )}
    </section>
  );
}

export function SettledToday({
  rows,
  onUndo,
  pending,
  error,
}: {
  rows: Settlement[];
  onUndo: (id: string) => void;
  pending: string | null;
  error: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(() => ({
    ids: readDismissedSettlements(),
    error: "",
  }));
  const listId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const reopenRef = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  const closed =
    rows.every((row) => dismissed.ids.includes(row.id)) &&
    (!error || error === dismissed.error);
  useEffect(() => {
    if (!moveFocus.current) return;
    (closed ? reopenRef : closeRef).current?.focus({ preventScroll: true });
    moveFocus.current = false;
  }, [closed]);
  function dismiss() {
    const ids = rows.map((row) => row.id);
    moveFocus.current = true;
    setDismissed({ ids, error });
    setExpanded(false);
    try {
      sessionStorage.setItem(DISMISSED_SETTLEMENTS, JSON.stringify(ids));
    } catch {
      /* Keep dismissal usable when storage is unavailable. */
    }
  }
  function reopen() {
    moveFocus.current = true;
    setDismissed({ ids: [], error: "" });
    setExpanded(true);
    try {
      sessionStorage.removeItem(DISMISSED_SETTLEMENTS);
    } catch {
      /* In-memory state still works. */
    }
  }
  if (!rows.length && !error) return null;
  if (closed)
    return (
      <div className="wm-settled-closed">
        <Button ref={reopenRef} size="sm" variant="ghost" onClick={reopen}>
          {pending ? "Undoing…" : "Settled today"}
          {rows.length ? ` · ${rows.length}` : ""}
          <span className="sr-only"> · Show history</span>
        </Button>
      </div>
    );
  return (
    <section
      className={`wm-settled ${expanded ? "wm-settled-expanded" : ""}`}
      aria-label="Settled today"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <div className="wm-settled-heading">
        <h2>
          Settled today <span>{rows.length}</span>
        </h2>
      </div>
      <div className="wm-settled-list" id={listId}>
        {(expanded ? rows : rows.slice(0, 1)).map((row) => (
          <div key={row.id} className="wm-settled-row">
            <span
              className={`wm-settled-mark wm-settled-${row.action}`}
              aria-hidden="true"
            >
              ✓
            </span>
            <div className="wm-settled-copy">
              <strong title={row.title}>{row.title}</strong>
              <span>
                {row.action === "done"
                  ? "Task done"
                  : row.action === "archive"
                    ? "Session archived"
                    : row.action === "review"
                      ? row.reviewer
                        ? `Waiting on ${row.reviewer} · follow up ${row.checkAfter}`
                        : "Ready for your review"
                      : "Paused · task remains open"}
                {row.action !== "archive" && row.archivedThreadIds.length
                  ? " · session archived"
                  : ""}
              </span>
              {expanded && row.nextAction && <span>{row.nextAction}</span>}
              {row.warning && (
                <span className="wm-settle-error" role="status">
                  {row.warning}
                </span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending !== null}
              onClick={() => onUndo(row.id)}
            >
              {pending === row.id ? "Undoing…" : "Undo"}
            </Button>
            {expanded && row.taskKey && (
              <UrlLink
                className="wm-settled-link"
                href={`/plugins/tasks/tasks/task/${row.taskKey}`}
              >
                Task ↗
              </UrlLink>
            )}
          </div>
        ))}
      </div>
      {rows.length > 0 && (
        <button
          className="wm-settled-more"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? "Show less"
            : rows.length > 1
              ? `History (${rows.length})`
              : "Details"}
        </button>
      )}
      <button
        ref={closeRef}
        className="wm-settled-close"
        aria-label="Close settled today"
        title="Close settled today"
        onClick={dismiss}
      >
        <span aria-hidden="true">×</span>
      </button>
      {error && (
        <p role="alert" className="wm-settle-error">
          {error}
        </p>
      )}
    </section>
  );
}
