import { heatTiming } from "./heat-timing";
import type { WorkItem } from "./model";
import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_CAP,
  areaOrchestrator,
  buildMap,
  arrangeMap,
  activityLabel,
  commentAsk,
  describeTask,
  dueLabel,
  isWorking,
  preferredSession,
  selectVisible,
  snoozeDays,
  snoozeLabel,
  threadSignal,
} from "./model";
import { now, data, task, thread } from "./fixtures";
describe("default connected session", () => {
  it("chooses input, error, unread, running, then recent idle work without reordering attachments", () => {
    const sessions = [
      thread({ id: "old", latestAttentionAt: now - 10000 }),
      thread({ id: "recent", latestAttentionAt: now - 1000 }),
      thread({ id: "run", indicator: "runtime" }),
      thread({ id: "result", indicator: "unread-success" }),
      thread({ id: "error", indicator: "unread-error" }),
      thread({ id: "input", hasPendingInteraction: true }),
      thread({ id: "archived", hasPendingInteraction: true, isArchived: true }),
    ];
    expect(preferredSession(sessions, now)?.id).toBe("input");
    expect(sessions[0].id).toBe("old");
    expect(preferredSession(sessions.slice(0, 5), now)?.id).toBe("error");
    expect(preferredSession(sessions.slice(0, 4), now)?.id).toBe("result");
    expect(preferredSession(sessions.slice(0, 3), now)?.id).toBe("run");
    expect(preferredSession(sessions.slice(0, 2), now)?.id).toBe("recent");
    expect(preferredSession([sessions[6]], now)).toBeUndefined();
  });
});
describe("attention rules", () => {
  it("balances an unread backlog with all three running agents and some quiet work", () => {
    const items = buildMap(
      data([]),
      [
        thread({ id: "pin", isPinned: true }),
        ...Array.from({ length: 8 }, (_, i) =>
          thread({
            id: `ready${i}`,
            indicator: "unread-success",
            latestAttentionAt: now - i,
          }),
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          thread({ id: `running${i}`, indicator: "runtime" }),
        ),
        ...Array.from({ length: 6 }, (_, i) => thread({ id: `quiet${i}` })),
      ],
      {},
      now,
    );
    const visible = selectVisible(items, 10);
    expect(visible).toHaveLength(10);
    expect(visible.filter(isWorking)).toHaveLength(3);
    expect(visible.filter((i) => i.unreadResults > 0)).toHaveLength(3);
    expect(
      visible.filter((i) => !i.focus && i.signal === "inactive"),
    ).toHaveLength(3);
    expect(arrangeMap(visible).near[0].id).toBe("thread:ready0");
  });
  it("keeps finished results visible among many running agents and close to a pin", () => {
    const items = buildMap(
      data([]),
      [
        thread({ id: "pin", isPinned: true }),
        ...Array.from({ length: 16 }, (_, i) =>
          thread({ id: `running${i}`, indicator: "runtime" }),
        ),
        thread({ id: "finished", indicator: "unread-success" }),
      ],
      {},
      now,
    );
    const shown = selectVisible(items, 10);
    const layout = arrangeMap(shown);
    expect(shown).toHaveLength(10);
    expect(layout.anchor?.id).toBe("thread:pin");
    expect(layout.near[0]?.id).toBe("thread:finished");
    expect(isWorking(layout.near[1])).toBe(true);
  });
  it("never sends unread results to the quiet outer ring, including linked task results", () => {
    const items = buildMap(
      data([task({ threadIds: ["attached"] })]),
      [
        thread({ id: "pin", isPinned: true }),
        thread({ id: "attached", indicator: "unread-success" }),
        ...Array.from({ length: 7 }, (_, i) =>
          thread({ id: `finished${i}`, indicator: "unread-success" }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          thread({ id: `quiet${i}`, latestAttentionAt: now - 7 * 86400000 }),
        ),
      ],
      {},
      now,
    );
    const layout = arrangeMap(selectVisible(items, 13));
    expect(
      [...layout.north, ...layout.south].every(
        (item) => item.unreadResults === 0,
      ),
    ).toBe(true);
    const inner = [
      layout.anchor!,
      ...layout.near,
      ...layout.west,
      ...layout.east,
    ];
    expect(inner.filter((item) => item.unreadResults > 0)).toHaveLength(8);
    expect(inner.some((item) => item.kind === "project")).toBe(true);
  });
  it("keeps the newest result stable through quiet rotation and removes its priority after reading", () => {
    const sessions = [
      thread({
        id: "fresh",
        indicator: "unread-success",
        latestAttentionAt: now,
      }),
      thread({
        id: "older",
        indicator: "unread-success",
        latestAttentionAt: now - 86400000,
      }),
      ...Array.from({ length: 12 }, (_, i) => thread({ id: `quiet${i}` })),
    ];
    const items = buildMap(data([]), sessions, {}, now);
    for (const rotation of [0, 4, 9]) {
      const layout = arrangeMap(selectVisible(items, 10, rotation));
      expect(layout.anchor?.id).toBe("thread:fresh");
      expect(layout.near[0]?.id).toBe("thread:older");
    }
    const read = buildMap(
      data([]),
      sessions.map((s) =>
        s.id === "fresh" ? { ...s, indicator: "none" as const } : s,
      ),
      {},
      now,
    );
    expect(arrangeMap(selectVisible(read, 10)).anchor?.id).toBe("thread:older");
  });
  it("keeps input requests and failed runs out of the quiet outer ring", () => {
    const items = buildMap(
      data([]),
      [
        ...Array.from({ length: 3 }, (_, i) =>
          thread({ id: `pin${i}`, isPinned: true }),
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          thread({
            id: `action${i}`,
            indicator: i % 2 ? "unread-error" : "waiting-for-input",
          }),
        ),
        ...Array.from({ length: 4 }, (_, i) =>
          thread({ id: `quiet${i}`, latestAttentionAt: now - 7 * 86400000 }),
        ),
      ],
      {},
      now,
    );
    const layout = arrangeMap(items);
    const far = [...layout.north, ...layout.south];
    expect(far).toHaveLength(4);
    expect(far.every((item) => item.signal === "inactive")).toBe(true);
    const inner = [
      layout.anchor!,
      ...layout.near,
      ...layout.west,
      ...layout.east,
    ];
    expect(inner.filter((item) => item.signal === "waiting")).toHaveLength(5);
    expect(new Set([...inner, ...far].map((item) => item.id)).size).toBe(
      items.length,
    );
  });
  it("does not hide an input request behind a full map of running agents", () => {
    const items = buildMap(
      data([]),
      [
        thread({ id: "input", hasPendingInteraction: true }),
        ...Array.from({ length: 15 }, (_, i) =>
          thread({ id: `running${i}`, indicator: "runtime" }),
        ),
      ],
      {},
      now,
    );
    expect(selectVisible(items, 10).map((item) => item.id)).toContain(
      "thread:input",
    );
    expect(arrangeMap(selectVisible(items, 10)).anchor?.id).toBe(
      "thread:input",
    );
  });
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
          latestAttentionAt: now - (index >= 6 ? 7 * 86400000 + index : index),
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
    expect(project.reason).toBe("1 needs review · 1 working");
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
      ["unread-success", "unread"],
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
    ).toBe("unread");
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
    ).toBe("Needs review");
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
  it("brings a finished unread session ahead of a routine review backlog", () => {
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
  it("separates requests, failures, reviews and unread results in rank and reasons", () => {
    const items = buildMap(
      data([task({ status: "in_review" })]),
      [
        thread({ id: "result", indicator: "unread-success" }),
        thread({ id: "input", indicator: "waiting-for-input" }),
        thread({ id: "error", indicator: "unread-error" }),
        thread({ id: "running", indicator: "runtime" }),
      ],
      {},
      now,
    );
    expect(items.map((i) => i.id)).toEqual([
      "thread:input",
      "thread:error",
      "thread:result",
      "project:p1",
      "thread:running",
    ]);
    expect(items.map((i) => i.reason)).toEqual([
      "Needs your input",
      "Run failed",
      "Ready to read",
      "1 needs review",
      "Agent working",
    ]);
    expect(items[2]).toMatchObject({
      signal: "unread",
      attention: "unread",
      unreadResults: 1,
    });
  });
  it("keeps review actionable while independently tracking unread attached results", () => {
    const snapshot = data([
      task({ status: "in_review", threadIds: ["result", "running"] }),
    ]);
    const threads = [
      thread({ id: "result", indicator: "unread-success" }),
      thread({ id: "running", indicator: "runtime" }),
    ];
    const [project] = buildMap(snapshot, threads, {}, now);
    expect(project.reason).toBe("1 needs review · 1 ready to read · 1 working");
    expect(project.children[0]).toMatchObject({
      signal: "waiting",
      attention: "review",
      unreadResults: 1,
      reason: "Needs review",
    });
    expect(isWorking(project.children[0])).toBe(true);
    const [read] = buildMap(
      snapshot,
      [thread({ id: "result" }), threads[1]],
      {},
      now,
    );
    expect(read.children[0]).toMatchObject({
      signal: "waiting",
      attention: "review",
      unreadResults: 0,
      reason: "Needs review",
    });
  });
  it("raises a review with unread material above an otherwise equivalent review", () => {
    const [project] = buildMap(
      data([
        task({ id: "a-read", status: "in_review" }),
        task({ id: "z-unread", status: "in_review", threadIds: ["result"] }),
      ]),
      [thread({ id: "result", indicator: "unread-success" })],
      {},
      now,
    );
    expect(project.children.map((child) => child.id)).toEqual([
      "task:z-unread",
      "task:a-read",
    ]);
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
      ask: "Review it.",
      askFrom: "next",
      dateKind: "plan",
      waitingOn: "none",
    });
  });
});

