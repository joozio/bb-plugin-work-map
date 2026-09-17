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
  unread: "Ready to read",
};
export function unreadLabel(count: number) {
  return count === 1 ? "Ready to read" : `${count} results ready to read`;
}
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
  activityAt: number;
  recent: boolean;
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
const DAY = 86400000;
function validActivity(value: number, now: number) {
  return Number.isFinite(value) && value > 0 && value <= now ? value : 0;
}
function sessionActivity(thread: PluginSidebarThread, now: number) {
  // Reads and metadata edits are not a new session activity signal.
  return (
    validActivity(thread.latestAttentionAt, now) ||
    validActivity(thread.createdAt, now)
  );
}
function recentlyActive(activityAt: number, now: number) {
  return activityAt > 0 && now - activityAt < DAY;
}
function activityLift(activityAt: number, now: number) {
  return activityAt ? 120 * 2 ** (-Math.max(0, now - activityAt) / DAY) : 0;
}
export function activityLabel(item: Pick<WorkItem, "activityAt">, now: number) {
  if (!item.activityAt) return "";
  const hours = Math.max(0, (now - item.activityAt) / 3600000);
  return hours < 1
    ? "Active <1h ago"
    : hours < 24
      ? `Active ${Math.floor(hours)}h ago`
      : `Active ${Math.floor(hours / 24)}d ago`;
}
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
/** Choose once on opening a task; acknowledging a result must not switch it. */
export function preferredSession(
  threads: readonly PluginSidebarThread[],
  now: number,
): PluginSidebarThread | undefined {
  const priority = (thread: PluginSidebarThread) =>
    thread.hasPendingInteraction || thread.indicator === "waiting-for-input"
      ? 4
      : thread.indicator === "unread-error"
        ? 3
        : thread.indicator === "unread-success"
          ? 2
          : RUNNING.has(thread.indicator)
            ? 1
            : 0;
  return [...threads]
    .filter((thread) => !thread.isArchived)
    .sort(
      (a, b) =>
        priority(b) - priority(a) ||
        sessionActivity(b, now) - sessionActivity(a, now) ||
        a.id.localeCompare(b.id),
    )[0];
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
    | "activityAt"
  >,
  now: number,
) {
  let score = item.focus ? 10000 : 0;
  score +=
    item.signal === "waiting"
      ? 6000
      : item.signal === "unread"
        ? 7500
        : item.signal === "working"
          ? 4000
          : 0;
  if (
    item.signal === "waiting" &&
    item.unreadResults > 0 &&
    item.attention !== "input" &&
    item.attention !== "error"
  )
    score += 600;
  score +=
    item.attention === "input" ? 3000 : item.attention === "error" ? 2500 : 0;
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
  // Half the activity lift remains after 24h. Attention tiers stay stronger.
  return score + activityLift(item.activityAt, now);
}
function activityReason(
  attention: Attention | null,
  signal: Signal,
  results = 1,
): string {
  if (attention === "unread") return unreadLabel(results);
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
  const activityById = new Map(
    threads.map((t) => [t.id, sessionActivity(t, now)]),
  );
  const attached = new Set<string>();
  const projectActivity = new Map<string, number>();
  const tasks: WorkItem[] = [];
  for (const task of snapshot.tasks) {
    const linked = task.threadIds
      .map((id) => byId.get(id))
      .filter((t): t is PluginSidebarThread => Boolean(t));
    const id = `task:${task.id}`;
    const states = linked.map(threadSignal);
    const resultCount = unreadResults(linked);
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
    const parsedUpdate = Date.parse(task.updatedAt);
    const updatedAt = Number.isFinite(parsedUpdate) ? parsedUpdate : 0;
    const activityAt = Math.max(
      validActivity(updatedAt, now),
      ...task.threadIds.map((id) => activityById.get(id) ?? 0),
    );
    projectActivity.set(
      task.projectId,
      Math.max(projectActivity.get(task.projectId) ?? 0, activityAt),
    );
    if (
      ["done", "canceled"].includes(task.status) &&
      signal === "inactive" &&
      task.id !== retainedTaskId
    )
      continue;
    linked.forEach((t) => attached.add(t.id));
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
      unreadResults: resultCount,
      reason:
        externalReview && signal === "inactive"
          ? `Waiting on ${task.waitingOn.split(" | ")[0].replace(/:\s*review$/i, "") || "review"}`
          : activityReason(attention, signal, resultCount),
      changed:
        updatedAt > (preferences[id]?.seenAt ?? 0) &&
        updatedAt <= now &&
        now - updatedAt < 48 * 3600000,
      updatedAt,
      activityAt,
      recent: recentlyActive(activityAt, now),
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
    const activityAt = projectActivity.get(project.id) ?? 0;
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
          unread ? `${unread} ready to read` : "",
          working ? `${working} working` : "",
        ]
          .filter(Boolean)
          .join(" · ") || `${children.length} inactive tasks`,
      score:
        Math.max(
          0,
          ...children.map((c) => c.score - activityLift(c.activityAt, now)),
        ) +
        activityLift(activityAt, now) +
        (focus && !children.some((c) => c.focus) ? 10000 : 0),
      children,
      threads: linked,
      changed: children.some((c) => c.changed),
      updatedAt: Math.max(0, ...children.map((c) => c.updatedAt)),
      activityAt,
      recent: recentlyActive(activityAt, now),
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
  const activityAt = sessionActivity(thread, now);
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
    updatedAt: activityAt,
    activityAt,
    recent: recentlyActive(activityAt, now),
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
function centralItems(
  items: WorkItem[],
  readyLimit = Infinity,
  recentLimit = Infinity,
  reviewLimit = Infinity,
) {
  const focused = items.filter((i) => i.focus);
  const urgent = items.filter((i) => !i.focus && needsImmediateAction(i));
  const remaining = items.filter((i) => !i.focus && !needsImmediateAction(i));
  const ready = remaining
    .filter((i) => i.unreadResults > 0)
    .slice(0, readyLimit);
  const readyIds = new Set(ready.map((i) => i.id));
  const working = remaining.filter((i) => !readyIds.has(i.id) && isWorking(i));
  const reviews = remaining
    .filter(
      (i) => i.signal === "waiting" && !readyIds.has(i.id) && !isWorking(i),
    )
    .slice(0, reviewLimit);
  const recent = remaining
    // Task lists keep priority/date order; root areas get the recent slots.
    .filter(
      (i) =>
        i.kind !== "task" &&
        i.recent &&
        i.signal === "inactive" &&
        !isWorking(i),
    )
    .sort(
      (a, b) =>
        b.activityAt - a.activityAt ||
        b.score - a.score ||
        a.id.localeCompare(b.id),
    )
    .slice(0, recentLimit);
  // Make room for both a new result and a running agent, then more results.
  return [
    ...focused,
    ...urgent,
    ...ready.slice(0, 1),
    ...working.slice(0, 1),
    ...ready.slice(1),
    ...working.slice(1),
    ...reviews,
    ...recent,
  ];
}
export function selectVisible(items: WorkItem[], limit: number, rotation = 0) {
  // Two recent result areas are essential; older unread work uses the queue
  // budget so it cannot displace the other running agents or all quiet work.
  const essential = centralItems(items, 2, 2, 1).slice(0, limit);
  const essentialIds = new Set(essential.map((i) => i.id));
  const waiting = items.filter(
    (i) =>
      !i.focus &&
      !needsImmediateAction(i) &&
      !essentialIds.has(i.id) &&
      ["waiting", "unread"].includes(i.signal),
  );
  const quiet = items.filter(
    (i) => !i.focus && !essentialIds.has(i.id) && i.signal === "inactive",
  );
  // Reserve a glimpse of the periphery, while never evicting a pin or the
  // only running session in favor of a queue full of task reviews.
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
  const central = centralItems(remaining);
  const centralIds = new Set(central.map((item) => item.id));
  const priority = [
    ...central,
    ...remaining.filter((item) => !centralIds.has(item.id)),
  ];
  const near = priority.slice(0, 2);
  const rest = priority.slice(2);
  const far = rest
    .filter(
      (item) =>
        !item.focus &&
        !isWorking(item) &&
        item.signal !== "waiting" &&
        !item.unreadResults &&
        !item.recent,
    )
    .sort(
      (a, b) =>
        b.activityAt - a.activityAt ||
        b.score - a.score ||
        a.id.localeCompare(b.id),
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
