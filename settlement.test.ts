import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { describeTask, buildMap } from "./model";
import { handoffDescription } from "./settlement";
import { settleInput } from "./settlement-contract";
import { data, task } from "./fixtures";
import type { Settlement } from "./settlement-contract";

const id = "1789650000000-bdc50aee-584d-42db-9406-9199ad461c1a";
const original = {
  id: "task1",
  projectId: "p1",
  key: "TEST-1",
  title: "Review proposal",
  status: "in_progress",
  updatedAt: "2026-09-17T10:00:00.000Z",
  labelIds: ["important"],
  priority: "high",
  dueDate: "2026-10-01",
  description:
    "**STATE 2026-09-17 10:00 UTC · Drafting proposal**\nLIFECYCLE: in_progress\nNATIVE STATUS: in_progress\nOWNER: alex\nNEXT ACTION: Review draft\nREVIEWER: none\nWAITING: none\nPROGRESS: 2026-09-17 | Drafting in session\nDATE KIND: external\nDATE SOURCE: Agreed delivery date\nSTATUS REASON: Draft underway\n\nNext steps:\n1. Check sources\n\nResources:\nhttps://example.test/source\n\n──────────── log ────────────\nEarlier decisions stay here.",
};
async function setup(
  options: {
    children?: boolean;
    fork?: boolean;
    archiveFails?: boolean;
    lostArchiveResponse?: boolean;
    lostTaskResponse?: boolean;
    alreadyArchived?: boolean;
  } = {},
) {
  let current = structuredClone(original);
  const threads = new Map(
    ["thr_one", "thr_two", "thr_unrelated"].map((id) => [
      id,
      makeThreadResponse({
        id,
        archivedAt: options.alreadyArchived && id === "thr_one" ? 1 : null,
      }),
    ]),
  );
  const patches: Record<string, unknown>[] = [];
  let labels = [{ id: "important", name: "important" }];
  const archive = vi.fn(async ({ threadId }: { threadId: string }) => {
    if (options.archiveFails) throw new Error("Archive service unavailable");
    threads.get(threadId)!.archivedAt = Date.now();
    if (options.lostArchiveResponse) throw new Error("Archive response lost");
    return { ok: true as const, archivedThreadIds: [threadId] };
  });
  const unarchive = vi.fn(async ({ threadId }: { threadId: string }) => {
    threads.get(threadId)!.archivedAt = null;
    return { ok: true as const };
  });
  const fake = createFakePluginHost({
    pluginId: "work-map",
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread)
            throw Object.assign(new Error("Thread not found"), { status: 404 });
          return thread;
        },
        archive,
        unarchive,
        childSummary: async () => ({
          nonDeletedChildCount: options.children ? 1 : 0,
        }),
        list: async () =>
          options.fork ? [makeThreadResponse({ id: "thr_fork" })] : [],
      },
      plugins: {
        callRpc: async ({ method, input, outputSchema }) => {
          const values = input as Record<string, unknown>;
          if (method === "getTask")
            return outputSchema.parse({ task: current });
          if (method === "listTaskThreads")
            return outputSchema.parse({
              taskThreads: [{ threadId: "thr_one" }, { threadId: "thr_two" }],
            });
          if (method === "listLabels") return outputSchema.parse({ labels });
          if (method === "createLabel") {
            labels = [...labels, { id: "waiting", name: "waiting" }];
            return outputSchema.parse({ label: labels.at(-1) });
          }
          if (method === "updateTask") {
            patches.push(values);
            current = {
              ...current,
              ...values,
              updatedAt: new Date(Date.now() + patches.length).toISOString(),
            };
            if (options.lostTaskResponse && patches.length === 1)
              throw new Error("Task response lost");
            return outputSchema.parse({ ok: true, task: current });
          }
          throw new Error(`Unexpected ${method}`);
        },
      },
    },
  });
  await plugin(fake.bb);
  const settle = (patch = {}) =>
    fake.harness.behavior.callRpc("settle", {
      id,
      action: "review",
      taskId: "task1",
      threadId: "thr_one",
      expectedUpdatedAt: original.updatedAt,
      ...patch,
    }) as Promise<Settlement>;
  const undo = () =>
    fake.harness.behavior.callRpc("undoSettlement", {
      id,
    }) as Promise<Settlement>;
  return {
    ...fake,
    settle,
    undo,
    archive,
    unarchive,
    threads,
    patches,
    current: () => current,
    edit: (patch: Partial<typeof original>) => {
      current = { ...current, ...patch };
    },
  };
}

