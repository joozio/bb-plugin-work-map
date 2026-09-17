import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { describeTask } from "./model";
import { sessionPreview, type SessionPreview } from "./preview";
import { settlementContract } from "./settlement-contract";
import { settlementService } from "./settlement";
import { managementContract } from "./management-contract";
import { managementService } from "./management";
import { managementUsage, runManagementCli } from "./management-cli";
import {
  sessionRequestSchema,
  sessionResultSchema,
  type SessionResult,
} from "./session-contract";

const taskSource = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.string(),
  priority: z.string(),
  dueDate: z.string().nullable(),
  updatedAt: z.string(),
});
const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  linkedBbProjectId: z.string().nullable().optional(),
  color: z.string().optional(),
  folderId: z.string().nullable().optional(),
});
const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.string(),
  priority: z.string(),
  dueDate: z.string().nullable(),
  updatedAt: z.string(),
  summary: z.string(),
  nextAction: z.string(),
  dateKind: z.string(),
  waitingOn: z.string(),
  lifecycle: z.string().optional(),
  checkAfter: z.string().optional(),
  threadIds: z.array(z.string()),
  sessionLinks: z
    .array(
      z.object({
        threadId: z.string(),
        title: z.string(),
        attachedAt: z.string(),
        liveStatus: z.string().optional(),
      }),
    )
    .optional(),
  commentSessions: z
    .array(
      z.object({
        threadId: z.string(),
        title: z.string().nullable(),
        at: z.string(),
      }),
    )
    .optional(),
});
export type MapTask = z.infer<typeof taskSchema>;
export type MapProject = z.infer<typeof projectSchema>;
const snapshotSchema = z.object({
  tasks: z.array(taskSchema),
  projects: z.array(projectSchema),
  generatedAt: z.number(),
  warnings: z.array(z.string()),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
const preferenceSchema = z.object({
  focus: z.boolean().optional(),
  seenAt: z.number().optional(),
  hidden: z.boolean().optional(),
});
export type Preference = z.infer<typeof preferenceSchema>;
const preferencesSchema = z.record(z.string(), preferenceSchema);
const itemId = z
  .string()
  .regex(/^(task|project|thread):[A-Za-z0-9_-]+$/)
  .max(100);
export const rpcContract = defineRpcContract({
  ...settlementContract,
  ...managementContract,
  createSession: {
    input: z.object({
      requestId: z.string().uuid(),
      request: sessionRequestSchema,
      taskId: z.string().min(1).optional(),
    }),
    output: sessionResultSchema,
  },
  retrySessionAttachment: {
    input: z.object({ requestId: z.string().uuid() }),
    output: sessionResultSchema,
  },
  snapshot: {
    input: z.object({ fresh: z.boolean().optional() }).nullable(),
    output: snapshotSchema,
  },
  preferences: { input: z.null(), output: preferencesSchema },
  setPreference: {
    input: z.object({
      id: itemId,
      focus: z.boolean().optional(),
      seenAt: z.number().optional(),
      hidden: z.boolean().optional(),
    }),
    output: preferenceSchema,
  },
  previews: {
    input: z.object({
      threadIds: z.array(z.string().regex(/^thr_[a-z0-9]+$/)).max(16),
      fresh: z.boolean().optional(),
    }),
    output: z.record(
      z.string(),
      z.object({
        text: z.string(),
        excerpt: z.string(),
        truncated: z.boolean(),
        error: z.boolean(),
      }),
    ),
  },
});

export default async function plugin(bb: BbPluginApi) {
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
  let cache: Snapshot | null = null;
  let inFlight: Promise<Snapshot> | null = null;
  let revision = 0;
  const invalidate = () => {
    cache = null;
    revision++;
  };
  let preferenceWrite: Promise<unknown> = Promise.resolve();
  const commentCache = new Map<
    string,
    {
      at: number;
      updatedAt: string;
      sessions: NonNullable<MapTask["commentSessions"]>;
    }
  >();
  const previews = new Map<string, SessionPreview & { at: number }>();
  async function collect(fresh = false): Promise<Snapshot> {
    const { projects } = await call(
      "listProjects",
      {},
      z.object({ projects: z.array(projectSchema) }),
    );
    const source: z.infer<typeof taskSource>[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await call(
        "listTasks",
        { limit: 500, ...(cursor ? { cursor } : {}) },
        z.object({
          tasks: z.array(taskSource),
          nextCursor: z.string().nullable(),
        }),
      );
      source.push(...result.tasks);
      if (!result.nextCursor) break;
      if (cursors.has(result.nextCursor) || page === 19)
        throw new Error("Task list is incomplete. Refresh to retry.");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    const warnings: string[] = [];
    const tasks: MapTask[] = [];
    let index = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (index < source.length) {
          const task = source[index++];
          let threadIds: string[] = [];
          let sessionLinks: NonNullable<MapTask["sessionLinks"]> = [];
          let commentSessions: NonNullable<MapTask["commentSessions"]> = [];
          try {
            const result = await call(
              "listTaskThreads",
              { taskId: task.id },
              z.object({
                taskThreads: z.array(
                  z.looseObject({
                    threadId: z.string(),
                    title: z.string().default("Session"),
                    attachedAt: z.string().default(""),
                    liveStatus: z.string().optional(),
                  }),
                ),
              }),
            );
            threadIds = result.taskThreads.map((t) => t.threadId);
            sessionLinks = result.taskThreads.map(
              ({ threadId, title, attachedAt, liveStatus }) => ({
                threadId,
                title,
                attachedAt,
                ...(liveStatus ? { liveStatus } : {}),
              }),
            );
          } catch {
            warnings.push(`Session links unavailable for ${task.key}.`);
          }
          const previousComments = commentCache.get(task.id);
          if (
            !fresh &&
            ["done", "canceled"].includes(task.status) &&
            previousComments?.updatedAt === task.updatedAt &&
            Date.now() - previousComments.at < 300_000
          ) {
            commentSessions = previousComments.sessions;
          } else
            try {
              const result = await call(
                "listComments",
                { taskId: task.id },
                z.object({
                  comments: z.array(
                    z.looseObject({
                      threadId: z.string().nullable(),
                      kind: z.string(),
                      threadTitle: z.string().nullable(),
                      createdAt: z.string(),
                    }),
                  ),
                }),
              );
              const latest = new Map<
                string,
                NonNullable<MapTask["commentSessions"]>[number]
              >();
              for (const comment of result.comments) {
                if (!comment.threadId || comment.kind !== "agent") continue;
                const previous = latest.get(comment.threadId);
                if (!previous || comment.createdAt > previous.at)
                  latest.set(comment.threadId, {
                    threadId: comment.threadId,
                    title: comment.threadTitle,
                    at: comment.createdAt,
                  });
              }
              commentSessions = [...latest.values()].sort((a, b) =>
                b.at.localeCompare(a.at),
              );
              commentCache.set(task.id, {
                at: Date.now(),
                updatedAt: task.updatedAt,
                sessions: commentSessions,
              });
            } catch {
              warnings.push(
                `Session contribution history unavailable for ${task.key}.`,
              );
            }
          const { description, ...fields } = task;
          tasks.push(
            taskSchema.parse({
              ...fields,
              ...describeTask(description),
              threadIds,
              sessionLinks,
              commentSessions,
            }),
          );
        }
      }),
    );
    const taskIds = new Set(source.map((task) => task.id));
    for (const id of commentCache.keys())
      if (!taskIds.has(id)) commentCache.delete(id);
    return { projects, tasks, generatedAt: Date.now(), warnings };
  }
  async function snapshot(input?: { fresh?: boolean } | null) {
    if (!input?.fresh && cache && Date.now() - cache.generatedAt < 45_000)
      return cache;
    if (!inFlight) {
      const startedAtRevision = revision;
      inFlight = collect(input?.fresh)
        .then((result) => {
          if (startedAtRevision === revision) cache = result;
          return result;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    const startedAtRevision = revision;
    const result = await inFlight;
    if (revision !== startedAtRevision || !cache)
      return snapshot({ fresh: true });
    return result;
  }
  async function getPreferences() {
    const keys = await bb.storage.kv.list("item:");
    const rows = await Promise.all(
      keys.map(async (key) => [
        key.slice(5),
        await bb.storage.kv.get<Preference>(key),
      ]),
    );
    return preferencesSchema.parse(Object.fromEntries(rows));
  }
  function setPreference({ id, ...patch }: { id: string } & Preference) {
    const write = preferenceWrite.then(async () => {
      if (patch.hidden !== undefined && !id.startsWith("project:"))
        throw new Error("Only project areas can be hidden from Overview.");
      const current = (await bb.storage.kv.get<Preference>(`item:${id}`)) ?? {};
      const next = preferenceSchema.parse({ ...current, ...patch });
      await bb.storage.kv.set(`item:${id}`, next);
      bb.realtime.publish("preferences-changed", { id });
      return next;
    });
    preferenceWrite = write.catch(() => undefined);
    return write;
  }
  // A repeated submit or attachment retry must never start another agent.
  const creations = new Map<string, Promise<SessionResult>>();
  const management = managementService(bb, invalidate);
  async function attachSession(result: SessionResult) {
    if (!result.taskId) return result;
    try {
      await call(
        "taskThreadsAttach",
        { taskId: result.taskId, threadId: result.threadId },
        z.object({ threadId: z.string() }),
      );
      invalidate();
      return { ...result, attachmentError: null };
    } catch {
      return {
        ...result,
        attachmentError:
          "Session started, but could not be attached to the task. Retry attachment below.",
      };
    }
  }
  async function recoverCreation(
    requestId: string,
    receipt: SessionResult,
    taskId?: string,
  ) {
    let result = sessionResultSchema.parse(receipt);
    if (result.taskId !== (taskId ?? null))
      throw new Error(
        "This creation request belongs to a different task. Start a new session request.",
      );
    if (result.taskId && result.attachmentError) {
      result = await attachSession(result);
      creations.set(requestId, Promise.resolve(result));
      try {
        await bb.storage.kv.set(`session:${requestId}`, result);
      } catch {
        /* The returned receipt reflects the attachment result. */
      }
    }
    return result;
  }
  bb.rpc.register(rpcContract, {
    ...management,
    ...settlementService(bb, invalidate),
    createSession: ({ requestId, request, taskId }) => {
      const existing = creations.get(requestId);
      if (existing)
        return existing.then((result) =>
          recoverCreation(requestId, result, taskId),
        );
      const creation = (async () => {
        const key = `session:${requestId}`;
        const stored = await bb.storage.kv.get<SessionResult>(key);
        if (stored) return recoverCreation(requestId, stored, taskId);
        if (taskId) {
          // Validate the target before dispatch, including a task removed since the map loaded.
          await call(
            "getTask",
            { taskId },
            z.object({ task: z.object({ id: z.string() }) }),
          );
        }
        const thread = await bb.sdk.threads.spawn({
          ...request,
          visibility: "visible",
        });
        let result: SessionResult = {
          threadId: thread.id,
          taskId: taskId ?? null,
          attachmentError: taskId
            ? "Attachment has not completed. Retry attachment below."
            : null,
        };
        // Save the created id before the second mutation so retries recover it.
        try {
          await bb.storage.kv.set(key, result);
        } catch {
          /* In-memory receipt still prevents repeat dispatch. */
        }
        result = await attachSession(result);
        try {
          await bb.storage.kv.set(key, result);
        } catch {
          /* Return the live session even if receipt persistence fails. */
        }
        return result;
      })();
      creations.set(requestId, creation);
      void creation.catch(() => creations.delete(requestId));
      return creation;
    },
    retrySessionAttachment: async ({ requestId }) => {
      const result = await (creations.get(requestId) ??
        bb.storage.kv.get<SessionResult>(`session:${requestId}`));
      if (!result)
        throw new Error("No created session was found for this request.");
      const next = await attachSession(sessionResultSchema.parse(result));
      creations.set(requestId, Promise.resolve(next));
      try {
        await bb.storage.kv.set(`session:${requestId}`, next);
      } catch {
        /* Attachment succeeded; retain the in-memory receipt. */
      }
      return next;
    },
    snapshot,
    preferences: getPreferences,
    setPreference,
    previews: async ({ threadIds, fresh }) => {
      const entries = await Promise.all(
        threadIds.map(async (threadId) => {
          let cached = previews.get(threadId);
          if (fresh || !cached || Date.now() - cached.at > 15_000) {
            try {
              const result = await bb.sdk.threads.output({ threadId });
              cached = {
                at: Date.now(),
                ...sessionPreview(result.output ?? ""),
                error: false,
              };
            } catch {
              cached = {
                at: Date.now(),
                text: "Session preview is unavailable. Open the session to read it.",
                excerpt: "",
                truncated: false,
                error: true,
              };
            }
            previews.set(threadId, cached);
          }
          const { at: _at, ...preview } = cached;
          return [threadId, preview] as const;
        }),
      );
      if (previews.size > 250)
        for (const [id, value] of previews)
          if (Date.now() - value.at > 60_000) previews.delete(id);
      return Object.fromEntries(entries);
    },
  });
  bb.cli.register({
    name: "work-map",
    summary: "Inspect Work Map and manage project areas",
    commands: [
      {
        name: "status",
        summary: "Check project, task and session-link coverage",
        usage: "bb work-map status [--json]",
      },
      {
        name: "project",
        summary: "List, create, edit, hide or restore areas",
        usage: managementUsage,
      },
      {
        name: "task",
        summary: "Add a backlog task to a project",
        usage:
          "bb work-map task create --project KEY --title TITLE [--description TEXT] [--request-id UUID] [--json]",
      },
      {
        name: "attach",
        summary: "Connect an existing session to a task",
        usage: "bb work-map attach TASK-KEY --thread THREAD-ID [--json]",
      },
    ],
    async run(argv) {
      const usage = `Usage: bb work-map status [--json]\n${managementUsage}`;
      if (!argv.length || argv[0] === "--help")
        return { exitCode: 0, stdout: usage };
      if (["project", "task", "attach"].includes(argv[0]))
        return runManagementCli(argv, {
          ...management,
          snapshot,
          preferences: getPreferences,
          setPreference,
        });
      if (argv[0] !== "status" || argv.slice(1).some((arg) => arg !== "--json"))
        return { exitCode: 1, stderr: usage };
      const data = await snapshot();
      const status = {
        projects: data.projects.length,
        tasks: data.tasks.length,
        attachedSessions: new Set(data.tasks.flatMap((t) => t.threadIds)).size,
        commentingSessions: new Set(
          data.tasks.flatMap((task) =>
            (task.commentSessions ?? []).map((session) => session.threadId),
          ),
        ).size,
        generatedAt: new Date(data.generatedAt).toISOString(),
        warnings: data.warnings,
      };
      return {
        exitCode: 0,
        stdout: argv.includes("--json")
          ? JSON.stringify(status, null, 2)
          : `${status.projects} projects · ${status.tasks} tasks · ${status.attachedSessions} attached sessions\nUpdated ${status.generatedAt}${status.warnings.length ? `\n${status.warnings.join("\n")}` : ""}`,
      };
    },
  });
  bb.onDispose(() => {
    previews.clear();
    commentCache.clear();
    cache = null;
  });
}
