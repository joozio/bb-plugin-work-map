import { describe, expect, it } from "vitest";
import {
  buildMap,
  arrangeMap,
  describeTask,
  dueLabel,
  isWorking,
  selectVisible,
  threadSignal,
} from "./model";
import { now, data, task, thread } from "./fixtures";
describe("attention rules", () => {
  it("moves a session under its task when attached later, while comments do not transfer activity", () => {
    const session = thread({ indicator: "runtime", isPinned: true });
    const input = task({
      commentSessions: [
        { threadId: session.id, title: "Session", at: "2026-09-17T12:00:00Z" },
      ],
    });
    const before = buildMap(data([input]), [session], {}, now);
    expect(before.find((item) => item.kind === "thread")).toBeTruthy();
    expect(before.find((item) => item.kind === "project")?.signal).toBe(
      "inactive",
    );
    const after = buildMap(
      data([{ ...input, threadIds: [session.id] }]),
      [session],
      {},
      now,
    );
    expect(after.filter((item) => item.kind === "thread")).toHaveLength(0);
    expect(after[0].children[0]).toMatchObject({
      focus: true,
      signal: "working",
    });
    const closed = data([
      { ...input, status: "done", threadIds: [session.id] },
    ]);
    const seen = thread({ isPinned: false });
    expect(
      buildMap(closed, [seen], {}, now).filter(
        (item) => item.kind === "project" && item.children.length > 0,
      ),
    ).toHaveLength(0);
    expect(
      buildMap(closed, [seen], {}, now, input.id)[0].children[0].signal,
    ).toBe("inactive");
  });
  it("anchors a request for input ahead of a running agent when nothing is pinned", () => {
    const items = buildMap(
      data([]),
      [
        thread({ id: "running", indicator: "runtime" }),
        thread({ id: "waiting", hasPendingInteraction: true }),
      ],
      {},
      now,
    );
    const layout = arrangeMap(selectVisible(items, 10));
    expect(layout.anchor?.id).toBe("thread:waiting");
    expect(layout.near.map((item) => item.id)).toContain("thread:running");
    expect(arrangeMap([]).anchor).toBeUndefined();
  });
  it("puts pinned and working sessions at the center while surrounding them with distinct work", () => {
    const items = buildMap(
      data([]),
      Array.from({ length: 16 }, (_, index) =>
        thread({
          id: `thr_${index}`,
          isPinned: index === 0,
          indicator:
            index === 1 ? "runtime" : index < 6 ? "unread-success" : "none",
          latestAttentionAt: now - index,
        }),
      ),
      {},
      now,
    );
    const shown = selectVisible(items, 13);
    const layout = arrangeMap(shown);
    expect(shown).toHaveLength(13);
    expect(layout.anchor?.id).toBe("thread:thr_0");
    expect(layout.near.some((item) => item.id === "thread:thr_1")).toBe(true);
    expect(layout.west.length).toBeGreaterThan(0);
    expect(layout.east.length).toBeGreaterThan(0);
    expect(layout.north.length).toBeGreaterThan(0);
    expect(layout.south.length).toBeGreaterThan(0);
    const all = [
      layout.anchor!,
      ...layout.near,
      ...layout.west,
      ...layout.east,
      ...layout.north,
      ...layout.south,
    ];
    expect(new Set(all.map((item) => item.id)).size).toBe(shown.length);
    expect(all.map((item) => item.id).sort()).toEqual(
      shown.map((item) => item.id).sort(),
    );
    expect(
      [...layout.north, ...layout.south].every(
        (item) => item.signal === "inactive",
      ),
    ).toBe(true);
  });
  it("keeps invalid source timestamps from poisoning project ranking", () => {
    const [project] = buildMap(
      data([task({ updatedAt: "invalid", status: "in_review" })]),
      [],
      {},
      now,
    );
    expect(Number.isFinite(project.score)).toBe(true);
    expect(project.updatedAt).toBe(0);
    expect(project.changed).toBe(false);
  });
  it("gives a project the same focus weight whether focus is direct, inherited or both", () => {
    const input = data();
    const inherited = buildMap(
      input,
      [],
      { "task:task1": { focus: true } },
      now,
    )[0];
    const direct = buildMap(
      input,
      [],
      { "project:p1": { focus: true } },
      now,
    )[0];
    const both = buildMap(
      input,
      [],
      { "project:p1": { focus: true }, "task:task1": { focus: true } },
      now,
    )[0];
    expect(inherited.score).toBe(direct.score);
    expect(both.score).toBe(direct.score);
  });
  it("shows review and agent activity together when an attached session is running", () => {
    const [project] = buildMap(
      data([task({ status: "in_review", threadIds: ["thr_test"] })]),
      [thread({ indicator: "runtime" })],
      {},
      now,
    );
    expect(project.signal).toBe("waiting");
    expect(isWorking(project)).toBe(true);
    expect(project.reason).toBe("1 working · 1 waiting for you");
  });
  it("uses the current status when the next-action field is a closed or blocked sentinel", () => {
    expect(
      describeTask("STATE 2026-09-17 · Waiting on response.\nNEXT ACTION: none")
        .nextAction,
    ).toBe("");
  });
  it("keeps focus independent of idle, working and unseen states", () => {
    for (const [indicator, signal] of [
      ["none", "inactive"],
      ["runtime", "working"],
      ["unread-success", "waiting"],
    ] as const) {
      const result = buildMap(
        data([]),
        [thread({ isPinned: true, indicator })],
        {},
        now,
      )[0];
      expect(result.focus).toBe(true);
      expect(result.signal).toBe(signal);
    }
  });
  it("requires input before showing a blocked runtime as working", () => {
    expect(
      threadSignal(
        thread({ indicator: "runtime", hasPendingInteraction: true }),
      ),
    ).toBe("waiting");
  });
  it("does not claim a plan-mode idle session is running", () => {
    expect(threadSignal(thread({ indicator: "plan-mode" }))).toBe("inactive");
  });
  it("rolls live activity and pin into a project and deduplicates linked sessions", () => {
    const result = buildMap(
      data([task({ threadIds: ["thr_test"] })]),
      [thread({ isPinned: true, indicator: "runtime" })],
      {},
      now,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ focus: true, signal: "working" });
  });
  it("keeps finished tasks with unseen results, then removes them when read", () => {
    const input = data([task({ status: "done", threadIds: ["thr_test"] })]);
    expect(
      buildMap(input, [thread({ indicator: "unread-success" })], {}, now)[0]
        .children[0].signal,
    ).toBe("waiting");
    expect(
      buildMap(input, [thread({ isArchived: true })], {}, now).flatMap(
        (item) => (item.kind === "project" ? item.children : [item]),
      ),
    ).toHaveLength(0);
  });
  it("does not confuse a task in progress with a running agent", () => {
    expect(
      buildMap(data([task({ status: "in_progress" })]), [], {}, now)[0].signal,
    ).toBe("inactive");
  });
  it("preserves human review after reading a session", () => {
    expect(
      buildMap(
        data([task({ status: "in_review", threadIds: ["thr_test"] })]),
        [thread()],
        {},
        now,
      )[0].children[0].reason,
    ).toBe("Your review");
  });
  it("distinguishes planning dates and ignores backlog dates", () => {
    expect(dueLabel(task({ dueDate: "2026-09-17" }), now)).toBe(
      "Planned today",
    );
    expect(
      dueLabel(task({ dueDate: "2026-09-17", dateKind: "deadline" }), now),
    ).toBe("Due today");
    expect(
      dueLabel(task({ dueDate: "2026-09-17", status: "backlog" }), now),
    ).toBe("");
  });
  it("new updates reappear after a prior version was seen", () => {
    const result = buildMap(
      data(),
      [],
      { "task:task1": { seenAt: now - 1000 } },
      now,
    );
    expect(result[0].changed).toBe(true);
    expect(
      buildMap(data(), [], { "task:task1": { seenAt: now } }, now)[0].changed,
    ).toBe(false);
  });
  it("bounds the map and rotates only inactive items", () => {
    const items = buildMap(
      data([]),
      Array.from({ length: 12 }, (_, i) =>
        thread({
          id: `thr_${i}`,
          isPinned: i === 0,
          latestAttentionAt: now - i,
        }),
      ),
      {},
      now,
    );
    const first = selectVisible(items, 8, 0),
      second = selectVisible(items, 8, 3);
    expect(first).toHaveLength(8);
    expect(second).toHaveLength(8);
    expect(first[0].id).toBe("thread:thr_0");
    expect(second[0].id).toBe("thread:thr_0");
    expect(first.map((i) => i.id)).not.toEqual(second.map((i) => i.id));
  });
  it("keeps a running session visible when review projects fill the queue", () => {
    const items = buildMap(
      data(
        Array.from({ length: 10 }, (_, i) =>
          task({ id: `task${i}`, status: "in_review", priority: "urgent" }),
        ),
      ),
      [
        thread({ id: "thr_running", indicator: "runtime" }),
        thread({ id: "thr_pinned", isPinned: true }),
        thread({ id: "thr_quiet" }),
      ],
      {},
      now,
    );
    const visible = selectVisible(items, 3);
    expect(visible.some((i) => i.id === "thread:thr_running")).toBe(true);
    expect(visible.some((i) => i.id === "thread:thr_pinned")).toBe(true);
  });
  it("ranks an unread session above routine review tasks", () => {
    const items = buildMap(
      data([
        task({
          status: "in_review",
          priority: "urgent",
          dueDate: "2026-09-17",
        }),
      ]),
      [thread({ indicator: "unread-success" })],
      {},
      now,
    );
    expect(items[0].kind).toBe("thread");
  });
  it("parses the existing task contract without leaking lifecycle fields into summaries", () => {
    expect(
      describeTask(
        "**STATE 2026-09-17 13:04 CEST · Draft is ready.**\nLIFECYCLE: in_review\nNEXT ACTION: Review it.\nDATE KIND: plan\nWAITING: none",
      ),
    ).toEqual({
      summary: "Draft is ready.",
      lifecycle: "in_review",
      checkAfter: "",
      nextAction: "Review it.",
      dateKind: "plan",
      waitingOn: "none",
    });
  });
});
