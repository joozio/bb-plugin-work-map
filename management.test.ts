import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { managementService } from "./management";
import { runManagementCli } from "./management-cli";
import {
  projectFields,
  type ManagementInput,
  type ManagedProject,
} from "./management-contract";
import { data } from "./fixtures";

const requestId = "bdc50aee-584d-42db-9406-9199ad461c1a";
async function setup() {
  const projects: ManagedProject[] = [
    {
      id: "p1",
      name: "Work",
      prefix: "WORK",
      color: "slategray",
      folderId: "folder",
      linkedBbProjectId: null,
    },
  ];
  const mutations = vi.fn();
  let status = "todo",
    archived = false,
    uncertain = false;
  let rejectInput = false;
  const fake = createFakePluginHost({
    pluginId: "work-map",
    sdk: {
      threads: {
        get: async () =>
          makeThreadResponse({ archivedAt: archived ? 42 : null }),
      },
      plugins: {
        callRpc: async ({ method, input, outputSchema }) => {
          let value: unknown;
          const fields = input as Record<string, unknown>;
          if (method === "listProjects") value = { projects };
          else if (method === "listFolders")
            value = { folders: [{ id: "folder", name: "Work" }] };
          else if (method === "listBbProjects")
            value = { bbProjects: [{ id: "workspace", name: "Code" }] };
          else if (method === "getTask")
            value = { task: { projectId: "p1", status } };
          else {
            mutations(method, input);
            if (rejectInput)
              throw Object.assign(new Error("Input rejected before handler"), {
                code: "invalid_input",
              });
            if (uncertain) throw new Error("Connection lost after dispatch");
            if (method === "createProject") {
              const project = { ...fields, id: "p2" };
              projects.push(project as ManagedProject);
              value = { project };
            } else if (method === "updateProject") {
              Object.assign(projects[0], fields);
              value = { project: projects[0] };
            } else if (method === "createTask")
              value = {
                ok: true,
                task: { id: "tasknew", key: "WORK-1", projectId: "p1" },
              };
            else if (method === "taskThreadsAttach")
              value = { threadId: fields.threadId };
            else throw new Error(`Unexpected ${method}`);
          }
          return outputSchema.parse(value);
        },
      },
    },
  });
  await plugin(fake.bb);
  const invalidate = vi.fn();
  const service = managementService(fake.bb, invalidate);
  return {
    ...fake,
    service,
    invalidate,
    projects,
    mutations,
    status: (value: string) => {
      status = value;
    },
    archive: () => {
      archived = true;
    },
    loseResponse: () => {
      uncertain = true;
    },
    rejectInput: (value: boolean) => {
      rejectInput = value;
    },
  };
}
describe("project maintenance", () => {
  it("retries a proven pre-handler rejection with the same request id", async () => {
    const f = await setup();
    const input: ManagementInput = {
      action: "createProject",
      requestId,
      name: "Launch",
      prefix: "LAUNCH",
      color: "slategray",
      folderId: "folder",
      linkedBbProjectId: null,
    };
    f.rejectInput(true);
    await expect(f.service.manage(input)).rejects.toThrow("Input rejected");
    f.rejectInput(false);
    expect((await f.service.manage(input)).project?.prefix).toBe("LAUNCH");
    expect(f.mutations).toHaveBeenCalledTimes(2);
    await f.harness.lifecycle.dispose();
  });
  it("deduplicates repeated creation across warm and cold service instances", async () => {
    const f = await setup();
    const input: ManagementInput = {
      action: "createProject",
      requestId,
      name: "Launch",
      prefix: "LAUNCH",
      color: "slategray",
      folderId: "folder",
      linkedBbProjectId: "workspace",
    };
    const first = await f.service.manage(input);
    expect(await f.service.manage(input)).toEqual(first);
    expect(await managementService(f.bb, f.invalidate).manage(input)).toEqual(
      first,
    );
    expect(f.mutations).toHaveBeenCalledTimes(1);
    await expect(
      f.service.manage({ ...input, name: "Different" }),
    ).rejects.toThrow("different work");
    await f.harness.lifecycle.dispose();
  });
  it("never repeats an unknown create outcome after a lost response", async () => {
    const f = await setup();
    f.loseResponse();
    const input: ManagementInput = {
      action: "createTask",
      requestId,
      projectId: "p1",
      title: "Draft",
      description: "User details",
    };
    await expect(f.service.manage(input)).rejects.toThrow("Connection lost");
    await expect(
      managementService(f.bb, f.invalidate).manage(input),
    ).rejects.toThrow("uncertain");
    expect(f.mutations).toHaveBeenCalledTimes(1);
    await f.harness.lifecycle.dispose();
  });
  it("rejects stale metadata and invalid folders before writing", async () => {
    const f = await setup();
    const expected = projectFields.parse(f.projects[0]);
    f.projects[0].name = "Changed elsewhere";
    await expect(
      f.service.manage({
        action: "editProject",
        projectId: "p1",
        ...expected,
        name: "New",
        expected,
      }),
    ).rejects.toThrow("changed since");
    await expect(
      f.service.manage({
        action: "createProject",
        requestId,
        name: "New",
        prefix: "NEW",
        color: "slategray",
        folderId: "missing",
        linkedBbProjectId: null,
      }),
    ).rejects.toThrow("existing folder");
    expect(f.mutations).not.toHaveBeenCalled();
    await f.harness.lifecycle.dispose();
  });
  it("adds backlog tasks with the supplied description and no lifecycle inventions", async () => {
    const f = await setup();
    await f.service.manage({
      action: "createTask",
      requestId,
      projectId: "p1",
      title: "Draft",
      description: "Keep these details",
    });
    expect(f.mutations).toHaveBeenCalledWith("createTask", {
      projectId: "p1",
      title: "Draft",
      description: "Keep these details",
      status: "backlog",
    });
    expect(f.invalidate).toHaveBeenCalledOnce();
    await f.harness.lifecycle.dispose();
  });
  it("connects only to an open task in the selected project and an unarchived session", async () => {
    const f = await setup();
    const input: ManagementInput = {
      action: "attachSession",
      projectId: "p1",
      taskId: "task1",
      threadId: "thr_test",
    };
    f.status("done");
    await expect(f.service.manage(input)).rejects.toThrow("open task");
    f.status("todo");
    f.archive();
    await expect(f.service.manage(input)).rejects.toThrow(
      "Restore the session",
    );
    expect(f.mutations).not.toHaveBeenCalled();
    await f.harness.lifecycle.dispose();
  });
  it("hiding merges the map preference without any canonical task or session mutation", async () => {
    const f = await setup();
    await f.harness.behavior.callRpc("setPreference", {
      id: "project:p1",
      focus: true,
    });
    await f.harness.behavior.callRpc("setPreference", {
      id: "project:p1",
      hidden: true,
    });
    expect(await f.harness.behavior.callRpc("preferences", null)).toEqual({
      "project:p1": { focus: true, hidden: true },
    });
    await expect(
      f.harness.behavior.callRpc("setPreference", {
        id: "task:task1",
        hidden: true,
      }),
    ).rejects.toThrow("Only project");
    expect(f.mutations).not.toHaveBeenCalled();
    await f.harness.lifecycle.dispose();
  });
  it("parses agent commands and refuses unknown or ambiguous arguments", async () => {
    const f = await setup();
    const service = {
      ...f.service,
      snapshot: async () => data(),
      preferences: async () => ({}),
      setPreference: vi.fn(async (input: { hidden: boolean }) => ({
        hidden: input.hidden,
      })),
    };
    const created = await runManagementCli(
      [
        "task",
        "create",
        "--project",
        "WORK",
        "--title",
        "Draft",
        "--request-id",
        requestId,
        "--json",
      ],
      service,
    );
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout!).task.key).toBe("WORK-1");
    expect(
      (await runManagementCli(["project", "hide", "WORK"], service)).exitCode,
    ).toBe(0);
    expect(service.setPreference).toHaveBeenCalledWith({
      id: "project:p1",
      hidden: true,
    });
    for (const args of [
      ["project", "bogus"],
      ["project", "list", "extra"],
      ["task", "create", "--title"],
      ["project", "edit", "WORK", "--typo", "x"],
    ])
      expect((await runManagementCli(args, service)).exitCode).toBe(1);
    await f.harness.lifecycle.dispose();
  });
});
