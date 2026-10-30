import { describe, expect, it } from "vitest";
import { handoffDescription } from "./settlement";
import { settleInput } from "./settlement-contract";

const id = "1760000000000-0b5e3c4f-8a2d-4e8b-9c31-5f6a7b8c9d0e";
const at = new Date("2026-09-17T12:00:00").getTime();
const LOG = "──────────── log ────────────";
const settle = (fields: Record<string, unknown>) =>
  settleInput.parse({ id, taskId: "task1", ...fields });
/** The stamp is local time with a zone name, so read it back rather than guess it. */
const stampOf = (output: string) => {
  const stamp = output.match(/\*\*STATE (.+?) · /)?.[1];
  expect(stamp).toMatch(/^2026-09-17 \d{2}:\d{2} \S+$/);
  return stamp!;
};

describe("rewriting a task description on handoff", () => {
  it("writes the full lifecycle block and a log onto a bare description", () => {
    const output = handoffDescription(
      "Ship the release notes.",
      settle({ action: "done" }),
      at,
    );
    const stamp = stampOf(output);
    expect(output).toBe(
      [
        `**STATE ${stamp} · Marked done in Work Map.**`,
        "Ship the release notes.",
        "NEXT ACTION: none",
        "LIFECYCLE: done",
        "NATIVE STATUS: done",
        "REVIEWER: none",
        "WAITING: none",
        "CHECK AFTER: none",
        "STATUS REASON: USER STEERING | 2026-09-17 | Work Map: done",
        "",
        LOG,
        `Work Map · ${stamp} · User chose done.`,
      ].join("\n"),
    );
  });

  it("pauses without touching lifecycle fields, keeping the next step and an existing --- log", () => {
    const description = [
      "**STATE 2026-09-10 · Draft underway**",
      "NEXT ACTION: Send the draft to the editor",
      "OWNER: alex",
      "---",
      "Older entry",
    ].join("\n");
    const output = handoffDescription(
      description,
      settle({ action: "pause", threadId: "thr_abc" }),
      at,
    );
    const stamp = stampOf(output);
    expect(output).toBe(
      [
        `**STATE ${stamp} · Draft underway**`,
        "NEXT ACTION: Send the draft to the editor",
        "OWNER: alex",
        "",
        "---",
        "Older entry",
        "",
        `Work Map · ${stamp} · User chose pause. Session: thr_abc.`,
        "Previous state: **STATE 2026-09-10 · Draft underway**",
      ].join("\n"),
    );
  });

  it("falls back to 'Task remains open' and 'Resume this task' when a pause has nothing to go on", () => {
    const output = handoffDescription("", settle({ action: "pause" }), at);
    const stamp = stampOf(output);
    expect(output).toBe(
      [
        `**STATE ${stamp} · Task remains open.**`,
        "NEXT ACTION: Resume this task.",
        "",
        LOG,
        `Work Map · ${stamp} · User chose pause.`,
      ].join("\n"),
    );
  });

  it("takes a typed next step, with its whitespace tidied, over the old one", () => {
    const output = handoffDescription(
      "Draft\nnext action: Old step",
      settle({ action: "pause", nextAction: "  Call   the\nprinter " }),
      at,
    );
    // The field is matched in any case and rewritten once, never duplicated.
    expect(output).toContain("NEXT ACTION: Call the printer");
    expect(output).not.toMatch(/next action: Old step/i);
    expect(output.match(/^NEXT ACTION:/gim)).toHaveLength(1);
  });

  it("will not resume work that waits on someone else, but can leave it waiting", () => {
    const description = "Waiting on legal\nLIFECYCLE: waiting\nNEXT ACTION: none";
    expect(() =>
      handoffDescription(
        description,
        settle({ action: "pause", nextAction: "Push ahead" }),
        at,
      ),
    ).toThrow("This task is waiting on someone else.");
    // A blank (or whitespace) next step keeps the wait and the task unchanged.
    const output = handoffDescription(
      description,
      settle({ action: "pause", nextAction: "   " }),
      at,
    );
    expect(output).toContain("LIFECYCLE: waiting");
    expect(output).toContain("NEXT ACTION: Resume this task.");
  });

  it("hands review to the owner, or to me when none is named", () => {
    const owned = handoffDescription(
      "Draft\nOWNER: alex",
      settle({ action: "review" }),
      at,
    );
    expect(owned).toContain("Ready for your review.");
    expect(owned).toContain("NEXT ACTION: Review the work.");
    expect(owned).toContain("REVIEWER: alex");
    expect(owned).toContain("STATUS REASON: USER STEERING | 2026-09-17 | Work Map: review by me");
    expect(owned).toMatch(/User chose review by me\.$/);
    const unowned = handoffDescription("Draft", settle({ action: "review" }), at);
    expect(unowned).toContain("REVIEWER: me");
  });

  it("waits on an outside reviewer until the follow-up date, with the typed ask", () => {
    const output = handoffDescription(
      "Draft",
      settle({
        action: "review",
        reviewBy: "other",
        reviewer: "  Sam  Lee ",
        checkAfter: "2026-10-02",
        nextAction: "check the copy",
      }),
      at,
    );
    expect(output).toContain("Waiting for Sam Lee to review.");
    expect(output).toContain("LIFECYCLE: waiting");
    expect(output).toContain("WAITING: Sam Lee | check the copy | review received");
    expect(output).toContain("CHECK AFTER: 2026-10-02");
    expect(output).toContain("REVIEWER: none");
    expect(output).toContain("Work Map: review by Sam Lee");
    expect(output).toMatch(/User chose review by Sam Lee\.$/);
  });

  it("keeps fields above a History heading and appends a log after it", () => {
    const description = "Draft\nLIFECYCLE: active\n\n## History\n- created";
    const output = handoffDescription(description, settle({ action: "done" }), at);
    const [head, tail] = output.split("## History");
    expect(head).toContain("LIFECYCLE: done");
    expect(head).not.toContain("LIFECYCLE: active");
    // A heading is not a log, so the log divider is added after the history.
    expect(tail).toMatch(new RegExp(`^\\n- created\\n\\n${LOG}\\nWork Map · `));
  });

  it("records the reason it replaced, but a pause leaves the reason alone", () => {
    const description = "Draft\nSTATUS REASON: blocked on data";
    expect(
      handoffDescription(description, settle({ action: "done" }), at),
    ).toContain("\nPrevious status reason: blocked on data");
    const paused = handoffDescription(description, settle({ action: "pause" }), at);
    expect(paused).toContain("STATUS REASON: blocked on data");
    expect(paused).not.toContain("Previous status reason");
  });
});

