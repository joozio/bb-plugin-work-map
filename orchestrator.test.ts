import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { ORCHESTRATOR_LIMIT } from "./delegation";

type Call = { method: string; input: Record<string, unknown> };
type Spawned = { title?: string; prompt?: string; projectId?: string };

/**
 * One area with three open tasks, its project linked, one dispatch preset, and
 * a spawner that hands back live threads. Everything a test wants to bend
 * (the link, a task's status, whether the spawned orchestrator is still
 * running) is a field, so each case reads as the situation it describes.
 */
async function area(
  options: {
    linked?: string | null;
    statuses?: Record<string, string>;
    missing?: string[];
    threadStatus?: string;
    deleted?: boolean;
    failAttach?: boolean;
    preset?: Record<string, unknown>;
  } = {},
) {
  const calls: Call[] = [];
  const spawned: Spawned[] = [];
  let nextThread = 0;
  const statuses: Record<string, string> = {
    t1: "in_review",
    t2: "todo",
    t3: "in_review",
    ...options.statuses,
  };
  const fake = createFakePluginHost({
    pluginId: "work-map",
    sdk: {
      threads: {
        spawn: async (request: Spawned) => {
          spawned.push(request);
          return { id: `thr_orch${++nextThread}` };
        },
        get: async () => ({
          status: options.threadStatus ?? "active",
          deletedAt: options.deleted ? "2026-10-01T00:00:00Z" : null,
        }),
        output: async () => ({ output: "" }),
      },
      system: { config: async () => ({ primaryHostId: "host_1" }) },
      plugins: {
        callRpc: async ({
          method,
          input: raw,
          outputSchema,
        }: {
          method: string;
          input?: unknown;
          outputSchema: { parse: (value: unknown) => unknown };
        }) => {
          const input = (raw ?? {}) as Record<string, unknown>;
          calls.push({ method, input });
          let value: unknown;
          if (method === "listProjects")
            value = {
              projects: [
                {
                  id: "p1",
                  name: "Test project",
                  prefix: "TEST",
                  linkedBbProjectId:
                    options.linked === undefined ? "proj_bb" : options.linked,
                },
              ],
            };
          else if (method === "listPresets")
            value = {
              presets: [
                {
                  id: "preset1",
                  name: "wiz",
                  providerId: "claude-code",
                  modelId: "test-model",
                  reasoningLevel: "high",
                  serviceTier: null,
                  permissionMode: "full",
                  environmentKind: "project-default",
                  baseBranch: null,
                  machineId: null,
                  ...options.preset,
                },
              ],
            };
          else if (method === "getTask") {
            const id = String(input.taskId);
            value = {
              task: options.missing?.includes(id)
                ? null
                : {
                    id,
                    key: `TEST-${id.slice(1)}`,
                    title: `Task ${id}`,
                    status: statuses[id] ?? "todo",
                    updatedAt: "2026-10-01T00:00:00Z",
                  },
            };
          } else if (method === "taskThreadsAttach") {
            if (options.failAttach) throw new Error("Attach failed");
            value = { threadId: input.threadId };
          } else if (["createComment", "updateTask"].includes(method))
            value = {};
          else throw new Error(`Unexpected ${method}`);
          return outputSchema.parse(value);
        },
      },
    },
  });
  await plugin(fake.bb);
  const dispatch = (input: Record<string, unknown> = {}) =>
    fake.harness.behavior.callRpc("delegateArea", {
      requestId: "11111111-1111-4111-8111-111111111111",
      projectId: "p1",
      taskIds: ["t1", "t2", "t3"],
      ...input,
    });
  return { ...fake, calls, spawned, dispatch, statuses };
}
const ids = (calls: Call[], method: string) =>
  calls.filter((call) => call.method === method).map((call) => call.input.taskId);

describe("handing a whole area to one orchestrator", () => {
  it("starts exactly one thread, named for the area, in its linked project", async () => {
    const { dispatch, spawned, harness } = await area();
    const result = (await dispatch()) as {
      threadId: string;
      title: string;
      preset: string;
      reused: boolean;
      covered: unknown[];
    };
    // Three tasks, one agent: the cap lives inside the brief, not in a queue.
    expect(spawned).toHaveLength(1);
    expect(spawned[0].title).toBe("Test project orchestrator");
    expect(spawned[0].projectId).toBe("proj_bb");
    expect(result).toMatchObject({
      threadId: "thr_orch1",
      title: "Test project orchestrator",
      preset: "wiz",
      reused: false,
    });
    expect(result.covered).toHaveLength(3);
    await harness.lifecycle.dispose();
  });
  it("briefs it with every task it owns and the concurrency limit", async () => {
    const { dispatch, spawned, harness } = await area();
    await dispatch();
    const prompt = spawned[0].prompt ?? "";
    for (const key of ["TEST-1 (t1)", "TEST-2 (t2)", "TEST-3 (t3)"])
      expect(prompt).toContain(key);
    expect(prompt).toContain(
      `at most ${ORCHESTRATOR_LIMIT} children running at once`,
    );
    expect(prompt).toContain("ship in the owner's name or voice");
    await harness.lifecycle.dispose();
  });
  it("records the handover, attaches itself and empties Review", async () => {
    const { dispatch, calls, harness } = await area();
    const result = (await dispatch()) as {
      covered: { taskId: string; movedFrom: string | null; attached: boolean }[];
    };
    expect(ids(calls, "createComment")).toEqual(["t1", "t2", "t3"]);
    expect(
      calls
        .filter((call) => call.method === "createComment")
        .map((call) => call.input.body),
    ).toEqual(
      Array(3).fill(
        "Delegated to the Test project orchestrator: it decides on its own",
      ),
    );
    // Attached to every task it owns: that is what makes the work read as
    // taken on the map before any child thread exists.
    expect(ids(calls, "taskThreadsAttach")).toEqual(["t1", "t2", "t3"]);
    // Every column the work was parked in moves, because Tasks only does that
    // for its own dispatches and this one is not one of them.
    expect(ids(calls, "updateTask")).toEqual(["t1", "t2", "t3"]);
    expect(result.covered.map((row) => row.movedFrom)).toEqual([
      "in_review",
      "todo",
      "in_review",
    ]);
    expect(result.covered.every((row) => row.attached)).toBe(true);
    await harness.lifecycle.dispose();
  });
  it("moves a backlog task it took out of backlog, and leaves in_progress alone", async () => {
    const { dispatch, calls, harness } = await area({
      statuses: { t1: "backlog", t2: "in_progress", t3: "todo" },
    });
    const result = (await dispatch()) as {
      covered: { movedFrom: string | null }[];
    };
    expect(result.covered.map((row) => row.movedFrom)).toEqual([
      "backlog",
      null,
      "todo",
    ]);
    expect(ids(calls, "updateTask")).toEqual(["t1", "t3"]);
    await harness.lifecycle.dispose();
  });
  it("still owns the work when attaching fails, and says so", async () => {
    const { dispatch, harness } = await area({ failAttach: true });
    const result = (await dispatch()) as { covered: { attached: boolean }[] };
    expect(result.covered).toHaveLength(3);
    expect(result.covered.every((row) => row.attached)).toBe(false);
    await harness.lifecycle.dispose();
  });
});

