import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { delegateAreaInput, delegationService } from "./delegate-service";
import {
  DELEGATION_COMMENT,
  DELEGATION_PROMPT,
  delegationNote,
} from "./delegation";

type Call = { method: string; input: Record<string, unknown> };
type Task = {
  id: string;
  key: string;
  title: string;
  status: string;
  updatedAt: string;
};
type Rpc = (input: Record<string, unknown>) => unknown;

const requestId = "22222222-2222-4222-8222-222222222222";
const otherRequest = "33333333-3333-4333-8333-333333333333";
const preset = {
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
};

/**
 * The service on a hand-built `bb`: an in-memory kv, Tasks RPCs answered from
 * plain records, and a thread spawner. Each case bends one field (a task's
 * status, a failing RPC, a kv that refuses writes) so it reads as the
 * situation it describes, and a second service on the same kv stands in for
 * a restarted server.
 */
function host(
  options: {
    tasks?: Record<string, Task | null>;
    presets?: Record<string, unknown>[];
    rpc?: Record<string, Rpc>;
    primaryHostId?: string | null;
    threadStatus?: string;
    failKvSet?: boolean;
    failKvList?: boolean;
  } = {},
) {
  const kv = new Map<string, unknown>();
  const calls: Call[] = [];
  const spawned: Record<string, unknown>[] = [];
  const tasks: Record<string, Task | null> = {
    t1: {
      id: "t1",
      key: "TEST-1",
      title: "Pick a direction",
      status: "in_review",
      updatedAt: "2026-10-01T00:00:00Z",
    },
    ...options.tasks,
  };
  const rpc: Record<string, Rpc> = {
    listPresets: () => ({ presets: options.presets ?? [preset] }),
    getTask: ({ taskId }) => ({ task: tasks[String(taskId)] ?? null }),
    createComment: () => ({}),
    updateTask: () => ({}),
    delegate: () => ({ threadId: "thr_agent1" }),
    taskThreadsAttach: () => ({}),
    listProjects: () => ({
      projects: [
        {
          id: "p1",
          name: "Test project",
          prefix: "TEST",
          linkedBbProjectId: "proj_bb",
        },
      ],
    }),
    ...options.rpc,
  };
  let nextThread = 0;
  const bb = {
    sdk: {
      plugins: {
        callRpc: async ({
          method,
          input,
          outputSchema,
        }: {
          method: string;
          input?: unknown;
          outputSchema: { parse: (value: unknown) => unknown };
        }) => {
          const fields = (input ?? {}) as Record<string, unknown>;
          calls.push({ method, input: fields });
          if (!rpc[method]) throw new Error(`Unexpected ${method}`);
          return outputSchema.parse(await rpc[method](fields));
        },
      },
      threads: {
        get: async () => ({
          status: options.threadStatus ?? "active",
          deletedAt: null,
        }),
        spawn: async (request: Record<string, unknown>) => {
          spawned.push(request);
          return { id: `thr_orch${++nextThread}` };
        },
      },
      system: {
        config: async () => ({
          primaryHostId:
            options.primaryHostId === undefined
              ? "host_1"
              : options.primaryHostId,
        }),
      },
    },
    storage: {
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => {
          if (options.failKvSet) throw new Error("kv unavailable");
          kv.set(key, structuredClone(value));
        },
        delete: async (key: string) => void kv.delete(key),
        list: async (prefix = "") => {
          if (options.failKvList) throw new Error("kv unavailable");
          return [...kv.keys()].filter((key) => key.startsWith(prefix));
        },
      },
    },
  } as unknown as BbPluginApi;
  const changed = vi.fn();
  const service = () => delegationService(bb, changed);
  const methods = (name: string) =>
    calls.filter((call) => call.method === name).map((call) => call.input);
  return { bb, kv, calls, spawned, changed, service, methods };
}

