import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  managedProjectSchema,
  managementInput,
  managementResult,
  projectFields,
  type ManagementInput,
  type ManagementResult,
} from "./management-contract";

export function managementService(bb: BbPluginApi, invalidate: () => void) {
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
  const projects = async () =>
    (
      await call(
        "listProjects",
        {},
        z.object({ projects: z.array(managedProjectSchema) }),
      )
    ).projects;
  const managementOptions = async () => {
    const [list, folders, bbProjects] = await Promise.all([
      projects(),
      call(
        "listFolders",
        null,
        z.object({
          folders: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              parentFolderId: z.string().nullable().optional(),
            }),
          ),
        }),
      ),
      call(
        "listBbProjects",
        null,
        z.object({
          bbProjects: z.array(z.object({ id: z.string(), name: z.string() })),
        }),
      ),
    ]);
    return { projects: list, ...folders, ...bbProjects };
  };
  const resultError = z.object({
    code: z.string().optional(),
    message: z.string(),
  });
  const taskResult = z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      task: z.object({
        id: z.string(),
        key: z.string(),
        projectId: z.string(),
      }),
    }),
    z.object({ ok: z.literal(false), error: resultError }),
  ]);
  const receipts = new Map<
    string,
    { signature: string; result?: ManagementResult }
  >();
  let writes: Promise<unknown> = Promise.resolve();
  async function execute(raw: ManagementInput) {
    const input = managementInput.parse(raw);
    const signature = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const requestId = "requestId" in input ? input.requestId : null;
    const key = requestId ? `management:${requestId}` : null;
    if (key) {
      const previous =
        receipts.get(key) ??
        (await bb.storage.kv.get<{
          signature: string;
          result?: ManagementResult;
        }>(key));
      if (previous) {
        if (previous.signature !== signature)
          throw new Error(
            "This request was already used for different work. Start a new creation.",
          );
        if (previous.result) return managementResult.parse(previous.result);
        throw new Error(
          "The previous creation outcome is uncertain. Refresh and check the project before starting another creation.",
        );
      }
    }
    const options = await managementOptions();
    const project =
      "projectId" in input
        ? options.projects.find((p) => p.id === input.projectId)
        : undefined;
    if ("projectId" in input && !project)
      throw new Error("This project no longer exists. Refresh the map.");
    if (input.action === "createProject" || input.action === "editProject") {
      if (
        input.folderId &&
        !options.folders.some((f) => f.id === input.folderId)
      )
        throw new Error("Choose an existing folder.");
      if (
        input.linkedBbProjectId &&
        !options.bbProjects.some((p) => p.id === input.linkedBbProjectId)
      )
        throw new Error("Choose an existing BB workspace.");
      if (
        input.action === "createProject" &&
        options.projects.some((p) => p.prefix === input.prefix)
      )
        throw new Error("That project prefix is already in use.");
      if (
        input.action === "editProject" &&
        JSON.stringify(projectFields.parse(project)) !==
          JSON.stringify(input.expected)
      )
        throw new Error(
          "This project changed since you opened it. Refresh its details before saving.",
        );
    }
    if (input.action === "attachSession") {
      const { task } = await call(
        "getTask",
        { taskId: input.taskId },
        z.object({
          task: z
            .object({ projectId: z.string(), status: z.string() })
            .nullable(),
        }),
      );
      if (!task || task.projectId !== input.projectId)
        throw new Error("Choose a task in this project.");
      if (["done", "canceled"].includes(task.status))
        throw new Error("Choose an open task to connect this session.");
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      if (thread.archivedAt !== null)
        throw new Error("Restore the session in BB before connecting it.");
    }
    // Persist a pending receipt before creation. An interrupted unknown outcome is
    // never retried blindly, because Tasks has no idempotent create endpoint.
    if (key) {
      await bb.storage.kv.set(key, { signature });
      receipts.set(key, { signature });
    }
    let result: ManagementResult;
    try {
      if (input.action === "createProject") {
        const { action, requestId: _, ...fields } = input;
        result = await call(
          "createProject",
          fields,
          z.object({ project: managedProjectSchema }),
        );
      } else if (input.action === "editProject") {
        const { action, expected, ...fields } = input;
        result = await call(
          "updateProject",
          fields,
          z.object({ project: managedProjectSchema }),
        );
      } else if (input.action === "createTask") {
        const response = await call(
          "createTask",
          {
            projectId: input.projectId,
            title: input.title,
            description: input.description,
            status: "backlog",
          },
          taskResult,
        );
        if (!response.ok) {
          if (key) {
            receipts.delete(key);
            await bb.storage.kv.delete(key);
          }
          throw new Error(response.error.message);
        }
        result = { task: response.task };
      } else {
        result = await call(
          "taskThreadsAttach",
          { taskId: input.taskId, threadId: input.threadId },
          z.object({ threadId: z.string() }),
        );
      }
    } catch (cause) {
      // Only protocol failures before the handler ran prove there was no write.
      // handler_error and invalid_output can occur after a successful insert.
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? cause.code
          : undefined;
      if (
        key &&
        ["invalid_input", "invalid_json", "unknown_method"].includes(
          String(code),
        )
      ) {
        await bb.storage.kv.delete(key);
        receipts.delete(key);
      }
      throw cause;
    }
    invalidate();
    bb.realtime.publish("projects-changed", {});
    if (key) {
      receipts.set(key, { signature, result });
      try {
        await bb.storage.kv.set(key, { signature, result });
      } catch {
        /* Return confirmed canonical work; the pending durable receipt prevents duplicate creation after a reload. */
      }
    }
    return result;
  }
  const manage = (input: ManagementInput) => {
    const next = writes.then(() => execute(input));
    writes = next.catch(() => undefined);
    return next;
  };
  return { managementOptions, manage };
}
