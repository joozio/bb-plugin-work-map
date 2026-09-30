import { describe, expect, it } from "vitest";
import {
  ACTION_LABEL,
  DELEGATION_COMMENT,
  DELEGATION_PROMPT,
  HANDOVER_GRACE,
  ORCHESTRATOR_LIMIT,
  ORCHESTRATOR_PROMPT,
  blockedReason,
  bulkPlan,
  confirmHeading,
  confirmNote,
  eligible,
  orchestratorBrief,
  orchestratorComment,
  orchestratorTitle,
  NEEDS_YOU,
  SNOOZE_DAYS,
  reportTitle,
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
    bbProjectId: "proj_test",
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
  it("refuses to snooze a task twice, and nothing else", () => {
    const snoozed = item({ snoozedUntil: 1_000 });
    expect(blockedReason(snoozed, "snooze")).toBe("already snoozed");
    expect(blockedReason(snoozed, "done")).toBeNull();
    expect(blockedReason(snoozed, "delegate")).toBeNull();
    expect(
      bulkPlan([item({ id: "a" }), { ...snoozed, id: "b" }], "snooze"),
    ).toMatchObject({
      take: [{ id: "a" }],
      skip: [{ item: { id: "b" }, why: "already snoozed" }],
    });
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
    expect(SNOOZE_DAYS).toBe(7);
    expect(confirmNote("snooze")).toBe(
      "Snoozing hides the task from what needs you for 7 days and changes nothing in Tasks. Undo restores it.",
    );
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

describe("what stops a handover before the click", () => {
  it("refuses an area with no bb project to start an agent in, naming it", () => {
    const unlinked = item({ bbProjectId: null });
    expect(blockedReason(unlinked, "delegate")).toBe(
      "project not linked to a bb project",
    );
    // Closing and snoozing it never needed an agent, so they stay available.
    expect(eligible(unlinked, "done")).toBe(true);
    expect(eligible(unlinked, "snooze")).toBe(true);
  });
  it("counts a dispatch seconds old as taken, before any indicator moves", () => {
    // This is tonight's double-click: the session list still shows nothing.
    const starting = item({
      task: task({
        id: "t1",
        key: "TEST-1",
        threadIds: ["thr_new"],
        sessionLinks: [
          {
            threadId: "thr_new",
            title: "Agent",
            attachedAt: "",
            liveStatus: "starting",
          },
        ],
      }),
    });
    expect(blockedReason(starting, "delegate")).toBe(
      "an agent is already running on it",
    );
  });
  it("frees the work again once that agent's link has ended", () => {
    const finished = item({
      task: task({
        id: "t1",
        sessionLinks: [
          {
            threadId: "thr_old",
            title: "Agent",
            attachedAt: "",
            liveStatus: "completed",
          },
        ],
      }),
    });
    expect(blockedReason(finished, "delegate")).toBeNull();
  });
  it("holds a task this session handed over, then lets it go", () => {
    const now = 1_000_000;
    const handedOver = { t1: now - 1000 };
    expect(blockedReason(item(), "delegate", { now, handedOver })).toBe(
      "just handed to an agent",
    );
    expect(
      blockedReason(item(), "delegate", {
        now: now + HANDOVER_GRACE,
        handedOver,
      }),
    ).toBeNull();
    // Another task's handover says nothing about this one.
    expect(
      blockedReason(item(), "delegate", { now, handedOver: { other: now } }),
    ).toBeNull();
  });
  it("lists the unlinked reason in a bulk plan, so the dialog can show it", () => {
    const plan = bulkPlan(
      [item({ id: "a" }), item({ id: "b", bbProjectId: null })],
      "delegate",
    );
    expect(plan.take.map((row) => row.id)).toEqual(["a"]);
    expect(plan.skip.map(({ why }) => why)).toEqual([
      "project not linked to a bb project",
    ]);
  });
});

describe("the brief handed to an area's orchestrator", () => {
  const brief = orchestratorBrief("Test project", [
    { id: "t1", key: "TEST-1", title: "Review the draft" },
    { id: "t2", key: "TEST-2", title: "Decide the price" },
  ]);
  it("is named for its area, and says so on the task it takes", () => {
    expect(orchestratorTitle("Test project")).toBe("Test project orchestrator");
    expect(orchestratorComment("Test project")).toContain(
      "Test project orchestrator",
    );
  });
  it("reads everything and writes the plan before starting anything", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("Read every task in full first");
    expect(ORCHESTRATOR_PROMPT).toContain(
      "Start nothing until you have read all of them",
    );
    expect(ORCHESTRATOR_PROMPT).toContain("duplicates");
    expect(ORCHESTRATOR_PROMPT).toContain("depend on another finishing first");
    expect(ORCHESTRATOR_PROMPT).toContain("Post that plan as your first message");
  });
  it("runs each task as a child under itself and attached to that task", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("child thread of yourself");
    expect(ORCHESTRATOR_PROMPT).toContain("attached to that task");
    // A task dispatch cannot set a parent, so the two-step path is the path.
    expect(ORCHESTRATOR_PROMPT).toContain("bb thread spawn --parent-self");
    expect(ORCHESTRATOR_PROMPT).toContain("bb tasks attach <task> --thread");
    expect(ORCHESTRATOR_PROMPT).toContain("Check both sides before you rely on it");
  });
  it("carries the concurrency limit as the one number, never a loose 3", () => {
    expect(ORCHESTRATOR_LIMIT).toBe(3);
    expect(ORCHESTRATOR_PROMPT).toContain(
      `at most ${ORCHESTRATOR_LIMIT} children running at once`,
    );
    // A cap that is only a number gets read as a target: the brief says how
    // to count before every spawn, and what to do at the cap.
    expect(ORCHESTRATOR_PROMPT).toContain("hard cap, not a target");
    expect(ORCHESTRATOR_PROMPT).toContain(
      "bb thread list --parent-thread <your thread id> --json",
    );
    expect(ORCHESTRATOR_PROMPT).toContain("bb thread wait <id>");
  });
  it("pushes a short result once, then ends every task done or in Review", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("not its whole transcript");
    expect(ORCHESTRATOR_PROMPT).toContain("re-brief that child once");
    expect(ORCHESTRATOR_PROMPT).toContain("never between them");
    // The words the owner scans for are fixed, on the task and in the brief.
    expect(NEEDS_YOU).toBe("Needs you:");
    expect(ORCHESTRATOR_PROMPT).toContain(`starts with the words "${NEEDS_YOU}"`);
    expect(ORCHESTRATOR_PROMPT).toContain("never re-brief or re-run it");
  });
  it("closes every thread it started and leaves exactly one review task", () => {
    expect(ORCHESTRATOR_PROMPT).toContain("archive it (`bb thread archive <id>`)");
    expect(ORCHESTRATOR_PROMPT).toContain("create exactly one task in this area");
    expect(ORCHESTRATOR_PROMPT).toContain("Closed without you (N)");
    expect(ORCHESTRATOR_PROMPT).toContain(
      "update its description instead of creating a second",
    );
    expect(ORCHESTRATOR_PROMPT).toContain("archive yourself (`bb thread archive --self`)");
    expect(ORCHESTRATOR_PROMPT).toContain("Nothing you started stays open");
    expect(reportTitle("Test project", 4, 2)).toBe(
      "Test project orchestrator: 4 done, 2 need you",
    );
  });
  it("lists the work it owns by key, id and title", () => {
    expect(brief).toContain("Your 2 tasks in Test project:");
    expect(brief).toContain(
      "Your review task's title, with the real counts: `Test project orchestrator: N done, M need you`",
    );
    expect(
      orchestratorBrief("Test project", [], "TEST"),
    ).toContain("Your 0 tasks in Test project (tracker project TEST):");
    expect(brief).toContain("- TEST-1 (t1): Review the draft");
    expect(brief).toContain("- TEST-2 (t2): Decide the price");
    expect(brief.startsWith(ORCHESTRATOR_PROMPT)).toBe(true);
  });
  it("names no person, so nothing private ships in the prompt", () => {
    expect(ORCHESTRATOR_PROMPT).not.toMatch(/pawel|wiz\b/i);
    expect(brief).not.toMatch(/pawel|wiz\b/i);
  });
});