describe("handing one task to an agent", () => {
  it("records the handover, dispatches on the preset and empties Review", async () => {
    const h = host();
    const result = await h.service().delegate({ requestId, taskId: "t1" });
    expect(result).toEqual({
      taskId: "t1",
      taskKey: "TEST-1",
      threadId: "thr_agent1",
      preset: "wiz",
      movedFrom: "in_review",
      commented: true,
    });
    // The comment lands before the dispatch, so the task already says why.
    expect(h.calls.map((call) => call.method)).toEqual([
      "getTask",
      "listPresets",
      "createComment",
      "delegate",
      "updateTask",
    ]);
    expect(h.methods("createComment")[0]).toEqual({
      taskId: "t1",
      body: DELEGATION_COMMENT,
      notify: false,
    });
    expect(h.methods("delegate")[0]).toEqual({
      taskId: "t1",
      presetId: "preset1",
      extraInstructions: DELEGATION_PROMPT,
    });
    expect(h.methods("updateTask")[0]).toEqual({
      taskId: "t1",
      status: "in_progress",
      authorName: "You",
    });
    expect(h.kv.get(`delegated:${requestId}`)).toEqual(result);
    expect(h.changed).toHaveBeenCalledOnce();
  });

  it("carries a typed note, trimmed, on the comment and inside the brief", async () => {
    const h = host();
    await h.service().delegate({
      requestId,
      taskId: "t1",
      note: "  Prefer the cheaper option.  ",
    });
    expect(h.methods("createComment")[0].body).toBe(
      `${DELEGATION_COMMENT}\n\nPrefer the cheaper option.`,
    );
    expect(h.methods("delegate")[0].extraInstructions).toBe(
      `${DELEGATION_PROMPT}\n\n${delegationNote("Prefer the cheaper option.")}`,
    );
  });

  it("leaves backlog and todo for Tasks to move, as its dispatch does", async () => {
    for (const status of ["backlog", "todo", "in_progress"]) {
      const h = host({
        tasks: {
          t1: {
            id: "t1",
            key: "TEST-1",
            title: "Pick",
            status,
            updatedAt: "2026-10-01T00:00:00Z",
          },
        },
      });
      const result = await h.service().delegate({ requestId, taskId: "t1" });
      expect(result.movedFrom).toBeNull();
      expect(h.methods("updateTask")).toEqual([]);
    }
  });

  it("starts one agent for two clicks that land together", async () => {
    const h = host();
    const service = h.service();
    const [first, second] = await Promise.all([
      service.delegate({ requestId, taskId: "t1" }),
      service.delegate({ requestId, taskId: "t1" }),
    ]);
    expect(second).toBe(first);
    expect(h.methods("delegate")).toHaveLength(1);
  });

  it("replays a request id after a restart from its stored receipt", async () => {
    const h = host();
    const first = await h.service().delegate({ requestId, taskId: "t1" });
    h.calls.length = 0;
    const replay = await h.service().delegate({ requestId, taskId: "t1" });
    expect(replay).toEqual(first);
    expect(h.calls).toEqual([]);
  });

  it("refuses a missing, closed or changed task before writing anything", async () => {
    const cases: [Partial<Task> | null, string, string | undefined][] = [
      [null, "no longer exists", undefined],
      [{ status: "done" }, "already closed", undefined],
      [{ status: "canceled" }, "already closed", undefined],
      [{}, "changed since you opened it", "2026-09-30T00:00:00Z"],
    ];
    for (const [patch, message, expectedUpdatedAt] of cases) {
      const h = host({
        tasks: {
          t1: patch && {
            id: "t1",
            key: "TEST-1",
            title: "Pick",
            status: "in_review",
            updatedAt: "2026-10-01T00:00:00Z",
            ...patch,
          },
        },
      });
      await expect(
        h.service().delegate({ requestId, taskId: "t1", expectedUpdatedAt }),
      ).rejects.toThrow(message);
      expect(h.calls.map((call) => call.method)).toEqual(["getTask"]);
      expect(h.kv.size).toBe(0);
      expect(h.changed).not.toHaveBeenCalled();
    }
  });

  it("accepts a snapshot that still matches the task", async () => {
    const h = host();
    const result = await h.service().delegate({
      requestId,
      taskId: "t1",
      expectedUpdatedAt: "2026-10-01T00:00:00Z",
    });
    expect(result.threadId).toBe("thr_agent1");
  });

  it("lets a failed request be retried with the same id", async () => {
    let fail = true;
    const h = host({
      rpc: {
        delegate: () => {
          if (fail) throw new Error("Dispatch unavailable");
          return { threadId: "thr_agent2" };
        },
      },
    });
    const service = h.service();
    await expect(service.delegate({ requestId, taskId: "t1" })).rejects.toThrow(
      "Dispatch unavailable",
    );
    fail = false;
    expect(
      (await service.delegate({ requestId, taskId: "t1" })).threadId,
    ).toBe("thr_agent2");
  });

  it("still dispatches when the comment, the move or the receipt cannot be written", async () => {
    const h = host({
      rpc: {
        createComment: () => {
          throw new Error("Comments offline");
        },
        updateTask: () => {
          throw new Error("Update rejected");
        },
      },
      failKvSet: true,
    });
    const service = h.service();
    const result = await service.delegate({ requestId, taskId: "t1" });
    expect(result).toMatchObject({
      threadId: "thr_agent1",
      commented: false,
      movedFrom: null,
    });
    // Without a durable receipt the in-memory one still blocks a second agent.
    expect(await service.delegate({ requestId, taskId: "t1" })).toBe(result);
    expect(h.methods("delegate")).toHaveLength(1);
  });

  it("explains a missing preset instead of dispatching", async () => {
    const h = host({ presets: [] });
    await expect(
      h.service().delegate({ requestId, taskId: "t1" }),
    ).rejects.toThrow("No dispatch preset exists");
    expect(h.methods("delegate")).toEqual([]);
  });
});

