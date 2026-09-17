import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import type { NewThreadRequest } from "@get-bb/plugin-sdk";

const request: NewThreadRequest = {
  projectId: "proj_test",
  providerId: "codex",
  model: "gpt-6-astra",
  reasoningLevel: "medium",
  permissionMode: "accept-edits",
  serviceTier: "fast",
  executionInputSources: {
    model: "explicit",
    providerId: "explicit",
    permissionMode: "explicit",
  },
  environment: { type: "reuse", environmentId: "env_test" },
  input: [
    { type: "text", text: "Inspect this", mentions: [] },
    { type: "localFile", path: "/tmp/example.txt", name: "example.txt" },
  ],
};
const requestId = "bdc50aee-584d-42db-9406-9199ad461c1a";
async function setup() {
  let failAttachment = false;
  let missingTask = false;
  const spawn = vi.fn(async () => makeThreadResponse({ id: "thr_created" }));
  const attach = vi.fn();
  const fake = createFakePluginHost({
    pluginId: "work-map",
    sdk: {
      threads: { spawn },
      plugins: {
        callRpc: async ({ method, input, outputSchema }) => {
          if (method === "getTask")
            return outputSchema.parse({
              task: missingTask ? null : { id: "task1" },
            });
          if (method === "taskThreadsAttach") {
            attach(input);
            if (failAttachment) throw new Error("Tasks offline");
            return outputSchema.parse({ threadId: "thr_created" });
          }
          throw new Error(`Unexpected ${method}`);
        },
      },
    },
  });
  await plugin(fake.bb);
  return {
    ...fake,
    spawn,
    attach,
    failAttachment: () => {
      failAttachment = true;
    },
    restore: () => {
      failAttachment = false;
    },
    removeTask: () => {
      missingTask = true;
    },
  };
}
describe("user-created sessions", () => {
  it("recovers partial success on a repeated submit, but rejects a changed task", async () => {
    const f = await setup();
    f.failAttachment();
    await f.harness.behavior.callRpc("createSession", {
      requestId,
      request,
      taskId: "task1",
    });
    f.restore();
    expect(
      await f.harness.behavior.callRpc("createSession", {
        requestId,
        request,
        taskId: "task1",
      }),
    ).toEqual({
      threadId: "thr_created",
      taskId: "task1",
      attachmentError: null,
    });
    await expect(
      f.harness.behavior.callRpc("createSession", {
        requestId,
        request,
        taskId: "different",
      }),
    ).rejects.toThrow("different task");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.attach).toHaveBeenCalledTimes(2);
    await f.harness.lifecycle.dispose();
  });
  it("finishes a recovered task attachment without spawning a second session", async () => {
    const f = await setup();
    await f.bb.storage.kv.set(`session:${requestId}`, {
      threadId: "thr_created",
      taskId: "task1",
      attachmentError: "Attachment has not completed.",
    });
    expect(
      await f.harness.behavior.callRpc("createSession", {
        requestId,
        request,
        taskId: "task1",
      }),
    ).toEqual({
      threadId: "thr_created",
      taskId: "task1",
      attachmentError: null,
    });
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.attach).toHaveBeenCalledOnce();
    await f.harness.lifecycle.dispose();
  });
  it("recovers a saved creation receipt after reload without dispatching again", async () => {
    const first = await setup();
    await first.harness.behavior.callRpc("createSession", {
      requestId,
      request,
    });
    const receipt = await first.bb.storage.kv.get(`session:${requestId}`);
    await first.harness.lifecycle.dispose();
    const next = await setup();
    await next.bb.storage.kv.set(`session:${requestId}`, receipt);
    expect(
      await next.harness.behavior.callRpc("createSession", {
        requestId,
        request,
      }),
    ).toEqual({ threadId: "thr_created", taskId: null, attachmentError: null });
    expect(next.spawn).not.toHaveBeenCalled();
    await next.harness.lifecycle.dispose();
  });
  it("preserves a provider environment, scheduling and structured mention input", async () => {
    const f = await setup();
    const selected: NewThreadRequest = {
      ...request,
      sendAt: Date.now() + 60_000,
      environment: {
        type: "provider",
        environmentProviderId: "example",
        inputs: { size: "small" },
        machine: { type: "existing", hostId: "host_test" },
      },
      input: [
        {
          type: "text",
          text: "Inspect Session",
          mentions: [
            {
              start: 8,
              end: 15,
              resource: {
                kind: "thread",
                label: "Session",
                threadId: "thr_test",
              },
            },
          ],
        },
      ],
    };
    await f.harness.behavior.callRpc("createSession", {
      requestId,
      request: selected,
    });
    expect(f.spawn).toHaveBeenCalledWith({
      ...selected,
      visibility: "visible",
      origin: "plugin",
      originPluginId: "work-map",
    });
    await f.harness.lifecycle.dispose();
  });
  it("passes native selections, provenance and attachments unchanged, once for concurrent submits", async () => {
    const f = await setup();
    const input = { requestId, request, taskId: "task1" };
    const results = await Promise.all([
      f.harness.behavior.callRpc("createSession", input),
      f.harness.behavior.callRpc("createSession", input),
    ]);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.spawn).toHaveBeenCalledWith({
      ...request,
      visibility: "visible",
      origin: "plugin",
      originPluginId: "work-map",
    });
    expect(f.attach).toHaveBeenCalledWith({
      taskId: "task1",
      threadId: "thr_created",
    });
    expect(results[0]).toEqual({
      threadId: "thr_created",
      taskId: "task1",
      attachmentError: null,
    });
    expect(results[1]).toEqual(results[0]);
    await f.harness.lifecycle.dispose();
  });
  it("retries only attachment after a partial success", async () => {
    const f = await setup();
    f.failAttachment();
    const first = (await f.harness.behavior.callRpc("createSession", {
      requestId,
      request,
      taskId: "task1",
    })) as { attachmentError: string };
    expect(first.attachmentError).toContain("Session started");
    f.restore();
    expect(
      await f.harness.behavior.callRpc("retrySessionAttachment", { requestId }),
    ).toEqual({
      threadId: "thr_created",
      taskId: "task1",
      attachmentError: null,
    });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.attach).toHaveBeenCalledTimes(2);
    await f.harness.lifecycle.dispose();
  });
  it("does not dispatch for a deleted task, or attach a project-level session to an arbitrary task", async () => {
    const f = await setup();
    f.removeTask();
    await expect(
      f.harness.behavior.callRpc("createSession", {
        requestId,
        request,
        taskId: "task1",
      }),
    ).rejects.toThrow();
    expect(f.spawn).not.toHaveBeenCalled();
    await f.harness.behavior.callRpc("createSession", { requestId, request });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.attach).not.toHaveBeenCalled();
    await f.harness.lifecycle.dispose();
  });
});
