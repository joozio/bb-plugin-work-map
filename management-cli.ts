import type {
  ManagementInput,
  ManagementOptions,
  ManagementResult,
} from "./management-contract";
import type { Preference, Snapshot } from "./server";

export const managementUsage = `bb work-map project list [--json]
bb work-map project create --name NAME --prefix KEY [--color COLOR] [--folder ID|NAME] [--workspace ID|NAME] [--request-id UUID] [--json]
bb work-map project edit KEY [--name NAME] [--color COLOR] [--folder ID|NAME|none] [--workspace ID|NAME|none] [--json]
bb work-map project hide|restore KEY [--json]
bb work-map task create --project KEY --title TITLE [--description TEXT] [--request-id UUID] [--json]
bb work-map attach TASK-KEY --thread THREAD-ID [--json]
Hide affects Overview only. Tasks and agents keep running; attention filters and search still include them.`;
type Services = {
  managementOptions: () => Promise<ManagementOptions>;
  manage: (input: ManagementInput) => Promise<ManagementResult>;
  snapshot: (input?: { fresh: boolean }) => Promise<Snapshot>;
  preferences: () => Promise<Record<string, Preference>>;
  setPreference: (input: {
    id: string;
    hidden: boolean;
  }) => Promise<Preference>;
};
export async function runManagementCli(argv: string[], service: Services) {
  if (argv.includes("--help")) return { exitCode: 0, stdout: managementUsage };
  let requestId: string | undefined;
  try {
    const flags = new Map<string, string>();
    const args: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (!arg.startsWith("--")) {
        args.push(arg);
        continue;
      }
      if (flags.has(arg)) throw new Error(`Duplicate option ${arg}`);
      if (arg === "--json") flags.set(arg, "true");
      else {
        const value = argv[++i];
        if (!value || value.startsWith("--"))
          throw new Error(`Missing value for ${arg}`);
        flags.set(arg, value);
      }
    }
    const verb = args[0] === "attach" ? "attach" : `${args[0]} ${args[1]}`;
    const allowed: Record<string, string[]> = {
      "project list": [],
      "project hide": [],
      "project restore": [],
      "project create": [
        "--name",
        "--prefix",
        "--color",
        "--folder",
        "--workspace",
        "--request-id",
      ],
      "project edit": ["--name", "--color", "--folder", "--workspace"],
      "task create": ["--project", "--title", "--description", "--request-id"],
      attach: ["--thread"],
    };
    if (!allowed[verb]) throw new Error("Unknown Work Map command.");
    for (const key of flags.keys())
      if (key !== "--json" && !allowed[verb].includes(key))
        throw new Error(`Unknown option ${key}`);
    const requiresTarget = [
      "project edit",
      "project hide",
      "project restore",
      "attach",
    ].includes(verb);
    if (args.length !== (verb === "attach" ? 2 : requiresTarget ? 3 : 2))
      throw new Error("Wrong number of arguments.");
    const options = await service.managementOptions();
    const required = (key: string) => {
      const value = flags.get(key);
      if (!value?.trim()) throw new Error(`${key} is required`);
      return value;
    };
    const resolve = <T extends { id: string; name: string }>(
      rows: T[],
      value: string | undefined,
    ): string | null => {
      if (!value || value === "none") return null;
      const found = rows.filter(
        (row) => row.id === value || row.name === value,
      );
      if (found.length !== 1)
        throw new Error(
          `Choose an unambiguous existing id or name for ${value}.`,
        );
      return found[0].id;
    };
    const findProject = (value: string) => {
      const p = options.projects.find(
        (p) => p.id === value || p.prefix === value.toUpperCase(),
      );
      if (!p) throw new Error(`Project ${value} was not found.`);
      return p;
    };
    let result: unknown;
    if (verb === "project list") {
      const preferences = await service.preferences();
      result = {
        projects: options.projects.map((p) => ({
          ...p,
          hiddenFromOverview: preferences[`project:${p.id}`]?.hidden === true,
        })),
        folders: options.folders,
      };
    } else if (verb === "project hide" || verb === "project restore") {
      const project = findProject(args[2]);
      result = {
        project,
        preference: await service.setPreference({
          id: `project:${project.id}`,
          hidden: verb === "project hide",
        }),
      };
    } else if (verb === "project create") {
      requestId = flags.get("--request-id") ?? crypto.randomUUID();
      result = await service.manage({
        action: "createProject",
        requestId,
        name: required("--name"),
        prefix: required("--prefix").toUpperCase(),
        color: flags.get("--color") ?? "slategray",
        folderId: resolve(options.folders, flags.get("--folder")),
        linkedBbProjectId: resolve(
          options.bbProjects,
          flags.get("--workspace"),
        ),
      });
    } else if (verb === "project edit") {
      const project = findProject(args[2]);
      if (![...flags.keys()].some((key) => key !== "--json"))
        throw new Error("Choose at least one project field to edit.");
      const { id, prefix, ...expected } = project;
      result = await service.manage({
        action: "editProject",
        projectId: id,
        expected,
        name: flags.get("--name") ?? project.name,
        color: flags.get("--color") ?? project.color,
        folderId: flags.has("--folder")
          ? resolve(options.folders, flags.get("--folder"))
          : project.folderId,
        linkedBbProjectId: flags.has("--workspace")
          ? resolve(options.bbProjects, flags.get("--workspace"))
          : project.linkedBbProjectId,
      });
    } else if (verb === "task create") {
      requestId = flags.get("--request-id") ?? crypto.randomUUID();
      result = await service.manage({
        action: "createTask",
        requestId,
        projectId: findProject(required("--project")).id,
        title: required("--title"),
        description: flags.get("--description") ?? "",
      });
    } else {
      const task = (await service.snapshot({ fresh: true })).tasks.find(
        (task) => task.key === args[1].toUpperCase() || task.id === args[1],
      );
      if (!task) throw new Error("Task was not found.");
      result = await service.manage({
        action: "attachSession",
        projectId: task.projectId,
        taskId: task.id,
        threadId: required("--thread"),
      });
    }
    const value = result as ManagementResult & {
      projects?: (ManagementOptions["projects"][number] & {
        hiddenFromOverview: boolean;
      })[];
      preference?: Preference;
    };
    const summary = value.projects
      ? value.projects
          .map(
            (p) =>
              `${p.prefix} · ${p.name}${p.hiddenFromOverview ? " · hidden from Overview" : ""}`,
          )
          .join("\n") || "No projects."
      : value.task
        ? `Created ${value.task.key} in backlog.`
        : value.project
          ? `${value.project.prefix} · ${value.project.name}${value.preference ? (value.preference.hidden ? " · hidden from Overview" : " · restored to Overview") : " · saved"}`
          : `Connected session ${value.threadId}.`;
    return {
      exitCode: 0,
      stdout: flags.has("--json")
        ? JSON.stringify(
            { ...(result as object), ...(requestId ? { requestId } : {}) },
            null,
            2,
          )
        : `${summary}${requestId ? `\nRequest id: ${requestId}` : ""}`,
    };
  } catch (error) {
    return {
      exitCode: 1,
      stderr: `${error instanceof Error ? error.message : String(error)}${requestId ? `\nRequest id: ${requestId}. Reuse it to recover a confirmed result. If the outcome is uncertain, inspect existing work before a new attempt.` : ""}\n${managementUsage}`,
    };
  }
}
