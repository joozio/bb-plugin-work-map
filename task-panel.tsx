import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { AskSource, WorkItem } from "./model";
import type { MapTask, TaskComment, TaskDetail } from "./server";
import {
  ACTION_LABEL,
  blockedReason,
  type ActionContext,
  type QuickAction,
} from "./delegation";
import { heatTiming } from "./heat-timing";
import { SafeMarkdown } from "./markdown";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";

/*
 * An opened task shows the whole task. The main column is the work: the ask,
 * the full description, then the timeline with a box to write back in place.
 * The side column is the facts and the people: status, dates, project,
 * labels, attachments, then every session with one click to open it.
 */

const STATUS_LABEL: Record<string, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
  canceled: "Canceled",
};
export function statusLabel(status: string) {
  return (
    STATUS_LABEL[status] ??
    status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}
const MINUTE = 60_000;
/** How long ago, in the fewest words; the exact moment goes in the tooltip. */
export function ageLabel(iso: string | null | undefined, now: number) {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const gap = Math.max(0, now - at);
  if (gap < MINUTE) return "just now";
  if (gap < 60 * MINUTE) return `${Math.floor(gap / MINUTE)}m ago`;
  if (gap < 24 * 60 * MINUTE) return `${Math.floor(gap / (60 * MINUTE))}h ago`;
  const days = Math.floor(gap / (24 * 60 * MINUTE));
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return `on ${iso!.slice(0, 10)}`;
}
export function exactTime(iso: string | null | undefined) {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** Who wrote a comment, as the timeline names them. */
export function commentAuthor(comment: TaskComment) {
  if (comment.kind === "agent")
    return (
      comment.threadTitle ||
      comment.presetName ||
      comment.authorName ||
      "Agent"
    );
  if (comment.kind === "system") return comment.authorName || "Tasks";
  return comment.authorName || "Someone";
}
/** Newest first: the latest word is what the reader came for. */
export function orderComments<T extends { createdAt: string; id: string }>(
  comments: readonly T[],
) {
  return [...comments].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}
export const ASK_LABEL: Record<AskSource, string> = {
  comment: "Needs you",
  next: "Next step",
  why: "Why",
  summary: "Summary",
};
/**
 * The ask the tile shows, from the same source: the latest "Needs you:"
 * comment, else NEXT STEP or Why, else the summary. A summary is the
 * description's own first lines, so it is not quoted above the description;
 * the description's lead paragraph carries it instead.
 */
export function taskAsk(task: MapTask): { ask: string; from: AskSource } | null {
  if (task.ask) return { ask: task.ask, from: task.askFrom ?? "summary" };
  if (task.nextAction) return { ask: task.nextAction, from: "next" };
  if (task.summary) return { ask: task.summary, from: "summary" };
  return null;
}
/** Past this a description folds behind Show all; comments fold sooner. */
export const DESCRIPTION_FOLD = { lines: 18, chars: 1400 };
export const COMMENT_FOLD = { lines: 10, chars: 700 };
export function folds(text: string, at: { lines: number; chars: number }) {
  return text.length > at.chars || text.split("\n").length > at.lines;
}
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Folded({
  text,
  at,
  label,
  className,
}: {
  text: string;
  at: { lines: number; chars: number };
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = folds(text, at);
  return (
    <div className={`wm-fold ${long && !open ? "wm-fold-closed" : ""}`}>
      <div id={id} className="wm-fold-body">
        <SafeMarkdown text={text} className={className} />
      </div>
      {long && (
        <button
          type="button"
          className="wm-fold-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Show less" : label}
        </button>
      )}
    </div>
  );
}

export function TaskAsk({ ask, from }: { ask: string; from: AskSource }) {
  return (
    <section className="wm-task-ask" aria-label="The ask" data-ask-from={from}>
      <h3>{ASK_LABEL[from]}</h3>
      <p>{ask}</p>
    </section>
  );
}

export function TaskDescription({
  text,
  lead,
  loading,
}: {
  text: string;
  /** The description's own first lines are the ask: draw its lead larger. */
  lead: boolean;
  loading?: boolean;
}) {
  return (
    <section
      className={`wm-task-description ${lead ? "wm-task-description-lead" : ""}`}
      aria-label="Description"
    >
      <h3>Description</h3>
      {text.trim() ? (
        <Folded text={text} at={DESCRIPTION_FOLD} label="Show all" />
      ) : (
        <p className="wm-task-empty">
          {loading ? "Loading the description…" : "No description yet."}
        </p>
      )}
    </section>
  );
}

export function CommentBox({
  taskKey,
  draft,
  busy,
  error,
  onDraft,
  onPost,
}: {
  taskKey: string;
  draft: string;
  busy: boolean;
  error: string;
  onDraft: (text: string) => void;
  onPost: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const hint = useId();
  return (
    <form
      className="wm-comment-box"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft.trim() && !busy) onPost();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLFormElement>) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (draft.trim() && !busy) onPost();
        } else if (
          event.key === "Escape" &&
          draft.trim() &&
          event.target === ref.current
        ) {
          // A draft is kept: Escape leaves the box; the next one steps back.
          event.preventDefault();
          event.stopPropagation();
          ref.current?.blur();
        }
      }}
    >
      <textarea
        ref={ref}
        value={draft}
        rows={2}
        maxLength={20000}
        disabled={busy}
        aria-label={`Comment on ${taskKey}`}
        aria-describedby={hint}
        placeholder="Steer this task: a comment in your name, Markdown allowed"
        onChange={(event) => onDraft(event.target.value)}
      />
      <div className="wm-comment-submit">
        <Button size="sm" type="submit" disabled={busy || !draft.trim()}>
          {busy ? "Posting…" : "Post comment"}
        </Button>
        <span id={hint} className="wm-comment-hint">
          {draft.trim()
            ? "⌘↩ posts · Agent decides sends it with the brief"
            : "Posts as you, to the task's timeline"}
        </span>
      </div>
      {error && (
        <p role="alert" className="wm-settle-error">
          {error}
        </p>
      )}
    </form>
  );
}

