// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { task } from "./fixtures";
import type { TaskComment } from "./server";
import type { WorkItem } from "./model";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  UrlLink: (props: Record<string, unknown>) => <a {...props} />,
  useRpc: () => ({ call: vi.fn() }),
}));
const {
  ageLabel,
  BarActs,
  CommentBox,
  CommentTimeline,
  commentAuthor,
  folds,
  MoreMenu,
  orderComments,
  snoozeItem,
  statusLabel,
  TaskAsk,
  TaskDescription,
  TaskFacts,
  taskAsk,
  COMMENT_FOLD,
  DESCRIPTION_FOLD,
} = await import("./task-panel");
afterEach(cleanup);

const NOW = Date.parse("2026-10-01T12:00:00Z");
function comment(overrides: Partial<TaskComment> = {}): TaskComment {
  return {
    id: "c1",
    kind: "user",
    authorName: "You",
    threadId: null,
    body: "A plain note.",
    createdAt: "2026-10-01T11:00:00Z",
    ...overrides,
  };
}
function item(overrides: Partial<WorkItem> = {}): WorkItem {
  const t = task({ status: "in_review", dueDate: "2026-09-25", dateKind: "due" });
  return {
    id: `task:${t.id}`,
    title: t.title,
    kind: "task",
    summary: t.summary,
    nextAction: t.nextAction,
    focus: false,
    signal: "inactive",
    attention: "review",
    unreadResults: 0,
    reason: "Needs review",
    score: 1,
    changed: false,
    updatedAt: NOW,
    activityAt: NOW,
    recent: false,
    threads: [],
    task: t,
    children: [],
    scope: "Test project",
    issue: false,
    bbProjectId: null,
    ...overrides,
  };
}

describe("labels and ages", () => {
  it("names statuses and ages in few words", () => {
    expect(statusLabel("in_review")).toBe("In review");
    expect(statusLabel("todo")).toBe("To do");
    expect(statusLabel("odd_state")).toBe("Odd state");
    expect(ageLabel("2026-10-01T11:59:40Z", NOW)).toBe("just now");
    expect(ageLabel("2026-10-01T11:15:00Z", NOW)).toBe("45m ago");
    expect(ageLabel("2026-10-01T05:00:00Z", NOW)).toBe("7h ago");
    expect(ageLabel("2026-09-25T12:00:00Z", NOW)).toBe("6d ago");
    expect(ageLabel("2026-09-10T12:00:00Z", NOW)).toBe("3w ago");
    expect(ageLabel("2026-06-10T12:00:00Z", NOW)).toBe("on 2026-06-10");
    expect(ageLabel("nonsense", NOW)).toBe("");
  });
  it("names comment authors by kind and orders newest first", () => {
    expect(commentAuthor(comment())).toBe("You");
    expect(
      commentAuthor(
        comment({ kind: "agent", authorName: "", threadTitle: "Worker A" }),
      ),
    ).toBe("Worker A");
    expect(
      commentAuthor(comment({ kind: "agent", authorName: "", presetName: "wiz" })),
    ).toBe("wiz");
    expect(commentAuthor(comment({ kind: "system", authorName: "" }))).toBe(
      "Tasks",
    );
    const ordered = orderComments([
      comment({ id: "a", createdAt: "2026-10-01T10:00:00Z" }),
      comment({ id: "b", createdAt: "2026-10-01T11:00:00Z" }),
      comment({ id: "c", createdAt: "2026-10-01T11:00:00Z" }),
    ]);
    expect(ordered.map((c) => c.id)).toEqual(["c", "b", "a"]);
  });
  it("takes the ask from the task's own source, else the next step, else the summary", () => {
    expect(taskAsk(task({ ask: "Pick one.", askFrom: "comment" }))).toEqual({
      ask: "Pick one.",
      from: "comment",
    });
    expect(taskAsk(task({ nextAction: "Choose", summary: "Drafted" }))).toEqual({
      ask: "Choose",
      from: "next",
    });
    expect(taskAsk(task({ nextAction: "", summary: "Drafted" }))).toEqual({
      ask: "Drafted",
      from: "summary",
    });
    expect(taskAsk(task({ nextAction: "", summary: "" }))).toBeNull();
    expect(folds("short", DESCRIPTION_FOLD)).toBe(false);
    expect(folds("x".repeat(1401), DESCRIPTION_FOLD)).toBe(true);
    expect(folds("line\n".repeat(19), DESCRIPTION_FOLD)).toBe(true);
    expect(folds("line\n".repeat(11), COMMENT_FOLD)).toBe(true);
  });
});

