import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DELEGATION_COMMENT,
  DELEGATION_PROMPT,
  orchestratorBrief,
  orchestratorComment,
  orchestratorTitle,
} from "./delegation";

/** The worker preset a delegated task runs on, unless a stored choice names another. */
const DEFAULT_PRESET = "wiz";
const PRESET_KEY = "delegate:preset";
/**
 * A preset's execution, as Tasks reports it. Only the id and name are relied
 * on for the single-task path, which Tasks itself dispatches; the rest is what
 * an orchestrator thread has to be spawned with here, so it is read leniently
 * and checked once, where a missing field can still be explained.
 */
const presetSchema = z.object({
  id: z.string(),
  name: z.string(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  reasoningLevel: z.string().optional(),
  serviceTier: z.string().nullable().optional(),
  permissionMode: z.string().optional(),
  environmentKind: z.string().optional(),
  baseBranch: z.string().nullable().optional(),
  machineId: z.string().nullable().optional(),
});
type Preset = z.infer<typeof presetSchema>;
const trackerProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string().optional(),
  linkedBbProjectId: z.string().nullable().optional(),
});
/** An orchestrator the map should show on its area while its thread lives. */
export const liveOrchestratorSchema = z.object({
  projectId: z.string(),
  threadId: z.string(),
  title: z.string(),
});
export type LiveOrchestrator = z.infer<typeof liveOrchestratorSchema>;
const taskState = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string().default(""),
  status: z.string(),
  updatedAt: z.string(),
});
export const delegationSchema = z.object({
  taskId: z.string(),
  taskKey: z.string(),
  threadId: z.string(),
  preset: z.string(),
  /** Set when the task left Review; the map shows where the work went. */
  movedFrom: z.string().nullable(),
  commented: z.boolean(),
});
export type Delegation = z.infer<typeof delegationSchema>;
export const delegateInput = z.object({
  requestId: z.string().uuid(),
  taskId: z.string().min(1),
  expectedUpdatedAt: z.string().optional(),
});
export const areaDelegationSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  preset: z.string(),
  /** True when an orchestrator for this area was already running. */
  reused: z.boolean(),
  covered: z.array(
    z.object({
      taskId: z.string(),
      taskKey: z.string(),
      movedFrom: z.string().nullable(),
      commented: z.boolean(),
      attached: z.boolean(),
    }),
  ),
  /** Work the dispatch left alone after the map was drawn, with the reason. */
  dropped: z.array(z.object({ taskId: z.string(), why: z.string() })),
});
export type AreaDelegation = z.infer<typeof areaDelegationSchema>;
export const delegateAreaInput = z.object({
  requestId: z.string().uuid(),
  /** The task project, never a bb project: its link is read here. */
  projectId: z.string().min(1),
  taskIds: z.array(z.string().min(1)).min(1).max(100),
});
export const delegationContract = {
  delegate: { input: delegateInput, output: delegationSchema },
  delegateArea: { input: delegateAreaInput, output: areaDelegationSchema },
  delegatePreset: { input: z.null(), output: z.object({ preset: z.string() }) },
};

/** Columns an orchestrator's dispatch moves into in_progress, as Tasks does. */
const TAKEN_FROM = ["in_review", "backlog", "todo"];
/** Thread states that mean an orchestrator is still on the work. */
const RUNNING_THREAD = new Set(["pending", "starting", "active", "stopping"]);