export function CommentTimeline({
  comments,
  now,
  loading,
  error,
  onRetry,
  children,
}: {
  comments: readonly TaskComment[];
  now: number;
  loading: boolean;
  error: string;
  onRetry: () => void;
  /** The comment box, at the top of the timeline. */
  children?: ReactNode;
}) {
  const [history, setHistory] = useState(false);
  const ordered = orderComments(comments);
  const notes = ordered.filter((comment) => comment.kind !== "system");
  const system = ordered.length - notes.length;
  // Status changes are history: folded while there are real comments to read.
  const shown = history || !notes.length ? ordered : notes;
  return (
    <section className="wm-task-comments" aria-label="Comments">
      <div className="wm-section-heading">
        <h3>
          Comments <span>{notes.length}</span>
        </h3>
        {system > 0 && notes.length > 0 && (
          <button
            type="button"
            className="wm-history-toggle"
            aria-pressed={history}
            onClick={() => setHistory((value) => !value)}
          >
            {history ? "Hide history" : `History (${system})`}
          </button>
        )}
      </div>
      {children}
      {error ? (
        <p role="alert" className="wm-settle-error">
          {error}{" "}
          <button type="button" className="wm-inline-link" onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : loading && !comments.length ? (
        <p className="wm-task-empty">Loading the timeline…</p>
      ) : !ordered.length ? (
        <p className="wm-task-empty">
          No comments yet. The first word here steers the task.
        </p>
      ) : (
        <ol className="wm-comment-list">
          {shown.map((comment) => (
            <li
              key={comment.id}
              className={`wm-comment wm-comment-${comment.kind}`}
              data-kind={comment.kind}
            >
              <div className="wm-comment-head">
                <strong>{commentAuthor(comment)}</strong>
                {comment.kind === "agent" && comment.threadId && (
                  <UrlLink
                    className="wm-comment-session"
                    href={`/threads/${comment.threadId}`}
                  >
                    session ↗
                  </UrlLink>
                )}
                <time
                  dateTime={comment.createdAt}
                  title={exactTime(comment.createdAt)}
                >
                  {ageLabel(comment.createdAt, now)}
                </time>
              </div>
              {comment.kind === "system" ? (
                <p className="wm-comment-system">{comment.body}</p>
              ) : (
                <Folded
                  text={comment.body}
                  at={COMMENT_FOLD}
                  label="Show more"
                  className="wm-comment-body"
                />
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function TaskFacts({
  item,
  task,
  detail,
  scope,
  now,
  dateFixes,
}: {
  item: WorkItem;
  task: MapTask;
  detail: TaskDetail | null;
  scope: string;
  now: number;
  /** The one-click date fixes, drawn under a date that is past. */
  dateFixes?: ReactNode;
}) {
  const timing = heatTiming(item, now);
  const dateName = task.dateKind === "plan" ? "Planned" : "Due";
  const waiting =
    task.waitingOn && task.waitingOn.toLowerCase() !== "none"
      ? task.waitingOn
      : "";
  const created = detail?.createdAt ?? task.createdAt;
  return (
    <dl className="wm-facts wm-task-facts">
      <div>
        <dt>Status</dt>
        <dd>{statusLabel(task.status)}</dd>
      </div>
      <div>
        <dt>Priority</dt>
        <dd>{task.priority}</dd>
      </div>
      {task.dueDate && (
        <div className="wm-fact-date" data-overdue={timing?.overdue || undefined}>
          <dt>{dateName}</dt>
          <dd>
            {task.dueDate}
            {timing?.kind === "due" && (
              <em className={timing.overdue ? "wm-fact-late" : undefined}>
                {timing.label}
              </em>
            )}
            {timing?.kind === "snooze" && <em>{timing.label}</em>}
          </dd>
          {timing?.kind === "due" && timing.overdue && dateFixes && (
            <dd className="wm-fact-fixes">{dateFixes}</dd>
          )}
        </div>
      )}
      <div>
        <dt>Project</dt>
        <dd>{scope}</dd>
      </div>
      {created && (
        <div>
          <dt>Created</dt>
          <dd title={exactTime(created)}>{ageLabel(created, now)}</dd>
        </div>
      )}
      <div>
        <dt>Updated</dt>
        <dd title={exactTime(task.updatedAt)}>
          {ageLabel(task.updatedAt, now)}
        </dd>
      </div>
      {waiting && (
        <div>
          <dt>Waiting on</dt>
          <dd>{waiting}</dd>
        </div>
      )}
      {task.checkAfter && (
        <div>
          <dt>Check after</dt>
          <dd>{task.checkAfter}</dd>
        </div>
      )}
      {detail && detail.labels.length > 0 && (
        <div>
          <dt>Labels</dt>
          <dd className="wm-fact-labels">
            {detail.labels.map((label) => (
              <span
                key={label.id}
                className="wm-label"
                style={label.color ? { "--wm-label": label.color } as never : undefined}
              >
                {label.name}
              </span>
            ))}
          </dd>
        </div>
      )}
      {detail && detail.attachments.length > 0 && (
        <div>
          <dt>Attachments</dt>
          <dd className="wm-fact-files">
            {detail.attachments.map((file) => (
              <UrlLink
                key={file.id}
                href={`/plugins/tasks/tasks/task/${task.key}`}
                title={`${file.mime} · ${formatBytes(file.sizeBytes)} · opens in Tasks`}
              >
                {file.fileName}
              </UrlLink>
            ))}
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * The lead of the one action bar: Agent decides. Done is the settlement the
 * bar already carries and Snooze sits in its menu, so neither repeats here.
 */
export function BarActs({
  item,
  disabled,
  busy,
  context,
  onAct,
}: {
  item: WorkItem;
  disabled: boolean;
  busy: QuickAction | null;
  context?: ActionContext;
  onAct: (action: QuickAction, item: WorkItem) => void;
}) {
  if (blockedReason(item, "done", context)) return null;
  const actions: QuickAction[] = ["delegate"];
  return (
    <>
      {actions.map((action) => {
        const why = blockedReason(item, action, context);
        return (
          <button
            key={action}
            type="button"
            className={`wm-bar-act wm-bar-lead wm-bar-${action}`}
            disabled={disabled || !!busy || !!why}
            title={why ? `${ACTION_LABEL[action]}: ${why}` : undefined}
            aria-label={
              why ? `${ACTION_LABEL[action]} · unavailable: ${why}` : undefined
            }
            onClick={() => onAct(action, item)}
          >
            {action === "delegate" && <Icon name="Bot" />}
            <span>{busy === action ? "…" : ACTION_LABEL[action]}</span>
          </button>
        );
      })}
    </>
  );
}

export type MoreItem = {
  key: string;
  label: string;
  hint?: string;
  href?: string;
  disabled?: boolean;
  className?: string;
  onSelect?: () => void;
};
/** Snooze, or Unsnooze on a snoozed task, as a menu entry that says why when it cannot. */
export function snoozeItem(
  item: WorkItem,
  context: ActionContext | undefined,
  busy: boolean,
  onAct: (action: QuickAction, item: WorkItem) => void,
): MoreItem | null {
  if (blockedReason(item, "done", context)) return null;
  const action: QuickAction = item.snoozedUntil ? "unsnooze" : "snooze";
  const why = blockedReason(item, action, context);
  return {
    key: action,
    label: ACTION_LABEL[action],
    hint: why
      ? `Unavailable: ${why}`
      : action === "snooze"
        ? "Quiet for 7 days. Tasks unchanged."
        : "Back into what needs you.",
    disabled: busy || !!why,
    className: "wm-menu-separated",
    onSelect: () => onAct(action, item),
  };
}
/** The quiet acts behind one ⋯: where to open the task, and its focus. */
export function MoreMenu({ label, items }: { label: string; items: MoreItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div
      className="wm-more-menu"
      ref={root}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const entries = Array.from(
            root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
              [],
          );
          const index = entries.indexOf(document.activeElement as HTMLElement);
          entries[
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? entries.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) %
                  entries.length
          ]?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="wm-area-tool wm-more-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open && (
        <div role="menu" aria-label={label} className="wm-area-menu wm-menu-start">
          {items.map((entry) =>
            entry.href ? (
              <UrlLink
                key={entry.key}
                role="menuitem"
                href={entry.href}
                onClick={() => setOpen(false)}
              >
                {entry.label}
                {entry.hint && <small>{entry.hint}</small>}
              </UrlLink>
            ) : (
              <button
                key={entry.key}
                type="button"
                role="menuitem"
                className={entry.className}
                disabled={entry.disabled}
                onClick={() => {
                  close();
                  entry.onSelect?.();
                }}
              >
                {entry.label}
                {entry.hint && <small>{entry.hint}</small>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