describe("which preset a handover runs on", () => {
  const named = (name: string, id = name) => ({ ...preset, id, name });

  it("prefers the stored choice, then the worker preset, then the first one", async () => {
    const h = host({ presets: [named("fast"), named("wiz"), named("deep")] });
    expect(await h.service().delegatePreset()).toEqual({ preset: "wiz" });
    h.kv.set("delegate:preset", "deep");
    expect(await h.service().delegatePreset()).toEqual({ preset: "deep" });
    // A stored name that no longer exists falls back rather than failing.
    h.kv.set("delegate:preset", "retired");
    expect(await h.service().delegatePreset()).toEqual({ preset: "wiz" });
    // A stored value of the wrong shape is ignored.
    h.kv.set("delegate:preset", { name: "deep" });
    expect(await h.service().delegatePreset()).toEqual({ preset: "wiz" });
  });

  it("uses whatever exists on an install without the worker preset", async () => {
    const h = host({ presets: [named("fast"), named("deep")] });
    expect(await h.service().delegatePreset()).toEqual({ preset: "fast" });
  });
});

describe("where an area's orchestrator runs", () => {
  const dispatch = (h: ReturnType<typeof host>, input = {}) =>
    h.service().delegateArea({
      requestId,
      projectId: "p1",
      taskIds: ["t1"],
      ...input,
    });

  it("runs in the project's default environment unless the preset says otherwise", async () => {
    for (const environmentKind of [undefined, "project-default"]) {
      const h = host({ presets: [{ ...preset, environmentKind }] });
      await dispatch(h);
      expect(h.spawned[0].environment).toEqual({ type: "project-default" });
      expect(h.spawned[0]).not.toHaveProperty("serviceTier");
    }
  });

  it("makes a worktree on bb's primary machine from the default branch", async () => {
    const h = host({
      presets: [{ ...preset, environmentKind: "managed-worktree" }],
    });
    await dispatch(h);
    expect(h.spawned[0].environment).toEqual({
      type: "host",
      hostId: "host_1",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });
  });

  it("honours the preset's own machine, branch and service tier", async () => {
    const h = host({
      presets: [
        {
          ...preset,
          environmentKind: "managed-worktree",
          machineId: "host_2",
          baseBranch: "release",
          serviceTier: "priority",
        },
      ],
    });
    await dispatch(h);
    expect(h.spawned[0]).toMatchObject({
      environment: {
        type: "host",
        hostId: "host_2",
        workspace: { baseBranch: { kind: "named", name: "release" } },
      },
      serviceTier: "priority",
      providerId: "claude-code",
      model: "test-model",
      reasoningLevel: "high",
      permissionMode: "full",
      projectId: "proj_bb",
      visibility: "visible",
    });
  });

  it("names the preset when there is no machine to make a worktree on", async () => {
    const h = host({
      presets: [{ ...preset, environmentKind: "managed-worktree" }],
      primaryHostId: null,
    });
    await expect(dispatch(h)).rejects.toThrow(
      'Preset "wiz" needs a worktree, and bb has no default machine',
    );
    expect(h.spawned).toEqual([]);
  });
});

