import { describe, expect, it, vi } from "vitest";
import { managementUsage, runManagementCli } from "./management-cli";
import type {
  ManagementInput,
  ManagementOptions,
  ManagementResult,
} from "./management-contract";
import type { Preference } from "./server";
import { data, task } from "./fixtures";

const requestId = "bdc50aee-584d-42db-9406-9199ad461c1a";
const options: ManagementOptions = {
  projects: [
    {
      id: "p1",
      name: "Work",
      prefix: "WORK",
      color: "slategray",
      folderId: "f1",
      linkedBbProjectId: null,
    },
    {
      id: "p2",
      name: "Home",
      prefix: "HOME",
      color: "teal",
      folderId: null,
      linkedBbProjectId: "ws1",
    },
  ],
  folders: [
    { id: "f1", name: "Clients" },
    { id: "f2", name: "Shared" },
    { id: "f3", name: "Shared" },
  ],
  bbProjects: [{ id: "ws1", name: "Code" }],
};

/**
 * Plain stand-ins for the services the CLI drives. `manage` echoes what each
 * action would return, so a case can check both the input the CLI built and
 * the line it printed for the result.
 */
function services(preferences: Record<string, Preference> = {}) {
  const manage = vi.fn(
    async (input: ManagementInput): Promise<ManagementResult> => {
      if (input.action === "createTask")
        return { task: { id: "t9", key: "WORK-9", projectId: input.projectId } };
      if (input.action === "attachSession") return { threadId: input.threadId };
      if (input.action === "createProject")
        return {
          project: {
            id: "p3",
            name: input.name,
            prefix: input.prefix,
            color: input.color,
            folderId: input.folderId,
            linkedBbProjectId: input.linkedBbProjectId,
          },
        };
      const { id, prefix } = options.projects.find(
        (p) => p.id === input.projectId,
      )!;
      return {
        project: {
          id,
          prefix,
          name: input.name,
          color: input.color,
          folderId: input.folderId,
          linkedBbProjectId: input.linkedBbProjectId,
        },
      };
    },
  );
  return {
    manage,
    managementOptions: vi.fn(async () => options),
    snapshot: vi.fn(async () =>
      data([task({ id: "task1", key: "WORK-1", projectId: "p1" })]),
    ),
    preferences: vi.fn(async () => preferences),
    setPreference: vi.fn(async (input: { id: string; hidden: boolean }) => ({
      hidden: input.hidden,
    })),
  };
}
const run = (argv: string[], service = services()) =>
  runManagementCli(argv, service);
const sent = (service: ReturnType<typeof services>) =>
  service.manage.mock.calls[0][0];

describe("reading the project list", () => {
  it("prints one line per project and marks those hidden from Overview", async () => {
    const result = await run(
      ["project", "list"],
      services({ "project:p2": { hidden: true } }),
    );
    expect(result).toEqual({
      exitCode: 0,
      stdout: "WORK · Work\nHOME · Home · hidden from Overview",
    });
  });

  it("prints a name with line breaks or terminal escapes as one plain line, JSON unchanged", async () => {
    const service = services({ "project:p2": { hidden: true } });
    const name = "Ops\nPAY · Payroll · hidden from Overview\u001b[2K\r\u202eWORK";
    service.managementOptions.mockResolvedValue({
      ...options,
      projects: [{ ...options.projects[1], name }],
    });
    const result = await run(["project", "list"], service);
    expect(result.stdout).toBe(
      "HOME · Ops PAY · Payroll · hidden from Overview [2K WORK · hidden from Overview",
    );
    expect(result.stdout!.split("\n")).toHaveLength(1);
    const json = await run(["project", "list", "--json"], service);
    expect(JSON.parse(json.stdout!).projects[0].name).toBe(name);
  });

  it("says so when there are none", async () => {
    const service = services();
    service.managementOptions.mockResolvedValue({ ...options, projects: [] });
    expect((await run(["project", "list"], service)).stdout).toBe(
      "No projects.",
    );
  });

  it("returns projects with their Overview flag and folders as JSON", async () => {
    const result = await run(["project", "list", "--json"]);
    const parsed = JSON.parse(result.stdout!);
    expect(parsed.projects.map((p: { hiddenFromOverview: boolean }) => p.hiddenFromOverview)).toEqual([false, false]);
    expect(parsed.folders).toEqual(options.folders);
    expect(parsed).not.toHaveProperty("requestId");
  });

  it("answers --help with the usage and touches nothing", async () => {
    const service = services();
    expect(await run(["project", "create", "--help"], service)).toEqual({
      exitCode: 0,
      stdout: managementUsage,
    });
    expect(service.managementOptions).not.toHaveBeenCalled();
  });
});

