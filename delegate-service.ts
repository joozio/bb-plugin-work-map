import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { DELEGATION_COMMENT, DELEGATION_PROMPT } from "./delegation";

/** The worker preset a delegated task runs on, unless a stored choice names another. */
const DEFAULT_PRESET = "wiz";
const PRESET_KEY = "delegate:preset";
const presetSchema = z.object({ id: z.string(), name: z.string() });
const taskState = z.object({
  id: z.string(),
  key: z.string(),
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
export const delegationContract = {
  delegate: { input: delegateInput, output: delegationSchema },
  delegatePreset: { input: z.null(), output: z.object({ preset: z.string() }) },
};

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
    let commented = false;
    try {
      await call(
        "createComment",
        { taskId: task.id, body: DELEGATION_COMMENT, notify: false },
        z.looseObject({}),
      );
      commented = true;
    } catch {
      /* The dispatch itself records the handover in the task's own history. */
    }
    const { threadId } = await call(
      "delegate",
      {
        taskId: task.id,
        presetId: preset.id,
        extraInstructions: DELEGATION_PROMPT,
      },
      z.object({ threadId: z.string() }),
    );
    // Tasks moves backlog and todo to in_progress itself. Review is the column
    // this action exists to empty, so move that one here.
    let movedFrom: string | null = null;
    if (task.status === "in_review") {
      try {
        await call(
          "updateTask",
          { taskId: task.id, status: "in_progress", authorName: "You" },
          z.looseObject({}),
        );
        movedFrom = "in_review";
      } catch {
        /* The agent is running; its own first comment shows the task moved. */
      }
    }
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
  return {
    delegatePreset: async () => ({ preset: (await resolvePreset()).name }),
    delegate: (input: z.infer<typeof delegateInput>) => {
      const existing = runs.get(input.requestId);
      if (existing) return existing;
      const started = run(input);
      runs.set(input.requestId, started);
      void started.catch(() => runs.delete(input.requestId));
      return started;
    },
  };
}
