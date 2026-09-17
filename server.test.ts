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
  } = {},
) {
  let output = "First response";
  let threadIds = ["thr_test"];
  let commentReads = 0;
  const fake = createFakePluginHost({
    pluginId: "work-map",
    sdk: {
      threads: { output: async () => ({ output }) },
      plugins: {
        callRpc: async ({ method, outputSchema }) => {
          const source = {
            ...task(),
            status: options.closed ? "done" : "todo",
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
              ],
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
  };
}
describe("backend coverage and preferences", () => {
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
    expect(result.warnings).toEqual([
      "Session contribution history unavailable for TEST-1.",
    ]);
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