describe("the voice limit, on both briefs", () => {
  it("stops an agent approving or closing work that ships as the owner", () => {
    for (const prompt of [DELEGATION_PROMPT, ORCHESTRATOR_PROMPT]) {
      expect(prompt).toContain("ship in the owner's name or voice");
      expect(prompt).toContain("approving, closing or signing off");
      for (const kind of ["post", "draft", "email", "social", "product copy"])
        expect(prompt).toContain(kind);
      // It still does the review it can, as a comment, and says where it stopped.
      expect(prompt).toContain("the concrete edits you propose");
      expect(prompt).toContain("as a task comment");
      expect(prompt).toMatch(/back to Review/);
    }
  });
  it("keeps both briefs' limits identical, so neither can drift", () => {
    const stops = (prompt: string) =>
      prompt
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .join("\n");
    expect(stops(ORCHESTRATOR_PROMPT)).toContain(stops(DELEGATION_PROMPT));
  });
});

describe("the confirmation before a whole area is handed over", () => {
  it("names the orchestrator, the count and the limit", () => {
    const note = confirmNote("delegate", "Digital Thoughts", 12);
    expect(note).toBe(
      "Starts Digital Thoughts orchestrator for 12 tasks. It runs at most 3 at a time, brings every task to done or back to you with a reason, and leaves you one review task with the summary. Undo cannot unstart an agent that has already begun.",
    );
    expect(confirmNote("delegate", "Test project", 1)).toContain("for 1 task.");
  });
});
