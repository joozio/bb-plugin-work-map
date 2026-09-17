import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { MapTask, Snapshot } from "./server";
export const now = new Date("2026-09-17T12:00:00").getTime();
export function thread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id: "thr_test",
    projectId: "proj_test",
    title: "Session",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: now,
    updatedAt: now,
    lastReadAt: now,
    latestAttentionAt: now,
    ...overrides,
  };
}
export function task(overrides: Partial<MapTask> = {}): MapTask {
  return {
    id: "task1",
    projectId: "p1",
    key: "TEST-1",
    title: "Review proposal",
    status: "todo",
    priority: "medium",
    dueDate: null,
    updatedAt: new Date(now).toISOString(),
    summary: "Proposal drafted",
    nextAction: "Choose a direction",
    dateKind: "plan",
    waitingOn: "none",
    threadIds: [],
    ...overrides,
  };
}
export function data(tasks = [task()]): Snapshot {
  return {
    tasks,
    projects: [{ id: "p1", prefix: "TEST", name: "Test project" }],
    generatedAt: now,
    warnings: [],
  };
}