describe("task ask", () => {
  it("takes the line after a heading-like NEXT STEP marker", () => {
    const result = describeTask(
      "**STATE 2026-09-18 16:00 CEST · exp1 is merged.**\n\n**NEXT STEP (rewritten 2026-09-18 dayshift 16:00, replacing the 13:00 one it completed).**\n\nThe pack blocker is closed. exp2 is spawn-ready. Spawn it after the 17:00 check.\nWhy: the run needs a slot.",
    );
    expect(result.ask).toBe("The pack blocker is closed. exp2 is spawn-ready.");
    expect(result.askFrom).toBe("next");
  });
  it("reads a NEXT ACTION line, bold or not, and skips none", () => {
    expect(describeTask("NEXT ACTION: Review it.")).toMatchObject({
      ask: "Review it.",
      askFrom: "next",
    });
    expect(
      describeTask("**NEXT ACTION:** Send the invoice to the client today."),
    ).toMatchObject({
      ask: "Send the invoice to the client today.",
      askFrom: "next",
    });
    expect(
      describeTask("Waiting on a reply.\nNEXT ACTION: none\nWAITING: Ania"),
    ).toMatchObject({ ask: "Waiting on a reply.", askFrom: "summary" });
  });
  it("falls back to the Why line", () => {
    expect(
      describeTask(
        "STATE 2026-10-01 · Disk alert.\n**Why:** the Mini's disk alert fired for the 6th time.",
      ),
    ).toMatchObject({
      ask: "the Mini's disk alert fired for the 6th time.",
      askFrom: "why",
    });
  });
  it("falls back to the first two sentences of the summary", () => {
    expect(
      describeTask(
        "Proposal is drafted. It needs a [title](https://x.test)! Then we ship. Later more.\nSecond line.",
      ),
    ).toMatchObject({
      ask: "Proposal is drafted. It needs a title!",
      askFrom: "summary",
    });
  });
  it("has no ask for an empty description", () => {
    const result = describeTask("");
    expect(result.ask).toBeUndefined();
    expect(result.askFrom).toBeUndefined();
  });
  it("cuts a long sentence at a word boundary under 280 characters", () => {
    const long = `${"word ".repeat(80).trim()}.`;
    expect(long.length).toBeGreaterThan(395);
    const { ask } = describeTask(`NEXT ACTION: ${long}`);
    expect(ask!.length).toBeLessThanOrEqual(280);
    expect(ask).toMatch(/ word…$/);
    expect(long.startsWith(ask!.slice(0, -1))).toBe(true);
  });
  it("picks the latest Needs you comment, ignoring system and unprefixed ones", () => {
    const at = (h: number) => `2026-09-17T${String(h).padStart(2, "0")}:00:00Z`;
    expect(
      commentAsk([
        {
          kind: "agent",
          body: "Needs you: approve the old plan.",
          createdAt: at(9),
        },
        {
          kind: "agent",
          body: "**Needs you:** pick a title",
          createdAt: at(11),
        },
        {
          kind: "system",
          body: "Needs you: status changed",
          createdAt: at(12),
        },
        { kind: "agent", body: "Progress: half done.", createdAt: at(13) },
        { kind: "user", createdAt: at(14) },
      ]),
    ).toBe("pick a title");
    expect(
      commentAsk([
        {
          kind: "agent",
          body: "✅ _needs you_: merge it. Then tag. Later.",
          createdAt: at(9),
        },
      ]),
    ).toBe("merge it. Then tag.");
    expect(
      commentAsk([
        { kind: "system", body: "Needs you: no", createdAt: at(9) },
        { kind: "agent", body: "Done.", createdAt: at(10) },
      ]),
    ).toBe("");
  });
});

