import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { describeTask, localDay } from "./model";
import type { Settlement, SettleInput } from "./settlement-contract";

const taskState = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.string(),
  description: z.string(),
  labelIds: z.array(z.string()),
  updatedAt: z.string(),
});
type TaskState = z.infer<typeof taskState>;
type Patch = Pick<TaskState, "status" | "description" | "labelIds">;
type Receipt = {
  result: Settlement;
  before: TaskState | null;
  after: Patch | null;
  signature: string;
  threadWasArchived: boolean;
  archiveAttempted: boolean;
  finished: boolean;
  undoTask: boolean;
  undoThreads: string[];
};
const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
const equal = (task: TaskState, patch: Patch) =>
  task.status === patch.status &&
  task.description === patch.description &&
  [...task.labelIds].sort().join() === [...patch.labelIds].sort().join();

export function handoffDescription(
  description: string,
  input: SettleInput,
  at: number,
) {
  const split = description.search(
    /^[ \t]*(?:─+[ \t]*log[ \t]*─+|---|(?:#+[ \t]+)?(?:History|Next steps|Resources):?)[ \t]*$/im,
  );
  let head = split < 0 ? description : description.slice(0, split);
  const tail = split < 0 ? "" : description.slice(split);
  const oldState = head.match(/^\*{0,2}STATE\b.*$/m)?.[0];
  const summary =
    input.action === "done"
      ? "Marked done in Work Map."
      : input.action === "review"
        ? input.reviewBy === "other"
          ? `Waiting for ${tidy(input.reviewer)} to review.`
          : "Ready for your review."
        : describeTask(description).summary || "Task remains open.";
  const stamp = `${localDay(at)} ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(at)}`;
  const state = `**STATE ${stamp} · ${summary}**`;
  head = oldState ? head.replace(oldState, () => state) : `${state}\n${head}`;
  const field = (name: string) =>
    head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "mi"))?.[1]?.trim();
  const oldReason = field("STATUS REASON");
  const set = (name: string, value: string) => {
    const pattern = new RegExp(`^${name}:.*$`, "mi");
    head = pattern.test(head)
      ? head.replace(pattern, () => `${name}: ${value}`)
      : `${head.trimEnd()}\n${name}: ${value}\n`;
  };
  const waiting = input.action === "review" && input.reviewBy === "other";
  if (
    input.action === "pause" &&
    field("LIFECYCLE") === "waiting" &&
    tidy(input.nextAction)
  )
    throw new Error(
      "This task is waiting on someone else. Leave Next step empty to keep it waiting, or change its status in Tasks before resuming work.",
    );
  set(
    "NEXT ACTION",
    input.action === "done" || waiting
      ? "none"
      : tidy(input.nextAction) ||
          (input.action === "review"
            ? "Review the work."
            : describeTask(description).nextAction || "Resume this task."),
  );
  if (input.action !== "pause") {
    set(
      "LIFECYCLE",
      input.action === "done" ? "done" : waiting ? "waiting" : "in_review",
    );
    set(
      "NATIVE STATUS",
      input.action === "done" ? "done" : waiting ? "todo" : "in_review",
    );
    set(
      "REVIEWER",
      input.action === "review" && !waiting ? field("OWNER") || "me" : "none",
    );
    set(
      "WAITING",
      waiting
        ? `${tidy(input.reviewer)} | ${tidy(input.nextAction) || "review"} | review received`
        : "none",
    );
    set("CHECK AFTER", waiting ? input.checkAfter! : "none");
  }
  if (input.action !== "pause")
    set(
      "STATUS REASON",
      `USER STEERING | ${localDay(at)} | Work Map: ${input.action === "review" ? `review by ${input.reviewBy === "me" ? "me" : tidy(input.reviewer)}` : input.action}`,
    );
  const hasLog = /^(?:─+[ \t]*log[ \t]*─+|---)[ \t]*$/m.test(tail);
  return `${head.trimEnd()}\n\n${tail}${tail ? "\n\n" : ""}${hasLog ? "" : "──────────── log ────────────\n"}Work Map · ${stamp} · User chose ${input.action === "review" ? `review by ${input.reviewBy === "me" ? "me" : tidy(input.reviewer)}` : input.action}.${input.threadId ? ` Session: ${input.threadId}.` : ""}${oldState ? `\nPrevious state: ${oldState}` : ""}${input.action !== "pause" && oldReason ? `\nPrevious status reason: ${oldReason}` : ""}`;
}