describe("what an area dispatch settles before spawning", () => {
  const dispatch = (
    service: ReturnType<ReturnType<typeof host>["service"]>,
    input = {},
  ) =>
    service.delegateArea({
      requestId,
      projectId: "p1",
      taskIds: ["t1"],
      ...input,
    });

  it("explains a task project that was deleted since the map was drawn", async () => {
    const h = host();
    await expect(
      dispatch(h.service(), { projectId: "gone" }),
    ).rejects.toThrow("This task project no longer exists");
    expect(h.spawned).toEqual([]);
  });

  it("drops a task it cannot read and still takes the rest", async () => {
    const h = host({
      rpc: {
        getTask: ({ taskId }) => {
          if (taskId === "t2") throw new Error("Read failed");
          return {
            task: {
              id: "t1",
              key: "TEST-1",
              title: "Pick",
              status: "todo",
              updatedAt: "2026-10-01T00:00:00Z",
            },
          };
        },
      },
    });
    const result = await dispatch(h.service(), { taskIds: ["t1", "t2"] });
    expect(result.dropped).toEqual([
      { taskId: "t2", why: "could not be read" },
    ]);
    expect(result.covered.map((row) => row.taskId)).toEqual(["t1"]);
    expect(h.spawned).toHaveLength(1);
  });

  it("replays a request id after a restart without spawning again", async () => {
    const h = host();
    const first = await dispatch(h.service());
    const replay = await dispatch(h.service());
    expect(replay).toEqual(first);
    expect(h.spawned).toHaveLength(1);
  });

  it("shares one dispatch between two requests for the same area in flight", async () => {
    const h = host();
    const service = h.service();
    const [first, second] = await Promise.all([
      dispatch(service),
      dispatch(service, { requestId: otherRequest }),
    ]);
    expect(second).toBe(first);
    expect(h.spawned).toHaveLength(1);
  });

  it("forgets a failed dispatch so the same request can try again", async () => {
    let fail = true;
    const h = host({
      rpc: {
        listProjects: () => {
          if (fail) throw new Error("Tasks offline");
          return {
            projects: [
              { id: "p1", name: "Test project", linkedBbProjectId: "proj_bb" },
            ],
          };
        },
      },
    });
    const service = h.service();
    await expect(dispatch(service)).rejects.toThrow("Tasks offline");
    fail = false;
    const result = await dispatch(service);
    expect(result.title).toBe("Test project orchestrator");
    // A project without a prefix still briefs the orchestrator.
    expect(String(h.spawned[0].prompt)).toContain("t1");
  });

  it("returns the receipt even when kv refuses to keep it", async () => {
    const h = host({ failKvSet: true });
    const result = await dispatch(h.service());
    expect(result.threadId).toBe("thr_orch1");
    expect(h.changed).toHaveBeenCalledOnce();
  });
});

describe("the orchestrators the map shows on its areas", () => {
  it("lists every recorded orchestrator by area, skipping unreadable rows", async () => {
    const h = host();
    await h.service().delegateArea({
      requestId,
      projectId: "p1",
      taskIds: ["t1"],
    });
    h.kv.set("orchestrator:p9", { threadId: 42 });
    expect(await h.service().liveOrchestrators()).toEqual([
      {
        projectId: "p1",
        threadId: "thr_orch1",
        title: "Test project orchestrator",
      },
    ]);
  });

  it("shows none when storage cannot be listed", async () => {
    const h = host({ failKvList: true });
    expect(await h.service().liveOrchestrators()).toEqual([]);
  });
});

describe("the area dispatch input at the RPC boundary", () => {
  it("refuses an oversized task list on its length alone (GHSA-mrhx-c7xc-m3w5)", () => {
    // Zod before 4.6.6 checked every element of a too-long array first, one
    // issue each: a large request held the host's memory before failing.
    const parsed = delegateAreaInput.safeParse({
      requestId,
      projectId: "p1",
      taskIds: Array.from({ length: 100_000 }, () => ""),
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toHaveLength(1);
    expect(parsed.error?.issues[0].code).toBe("too_big");
  });
});