describe("activity proximity", () => {
  const day = 86400000;
  it("never lets an urgent input/error task with unread siblings displace an old pin", () => {
    for (const indicator of ["waiting-for-input", "unread-error"] as const) {
      const items = buildMap(
        data([
          task({
            priority: "urgent",
            dateKind: "deadline",
            dueDate: "2026-09-17",
            threadIds: ["action", "result"],
          }),
        ]),
        [
          thread({
            id: "pin",
            isPinned: true,
            latestAttentionAt: now - 30 * day,
          }),
          thread({ id: "action", indicator }),
          thread({ id: "result", indicator: "unread-success" }),
          thread({
            id: "old-input",
            indicator: "waiting-for-input",
            latestAttentionAt: now - 30 * day,
          }),
        ],
        {},
        now,
      );
      expect(arrangeMap(items).anchor?.id).toBe("thread:pin");
      if (indicator === "unread-error")
        expect(items[1].id).toBe("thread:old-input");
    }
  });
  it("reserves room for a review before recent quiet roots, and keeps old review/follow-up work in the inner area", () => {
    const items = buildMap(
      data([
        task({
          status: "in_review",
          updatedAt: new Date(now - 5 * day).toISOString(),
        }),
      ]),
      [
        thread({ id: "pin", isPinned: true }),
        thread({ id: "ready1", indicator: "unread-success" }),
        thread({ id: "ready2", indicator: "unread-success" }),
        thread({ id: "working", indicator: "runtime" }),
        thread({ id: "recent1" }),
        thread({ id: "recent2" }),
      ],
      {},
      now,
    );
    expect(selectVisible(items, 6).map((i) => i.id)).toContain("project:p1");
    for (const input of [
      task({ status: "in_review" }),
      task({ lifecycle: "waiting", checkAfter: "2026-09-17" }),
    ]) {
      const roots = buildMap(
        data([{ ...input, updatedAt: new Date(now - 5 * day).toISOString() }]),
        [
          thread({ id: "pin", isPinned: true }),
          thread({ id: "recent1" }),
          thread({ id: "recent2" }),
          ...Array.from({ length: 5 }, (_, i) =>
            thread({ id: `old${i}`, latestAttentionAt: now - (i + 2) * day }),
          ),
        ],
        {},
        now,
      );
      const orbit = arrangeMap(roots);
      expect(orbit.near.map((i) => i.id)).toContain("project:p1");
      expect(
        [...orbit.north, ...orbit.south].every((i) => i.signal !== "waiting"),
      ).toBe(true);
    }
  });
  it("keeps an overdue urgent task ahead of fresh low-priority work in the project headline and a small task grid", () => {
    const [project] = buildMap(
      data([
        task({
          id: "urgent",
          priority: "urgent",
          dateKind: "deadline",
          dueDate: "2026-09-10",
          updatedAt: new Date(now - 3 * day).toISOString(),
        }),
        task({
          id: "fresh",
          priority: "low",
          updatedAt: new Date(now - 3600000).toISOString(),
        }),
        task({ id: "fresh2", priority: "low" }),
      ]),
      [],
      {},
      now,
    );
    expect(project.children[0].id).toBe("task:urgent");
    expect(selectVisible(project.children, 2)[0].id).toBe("task:urgent");
  });
  it("keeps old pins, input and errors ahead of even a fresh urgent review with unread output", () => {
    const old = now - 30 * day;
    const items = buildMap(
      data([
        task({
          status: "in_review",
          priority: "urgent",
          dateKind: "deadline",
          dueDate: "2026-09-17",
          threadIds: ["result"],
        }),
      ]),
      [
        thread({ id: "pin", isPinned: true, latestAttentionAt: old }),
        thread({
          id: "input",
          indicator: "waiting-for-input",
          latestAttentionAt: old,
        }),
        thread({
          id: "error",
          indicator: "unread-error",
          latestAttentionAt: old,
        }),
        thread({ id: "result", indicator: "unread-success" }),
        thread({
          id: "unread",
          indicator: "unread-success",
          latestAttentionAt: old,
        }),
      ],
      {},
      now,
    );
    expect(items.map((i) => i.id)).toEqual([
      "thread:pin",
      "thread:input",
      "thread:error",
      "thread:unread",
      "project:p1",
    ]);
  });
  it("keeps project activity from recently completed tasks without bringing those tasks back", () => {
    const [project] = buildMap(
      data([
        task({ updatedAt: new Date(now - 14 * day).toISOString() }),
        task({
          id: "closed",
          status: "done",
          updatedAt: new Date(now).toISOString(),
        }),
      ]),
      [],
      {},
      now,
    );
    expect(project).toMatchObject({ activityAt: now, recent: true });
    expect(project.children.map((i) => i.task?.id)).toEqual(["task1"]);
  });
  it("brings yesterday's attached session activity into its task and project without changing task update state", () => {
    const old = new Date(now - 14 * day).toISOString();
    const [project] = buildMap(
      data([task({ updatedAt: old, threadIds: ["attached"] })]),
      [thread({ id: "attached", latestAttentionAt: now - 2 * 3600000 })],
      {},
      now,
    );
    expect(project).toMatchObject({
      activityAt: now - 2 * 3600000,
      recent: true,
      signal: "inactive",
      changed: false,
    });
    expect(project.children[0]).toMatchObject({
      activityAt: project.activityAt,
      updatedAt: Date.parse(old),
      recent: true,
      changed: false,
    });
    expect(activityLabel(project, now)).toBe("Active 2h ago");
  });
  it("does not borrow activity from comments or from reading an old session", () => {
    const old = now - 14 * day;
    const sessions = [
      thread({
        id: "old",
        latestAttentionAt: old,
        createdAt: old,
        updatedAt: now,
        lastReadAt: now,
      }),
      thread({ id: "contributor" }),
    ];
    const items = buildMap(
      data([
        task({
          updatedAt: new Date(old).toISOString(),
          threadIds: ["old"],
          commentSessions: [
            {
              threadId: "contributor",
              title: "Contributed",
              at: new Date(now).toISOString(),
            },
          ],
        }),
      ]),
      sessions,
      { "task:task1": { seenAt: now } },
      now,
    );
    expect(items.find((i) => i.kind === "project")).toMatchObject({
      activityAt: old,
      recent: false,
    });
  });
  it("keeps the two most recently active quiet roots through rotation and nearer than old work", () => {
    const items = buildMap(
      data([]),
      [
        thread({
          id: "pin",
          isPinned: true,
          latestAttentionAt: now - 20 * day,
        }),
        thread({ id: "recent1", latestAttentionAt: now - 3600000 }),
        thread({ id: "recent2", latestAttentionAt: now - 23 * 3600000 }),
        ...Array.from({ length: 12 }, (_, i) =>
          thread({ id: `old${i}`, latestAttentionAt: now - (i + 3) * day }),
        ),
      ],
      {},
      now,
    );
    for (const rotation of [0, 5, 10]) {
      const shown = selectVisible(items, 10, rotation);
      expect(new Set(shown.map((i) => i.id)).size).toBe(10);
      const orbit = arrangeMap(shown);
      expect(orbit.anchor?.id).toBe("thread:pin");
      expect(orbit.near.map((i) => i.id)).toEqual([
        "thread:recent1",
        "thread:recent2",
      ]);
      expect([...orbit.north, ...orbit.south].every((i) => !i.recent)).toBe(
        true,
      );
    }
  });
  it("ages an unchanged session out of the recent neighborhood without losing its attention or pin", () => {
    const sessions = [
      thread({ id: "pin", isPinned: true }),
      thread({ id: "aging" }),
      ...Array.from({ length: 4 }, (_, i) =>
        thread({ id: `ready${i}`, indicator: "unread-success" }),
      ),
    ];
    const fresh = buildMap(data([]), sessions, {}, now);
    expect(fresh.find((i) => i.id === "thread:aging")?.recent).toBe(true);
    expect(
      [...arrangeMap(fresh).west, ...arrangeMap(fresh).east].some(
        (i) => i.id === "thread:aging",
      ),
    ).toBe(true);
    const aged = buildMap(data([]), sessions, {}, now + 2 * day);
    const orbit = arrangeMap(aged);
    expect(orbit.anchor?.id).toBe("thread:pin");
    expect([...orbit.north, ...orbit.south].map((i) => i.id)).toContain(
      "thread:aging",
    );
    expect(aged.find((i) => i.id === "thread:ready0")).toMatchObject({
      recent: false,
      signal: "unread",
      unreadResults: 1,
    });
    const originalScore = fresh.find((i) => i.id === "thread:aging")!.score;
    expect(aged.find((i) => i.id === "thread:aging")!.score).toBeCloseTo(
      originalScore / 4,
    );
  });
  it("never lets recency alone turn quiet work into an agent or outrank explicit attention", () => {
    const items = buildMap(
      data([]),
      [
        thread({ id: "fresh" }),
        thread({
          id: "input",
          indicator: "waiting-for-input",
          latestAttentionAt: now - 30 * day,
        }),
        thread({
          id: "working",
          indicator: "runtime",
          latestAttentionAt: now - 30 * day,
        }),
      ],
      {},
      now,
    );
    expect(items[0].id).toBe("thread:input");
    expect(items.find((i) => i.id === "thread:fresh")).toMatchObject({
      signal: "inactive",
      reason: "Inactive",
    });
    expect(selectVisible(items, 2).map((i) => i.id)).toEqual([
      "thread:input",
      "thread:working",
    ]);
  });
  it("ignores invalid and future activity clocks and handles the 24 hour boundary", () => {
    const invalid = buildMap(
      data([]),
      [
        thread({ id: "bad", latestAttentionAt: NaN, createdAt: Infinity }),
        thread({
          id: "future",
          latestAttentionAt: now + day,
          createdAt: now + day,
        }),
        thread({ id: "boundary", latestAttentionAt: now - day }),
      ],
      {},
      now,
    );
    expect(invalid.every((i) => Number.isFinite(i.score) && !i.recent)).toBe(
      true,
    );
    expect(invalid.find((i) => i.id === "thread:bad")?.activityAt).toBe(0);
    expect(
      activityLabel(invalid.find((i) => i.id === "thread:boundary")!, now),
    ).toBe("Active 1d ago");
  });
});

