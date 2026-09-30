import type { WorkItem } from "./model";
import { hasAgent, ORCHESTRATOR_CAP } from "./model";

/** What an expanded area can do to a piece of work without opening it. */
export type QuickAction = "delegate" | "done" | "snooze";
/**
 * The labels say what happens, in the map's own voice, where "you" is always
 * the reader: "Agent decides" is the act of letting it decide on its own.
 */
export const ACTION_LABEL: Record<QuickAction, string> = {
  delegate: "Agent decides",
  done: "Done",
  snooze: "Snooze",
};
/** The comment recorded on the task, in your name, when you hand it over. */
export const DELEGATION_COMMENT = "Delegated: decide on your own";
/** The same handover, when an area's orchestrator is the one taking it on. */
export function orchestratorComment(area: string) {
  return `Delegated to the ${orchestratorTitle(area)}: it decides on its own`;
}
/** How many tasks one orchestrator may have children running on at once. */
export const ORCHESTRATOR_LIMIT = ORCHESTRATOR_CAP;
/**
 * The fixed opening of the one comment a task gets when it comes back: the
 * owner scans the board for these words, so no agent gets to phrase them.
 */
export const NEEDS_YOU = "Needs you:";
/** The one task an orchestrator leaves behind, counts and all. */
export function reportTitle(area: string, done: number, needYou: number) {
  return `${orchestratorTitle(area)}: ${done} done, ${needYou} need you`;
}
const CLOSED = ["done", "canceled"];

/**
 * The limits, written once. Both briefs carry the identical list, so a stop
 * can never hold for a single delegated task and lapse for an orchestrated one.
 */
const HARD_STOPS = `- be irreversible: deleting data, spending money, or anything else that cannot be undone;
- publish or send anything outward in the owner's name, to any person or service;
- need a credential, device or account only the owner has;
- ship in the owner's name or voice: approving, closing or signing off a post, draft, email, social or product copy that goes out as their words. Do the review you can instead, as a task comment: your notes, the concrete edits you propose, the risks you see.`;

/**
 * The standing brief every delegated agent receives. It is fixed on purpose:
 * the point of one click is that no prompt has to be written, so the limits
 * cannot be edited away per dispatch either.
 */
export const DELEGATION_PROMPT = `You own this decision now. It was delegated to you from Work Map: nobody is waiting to approve your choice, and nobody will answer a question you ask here.

Do this:
1. Read the task in full: its description, its comments and any attached session history.
2. Decide using that brief. Where it leaves room, choose what the brief's own goals imply and say why.
3. Do the work the decision calls for.
4. Record the decision and your evidence as a task comment: what you chose, why, and what you changed or produced.
5. Mark the task done. This dispatch overrides any standing instruction to leave closing to the task's owner, because closing it is part of what was delegated.

Stop and do NOT act if the work would:
${HARD_STOPS}

In any of those cases, do nothing irreversible, move the task back to Review, and leave one line saying which limit you hit. That is a complete and correct outcome, not a failure.`;

/**
 * The standing brief for an area's orchestrator. One click on a whole area
 * starts this one agent, not one per task: reading the tasks together is what
 * finds the duplicates and the order, and holding the children is what keeps
 * a twelve-task area from starting twelve agents at once.
 */
export const ORCHESTRATOR_PROMPT = `You own an area of work now. It was delegated to you from Work Map: every task listed below is yours to bring to an end, nobody is waiting to approve your plan, and nobody will answer a question you ask here. The owner reads the board, not this thread: what you leave on the tasks and in your one review task is all they will see.

You are the orchestrator. You do not do these tasks yourself. You read them, connect them, and run them as child agents.

1. Read every task in full first: its description, its comments and any attached session history. Start nothing until you have read all of them.
2. Map the connections. Name which tasks are duplicates, which overlap, which depend on another finishing first, which share context worth working out once, and what order makes the later ones easier. Merge what is really one piece of work; sequence what has an order.
3. Post that plan as your first message: the order you chose and why.
4. Run each task as a child thread of yourself, attached to that task, so both the map and the task show who is working. Two steps, because a task dispatch cannot set a parent: spawn the child under yourself (\`bb thread spawn --parent-self\`), then attach that thread to its task (\`bb tasks attach <task> --thread <id>\`, or the Tasks API). Check both sides before you rely on it: the child appears under you, and it appears on its task.
5. Brief each child in full: the task, the cross-task context you found, what done means for it, the two end states below and the exact words that mark one of them, and the same limits you work under. A child left to guess its finish line stops early. Tell it to reply with a short result, not a transcript.
6. Keep at most ${ORCHESTRATOR_LIMIT} children running at once. That is a hard cap, not a target. Before every spawn, list your children (\`bb thread list --parent-thread <your thread id> --json\`) and count the ones whose status is not idle; if that count is already ${ORCHESTRATOR_LIMIT}, wait for one of them (\`bb thread wait <id>\`) and only then spawn. Keep going until every task has an end.
7. Read each child's reported result, not its whole transcript. Check that result against what the task actually asked for. Where it falls short, re-brief that child once with what is missing; if the second result still falls short, accept the limit and say so. Once you have read a child's final result, archive it (\`bb thread archive <id>\`): a finished child left open is noise on the owner's screen.
8. End every task in one of exactly two states, never between them: done, with a comment recording the decision and its evidence; or back in Review (\`bb tasks update <task> --status in_review\`), with one comment that starts with the words "${NEEDS_YOU}" and says in one line what the owner has to do and why you could not. A task back in Review is finished for you: never re-brief or re-run it.
9. When every task has an end, create exactly one task in this area, in Review, with the title given below and the real counts filled in. Its description is the owner's whole summary: first "Closed without you (N)" with one line of evidence per task, then the tasks that need them, grouped by what they have to do (a quick call, a small fix before shipping, a rewrite or let go), each with its "${NEEDS_YOU}" line, then your own recommendation where you have one. Before creating it, list the area's open tasks; if one with that exact title already exists, update its description instead of creating a second.
10. Then archive every child you have not archived yet, post a final message naming that review task's key, and archive yourself (\`bb thread archive --self\`) as your last act. Nothing you started stays open.

You and every child stop and do NOT act if the work would:
${HARD_STOPS}

On any of those, move that task back to Review with its "${NEEDS_YOU}" line naming the limit. That is a complete and correct outcome, not a failure.`;

