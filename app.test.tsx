// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { data, task, thread } from "./fixtures";
import { sessionPreview } from "./preview";
import type { rpcContract, MapTask, Preference } from "./server";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  managedProjectSchema,
  managementInput,
  type ManagementInput,
} from "./management-contract";
import {
  settleInput,
  type Settlement,
  type SettleInput,
} from "./settlement-contract";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("zooms out to more areas and project tasks without acknowledging work, and resets to actual", async () => {
  const slot = await mount({
    tasks: Array.from({ length: 16 }, (_, i) =>
      task({ id: `task${i}`, key: `TEST-${i}`, title: `Task ${i}` }),
    ),
    threads: Array.from({ length: 32 }, (_, i) =>
      thread({ id: `thr_${i}`, title: `Session ${i}` }),
    ),
  });
  await slot.findByRole("button", { name: /^Open project Test project/ });
  const roots = () =>
    slot.container.querySelectorAll("[data-layout-id]").length;
  const taskTiles = () =>
    slot.queryAllByRole("button", { name: /^Preview Task / }).length;
  expect(roots()).toBe(13);
  expect(taskTiles()).toBe(4);
  const originalIds = Array.from(
    slot.container.querySelectorAll<HTMLElement>("[data-layout-id]"),
  ).map((element) => element.dataset.layoutId);
  const beforeWrites = slot.inspection.rpcCalls.filter(
    (call) => call.method === "setPreference",
  ).length;
  fireEvent.change(slot.getByRole("slider", { name: "Map zoom level" }), {
    target: { value: "60" },
  });
  expect(roots()).toBe(32);
  expect(taskTiles()).toBe(8);
  expect(
    slot.container.querySelector(".wm-map-world")?.getAttribute("data-detail"),
  ).toBe("compact");
  expect(
    slot.container
      .querySelector<HTMLElement>(".wm-map-world")
      ?.style.getPropertyValue("zoom"),
  ).toBe("");
  expect(
    slot.container.querySelectorAll(".wm-orbit-side [data-layout-id]").length,
  ).toBeGreaterThan(20);
  expect(slot.queryByRole("button", { name: "Collapse details" })).toBeNull();
  expect(
    slot.inspection.rpcCalls.filter((call) => call.method === "setPreference"),
  ).toHaveLength(beforeWrites);
  fireEvent.click(slot.getByRole("button", { name: "Reset to actual size" }));
  expect(roots()).toBe(13);
  expect(taskTiles()).toBe(4);
  expect(
    Array.from(
      slot.container.querySelectorAll<HTMLElement>("[data-layout-id]"),
    ).map((element) => element.dataset.layoutId),
  ).toEqual(originalIds);
  fireEvent.change(slot.getByRole("slider"), { target: { value: "160" } });
  expect(roots()).toBe(5);
  expect(taskTiles()).toBe(2);
  slot.lifecycle.unmount();
});

it("reveals a longer readable session excerpt on zoom without opening or acknowledging it", async () => {
  const previewText =
    "A useful result. ".repeat(24) + "The next decision is which draft to use.";
  const slot = await mount({ tasks: [], previewText });
  const card = await slot.findByRole("button", { name: /^Preview Session/ });
  await waitFor(() => expect(card.textContent).toContain("A useful result."));
  expect(card.textContent).not.toContain("The next decision");
  fireEvent.change(slot.getByRole("slider"), { target: { value: "160" } });
  expect(card.textContent).toContain(
    "The next decision is which draft to use.",
  );
  expect(card.getAttribute("aria-expanded")).toBe("false");
  expect(slot.inspection.sidebarActionCalls).toHaveLength(0);
  expect(
    slot.inspection.rpcCalls.filter((c) => c.method === "setPreference"),
  ).toHaveLength(0);
  slot.lifecycle.unmount();
});

it("adds standalone work at narrow widths and shows task context on zoom-in without expanding the project", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: (entries: unknown[]) => void) {}
      observe() {
        this.cb([{ contentRect: { width: 800 } }]);
      }
      disconnect() {}
    },
  );
  const slot = await mount({
    tasks: [task()],
    threads: Array.from({ length: 32 }, (_, i) => thread({ id: `t${i}` })),
  });
  const project = await slot.findByRole("button", {
    name: /^Open project Test project/,
  });
  expect(slot.container.querySelectorAll("[data-layout-id]")).toHaveLength(10);
  fireEvent.change(slot.getByRole("slider"), { target: { value: "60" } });
  expect(slot.container.querySelectorAll("[data-layout-id]")).toHaveLength(28);
  fireEvent.click(slot.getByRole("button", { name: "Reset to actual size" }));
  fireEvent.change(slot.getByRole("slider"), { target: { value: "160" } });
  expect(slot.container.querySelectorAll("[data-layout-id]")).toHaveLength(4);
  const card = slot.getByRole("button", { name: /^Preview Review proposal/ });
  expect(card.textContent).toContain("Next: Choose a direction");
  expect(card.textContent).toContain("medium priority");
  expect(project.getAttribute("aria-expanded")).toBe("false");
  slot.lifecycle.unmount();
});

it("reveals more detail while keeping expanded task controls and filtered order intact", async () => {
  const slot = await mount({
    tasks: [
      task({ status: "in_review" }),
      task({
        id: "task2",
        key: "TEST-2",
        title: "Second task",
        status: "in_review",
      }),
    ],
    threads: [],
  });
  await slot.findByRole("button", { name: /^Open project Test project/ });
  fireEvent.click(slot.getByRole("button", { name: /Waiting for you/ }));
  const ids = () =>
    Array.from(
      slot.container.querySelectorAll<HTMLElement>("[data-layout-id]"),
    ).map((element) => element.dataset.layoutId);
  const before = ids();
  fireEvent.click(
    slot.getByRole("button", { name: /^Preview Review proposal/ }),
  );
  const panel = slot
    .getByRole("button", { name: "Pause here" })
    .closest(".wm-inline-detail");
  fireEvent.change(slot.getByRole("slider"), { target: { value: "150" } });
  expect(ids()).toEqual(before);
  expect(
    slot
      .getByRole("button", { name: "Pause here" })
      .closest(".wm-inline-detail"),
  ).toBe(panel);
  expect(slot.container.querySelector(".wm-zoom-details")?.textContent).toBe(
    "Status Proposal drafted",
  );
  fireEvent.click(slot.getByRole("button", { name: "Reset to actual size" }));
  expect(slot.getByRole("button", { name: "Pause here" })).toBeTruthy();
  expect(ids()).toEqual(before);
  slot.lifecycle.unmount();
});

it("keeps an expanded project and unsaved handoff in place through intermediate and compact zoom", async () => {
  const slot = await mount({ threads: [] });
  const project = await slot.findByRole("button", {
    name: /^Open project Test project/,
  });
  fireEvent.click(project);
  fireEvent.click(
    slot.getByRole("button", { name: /^Preview Review proposal/ }),
  );
  fireEvent.click(slot.getByRole("button", { name: "Pause here" }));
  const input = slot.getByRole("textbox", { name: "Next step" });
  fireEvent.change(input, { target: { value: "Keep this draft" } });
  const expanded = slot.container.querySelector(".wm-expanded-tasks");
  const ids = Array.from(
    slot.container.querySelectorAll("[data-layout-id]"),
    (e) => e.getAttribute("data-layout-id"),
  );
  for (const level of [90, 60]) {
    fireEvent.change(slot.getByRole("slider"), {
      target: { value: String(level) },
    });
    expect(slot.container.querySelector(".wm-expanded-tasks")).toBe(expanded);
    expect(slot.getByRole("textbox", { name: "Next step" })).toBe(input);
    expect((input as HTMLInputElement).value).toBe("Keep this draft");
    expect(
      Array.from(slot.container.querySelectorAll("[data-layout-id]"), (e) =>
        e.getAttribute("data-layout-id"),
      ),
    ).toEqual(ids);
    expect(slot.getByText(/Layout held while expanded/)).toBeTruthy();
  }
  slot.lifecycle.unmount();
});