describe("settling user work", () => {
  it("keeps lifecycle metadata above resources and logs, with native parity and literal reviewer text", () => {
    for (const action of ["review", "done"] as const) {
      const input = settleInput.parse({ id, action, taskId: "task1" });
      const output = handoffDescription(
        original.description,
        input,
        Date.now(),
      );
      const head = output.split("Next steps:")[0];
      const state = action === "done" ? "done" : "in_review";
      expect(head).toContain(`LIFECYCLE: ${state}`);
      expect(head).toContain(`NATIVE STATUS: ${state}`);
      expect(head).toContain(
        `REVIEWER: ${action === "done" ? "none" : "alex"}`,
      );
      expect(head).toContain("CHECK AFTER: none");
      expect(head).toContain("STATUS REASON: USER STEERING |");
      expect(output).toContain("Previous status reason: Draft underway");
      expect(output.split("──────────── log ────────────")).toHaveLength(2);
      expect(output).toContain(
        original.description.slice(original.description.indexOf("Next steps:")),
      );
    }
    const name = "Sam $& $'";
    const output = handoffDescription(
      original.description,
      settleInput.parse({
        id,
        action: "review",
        taskId: "task1",
        reviewBy: "other",
        reviewer: name,
        checkAfter: "2026-10-02",
      }),
      Date.now(),
    );
    const head = output.split("Next steps:")[0];
    expect(head).toContain(`Waiting for ${name} to review.`);
    expect(head).toContain(`WAITING: ${name} | review | review received`);
    expect(head).toContain("NEXT ACTION: none");
    expect(head).toContain("NATIVE STATUS: todo");
  });
  it("does not rewrite the task for an unchanged pause and retains the pause receipt", async () => {
    const f = await setup();
    const result = await f.settle({
      action: "pause",
      nextAction: "Review draft",
      threadId: undefined,
    });
    expect(f.patches).toHaveLength(0);
    expect(f.current().description).toBe(original.description);
    expect(result).toMatchObject({
      taskUpdated: false,
      archivedThreadIds: [],
      warning: null,
    });
    expect(await f.harness.behavior.callRpc("settledToday", null)).toEqual([
      result,
    ]);
    await f.harness.lifecycle.dispose();
  });
  it("moves only the task and viewed session, preserves history, and restores them with Undo", async () => {
    const f = await setup();
    const result = await f.settle({
      nextAction: "Check the draft's conclusions",
    });
    expect(result).toMatchObject({
      taskUpdated: true,
      archivedThreadIds: ["thr_one"],
      warning: null,
    });
    expect(f.current()).toMatchObject({
      status: "in_review",
      priority: "high",
      dueDate: original.dueDate,
      labelIds: ["important"],
    });
    expect(f.current().description).toContain(
      "Resources:\nhttps://example.test/source",
    );
    expect(f.current().description).toContain("Earlier decisions stay here.");
    expect(describeTask(f.current().description).nextAction).toBe(
      "Check the draft's conclusions",
    );
    expect(f.patches[0].authorName).toBe("You");
    expect(f.threads.get("thr_two")!.archivedAt).toBeNull();
    expect(await f.harness.behavior.callRpc("settledToday", null)).toEqual([
      result,
    ]);
    await f.undo();
    expect(f.current()).toMatchObject({
      status: original.status,
      description: original.description,
      labelIds: original.labelIds,
    });
    expect(f.unarchive).toHaveBeenCalledExactlyOnceWith({
      threadId: "thr_one",
    });
    expect(await f.harness.behavior.callRpc("settledToday", null)).toEqual([]);
    await f.harness.lifecycle.dispose();
  });
  it("keeps external review open and quiet until its follow-up, without changing the due date", async () => {
    const f = await setup();
    await f.settle({
      reviewBy: "other",
      reviewer: "Sam",
      checkAfter: "2026-10-02",
      threadId: undefined,
    });
    expect(f.current()).toMatchObject({
      status: "todo",
      labelIds: ["important", "waiting"],
      dueDate: original.dueDate,
    });
    const t = task({
      ...f.current(),
      ...describeTask(f.current().description),
    });
    expect(
      buildMap(data([t]), [], {}, new Date("2026-10-01T12:00:00").getTime())[0]
        .children[0],
    ).toMatchObject({ signal: "inactive", reason: "Waiting on Sam" });
    expect(
      buildMap(data([t]), [], {}, new Date("2026-10-02T12:00:00").getTime())[0]
        .children[0],
    ).toMatchObject({ signal: "waiting", reason: "Follow-up due" });
    await f.harness.lifecycle.dispose();
  });
  it("pauses a session without closing its task, and makes done explicit", async () => {
    const f = await setup();
    await f.settle({
      action: "pause",
      nextAction: "Resume with the final numbers",
    });
    expect(f.current().status).toBe("in_progress");
    expect(f.current().description.split("Next steps:")[0]).toContain(
      "STATUS REASON: Draft underway",
    );
    expect(describeTask(f.current().description).nextAction).toBe(
      "Resume with the final numbers",
    );
    await f.undo();
    await f.settle({
      action: "done",
      id: id.replace("0000-", "0001-"),
      expectedUpdatedAt: f.current().updatedAt,
    });
    expect(f.current().status).toBe("done");
    expect(describeTask(f.current().description).nextAction).toBe("");
    await f.harness.lifecycle.dispose();
  });
  it.each([{ children: true }, { fork: true }])(
    "keeps sessions open when BB archive would cascade: %s",
    async (options) => {
      const f = await setup(options);
      const result = await f.settle();
      expect(result.taskUpdated).toBe(true);
      expect(result.warning).toContain("child sessions");
      expect(f.archive).not.toHaveBeenCalled();
      await f.undo();
      expect(f.unarchive).not.toHaveBeenCalled();
      await f.harness.lifecycle.dispose();
    },
  );
  it("archives standalone sessions without task writes, and deduplicates simultaneous submissions", async () => {
    const f = await setup();
    const input = {
      action: "archive",
      taskId: undefined,
      expectedUpdatedAt: undefined,
    };
    const [first, second] = await Promise.all([
      f.settle(input),
      f.settle(input),
    ]);
    expect(first).toEqual(second);
    expect(first.taskUpdated).toBe(false);
    expect(f.patches).toHaveLength(0);
    expect(f.archive).toHaveBeenCalledOnce();
    await expect(f.settle()).rejects.toThrow("different request");
    await f.harness.lifecycle.dispose();
  });
  it("rejects changed tasks and unrelated sessions before writing", async () => {
    const f = await setup();
    await expect(f.settle({ threadId: "thr_unrelated" })).rejects.toThrow(
      "not attached",
    );
    f.edit({ updatedAt: "2026-09-17T11:00:00.000Z" });
    await expect(f.settle()).rejects.toThrow("changed since");
    expect(f.patches).toHaveLength(0);
    expect(f.archive).not.toHaveBeenCalled();
    await f.harness.lifecycle.dispose();
  });
  it("refuses to undo over newer task content, but preserves unrelated edits", async () => {
    const f = await setup();
    await f.settle();
    const after = f.current().description;
    f.edit({ description: "Someone added new work" });
    await expect(f.undo()).rejects.toThrow("newer work");
    expect(f.unarchive).not.toHaveBeenCalled();
    f.edit({ description: after, priority: "urgent" });
    await f.undo();
    expect(f.current().priority).toBe("urgent");
    await f.harness.lifecycle.dispose();
  });
  it("reports partial success when archiving fails and keeps task Undo available", async () => {
    const f = await setup({ archiveFails: true });
    expect(await f.settle()).toMatchObject({
      taskUpdated: true,
      archivedThreadIds: [],
      warning: "Archive service unavailable",
    });
    await f.undo();
    expect(f.current().status).toBe(original.status);
    await f.harness.lifecycle.dispose();
  });
  it.each([{ lostTaskResponse: true }, { lostArchiveResponse: true }])(
    "recovers applied mutations after lost responses: %s",
    async (options) => {
      const f = await setup(options);
      const result = await f.settle();
      expect(result.taskUpdated).toBe(true);
      expect(result.warning).toContain("response lost");
      await f.undo();
      expect(f.current().description).toBe(original.description);
      expect(f.threads.get("thr_one")!.archivedAt).toBeNull();
      await f.harness.lifecycle.dispose();
    },
  );
  it("never reopens a session that was archived before the action", async () => {
    const f = await setup({ alreadyArchived: true });
    await f.settle();
    await f.undo();
    expect(f.archive).not.toHaveBeenCalled();
    expect(f.unarchive).not.toHaveBeenCalled();
    expect(f.threads.get("thr_one")!.archivedAt).toBe(1);
    await f.harness.lifecycle.dispose();
  });
  it("allows the same action to retry after a stale snapshot is refreshed", async () => {
    const f = await setup();
    f.edit({ updatedAt: "2026-09-17T11:00:00.000Z" });
    await expect(f.settle()).rejects.toThrow("changed since");
    const result = await f.settle({ expectedUpdatedAt: f.current().updatedAt });
    expect(result.taskUpdated).toBe(true);
    expect(
      await f.settle({ expectedUpdatedAt: f.current().updatedAt }),
    ).toEqual(result);
    expect(f.patches).toHaveLength(1);
    await f.harness.lifecycle.dispose();
  });
  it("finishes Undo with an explicit warning if a session was subsequently deleted", async () => {
    const f = await setup();
    await f.settle();
    f.threads.delete("thr_one");
    const result = await f.undo();
    expect(result).toMatchObject({ undone: true });
    expect(result.warning).toContain("deleted session");
    expect(f.current().description).toBe(original.description);
    expect(await f.harness.behavior.callRpc("settledToday", null)).toEqual([]);
    await f.harness.lifecycle.dispose();
  });
});