export function delegationService(bb: BbPluginApi, changed: () => void) {
  const call = <T>(method: string, input: unknown, output: z.ZodType<T>) =>
    bb.sdk.plugins.callRpc({
      pluginId: "tasks",
      method,
      input: input as never,
      outputSchema: output,
    });
  /**
   * Presets belong to the installation, not to this plugin. Prefer the stored
   * choice, then the documented worker preset, then whatever exists, so a fresh
   * install still delegates instead of failing on a name it never had.
   */
  const resolvePreset = async () => {
    const { presets } = await call(
      "listPresets",
      null,
      z.object({ presets: z.array(z.looseObject(presetSchema.shape)) }),
    );
    if (!presets.length)
      throw new Error(
        "No dispatch preset exists. Create one in Tasks before delegating work.",
      );
    const stored = await bb.storage.kv.get<unknown>(PRESET_KEY);
    const wanted = typeof stored === "string" ? stored : DEFAULT_PRESET;
    return (
      presets.find((preset) => preset.name === wanted) ??
      presets.find((preset) => preset.name === DEFAULT_PRESET) ??
      presets[0]
    );
  };
  const commentOn = async (taskId: string, body: string) => {
    try {
      await call(
        "createComment",
        { taskId, body, notify: false },
        z.looseObject({}),
      );
      return true;
    } catch {
      /* The dispatch itself records the handover in the task's own history. */
      return false;
    }
  };
  /**
   * Tasks moves backlog and todo to in_progress when it dispatches, so the
   * single-task path only has to empty Review, the column the act exists for.
   * An orchestrator is spawned here rather than dispatched by Tasks, so its
   * own work needs the same move, or a task reads backlog while an agent has it.
   */
  const startWork = async (
    task: z.infer<typeof taskState>,
    from: readonly string[],
  ) => {
    if (!from.includes(task.status)) return null;
    const was = task.status;
    try {
      await call(
        "updateTask",
        { taskId: task.id, status: "in_progress", authorName: "You" },
        z.looseObject({}),
      );
      return was;
    } catch {
      /* The agent is running; its own first comment shows the task moved. */
      return null;
    }
  };
  // A repeated click or a retry must never start a second agent on one task.
  const runs = new Map<string, Promise<Delegation>>();
  const run = async (input: z.infer<typeof delegateInput>) => {
    const key = `delegated:${input.requestId}`;
    const stored = await bb.storage.kv.get<Delegation>(key);
    if (stored) return delegationSchema.parse(stored);
    const { task } = await call(
      "getTask",
      { taskId: input.taskId },
      z.object({ task: taskState.nullable() }),
    );
    if (!task) throw new Error("This task no longer exists.");
    if (["done", "canceled"].includes(task.status))
      throw new Error("This task is already closed. Refresh the map.");
    if (input.expectedUpdatedAt && task.updatedAt !== input.expectedUpdatedAt)
      throw new Error(
        "This task changed since you opened it. Refresh before delegating it.",
      );
    const preset = await resolvePreset();
    // Record the handover before dispatch: if the agent starts, the task
    // already says who asked for it and why it stopped waiting on you.
    const commented = await commentOn(task.id, DELEGATION_COMMENT);
    const { threadId } = await call(
      "delegate",
      {
        taskId: task.id,
        presetId: preset.id,
        extraInstructions: DELEGATION_PROMPT,
      },
      z.object({ threadId: z.string() }),
    );
    const movedFrom = await startWork(task, ["in_review"]);
    const result: Delegation = {
      taskId: task.id,
      taskKey: task.key,
      threadId,
      preset: preset.name,
      movedFrom,
      commented,
    };
    try {
      await bb.storage.kv.set(key, result);
    } catch {
      /* The in-memory receipt still prevents a repeat dispatch. */
    }
    changed();
    return result;
  };

  /** Whether a recorded orchestrator is still working on its area. */
  const stillRunning = async (threadId: string) => {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return thread.deletedAt == null && RUNNING_THREAD.has(thread.status);
    } catch {
      // A thread bb can no longer read is no reason to refuse a fresh one.
      return false;
    }
  };
  /** The preset's own environment, so an orchestrator runs where its work does. */
  const environmentFor = async (preset: Preset) => {
    if (!preset.environmentKind || preset.environmentKind === "project-default")
      return { type: "project-default" as const };
    const hostId =
      preset.machineId ?? (await bb.sdk.system.config()).primaryHostId;
    if (!hostId)
      throw new Error(
        `Preset "${preset.name}" needs a worktree, and bb has no default machine to make one on.`,
      );
    return {
      type: "host" as const,
      hostId,
      workspace: {
        type: "managed-worktree" as const,
        baseBranch: preset.baseBranch
          ? { kind: "named" as const, name: preset.baseBranch }
          : { kind: "default" as const },
      },
    };
  };
  const spawnOrchestrator = async (
    preset: Preset,
    bbProjectId: string,
    title: string,
    area: string,
    tasks: z.infer<typeof taskState>[],
    prefix: string,
  ) => {
    const { providerId, modelId, reasoningLevel, permissionMode } = preset;
    if (!providerId || !modelId || !reasoningLevel || !permissionMode)
      throw new Error(
        `Preset "${preset.name}" does not say what to run an orchestrator on. Update it in Tasks, or let agents decide one task at a time.`,
      );
    const thread = await bb.sdk.threads.spawn({
      projectId: bbProjectId,
      environment: await environmentFor(preset),
      providerId,
      model: modelId,
      // BB owns which execution choices are valid, including values added after
      // this SDK version, so the preset's own strings are passed through.
      reasoningLevel: reasoningLevel as never,
      ...(preset.serviceTier
        ? { serviceTier: preset.serviceTier as never }
        : {}),
      permissionMode: permissionMode as never,
      visibility: "visible",
      title,
      prompt: orchestratorBrief(area, tasks, prefix),
    });
    return thread.id;
  };
  /**
   * One area, one orchestrator. It reads the whole area before starting
   * anything, holds its own children to the concurrency limit, and is the only
   * agent this dispatch creates, so a click on twelve tasks starts one thread.
   */
  const areas = new Map<string, Promise<AreaDelegation>>();
  const runArea = async (input: z.infer<typeof delegateAreaInput>) => {
    const key = `area:${input.requestId}`;
    const stored = await bb.storage.kv.get<AreaDelegation>(key);
    if (stored) return areaDelegationSchema.parse(stored);
    const { projects } = await call(
      "listProjects",
      {},
      z.object({ projects: z.array(z.looseObject(trackerProjectSchema.shape)) }),
    );
    const project = projects.find((row) => row.id === input.projectId);
    if (!project)
      throw new Error("This task project no longer exists. Refresh the map.");
    if (!project.linkedBbProjectId)
      throw new Error(
        `Task project "${project.name}" is not linked to a bb project, so no agent can be started in it. Link it in Tasks, then try again.`,
      );
    const title = orchestratorTitle(project.name);
    // A second click while this area's orchestrator runs belongs to that one.
    const liveKey = `orchestrator:${project.id}`;
    const live = await bb.storage.kv.get<AreaDelegation>(liveKey);
    const running = areaDelegationSchema.safeParse(live);
    if (running.success && (await stillRunning(running.data.threadId)))
      return { ...running.data, reused: true };
    const preset = await resolvePreset();
    // Settle what the dispatch really covers before spawning anything, so the
    // brief never names work that closed while the map was on screen.
    const covered: z.infer<typeof taskState>[] = [];
    const dropped: AreaDelegation["dropped"] = [];
    for (const taskId of input.taskIds) {
      let task: z.infer<typeof taskState> | null = null;
      try {
        ({ task } = await call(
          "getTask",
          { taskId },
          z.object({ task: taskState.nullable() }),
        ));
      } catch {
        dropped.push({ taskId, why: "could not be read" });
        continue;
      }
      if (!task) dropped.push({ taskId, why: "no longer exists" });
      else if (["done", "canceled"].includes(task.status))
        dropped.push({ taskId, why: "already closed" });
      else covered.push(task);
    }
    if (!covered.length)
      throw new Error(
        "None of these tasks is still open. Refresh the map and try again.",
      );
    const threadId = await spawnOrchestrator(
      preset,
      project.linkedBbProjectId,
      title,
      project.name,
      covered,
      project.prefix ?? "",
    );
    const result: AreaDelegation = {
      threadId,
      title,
      preset: preset.name,
      reused: false,
      covered: [],
      dropped,
    };
    // Attaching the orchestrator to every task it owns is what makes the work
    // read as taken: the map shows one running agent per card, and a second
    // click sees it before any child thread exists.
    for (const task of covered) {
      const commented = await commentOn(task.id, orchestratorComment(project.name));
      let attached = false;
      try {
        await call(
          "taskThreadsAttach",
          { taskId: task.id, threadId },
          z.looseObject({}),
        );
        attached = true;
      } catch {
        /* The orchestrator still owns it; its own comment records that. */
      }
      result.covered.push({
        taskId: task.id,
        taskKey: task.key,
        movedFrom: await startWork(task, TAKEN_FROM),
        commented,
        attached,
      });
    }
    for (const [target, value] of [
      [key, result],
      [liveKey, result],
    ] as const)
      try {
        await bb.storage.kv.set(target, value);
      } catch {
        /* The in-memory receipt still prevents a repeat dispatch. */
      }
    changed();
    return result;
  };
  /**
   * Every orchestrator this plugin has started, by area. Whether each still
   * lives is the map's call: it holds the thread list and can see a thread
   * end, so a stale record here costs nothing and a fresh one shows at once.
   */
  const liveOrchestrators = async (): Promise<LiveOrchestrator[]> => {
    let keys: string[] = [];
    try {
      keys = await bb.storage.kv.list("orchestrator:");
    } catch {
      return [];
    }
    const rows = await Promise.all(
      keys.map(async (key) => {
        const parsed = areaDelegationSchema.safeParse(
          await bb.storage.kv.get<unknown>(key),
        );
        return parsed.success
          ? {
              projectId: key.slice("orchestrator:".length),
              threadId: parsed.data.threadId,
              title: parsed.data.title,
            }
          : null;
      }),
    );
    return rows.filter((row): row is LiveOrchestrator => row !== null);
  };
  return {
    liveOrchestrators,
    delegatePreset: async () => ({ preset: (await resolvePreset()).name }),
    delegate: (input: z.infer<typeof delegateInput>) => {
      const existing = runs.get(input.requestId);
      if (existing) return existing;
      const started = run(input);
      runs.set(input.requestId, started);
      void started.catch(() => runs.delete(input.requestId));
      return started;
    },
    delegateArea: (input: z.infer<typeof delegateAreaInput>) => {
      // Two clicks that reach the server together must share one dispatch, not
      // race to discover each other's receipt.
      const existing =
        areas.get(input.requestId) ?? areas.get(`project:${input.projectId}`);
      if (existing) return existing;
      const started = runArea(input);
      areas.set(input.requestId, started);
      areas.set(`project:${input.projectId}`, started);
      const forget = () => areas.delete(`project:${input.projectId}`);
      void started.then(forget, () => {
        forget();
        areas.delete(input.requestId);
      });
      return started;
    },
  };
}