describe("the work column", () => {
  it("renders the ask once and the description as Markdown, folded past a sensible height", () => {
    const long = `# Heading\n\n${"A line of the plan.\n".repeat(30)}- one\n- two`;
    const { container } = render(
      <>
        <TaskAsk ask="Decide the thing." from="comment" />
        <TaskDescription text={long} lead={false} />
      </>,
    );
    const ask = container.querySelector(".wm-task-ask")!;
    expect(ask.getAttribute("data-ask-from")).toBe("comment");
    expect(ask.querySelector("h3")?.textContent).toBe("Needs you");
    expect(container.querySelector(".wm-task-description h4")?.textContent).toBe(
      "Heading",
    );
    expect(container.querySelectorAll(".wm-task-description li")).toHaveLength(2);
    expect(container.querySelector(".wm-fold-closed")).toBeTruthy();
    const toggle = within(container as HTMLElement).getByRole("button", {
      name: "Show all",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(container.querySelector(".wm-fold-closed")).toBeNull();
    expect(toggle.textContent).toBe("Show less");
  });
  it("keeps a short description open, marks the summary lead, and says when there is none", () => {
    const { container, rerender } = render(
      <TaskDescription text="Short and sweet." lead={true} />,
    );
    expect(container.querySelector(".wm-fold-toggle")).toBeNull();
    expect(container.querySelector(".wm-task-description-lead")).toBeTruthy();
    rerender(<TaskDescription text="" lead={false} loading />);
    expect(container.textContent).toContain("Loading the description…");
    rerender(<TaskDescription text="  " lead={false} />);
    expect(container.textContent).toContain("No description yet.");
  });
  it("keeps script and HTML in a description as text", () => {
    const { container } = render(
      <TaskDescription
        text={'<script>alert(1)</script><img src=x onerror="alert(2)">'}
        lead={false}
      />,
    );
    expect(container.querySelector("script, img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("the timeline", () => {
  const comments = [
    comment({ id: "old", createdAt: "2026-09-30T10:00:00Z", body: "First word." }),
    comment({
      id: "sys",
      kind: "system",
      authorName: "cli",
      createdAt: "2026-09-30T11:00:00Z",
      body: "Status changed to In Review by cli",
    }),
    comment({
      id: "agent",
      kind: "agent",
      authorName: "",
      threadId: "thr_worker",
      threadTitle: "Worker A",
      createdAt: "2026-10-01T09:00:00Z",
      body: `**Review**\n\n${"Evidence line.\n".repeat(14)}`,
    }),
    comment({
      id: "new",
      createdAt: "2026-10-01T11:30:00Z",
      body: "Needs you: pick <b>one</b>.",
    }),
  ];
  it("lists comments newest first with author and age, renders bodies as Markdown, clamps long ones and folds history", () => {
    const { container } = render(
      <CommentTimeline
        comments={comments}
        now={NOW}
        loading={false}
        error=""
        onRetry={() => {}}
      />,
    );
    expect(container.querySelector(".wm-task-comments h3")?.textContent).toBe(
      "Comments 3",
    );
    const rows = () =>
      Array.from(container.querySelectorAll<HTMLElement>(".wm-comment"));
    expect(rows().map((row) => row.dataset.kind)).toEqual([
      "user",
      "agent",
      "user",
    ]);
    const [first, second] = rows();
    expect(first.querySelector("strong")?.textContent).toBe("You");
    expect(first.querySelector("time")?.textContent).toBe("30m ago");
    expect(first.querySelector("time")?.getAttribute("title")).toMatch(
      /^2026-10-01 \d\d:30$/,
    );
    expect(first.querySelector("b")).toBeNull();
    expect(first.textContent).toContain("<b>one</b>");
    expect(second.querySelector("strong")?.textContent).toBe("Worker A");
    expect(second.querySelector("a")?.getAttribute("href")).toBe(
      "/threads/thr_worker",
    );
    expect(second.querySelector(".wm-md strong")?.textContent).toBe("Review");
    expect(second.querySelector(".wm-fold-closed")).toBeTruthy();
    expect(first.querySelector(".wm-fold-closed")).toBeNull();
    fireEvent.click(
      within(second).getByRole("button", { name: "Show more" }),
    );
    expect(second.querySelector(".wm-fold-closed")).toBeNull();
    const history = within(container as HTMLElement).getByRole("button", {
      name: "History (1)",
    });
    fireEvent.click(history);
    expect(rows().map((row) => row.dataset.kind)).toEqual([
      "user",
      "agent",
      "system",
      "user",
    ]);
    expect(rows()[2].textContent).toContain("Status changed to In Review");
    expect(history.textContent).toBe("Hide history");
  });
  it("shows an empty timeline, a loading note and an inline error with retry", () => {
    const retry = vi.fn();
    const { container, rerender } = render(
      <CommentTimeline comments={[]} now={NOW} loading={false} error="" onRetry={retry} />,
    );
    expect(container.textContent).toContain("No comments yet.");
    rerender(
      <CommentTimeline comments={[]} now={NOW} loading error="" onRetry={retry} />,
    );
    expect(container.textContent).toContain("Loading the timeline…");
    rerender(
      <CommentTimeline
        comments={[]}
        now={NOW}
        loading={false}
        error="Comments unavailable"
        onRetry={retry}
      />,
    );
    const alert = within(container as HTMLElement).getByRole("alert");
    expect(alert.textContent).toContain("Comments unavailable");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it("posts a draft with the button or ⌘↩, never empty, keeps a draft on Escape, and shows a failure inline", () => {
    const onPost = vi.fn();
    const onDraft = vi.fn();
    const { container, rerender } = render(
      <CommentBox taskKey="TEST-1" draft="" busy={false} error="" onDraft={onDraft} onPost={onPost} />,
    );
    const box = within(container as HTMLElement).getByRole("textbox", {
      name: "Comment on TEST-1",
    });
    const post = within(container as HTMLElement).getByRole("button", {
      name: "Post comment",
    });
    expect(post).toHaveProperty("disabled", true);
    fireEvent.change(box, { target: { value: "Go with B." } });
    expect(onDraft).toHaveBeenCalledWith("Go with B.");
    rerender(
      <CommentBox taskKey="TEST-1" draft="Go with B." busy={false} error="" onDraft={onDraft} onPost={onPost} />,
    );
    expect(container.textContent).toContain("Agent decides sends it with the brief");
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(onPost).toHaveBeenCalledTimes(1);
    fireEvent.click(post);
    expect(onPost).toHaveBeenCalledTimes(2);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    box.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    rerender(
      <CommentBox taskKey="TEST-1" draft="Go with B." busy error="" onDraft={onDraft} onPost={onPost} />,
    );
    expect(post.textContent).toBe("Posting…");
    rerender(
      <CommentBox taskKey="TEST-1" draft="Go with B." busy={false} error="Tasks refused it" onDraft={onDraft} onPost={onPost} />,
    );
    expect(within(container as HTMLElement).getByRole("alert").textContent).toBe(
      "Tasks refused it",
    );
    expect((box as HTMLTextAreaElement).value).toBe("Go with B.");
  });
});

describe("the side column and the bar", () => {
  it("lists the facts with a late date, its fixes, labels and files", () => {
    const work = item();
    const { container } = render(
      <TaskFacts
        item={work}
        task={work.task!}
        detail={{
          taskId: work.task!.id,
          description: "",
          createdAt: "2026-09-20T12:00:00Z",
          updatedAt: work.task!.updatedAt,
          labels: [{ id: "l1", name: "bug", color: "#f00" }],
          attachments: [
            { id: "a1", fileName: "shot.png", mime: "image/png", sizeBytes: 2048, isImage: true },
          ],
          comments: [],
          warnings: [],
        }}
        scope="Test project"
        now={NOW}
        dateFixes={<button type="button">Today</button>}
      />,
    );
    const rows = Array.from(container.querySelectorAll(".wm-facts > div"), (d) =>
      Array.from(d.children, (cell) => cell.textContent!.trim()).join(" "),
    );
    expect(rows[0]).toBe("Status In review");
    expect(rows[1]).toBe("Priority medium");
    expect(rows[2]).toBe("Due 2026-09-256d late Today");
    expect(container.querySelector(".wm-fact-late")?.textContent).toBe("6d late");
    expect(rows[3]).toBe("Project Test project");
    expect(rows[4]).toBe("Created 11d ago");
    expect(rows[5]).toMatch(/^Updated /);
    expect(rows[6]).toBe("Labels bug");
    expect(rows[7]).toBe("Attachments shot.png");
    expect(container.querySelector(".wm-fact-files a")?.getAttribute("title")).toBe(
      "image/png · 2 KB · opens in Tasks",
    );
  });
  it("offers no fixes on a date that is not past, and no date row without a date", () => {
    const future = item({ task: task({ dueDate: "2026-10-20", status: "todo" }) });
    const { container, rerender } = render(
      <TaskFacts item={future} task={future.task!} detail={null} scope="P" now={NOW} dateFixes={<button type="button">Today</button>} />,
    );
    expect(container.querySelector(".wm-fact-fixes")).toBeNull();
    expect(container.querySelector(".wm-fact-date")?.textContent).toContain("2026-10-20");
    const undated = item({ task: task({ dueDate: null }) });
    rerender(
      <TaskFacts item={undated} task={undated.task!} detail={null} scope="P" now={NOW} />,
    );
    expect(container.querySelector(".wm-fact-date")).toBeNull();
  });
  it("puts Agent decides in the lead, never Done, and says why it cannot", () => {
    const onAct = vi.fn();
    const work = item({ bbProjectId: "proj_bb" });
    const { container } = render(
      <BarActs item={work} disabled={false} busy={null} context={{ now: NOW, handedOver: {} }} onAct={onAct} />,
    );
    const buttons = Array.from(container.querySelectorAll("button"), (b) => b.textContent);
    expect(buttons).toEqual(["Agent decides"]);
    fireEvent.click(container.querySelector(".wm-bar-delegate")!);
    expect(onAct).toHaveBeenCalledWith("delegate", work);
    const unlinked = item();
    const { container: blocked } = render(
      <BarActs item={unlinked} disabled={false} busy={null} onAct={onAct} />,
    );
    expect(blocked.querySelector("button")).toHaveProperty("disabled", true);
    expect(blocked.querySelector("button")?.getAttribute("aria-label")).toContain(
      "project not linked",
    );
    const closed = item({ task: task({ status: "done" }) });
    const { container: none } = render(
      <BarActs item={closed} disabled={false} busy={null} onAct={onAct} />,
    );
    expect(none.querySelector("button")).toBeNull();
  });
  it("offers Snooze in the menu, Unsnooze once snoozed, nothing on a closed task", () => {
    const onAct = vi.fn();
    const work = item();
    const snooze = snoozeItem(work, { now: NOW, handedOver: {} }, false, onAct)!;
    expect(snooze.label).toBe("Snooze 7d");
    expect(snooze.disabled).toBe(false);
    snooze.onSelect!();
    expect(onAct).toHaveBeenCalledWith("snooze", work);
    const snoozed = item({ snoozedUntil: NOW + 86400000 });
    expect(snoozeItem(snoozed, undefined, false, onAct)?.label).toBe("Unsnooze");
    expect(snoozeItem(work, undefined, true, onAct)?.disabled).toBe(true);
    expect(snoozeItem(item({ task: task({ status: "done" }) }), undefined, false, onAct)).toBeNull();
  });
  it("opens the ⋯ menu with its items, moves with arrows, closes on Escape and after a choice", () => {
    const pick = vi.fn();
    const { container } = render(
      <MoreMenu
        label="More on TEST-1"
        items={[
          { key: "focus", label: "Bring into focus", onSelect: pick },
          { key: "pane", label: "Open in side pane", onSelect: () => {} },
          { key: "open", label: "Open in Tasks ↗", href: "/plugins/tasks/tasks/task/TEST-1" },
        ]}
      />,
    );
    const scope = within(container as HTMLElement);
    const trigger = scope.getByRole("button", { name: "More on TEST-1" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(trigger);
    const items = scope.getAllByRole("menuitem");
    expect(items.map((e) => e.textContent)).toEqual([
      "Bring into focus",
      "Open in side pane",
      "Open in Tasks ↗",
    ]);
    expect(items[2].getAttribute("href")).toBe("/plugins/tasks/tasks/task/TEST-1");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "Escape" });
    expect(scope.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(scope.getByRole("menuitem", { name: "Bring into focus" }));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(scope.queryByRole("menu")).toBeNull();
  });
});
