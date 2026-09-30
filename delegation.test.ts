import { describe, expect, it } from "vitest";
import {
  ACTION_LABEL,
  DELEGATION_COMMENT,
  DELEGATION_PROMPT,
  blockedReason,
  bulkPlan,
  confirmHeading,
  confirmNote,
  eligible,
} from "./delegation";
import type { WorkItem } from "./model";
import { task, thread } from "./fixtures";

function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "task:t1",
    title: "Review the proposal",
    kind: "task",
    summary: "",
    nextAction: "",
    focus: false,
    signal: "waiting",
    attention: "review",
    unreadResults: 0,
    reason: "",
    score: 1,
    changed: false,
    updatedAt: 0,
    activityAt: 0,
    recent: false,
    threads: [],
    task: task({ id: "t1", key: "TEST-1" }),
    children: [],
    scope: "Test project",
    issue: false,
    ...overrides,
  };
}

describe("what each action may touch", () => {
  it("offers all three on an open task", () => {
    const open = item();
    for (const action of ["delegate", "done", "snooze"] as const)
      expect(eligible(open, action)).toBe(true);
  });
  it("refuses a closed task, naming why", () => {
    const closed = item({ task: task({ id: "t1", status: "done" }) });
    expect(blockedReason(closed, "done")).toBe("already closed");
    expect(blockedReason(closed, "delegate")).toBe("already closed");
  });
  it("settles only tasks, since a session has nothing to close here", () => {
    const session = item({ kind: "thread", task: undefined });
    expect(blockedReason(session, "done")).toBe(
      "only tasks can be settled here",
    );
    expect(blockedReason(session, "delegate")).toBe(
      "only tasks can be settled here",
    );
  });
  it("will not delegate work an agent is already running", () => {
    const running = item({
      threads: [thread({ id: "thr_run", indicator: "runtime" })],
    });
    expect(blockedReason(running, "delegate")).toBe(
      "an agent is already running on it",
    );
    // Closing or snoozing it is still yours to do.
    expect(eligible(running, "done")).toBe(true);
    expect(eligible(running, "snooze")).toBe(true);
  });
});

describe("a bulk act names exactly what it will touch", () => {
  const rows = [
    item({ id: "a", title: "Open one" }),
    item({
      id: "b",
      title: "Closed one",
      task: task({ id: "b", key: "TEST-2", status: "done" }),
    }),
    item({
      id: "c",
      title: "Running one",
      threads: [thread({ id: "thr_run", indicator: "runtime" })],
    }),
    item({ id: "d", kind: "thread", title: "A session", task: undefined }),
  ];
  it("splits a selection into taken and skipped with reasons", () => {
    const plan = bulkPlan(rows, "delegate");
    expect(plan.take.map((row) => row.id)).toEqual(["a"]);
    expect(plan.skip.map(({ item: row, why }) => `${row.id}:${why}`)).toEqual([
      "b:already closed",
      "c:an agent is already running on it",
      "d:only tasks can be settled here",
    ]);
  });
  it("takes the running task for Done, which delegate refuses", () => {
    expect(bulkPlan(rows, "done").take.map((row) => row.id)).toEqual([
      "a",
      "c",
    ]);
  });
  it("counts in the heading and never says 1 tasks", () => {
    expect(confirmHeading("delegate", 1)).toBe("Let agents decide 1 task?");
    expect(confirmHeading("delegate", 4)).toBe("Let agents decide 4 tasks?");
    expect(confirmHeading("done", 2)).toBe("Mark 2 tasks done?");
    expect(confirmHeading("snooze", 1)).toBe("Snooze 1 task?");
  });
  it("says plainly what undo cannot reverse", () => {
    expect(confirmNote("delegate")).toContain(
      "cannot unstart an agent that has already begun",
    );
    expect(confirmNote("done")).toContain("follow-ups wired outside Work Map");
    expect(confirmNote("snooze")).toContain("Undo restores it");
  });
});

describe("the standing brief handed to a delegated agent", () => {
  it("hands over the decision and asks for evidence in the task", () => {
    expect(DELEGATION_PROMPT).toContain("You own this decision now");
    expect(DELEGATION_PROMPT).toContain("Record the decision");
    expect(DELEGATION_PROMPT).toContain("Mark the task done");
  });
  it("carries every hard stop, and routes them back to Review", () => {
    for (const limit of [
      "irreversible",
      "spending money",
      "publish or send anything outward",
      "credential, device or account only the owner has",
    ])
      expect(DELEGATION_PROMPT).toContain(limit);
    expect(DELEGATION_PROMPT).toContain("move the task back to Review");
  });
  it("names no person, so nothing private ships in the prompt", () => {
    expect(DELEGATION_PROMPT).not.toMatch(/pawel|wiz\b/i);
  });
  it("labels the act the same way everywhere", () => {
    expect(ACTION_LABEL.delegate).toBe("Agent decides");
    expect(DELEGATION_COMMENT).toBe("Delegated: decide on your own");
  });
});