describe("creating a project", () => {
  it("uppercases the prefix, resolves folder and workspace by name and keeps the request id", async () => {
    const service = services();
    const result = await run(
      [
        "project",
        "create",
        "--name",
        "Launch",
        "--prefix",
        "launch",
        "--folder",
        "Clients",
        "--workspace",
        "Code",
        "--request-id",
        requestId,
      ],
      service,
    );
    expect(sent(service)).toEqual({
      action: "createProject",
      requestId,
      name: "Launch",
      prefix: "LAUNCH",
      color: "slategray",
      folderId: "f1",
      linkedBbProjectId: "ws1",
    });
    expect(result).toEqual({
      exitCode: 0,
      stdout: `LAUNCH · Launch · saved\nRequest id: ${requestId}`,
    });
  });

  it("mints a request id when none is given and reports it in JSON", async () => {
    const service = services();
    const result = await run(
      ["project", "create", "--name", "Launch", "--prefix", "L", "--json"],
      service,
    );
    const minted = (sent(service) as { requestId: string }).requestId;
    expect(minted).toMatch(/^[0-9a-f-]{36}$/);
    const parsed = JSON.parse(result.stdout!);
    expect(parsed.requestId).toBe(minted);
    expect(parsed.project.folderId).toBeNull();
  });

  it("refuses a folder name that matches more than one folder, or none", async () => {
    for (const folder of ["Shared", "Nowhere"]) {
      const service = services();
      const result = await run(
        ["project", "create", "--name", "X", "--prefix", "X", "--folder", folder],
        service,
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `Choose an unambiguous existing id or name for ${folder}.`,
      );
      expect(service.manage).not.toHaveBeenCalled();
    }
  });

  it("needs a name and a prefix, and a blank one is not a value", async () => {
    const missing = await run(["project", "create", "--name", "X"]);
    expect(missing.stderr).toMatch(/^--prefix is required/);
    const blank = await run(["project", "create", "--name", " ", "--prefix", "X"]);
    expect(blank.stderr).toMatch(/^--name is required/);
  });

  it("offers the request id back when the write fails, so a retry can recover it", async () => {
    const service = services();
    service.manage.mockRejectedValue(new Error("Connection lost"));
    const result = await run(
      ["project", "create", "--name", "X", "--prefix", "X", "--request-id", requestId],
      service,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Connection lost");
    expect(result.stderr).toContain(`Request id: ${requestId}. Reuse it`);
    expect(result.stderr).toContain(managementUsage);
  });
});

describe("editing a project", () => {
  it("sends only the changed field and the project as it was read", async () => {
    const service = services();
    const result = await run(["project", "edit", "work", "--name", "Office"], service);
    expect(sent(service)).toEqual({
      action: "editProject",
      projectId: "p1",
      expected: {
        name: "Work",
        color: "slategray",
        folderId: "f1",
        linkedBbProjectId: null,
      },
      name: "Office",
      color: "slategray",
      folderId: "f1",
      linkedBbProjectId: null,
    });
    expect(result.stdout).toBe("WORK · Office · saved");
  });

  it("clears a folder or workspace with none, and finds a project by id", async () => {
    const service = services();
    await run(
      ["project", "edit", "p2", "--workspace", "none", "--folder", "f2"],
      service,
    );
    expect(sent(service)).toMatchObject({
      projectId: "p2",
      folderId: "f2",
      linkedBbProjectId: null,
      color: "teal",
    });
  });

  it("needs at least one field, and an existing project", async () => {
    expect((await run(["project", "edit", "WORK", "--json"])).stderr).toMatch(
      /^Choose at least one project field to edit\./,
    );
    expect(
      (await run(["project", "edit", "NOPE", "--name", "X"])).stderr,
    ).toMatch(/^Project NOPE was not found\./);
  });
});

describe("hiding and restoring a project on Overview", () => {
  it("says which way it went", async () => {
    const service = services();
    expect((await run(["project", "hide", "HOME"], service)).stdout).toBe(
      "HOME · Home · hidden from Overview",
    );
    expect((await run(["project", "restore", "HOME"], service)).stdout).toBe(
      "HOME · Home · restored to Overview",
    );
    expect(service.setPreference.mock.calls).toEqual([
      [{ id: "project:p2", hidden: true }],
      [{ id: "project:p2", hidden: false }],
    ]);
    expect(service.manage).not.toHaveBeenCalled();
  });
});

describe("adding a task and attaching a session", () => {
  it("creates a backlog task with an empty description by default", async () => {
    const service = services();
    const result = await run(
      ["task", "create", "--project", "work", "--title", "Draft", "--request-id", requestId],
      service,
    );
    expect(sent(service)).toEqual({
      action: "createTask",
      requestId,
      projectId: "p1",
      title: "Draft",
      description: "",
    });
    expect(result.stdout).toBe(
      `Created WORK-9 in backlog.\nRequest id: ${requestId}`,
    );
  });

  it("attaches a session to a task found by key in any case, or by id, from a fresh snapshot", async () => {
    for (const target of ["work-1", "task1"]) {
      const service = services();
      const result = await run(["attach", target, "--thread", "thr_abc"], service);
      expect(service.snapshot).toHaveBeenCalledWith({ fresh: true });
      expect(sent(service)).toEqual({
        action: "attachSession",
        projectId: "p1",
        taskId: "task1",
        threadId: "thr_abc",
      });
      expect(result.stdout).toBe("Connected session thr_abc.");
    }
  });

  it("refuses an unknown task or a missing thread", async () => {
    expect(
      (await run(["attach", "WORK-404", "--thread", "thr_abc"])).stderr,
    ).toMatch(/^Task was not found\./);
    expect((await run(["attach", "WORK-1"])).stderr).toMatch(
      /^--thread is required/,
    );
  });
});

describe("arguments the CLI refuses before calling anything", () => {
  it.each([
    [[], "Unknown Work Map command."],
    [["task", "list"], "Unknown Work Map command."],
    [["project", "list", "--json", "--json"], "Duplicate option --json"],
    [["project", "create", "--name", "--prefix", "X"], "Missing value for --name"],
    [["project", "create", "--name"], "Missing value for --name"],
    [["project", "list", "--name", "X"], "Unknown option --name"],
    [["task", "create", "--color", "red"], "Unknown option --color"],
    [["project", "hide"], "Wrong number of arguments."],
    [["project", "hide", "WORK", "HOME"], "Wrong number of arguments."],
    [["attach"], "Wrong number of arguments."],
    [["attach", "WORK-1", "extra", "--thread", "thr_a"], "Wrong number of arguments."],
  ])("%j → %s", async (argv, message) => {
    const service = services();
    const result = await run(argv, service);
    expect(result.exitCode).toBe(1);
    expect(result.stderr!.startsWith(`${message}\n`)).toBe(true);
    // Nothing was sent, so there is no request id to reuse.
    expect(result.stderr).not.toContain("Request id");
    expect(service.managementOptions).not.toHaveBeenCalled();
  });
});
