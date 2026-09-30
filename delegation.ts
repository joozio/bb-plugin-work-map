import type { WorkItem } from "./model";
import { isWorking } from "./model";

/** What an expanded area can do to a piece of work without opening it. */
export type QuickAction = "delegate" | "done" | "snooze";
export const ACTION_LABEL: Record<QuickAction, string> = {
  delegate: "Decide on your own",
  done: "Done",
  snooze: "Snooze",
};
/** The comment recorded on the task, in your name, when you hand it over. */
export const DELEGATION_COMMENT = "Delegated: decide on your own";
const CLOSED = ["done", "canceled"];

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
- be irreversible: deleting data, spending money, or anything else that cannot be undone;
- publish or send anything outward in the owner's name, to any person or service;
- need a credential, device or account only the owner has.

In any of those cases, do nothing irreversible, move the task back to Review, and leave one line saying which limit you hit. That is a complete and correct outcome, not a failure.`;

/** Work an action can actually touch, with the reason when it cannot. */
export function blockedReason(
  item: WorkItem,
  action: QuickAction,
): string | null {
  if (item.kind !== "task" || !item.task)
    return "only tasks can be settled here";
  if (CLOSED.includes(item.task.status)) return "already closed";
  if (action === "delegate" && isWorking(item))
    return "an agent is already running on it";
  return null;
}
export function eligible(item: WorkItem, action: QuickAction) {
  return blockedReason(item, action) === null;
}

export type BulkPlan = {
  take: WorkItem[];
  skip: { item: WorkItem; why: string }[];
};
/** Split a selection into what the action will touch and what it will not. */
export function bulkPlan(items: WorkItem[], action: QuickAction): BulkPlan {
  const plan: BulkPlan = { take: [], skip: [] };
  for (const item of items) {
    const why = blockedReason(item, action);
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
export function confirmNote(action: QuickAction) {
  return action === "delegate"
    ? "Each task gets its own agent, which decides and finishes it on its own. Undo stops the task being handed over, but cannot unstart an agent that has already begun."
    : action === "done"
      ? "Closing a task can trigger follow-ups wired outside Work Map, which do not run on cancel. Undo reopens the task here; it cannot recall a follow-up that already fired."
      : "Snoozing keeps the task open and clears it from what needs you. Undo restores it.";
}