async function mount(
  options: {
    unavailable?: boolean;
    done?: boolean;
    rejectPreview?: boolean;
    previewText?: string;
    tasks?: MapTask[];
    threads?: PluginSidebarThread[];
    preferences?: Record<string, Preference>;
    attachmentError?: boolean;
    linkedBbProjectId?: string;
    createRequests?: { taskId?: string; request: { projectId: string } }[];
    settleRequests?: SettleInput[];
    settleError?: boolean;
    manageRequests?: ManagementInput[];
  } = {},
) {
  const app = await loadPluginApp(() => import("./app"));
  const storedPreferences = { ...options.preferences };
  const settled: Settlement[] = [];
  const projects = [
    managedProjectSchema.parse({
      id: "p1",
      name: "Test project",
      prefix: "TEST",
      linkedBbProjectId: options.linkedBbProjectId ?? null,
    }),
  ];
  const tasks = options.tasks ?? [
    task({ threadIds: ["thr_test"], status: options.done ? "done" : "todo" }),
  ];
  return renderSlot<{ subPath: string }, typeof rpcContract>(
    app.navPanels[0],
    { subPath: "" },
    {
      context: { projectId: "proj_unrelated" },
      rpc: {
        managementOptions: () => ({
          projects,
          folders: [{ id: "folder", name: "Work" }],
          bbProjects: [{ id: "proj_unrelated", name: "BB work" }],
        }),
        manage: (raw) => {
          const input = managementInput.parse(raw);
          options.manageRequests?.push(input);
          if (input.action === "createProject") {
            const project = managedProjectSchema.parse({ ...input, id: "p2" });
            projects.push(project);
            return { project };
          }
          if (input.action === "editProject") {
            const index = projects.findIndex((p) => p.id === input.projectId);
            projects[index] = managedProjectSchema.parse({
              ...projects[index],
              ...input,
            });
            return { project: projects[index] };
          }
          if (input.action === "createTask") {
            const created = task({
              id: "tasknew",
              key: "TEST-2",
              projectId: input.projectId,
              title: input.title,
              status: "backlog",
            });
            tasks.push(created);
            return { task: created };
          }
          tasks
            .find((t) => t.id === input.taskId)!
            .threadIds.push(input.threadId);
          return { threadId: input.threadId };
        },
        settledToday: () => settled,
        settle: (raw) => {
          const input = settleInput.parse(raw);
          options.settleRequests?.push(input);
          if (options.settleError)
            throw new Error("Task changed since you opened it");
          const result: Settlement = {
            id: input.id,
            at: Date.now(),
            action: input.action,
            title: "TEST-1 · Review proposal",
            taskId: input.taskId ?? null,
            taskKey: input.taskId ? "TEST-1" : null,
            threadId: input.threadId ?? null,
            nextAction: input.nextAction,
            reviewer: input.reviewer,
            checkAfter: input.checkAfter ?? null,
            taskUpdated: !!input.taskId,
            archivedThreadIds: input.threadId ? [input.threadId] : [],
            undone: false,
            warning: null,
          };
          settled.push(result);
          return result;
        },
        undoSettlement: ({ id }) => {
          const row = settled.find((row) => row.id === id)!;
          settled.splice(settled.indexOf(row), 1);
          return { ...row, undone: true };
        },
        createSession: (input) => {
          options.createRequests?.push(input);
          return {
            threadId: "thr_created",
            taskId: input.taskId ?? null,
            attachmentError: options.attachmentError
              ? "Session started, attachment failed."
              : null,
          };
        },
        retrySessionAttachment: () => ({
          threadId: "thr_created",
          taskId: "task1",
          attachmentError: null,
        }),
        snapshot: () => ({
          ...data(tasks),
          projects,
        }),
        preferences: () => storedPreferences,
        setPreference: (input) => {
          storedPreferences[input.id] = {
            ...storedPreferences[input.id],
            ...(input.focus === undefined ? {} : { focus: input.focus }),
            ...(input.seenAt === undefined ? {} : { seenAt: input.seenAt }),
            ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
          };
          return storedPreferences[input.id];
        },
        previews: () => {
          if (options.rejectPreview) throw new Error("RPC disconnected");
          return {
            thr_test: {
              ...sessionPreview(
                options.unavailable
                  ? "Preview unavailable"
                  : (options.previewText ?? "The proposal is ready to review."),
              ),
              ...(options.unavailable ? { excerpt: "" } : {}),
              error: !!options.unavailable,
            },
          };
        },
      },
      sidebarThreads: {
        status: "ready",
        projects: [],
        threads: options.threads ?? [
          thread({ indicator: "unread-success", isUnread: true }),
        ],
      },
    },
  );
}
describe("existing session chat", () => {
  it("opens a running session in its filtered row without creating or navigating, and preserves it through zoom and activity changes", async () => {
    const session = thread({ title: "Running session", indicator: "runtime" });
    const slot = await mount({ tasks: [], threads: [session] });
    await slot.findByRole("button", { name: /^Preview Running session/ });
    fireEvent.click(slot.getByRole("button", { name: /^Working/ }));
    fireEvent.click(
      slot.getByRole("button", { name: /^Preview Running session/ }),
    );
    const row = slot
      .getByRole("region", { name: "Expanded: Running session" })
      .closest(".wm-result");
    expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
    const chat = slot.getByTestId("bb-thread-chat");
    expect(chat.getAttribute("data-thread-id")).toBe(session.id);
    expect(chat.getAttribute("data-permission-policy")).toBe("inherit");
    expect(chat.getAttribute("data-layout")).toBe("contained");
    expect(chat.getAttribute("data-focus-request")).toBe("1");
    expect(chat.closest(".wm-result")).toBe(row);
    expect(chat.closest(".wm-detail-section")).toBeNull();
    fireEvent.change(slot.getByRole("slider"), { target: { value: "160" } });
    expect(slot.getByTestId("bb-thread-chat")).toBe(chat);
    const key = new KeyboardEvent("keydown", {
      key: "0",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    fireEvent(chat, key);
    expect(key.defaultPrevented).toBe(false);
    expect((slot.getByRole("slider") as HTMLInputElement).value).toBe("160");
    session.indicator = "none";
    fireEvent.click(slot.getByRole("button", { name: "Refresh map" }));
    await waitFor(() =>
      expect(
        slot.getByRole("region", { name: "Live session: Running session" })
          .textContent,
      ).toContain("Inactive"),
    );
    expect(slot.getByTestId("bb-thread-chat")).toBe(chat);
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "createSession"),
    ).toBe(false);
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    session.indicator = "unread-success";
    session.latestAttentionAt += 1;
    fireEvent.click(slot.getByRole("button", { name: "Refresh map" }));
    await waitFor(() =>
      expect(
        slot.getByRole("region", { name: "Live session: Running session" })
          .textContent,
      ).toContain("Ready to read"),
    );
    // The SDK stub does not implement host read tracking. Work Map must not
    // acknowledge a hidden excerpt on the host chat's behalf.
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Back to summary" }));
    expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
    expect(
      slot
        .getByRole("region", { name: "Expanded: Running session" })
        .closest(".wm-result"),
    ).toBe(row);
    slot.lifecycle.unmount();
  });
  it("targets the chosen attached session, supports the optional pane, and steps back from chat before closing the task", async () => {
    const slot = await mount({
      tasks: [task({ threadIds: ["thr_test", "thr_second"] })],
      threads: [
        thread({ title: "First agent", indicator: "runtime" }),
        thread({
          id: "thr_second",
          title: "Second agent",
          hasPendingInteraction: true,
        }),
      ],
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
    fireEvent.click(
      slot.getByRole("button", { name: /^Second agent.*Attached/ }),
    );
    expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
    expect(
      slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"),
    ).toBe("thr_second");
    const taskDetail = slot.getByRole("region", {
      name: "Expanded: Review proposal",
    });
    fireEvent.click(
      within(taskDetail).getByRole("button", { name: "Open in side pane" }),
    );
    expect(
      slot.getByTestId("bb-thread-chat").closest(".wm-preview"),
    ).not.toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Expand in map" }));
    const focusRequest = Number(
      slot.getByTestId("bb-thread-chat").getAttribute("data-focus-request"),
    );
    fireEvent.click(
      slot.getByRole("button", { name: /^Preview Review proposal/ }),
    );
    expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
    expect(
      slot.getByRole("region", { name: "Expanded: Review proposal" }),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
    expect(
      Number(
        slot.getByTestId("bb-thread-chat").getAttribute("data-focus-request"),
      ),
    ).toBeGreaterThan(focusRequest);
    const consumedEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    consumedEscape.preventDefault();
    fireEvent(slot.getByTestId("bb-thread-chat"), consumedEscape);
    expect(slot.getByTestId("bb-thread-chat")).toBeTruthy();
    fireEvent.keyDown(slot.getByTestId("bb-thread-chat"), { key: "Escape" });
    expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
    expect(
      slot.getByRole("region", { name: "Expanded: Review proposal" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        slot.getByRole("button", { name: "Chat here" }),
      ),
    );
    fireEvent.keyDown(slot.getByRole("button", { name: "Chat here" }), {
      key: "Escape",
    });
    expect(
      slot.queryByRole("region", { name: "Expanded: Review proposal" }),
    ).toBeNull();
    expect(
      slot.getByRole("region", { name: "Expanded: Test project" }),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("can open native chat when the excerpt request fails and returns to a summary after starting a new draft", async () => {
    const slot = await mount({
      rejectPreview: true,
      threads: [thread({ indicator: "runtime" })],
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    await slot.findByText(/Session preview could not be loaded/);
    fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
    expect(
      slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"),
    ).toBe("thr_test");
    const detail = slot.getByRole("region", {
      name: "Expanded: Review proposal",
    });
    fireEvent.click(
      within(detail).getByRole("button", { name: "New session" }),
    );
    expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
    expect(slot.getByTestId("bb-new-thread-composer")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Close draft" }));
    expect(slot.getByRole("button", { name: "Chat here" })).toBeTruthy();
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "createSession"),
    ).toBe(false);
    slot.lifecycle.unmount();
  });
  it("unmounts chat when its session is archived and keeps the full-session fallback", async () => {
    const session = thread({ indicator: "runtime" });
    const slot = await mount({ tasks: [], threads: [session] });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Session/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
    session.isArchived = true;
    fireEvent.click(slot.getByRole("button", { name: "Refresh map" }));
    await waitFor(() =>
      expect(slot.queryByTestId("bb-thread-chat")).toBeNull(),
    );
    expect(slot.queryByRole("button", { name: "Chat here" })).toBeNull();
    expect(
      slot.getByText(
        "Archived session. Open the full session to view or reopen it.",
      ),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Open full session" }));
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "thr_test", options: undefined },
    ]);
    slot.lifecycle.unmount();
  });
});

describe("area management", () => {
  it("shows inherited project focus accurately in Manage areas", async () => {
    const slot = await mount({ threads: [thread({ isPinned: true })] });
    await slot.findByRole("button", { name: /^Open project Test project/ });
    fireEvent.click(slot.getByRole("button", { name: "Manage areas" }));
    const focus = await slot.findByRole("button", { name: "Focus from tasks" });
    expect(focus.getAttribute("aria-pressed")).toBe("true");
    expect(focus.hasAttribute("disabled")).toBe(true);
    slot.lifecycle.unmount();
  });
  it("edits metadata and preserves an already expanded project", async () => {
    const requests: ManagementInput[] = [];
    const slot = await mount({ threads: [], manageRequests: requests });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Open project Test project/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Manage Test project" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Edit project" }));
    fireEvent.change(await slot.findByLabelText("Name"), {
      target: { value: "Updated project" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save project" }));
    await slot.findByRole("region", { name: "Expanded: Updated project" });
    expect(requests[0]).toMatchObject({
      action: "editProject",
      projectId: "p1",
      name: "Updated project",
      expected: { name: "Test project" },
    });
    slot.lifecycle.unmount();
  });
  it("preserves expanded task details while editing its project", async () => {
    const slot = await mount({ threads: [] });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Open project Test project/ }),
    );
    fireEvent.click(
      slot.getByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Manage Test project" }));
    fireEvent.click(slot.getByRole("menuitem", { name: "Edit project" }));
    fireEvent.change(await slot.findByLabelText("Name"), {
      target: { value: "Renamed area" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save project" }));
    await slot.findByRole("button", { name: /^Open project Renamed area/ });
    expect(
      slot.getByRole("region", { name: "Expanded: Review proposal" }),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("hides an area only from Overview and restores it from Manage areas", async () => {
    const slot = await mount({
      tasks: [task({ status: "in_review" })],
      threads: [],
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Manage Test project" }),
    );
    fireEvent.click(slot.getByRole("menuitem", { name: /Hide from Overview/ }));
    await waitFor(() =>
      expect(slot.queryByRole("button", { name: /^Open project/ })).toBeNull(),
    );
    fireEvent.click(slot.getByRole("button", { name: /Waiting for you/ }));
    expect(
      slot.getByRole("button", { name: /^Preview Review proposal/ }),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Overview" }));
    fireEvent.click(slot.getByRole("button", { name: "Manage areas" }));
    fireEvent.click(
      await slot.findByRole("button", { name: "Restore Test project" }),
    );
    await slot.findByRole("button", { name: /^Open project Test project/ });
    expect(
      slot.inspection.rpcCalls.filter(
        (call) => call.method === "manage" || call.method === "settle",
      ),
    ).toHaveLength(0);
    slot.lifecycle.unmount();
  });
  it("creates a project with explicit folder and workspace and reveals the empty area", async () => {
    const requests: ManagementInput[] = [];
    const slot = await mount({ manageRequests: requests, threads: [] });
    await slot.findByRole("button", { name: /^Open project Test project/ });
    fireEvent.click(slot.getByRole("button", { name: "New project" }));
    fireEvent.change(await slot.findByLabelText("Name"), {
      target: { value: "Launch" },
    });
    fireEvent.change(slot.getByLabelText("Task prefix"), {
      target: { value: "launch" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Create project" }));
    await slot.findByRole("region", { name: "Expanded: Launch" });
    expect(requests[0]).toMatchObject({
      action: "createProject",
      name: "Launch",
      prefix: "LAUNCH",
      folderId: "folder",
      linkedBbProjectId: "proj_unrelated",
    });
    slot.lifecycle.unmount();
  });
  it("adds a task inline and reveals it without starting a session", async () => {
    const requests: ManagementInput[] = [];
    const slot = await mount({ manageRequests: requests, threads: [] });
    fireEvent.click(
      await slot.findByRole("button", { name: "Add to Test project" }),
    );
    fireEvent.click(slot.getByRole("menuitem", { name: "New task" }));
    fireEvent.change(await slot.findByLabelText("Task title"), {
      target: { value: "Prepare launch" },
    });
    expect(
      slot.getByLabelText("Task title").closest(".wm-expanded-project"),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Add task" }));
    await slot.findByRole("region", { name: "Expanded: Prepare launch" });
    expect(requests[0]).toMatchObject({
      action: "createTask",
      projectId: "p1",
      title: "Prepare launch",
    });
    expect(
      slot.inspection.rpcCalls.filter(
        (call) => call.method === "createSession",
      ),
    ).toHaveLength(0);
    slot.lifecycle.unmount();
  });
  it("connects an existing session through a chosen open task", async () => {
    const requests: ManagementInput[] = [];
    const slot = await mount({
      tasks: [task()],
      threads: [thread({ title: "Planning" })],
      manageRequests: requests,
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Add to Test project" }),
    );
    fireEvent.click(
      slot.getByRole("menuitem", { name: "Connect existing session" }),
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Connect Planning" }),
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      action: "attachSession",
      projectId: "p1",
      taskId: "task1",
      threadId: "thr_test",
    });
    await waitFor(() =>
      expect(
        slot.queryByRole("button", { name: /^Preview Planning/ }),
      ).toBeNull(),
    );
    slot.lifecycle.unmount();
  });
  it("uses Escape to close the menu without collapsing the area", async () => {
    const slot = await mount({ threads: [] });
    fireEvent.click(await slot.findByRole("button", { name: /^Open project/ }));
    const trigger = slot.getByRole("button", { name: "Manage Test project" });
    fireEvent.click(trigger);
    fireEvent.keyDown(slot.getByRole("menuitem", { name: "Edit project" }), {
      key: "Escape",
    });
    expect(slot.queryByRole("menu")).toBeNull();
    expect(
      slot.getByRole("region", { name: "Expanded: Test project" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
    slot.lifecycle.unmount();
  });
});
describe("preview and native navigation", () => {
  it.each(["todo", "in_review"])(
    "signals unread results on a neutral project and uses the plural badge for its %s task",
    async (status) => {
      const slot = await mount({
        tasks: [task({ status, threadIds: ["thr_test", "thr_other"] })],
        threads: [
          thread({ indicator: "unread-success" }),
          thread({ id: "thr_other", indicator: "unread-success" }),
        ],
      });
      const project = await slot.findByRole("button", {
        name: /^Open project Test project/,
      });
      expect(
        project.closest(".wm-island")?.getAttribute("data-has-results"),
      ).toBe("true");
      expect(project.textContent).toContain("2 ready to read");
      expect(project.querySelector(".wm-result-icon")).toBeNull();
      const card = slot.getByRole("button", {
        name: /^Preview Review proposal/,
      });
      expect(within(card).getByText("2 results ready to read")).toBeTruthy();
      expect(card.getAttribute("aria-label")).toContain(
        "2 results ready to read",
      );
      expect(
        slot.getByRole("button", { name: "Ready to read 1" }),
      ).toBeTruthy();
      expect(slot.inspection.sidebarActionCalls).toEqual([]);
      slot.lifecycle.unmount();
    },
  );
  it("moves a newly finished standalone session beside the focus and gives it a readable badge without marking it seen", async () => {
    const finished = thread({ title: "Finished session" });
    const slot = await mount({
      tasks: [],
      threads: [
        thread({ id: "thr_pin", isPinned: true }),
        thread({ id: "thr_working", indicator: "runtime" }),
        finished,
        ...Array.from({ length: 6 }, (_, i) => thread({ id: `thr_quiet${i}` })),
      ],
    });
    const card = await slot.findByRole("button", {
      name: /^Preview Finished session/,
    });
    expect(card.classList.contains("wm-unread")).toBe(false);
    finished.indicator = "unread-success";
    finished.isUnread = true;
    finished.latestAttentionAt = Date.now();
    await slot.behavior.emitRealtime("preferences-changed", {});
    const ready = await slot.findByRole("button", {
      name: /^Preview Finished session.*Ready to read/,
    });
    expect(ready.closest(".wm-orbit-near")).toBeTruthy();
    const badge = within(ready).getByText("Ready to read");
    expect(badge.classList.contains("wm-unread")).toBe(true);
    expect(badge.querySelector(".wm-result-icon")).toBeTruthy();
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "setPreference"),
    ).toBe(false);
    slot.lifecycle.unmount();
  });
  it("renders intact Markdown in expanded previews and keeps table syntax out of cards", async () => {
    const markdown =
      "Options ready.\n\n| Option | Status |\n| --- | --- |\n| First | Ready |";
    const slot = await mount({ tasks: [], previewText: markdown });
    const card = await slot.findByRole("button", { name: /^Preview Session/ });
    await waitFor(() => expect(card.textContent).toContain("Options ready."));
    expect(card.textContent).not.toContain("|");
    expect(card.getAttribute("aria-label")).not.toContain("|");
    fireEvent.click(card);
    const content = await slot.findByTestId("bb-markdown");
    expect(content.textContent).toBe(markdown);
    expect(content.closest("p, button")).toBeNull();
    expect(content.closest('[role="region"]')?.getAttribute("tabindex")).toBe(
      "0",
    );
    fireEvent.click(slot.getByRole("button", { name: "Open in side pane" }));
    expect(slot.getByTestId("bb-markdown").textContent).toBe(markdown);
    expect(slot.getByTestId("bb-markdown").closest(".wm-preview")).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("labels shortened responses and keeps the full session accessible", async () => {
    const slot = await mount({
      tasks: [],
      previewText: "Long response.\n\n" + "| First | Ready |\n".repeat(500),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Session/ }),
    );
    const content = await slot.findByTestId("bb-markdown");
    expect(content.textContent!.length).toBeLessThanOrEqual(6000);
    expect(
      slot.getByText(
        /Shortened response\. Open the full session for the rest\./,
      ),
    ).toBeTruthy();
    expect(
      slot.getByRole("button", { name: /Open full session/ }),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("keeps task details readable before showing handoff fields", async () => {
    const settleRequests: SettleInput[] = [];
    const slot = await mount({ settleRequests });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    const detail = slot.getByRole("region", {
      name: "Expanded: Review proposal",
    });
    const card = detail.closest(".wm-item-expanded")!;
    expect(
      within(card as HTMLElement).getAllByText("Choose a direction"),
    ).toHaveLength(1);
    expect(
      card.querySelector(".wm-tile")?.getAttribute("aria-label"),
    ).not.toContain("Choose a direction");
    expect(slot.queryByLabelText("Next step")).toBeNull();
    expect(slot.queryByLabelText("Review by")).toBeNull();
    const summary = within(detail).getByRole("region", {
      name: "Task summary",
    });
    const sessions = within(detail).getByRole("region", {
      name: "Connected sessions",
    });
    const settle = within(detail).getByRole("region", {
      name: "Settle this work",
    });
    expect(
      summary.compareDocumentPosition(sessions) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      sessions.compareDocumentPosition(settle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(sessions).getByRole("button", { name: "New session" }),
    ).toBeTruthy();
    expect(
      slot.getByRole("checkbox", { name: /Archive viewed session/ }),
    ).toHaveProperty("checked", true);
    expect(settleRequests).toEqual([]);
    slot.lifecycle.unmount();
  });
  it("cancels a handoff with Escape before collapsing the task and keeps canceled edits out of writes", async () => {
    const settleRequests: SettleInput[] = [];
    const slot = await mount({ settleRequests });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    const pause = slot.getByRole("button", { name: "Pause here" });
    fireEvent.click(pause);
    const nextStep = slot.getByLabelText("Next step");
    expect(document.activeElement).toBe(nextStep);
    expect(slot.queryByLabelText("Review by")).toBeNull();
    fireEvent.change(nextStep, { target: { value: "Canceled next step" } });
    fireEvent.keyDown(nextStep, { key: "Escape" });
    expect(document.activeElement).toBe(pause);
    expect(slot.queryByLabelText("Next step")).toBeNull();
    expect(
      slot.getByRole("region", { name: "Expanded: Review proposal" }),
    ).toBeTruthy();
    expect(settleRequests).toEqual([]);
    fireEvent.click(pause);
    expect(slot.getByLabelText("Next step")).toHaveProperty(
      "value",
      "Choose a direction",
    );
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    fireEvent.click(slot.getByRole("button", { name: "Task done" }));
    await slot.findByRole("region", { name: "Settled today" });
    expect(settleRequests).toHaveLength(1);
    expect(settleRequests[0]).toMatchObject({
      action: "done",
      taskId: "task1",
      threadId: "thr_test",
      nextAction: "Choose a direction",
    });
    slot.lifecycle.unmount();
  });
  it("keeps the compact task layout in the pane and handoff draft through zoom", async () => {
    const slot = await mount({
      threads: [],
      tasks: [task({ summary: "Choose a direction" })],
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.click(
      within(
        slot.getByRole("region", { name: "Expanded: Review proposal" }),
      ).getByRole("button", { name: "Open in side pane" }),
    );
    const pane = slot.getByRole("complementary", {
      name: "Preview: Review proposal",
    });
    expect(within(pane).getAllByText("Choose a direction")).toHaveLength(1);
    expect(
      within(pane).queryByRole("heading", { name: "Current status" }),
    ).toBeNull();
    expect(
      within(pane).getByText("Start a session to work on this task."),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Ready for review" }));
    const input = slot.getByLabelText("Next step");
    fireEvent.change(input, { target: { value: "Review these numbers" } });
    fireEvent.change(slot.getByRole("slider"), { target: { value: "160" } });
    expect(slot.getByLabelText("Next step")).toBe(input);
    expect(input).toHaveProperty("value", "Review these numbers");
    slot.lifecycle.unmount();
  });
  it("keeps task actions outside the live chat frame and usable while chatting", async () => {
    const settleRequests: SettleInput[] = [];
    const slot = await mount({ settleRequests });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
    const chat = slot.getByTestId("bb-thread-chat");
    const done = slot.getByRole("button", { name: "Task done" });
    expect(done.closest(".wm-inline-detail")).toBe(
      chat.closest(".wm-inline-detail"),
    );
    expect(done.closest(".wm-live-session")).toBeNull();
    fireEvent.change(slot.getByRole("slider"), { target: { value: "60" } });
    expect(slot.getByTestId("bb-thread-chat")).toBe(chat);
    fireEvent.click(done);
    await slot.findByRole("region", { name: "Settled today" });
    expect(settleRequests[0]).toMatchObject({
      action: "done",
      taskId: "task1",
      threadId: "thr_test",
    });
    slot.lifecycle.unmount();
  });
  it("leaves the review draft open on select Escape and never submits it through Task done", async () => {
    const settleRequests: SettleInput[] = [];
    const slot = await mount({ settleRequests });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Ready for review" }));
    fireEvent.change(slot.getByLabelText("Next step"), {
      target: { value: "Unsaved review draft" },
    });
    const reviewer = slot.getByLabelText("Review by");
    fireEvent.change(reviewer, { target: { value: "other" } });
    fireEvent.keyDown(reviewer, { key: "Escape" });
    expect(slot.getByLabelText("Review request")).toHaveProperty(
      "value",
      "Unsaved review draft",
    );
    expect(slot.getByRole("button", { name: "Save review" })).toBeTruthy();
    expect(settleRequests).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Task done" }));
    await slot.findByRole("region", { name: "Settled today" });
    expect(settleRequests[0]).toMatchObject({
      action: "done",
      nextAction: "Choose a direction",
      reviewBy: "me",
      reviewer: "",
    });
    expect(settleRequests[0].checkAfter).toBeUndefined();
    slot.lifecycle.unmount();
  });
  it("opens review fields on demand, then contracts and offers persistent Undo", async () => {
    const settleRequests: SettleInput[] = [];
    const slot = await mount({ settleRequests });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    expect(slot.queryByLabelText("Next step")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Ready for review" }));
    expect(settleRequests).toHaveLength(0);
    fireEvent.change(slot.getByLabelText("Next step"), {
      target: { value: "Check the new numbers" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save review" }));
    const strip = await slot.findByRole("region", { name: "Settled today" });
    await waitFor(() =>
      expect(
        slot.queryByRole("region", { name: "Expanded: Review proposal" }),
      ).toBeNull(),
    );
    expect(settleRequests).toHaveLength(1);
    expect(settleRequests[0]).toMatchObject({
      action: "review",
      taskId: "task1",
      threadId: "thr_test",
      reviewBy: "me",
      nextAction: "Check the new numbers",
    });
    fireEvent.click(within(strip).getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(slot.queryByRole("region", { name: "Settled today" })).toBeNull(),
    );
  });
  it("validates an external review and can leave the session open", async () => {
    const settleRequests: SettleInput[] = [];
    const slot = await mount({ settleRequests });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Ready for review" }));
    fireEvent.change(slot.getByLabelText("Review by"), {
      target: { value: "other" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save review" }));
    expect(await slot.findByRole("alert")).toHaveProperty(
      "textContent",
      "Name the reviewer and choose a follow-up date.",
    );
    expect(settleRequests).toHaveLength(0);
    fireEvent.change(slot.getByLabelText("Reviewer"), {
      target: { value: "Sam" },
    });
    fireEvent.change(slot.getByLabelText("Follow up on"), {
      target: { value: "2026-10-02" },
    });
    fireEvent.click(
      slot.getByRole("checkbox", { name: /Archive viewed session/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Save review" }));
    await slot.findByRole("region", { name: "Settled today" });
    expect(settleRequests[0]).toMatchObject({
      reviewer: "Sam",
      checkAfter: "2026-10-02",
      reviewBy: "other",
    });
    expect(settleRequests[0].threadId).toBeUndefined();
  });
  it("keeps expanded content and handoff text after a failed settle", async () => {
    const slot = await mount({ settleError: true });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Pause here" }));
    fireEvent.click(slot.getByRole("button", { name: "Save and pause" }));
    await slot.findByText("Task changed since you opened it");
    expect(slot.getByLabelText("Next step")).toHaveProperty(
      "value",
      "Choose a direction",
    );
    expect(slot.queryByRole("region", { name: "Settled today" })).toBeNull();
  });
  it("archives an unlinked session without changing a task", async () => {
    const settleRequests: SettleInput[] = [];
    const slot = await mount({ tasks: [], settleRequests });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Session/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Archive session" }));
    await slot.findByRole("region", { name: "Settled today" });
    expect(settleRequests[0]).toMatchObject({
      action: "archive",
      threadId: "thr_test",
    });
    expect(settleRequests[0].taskId).toBeUndefined();
  });
  it("retries after Refresh with the same action id and the current task version", async () => {
    const settleRequests: SettleInput[] = [];
    const options = {
      settleError: true,
      settleRequests,
      tasks: [task({ threadIds: ["thr_test"] })],
    };
    const slot = await mount(options);
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Ready for review" }));
    fireEvent.click(slot.getByRole("button", { name: "Save review" }));
    await slot.findByText("Task changed since you opened it");
    options.settleError = false;
    options.tasks[0] = task({
      threadIds: ["thr_test"],
      updatedAt: "2026-09-17T14:00:00Z",
      summary: "New information from the task",
    });
    fireEvent.click(slot.getByRole("button", { name: "Refresh map" }));
    await slot.findByText("New information from the task");
    fireEvent.click(slot.getByRole("button", { name: "Save review" }));
    await slot.findByRole("region", { name: "Settled today" });
    expect(settleRequests[1].id).toBe(settleRequests[0].id);
    expect(settleRequests[1].expectedUpdatedAt).toBe("2026-09-17T14:00:00Z");
  });
  it("settles the newly created task session rather than the older preview", async () => {
    const settleRequests: SettleInput[] = [];
    const slot = await mount({ settleRequests });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    const area = slot.getByRole("region", {
      name: "Expanded: Review proposal",
    });
    fireEvent.click(within(area).getByRole("button", { name: "New session" }));
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await slot.findByTestId("bb-thread-chat");
    fireEvent.click(slot.getByRole("button", { name: "Pause here" }));
    fireEvent.click(slot.getByRole("button", { name: "Save and pause" }));
    await slot.findByRole("region", { name: "Settled today" });
    expect(settleRequests[0].threadId).toBe("thr_created");
  });
  it("creates a standalone session from the toolbar without inventing a task link", async () => {
    const createRequests: {
      taskId?: string;
      request: { projectId: string };
    }[] = [];
    const slot = await mount({ createRequests });
    fireEvent.click(await slot.findByRole("button", { name: "New session" }));
    expect(
      slot
        .getByTestId("bb-new-thread-composer")
        .getAttribute("data-default-project-id"),
    ).toBe("proj_unrelated");
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    const chat = await slot.findByTestId("bb-thread-chat");
    expect(chat.getAttribute("data-layout")).toBe("contained");
    expect(chat.parentElement?.classList.contains("wm-created-chat")).toBe(
      true,
    );
    expect(
      chat
        .closest(".wm-session-launcher")
        ?.parentElement?.classList.contains("wm-canvas"),
    ).toBe(true);
    expect(createRequests[0].taskId).toBeUndefined();
    expect(createRequests[0].request.projectId).toBe("proj_unrelated");
    fireEvent.change(slot.getByRole("slider"), { target: { value: "160" } });
    expect(slot.getByTestId("bb-thread-chat")).toBe(chat);
    fireEvent.click(slot.getByRole("button", { name: "Collapse session" }));
    expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
  });
  it("preserves the project draft and placement through zoom, then contains its created chat", async () => {
    const createRequests: {
      taskId?: string;
      request: { projectId: string };
    }[] = [];
    const slot = await mount({ createRequests });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Open project Test project/ }),
    );
    const area = slot.getByRole("region", { name: "Expanded: Test project" });
    fireEvent.click(within(area).getByRole("button", { name: "New session" }));
    const composer = slot.getByTestId("bb-new-thread-composer");
    expect(composer.closest(".wm-island")).toBe(area.closest(".wm-island"));
    expect(composer.getAttribute("data-default-model")).toBe("");
    expect(composer.getAttribute("data-default-permission-mode")).toBe("");
    expect(composer.getAttribute("data-default-project-id")).toBe("");
    const roots = () =>
      Array.from(
        slot.container.querySelectorAll<HTMLElement>("[data-layout-id]"),
      ).map((element) => element.dataset.layoutId);
    const before = roots();
    const input = slot.getByTestId(
      "bb-new-thread-composer-input",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: { value: "Keep my draft while I zoom" },
    });
    fireEvent.change(slot.getByRole("slider"), { target: { value: "60" } });
    expect(roots()).toEqual(before);
    expect(slot.getByTestId("bb-new-thread-composer")).toBe(composer);
    fireEvent.click(slot.getByRole("button", { name: "Reset to actual size" }));
    expect(input.value).toBe("Keep my draft while I zoom");
    expect(roots()).toEqual(before);
    expect(createRequests).toEqual([]);
    fireEvent.keyDown(slot.getByTestId("bb-new-thread-composer-input"), {
      key: "Escape",
    });
    expect(slot.queryByTestId("bb-new-thread-composer")).toBeNull();
    expect(
      slot.getByRole("region", { name: "Expanded: Test project" }),
    ).toBeTruthy();
    fireEvent.click(within(area).getByRole("button", { name: "New session" }));
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    const chat = await slot.findByTestId("bb-thread-chat");
    expect(chat.getAttribute("data-layout")).toBe("contained");
    expect(chat.parentElement?.classList.contains("wm-created-chat")).toBe(
      true,
    );
    expect(chat.closest(".wm-island")).toBe(area.closest(".wm-island"));
    fireEvent.change(slot.getByRole("slider"), { target: { value: "60" } });
    expect(slot.getByTestId("bb-thread-chat")).toBe(chat);
    expect(roots()).toEqual(before);
  });
  it("starts a task session inside its filtered row with the linked BB project", async () => {
    const createRequests: {
      taskId?: string;
      request: { projectId: string };
    }[] = [];
    const slot = await mount({
      createRequests,
      tasks: [task({ status: "in_review" })],
      threads: [],
      linkedBbProjectId: "proj_linked",
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Waiting for you 1" }),
    );
    fireEvent.click(
      slot.getByRole("button", { name: /^Preview Review proposal/ }),
    );
    const detail = slot.getByRole("region", {
      name: "Expanded: Review proposal",
    });
    const row = detail.closest(".wm-result");
    fireEvent.click(
      within(detail).getByRole("button", { name: "New session" }),
    );
    expect(
      slot
        .getByTestId("bb-new-thread-composer")
        .getAttribute("data-default-project-id"),
    ).toBe("proj_linked");
    expect(
      (slot.getByTestId("bb-new-thread-composer-input") as HTMLTextAreaElement)
        .value,
    ).toContain("TEST-1");
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    const chat = await slot.findByTestId("bb-thread-chat");
    expect(chat.getAttribute("data-thread-id")).toBe("thr_created");
    expect(chat.getAttribute("data-layout")).toBe("contained");
    expect(chat.parentElement?.classList.contains("wm-created-chat")).toBe(
      true,
    );
    expect(chat.closest(".wm-result")).toBe(row);
    expect(createRequests[0].taskId).toBe("task1");
    expect(createRequests[0].request.projectId).toBe("proj_linked");
    expect(slot.queryByTestId("bb-new-thread-composer")).toBeNull();
    fireEvent.change(slot.getByRole("slider"), { target: { value: "60" } });
    expect(slot.getByTestId("bb-thread-chat")).toBe(chat);
    expect(chat.closest(".wm-result")).toBe(row);
  });
  it("keeps a started session usable when attachment fails, with a separate retry", async () => {
    const slot = await mount({ attachmentError: true, threads: [] });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    const detail = slot.getByRole("region", {
      name: "Expanded: Review proposal",
    });
    fireEvent.click(
      within(detail).getByRole("button", { name: "New session" }),
    );
    fireEvent.click(slot.getByTestId("bb-new-thread-composer-submit"));
    await slot.findByRole("button", { name: "Retry attachment" });
    fireEvent.click(slot.getByRole("button", { name: "Collapse session" }));
    fireEvent.click(
      within(detail).getByRole("button", { name: "New session" }),
    );
    expect(slot.queryByTestId("bb-new-thread-composer")).toBeNull();
    fireEvent.click(
      await slot.findByRole("button", { name: "Retry attachment" }),
    );
    await waitFor(() =>
      expect(
        slot.queryByRole("button", { name: "Retry attachment" }),
      ).toBeNull(),
    );
    expect(
      slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"),
    ).toBe("thr_created");
  });
  it("expands a waiting result in its row and keeps order through a ranking change", async () => {
    const slot = await mount({
      threads: [],
      tasks: Array.from({ length: 5 }, (_, i) =>
        task({
          id: `waiting-${i}`,
          title: `Waiting ${i}`,
          status: "in_review",
        }),
      ),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Waiting for you 5" }),
    );
    const list = slot.getByRole("region", { name: "Matching work" });
    const order = () =>
      Array.from(list.querySelectorAll("[data-layout-id]"), (element) =>
        element.getAttribute("data-layout-id"),
      );
    const before = order();
    const trigger = within(list).getByRole("button", {
      name: /^Preview Waiting 3/,
    });
    const row = trigger.closest(".wm-result");
    fireEvent.click(trigger);
    const detail = slot.getByRole("region", { name: "Expanded: Waiting 3" });
    expect(detail.closest(".wm-result")).toBe(row);
    await waitFor(() =>
      expect(trigger.getAttribute("aria-label")).not.toContain("Updated"),
    );
    fireEvent.click(
      within(detail).getByRole("button", { name: "Bring into focus" }),
    );
    await within(detail).findByRole("button", { name: "In focus" });
    expect(order()).toEqual(before);
    fireEvent.click(
      within(detail).getByRole("button", { name: "Open in side pane" }),
    );
    expect(order()).toEqual(before);
    fireEvent.click(slot.getByRole("button", { name: "Expand in map" }));
    expect(
      slot
        .getByRole("region", { name: "Expanded: Waiting 3" })
        .closest(".wm-result"),
    ).toBe(row);
    fireEvent.click(trigger);
    expect(
      slot.queryByRole("region", { name: "Expanded: Waiting 3" }),
    ).toBeNull();
    expect(
      slot.getAllByRole("button", { name: /^Preview Waiting/ }),
    ).toHaveLength(5);
    expect(order()[0]).toBe("task:waiting-3");
    slot.lifecycle.unmount();
  });
  it.each([null, "thr_parent"])(
    "retains a viewed new result (parent %s) until collapse, then focuses the next result",
    async (parentThreadId) => {
      const sessions = [
        thread({ indicator: "unread-success", isUnread: true, parentThreadId }),
        thread({
          id: "thr_next",
          title: "Next result",
          indicator: "unread-success",
          isUnread: true,
        }),
      ];
      const slot = await mount({
        tasks: [task({ status: "in_review" })],
        threads: sessions,
      });
      fireEvent.click(
        await slot.findByRole("button", { name: "Ready to read 2" }),
      );
      fireEvent.click(slot.getByRole("button", { name: /^Preview Session/ }));
      const detail = slot.getByRole("region", { name: "Expanded: Session" });
      await within(detail).findByText("The proposal is ready to review.");
      await waitFor(() =>
        expect(slot.inspection.sidebarActionCalls).toContainEqual({
          method: "setRead",
          threadId: "thr_test",
          read: true,
        }),
      );
      // The SDK fake records setRead; drive the resulting host snapshot explicitly.
      sessions[0] = { ...sessions[0], indicator: "none", isUnread: false };
      await slot.behavior.emitRealtime("preferences-changed", {});
      await slot.findByRole("button", { name: "Ready to read 1" });
      expect(slot.getByRole("region", { name: "Expanded: Session" })).toBe(
        detail,
      );
      expect(slot.getByText(/No longer matches this view/)).toBeTruthy();
      expect(
        slot
          .getByRole("button", { name: /^Preview Session/ })
          .getAttribute("aria-label"),
      ).toContain("Inactive");
      fireEvent.click(
        within(detail).getByRole("button", { name: "Collapse details" }),
      );
      expect(
        slot.queryByRole("button", { name: /^Preview Session/ }),
      ).toBeNull();
      await waitFor(() =>
        expect(document.activeElement).toBe(
          slot.getByRole("button", { name: /^Preview Next result/ }),
        ),
      );
      slot.lifecycle.unmount();
    },
  );
  it("closes inspection when Show all changes the overview to a list", async () => {
    const slot = await mount({
      tasks: [],
      threads: Array.from({ length: 16 }, (_, i) =>
        thread({ id: `many-${i}`, title: `Many ${i}` }),
      ),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Many 0\./ }),
    );
    expect(slot.getByRole("region", { name: "Expanded: Many 0" })).toBeTruthy();
    fireEvent.click(
      slot.getByRole("button", { name: /Show all 17 areas and sessions/ }),
    );
    expect(slot.queryByRole("region", { name: /^Expanded:/ })).toBeNull();
    expect(
      within(slot.getByRole("region", { name: "Matching work" })).getAllByRole(
        "button",
        { name: /^Preview Many/ },
      ),
    ).toHaveLength(16);
    slot.lifecycle.unmount();
  });
  it("clears an inspected result on filter change and collapses a search task without a hidden project step", async () => {
    const slot = await mount({
      tasks: [task({ status: "in_review" })],
      threads: [],
    });
    await slot.findByRole("button", { name: /^Open project Test project/ });
    fireEvent.change(slot.getByRole("textbox"), {
      target: { value: "Test project" },
    });
    fireEvent.click(
      slot.getByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.keyDown(
      slot.getByRole("region", { name: "Expanded: Review proposal" }),
      { key: "Escape" },
    );
    expect(slot.queryByRole("region", { name: /^Expanded:/ })).toBeNull();
    fireEvent.change(slot.getByRole("textbox"), { target: { value: "" } });
    fireEvent.click(slot.getByRole("button", { name: "Waiting for you 1" }));
    fireEvent.click(
      slot.getByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Inactive 0" }));
    expect(slot.queryByRole("region", { name: /^Expanded:/ })).toBeNull();
    expect(
      slot.queryByRole("button", { name: /^Preview Review proposal/ }),
    ).toBeNull();
    slot.lifecycle.unmount();
  });
  it("keeps every area in its original group through expansion, switching and collapse", async () => {
    const threads = Array.from({ length: 12 }, (_, i) =>
      thread({
        id: `position-${i}`,
        title: `Position ${i}`,
        isPinned: i === 0,
      }),
    );
    const slot = await mount({ tasks: [], threads });
    await slot.findByRole("button", { name: /^Preview Position 0\./ });
    const map = slot.getByRole("region", {
      name: "Work arranged around your focus",
    });
    const groups = [
      "Work to the left",
      "Work to the right",
      "Outer work above",
      "Outer work below",
    ];
    const before = new Map(
      Array.from(
        map.querySelectorAll<HTMLElement>("[data-layout-id]"),
        (element) => [element.dataset.layoutId, element.parentElement],
      ),
    );
    for (const name of groups) {
      const region = slot.getByRole("region", { name });
      const button = within(region).getAllByRole("button", {
        name: /^Preview Position/,
      })[0];
      fireEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(map.querySelectorAll(".wm-map-area-expanded")).toHaveLength(1);
      expect(
        map.querySelectorAll(".wm-map-area-compact").length,
      ).toBeGreaterThan(0);
      for (const element of Array.from(
        map.querySelectorAll<HTMLElement>("[data-layout-id]"),
      ))
        expect(element.parentElement).toBe(
          before.get(element.dataset.layoutId),
        );
      fireEvent.click(slot.getByRole("button", { name: "Collapse details" }));
      for (const element of Array.from(
        map.querySelectorAll<HTMLElement>("[data-layout-id]"),
      ))
        expect(element.parentElement).toBe(
          before.get(element.dataset.layoutId),
        );
    }
    slot.lifecycle.unmount();
  });
  it.each([false, true])(
    "animates changed card geometry unless reduced motion is %s",
    async (reduced) => {
      vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
      const cancel = vi.fn();
      const animate = vi.fn(() => ({ cancel }));
      Object.defineProperty(HTMLElement.prototype, "animate", {
        configurable: true,
        value: animate,
      });
      const bounds = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockImplementation(function (this: HTMLElement) {
          const expanded = this.classList.contains("wm-map-area-expanded");
          return {
            x: 20,
            y: 40,
            left: 20,
            top: 40,
            width: expanded ? 500 : 250,
            height: expanded ? 500 : 180,
            right: expanded ? 520 : 270,
            bottom: expanded ? 540 : 220,
            toJSON() {},
          };
        });
      const slot = await mount({ threads: [] });
      const project = await slot.findByRole("button", {
        name: /^Open project/,
      });
      fireEvent.click(project);
      if (reduced) expect(animate).not.toHaveBeenCalled();
      else
        expect(animate).toHaveBeenCalledWith(
          expect.any(Array),
          expect.objectContaining({ duration: 320 }),
        );
      fireEvent.click(project);
      if (!reduced) expect(cancel).toHaveBeenCalled();
      slot.lifecycle.unmount();
      bounds.mockRestore();
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
    },
  );
  it("steps from task to project to overview with Escape", async () => {
    const slot = await mount({ threads: [] });
    fireEvent.click(
      await slot.findByRole("button", { name: /Preview Review proposal/ }),
    );
    fireEvent.keyDown(
      slot.getByRole("region", { name: "Expanded: Review proposal" }),
      { key: "Escape" },
    );
    expect(
      slot.queryByRole("region", { name: "Expanded: Review proposal" }),
    ).toBeNull();
    const project = slot.getByRole("region", {
      name: "Expanded: Test project",
    });
    fireEvent.keyDown(project, { key: "Escape" });
    expect(
      slot.queryByRole("region", { name: "Expanded: Test project" }),
    ).toBeNull();
    slot.lifecycle.unmount();
  });
  it("labels archived attachments and opens them only when chosen", async () => {
    const slot = await mount({
      tasks: [
        task({
          threadIds: ["thr_test"],
          sessionLinks: [
            {
              threadId: "thr_test",
              title: "Archived session",
              attachedAt: "2026-09-17",
              liveStatus: "completed",
            },
          ],
        }),
      ],
      threads: [thread({ isArchived: true, title: "Archived session" })],
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /Preview Review proposal/ }),
    );
    expect(
      slot.queryByRole("button", { name: "Open full session" }),
    ).toBeNull();
    fireEvent.click(
      slot.getByRole("button", {
        name: /Archived session.*Archived.*Attached/,
      }),
    );
    await slot.findByText("The proposal is ready to review.");
    fireEvent.click(slot.getByRole("button", { name: "Open full session" }));
    expect(slot.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "thr_test", options: undefined },
    ]);
    slot.lifecycle.unmount();
  });
  it("expands a project and its task in the map, collapses details, and offers an optional pane", async () => {
    const slot = await mount({
      tasks: Array.from({ length: 8 }, (_, index) =>
        task({ id: `task${index}`, title: `Task ${index}` }),
      ),
      threads: [],
    });
    const project = await slot.findByRole("button", { name: /^Open project/ });
    slot.getByRole("main").scrollTop = 100;
    fireEvent.click(project);
    const area = slot.getByRole("region", { name: "Expanded: Test project" });
    expect(
      within(area).getAllByRole("button", { name: /^Preview Task/ }),
    ).toHaveLength(8);
    expect(slot.queryByRole("complementary")).toBeNull();
    fireEvent.click(
      within(area).getByRole("button", { name: /^Preview Task 7/ }),
    );
    const details = slot.getByRole("region", { name: "Expanded: Task 7" });
    expect(details.closest(".wm-area-expanded")).toBeTruthy();
    expect(within(details).getByText("Choose a direction")).toBeTruthy();
    fireEvent.click(
      within(details).getByRole("button", { name: "Collapse details" }),
    );
    expect(slot.queryByRole("region", { name: "Expanded: Task 7" })).toBeNull();
    expect(
      within(area).getAllByRole("button", { name: /^Preview Task/ }),
    ).toHaveLength(8);
    fireEvent.click(
      within(area).getByRole("button", { name: "Open in side pane" }),
    );
    const pane = slot.getByRole("complementary", {
      name: "Preview: Test project",
    });
    fireEvent.click(
      within(pane).getByRole("button", { name: "Expand in map" }),
    );
    expect(slot.queryByRole("complementary")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /^Open project/ }));
    expect(
      slot.queryByRole("region", { name: "Expanded: Test project" }),
    ).toBeNull();
    expect(slot.getAllByRole("button", { name: /^Preview Task/ })).toHaveLength(
      4,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        slot.getByRole("button", { name: /^Open project/ }),
      ),
    );
    expect(slot.getByRole("main").scrollTop).toBe(100);
    slot.lifecycle.unmount();
  });
  it("shows a session's contributed tasks separately from attachments and can expand a related task", async () => {
    const slot = await mount({
      tasks: [
        task({
          commentSessions: [
            {
              threadId: "thr_test",
              title: "Session",
              at: "2026-09-17T12:00:00Z",
            },
          ],
        }),
      ],
      threads: [thread({ indicator: "runtime" })],
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Session/ }),
    );
    const details = slot.getByRole("region", { name: "Expanded: Session" });
    fireEvent.click(
      within(details).getByRole("button", {
        name: /TEST-1.*Commented on this task/,
      }),
    );
    const taskDetails = slot.getByRole("region", {
      name: "Expanded: Review proposal",
    });
    fireEvent.click(
      within(taskDetails).getByRole("button", {
        name: /Session.*Contributed/,
      }),
    );
    await within(taskDetails).findByText("The proposal is ready to review.");
    expect(slot.getByRole("button", { name: "Working 1" })).toBeTruthy();
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    slot.lifecycle.unmount();
  });
  it("starts map navigation at the focused item and distinguishes an inactive anchor", async () => {
    const slot = await mount({
      tasks: [],
      threads: [
        thread({ id: "quiet", title: "Quiet" }),
        thread({ id: "focus", title: "Pinned", isPinned: true }),
      ],
    });
    await slot.findByRole("button", { name: /^Preview Pinned/ });
    const map = slot.getByRole("region", {
      name: "Work arranged around your focus",
    });
    expect(map.querySelector("button")?.getAttribute("aria-label")).toMatch(
      /^Preview Pinned/,
    );
    expect(slot.getByText("IN FOCUS")).toBeTruthy();
    slot.lifecycle.unmount();
    const inactive = await mount({
      tasks: [],
      threads: [thread({ title: "Idle" })],
    });
    await inactive.findByRole("button", { name: /^Preview Idle/ });
    expect(inactive.getByText("IN VIEW")).toBeTruthy();
    expect(inactive.queryByText("NEEDS YOU NOW")).toBeNull();
    inactive.lifecycle.unmount();
  });
  it("starts with rotation paused when reduced motion is requested", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const slot = await mount();
    expect(
      await slot.findByRole("button", { name: "Rotation paused" }),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("shows four project tasks and keeps a running task visible among reviews", async () => {
    const slot = await mount({
      tasks: Array.from({ length: 8 }, (_, index) =>
        task({
          id: `task${index}`,
          key: `TEST-${index}`,
          title: `Task ${index}`,
          status: index === 7 ? "in_progress" : "in_review",
          threadIds: index === 7 ? ["thr_test"] : [],
        }),
      ),
      threads: [thread({ indicator: "runtime" })],
    });
    await slot.findByRole("button", { name: /^Open project Test project/ });
    expect(slot.getAllByRole("button", { name: /^Preview Task/ })).toHaveLength(
      4,
    );
    expect(slot.getByRole("button", { name: /^Preview Task 7/ })).toBeTruthy();
    expect(
      slot.container.querySelector(".wm-island.wm-has-working"),
    ).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("does not mark sessions read from the overview or a project preview", async () => {
    const slot = await mount();
    fireEvent.click(
      await slot.findByRole("button", { name: /^Open project Test project/ }),
    );
    expect(slot.queryByRole("complementary")).toBeNull();
    expect(
      slot.getByRole("region", { name: "Expanded: Test project" }),
    ).toBeTruthy();
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    slot.lifecycle.unmount();
  });
  it("loads a fresh response, marks only that successful response seen and opens the native session", async () => {
    const slot = await mount({ done: true });
    fireEvent.click(
      await slot.findByRole("button", { name: /Preview Review proposal/ }),
    );
    await slot.findByText("The proposal is ready to review.");
    await waitFor(() =>
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "setRead",
        threadId: "thr_test",
        read: true,
      }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Open full session" }));
    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thr_test",
      options: undefined,
    });
    slot.lifecycle.unmount();
  });
  it("preserves unread state when the response cannot be loaded", async () => {
    const slot = await mount({ unavailable: true });
    fireEvent.click(
      await slot.findByRole("button", { name: /Preview Review proposal/ }),
    );
    await slot.findByText("Preview unavailable");
    expect(
      slot.inspection.sidebarActionCalls.filter((c) => c.method === "setRead"),
    ).toEqual([]);
    slot.lifecycle.unmount();
  });
  it("retains the session card context on preview failure, with the error and retry in its details", async () => {
    const slot = await mount({ unavailable: true, tasks: [] });
    const card = await slot.findByRole("button", { name: /^Preview Session/ });
    fireEvent.click(card);
    await slot.findByText("Preview unavailable");
    expect(card.textContent).toContain("Open for the latest session update.");
    expect(card.textContent).not.toContain("Preview unavailable");
    expect(slot.getByRole("button", { name: "Retry preview" })).toBeTruthy();
    expect(slot.queryByTestId("bb-markdown")).toBeNull();
    expect(
      slot.inspection.sidebarActionCalls.filter((c) => c.method === "setRead"),
    ).toEqual([]);
    slot.lifecycle.unmount();
  });
  it("uses plugin preferences for task focus and leaves task status alone", async () => {
    const slot = await mount();
    fireEvent.click(
      await slot.findByRole("button", { name: /Preview Review proposal/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Bring into focus" }));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (c) =>
            c.method === "setPreference" &&
            (c.input as { focus?: boolean }).focus === true,
        ),
      ).toBe(true),
    );
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "updateTask"),
    ).toBe(false);
    slot.lifecycle.unmount();
  });
  it("shows a retryable error on a rejected preview without acknowledging unread work", async () => {
    const options = { rejectPreview: true };
    const slot = await mount(options);
    fireEvent.click(
      await slot.findByRole("button", { name: /Preview Review proposal/ }),
    );
    await slot.findByText(
      "Session preview could not be loaded. Retry or open the full session.",
    );
    expect(slot.queryByText("Loading session preview…")).toBeNull();
    expect(
      slot.inspection.sidebarActionCalls.filter((c) => c.method === "setRead"),
    ).toEqual([]);
    options.rejectPreview = false;
    fireEvent.click(slot.getByRole("button", { name: "Retry preview" }));
    await slot.findByText("The proposal is ready to review.");
    slot.lifecycle.unmount();
  });
  it("searches project scopes without rendering each task twice", async () => {
    const slot = await mount();
    await slot.findByRole("button", { name: /^Open project Test project/ });
    fireEvent.change(slot.getByRole("textbox"), {
      target: { value: "Test project" },
    });
    expect(
      slot.getAllByRole("button", { name: /Preview Review proposal/ }),
    ).toHaveLength(1);
    expect(
      slot.getAllByRole("button", { name: /Preview Test project/ }),
    ).toHaveLength(1);
    fireEvent.change(slot.getByRole("textbox"), {
      target: { value: "TEST-1" },
    });
    expect(slot.getAllByRole("button", { name: /^Preview / })).toHaveLength(1);
    expect(
      slot.queryByRole("button", { name: /Preview Test project/ }),
    ).toBeNull();
    slot.lifecycle.unmount();
  });
  it("keeps task review and an attached unread result visible independently across filters", async () => {
    const sessions = [thread({ indicator: "unread-success", isUnread: true })];
    const slot = await mount({
      tasks: [task({ status: "in_review", threadIds: ["thr_test"] })],
      threads: sessions,
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Ready to read 1" }),
    );
    const tile = slot.getByRole("button", { name: /^Preview Review proposal/ });
    expect(within(tile).getByText("Needs review")).toBeTruthy();
    expect(within(tile).getByText("Ready to read")).toBeTruthy();
    fireEvent.click(tile);
    await waitFor(() =>
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "setRead",
        threadId: "thr_test",
        read: true,
      }),
    );
    sessions[0] = { ...sessions[0], indicator: "none", isUnread: false };
    await slot.behavior.emitRealtime("preferences-changed", {});
    await slot.findByRole("button", { name: "Ready to read 0" });
    fireEvent.click(slot.getByRole("button", { name: "Waiting for you 1" }));
    expect(
      slot
        .getByRole("button", { name: /^Preview Review proposal/ })
        .getAttribute("data-attention"),
    ).toBe("review");
    expect(
      slot.inspection.rpcCalls.some((call) => call.method === "settle"),
    ).toBe(false);
    slot.lifecycle.unmount();
  });
  it("shows failure, review, unread, working and focus together without acknowledging on browse", async () => {
    const slot = await mount({
      tasks: [
        task({
          status: "in_review",
          threadIds: ["error", "result", "running"],
        }),
      ],
      threads: [
        thread({ id: "error", indicator: "unread-error" }),
        thread({ id: "result", indicator: "unread-success" }),
        thread({ id: "running", indicator: "runtime" }),
      ],
      preferences: { "task:task1": { focus: true } },
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Waiting for you 1" }),
    );
    const tile = slot.getByRole("button", { name: /^Preview Review proposal/ });
    expect(tile.getAttribute("data-attention")).toBe("error");
    expect(tile.classList.contains("wm-has-working")).toBe(true);
    expect(tile.classList.contains("wm-focused")).toBe(true);
    for (const label of [
      "Run failed",
      "Needs review",
      "Ready to read",
      "Agent working",
    ])
      expect(within(tile).getByText(label)).toBeTruthy();
    expect(tile.getAttribute("aria-label")).toContain(
      "Run failed. Needs review. Ready to read",
    );
    expect(slot.getByRole("button", { name: "Ready to read 1" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Working 1" })).toBeTruthy();
    expect(
      slot.inspection.sidebarActionCalls.filter((c) => c.method === "setRead"),
    ).toHaveLength(0);
    slot.lifecycle.unmount();
  });
  it("separates actionable tasks from unread results without acknowledging either on filter change", async () => {
    const slot = await mount({ tasks: [task({ status: "in_review" })] });
    fireEvent.click(
      await slot.findByRole("button", { name: "Waiting for you 1" }),
    );
    const tiles = slot.getAllByRole("button", { name: /^Preview / });
    expect(tiles).toHaveLength(1);
    expect(tiles[0].getAttribute("aria-label")).toMatch(
      /^Preview Review proposal/,
    );
    expect(slot.queryByRole("button", { name: /^Open project/ })).toBeNull();
    expect(tiles[0].getAttribute("data-attention")).toBe("review");
    fireEvent.click(slot.getByRole("button", { name: "Ready to read 1" }));
    const result = slot.getByRole("button", { name: /^Preview Session/ });
    expect(result.classList.contains("wm-unread")).toBe(true);
    expect(result.classList.contains("wm-waiting")).toBe(false);
    expect(within(result).getByText("Ready to read")).toBeTruthy();
    expect(
      slot.inspection.sidebarActionCalls.filter((c) => c.method === "setRead"),
    ).toHaveLength(0);
    slot.lifecycle.unmount();
  });
  it("counts a project focused directly even when no child is focused", async () => {
    const slot = await mount({
      preferences: { "project:p1": { focus: true } },
    });
    fireEvent.click(await slot.findByRole("button", { name: "In focus 1" }));
    expect(slot.getAllByRole("button", { name: /^Open project/ })).toHaveLength(
      1,
    );
    slot.lifecycle.unmount();
  });
  it("removes inherited task focus by unpinning its attached session", async () => {
    const slot = await mount({ threads: [thread({ isPinned: true })] });
    fireEvent.click(
      await slot.findByRole("button", { name: /Preview Review proposal/ }),
    );
    expect(
      slot.getByText(/Removing focus also unpins those sessions in BB/),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "In focus" }));
    await waitFor(() =>
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "setPinned",
        threadId: "thr_test",
        pinned: false,
      }),
    );
    slot.lifecycle.unmount();
  });
  it("explains inherited project focus on drop without changing preferences or showing a connection error", async () => {
    const slot = await mount({ threads: [thread({ isPinned: true })] });
    const project = await slot.findByRole("button", {
      name: /^Open project Test project/,
    });
    const transfer = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => transfer.set(k, v),
      getData: (k: string) => transfer.get(k),
    };
    fireEvent.dragStart(project, { dataTransfer });
    fireEvent.drop(slot.getByText("Drop here to remove your focus"), {
      dataTransfer,
    });
    expect(slot.container.querySelector(".wm-notice")?.textContent).toContain(
      "This project contains focused tasks",
    );
    expect(slot.queryByRole("alert")).toBeNull();
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "setPreference"),
    ).toBe(false);
    expect(slot.inspection.sidebarActionCalls).toEqual([]);
    slot.lifecycle.unmount();
  });
  it("supports dragging a task into focus and exposes dates to assistive technology", async () => {
    const slot = await mount({
      tasks: [task({ dueDate: "2026-09-17" })],
      threads: [],
    });
    const tile = await slot.findByRole("button", {
      name: /Preview Review proposal.*Planned/,
    });
    const transfer = new Map<string, string>();
    const dataTransfer = {
      setData: (k: string, v: string) => transfer.set(k, v),
      getData: (k: string) => transfer.get(k),
    };
    fireEvent.dragStart(tile, { dataTransfer });
    fireEvent.drop(slot.getByText("Drop here to bring into focus"), {
      dataTransfer,
    });
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (c) =>
            c.method === "setPreference" &&
            (c.input as Preference).focus === true,
        ),
      ).toBe(true),
    );
    expect(slot.container.querySelector("button p")).toBeNull();
    slot.lifecycle.unmount();
  });
});