export function settlementService(bb: BbPluginApi, changed: () => void) {
  const call = <T>(
    method: string,
    input: unknown,
    outputSchema: z.ZodType<T>,
  ) =>
    bb.sdk.plugins.callRpc({
      pluginId: "tasks",
      method,
      input: input as never,
      outputSchema,
    });
  const read = async (taskId: string) => {
    const { task } = await call(
      "getTask",
      { taskId },
      z.object({ task: taskState.nullable() }),
    );
    if (!task) throw new Error("This task no longer exists.");
    return task;
  };
  const update = async (taskId: string, patch: Patch) => {
    const result = await call(
      "updateTask",
      { taskId, ...patch, authorName: "You" },
      z.union([
        z.object({ ok: z.literal(true), task: taskState }),
        z.object({
          ok: z.literal(false),
          error: z.object({ message: z.string() }),
        }),
      ]),
    );
    if (!result.ok) throw new Error(result.error.message);
    changed();
    if (!equal(result.task, patch))
      throw new Error(
        "Task changed while saving. Refresh to check its current state.",
      );
    return result.task;
  };
  const save = async (receipt: Receipt) => {
    await bb.storage.kv.set(`settled:${receipt.result.id}`, receipt);
    bb.realtime.publish("settlements-changed", {});
  };
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const job = chain.then(run);
    chain = job.catch(() => undefined);
    return job;
  };
  const archive = async (receipt: Receipt) => {
    const threadId = receipt.result.threadId!;
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.archivedAt !== null) return [];
    // BB's public archive method recursively archives children and hidden forks.
    // Refuse that wider mutation instead of silently stopping other sessions.
    const [children, forks] = await Promise.all([
      bb.sdk.threads.childSummary({ threadId }),
      bb.sdk.threads.list({
        sourceThreadId: threadId,
        includeHidden: true,
        limit: 1,
      }),
    ]);
    if (children.nonDeletedChildCount || forks.length)
      throw new Error(
        "Session kept open: BB archives child sessions too. Manage this session in BB to choose what to close.",
      );
    receipt.archiveAttempted = true;
    await save(receipt);
    const result = await bb.sdk.threads.archive({ threadId });
    changed();
    return result.archivedThreadIds;
  };
  const reconcile = async (receipt: Receipt) => {
    const { result, after, before } = receipt;
    if (before && after && !result.taskUpdated)
      result.taskUpdated = equal(await read(before.id), after);
    if (
      receipt.archiveAttempted &&
      !receipt.threadWasArchived &&
      !result.archivedThreadIds.length &&
      result.threadId
    ) {
      const thread = await bb.sdk.threads.get({ threadId: result.threadId });
      if (
        thread.archivedAt !== null &&
        new Date(thread.archivedAt).getTime() >= result.at
      ) {
        // The response can be lost after BB has archived the guarded leaf.
        result.archivedThreadIds = [result.threadId];
      }
    }
  };
  const finish = async (receipt: Receipt) => {
    const { result, before, after } = receipt;
    await reconcile(receipt);
    try {
      if (before && after && !result.taskUpdated) {
        const current = await read(before.id);
        if (current.updatedAt !== before.updatedAt || !equal(current, before))
          throw new Error(
            "The task changed before this action completed. Refresh and check its current state.",
          );
        await update(before.id, after);
        result.taskUpdated = true;
        await save(receipt);
      }
      if (
        result.threadId &&
        !receipt.threadWasArchived &&
        !result.archivedThreadIds.length
      )
        result.archivedThreadIds = await archive(receipt);
      result.warning = null;
    } catch (cause) {
      result.warning = cause instanceof Error ? cause.message : String(cause);
      await reconcile(receipt);
    }
    receipt.finished = true;
    await save(receipt);
    // Bound private before/after snapshots. Retain pending receipts for recovery.
    const keys = (await bb.storage.kv.list("settled:")).sort().reverse();
    for (const key of keys.slice(200)) {
      const old = await bb.storage.kv.get<Receipt>(key);
      if (old?.finished) await bb.storage.kv.delete(key);
    }
    changed();
    return result;
  };
  return {
    settledToday: async () => {
      const keys = (await bb.storage.kv.list("settled:"))
        .sort()
        .reverse()
        .slice(0, 200);
      const rows = await Promise.all(
        keys.map((key) => bb.storage.kv.get<Receipt>(key)),
      );
      for (const row of rows)
        if (row && !row.finished) {
          try {
            await reconcile(row);
          } catch (cause) {
            row.result.warning = `Recovery unavailable: ${cause instanceof Error ? cause.message : String(cause)}`;
          }
        }
      return rows
        .filter(
          (r): r is Receipt =>
            !!r &&
            localDay(r.result.at) === localDay(Date.now()) &&
            !r.result.undone &&
            (r.result.taskUpdated ||
              r.result.archivedThreadIds.length > 0 ||
              (r.finished && r.result.action === "pause" && !r.result.warning)),
        )
        .map((r) => r.result)
        .sort((a, b) => b.at - a.at);
    },
    settle: (input: SettleInput) =>
      serial(async () => {
        const { expectedUpdatedAt: _expected, ...intent } = input;
        const signature = JSON.stringify(intent);
        const prior = await bb.storage.kv.get<Receipt>(`settled:${input.id}`);
        if (prior) {
          if (prior.signature !== signature)
            throw new Error(
              "This action belongs to a different request. Start a new action.",
            );
          return prior.finished ? prior.result : finish(prior);
        }
        const before = input.taskId ? await read(input.taskId) : null;
        if (before && ["done", "canceled"].includes(before.status))
          throw new Error("This task is already closed. Refresh the map.");
        if (
          before &&
          input.expectedUpdatedAt &&
          before.updatedAt !== input.expectedUpdatedAt
        )
          throw new Error(
            "This task changed since you opened it. Refresh before settling it.",
          );
        let title = before ? `${before.key} · ${before.title}` : "Session";
        let threadWasArchived = false;
        if (input.threadId) {
          const thread = await bb.sdk.threads.get({ threadId: input.threadId });
          if (thread.deletedAt !== null)
            throw new Error(
              "This session has been deleted. Settle the task without archiving a session.",
            );
          threadWasArchived = thread.archivedAt !== null;
          if (!before)
            title = thread.title ?? thread.titleFallback ?? "Session";
          if (before) {
            const links = await call(
              "listTaskThreads",
              { taskId: before.id },
              z.object({
                taskThreads: z.array(z.object({ threadId: z.string() })),
              }),
            );
            if (
              !links.taskThreads.some(
                (link) => link.threadId === input.threadId,
              )
            )
              throw new Error(
                "This session is not attached to this task. Choose an attached session or settle the task on its own.",
              );
          }
        }
        const at = Date.now();
        let after: Patch | null = null;
        if (before) {
          let labelIds = before.labelIds;
          if (input.action !== "pause") {
            const schema = z.object({ id: z.string(), name: z.string() });
            const { labels } = await call(
              "listLabels",
              { projectId: before.projectId },
              z.object({ labels: z.array(schema) }),
            );
            let waiting = labels.find(
              (label) => label.name.toLowerCase() === "waiting",
            );
            if (
              input.action === "review" &&
              input.reviewBy === "other" &&
              !waiting
            ) {
              waiting = (
                await call(
                  "createLabel",
                  {
                    projectId: before.projectId,
                    name: "waiting",
                    color: "#91b9df",
                  },
                  z.object({ label: schema }),
                )
              ).label;
            }
            labelIds = before.labelIds.filter((id) => id !== waiting?.id);
            if (input.action === "review" && input.reviewBy === "other")
              labelIds = [...labelIds, waiting!.id];
          }
          if (
            input.action !== "pause" ||
            tidy(input.nextAction) !==
              describeTask(before.description).nextAction
          )
            after = {
              status:
                input.action === "done"
                  ? "done"
                  : input.action === "review"
                    ? input.reviewBy === "other"
                      ? "todo"
                      : "in_review"
                    : before.status,
              description: handoffDescription(before.description, input, at),
              labelIds,
            };
          const latest = await read(before.id);
          if (latest.updatedAt !== before.updatedAt || !equal(latest, before))
            throw new Error(
              "This task changed while preparing the handoff. Refresh and try again.",
            );
        }
        const result: Settlement = {
          id: input.id,
          at,
          title,
          action: input.action,
          taskId: before?.id ?? null,
          taskKey: before?.key ?? null,
          threadId: input.threadId ?? null,
          nextAction:
            after || before
              ? describeTask(after?.description ?? before!.description)
                  .nextAction
              : "",
          reviewer:
            input.action === "review" && input.reviewBy === "other"
              ? tidy(input.reviewer)
              : "",
          checkAfter:
            input.action === "review" && input.reviewBy === "other"
              ? input.checkAfter!
              : null,
          taskUpdated: false,
          archivedThreadIds: [],
          undone: false,
          warning: null,
        };
        const receipt: Receipt = {
          result,
          before,
          after,
          signature,
          threadWasArchived,
          archiveAttempted: false,
          finished: false,
          undoTask: false,
          undoThreads: [],
        };
        await save(receipt); // A durable undo record must exist before any mutation.
        return finish(receipt);
      }),
    undoSettlement: ({ id }: { id: string }) =>
      serial(async () => {
        const receipt = await bb.storage.kv.get<Receipt>(`settled:${id}`);
        if (!receipt) throw new Error("This undo is no longer available.");
        const { result, before, after } = receipt;
        if (result.undone) return result;
        await reconcile(receipt);
        // Recover a lost response after a successful task write before deciding what to undo.
        if (before && after && !receipt.undoTask) {
          const current = await read(before.id);
          if (equal(current, after)) {
            await update(before.id, {
              status: before.status,
              description: before.description,
              labelIds: before.labelIds,
            });
            receipt.undoTask = true;
          } else if (equal(current, before)) receipt.undoTask = true;
          else
            throw new Error(
              "The task has changed since this action. Undo will not overwrite newer work; open the task to adjust it.",
            );
          await save(receipt);
        }
        const missing: string[] = [];
        for (const threadId of result.archivedThreadIds) {
          if (receipt.undoThreads.includes(threadId)) continue;
          try {
            const thread = await bb.sdk.threads.get({ threadId });
            if (thread.deletedAt !== null) missing.push(threadId);
            else if (thread.archivedAt !== null)
              await bb.sdk.threads.unarchive({ threadId });
          } catch (cause) {
            if (
              (cause as { status?: number })?.status === 404 ||
              (cause instanceof Error &&
                /^Thread not found/i.test(cause.message))
            )
              missing.push(threadId);
            else
              throw new Error(
                `${receipt.undoTask ? "Task restored. " : ""}Could not reopen ${threadId}. Retry Undo: ${cause instanceof Error ? cause.message : String(cause)}`,
              );
          }
          receipt.undoThreads.push(threadId);
          await save(receipt);
        }
        result.undone = true;
        result.warning = missing.length
          ? `${result.taskUpdated ? "Task changes undone. " : ""}${missing.length} deleted session(s) could not be restored.`
          : null;
        await save(receipt);
        changed();
        return result;
      }),
  };
}
