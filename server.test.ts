import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { task } from "./fixtures";
afterEach(() => vi.restoreAllMocks());

async function host(
  options: {
    repeatedCursor?: boolean;
    missingLinks?: boolean;
    missingComments?: boolean;
    closed?: boolean;
    review?: boolean;
    needsYou?: boolean;
    missingLabels?: boolean;
  } = {},
) {
  let output = "First response";
  let threadIds = ["thr_test"];
  let commentReads = 0;
  const posted: { taskId: string; body: string; notify: boolean }[] = [];
  const calls: string[] = [];
  const fake = createFakePluginHost({
    pluginId: "work-map",
    sdk: {
      threads: { output: async () => ({ output }) },
      plugins: {
        callRpc: async ({ method, input, outputSchema }) => {
          calls.push(method);
          const source = {
            ...task(),
            status: options.closed
              ? "done"
              : options.review
                ? "in_review"
                : "todo",
            description:
              "**STATE 2026-09-17 12:00 CEST · Ready for review.**\nNEXT ACTION: Choose a direction.",
          };
          let value: unknown;
          if (method === "listProjects")
            value = { projects: [{ id: "p1", name: "Test", prefix: "TEST" }] };
          else if (method === "listTasks")
            value = {
              tasks: [source],
              nextCursor: options.repeatedCursor ? "same-cursor" : null,
            };
          else if (method === "listTaskThreads") {
            if (options.missingLinks) throw new Error("Tasks link read failed");
            value = {
              taskThreads: threadIds.map((threadId) => ({
                threadId,
                title: "Linked session",
                attachedAt: "2026-09-17T12:00:00Z",
              })),
            };
          } else if (method === "listComments") {
            commentReads++;
            if (options.missingComments)
              throw new Error("Comments unavailable");
            value = {
              comments: [
                {
                  kind: "system",
                  body: "Status changed to In Review by cli",
                  threadId: null,
                  threadTitle: null,
                  createdAt: "2026-09-17T10:00:00Z",
                },
                {
                  kind: "agent",
                  threadId: "thr_comment",
                  threadTitle: "Planning session",
                  createdAt: "2026-09-16T12:00:00Z",
                },
                {
                  kind: "agent",
                  threadId: "thr_comment",
                  threadTitle: "Planning session",
                  createdAt: "2026-09-17T12:00:00Z",
                },
                {
                  kind: "user",
                  threadId: null,
                  threadTitle: null,
                  createdAt: "2026-09-17T12:00:00Z",
                },
                ...(options.needsYou
                  ? [
                      {
                        kind: "agent",
                        body: "**Needs you:** pick a title. Two are in the doc.",
                        threadId: "thr_comment",
                        threadTitle: "Planning session",
                        createdAt: "2026-09-17T13:00:00Z",
                      },
                    ]
                  : []),
              ],
            };
          } else if (method === "getTask")
            value = {
              task: {
                ...source,
                labelIds: ["lab1", "lab-gone"],
                description:
                  "# Plan\n\nThe whole description, **bold**.\n\n- a\n- b",
              },
            };
          else if (method === "listLabels") {
            if (options.missingLabels) throw new Error("Labels unavailable");
            value = {
              labels: [
                { id: "lab1", projectId: "p1", name: "bug", color: "#f00" },
                { id: "lab2", projectId: "p1", name: "idea", color: "#0f0" },
              ],
            };
          } else if (method === "listAttachments")
            value = {
              attachments: [
                {
                  id: "att1",
                  taskId: "task1",
                  commentId: null,
                  fileName: "shot.png",
                  mime: "image/png",
                  sizeBytes: 2048,
                  isImage: true,
                  createdAt: "2026-09-17T12:00:00Z",
                },
              ],
            };
          else if (method === "createComment") {
            const raw = input as { taskId: string; body: string; notify: boolean };
            posted.push(raw);
            if (raw.body.includes("refuse")) throw new Error("Tasks refused it");
            value = {
              comment: {
                id: "cnew",
                taskId: raw.taskId,
                kind: "user",
                authorName: "You",
                presetName: null,
                threadId: null,
                body: raw.body,
                notifiedCount: 0,
                createdAt: "2026-09-17T14:00:00Z",
              },
            };
          } else throw new Error(`Unexpected ${method}`);
          return outputSchema.parse(value);
        },
      },
    },
  });
  await plugin(fake.bb);
  return {
    ...fake,
    setOutput(value: string) {
      output = value;
    },
    setLinks(value: string[]) {
      threadIds = value;
    },
    getCommentReads: () => commentReads,
    posted,
    calls,
  };
}
describe("the opened task", () => {
  it("reads the whole task on open: description, resolved labels, attachments and shaped comments, cached briefly", async () => {
    const fixture = await host();
    const read = () =>
      fixture.harness.behavior.callRpc("taskDetail", { taskId: "task1" }) as Promise<{
        description: string;
        labels: { name: string }[];
        attachments: { fileName: string }[];
        comments: { kind: string; authorName: string; body: string }[];
        warnings: string[];
      }>;
    const detail = await read();
    expect(detail.description).toContain("# Plan");
    expect(detail.labels.map((l) => l.name)).toEqual(["bug"]);
    expect(detail.attachments.map((a) => a.fileName)).toEqual(["shot.png"]);
    expect(detail.comments).toHaveLength(4);
    expect(detail.comments[0]).toMatchObject({ kind: "system", authorName: "" });
    expect(detail.warnings).toEqual([]);
    const before = fixture.calls.filter((m) => m === "getTask").length;
    await read();
    expect(fixture.calls.filter((m) => m === "getTask").length).toBe(before);
    await fixture.harness.behavior.callRpc("taskDetail", { taskId: "task1", fresh: true });
    expect(fixture.calls.filter((m) => m === "getTask").length).toBe(before + 1);
    await fixture.harness.lifecycle.dispose();
  });
  it("keeps the task readable when labels cannot be read, and says so", async () => {
    const fixture = await host({ missingLabels: true });
    const detail = (await fixture.harness.behavior.callRpc("taskDetail", {
      taskId: "task1",
    })) as { labels: unknown[]; warnings: string[]; comments: unknown[] };
    expect(detail.labels).toEqual([]);
    expect(detail.warnings).toEqual(["Labels are unavailable."]);
    expect(detail.comments).toHaveLength(4);
    await fixture.harness.lifecycle.dispose();
  });
  it("posts a comment in your name without notifying, returns it shaped, and makes the next snapshot re-read the task", async () => {
    const fixture = await host({ closed: true });
    await fixture.harness.behavior.callRpc("snapshot", null);
    await fixture.harness.behavior.callRpc("snapshot", null);
    expect(fixture.getCommentReads()).toBe(1);
    const { comment } = (await fixture.harness.behavior.callRpc("postComment", {
      taskId: "task1",
      body: "  Go with B.  ",
    })) as { comment: { kind: string; authorName: string; body: string } };
    expect(fixture.posted).toEqual([{ taskId: "task1", body: "Go with B.", notify: false }]);
    expect(comment).toMatchObject({ kind: "user", authorName: "You", body: "Go with B." });
    await fixture.harness.behavior.callRpc("snapshot", null);
    expect(fixture.getCommentReads()).toBe(2);
    await expect(
      fixture.harness.behavior.callRpc("postComment", { taskId: "task1", body: "   " }),
    ).rejects.toThrow();
    await expect(
      fixture.harness.behavior.callRpc("postComment", { taskId: "task1", body: "please refuse" }),
    ).rejects.toThrow("Tasks refused it");
    await fixture.harness.lifecycle.dispose();
  });
});
describe("backend coverage and preferences", () => {
  it("ships the ask from a Needs you comment over the description's next action, also from closed-task cache", async () => {
    const fixture = await host({ needsYou: true, closed: true });
    for (const _ of [0, 1]) {
      const result = (await fixture.harness.behavior.callRpc(
        "snapshot",
        null,
      )) as { tasks: { ask?: string; askFrom?: string }[] };
      expect(result.tasks[0]).toMatchObject({
        ask: "pick a title. Two are in the doc.",
        askFrom: "comment",
      });
    }
    expect(fixture.getCommentReads()).toBe(1);
    await fixture.harness.lifecycle.dispose();
  });
  it("ships the description's ask without a Needs you comment", async () => {
    const { harness } = await host();
    const result = (await harness.behavior.callRpc("snapshot", null)) as {
      tasks: { ask?: string; askFrom?: string }[];
    };
    expect(result.tasks[0]).toMatchObject({
      ask: "Choose a direction.",
      askFrom: "next",
    });
    await harness.lifecycle.dispose();
  });
  it("returns review age from status history without turning system events into session links", async () => {
    const { harness } = await host({ review: true });
    const result = (await harness.behavior.callRpc("snapshot", null)) as {
      tasks: { statusSince?: string; commentSessions: unknown[] }[];
    };
    expect(result.tasks[0].statusSince).toBe("2026-09-17T10:00:00.000Z");
    expect(result.tasks[0].commentSessions).toHaveLength(1);
    await harness.lifecycle.dispose();
  });
  it("reuses closed-task history between polls and refreshes it on demand", async () => {
    const fixture = await host({ closed: true });
    await fixture.harness.behavior.callRpc("snapshot", null);
    expect(fixture.getCommentReads()).toBe(1);
    const nextPoll = Date.now() + 60_000;
    vi.spyOn(Date, "now").mockReturnValue(nextPoll);
    await fixture.harness.behavior.callRpc("snapshot", null);
    expect(fixture.getCommentReads()).toBe(1);
    await fixture.harness.behavior.callRpc("snapshot", { fresh: true });
    expect(fixture.getCommentReads()).toBe(2);
    await fixture.harness.lifecycle.dispose();
  });
  it("picks up a later attachment immediately on explicit refresh", async () => {
    const fixture = await host();
    await fixture.harness.behavior.callRpc("snapshot", null);
    fixture.setLinks(["thr_later"]);
    const result = (await fixture.harness.behavior.callRpc("snapshot", {
      fresh: true,
    })) as { tasks: { threadIds: string[] }[] };
    expect(result.tasks[0].threadIds).toEqual(["thr_later"]);
    await fixture.harness.lifecycle.dispose();
  });
  it("keeps tasks and explicit links when contribution history is unavailable", async () => {
    const { harness } = await host({ missingComments: true });
    const result = (await harness.behavior.callRpc("snapshot", null)) as {
      tasks: { threadIds: string[] }[];
      warnings: string[];
    };
    expect(result.tasks[0].threadIds).toEqual(["thr_test"]);
    expect(result.warnings).toEqual(["Task history unavailable for TEST-1."]);
    await harness.lifecycle.dispose();
  });
  it("reads canonical task fields and links", async () => {
    const { harness } = await host();
    const result = (await harness.behavior.callRpc("snapshot", null)) as {
      tasks: { summary: string; threadIds: string[] }[];
    };
    expect(result.tasks[0]).toMatchObject({
      summary: "Ready for review.",
      threadIds: ["thr_test"],
      sessionLinks: [
        {
          threadId: "thr_test",
          title: "Linked session",
          attachedAt: "2026-09-17T12:00:00Z",
        },
      ],
      commentSessions: [
        {
          threadId: "thr_comment",
          title: "Planning session",
          at: "2026-09-17T12:00:00Z",
        },
      ],
    });
    await harness.lifecycle.dispose();
  });
  it("fails a repeated page cursor instead of presenting incomplete coverage", async () => {
    const { harness } = await host({ repeatedCursor: true });
    await expect(harness.behavior.callRpc("snapshot", null)).rejects.toThrow(
      "incomplete",
    );
    await harness.lifecycle.dispose();
  });
  it("retains tasks with explicit warnings when session links are inaccessible", async () => {
    const { harness } = await host({ missingLinks: true });
    const result = (await harness.behavior.callRpc("snapshot", null)) as {
      tasks: unknown[];
      warnings: string[];
    };
    expect(result.tasks).toHaveLength(1);
    expect(result.warnings).toEqual(["Session links unavailable for TEST-1."]);
    await harness.lifecycle.dispose();
  });
  it("persists distinct focus and seen state without touching canonical tasks", async () => {
    const { harness } = await host();
    await Promise.all([
      harness.behavior.callRpc("setPreference", {
        id: "task:task1",
        focus: true,
      }),
      harness.behavior.callRpc("setPreference", {
        id: "task:task1",
        seenAt: 100,
      }),
    ]);
    expect(await harness.behavior.callRpc("preferences", null)).toEqual({
      "task:task1": { focus: true, seenAt: 100 },
    });
    await harness.lifecycle.dispose();
  });
  it("snoozes tasks only, beside focus in the same record, and clears on null or 0", async () => {
    const { harness } = await host();
    await harness.behavior.callRpc("setPreference", {
      id: "task:task1",
      focus: true,
    });
    expect(
      await harness.behavior.callRpc("setPreference", {
        id: "task:task1",
        snoozedUntil: 5_000,
      }),
    ).toEqual({ focus: true, snoozedUntil: 5_000 });
    await expect(
      harness.behavior.callRpc("setPreference", {
        id: "project:project1",
        snoozedUntil: 5_000,
      }),
    ).rejects.toThrow("Only tasks can be snoozed.");
    await expect(
      harness.behavior.callRpc("setPreference", {
        id: "thread:thr_test",
        snoozedUntil: 5_000,
      }),
    ).rejects.toThrow("Only tasks can be snoozed.");
    expect(
      await harness.behavior.callRpc("setPreference", {
        id: "task:task1",
        snoozedUntil: null,
      }),
    ).toEqual({ focus: true });
    await harness.behavior.callRpc("setPreference", {
      id: "task:task1",
      snoozedUntil: 9_000,
    });
    await harness.behavior.callRpc("setPreference", {
      id: "task:task1",
      snoozedUntil: 0,
    });
    expect(await harness.behavior.callRpc("preferences", null)).toEqual({
      "task:task1": { focus: true },
    });
    await harness.lifecycle.dispose();
  });
  it("bypasses the excerpt cache before acknowledging a new response", async () => {
    const fixture = await host();
    await fixture.harness.behavior.callRpc("previews", {
      threadIds: ["thr_test"],
    });
    fixture.setOutput("New completed response");
    expect(
      await fixture.harness.behavior.callRpc("previews", {
        threadIds: ["thr_test"],
        fresh: true,
      }),
    ).toEqual({
      thr_test: {
        text: "New completed response",
        excerpt: "New completed response",
        truncated: false,
        error: false,
      },
    });
    await fixture.harness.lifecycle.dispose();
  });
  it("preserves Markdown tables on the wire and provides a separate card excerpt", async () => {
    const fixture = await host();
    const markdown =
      "Two options to compare.\n\n| Option | Status |\n| --- | --- |\n| First | Ready |\n| Second | Pending |";
    fixture.setOutput(markdown);
    expect(
      await fixture.harness.behavior.callRpc("previews", {
        threadIds: ["thr_test"],
      }),
    ).toEqual({
      thr_test: {
        text: markdown,
        excerpt: "Two options to compare.",
        truncated: false,
        error: false,
      },
    });
    await fixture.harness.lifecycle.dispose();
  });
});