describe("what a settle request must name", () => {
  const ok = (fields: Record<string, unknown>) =>
    settleInput.safeParse({ id, ...fields }).success;

  it("archives a session alone, and settles everything else on a task", () => {
    expect(ok({ action: "archive", threadId: "thr_a1" })).toBe(true);
    expect(ok({ action: "archive" })).toBe(false);
    expect(ok({ action: "archive", threadId: "thr_a1", taskId: "t1" })).toBe(false);
    for (const action of ["pause", "review", "done"]) {
      expect(ok({ action, taskId: "t1" })).toBe(true);
      expect(ok({ action, threadId: "thr_a1" })).toBe(false);
    }
  });

  it("needs a reviewer's name and a follow-up date for an outside review", () => {
    const review = { action: "review", taskId: "t1", reviewBy: "other" };
    expect(ok({ ...review, reviewer: "Sam", checkAfter: "2026-10-02" })).toBe(true);
    expect(ok({ ...review, reviewer: "  ", checkAfter: "2026-10-02" })).toBe(false);
    expect(ok({ ...review, reviewer: "Sam" })).toBe(false);
    const issue = settleInput.safeParse({ id, ...review, reviewer: "Sam" });
    expect(issue.error?.issues.map((i) => i.message)).toContain(
      "Name the reviewer and choose a follow-up date.",
    );
  });

  it("accepts only real calendar days", () => {
    const date = (dueDate: string) => ok({ action: "date", taskId: "t1", dueDate });
    expect(date("2028-02-29")).toBe(true);
    expect(date("2026-02-29")).toBe(false);
    expect(date("2026-13-01")).toBe(false);
    expect(date("2026-9-17")).toBe(false);
  });

  it("refuses malformed request and session ids", () => {
    expect(settleInput.safeParse({ id: "abc", action: "done", taskId: "t1" }).success).toBe(false);
    expect(ok({ action: "archive", threadId: "THR-1" })).toBe(false);
  });

  it("defaults the free-text fields so a handoff never sees undefined", () => {
    expect(settleInput.parse({ id, action: "done", taskId: "t1" })).toMatchObject({
      nextAction: "",
      reviewBy: "me",
      reviewer: "",
    });
  });
});