describe("the orchestrator on an area", () => {
  const record = { orchestrators: [{ projectId: "p1", threadId: "orch", title: "Test project orchestrator" }] };
  const orchestrator = (indicator: "runtime" | "none" = "runtime") =>
    thread({ id: "orch", title: "Test project orchestrator", indicator });
  const child = (id: string, indicator: "runtime" | "none" | "unread-success" = "runtime") =>
    thread({ id, parentThreadId: "orch", indicator });
  it("shows while its thread lives, counting only its running children against the cap", () => {
    const found = areaOrchestrator("p1", record, [
      orchestrator(),
      child("c1"),
      child("c2", "unread-success"),
      thread({ id: "other", indicator: "runtime" }),
    ]);
    expect(found).toEqual({
      threadId: "orch",
      title: "Test project orchestrator",
      running: 1,
      limit: ORCHESTRATOR_CAP,
    });
  });
  it("stays while its children run even when the orchestrator itself is idle", () => {
    expect(areaOrchestrator("p1", record, [orchestrator("none"), child("c1")])?.running).toBe(1);
  });
  it("is gone once its thread ended, was archived, or never existed", () => {
    expect(areaOrchestrator("p1", record, [orchestrator("none")])).toBeNull();
    expect(areaOrchestrator("p1", record, [orchestrator(), child("c1")].map((t) => ({ ...t, isArchived: t.id === "orch" })))).toBeNull();
    expect(areaOrchestrator("p1", record, [])).toBeNull();
    expect(areaOrchestrator("p2", record, [orchestrator()])).toBeNull();
    expect(areaOrchestrator("p1", {}, [orchestrator()])).toBeNull();
  });
  it("lands on the project item the map builds", () => {
    const snapshot = { ...data([task({ projectId: "p1" })]), ...record };
    const project = buildMap(snapshot, [orchestrator(), child("c1"), child("c2"), child("c3"), child("c4")], {}, now).find((item) => item.id === "project:p1");
    expect(project?.orchestrator).toMatchObject({ running: 4, limit: 3 });
  });
});