describe("a second click on an area that is already running", () => {
  it("opens the running orchestrator instead of starting another", async () => {
    const { dispatch, spawned, harness } = await area();
    const first = (await dispatch()) as { threadId: string };
    const second = (await dispatch({
      requestId: "22222222-2222-4222-8222-222222222222",
    })) as { threadId: string; reused: boolean };
    expect(spawned).toHaveLength(1);
    expect(second.threadId).toBe(first.threadId);
    expect(second.reused).toBe(true);
    await harness.lifecycle.dispose();
  });
  it("shares one dispatch between two clicks that land together", async () => {
    const { dispatch, spawned, harness } = await area();
    const [first, second] = (await Promise.all([
      dispatch(),
      dispatch({ requestId: "33333333-3333-4333-8333-333333333333" }),
    ])) as { threadId: string }[];
    // This is the twelve-tasks-twice bug: both clicks are one orchestrator.
    expect(spawned).toHaveLength(1);
    expect(second.threadId).toBe(first.threadId);
    await harness.lifecycle.dispose();
  });
  it("replays one request id without dispatching again", async () => {
    const { dispatch, spawned, calls, harness } = await area();
    await dispatch();
    const before = calls.length;
    const again = (await dispatch()) as { reused: boolean };
    expect(spawned).toHaveLength(1);
    expect(again.reused).toBe(false);
    // A replayed receipt touches no task a second time.
    expect(calls.length).toBe(before);
    await harness.lifecycle.dispose();
  });
  it("starts a fresh one once the last orchestrator has finished", async () => {
    const { dispatch, spawned, harness } = await area({ threadStatus: "idle" });
    await dispatch();
    const second = (await dispatch({
      requestId: "44444444-4444-4444-8444-444444444444",
    })) as { threadId: string; reused: boolean };
    expect(spawned).toHaveLength(2);
    expect(second.reused).toBe(false);
    expect(second.threadId).toBe("thr_orch2");
    await harness.lifecycle.dispose();
  });
  it("starts a fresh one when the recorded thread is gone", async () => {
    const { dispatch, spawned, harness } = await area({ deleted: true });
    await dispatch();
    await dispatch({ requestId: "55555555-5555-4555-8555-555555555555" });
    expect(spawned).toHaveLength(2);
    await harness.lifecycle.dispose();
  });
});

describe("what the dispatch refuses to do", () => {
  it("explains an unlinked project instead of failing with a 500", async () => {
    const { dispatch, spawned, harness } = await area({ linked: null });
    await expect(dispatch()).rejects.toThrow(
      /not linked to a bb project.*Link it in Tasks/s,
    );
    expect(spawned).toHaveLength(0);
    await harness.lifecycle.dispose();
  });
  it("leaves out work that closed while the map was on screen", async () => {
    const { dispatch, spawned, calls, harness } = await area({
      statuses: { t2: "done" },
      missing: ["t3"],
    });
    const result = (await dispatch()) as {
      covered: { taskId: string }[];
      dropped: { taskId: string; why: string }[];
    };
    expect(result.covered.map((row) => row.taskId)).toEqual(["t1"]);
    expect(result.dropped).toEqual([
      { taskId: "t2", why: "already closed" },
      { taskId: "t3", why: "no longer exists" },
    ]);
    // The brief names only the work that is really its own.
    expect(spawned[0].prompt).toContain("Your 1 task in Test project:");
    expect(ids(calls, "createComment")).toEqual(["t1"]);
    await harness.lifecycle.dispose();
  });
  it("starts nothing when every task in the selection has closed", async () => {
    const { dispatch, spawned, harness } = await area({
      statuses: { t1: "done", t2: "canceled", t3: "done" },
    });
    await expect(dispatch()).rejects.toThrow("None of these tasks is still open");
    expect(spawned).toHaveLength(0);
    await harness.lifecycle.dispose();
  });
  it("names the preset when it cannot say what to run an orchestrator on", async () => {
    const { dispatch, harness } = await area({ preset: { modelId: undefined } });
    await expect(dispatch()).rejects.toThrow(
      /Preset "wiz" does not say what to run an orchestrator on/,
    );
    await harness.lifecycle.dispose();
  });
});
