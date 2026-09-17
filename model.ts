import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { MapTask, Preference, Snapshot } from "./server";

export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*`_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function describeTask(description: string) {
  const field = (name: string) =>
    plainText(
      description.match(new RegExp(`^${name}:\\s*(.*)$`, "mi"))?.[1] ?? "",
    );
  const first = description.split("\n").find((line) => line.trim()) ?? "";
  const summary = plainText(first).replace(
    /^STATE\s+\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?(?:\s+[A-Z]{3,4})?\s*[·:.-]?\s*/i,
    "",
  );
  const next = field("NEXT ACTION");
  return {
    summary: summary.slice(0, 500),
    nextAction: /^(none|n\/a)$/i.test(next) ? "" : next.slice(0, 700),
    dateKind: field("DATE KIND"),
    waitingOn: field("WAITING"),
    lifecycle: (description.match(/^LIFECYCLE:[ \t]*(.*)$/im)?.[1] ?? "")
      .trim()
      .toLowerCase(),
    checkAfter: field("CHECK AFTER"),
  };
}
export type Signal = "waiting" | "unread" | "working" | "inactive";
export type Attention = "input" | "error" | "review" | "followup" | "unread";
const ATTENTION_ORDER: Attention[] = [
  "input",
  "error",
  "review",
  "followup",
  "unread",
];
const ATTENTION_LABEL: Record<Attention, string> = {
  input: "Needs your input",
  error: "Run failed",
  review: "Needs review",
  followup: "Follow-up due",
  unread: "New result · unread",
};
export interface WorkItem {
  id: string;
  title: string;
  kind: "project" | "task" | "thread";
  summary: string;
  nextAction: string;
  focus: boolean;
  signal: Signal;
  attention: Attention | null;
  unreadResults: number;
  reason: string;
  score: number;
  changed: boolean;
  updatedAt: number;
  threads: PluginSidebarThread[];
  task?: MapTask;
  children: WorkItem[];
  scope: string;
  issue: boolean;
}
const RUNNING = new Set([
  "runtime",
  "background-agent",
  "background-command",
  "workflow",
  "goal",
  "working-draft",
]);
export function threadSignal(thread: PluginSidebarThread): Signal {
  if (
    thread.hasPendingInteraction ||
    ["waiting-for-input", "unread-error"].includes(thread.indicator)
  )
    return "waiting";
  if (thread.indicator === "unread-success") return "unread";
  if (RUNNING.has(thread.indicator)) return "working";
  return "inactive";
}
function attentionFor(
  threads: readonly PluginSidebarThread[],
): Attention | null {
  if (
    threads.some(
      (t) => t.hasPendingInteraction || t.indicator === "waiting-for-input",
    )
  )
    return "input";
  if (threads.some((t) => t.indicator === "unread-error")) return "error";
  if (threads.some((t) => t.indicator === "unread-success")) return "unread";
  return null;
}
function unreadResults(threads: readonly PluginSidebarThread[]) {
  return new Set(
    threads.filter((t) => t.indicator === "unread-success").map((t) => t.id),
  ).size;
}
export function localDay(now: number) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function dueLabel(task: MapTask, now: number) {
  if (!task.dueDate || ["done", "canceled", "backlog"].includes(task.status))
    return "";
  const prefix = task.dateKind === "plan" ? "Planned" : "Due";
  if (task.dueDate === localDay(now)) return `${prefix} today`;
  if (task.dueDate < localDay(now))
    return `${prefix} ${task.dueDate.slice(5)} · passed`;
  return `${prefix} ${task.dueDate.slice(5)}`;
}
function rank(
  item: Pick<
    WorkItem,
    | "focus"
    | "signal"
    | "attention"
    | "unreadResults"
    | "changed"
    | "task"
    | "updatedAt"
  >,
  now: number,
) {
  let score = item.focus ? 10000 : 0;
  score +=
    item.signal === "waiting"
      ? 6000
      : item.signal === "unread"
        ? 4500
        : item.signal === "working"
          ? 4000
          : 0;
  if (item.signal === "waiting" && item.unreadResults > 0) score += 300;
  score +=
    item.attention === "input" ? 1200 : item.attention === "error" ? 1000 : 0;
  const task = item.task;
  if (task && !["done", "canceled", "backlog"].includes(task.status)) {
    score +=
      task.priority === "urgent" ? 180 : task.priority === "high" ? 90 : 0;
    if (
      task.dueDate &&
      (!task.waitingOn || task.waitingOn.toLowerCase() === "none")
    )
      score +=
        task.dueDate <= localDay(now + 86400000)
          ? task.dateKind === "plan"
            ? 40
            : 130
          : 0;
  }
  score += item.changed ? 60 : 0;
  return score + Math.max(0, 20 - (now - item.updatedAt) / 86400000);
}
function activityReason(attention: Attention | null, signal: Signal): string {
  if (attention) return ATTENTION_LABEL[attention];
  if (signal === "working") return "Agent working";
  return "Inactive";
}
export function buildMap(
  snapshot: Snapshot,
  threads: readonly PluginSidebarThread[],
  preferences: Record<string, Preference>,
  now: number,
  retainedTaskId?: string,
): WorkItem[] {
  const active = threads.filter((t) => !t.isArchived);
  const byId = new Map(active.map((t) => [t.id, t]));
  const attached = new Set<string>();
  const tasks: WorkItem[] = [];
  for (const task of snapshot.tasks) {
    const linked = task.threadIds
      .map((id) => byId.get(id))
      .filter((t): t is PluginSidebarThread => Boolean(t));
    const id = `task:${task.id}`;
    const states = linked.map(threadSignal);
    const externalReview =
      task.lifecycle === "waiting" &&
      !["done", "canceled", "in_review"].includes(task.status);
    const followUp =
      externalReview &&
      /^\d{4}-\d{2}-\d{2}$/.test(task.checkAfter ?? "") &&
      task.checkAfter! <= localDay(now);
    const sessionAttention = attentionFor(linked);
    const attention =
      sessionAttention === "input" || sessionAttention === "error"
        ? sessionAttention
        : task.status === "in_review"
          ? "review"
          : followUp
            ? "followup"
            : sessionAttention;
    const signal =
      attention && attention !== "unread"
        ? "waiting"
        : attention === "unread"
          ? "unread"
          : states.includes("working")
            ? "working"
            : "inactive";
    if (
      ["done", "canceled"].includes(task.status) &&
      signal === "inactive" &&
      task.id !== retainedTaskId
    )
      continue;
    linked.forEach((t) => attached.add(t.id));
    const parsedUpdate = Date.parse(task.updatedAt);
    const updatedAt = Number.isFinite(parsedUpdate) ? parsedUpdate : 0;
    const item: WorkItem = {
      id,
      kind: "task",
      title: task.title,
      summary: task.summary,
      nextAction: task.nextAction,
      task,
      children: [],
      threads: linked,
      focus: linked.some((t) => t.isPinned) || preferences[id]?.focus === true,
      signal,
      attention,
      unreadResults: unreadResults(linked),
      reason:
        externalReview && signal === "inactive"
          ? `Waiting on ${task.waitingOn.split(" | ")[0].replace(/:\s*review$/i, "") || "review"}`
          : activityReason(attention, signal),
      changed:
        updatedAt > (preferences[id]?.seenAt ?? 0) &&
        now - updatedAt < 48 * 3600000,
      updatedAt,
      score: 0,
      scope:
        snapshot.projects.find((p) => p.id === task.projectId)?.name ?? "Tasks",
      issue: linked.some((t) => t.indicator === "unread-error"),
    };
    item.score = rank(item, now);
    tasks.push(item);
  }
  const projects: WorkItem[] = snapshot.projects.map((project): WorkItem => {
    const children = tasks
      .filter((t) => t.task?.projectId === project.id)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const id = `project:${project.id}`;
    const working = children.filter(isWorking).length;
    const waiting = children.filter((c) => c.signal === "waiting").length;
    const linked = children.flatMap((c) => c.threads);
    const unread = unreadResults(linked);
    const attention =
      ATTENTION_ORDER.find((kind) =>
        children.some((c) => c.attention === kind),
      ) ?? null;
    const counts: Record<Attention, number> = {
      input: 0,
      error: 0,
      review: 0,
      followup: 0,
      unread: 0,
    };
    for (const child of children) {
      if (child.attention) counts[child.attention]++;
      if (needsReview(child) && child.attention !== "review") counts.review++;
    }
    const countLabel = (kind: Attention, singular: string, plural: string) =>
      counts[kind]
        ? `${counts[kind]} ${counts[kind] === 1 ? singular : plural}`
        : "";
    const focus =
      preferences[id]?.focus === true || children.some((c) => c.focus);
    const signal: Signal = waiting
      ? "waiting"
      : unread
        ? "unread"
        : working
          ? "working"
          : "inactive";
    const lead = children[0];
    return {
      id,
      title: project.name,
      kind: "project",
      summary: lead
        ? `${lead.task?.key} · ${lead.nextAction || lead.summary}`
        : "No open tasks",
      nextAction: "",
      focus,
      signal,
      attention,
      unreadResults: unread,
      reason:
        [
          countLabel("input", "needs input", "need input"),
          countLabel("error", "with an error", "with errors"),
          countLabel("review", "needs review", "need review"),
          countLabel("followup", "needs follow-up", "need follow-up"),
          unread ? `${unread} new ${unread === 1 ? "result" : "results"}` : "",
          working ? `${working} working` : "",
        ]
          .filter(Boolean)
          .join(" · ") || `${children.length} inactive tasks`,
      score:
        Math.max(0, ...children.map((c) => c.score)) +
        (focus && !children.some((c) => c.focus) ? 10000 : 0),
      children,
      threads: linked,
      changed: children.some((c) => c.changed),
      updatedAt: Math.max(0, ...children.map((c) => c.updatedAt)),
      scope: project.prefix,
      issue: children.some((c) => c.issue),
    };
  });
  const standalone: WorkItem[] = active
    .filter(
      (t) =>
        !attached.has(t.id) &&
        (!t.parentThreadId || t.isPinned || threadSignal(t) !== "inactive"),
    )
    .map((thread) => sessionItem(thread, now));
  return [...projects, ...standalone].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
}
export function sessionItem(
  thread: PluginSidebarThread,
  now: number,
): WorkItem {
  const signal = thread.isArchived ? "inactive" : threadSignal(thread);
  const attention = thread.isArchived ? null : attentionFor([thread]);
  const item: WorkItem = {
    id: `thread:${thread.id}`,
    kind: "thread",
    title: thread.title ?? thread.titleFallback ?? "Untitled session",
    summary: thread.indicatorLabel ?? "Open for the latest session update.",
    nextAction: "",
    focus: thread.isPinned,
    signal,
    attention,
    unreadResults: thread.isArchived ? 0 : unreadResults([thread]),
    reason: thread.isArchived ? "Archived" : activityReason(attention, signal),
    changed: false,
    updatedAt: thread.latestAttentionAt,
    score: 0,
    threads: [thread],
    children: [],
    scope: "Session",
    issue: thread.indicator === "unread-error",
  };
  item.score = rank(item, now);
  return item;
}
export function isWorking(item: WorkItem) {
  return item.threads.some((t) => threadSignal(t) === "working");
}
export function needsReview(item: WorkItem) {
  return item.task?.status === "in_review";
}
function needsImmediateAction(item: WorkItem) {
  return item.attention === "input" || item.attention === "error";
}
export function selectVisible(items: WorkItem[], limit: number, rotation = 0) {
  const focused = items.filter((i) => i.focus);
  const urgent = items.filter((i) => !i.focus && needsImmediateAction(i));
  const working = items.filter(
    (i) => !i.focus && !needsImmediateAction(i) && isWorking(i),
  );
  const waiting = items.filter(
    (i) =>
      !i.focus &&
      !needsImmediateAction(i) &&
      !isWorking(i) &&
      ["waiting", "unread"].includes(i.signal),
  );
  const quiet = items.filter((i) => !i.focus && i.signal === "inactive");
  // Reserve a glimpse of the periphery, while never evicting a pin or the
  // only running session in favor of a queue full of task reviews.
  const essential = [...focused, ...urgent, ...working].slice(0, limit);
  const quietSlots = Math.min(
    limit >= 10 ? 4 : 2,
    quiet.length,
    Math.max(0, limit - essential.length - (waiting.length ? 1 : 0)),
  );
  const reserved = [
    ...essential,
    ...waiting.slice(0, Math.max(0, limit - essential.length - quietSlots)),
  ];
  const slots = limit - reserved.length;
  const rotated = quiet.length
    ? quiet
        .slice(rotation % quiet.length)
        .concat(quiet.slice(0, rotation % quiet.length))
    : [];
  return [...reserved, ...rotated.slice(0, slots)];
}

export function arrangeMap(items: WorkItem[]) {
  // Importance controls distance from the center, not a top-to-bottom list.
  const ranked = [...items].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
  const anchor = ranked.at(0);
  const remaining = ranked.filter((item) => item.id !== anchor?.id);
  // Keep running agents close even when many routine reviews outrank them.
  const priority = [
    ...remaining.filter((item) => item.focus),
    ...remaining.filter((item) => !item.focus && needsImmediateAction(item)),
    ...remaining.filter(
      (item) => !item.focus && !needsImmediateAction(item) && isWorking(item),
    ),
    ...remaining.filter(
      (item) => !item.focus && !needsImmediateAction(item) && !isWorking(item),
    ),
  ];
  const near = priority.slice(0, 2);
  const rest = priority.slice(2);
  const far = rest
    .filter(
      (item) => !item.focus && !isWorking(item) && !needsImmediateAction(item),
    )
    .slice(-4);
  const farIds = new Set(far.map((item) => item.id));
  const sides = rest.filter((item) => !farIds.has(item.id));
  const west: WorkItem[] = [],
    east: WorkItem[] = [];
  let westHeight = 0,
    eastHeight = 0;
  for (const item of sides) {
    const height = item.kind === "project" ? 2 : 1;
    if (westHeight <= eastHeight) {
      west.push(item);
      westHeight += height;
    } else {
      east.push(item);
      eastHeight += height;
    }
  }
  const middleFirst = (column: WorkItem[]) => {
    if (column.length < 3) return column;
    const ordered = column.slice(1);
    ordered.splice(Math.floor(column.length / 2), 0, column[0]);
    return ordered;
  };
  return {
    anchor,
    near,
    west: middleFirst(west),
    east: middleFirst(east),
    north: far.filter((_, index) => index % 2 === 0),
    south: far.filter((_, index) => index % 2 === 1),
  };
}
