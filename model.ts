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
export type Signal = "waiting" | "working" | "inactive";
export interface WorkItem {
  id: string;
  title: string;
  kind: "project" | "task" | "thread";
  summary: string;
  nextAction: string;
  focus: boolean;
  signal: Signal;
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
    ["waiting-for-input", "unread-success", "unread-error"].includes(
      thread.indicator,
    )
  )
    return "waiting";
  if (RUNNING.has(thread.indicator)) return "working";
  return "inactive";
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
  item: Pick<WorkItem, "focus" | "signal" | "changed" | "task" | "updatedAt">,
  now: number,
) {
  let score = item.focus ? 10000 : 0;
  score +=
    item.signal === "waiting" ? 6000 : item.signal === "working" ? 4000 : 0;
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
function activityReason(
  threads: PluginSidebarThread[],
  signal: Signal,
): string {
  if (
    threads.some(
      (t) => t.hasPendingInteraction || t.indicator === "waiting-for-input",
    )
  )
    return "Needs your input";
  if (threads.some((t) => t.indicator === "unread-error"))
    return "Session needs attention";
  if (signal === "waiting") return "Finished · not seen";
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
    const signal =
      states.includes("waiting") || task.status === "in_review" || followUp
        ? "waiting"
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
      reason:
        task.status === "in_review" && !states.includes("waiting")
          ? "Your review"
          : followUp && !states.includes("waiting")
            ? "Follow-up due"
            : externalReview && signal === "inactive"
              ? `Waiting on ${task.waitingOn.split(" | ")[0].replace(/:\s*review$/i, "") || "review"}`
              : activityReason(linked, signal),
      changed:
        updatedAt > (preferences[id]?.seenAt ?? 0) &&
        now - updatedAt < 48 * 3600000,
      updatedAt,
      score: 0,
      scope:
        snapshot.projects.find((p) => p.id === task.projectId)?.name ?? "Tasks",
      issue: linked.some((t) => t.indicator === "unread-error"),
    };
    item.score =
      rank(item, now) +
      (linked.some((t) => t.hasPendingInteraction)
        ? 1200
        : linked.some((t) =>
              ["unread-success", "unread-error"].includes(t.indicator),
            )
          ? 1000
          : 0);
    tasks.push(item);
  }
  const projects: WorkItem[] = snapshot.projects.map((project): WorkItem => {
    const children = tasks
      .filter((t) => t.task?.projectId === project.id)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const id = `project:${project.id}`;
    const working = children.filter(isWorking).length;
    const waiting = children.filter((c) => c.signal === "waiting").length;
    const focus =
      preferences[id]?.focus === true || children.some((c) => c.focus);
    const signal: Signal = waiting
      ? "waiting"
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
      reason:
        [
          working ? `${working} working` : "",
          waiting ? `${waiting} waiting for you` : "",
        ]
          .filter(Boolean)
          .join(" · ") || `${children.length} inactive tasks`,
      score:
        Math.max(0, ...children.map((c) => c.score)) +
        (focus && !children.some((c) => c.focus) ? 10000 : 0),
      children,
      threads: children.flatMap((c) => c.threads),
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
  const item: WorkItem = {
    id: `thread:${thread.id}`,
    kind: "thread",
    title: thread.title ?? thread.titleFallback ?? "Untitled session",
    summary: thread.indicatorLabel ?? "Open for the latest session update.",
    nextAction: "",
    focus: thread.isPinned,
    signal,
    reason: thread.isArchived ? "Archived" : activityReason([thread], signal),
    changed: false,
    updatedAt: thread.latestAttentionAt,
    score: 0,
    threads: [thread],
    children: [],
    scope: "Session",
    issue: thread.indicator === "unread-error",
  };
  item.score =
    rank(item, now) +
    (thread.hasPendingInteraction
      ? 1200
      : ["unread-success", "unread-error"].includes(thread.indicator)
        ? 1000
        : 0);
  return item;
}
export function isWorking(item: WorkItem) {
  return item.threads.some((t) => threadSignal(t) === "working");
}
export function selectVisible(items: WorkItem[], limit: number, rotation = 0) {
  const focused = items.filter((i) => i.focus);
  const working = items.filter((i) => !i.focus && isWorking(i));
  const waiting = items.filter(
    (i) => !i.focus && !isWorking(i) && i.signal === "waiting",
  );
  const quiet = items.filter((i) => !i.focus && i.signal === "inactive");
  // Reserve a glimpse of the periphery, while never evicting a pin or the
  // only running session in favor of a queue full of task reviews.
  const essential = [...focused, ...working].slice(0, limit);
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
    ...remaining.filter((item) => !item.focus && isWorking(item)),
    ...remaining.filter((item) => !item.focus && !isWorking(item)),
  ];
  const near = priority.slice(0, 2);
  const rest = priority.slice(2);
  const farCount = Math.min(
    4,
    rest.filter((item) => !item.focus && !isWorking(item)).length,
  );
  const far = farCount ? rest.slice(-farCount) : [];
  const sides = farCount ? rest.slice(0, -farCount) : rest;
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