describe("a snoozed task", () => {
  const WEEK = 7 * 86400000;
  const snoozed = { "task:task1": { snoozedUntil: now + WEEK } };
  const overdueReview = task({
    status: "in_review",
    priority: "urgent",
    dueDate: "2026-09-01",
    dateKind: "deadline",
  });
  it("loses its attention, score and review count until the date", () => {
    const [awake] = buildMap(data([overdueReview]), [], {}, now);
    const [asleep] = buildMap(data([overdueReview]), [], snoozed, now);
    const child = asleep.children[0];
    expect(child).toMatchObject({
      attention: null,
      signal: "inactive",
      reason: "Snoozed until 2026-09-24",
      snoozedUntil: now + WEEK,
    });
    expect(child.score).toBeLessThan(awake.children[0].score);
    // Nothing but recency: the same as a quiet, already-seen todo.
    expect(child.score).toBe(
      buildMap(
        data([task({ status: "todo" })]),
        [],
        { "task:task1": { seenAt: now } },
        now,
      )[0].children[0].score,
    );
    expect(awake.reason).toBe("1 needs review");
    expect(asleep).toMatchObject({ attention: null, signal: "inactive" });
    expect(asleep.reason).toBe("1 inactive tasks");
    expect(snoozeLabel(child, now)).toBe("Snoozed 7d");
    expect(snoozeLabel(child, now + WEEK - 3600000)).toBe("Snoozed 1d");
  });
  it("still surfaces input and failed runs, and shows a running agent", () => {
    const withThread = (
      id: string,
      indicator:
        "waiting-for-input" | "unread-error" | "runtime" | "unread-success",
    ) =>
      buildMap(
        data([{ ...overdueReview, threadIds: [id] }]),
        [thread({ id, indicator })],
        snoozed,
        now,
      ).find((item) => item.id === "project:p1")!;
    expect(withThread("in", "waiting-for-input").children[0]).toMatchObject({
      attention: "input",
      signal: "waiting",
      reason: "Needs your input",
    });
    expect(withThread("err", "unread-error").children[0]).toMatchObject({
      attention: "error",
      reason: "Run failed",
    });
    expect(withThread("err", "unread-error").reason).toBe("1 with an error");
    expect(withThread("run", "runtime").children[0]).toMatchObject({
      attention: null,
      signal: "working",
      reason: "Snoozed until 2026-09-24",
    });
    const unread = withThread("res", "unread-success");
    expect(unread.children[0]).toMatchObject({
      attention: null,
      signal: "inactive",
      unreadResults: 0,
    });
    expect(unread).toMatchObject({ signal: "inactive", unreadResults: 0 });
  });
  it("wakes on its own once now passes the date, with no write", () => {
    const [later] = buildMap(data([overdueReview]), [], snoozed, now + WEEK);
    expect(later.children[0]).toMatchObject({
      attention: "review",
      signal: "waiting",
    });
    expect(later.children[0].snoozedUntil).toBeUndefined();
    expect(snoozeLabel(later.children[0], now + WEEK)).toBe("");
  });
  it("leaves the other tasks in its area counted", () => {
    const [project] = buildMap(
      data([
        overdueReview,
        task({ id: "task2", key: "TEST-2", status: "in_review" }),
      ]),
      [],
      snoozed,
      now,
    );
    expect(project.reason).toBe("1 needs review");
    expect(project.attention).toBe("review");
    expect(project.children.map((c) => c.id)).toEqual([
      "task:task2",
      "task:task1",
    ]);
  });
});

describe("one snooze day count for Heat and Overview", () => {
  it("counts calendar days, so a clock behind the click never reads 8d", () => {
    const noon = new Date(2026, 9, 1, 12, 0, 0).getTime();
    const until = noon + 7 * 86400000;
    // The map's clock ticked a minute before the click that saved the snooze.
    expect(snoozeDays(until, noon - 60000)).toBe(7);
    expect(snoozeLabel({ snoozedUntil: until }, noon - 60000)).toBe("Snoozed 7d");
    // Late on the last day it still says 1d, never 0d.
    expect(snoozeDays(until, until - 3600000)).toBe(1);
  });
  it("is the count Heat shows", () => {
    const noon = new Date(2026, 9, 1, 12, 0, 0).getTime();
    const until = noon + 7 * 86400000;
    expect(
      heatTiming(
        {
          snoozedUntil: until,
          task: { status: "in_review", dueDate: "" },
        } as unknown as WorkItem,
        noon - 60000,
      )?.label,
    ).toBe(`snoozed ${snoozeDays(until, noon - 60000)}d`);
  });
});