/** An orchestrator is named for its area, so the map reads as one owner. */
export function orchestratorTitle(area: string) {
  return `${area} orchestrator`;
}
/** The brief plus the work it covers, which is the only part that varies. */
export function orchestratorBrief(
  area: string,
  tasks: readonly { id: string; key: string; title: string }[],
  prefix = "",
) {
  const list = tasks
    .map((task) => `- ${task.key} (${task.id}): ${task.title}`)
    .join("\n");
  const where = prefix ? ` (tracker project ${prefix})` : "";
  return `${ORCHESTRATOR_PROMPT}

Your ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} in ${area}${where}:
${list}

Your review task's title, with the real counts: \`${orchestratorTitle(area)}: N done, M need you\``;
}

/**
 * What the map knows at click time that the task source may not show yet. A
 * dispatch is invisible in Tasks for a moment, and that gap is exactly where a
 * second click starts a second agent on work already handed over.
 */
export type ActionContext = {
  now?: number;
  /** When this session handed each task over, by task id. */
  handedOver?: Readonly<Record<string, number>>;
};
/** How long a handover counts on its own, before the source confirms it. */
export const HANDOVER_GRACE = 180_000;

/** Work an action can actually touch, with the reason when it cannot. */
export function blockedReason(
  item: WorkItem,
  action: QuickAction,
  context: ActionContext = {},
): string | null {
  if (item.kind !== "task" || !item.task)
    return "only tasks can be settled here";
  if (CLOSED.includes(item.task.status)) return "already closed";
  if (action !== "delegate") return null;
  // Dispatch needs a bb project to start the agent in. Saying so here is the
  // difference between a disabled act with a reason and a failed click.
  if (!item.bbProjectId) return "project not linked to a bb project";
  if (hasAgent(item)) return "an agent is already running on it";
  const handedOver = context.handedOver?.[item.task.id];
  if (handedOver && (context.now ?? Date.now()) - handedOver < HANDOVER_GRACE)
    return "just handed to an agent";
  return null;
}
export function eligible(
  item: WorkItem,
  action: QuickAction,
  context: ActionContext = {},
) {
  return blockedReason(item, action, context) === null;
}

export type BulkPlan = {
  take: WorkItem[];
  skip: { item: WorkItem; why: string }[];
};
/** Split a selection into what the action will touch and what it will not. */
export function bulkPlan(
  items: WorkItem[],
  action: QuickAction,
  context: ActionContext = {},
): BulkPlan {
  const plan: BulkPlan = { take: [], skip: [] };
  for (const item of items) {
    const why = blockedReason(item, action, context);
    if (why) plan.skip.push({ item, why });
    else plan.take.push(item);
  }
  return plan;
}

/** The sentence that names the count, so no bulk action runs unnamed. */
export function confirmHeading(action: QuickAction, count: number) {
  const work = `${count} ${count === 1 ? "task" : "tasks"}`;
  return action === "delegate"
    ? `Let agents decide ${work}?`
    : action === "done"
      ? `Mark ${work} done?`
      : `Snooze ${work}?`;
}
/**
 * What the confirmation says beyond the list. Undo is honest about its limit:
 * a settlement can be reversed, an agent that has already read the task cannot.
 */
export function confirmNote(action: QuickAction, area = "", count = 0) {
  return action === "delegate"
    ? `Starts ${orchestratorTitle(area)} for ${count} ${count === 1 ? "task" : "tasks"}. It runs at most ${ORCHESTRATOR_LIMIT} at a time, brings every task to done or back to you with a reason, and leaves you one review task with the summary. Undo cannot unstart an agent that has already begun.`
    : action === "done"
      ? "Closing a task can trigger follow-ups wired outside Work Map, which do not run on cancel. Undo reopens the task here; it cannot recall a follow-up that already fired."
      : "Snoozing keeps the task open and clears it from what needs you. Undo restores it.";
}
