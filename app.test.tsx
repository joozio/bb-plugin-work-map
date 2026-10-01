// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { data, now, task, thread } from "./fixtures";
import { sessionPreview } from "./preview";
import { localDay } from "./model";
import type {
  rpcContract,
  MapTask,
  Preference,
  TaskComment,
  TaskDetail,
} from "./server";
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
/** An opened task's quiet acts sit behind its ⋯ menu: open it, choose one. */
function pickMore(
  scope: {
    getByRole: (
      role: string,
      options?: { name?: string | RegExp },
    ) => HTMLElement;
  },
  name: string | RegExp,
) {
  fireEvent.click(scope.getByRole("button", { name: /^More on / }));
  fireEvent.click(scope.getByRole("menuitem", { name }));
}
it("fits collapsed Overview to height and width, keeps overflow reachable, and lets details scroll", async () => {
  let width = 1500,
    height = 780;
  const observers = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      targets: Element[] = [];
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.targets.push(target);
        observers.set(target, this.callback);
      }
      disconnect() {
        this.targets.forEach((target) => observers.delete(target));
      }
    },
  );
  const resize = () =>
    act(async () => {
      for (const [target, callback] of observers)
        callback(
          [{ target, contentRect: { width, height } } as ResizeObserverEntry],
          {} as ResizeObserver,
        );
    });
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("wm-spatial")
        ? {
            width,
            height,
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: width,
            bottom: height,
            toJSON: () => ({}),
          }
        : originalRect.call(this);
    },
  );
  const slot = await mount({
    tasks: [],
    threads: Array.from({ length: 30 }, (_, i) =>
      thread({ id: `fit${i}`, title: `Fit session ${i}`, isPinned: i === 0 }),
    ),
  });
  await slot.findByText(/Fits this screen/);
  const roots = () =>
    Array.from(
      slot.container.querySelectorAll<HTMLElement>("[data-layout-id]"),
    );
  const wideCount = roots().length;
  expect(wideCount).toBeGreaterThan(5);
  height = 60;
  await resize();
  expect(roots()).toHaveLength(0);
  expect(slot.getByRole("button", { name: /Show all 31/ })).toBeTruthy();
  expect(slot.queryByText("Nothing here needs attention")).toBeNull();
  expect(slot.getByText("More room needed · Use Show all below")).toBeTruthy();
  width = 480;
  height = 340;
  await resize();
  expect(roots().length).toBeLessThan(wideCount);
  expect(
    roots().every(
      (e) => parseFloat(e.style.top) + parseFloat(e.style.height) <= height,
    ),
  ).toBe(true);
  const pinned = slot.getByRole("button", { name: /^Preview Fit session 0/ });
  expect(pinned.closest(".wm-rich-card")).toBeTruthy();
  expect(slot.inspection.sidebarActionCalls).toEqual([]);
  expect(
    slot.inspection.rpcCalls.some((c) => c.method === "setPreference"),
  ).toBe(false);
  fireEvent.click(pinned);
  expect(slot.container.querySelector(".wm-fit-canvas")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Collapse details" }));
  await slot.findByText(/Fits this screen/);
  fireEvent.click(slot.getByRole("button", { name: /Show all 31/ }));
  expect(slot.queryByText(/Fits this screen/)).toBeNull();
  expect(
    slot.getAllByRole("button", { name: /^Preview Fit session/ }),
  ).toHaveLength(30);
  slot.lifecycle.unmount();
});
it("hands the map to Heat without the Overview fit, and takes it back", async () => {
  const width = 1500,
    height = 780;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ target, contentRect: { width, height } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
    },
  );
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("wm-spatial")
        ? new DOMRect(0, 0, width, height)
        : originalRect.call(this);
    },
  );
  const slot = await mount({
    tasks: [],
    threads: Array.from({ length: 30 }, (_, i) =>
      thread({ id: `both${i}`, title: `Both session ${i}` }),
    ),
  });
  await slot.findByText(/Fits this screen/);
  expect(slot.container.querySelector(".wm-fit-canvas")).toBeTruthy();
  // Heat fills the map itself, so the Overview's viewport fit stands down
  // rather than measuring a layout that is no longer on screen.
  fireEvent.click(slot.getByRole("button", { name: "Heat layout" }));
  await waitFor(() =>
    expect(slot.container.querySelector(".wm-heat")).toBeTruthy(),
  );
  expect(slot.container.querySelector(".wm-fit-canvas")).toBeNull();
  expect(slot.container.querySelector(".wm-heat-canvas")).toBeTruthy();
  expect(slot.queryByText(/Fits this screen/)).toBeNull();
  expect(slot.queryByRole("button", { name: /Show all 30/ })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Overview layout" }));
  await slot.findByText(/Fits this screen/);
  expect(slot.container.querySelector(".wm-heat-canvas")).toBeNull();
  slot.lifecycle.unmount();
});
it("offers Explore when a short project card has no room for task tiles", async () => {
  vi.stubGlobal("ResizeObserver", undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 180),
  );
  const slot = await mount({
    threads: [],
    tasks: Array.from({ length: 6 }, (_, i) =>
      task({ id: `short${i}`, title: `Short task ${i}` }),
    ),
  });
  await slot.findByText(/Fits this screen/);
  expect(slot.container.querySelectorAll(".wm-small")).toHaveLength(0);
  expect(slot.queryByText("+6 more tasks")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: /Explore 6 tasks/ }));
  expect(
    slot.getAllByRole("button", { name: /^Preview Short task/ }),
  ).toHaveLength(6);
  slot.lifecycle.unmount();
});
it("shows recent activity without claiming an agent is running, and holds an open chat while it ages through a failed refresh", async () => {
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const options = {
    tasks: [],
    rejectSnapshot: false,
    threads: [
      thread({ title: "Recent work", latestAttentionAt: clock - 2 * 3600000 }),
    ],
  };
  const slot = await mount(options);
  const tile = await slot.findByRole("button", {
    name: /^Preview Recent work/,
  });
  expect(tile.textContent).toContain("Active 2h ago");
  expect(tile.textContent).not.toContain("Inactive");
  expect(tile.getAttribute("aria-label")).toContain("Inactive");
  expect(slot.getByText("ACTIVE IN THE LAST 24H")).toBeTruthy();
  fireEvent.click(tile);
  fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
  const chat = slot.getByTestId("bb-thread-chat");
  const area = tile.closest("[data-layout-id]");
  const parent = area?.parentElement;
  clock += 2 * 86400000;
  options.rejectSnapshot = true;
  fireEvent.click(slot.getByRole("button", { name: "Refresh map" }));
  await waitFor(() => expect(tile.textContent).toContain("Active 2d ago"));
  await slot.findByText(/Task source disconnected/);
  expect(area?.parentElement).toBe(parent);
  expect(slot.getByTestId("bb-thread-chat")).toBe(chat);
  expect(slot.inspection.sidebarActionCalls).toEqual([]);
  expect(
    slot.inspection.rpcCalls.some((c) =>
      ["setPreference", "createSession", "settle"].includes(c.method),
    ),
  ).toBe(false);
  slot.lifecycle.unmount();
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
  await waitFor(() => {
    const calls = slot.inspection.rpcCalls.filter(
      (call) => call.method === "previews",
    );
    const ids = new Set(
      calls.flatMap(
        (call) => (call.input as { threadIds: string[] }).threadIds,
      ),
    );
    expect(ids.size).toBeGreaterThan(24);
    expect(
      calls.every(
        (call) =>
          (call.input as { threadIds: string[] }).threadIds.length <= 16,
      ),
    ).toBe(true);
  });
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

it.each(["none", "runtime"] as const)(
  "shows useful central session context for %s without opening or acknowledging it",
  async (indicator) => {
    const previewText =
      "A useful result. ".repeat(24) +
      "The next decision is which draft to use.";
    const slot = await mount({
      tasks: [],
      previewText,
      threads: [thread({ indicator })],
    });
    const card = await slot.findByRole("button", { name: /^Preview Session/ });
    await waitFor(() => expect(card.textContent).toContain("A useful result."));
    expect(card.textContent).toContain("The next decision");
    expect(card.textContent).toContain(
      indicator === "runtime" ? "Latest available response" : "Latest response",
    );
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
  },
);

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
    rejectSnapshot?: boolean;
    previewText?: string;
    tasks?: MapTask[];
    threads?: PluginSidebarThread[];
    preferences?: Record<string, Preference>;
    attachmentError?: boolean;
    linkedBbProjectId?: string | null;
    delegateAreaRequests?: {
      requestId: string;
      projectId: string;
      taskIds: string[];
    }[];
    delegateAreaError?: string;
    areaRunning?: boolean;
    createRequests?: { taskId?: string; request: { projectId: string } }[];
    settleRequests?: SettleInput[];
    settleError?: boolean;
    manageRequests?: ManagementInput[];
    layout?: "overview" | "heat";
    legendOpen?: boolean;
    noProjects?: boolean;
    /** Hold the layout and snapshot answers until these settle. */
    layoutGate?: Promise<void>;
    snapshotGate?: Promise<void>;
    delegateRequests?: { requestId: string; taskId: string; note?: string }[];
    delegateError?: string;
    /** Answers a snapshot call in place of the fixture, by call number. */
    snapshot?: (call: number, tasks: MapTask[]) => Promise<MapTask[]> | null;
    /** The opened task's full text and timeline, by task id. */
    details?: Record<string, Partial<TaskDetail>>;
    detailError?: string;
    commentRequests?: { taskId: string; body: string }[];
    commentError?: string;
  } = {},
) {
  const app = await loadPluginApp(() => import("./app"));
  const storedPreferences = { ...options.preferences };
  const storedLayout = { layout: options.layout ?? ("overview" as const) };
  const storedLegend = { open: options.legendOpen ?? false };
  const settled: Settlement[] = [];
  let snapshotCalls = 0;
  const projects = options.noProjects
    ? []
    : [
        managedProjectSchema.parse({
          id: "p1",
          name: "Test project",
          prefix: "TEST",
          linkedBbProjectId:
            options.linkedBbProjectId === undefined
              ? "proj_bb"
              : options.linkedBbProjectId,
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
            dueDate: input.dueDate ?? null,
            // A date fix reports the date it replaced, as Tasks does.
            previousDueDate:
              input.action === "date"
                ? (tasks.find((row) => row.id === input.taskId)?.dueDate ?? null)
                : null,
            taskUpdated: !!input.taskId,
            archivedThreadIds: input.threadId ? [input.threadId] : [],
            undone: false,
            warning: null,
          };
          settled.push(result);
          return result;
        },
        delegatePreset: () => ({ preset: "wiz" }),
        delegate: (input) => {
          options.delegateRequests?.push({
            requestId: input.requestId,
            taskId: input.taskId,
            ...(input.note ? { note: input.note } : {}),
          });
          if (options.delegateError) throw new Error(options.delegateError);
          const target = tasks.find((row) => row.id === input.taskId);
          return {
            taskId: input.taskId,
            taskKey: target?.key ?? "TEST-1",
            threadId: `thr_agent_${input.taskId}`,
            preset: "wiz",
            movedFrom: target?.status === "in_review" ? "in_review" : null,
            commented: true,
          };
        },
        delegateArea: (input) => {
          options.delegateAreaRequests?.push({
            requestId: input.requestId,
            projectId: input.projectId,
            taskIds: [...input.taskIds],
          });
          if (options.delegateAreaError)
            throw new Error(options.delegateAreaError);
          const covered = input.taskIds.flatMap((taskId) => {
            const target = tasks.find((row) => row.id === taskId);
            if (!target || ["done", "canceled"].includes(target.status))
              return [];
            // A real dispatch attaches the orchestrator to every task it owns,
            // which is what makes a second click see the work as taken.
            target.threadIds.push("thr_orch");
            target.sessionLinks = [
              ...(target.sessionLinks ?? []),
              {
                threadId: "thr_orch",
                title: "Test project orchestrator",
                attachedAt: new Date().toISOString(),
                liveStatus: "starting",
              },
            ];
            return [
              {
                taskId,
                taskKey: target.key,
                movedFrom: target.status === "in_review" ? "in_review" : null,
                commented: true,
                attached: true,
              },
            ];
          });
          return {
            threadId: "thr_orch",
            title: "Test project orchestrator",
            preset: "wiz",
            reused: !!options.areaRunning,
            covered,
            dropped: [],
          };
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
        taskDetail: ({ taskId }) => {
          if (options.detailError) throw new Error(options.detailError);
          const source = tasks.find((row) => row.id === taskId);
          return {
            taskId,
            description: "",
            createdAt: source?.createdAt ?? null,
            updatedAt: source?.updatedAt ?? new Date(now).toISOString(),
            labels: [],
            attachments: [],
            comments: [],
            warnings: [],
            ...options.details?.[taskId],
          };
        },
        postComment: ({ taskId, body }) => {
          options.commentRequests?.push({ taskId, body });
          if (options.commentError) throw new Error(options.commentError);
          const comment: TaskComment = {
            id: `c${options.commentRequests?.length ?? 1}`,
            kind: "user",
            authorName: "You",
            threadId: null,
            body,
            createdAt: new Date(Date.now()).toISOString(),
          };
          const detail = (options.details ??= {});
          detail[taskId] = {
            ...detail[taskId],
            comments: [...(detail[taskId]?.comments ?? []), comment],
          };
          return { comment };
        },
        snapshot: async () => {
          await options.snapshotGate;
          if (options.rejectSnapshot)
            throw new Error("Task source disconnected");
          const gated = options.snapshot?.(++snapshotCalls, tasks);
          return { ...data(gated ? await gated : tasks), projects };
        },
        layout: async () => {
          await options.layoutGate;
          return { layout: storedLayout.layout };
        },
        setLayout: ({ layout }) => {
          storedLayout.layout = layout;
          return { layout };
        },
        legend: () => ({ ...storedLegend }),
        setLegend: ({ open }) => {
          storedLegend.open = open;
          return { open };
        },
        preferences: () => storedPreferences,
        setPreference: (input) => {
          storedPreferences[input.id] = {
            ...storedPreferences[input.id],
            ...(input.focus === undefined ? {} : { focus: input.focus }),
            ...(input.seenAt === undefined ? {} : { seenAt: input.seenAt }),
            ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
          };
          if (input.snoozedUntil)
            storedPreferences[input.id].snoozedUntil = input.snoozedUntil;
          else if (input.snoozedUntil !== undefined)
            delete storedPreferences[input.id].snoozedUntil;
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
    expect(
      slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"),
    ).toBe("thr_second");
    fireEvent.click(
      slot.getByRole("button", { name: /^First agent.*Attached/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
    expect(
      slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"),
    ).toBe("thr_test");
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
    pickMore(within(taskDetail), "Open in side pane");
    expect(
      slot.getByTestId("bb-thread-chat").closest(".wm-preview"),
    ).not.toBeNull();
    pickMore(slot, "Expand in map");
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
  it("hands focus to Back to summary when the native editor takes Escape and drops focus, after its own menu gets the first Escape", async () => {
    const slot = await mount({
      tasks: [task({ threadIds: ["thr_test"] })],
      threads: [thread({ title: "First agent", indicator: "runtime" })],
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
    // The SDK stub has no editor; stand its root in for the Reply editor.
    const editor = slot.getByTestId("bb-thread-chat");
    editor.tabIndex = -1;
    editor.focus();
    const escape = () => {
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      // The editor handles Escape itself, as the native one does.
      editor.addEventListener("keydown", (e) => e.preventDefault(), {
        once: true,
      });
      fireEvent(editor, event);
    };
    // First Escape closes the editor's own menu: focus stays in the editor.
    escape();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.activeElement).toBe(editor);
    expect(slot.getByTestId("bb-thread-chat")).toBe(editor);
    // Second Escape leaves the editor, which drops focus on the body.
    escape();
    editor.blur();
    const back = slot.getByRole("button", { name: "Back to summary" });
    await waitFor(() => expect(document.activeElement).toBe(back));
    expect(slot.getByTestId("bb-thread-chat")).toBeTruthy();
    // From there Escape steps back as the hint promises: chat closes first.
    fireEvent.keyDown(back, { key: "Escape" });
    expect(slot.queryByTestId("bb-thread-chat")).toBeNull();
    expect(
      slot.getByRole("region", { name: "Expanded: Review proposal" }),
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
    fireEvent.click(slot.getByRole("button", { name: "All work" }));
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
    // One action bar first, then the work, then the facts and the people.
    const settle = within(detail).getByRole("region", {
      name: "Act on this task",
    });
    const ask = within(detail).getByRole("region", { name: "The ask" });
    const description = within(detail).getByRole("region", {
      name: "Description",
    });
    const sessions = within(detail).getByRole("region", {
      name: "Connected sessions",
    });
    expect(
      settle.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      ask.compareDocumentPosition(description) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      description.compareDocumentPosition(sessions) &
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
    fireEvent.click(slot.getByRole("button", { name: "Done" }));
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
    pickMore(
      within(slot.getByRole("region", { name: "Expanded: Review proposal" })),
      "Open in side pane",
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
    const done = slot.getByRole("button", { name: "Done" });
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
    fireEvent.click(slot.getByRole("button", { name: "Done" }));
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
      ask: "New information from the task",
      askFrom: "comment",
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
    const slot = await mount({ createRequests, linkedBbProjectId: null });
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
    pickMore(within(detail), "Bring into focus");
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (c) =>
            c.method === "setPreference" &&
            (c.input as { focus?: boolean }).focus === true,
        ),
      ).toBe(true),
    );
    await waitFor(() => {
      fireEvent.click(within(detail).getByRole("button", { name: /^More on / }));
      expect(within(detail).getByRole("menuitem", { name: "Remove focus" })).toBeTruthy();
      fireEvent.keyDown(within(detail).getByRole("menuitem", { name: "Remove focus" }), { key: "Escape" });
    });
    expect(order()).toEqual(before);
    pickMore(within(detail), "Open in side pane");
    expect(order()).toEqual(before);
    pickMore(slot, "Expand in map");
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
        latestAttentionAt: Date.now() - 7 * 86400000,
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
      threads: [
        thread({ title: "Idle", latestAttentionAt: Date.now() - 7 * 86400000 }),
      ],
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
    expect(card.querySelector(".wm-excerpt")).toBeNull();
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
    pickMore(slot, "Bring into focus");
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
  it("keeps the initially chosen result selected after acknowledgment and a sibling becoming more urgent", async () => {
    const sessions = [
      thread({ id: "thr_old", title: "Older agent", indicator: "runtime" }),
      thread({
        id: "thr_test",
        title: "Finished agent",
        indicator: "unread-success",
      }),
    ];
    const slot = await mount({
      tasks: [
        task({
          threadIds: ["thr_old", "thr_test"],
          waitingOn: "A reviewer",
        }),
      ],
      threads: sessions,
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    await waitFor(() =>
      expect(slot.inspection.sidebarActionCalls).toContainEqual({
        method: "setRead",
        threadId: "thr_test",
        read: true,
      }),
    );
    sessions[1] = { ...sessions[1], indicator: "none" };
    sessions[0] = { ...sessions[0], hasPendingInteraction: true };
    await slot.behavior.emitRealtime("preferences-changed", {});
    fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
    expect(
      slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"),
    ).toBe("thr_test");
    expect(
      slot.inspection.sidebarActionCalls.filter(
        (call) => call.method === "setRead",
      ),
    ).toHaveLength(1);
    slot.lifecycle.unmount();
  });
  it("keeps external waiting reasons visible on otherwise inactive tasks", async () => {
    const slot = await mount({
      tasks: [task({ waitingOn: "A reviewer", lifecycle: "waiting" })],
      threads: [],
    });
    const tile = await slot.findByRole("button", {
      name: /^Preview Review proposal/,
    });
    expect(tile.textContent).toContain("Waiting on A reviewer");
    slot.lifecycle.unmount();
  });
  it("stops targeting a detached session and selects a remaining attachment", async () => {
    const tasks = [task({ threadIds: ["thr_test", "thr_second"] })];
    const slot = await mount({
      tasks,
      threads: [
        thread({ hasPendingInteraction: true }),
        thread({
          id: "thr_second",
          indicator: "runtime",
          title: "Remaining agent",
        }),
      ],
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
    expect(
      slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"),
    ).toBe("thr_test");
    tasks[0] = { ...tasks[0], threadIds: ["thr_second"] };
    fireEvent.click(slot.getByRole("button", { name: "Refresh map" }));
    await waitFor(() =>
      expect(slot.queryByTestId("bb-thread-chat")).toBeNull(),
    );
    await waitFor(() =>
      expect(
        slot
          .getByRole("button", { name: /^Remaining agent.*Attached/ })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    fireEvent.click(slot.getByRole("button", { name: "Chat here" }));
    expect(
      slot.getByTestId("bb-thread-chat").getAttribute("data-thread-id"),
    ).toBe("thr_second");
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
    pickMore(slot, "Remove focus");
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

describe("heat layout", () => {
  it("shows current due dates and old undated backlog with distinct timing marks", async () => {
    const current = Date.now();
    const days = (offset: number) => localDay(current + offset * 86400000);
    const slot = await mount({
      layout: "heat",
      threads: [],
      tasks: [
        task({
          id: "recurring",
          title: "Weekly check",
          status: "in_review",
          dateKind: "deadline",
          dueDate: days(0),
          createdAt: new Date(current - 300 * 86400000).toISOString(),
        }),
        task({
          id: "late",
          title: "Late decision",
          dateKind: "deadline",
          dueDate: days(-2),
        }),
        task({
          id: "near",
          title: "Near deadline",
          dateKind: "deadline",
          dueDate: days(3),
        }),
        task({
          id: "backlog",
          title: "Old idea",
          status: "backlog",
          createdAt: new Date(current - 90 * 86400000).toISOString(),
        }),
        ...Array.from({ length: 10 }, (_, index) =>
          task({
            id: `quiet${index}`,
            title: `New idea ${index}`,
            status: "backlog",
            createdAt: new Date(current).toISOString(),
          }),
        ),
      ],
    });
    const recurring = await slot.findByRole("button", {
      name: /^Preview Weekly check/,
    });
    const late = slot.getByRole("button", { name: /^Preview Late decision/ });
    const near = slot.getByRole("button", { name: /^Preview Near deadline/ });
    const backlog = slot.getByRole("button", { name: /^Preview Old idea/ });
    // A coloured tile says why: the date in lower case, with its priority.
    expect(recurring.textContent).toContain("due today · medium");
    expect(recurring.getAttribute("aria-label")).toContain("Due today");
    expect(recurring.textContent).not.toContain("300d");
    // Tiers across the map: the review due today and the date just passed are
    // Now, in that order; the date this week and the aged backlog fill Next;
    // the fresh quiet ones are Later and say only their age.
    expect(recurring.getAttribute("data-tier")).toBe("now");
    expect(recurring.querySelector(".wm-heat-rank")?.textContent).toBe("1");
    expect(late.textContent).toContain("2d late · medium");
    expect(late.getAttribute("data-tier")).toBe("now");
    expect(late.querySelector(".wm-heat-rank")?.textContent).toBe("2");
    expect(near.textContent).toContain("due in 3d · medium");
    expect(near.getAttribute("data-tier")).toBe("next");
    expect(near.getAttribute("aria-label")).toContain("Next: due in 3d · medium");
    expect(backlog.textContent).toContain("90d old");
    expect(backlog.getAttribute("data-tier")).toBe("next");
    const fresh = slot.getByRole("button", { name: /^Preview New idea 0/ });
    expect(fresh.getAttribute("data-tier")).toBe("later");
    expect(fresh.getAttribute("aria-label")).toContain(". Later.");
    expect(fresh.querySelector(".wm-heat-meta > span + span")?.textContent).toBe(
      "0d old",
    );
    expect(backlog.getAttribute("aria-label")).toContain("no due date");
    slot.lifecycle.unmount();
  });
  it("labels undated tasks by creation age and keeps verified review waits separate", async () => {
    const current = Date.now();
    const slot = await mount({
      layout: "heat",
      tasks: [
        task({
          id: "known",
          title: "Weekly review",
          status: "in_review",
          createdAt: new Date(current - 40 * 86400000).toISOString(),
          statusSince: new Date(current - 3600000).toISOString(),
        }),
        task({
          id: "unknown",
          title: "Imported review",
          status: "in_review",
          createdAt: new Date(current - 40 * 86400000).toISOString(),
        }),
      ],
      threads: [],
    });
    const known = await slot.findByRole("button", {
      name: /Preview Weekly review/,
    });
    const unknown = slot.getByRole("button", {
      name: /Preview Imported review/,
    });
    expect(known.getAttribute("aria-label")).toContain(
      "Waiting less than a day",
    );
    expect(known.textContent).toContain("40d old");
    expect(unknown.textContent).toContain("40d old");
    expect(unknown.getAttribute("aria-label")).not.toContain("Waiting");
    expect(unknown.textContent).not.toContain("today");
    // No edge or hatch repeats a date: the label and the heat speak.
    for (const tile of Array.from(
      slot.container.querySelectorAll(".wm-heat-tile"),
    ))
      expect(tile.className).not.toMatch(/wm-heat-(stale|overdue|aged)/);
    slot.lifecycle.unmount();
  });
  const heatFixture = () => ({
    tasks: [
      task({
        id: "t1",
        key: "TEST-1",
        title: "Pick a direction",
        threadIds: ["thr_input"],
      }),
      task({
        id: "t2",
        key: "TEST-2",
        title: "Read the result",
        threadIds: ["thr_done"],
      }),
      task({ id: "t3", key: "TEST-3", title: "Quiet backlog item" }),
    ],
    threads: [
      thread({ id: "thr_input", indicator: "waiting-for-input" }),
      thread({ id: "thr_done", indicator: "unread-success", isUnread: true }),
      thread({ id: "thr_live", title: "Live agent", indicator: "runtime" }),
      ...Array.from({ length: 5 }, (_, index) =>
        thread({ id: `thr_idle${index}`, title: `Finished ${index}` }),
      ),
    ],
  });
  const rect = (element: Element) => {
    const style = (element as HTMLElement).style;
    return {
      x: parseFloat(style.left),
      y: parseFloat(style.top),
      w: parseFloat(style.width),
      h: parseFloat(style.height),
    };
  };
  const areas = (slot: { container: HTMLElement }) =>
    Array.from(slot.container.querySelectorAll<HTMLElement>(".wm-heat-area"));

  /** Open Heat and expand the project area, which is where acts appear. */
  const expandProject = async (slot: Awaited<ReturnType<typeof mount>>) => {
    await slot.findByRole("button", { name: /^Open project Test project/ });
    fireEvent.click(slot.getByRole("button", { name: "Heat layout" }));
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-heat")).toBeTruthy(),
    );
    fireEvent.click(
      slot.getByRole("button", { name: /^Open project Test project/ }),
    );
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-bulk")).toBeTruthy(),
    );
  };
  /** Snooze all and Mark all done live in the open area's Manage menu. */
  const menuAct = (slot: Awaited<ReturnType<typeof mount>>, name: RegExp) => {
    const bar = slot.container.querySelector<HTMLElement>(".wm-heat-actions")!;
    fireEvent.click(
      within(bar).getByRole("button", { name: "Manage Test project" }),
    );
    fireEvent.click(within(bar).getByRole("menuitem", { name }));
  };

  it("offers acts on the tiles of an expanded area, not before", async () => {
    const slot = await mount({ ...heatFixture(), layout: "heat" });
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-heat")).toBeTruthy(),
    );
    // A collapsed map is for reading. Nothing is one click from being settled.
    expect(slot.container.querySelector(".wm-tile-actions")).toBeNull();
    fireEvent.click(
      slot.getByRole("button", { name: /^Open project Test project/ }),
    );
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-tile-actions")).toBeTruthy(),
    );
    expect(
      slot.getAllByRole("button", { name: /^Agent decides · / }).length,
    ).toBeGreaterThan(0);
    slot.lifecycle.unmount();
  });

  it("gives every tile of an expanded area a card with one act-row shape and no repeated state", async () => {
    const slot = await mount({ ...heatFixture(), layout: "heat" });
    await expandProject(slot);
    const open =
      slot.container.querySelector<HTMLElement>(".wm-heat-area-open")!;
    const slots = Array.from(
      open.querySelectorAll<HTMLElement>(
        ".wm-heat-slot:not(.wm-heat-slot-open)",
      ),
    ).filter((node) => node.querySelector(".wm-heat-tile:not(.wm-heat-group)"));
    expect(slots.length).toBe(3);
    // An open area is a flow of content-sized cards: the grid places them,
    // so no slot carries a rectangle of its own.
    expect(open.querySelector(".wm-heat-cards")!.classList).toContain(
      "wm-heat-flow",
    );
    for (const node of slots) expect(node.style.width).toBe("");
    // Every card has the same act-row shape and all three acts.
    expect(new Set(slots.map((node) => node.dataset.acts)).size).toBe(1);
    expect(["full", "lead", "icons"]).toContain(slots[0].dataset.acts);
    for (const node of slots)
      expect(
        node.querySelectorAll(".wm-tile-actions > button"),
      ).toHaveLength(3);
    // The quiet backlog task is still a card you can act on.
    const quiet = slot.getByRole("button", {
      name: /^Preview Quiet backlog item\./,
    });
    expect(
      quiet.closest(".wm-heat-slot")!.querySelector(".wm-tile-actions"),
    ).toBeTruthy();
    // The hue already says "Needs your input"; the facts carry only what it
    // adds, and in a flow the priority belongs to the group label, not a fact.
    const facts = Array.from(open.querySelectorAll(".wm-heat-facts")).map(
      (node) => node.textContent ?? "",
    );
    expect(facts.join(" ")).not.toContain("Needs your input");
    expect(facts.join(" ")).not.toContain("priority");
    expect(open.querySelector(".wm-heat-reason")).toBeNull();
    // Every task here is medium: one group, so no label repeats it.
    expect(open.querySelector(".wm-heat-group-label")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("opens an area in Heat as a flow of cards under priority labels", async () => {
    const slot = await mount({
      layout: "heat",
      tasks: [
        task({ id: "t1", key: "TEST-1", title: "Medium one" }),
        task({ id: "t2", key: "TEST-2", title: "Urgent one", priority: "urgent" }),
        task({ id: "t3", key: "TEST-3", title: "Low one", priority: "low" }),
      ],
      threads: [],
    });
    await expandProject(slot);
    const open =
      slot.container.querySelector<HTMLElement>(".wm-heat-area-open")!;
    expect(open.querySelector(".wm-heat-cards")!.classList).toContain(
      "wm-heat-flow",
    );
    expect(
      within(open)
        .getAllByRole("heading", { level: 4 })
        .map((node) => node.textContent),
    ).toEqual(["Urgent", "Medium", "Low / none"]);
    slot.lifecycle.unmount();
  });

  it("keeps Mark all done away from the primary act and makes its confirmation read as a close", async () => {
    const slot = await mount({ ...heatFixture(), layout: "heat" });
    await expandProject(slot);
    const row = slot.container.querySelector<HTMLElement>(".wm-bulk-row")!;
    // One row: the area's own buttons, the primary act, the picker, the
    // count and the menus. Nothing else is a button there.
    const names = Array.from(row.querySelectorAll("button")).map(
      (button) =>
        button.getAttribute("aria-label") ?? button.textContent?.trim() ?? "",
    );
    expect(names).toEqual([
      "New session",
      "Collapse area",
      "Let agents decide all",
      "Pick tasks",
      "Add to Test project",
      "Manage Test project",
    ]);
    // Nothing is picked, so the hint has nothing to say; the count is enough.
    expect(row.textContent).toContain("3 tasks");
    expect(slot.container.querySelector(".wm-bulk-hint")).toBeNull();
    // Mark all done is last in the menu, after Snooze all and the side pane.
    fireEvent.click(
      within(row).getByRole("button", { name: "Manage Test project" }),
    );
    const items = within(row)
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");
    expect(items.slice(0, 3)).toEqual([
      "Open in side pane",
      expect.stringMatching(/^Snooze all/),
      expect.stringMatching(/^Mark all done/),
    ]);
    fireEvent.click(within(row).getByRole("menuitem", { name: /^Mark all done/ }));
    const confirm = await slot.findByRole("dialog");
    // Focus rests on the dialog, so Enter cannot close three tasks unread.
    expect(document.activeElement).toBe(confirm);
    expect(confirm.className).toContain("wm-bulk-confirm-done");
    expect(
      within(confirm).getByRole("button", { name: "Mark 3 tasks done" })
        .className,
    ).toContain("bg-destructive");
    // The tiles behind it did not move: the dialog lies over them.
    expect(
      slot.container.querySelector(".wm-heat-area-open .wm-bulk-anchor"),
    ).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    slot.lifecycle.unmount();
  });

  it("delegates one task with the whole standing brief and its own request id", async () => {
    const delegateRequests: { requestId: string; taskId: string }[] = [];
    const slot = await mount({ ...heatFixture(), delegateRequests });
    await expandProject(slot);
    fireEvent.click(
      slot.getByRole("button", {
        name: "Agent decides · Pick a direction",
      }),
    );
    await waitFor(() => expect(delegateRequests).toHaveLength(1));
    expect(delegateRequests[0].taskId).toBe("t1");
    expect(delegateRequests[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    // The map says where the work went, naming the preset that will run it.
    await slot.findByText(/handed to an agent on wiz/);
    slot.lifecycle.unmount();
  });

  it("names the count, the orchestrator and its limit before a bulk act runs", async () => {
    const delegateAreaRequests: {
      requestId: string;
      projectId: string;
      taskIds: string[];
    }[] = [];
    const slot = await mount({ ...heatFixture(), delegateAreaRequests });
    await expandProject(slot);
    fireEvent.click(
      slot.getByRole("button", { name: /^Let agents decide all/ }),
    );
    const confirm = await slot.findByRole("dialog");
    expect(
      within(confirm).getByRole("heading", {
        name: "Let agents decide 3 tasks?",
      }),
    ).toBeTruthy();
    for (const key of ["TEST-1", "TEST-2", "TEST-3"])
      expect(within(confirm).getByText(key)).toBeTruthy();
    expect(
      within(confirm).getByText(
        /Starts Test project orchestrator for 3 tasks\. It runs at most 3 at a time, brings every task to done or back to you with a reason, and leaves you one review task with the summary\./,
      ),
    ).toBeTruthy();
    expect(within(confirm).getByText(/wiz/)).toBeTruthy();
    // Nothing is dispatched by opening the confirmation.
    expect(delegateAreaRequests).toHaveLength(0);
    fireEvent.click(
      within(confirm).getByRole("button", {
        name: "Let agents decide 3 tasks",
      }),
    );
    // One orchestrator for the area, never one agent per task.
    await waitFor(() => expect(delegateAreaRequests).toHaveLength(1));
    expect(delegateAreaRequests[0].projectId).toBe("p1");
    expect(delegateAreaRequests[0].taskIds).toEqual(["t1", "t2", "t3"]);
    expect(delegateAreaRequests[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    await slot.findByText(
      /Test project orchestrator started on wiz for 3 tasks, at most 3 at a time\./,
    );
    slot.lifecycle.unmount();
  });

  it("shows the pick list in whole rows and fades its last row while more wait below", async () => {
    const slot = await mount({ ...heatFixture() });
    await expandProject(slot);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("wm-bulk-picks") ? 200 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("wm-bulk-picks") ? 76 : 0;
      },
    );
    fireEvent.click(slot.getByRole("button", { name: "Pick tasks" }));
    const list = slot.getByRole("list", { name: /^Pick work in/ });
    await waitFor(() => expect(list.classList).toContain("wm-bulk-picks-more"));
    // Scrolled to the end, nothing waits below: the fade goes.
    Object.defineProperty(list, "scrollTop", {
      value: 124,
      configurable: true,
    });
    fireEvent.scroll(list);
    await waitFor(() =>
      expect(list.classList).not.toContain("wm-bulk-picks-more"),
    );
    const css = readFileSync(join(__dirname, "app.css"), "utf8");
    expect(css).toContain("max-height: calc(3 * 24px + 2 * 2px);");
    expect(css).toContain("max-height: calc(3 * 36px + 2 * 2px);");
    slot.lifecycle.unmount();
  });

  it("acts on the picked subset only, and cancelling changes nothing", async () => {
    const delegateAreaRequests: {
      requestId: string;
      projectId: string;
      taskIds: string[];
    }[] = [];
    const slot = await mount({ ...heatFixture(), delegateAreaRequests });
    await expandProject(slot);
    // The picker is shut by default so the area keeps its room for tiles.
    expect(slot.queryByRole("checkbox", { name: /TEST-2/ })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Pick tasks" }));
    fireEvent.click(slot.getByRole("checkbox", { name: /TEST-2/ }));
    await slot.findByText(/1 of 3 picked/);
    fireEvent.click(slot.getByRole("button", { name: /^Let agents decide 1/ }));
    const confirm = await slot.findByRole("dialog");
    expect(
      within(confirm).getByRole("heading", {
        name: "Let agents decide 1 task?",
      }),
    ).toBeTruthy();
    expect(within(confirm).queryByText("TEST-1")).toBeNull();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(delegateAreaRequests).toHaveLength(0);
    fireEvent.click(slot.getByRole("button", { name: /^Let agents decide 1/ }));
    fireEvent.click(
      within(await slot.findByRole("dialog")).getByRole("button", {
        name: "Let agents decide 1 task",
      }),
    );
    await waitFor(() => expect(delegateAreaRequests).toHaveLength(1));
    expect(delegateAreaRequests[0].taskIds).toEqual(["t2"]);
    slot.lifecycle.unmount();
  });

  it("marks a task done through the same settlement that Undo reverses", async () => {
    const settleRequests: SettleInput[] = [];
    const slot = await mount({ ...heatFixture(), settleRequests });
    await expandProject(slot);
    fireEvent.click(
      slot.getByRole("button", { name: "Done · Pick a direction" }),
    );
    await waitFor(() => expect(settleRequests).toHaveLength(1));
    expect(settleRequests[0].action).toBe("done");
    expect(settleRequests[0].taskId).toBe("t1");
    // It lands in Settled today, which is where its Undo lives.
    const strip = await slot.findByRole("region", { name: "Settled today" });
    expect(within(strip).getByRole("button", { name: /Undo/ })).toBeTruthy();
    slot.lifecycle.unmount();
  });

  it("snoozes one task for 7 days in this plugin only, with no confirmation, and Undo clears it", async () => {
    const settleRequests: SettleInput[] = [];
    const slot = await mount({ ...heatFixture(), settleRequests });
    await expandProject(slot);
    const snoozes = () =>
      slot.inspection.rpcCalls
        .filter((call) => call.method === "setPreference")
        .map(
          (call) => call.input as { id: string; snoozedUntil?: number | null },
        )
        .filter((input) => input.snoozedUntil !== undefined);
    const before = Date.now();
    fireEvent.click(
      slot.getByRole("button", { name: "Snooze 7d · Read the result" }),
    );
    await waitFor(() => expect(snoozes()).toHaveLength(1));
    const after = Date.now();
    // Reversible and outside Tasks, so a single card asks nothing first.
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(snoozes()[0].id).toBe("task:t2");
    const week = 7 * 86400000;
    expect(snoozes()[0].snoozedUntil).toBeGreaterThanOrEqual(before + week);
    expect(snoozes()[0].snoozedUntil).toBeLessThanOrEqual(after + week);
    expect(settleRequests).toHaveLength(0);
    const strip = await slot.findByRole("region", { name: "Settled today" });
    expect(strip.textContent).toContain("Read the result");
    expect(strip.textContent).toMatch(
      /Snoozed until \d{4}-\d{2}-\d{2} · Tasks unchanged/,
    );
    fireEvent.click(within(strip).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(snoozes()).toHaveLength(2));
    expect(snoozes()[1]).toEqual({ id: "task:t2", snoozedUntil: null });
    await slot.findByText("Undone. Snooze cleared.");
    expect(slot.queryByRole("region", { name: "Settled today" })).toBeNull();
    expect(settleRequests).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("opens tidy mode from the slipped-dates chip and fixes a date in one click with Undo in Settled today", async () => {
    const current = Date.now();
    const days = (offset: number) => localDay(current + offset * 86400000);
    const settleRequests: SettleInput[] = [];
    const slot = await mount({
      layout: "heat",
      threads: [],
      settleRequests,
      tasks: [
        task({
          id: "slip",
          key: "TEST-1",
          title: "Slipped plan",
          dateKind: "deadline",
          dueDate: days(-20),
        }),
        task({
          id: "soon",
          key: "TEST-2",
          title: "Tomorrow plan",
          dateKind: "deadline",
          dueDate: days(1),
        }),
      ],
    });
    await slot.findByRole("button", { name: /^Preview Slipped plan/ });
    const map = () => slot.container.querySelector<HTMLElement>(".wm-heat")!;
    const chip = slot.getByRole("button", { name: "1 slipped date" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(map().dataset.tidy).toBeUndefined();
    // The slipped date is no longer urgency: it does not count as overdue.
    expect(
      Array.from(slot.container.querySelectorAll(".wm-heat-counts > div")).map(
        (entry) => entry.textContent,
      ),
    ).toContain("0overdue");
    fireEvent.click(chip);
    await waitFor(() => expect(map().dataset.tidy).toBe("true"));
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(slot.container.querySelector(".wm-heat-hint")?.textContent).toBe(
      "Tidy mode · Fix a date in one click, Undo in Settled today · Escape leaves",
    );
    // Open the area so both tasks are cards with a footer.
    fireEvent.click(
      slot.getByRole("button", { name: /^Open project Test project/ }),
    );
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-heat-area-open")).toBeTruthy(),
    );
    const card = (title: string) =>
      slot
        .getByRole("button", { name: new RegExp(`^Preview ${title}`) })
        .closest<HTMLElement>(".wm-heat-slot")!;
    await waitFor(() =>
      expect(card("Slipped plan").querySelectorAll(".wm-date-fix")).toHaveLength(4),
    );
    // On the slipped card the fixes replace the act row; the other keeps it.
    expect(card("Slipped plan").querySelector(".wm-tile-actions")).toBeNull();
    expect(card("Tomorrow plan").querySelector(".wm-tile-actions")).toBeTruthy();
    expect(card("Tomorrow plan").querySelector(".wm-date-fix")).toBeNull();
    expect(
      Array.from(
        card("Slipped plan").querySelectorAll(".wm-date-fix"),
        (button) => button.textContent,
      ),
    ).toEqual(["Today", "+1 week", "+1 month", "No date"]);
    // A week ahead on the local calendar.
    const at = new Date(current);
    const week = localDay(
      new Date(at.getFullYear(), at.getMonth(), at.getDate() + 7, 12).getTime(),
    );
    fireEvent.click(
      within(card("Slipped plan")).getByRole("button", {
        name: `Move TEST-1 to ${week}`,
      }),
    );
    await waitFor(() => expect(settleRequests).toHaveLength(1));
    expect(settleRequests[0]).toMatchObject({
      action: "date",
      taskId: "slip",
      dueDate: week,
    });
    const strip = await slot.findByRole("region", { name: "Settled today" });
    expect(strip.textContent).toContain(
      `Date moved to ${week} · was ${days(-20)}`,
    );
    expect(within(strip).getByRole("button", { name: /Undo/ })).toBeTruthy();
    // Escape steps back the area first, then leaves tidy mode.
    fireEvent.keyDown(map(), { key: "Escape" });
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-heat-area-open")).toBeNull(),
    );
    expect(map().dataset.tidy).toBe("true");
    fireEvent.keyDown(map(), { key: "Escape" });
    await waitFor(() => expect(map().dataset.tidy).toBeUndefined());
    expect(
      slot.getByRole("button", { name: "1 slipped date" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(slot.container.querySelector(".wm-heat-hint")?.textContent).toBe(
      "Click to expand in place · Escape steps back",
    );
    // Leaving Heat leaves tidy mode too.
    fireEvent.click(slot.getByRole("button", { name: "1 slipped date" }));
    await waitFor(() => expect(map().dataset.tidy).toBe("true"));
    fireEvent.click(slot.getByRole("button", { name: "Overview layout" }));
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-heat")).toBeNull(),
    );
    fireEvent.click(slot.getByRole("button", { name: "Heat layout" }));
    await waitFor(() => expect(slot.container.querySelector(".wm-heat")).toBeTruthy());
    expect(map().dataset.tidy).toBeUndefined();
    expect(
      slot.getByRole("button", { name: "1 slipped date" }).getAttribute("aria-pressed"),
    ).toBe("false");
    slot.lifecycle.unmount();
  });

  it("offers no slipped-dates chip when nothing has slipped", async () => {
    const current = Date.now();
    const slot = await mount({
      layout: "heat",
      threads: [],
      tasks: [
        task({
          id: "late",
          key: "TEST-1",
          title: "Two weeks late",
          dateKind: "deadline",
          // Calendar days, so a daylight-saving change never makes it 15.
          dueDate: localDay(
            new Date(
              new Date(current).getFullYear(),
              new Date(current).getMonth(),
              new Date(current).getDate() - 14,
              12,
            ).getTime(),
          ),
        }),
      ],
    });
    const late = await slot.findByRole("button", { name: /^Preview Two weeks late/ });
    // Fourteen days past is still late, not slipped: overdue, and no tidying.
    expect(late.dataset.slipped).toBeUndefined();
    expect(
      Array.from(slot.container.querySelectorAll(".wm-heat-counts > div")).map(
        (entry) => entry.textContent,
      ),
    ).toContain("1overdue");
    expect(slot.container.querySelector(".wm-heat-chip")).toBeNull();
    expect(slot.queryByRole("button", { name: /slipped date/ })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("offers Unsnooze on a card snoozed before this page loaded, and it clears the snooze without asking", async () => {
    // A fresh page: the snooze is saved, the session that made it is gone,
    // so there is no Undo receipt. The card itself is the way back.
    const settleRequests: SettleInput[] = [];
    const slot = await mount({
      ...heatFixture(),
      settleRequests,
      preferences: {
        "task:t2": { snoozedUntil: Date.now() + 7 * 86400000 },
      },
    });
    await expandProject(slot);
    expect(slot.queryByRole("region", { name: "Settled today" })).toBeNull();
    expect(slot.queryByRole("button", { name: /^Snooze 7d · Read the result/ })).toBeNull();
    const card = slot.container.querySelector<HTMLElement>(
      '.wm-heat-area-open [data-layout-id="task:t2"]',
    )!;
    // Heat and Overview read the same day count.
    expect(card.textContent).toContain("snoozed 7d");
    const unsnooze = slot.getByRole("button", {
      name: "Unsnooze · Read the result",
    });
    expect((unsnooze as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(unsnooze);
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (call) =>
            call.method === "setPreference" &&
            (call.input as { id: string; snoozedUntil?: null }).id === "task:t2" &&
            (call.input as { snoozedUntil?: null }).snoozedUntil === null,
        ),
      ).toBe(true),
    );
    expect(slot.queryByRole("dialog")).toBeNull();
    await slot.findByText("Snooze cleared on TEST-2.");
    // Its attention is back, and so is the act that snoozes it.
    await slot.findByRole("button", { name: "Snooze 7d · Read the result" });
    expect(settleRequests).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("confirms a bulk snooze with honest copy and snoozes each task in turn", async () => {
    const settleRequests: SettleInput[] = [];
    const slot = await mount({ ...heatFixture(), settleRequests });
    await expandProject(slot);
    menuAct(slot, /^Snooze all/);
    const confirm = await slot.findByRole("dialog");
    expect(confirm.textContent).toContain(
      "Snoozing hides the task from what needs you for 7 days and changes nothing in Tasks. New input or a failed run still brings it back. Unsnooze on its card ends it early.",
    );
    expect(confirm.textContent).not.toContain("clears it from what needs you");
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Snooze 3 tasks" }),
    );
    await slot.findByText("Snooze 7d · 3 of 3 tasks.");
    const ids = slot.inspection.rpcCalls
      .filter((call) => call.method === "setPreference")
      .map((call) => (call.input as { id: string }).id);
    expect([...ids].sort()).toEqual(["task:t1", "task:t2", "task:t3"]);
    expect(settleRequests).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("holds an open area's tiles in place through a refresh that re-ranks them, updating only their facts", async () => {
    const fixture = heatFixture();
    const slot = await mount(fixture);
    await expandProject(slot);
    const open = () =>
      slot.container.querySelector<HTMLElement>(".wm-heat-area-open")!;
    const places = () =>
      Object.fromEntries(
        Array.from(
          open().querySelectorAll<HTMLElement>(".wm-heat-slot[data-layout-id]"),
        ).map((node) => [node.dataset.layoutId, rect(node)]),
      );
    const before = places();
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining(["task:t1", "task:t2", "task:t3"]),
    );
    // The quiet backlog task turns urgent and due today: it outranks the rest.
    Object.assign(fixture.tasks[2], {
      priority: "urgent",
      dueDate: localDay(Date.now()),
      dateKind: "deadline",
    });
    fireEvent.click(slot.getByRole("button", { name: "Refresh map" }));
    await waitFor(() =>
      expect(
        open().querySelector('[data-layout-id="task:t3"]')!.textContent,
      ).toContain("today"),
    );
    expect(places()).toEqual(before);
    slot.lifecycle.unmount();
  });

  it("keeps the area open through a bulk settle and refreshes once at the end", async () => {
    const settleRequests: SettleInput[] = [];
    const slot = await mount({ ...heatFixture(), settleRequests });
    await expandProject(slot);
    const before = slot.inspection.rpcCalls.filter(
      (call) => call.method === "snapshot",
    ).length;
    menuAct(slot, /^Mark all done/);
    fireEvent.click(
      within(await slot.findByRole("dialog")).getByRole("button", {
        name: /^Mark \d+ tasks? done$/,
      }),
    );
    await waitFor(() => expect(settleRequests.length).toBeGreaterThan(1));
    // The area the run was started from is still the one you are looking at.
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-heat-area-open")).toBeTruthy(),
    );
    const after = slot.inspection.rpcCalls.filter(
      (call) => call.method === "snapshot",
    ).length;
    expect(after - before).toBeLessThanOrEqual(2);
    slot.lifecycle.unmount();
  });

  it("reports a failed area dispatch in the bar that started it, with its count", async () => {
    const delegateAreaRequests: {
      requestId: string;
      projectId: string;
      taskIds: string[];
    }[] = [];
    const slot = await mount({
      ...heatFixture(),
      delegateAreaRequests,
      delegateAreaError: "Preset is gone.",
    });
    await expandProject(slot);
    fireEvent.click(
      slot.getByRole("button", { name: /^Let agents decide all/ }),
    );
    fireEvent.click(
      within(await slot.findByRole("dialog")).getByRole("button", {
        name: "Let agents decide 3 tasks",
      }),
    );
    // The failure lands in the bulk bar, announced, not in Settled today.
    const failure = await waitFor(() => {
      const row = slot.container.querySelector(".wm-bulk-error");
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });
    expect(failure.getAttribute("role")).toBe("alert");
    expect(failure.textContent).toContain("Preset is gone.");
    expect(failure.textContent).toContain(
      "No agent was started; all 3 tasks are unchanged.",
    );
    expect(delegateAreaRequests).toHaveLength(1);
    // A failed handover frees the work: the act comes back, not stays spent.
    await slot.findByRole("button", { name: /^Let agents decide all/ });
    fireEvent.click(within(failure).getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-bulk-error")).toBeNull(),
    );
    slot.lifecycle.unmount();
  });

  it("stops a bulk settle at the first failure and says how far it got", async () => {
    const slot = await mount({
      ...heatFixture(),
      settleError: true,
    });
    await expandProject(slot);
    menuAct(slot, /^Mark all done/);
    fireEvent.click(
      within(await slot.findByRole("dialog")).getByRole("button", {
        name: /^Mark \d+ tasks? done$/,
      }),
    );
    const failure = await waitFor(() => {
      const row = slot.container.querySelector(".wm-bulk-error");
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });
    expect(failure.textContent).toContain(
      "Stopped after 0 of 3; the rest are unchanged.",
    );
    slot.lifecycle.unmount();
  });

  it("shows a failed card act on that card, dismissibly and announced", async () => {
    const slot = await mount({
      ...heatFixture(),
      delegateError: "This task changed since you opened it.",
    });
    await expandProject(slot);
    fireEvent.click(
      slot.getByRole("button", { name: "Agent decides · Pick a direction" }),
    );
    // The reason appears on the card that was clicked, not in the settled strip.
    const failure = await waitFor(() => {
      const row = slot.container.querySelector(".wm-tile-error");
      expect(row).toBeTruthy();
      return row as HTMLElement;
    });
    expect(failure.getAttribute("role")).toBe("alert");
    expect(failure.textContent).toContain(
      "This task changed since you opened it.",
    );
    expect(failure.closest(".wm-heat-slot")?.textContent).toContain(
      "Pick a direction",
    );
    fireEvent.click(
      within(failure).getByRole("button", {
        name: "Dismiss the error on Pick a direction",
      }),
    );
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-tile-error")).toBeNull(),
    );
    slot.lifecycle.unmount();
  });

  it("disables the handover with its reason when the area has no bb project", async () => {
    const delegateAreaRequests: {
      requestId: string;
      projectId: string;
      taskIds: string[];
    }[] = [];
    const slot = await mount({
      ...heatFixture(),
      linkedBbProjectId: null,
      delegateAreaRequests,
    });
    await expandProject(slot);
    // The act stays on the card, disabled, saying why: the click that failed
    // tonight is now impossible to make.
    const blocked = slot.getByRole("button", {
      name: "Agent decides · Pick a direction · unavailable: project not linked to a bb project",
    });
    expect(blocked.hasAttribute("disabled")).toBe(true);
    expect(
      slot.container.querySelector(".wm-tile-note")?.textContent,
    ).toContain("Cannot hand over: project not linked to a bb project");
    // With nothing to hand over, the area never offers the bulk act either.
    expect(
      slot.queryByRole("button", { name: /^Let agents decide/ }),
    ).toBeNull();
    // Closing and snoozing never needed an agent, so they still work.
    expect(
      slot
        .getByRole("button", { name: "Done · Pick a direction" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(delegateAreaRequests).toHaveLength(0);
    slot.lifecycle.unmount();
  });

  it("will not hand an area over twice while its first agents are starting", async () => {
    const delegateAreaRequests: {
      requestId: string;
      projectId: string;
      taskIds: string[];
    }[] = [];
    const slot = await mount({ ...heatFixture(), delegateAreaRequests });
    await expandProject(slot);
    const open = () =>
      slot.queryByRole("button", { name: /^Let agents decide all/ });
    fireEvent.click(open()!);
    const confirm = await slot.findByRole("dialog");
    const run = within(confirm).getByRole("button", {
      name: "Let agents decide 3 tasks",
    });
    // Two clicks in the same moment, which is how twelve tasks became twenty-four.
    fireEvent.click(run);
    fireEvent.click(run);
    await waitFor(() => expect(delegateAreaRequests).toHaveLength(1));
    // The bulk act does not come back before the refresh shows the new state,
    // and once it does, the work reads as taken and cannot be handed over again.
    await waitFor(() => expect(open()).toBeNull());
    expect(delegateAreaRequests).toHaveLength(1);
    // Every card says the same thing, in the place the click would have been.
    expect(delegateAreaRequests).toHaveLength(1);
    // Every card in the area says the same thing where the click would have been.
    for (const title of [
      "Pick a direction",
      "Read the result",
      "Quiet backlog item",
    ])
      expect(
        slot
          .getByRole("button", {
            name: `Agent decides · ${title} · unavailable: an agent is already running on it`,
          })
          .hasAttribute("disabled"),
      ).toBe(true);
    slot.lifecycle.unmount();
  });

  it("opens a running orchestrator instead of starting a second one", async () => {
    const slot = await mount({ ...heatFixture(), areaRunning: true });
    await expandProject(slot);
    fireEvent.click(
      slot.getByRole("button", { name: /^Let agents decide all/ }),
    );
    fireEvent.click(
      within(await slot.findByRole("dialog")).getByRole("button", {
        name: "Let agents decide 3 tasks",
      }),
    );
    await slot.findByText(
      /Test project orchestrator is already running this area\. Opened it instead of starting another\./,
    );
    expect(
      slot.inspection.sidebarActionCalls.filter(
        (call) => call.method === "open",
      ),
    ).toEqual([{ method: "open", threadId: "thr_orch" }]);
    slot.lifecycle.unmount();
  });

  it("tells a truly empty account how to start instead of pointing at Overview", async () => {
    for (const layout of ["heat", "overview"] as const) {
      const slot = await mount({
        tasks: [],
        threads: [],
        noProjects: true,
        layout,
      });
      expect(
        await slot.findByText(
          "No open work yet. Create a project or start a session.",
        ),
      ).toBeTruthy();
      expect(slot.queryByText(/Choose Overview/)).toBeNull();
      slot.lifecycle.unmount();
    }
  });

  it("never paints Overview's chrome while a stored Heat layout loads, nor in a Heat search", async () => {
    let openLayout = () => {};
    let openSnapshot = () => {};
    const layoutGate = new Promise<void>((resolve) => (openLayout = resolve));
    const snapshotGate = new Promise<void>(
      (resolve) => (openSnapshot = resolve),
    );
    let footerSeen = false;
    const watch = new MutationObserver(() => {
      if (document.querySelector(".wm-footer")) footerSeen = true;
    });
    watch.observe(document.body, { childList: true, subtree: true });
    const slot = await mount({
      ...heatFixture(),
      layout: "heat",
      layoutGate,
      snapshotGate,
    });
    const pressed = () =>
      ["Overview layout", "Heat layout"].map((name) =>
        slot.getByRole("button", { name }).getAttribute("aria-pressed"),
      );
    await slot.findByText("Gathering your projects and sessions…");
    expect(pressed()).toEqual(["false", "false"]);
    expect(slot.queryByRole("group", { name: "Attention counts" })).toBeNull();
    // The tasks arrive first: still no layout, so still nothing but the wait.
    openSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      slot.getByText("Gathering your projects and sessions…"),
    ).toBeTruthy();
    expect(slot.container.querySelector(".wm-spatial")).toBeNull();
    openLayout();
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-heat")).toBeTruthy(),
    );
    expect(pressed()).toEqual(["false", "true"]);
    expect(slot.getByRole("group", { name: "Attention counts" })).toBeTruthy();
    // A search from Heat that finds nothing is still Heat's: no Overview footer.
    fireEvent.change(slot.getByRole("textbox"), {
      target: { value: "zzz no such work" },
    });
    await slot.findByText("No matching work");
    expect(slot.container.querySelector(".wm-footer")).toBeNull();
    watch.disconnect();
    expect(footerSeen).toBe(false);
    slot.lifecycle.unmount();
  });

  it("rests the zoom controls in Heat, whose geometry ignores zoom, and hands them back in Overview", async () => {
    const slot = await mount({ ...heatFixture(), layout: "heat" });
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-heat")).toBeTruthy(),
    );
    const controls = () => [
      slot.getByRole("button", { name: "Zoom in" }),
      slot.getByRole("button", { name: "Zoom out" }),
      slot.getByRole("slider", { name: "Map zoom level" }),
    ];
    for (const control of controls()) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
      expect(control.getAttribute("title")).toBe("Zoom applies to Overview");
    }
    expect(
      slot.getByRole("group", { name: "Map zoom" }).getAttribute("title"),
    ).toBe("Zoom applies to Overview");
    expect(slot.getByLabelText("Current map zoom").textContent).toBe("100%");
    fireEvent.click(slot.getByRole("button", { name: "Overview layout" }));
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-heat")).toBeNull(),
    );
    for (const control of controls()) {
      expect(control.getAttribute("title")).not.toBe(
        "Zoom applies to Overview",
      );
    }
    expect(
      (slot.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (slot.getByRole("slider", { name: "Map zoom level" }) as HTMLInputElement)
        .disabled,
    ).toBe(false);
    slot.lifecycle.unmount();
  });

  it("folds Heat's legend behind one remembered toggle, keeping the five counts", async () => {
    const slot = await mount({ ...heatFixture(), layout: "heat" });
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-heat")).toBeTruthy(),
    );
    const legend = slot.container.querySelector<HTMLElement>(".wm-heat-legend")!;
    const toggle = slot.getByRole("button", { name: "Legend" });
    // Shut by default; the stylesheet hides it only under 720px.
    expect(legend.dataset.open).toBe("false");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(legend.id);
    expect(
      slot.container.querySelectorAll(".wm-heat-counts > div"),
    ).toHaveLength(5);
    fireEvent.click(toggle);
    expect(legend.dataset.open).toBe("true");
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "setLegend"),
      ).toEqual([{ method: "setLegend", input: { open: true } }]),
    );
    slot.lifecycle.unmount();
    // A reload reads the choice back.
    const again = await mount({
      ...heatFixture(),
      layout: "heat",
      legendOpen: true,
    });
    await waitFor(() =>
      expect(
        again.container.querySelector<HTMLElement>(".wm-heat-legend")?.dataset
          .open,
      ).toBe("true"),
    );
    again.lifecycle.unmount();
  });

  it("stays off until chosen, then remembers the choice and sizes areas by pull", async () => {
    const slot = await mount(heatFixture());
    await slot.findByRole("button", { name: /^Open project Test project/ });
    expect(slot.container.querySelector(".wm-heat")).toBeNull();
    expect(
      slot
        .getByRole("button", { name: "Overview layout" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Heat layout" }));
    await waitFor(() =>
      expect(slot.container.querySelector(".wm-heat")).toBeTruthy(),
    );
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "setLayout"),
      ).toEqual([{ method: "setLayout", input: { layout: "heat" } }]),
    );
    const [project, sessions] = areas(slot);
    expect(project.getAttribute("aria-label")).toBe(
      "Test project · 1 need you",
    );
    // The project holds the only work that needs him, so it takes more room.
    expect(rect(project).w * rect(project).h).toBeGreaterThan(
      rect(sessions).w * rect(sessions).h,
    );
    const covered = areas(slot).reduce(
      (sum, area) => sum + rect(area).w * rect(area).h,
      0,
    );
    expect(covered).toBeCloseTo(10000, 4);
    slot.lifecycle.unmount();
  });

  it("preserves attention channels while marking aged undated work", async () => {
    const fixture = heatFixture();
    fixture.threads[0].latestAttentionAt = Date.now() - 44 * 86400000;
    // Routine edits reset neither creation age nor the current input wait.
    fixture.tasks[0].createdAt = new Date(
      Date.now() - 44 * 86400000,
    ).toISOString();
    fixture.tasks[0].updatedAt = new Date(
      Date.now() - 1 * 86400000,
    ).toISOString();
    fixture.tasks[0].title = "Decide: pick a direction";
    const slot = await mount({ ...fixture, layout: "heat" });
    const tile = await slot.findByRole("button", {
      name: /^Preview Decide: pick a direction/,
    });
    expect(tile.className).toContain("wm-heat-input");
    // A request for your hands keeps its shape on any heat: the glyph ahead of the key.
    expect(tile.querySelector(".wm-heat-flag")?.textContent).toBe("!");
    expect(tile.getAttribute("aria-label")).toContain("Needs your input");
    expect(tile.getAttribute("aria-label")).toContain("Waiting 44 days");
    expect(
      slot.getByRole("button", { name: /^Preview Read the result/ }).className,
    ).toContain("wm-heat-unread");
    expect(
      slot.getByRole("button", { name: /^Preview Live agent/ }).className,
    ).toContain("wm-heat-running");
    // The age stays on the tile, inside the reason it wears Now for.
    expect(tile.querySelector(".wm-heat-meta > span + span")?.textContent).toBe(
      "needs your input · 44d old · medium",
    );
    expect(tile.getAttribute("aria-label")).toContain("Created 44 days ago");
    // The verb moves to the label line; the title keeps its words.
    expect(tile.querySelector(".wm-heat-ask")?.textContent).toBe("decide");
    expect(tile.querySelector(".wm-heat-title")?.textContent).toBe(
      "pick a direction",
    );
    // A request for your hands fills Now before any date, and says so.
    expect(tile.getAttribute("data-tier")).toBe("now");
    expect(tile.getAttribute("aria-label")).toMatch(/Now(, \d of 3)?: needs your input/);
    expect(
      Array.from(slot.container.querySelectorAll(".wm-heat-counts > div")).map(
        (entry) => entry.textContent,
      ),
    ).toEqual([
      "1need you",
      "1ready to read",
      "1agents running",
      "0overdue",
      "1undated 30d+",
    ]);
    // Nothing has slipped, so there is nothing to tidy and no chip offers it.
    expect(slot.container.querySelector(".wm-heat-chip")).toBeNull();
    // One legend: a single row above the map, no footer repeating it.
    const legend = slot.container.querySelector(".wm-heat-legend")!;
    // Three tiers, then the few shape signals, then the sentence that reads them.
    expect(Array.from(legend.children, (entry) => entry.textContent)).toEqual([
      "NowNextLater",
      "Needs your input",
      "Run failed",
      "Agent working",
      "In focus",
      "Red = now, at most 5 · Amber = next · Grey = later · The tile says why",
    ]);
    expect(
      Array.from(legend.querySelectorAll(".wm-heat-tiers i.wm-heat-key"), (chip) =>
        chip.getAttribute("data-tier"),
      ),
    ).toEqual(["now", "next", "later"]);
    expect(legend.getAttribute("title")).toContain(
      "Red = now (at most 5 on the whole map)",
    );
    expect(legend.getAttribute("title")).toContain("slipped");
    expect(slot.container.querySelector(".wm-footer")).toBeNull();
    expect(slot.container.querySelector(".wm-heat-hint")?.textContent).toBe(
      "Click to expand in place · Escape steps back",
    );
    expect(
      slot.getByRole("button", { name: "Show work that needs you (1)" }),
    ).toBeTruthy();
    // Heat already holds every area, so the overview's Show all has nothing to add.
    expect(slot.container.querySelector(".wm-more")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("keeps an open card's cover at content height and gives the chat the rest of the card", async () => {
    const slot = await mount({
      layout: "heat",
      tasks: [task({ threadIds: ["thr_test"], status: "in_review" })],
      threads: [thread({ title: "First agent", indicator: "runtime" })],
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Chat here" }));
    const chat = slot.getByTestId("bb-thread-chat");
    // The stylesheet relies on exactly this nesting (app.css, open Heat card).
    const live = chat.closest(".wm-live-session")!;
    const view = live.parentElement!;
    const detail = view.parentElement!;
    const card = detail.parentElement!;
    expect(view.classList).toContain("wm-session-view");
    expect(detail.classList).toContain("wm-inline-detail");
    expect(card.classList).toContain("wm-heat-slot");
    expect(card.classList).toContain("wm-heat-slot-open");
    const cover = card.querySelector(":scope > .wm-heat-tile")!;
    expect(cover.getAttribute("aria-expanded")).toBe("true");
    // An open card's acts live in its one action bar, not on its cover.
    expect(card.querySelector(":scope > .wm-tile-acts")).toBeNull();
    expect(detail.querySelector(".wm-settle-bar")).toBeTruthy();
    // The closed-card rule that grows the cover must not match an open card.
    const css = readFileSync(join(__dirname, "app.css"), "utf8");
    // A card's footer is its act row or, in tidy mode, its date fixes.
    expect(css).toContain(
      ".wm-heat-slot:not(.wm-heat-slot-open):has(.wm-tile-actions, .wm-tile-fixes) > .wm-heat-tile {\n  flex: 1 1 auto;",
    );
    expect(css).not.toMatch(
      /\n\.wm-heat-slot:has\(\.wm-tile-actions(, \.wm-tile-fixes)?\) > \.wm-heat-tile \{/,
    );
    expect(css).toMatch(
      /\.wm-heat-slot-open \.wm-session-view > \.wm-live-session \{\n  flex: 1 1 0;/,
    );
    slot.lifecycle.unmount();
  });

  it("expands a tile in place, holds every neighbour's slot, and steps back out", async () => {
    const slot = await mount({ ...heatFixture(), layout: "heat" });
    const tile = await slot.findByRole("button", {
      name: /^Preview Pick a direction/,
    });
    const before = areas(slot).map((area) => ({
      id: area.dataset.layoutId,
      ...rect(area),
    }));
    fireEvent.click(tile);
    await slot.findByRole("region", { name: "Expanded: Pick a direction" });
    const after = areas(slot).map((area) => ({
      id: area.dataset.layoutId,
      ...rect(area),
    }));
    // Same areas, same reading order, same relative arrangement: only sizes move.
    expect(after.map((area) => area.id)).toEqual(before.map((area) => area.id));
    expect(after.map((area) => area.x <= after[0].x + after[0].w)).toEqual(
      after.map(() => true),
    );
    // The heaviest area keeps at least its share; expanding never shrinks it.
    const grown = after.find((area) => area.id === "project:p1")!;
    const was = before.find((area) => area.id === "project:p1")!;
    expect(grown.w * grown.h).toBeGreaterThanOrEqual(6600);
    expect(grown.w * grown.h).toBeGreaterThanOrEqual(was.w * was.h);
    expect(after.reduce((sum, area) => sum + area.w * area.h, 0)).toBeCloseTo(
      10000,
      4,
    );
    expect(tile.getAttribute("aria-expanded")).toBe("true");
    const detail = slot.getByRole("region", {
      name: "Expanded: Pick a direction",
    });
    expect(detail.closest(".wm-heat-slot")).toBe(tile.closest(".wm-heat-slot"));
    fireEvent.keyDown(detail, { key: "Escape" });
    await waitFor(() =>
      expect(
        slot.queryByRole("region", { name: "Expanded: Pick a direction" }),
      ).toBeNull(),
    );
    // Escape steps from the task to its area, then out to the map, which is
    // exactly the map it was before.
    const open = slot.container.querySelector(".wm-heat-area-open");
    if (open) {
      fireEvent.keyDown(open, { key: "Escape" });
      await waitFor(() =>
        expect(slot.container.querySelector(".wm-heat-area-open")).toBeNull(),
      );
    }
    expect(
      areas(slot).map((area) => ({ id: area.dataset.layoutId, ...rect(area) })),
    ).toEqual(before);
    slot.lifecycle.unmount();
  });

  it("gives a lighter area its room back and grows only the tile you opened", async () => {
    const slot = await mount({ ...heatFixture(), layout: "heat" });
    const tile = await slot.findByRole("button", {
      name: /^Preview Live agent/,
    });
    const slots = () =>
      Array.from(
        tile
          .closest(".wm-heat-area")!
          .querySelectorAll<HTMLElement>(".wm-heat-slot"),
      );
    const order = slots().map((slotEl) => slotEl.dataset.layoutId);
    fireEvent.click(tile);
    await slot.findByRole("region", { name: "Expanded: Live agent" });
    const sessions = areas(slot).find(
      (area) => area.dataset.layoutId === "heat:sessions",
    )!;
    const project = areas(slot).find(
      (area) => area.dataset.layoutId === "project:p1",
    )!;
    expect(rect(sessions).w * rect(sessions).h).toBeCloseTo(6600, 0);
    expect(rect(project).w * rect(project).h).toBeCloseTo(3400, 0);
    // Siblings keep their slots in the same order; only the open tile grows.
    expect(slots().map((slotEl) => slotEl.dataset.layoutId)).toEqual(order);
    const open = tile.closest(".wm-heat-slot") as HTMLElement;
    expect(rect(open).w * rect(open).h).toBeCloseTo(7800, 0);
    slot.lifecycle.unmount();
  });

  it("brings the whole map back when Heat is chosen from a filter", async () => {
    const slot = await mount({ ...heatFixture(), layout: "heat" });
    await slot.findByRole("button", { name: /^Preview Pick a direction/ });
    fireEvent.click(slot.getByRole("button", { name: /^Working/ }));
    await waitFor(() => expect(areas(slot)).toHaveLength(0));
    fireEvent.click(slot.getByRole("button", { name: "Heat layout" }));
    await waitFor(() => expect(areas(slot).length).toBeGreaterThan(0));
    expect(
      slot
        .getByRole("button", { name: "All work" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    slot.lifecycle.unmount();
  });

  it("keeps finished agents in one quiet tile until you ask for them", async () => {
    const slot = await mount({ ...heatFixture(), layout: "heat" });
    const group = await slot.findByRole("button", {
      name: "Show 5 agents finished in Sessions",
    });
    expect(
      slot.queryByRole("button", { name: /^Preview Finished 0/ }),
    ).toBeNull();
    fireEvent.click(group);
    await slot.findByRole("button", { name: /^Preview Finished 0/ });
    expect(
      slot.queryByRole("button", { name: /agents finished in Sessions/ }),
    ).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("map bookkeeping under load", () => {
  it("never measures the map for keys typed into an editor inside it", async () => {
    const slot = await mount();
    const card = await slot.findByRole("button", {
      name: /^Open project Test project/,
    });
    const root = slot.container.querySelector(".wm-root")!;
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    root.append(editor);
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    for (const key of ["a", " ", "Enter", "Escape"])
      fireEvent.keyDown(editor, { key });
    expect(measure).not.toHaveBeenCalled();
    fireEvent.keyDown(card, { key: "Enter" });
    expect(measure).toHaveBeenCalled();
    measure.mockRestore();
    editor.remove();
    slot.lifecycle.unmount();
  });

  it("keeps the newer snapshot when an older refresh resolves after it", async () => {
    let releaseOld: (tasks: MapTask[]) => void = () => undefined;
    let base = Infinity;
    const slot = await mount({
      tasks: [task({ nextAction: "Loaded first" })],
      snapshot: (call) =>
        call === base + 1
          ? new Promise<MapTask[]>((resolve) => (releaseOld = resolve))
          : call === base + 2
            ? Promise.resolve([task({ nextAction: "Newest step" })])
            : null,
    });
    await slot.findByText(/Loaded first/);
    base = slot.inspection.rpcCalls.filter(
      (call) => call.method === "snapshot",
    ).length;
    fireEvent.click(slot.getByRole("button", { name: "Refresh map" }));
    fireEvent.click(slot.getByRole("button", { name: "Refresh map" }));
    await slot.findByText(/Newest step/);
    releaseOld([task({ nextAction: "Stale step" })]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.container.textContent).toContain("Newest step");
    expect(slot.container.textContent).not.toContain("Stale step");
    slot.lifecycle.unmount();
  });
});

describe("the opened task", () => {
  const description =
    "Why: the gate stays red.\n\nWhat happened:\n1. Step one ran.\n2. Step two failed.\n\n<script>alert(1)</script>\n\nNEXT STEP: choose a gate.";
  const details = () => ({
    task1: {
      description,
      comments: [
        {
          id: "c-old",
          kind: "user" as const,
          authorName: "You",
          threadId: null,
          body: "First word.",
          createdAt: "2026-09-16T10:00:00Z",
        },
        {
          id: "c-sys",
          kind: "system" as const,
          authorName: "cli",
          threadId: null,
          body: "Status changed to In Review by cli",
          createdAt: "2026-09-16T11:00:00Z",
        },
        {
          id: "c-agent",
          kind: "agent" as const,
          authorName: "",
          threadId: "thr_worker",
          threadTitle: "Gate worker",
          body: "**Needs you:** pick gate A or B.",
          createdAt: "2026-09-17T09:00:00Z",
        },
      ],
      labels: [{ id: "l1", name: "gate", color: "#0af" }],
    },
  });
  it("shows one action bar with no act twice, the ask once, the description as Markdown and the timeline newest first", async () => {
    const slot = await mount({
      tasks: [
        task({
          status: "in_review",
          ask: "pick gate A or B.",
          askFrom: "comment",
          summary: "pick gate A or B.",
        }),
      ],
      details: details(),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    const detail = slot.getByRole("region", {
      name: "Expanded: Review proposal",
    });
    const card = detail.closest(".wm-item-expanded") as HTMLElement;
    // One bar: every act once, across the bar and its menu.
    const bar = within(detail).getByRole("region", { name: "Act on this task" });
    const labels = Array.from(
      bar.querySelectorAll(".wm-settle-buttons button, .wm-settle-buttons a"),
      (b) => b.getAttribute("aria-label") || b.textContent?.trim(),
    );
    expect(labels).toEqual([
      "Agent decides",
      "Done",
      "Ready for review",
      "Pause here",
      "More on TEST-1",
    ]);
    fireEvent.click(within(bar).getByRole("button", { name: "More on TEST-1" }));
    const menu = within(bar)
      .getAllByRole("menuitem")
      .map((e) => e.textContent?.replace(/Quiet for.*$/, "").trim());
    expect(menu).toEqual([
      "Snooze 7d",
      "Bring into focus",
      "Open in side pane",
      "Open in Tasks ↗",
    ]);
    fireEvent.keyDown(within(bar).getAllByRole("menuitem")[0], { key: "Escape" });
    expect(card.querySelectorAll(".wm-tile-acts")).toHaveLength(0);
    expect(card.querySelectorAll(".wm-preview-actions")).toHaveLength(0);
    const every = Array.from(card.querySelectorAll("button"), (b) => b.textContent?.trim());
    for (const act of ["Agent decides", "Done", "Ready for review", "Pause here"])
      expect(every.filter((t) => t === act)).toHaveLength(1);
    // The ask once: in its block, not again on the cover or in a status section.
    expect(within(card).getAllByText("pick gate A or B.")).toHaveLength(1);
    expect(within(detail).getByRole("region", { name: "The ask" }).textContent).toContain("Needs you");
    expect(within(detail).queryByRole("heading", { name: "Current status" })).toBeNull();
    // The description, rendered and sanitised.
    const text = await within(detail).findByRole("region", { name: "Description" });
    expect(text.querySelectorAll("ol li")).toHaveLength(2);
    expect(text.querySelector("script")).toBeNull();
    expect(text.textContent).toContain("<script>alert(1)</script>");
    // The timeline: newest first, author and session, history folded.
    const rows = () =>
      Array.from(detail.querySelectorAll<HTMLElement>(".wm-comment"));
    expect(rows().map((r) => r.querySelector("strong")?.textContent)).toEqual([
      "Gate worker",
      "You",
    ]);
    expect(rows()[0].querySelector("a")?.getAttribute("href")).toBe("/threads/thr_worker");
    fireEvent.click(within(detail).getByRole("button", { name: "History (1)" }));
    expect(rows()).toHaveLength(3);
    // The facts and the people on the side.
    const facts = Array.from(detail.querySelectorAll(".wm-facts > div"), (d) =>
      Array.from(d.children, (c) => c.textContent?.trim()).join(" "),
    );
    expect(facts[0]).toBe("Status In review");
    expect(facts).toContain("Project Test project");
    expect(facts).toContain("Labels gate");
    expect(within(detail).getByRole("region", { name: "Connected sessions" })).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("posts a comment in place, shows it at once, keeps the draft on failure, and hands a draft to Agent decides", async () => {
    const commentRequests: { taskId: string; body: string }[] = [];
    const delegateRequests: { requestId: string; taskId: string; note?: string }[] = [];
    const options = {
      tasks: [task({ status: "in_review" })],
      details: details(),
      commentRequests,
      commentError: "",
      delegateRequests,
    };
    const slot = await mount(options);
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    const detail = slot.getByRole("region", {
      name: "Expanded: Review proposal",
    });
    const box = within(detail).getByRole("textbox", { name: "Comment on TEST-1" });
    const post = within(detail).getByRole("button", { name: "Post comment" });
    expect(post).toHaveProperty("disabled", true);
    fireEvent.change(box, { target: { value: "Go with gate B." } });
    options.commentError = "Tasks is away";
    fireEvent.click(post);
    const alert = await within(detail).findByRole("alert");
    expect(alert.textContent).toBe("Tasks is away");
    expect(commentRequests).toEqual([{ taskId: "task1", body: "Go with gate B." }]);
    expect(box).toHaveProperty("value", "Go with gate B.");
    // Escape with a draft leaves the box and keeps the task open; the draft stays.
    box.focus();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(slot.getByRole("region", { name: "Expanded: Review proposal" })).toBeTruthy();
    expect(box).toHaveProperty("value", "Go with gate B.");
    options.commentError = "";
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(
        Array.from(detail.querySelectorAll(".wm-comment")).some((r) =>
          r.textContent?.includes("Go with gate B."),
        ),
      ).toBe(true),
    );
    expect(detail.querySelectorAll(".wm-comment")[0].textContent).toContain("Go with gate B.");
    expect(within(detail).queryByRole("alert")).toBeNull();
    expect(box).toHaveProperty("value", "");
    // A new draft rides with Agent decides as its note, and is cleared.
    fireEvent.change(box, { target: { value: "Prefer the cheaper gate." } });
    expect(detail.textContent).toContain("Agent decides sends it with the brief");
    fireEvent.click(within(detail).getByRole("button", { name: "Agent decides" }));
    await waitFor(() => expect(delegateRequests).toHaveLength(1));
    expect(delegateRequests[0].note).toBe("Prefer the cheaper gate.");
    await waitFor(() =>
      expect(slot.queryByRole("textbox", { name: "Comment on TEST-1" })).toHaveProperty("value", ""),
    );
    slot.lifecycle.unmount();
  });
  it("folds the body to the ask and the sessions while chatting, and lays one column out on a phone and in the pane", async () => {
    const slot = await mount({
      tasks: [task({ threadIds: ["thr_test"], status: "in_review", ask: "Choose.", askFrom: "next" })],
      details: details(),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /^Preview Review proposal/ }),
    );
    const detail = slot.getByRole("region", { name: "Expanded: Review proposal" });
    expect(detail.querySelector(".wm-task-body")).toBeTruthy();
    fireEvent.click(within(detail).getByRole("button", { name: "Chat here" }));
    expect(detail.querySelector(".wm-task-body-chat")).toBeTruthy();
    expect(within(detail).queryByRole("region", { name: "Description" })).toBeNull();
    expect(within(detail).getByRole("region", { name: "The ask" })).toBeTruthy();
    expect(within(detail).getByRole("region", { name: "Connected sessions" })).toBeTruthy();
    fireEvent.click(within(detail).getByRole("button", { name: "Back to summary" }));
    expect(within(detail).getByRole("region", { name: "Description" })).toBeTruthy();
    const css = readFileSync(join(__dirname, "app.css"), "utf8");
    expect(css).toMatch(/\.wm-task-body \{\n  display: grid;\n  grid-template-columns: minmax\(0, 1fr\) minmax\(180px, 220px\);/);
    expect(css).toMatch(/@container \(max-width: 470px\) \{\n  \.wm-task-body \{\n    grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toMatch(/@media \(width <= 720px\) \{\n  \.wm-task-body \{\n    grid-template-columns: minmax\(0, 1fr\);/);
    expect(css).toContain(".wm-task-detail {\n  container-type: inline-size;");
    slot.lifecycle.unmount();
  });
});
