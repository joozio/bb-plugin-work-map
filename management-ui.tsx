import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRpc, UrlLink } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { rpcContract, Snapshot, Preference } from "./server";
import type { WorkItem } from "./model";
import {
  projectFields,
  type ManagedProject,
  type ManagementInput,
  type ManagementOptions,
  type ManagementResult,
} from "./management-contract";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import "./management.css";

type Mode =
  | "list"
  | "createProject"
  | "editProject"
  | "createTask"
  | "attachSession";
type View = { mode: Mode; projectId?: string };
const palette = [
  "#8796ab",
  "#8d96b8",
  "#9b8ab1",
  "#b18491",
  "#b49a7d",
  "#849c8e",
  "#7b9fa9",
];
export function ProjectDot({ color }: { color?: string }) {
  return (
    <i
      className="wm-project-dot"
      style={{ backgroundColor: color ?? palette[0] }}
      aria-hidden="true"
    />
  );
}

export function AreaTools({
  title,
  disabled,
  focused,
  hidden,
  onAction,
}: {
  title: string;
  disabled: boolean;
  focused: boolean;
  hidden: boolean;
  onAction: (
    action:
      | "createTask"
      | "session"
      | "attachSession"
      | "editProject"
      | "focus"
      | "hide",
  ) => void;
}) {
  const [menu, setMenu] = useState<"add" | "more" | null>(null);
  const [placement, setPlacement] = useState({ start: false, above: false });
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (!menu || !root.current) return;
    const rect = root.current.getBoundingClientRect();
    const boundary = root.current
      .closest(".wm-canvas,.wm-preview")
      ?.getBoundingClientRect();
    setPlacement({
      start: rect.right - 225 < (boundary?.left ?? 0) + 8,
      above:
        rect.bottom + 150 > (boundary?.bottom ?? window.innerHeight) &&
        rect.top - 150 > (boundary?.top ?? 0),
    });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", dismiss);
    root.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menu]);
  const choose = (action: Parameters<typeof onAction>[0]) => {
    setMenu(null);
    trigger.current?.focus();
    onAction(action);
  };
  return (
    <div
      className="wm-area-tools"
      ref={root}
      onKeyDown={(event) => {
        if (!menu) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setMenu(null);
          trigger.current?.focus();
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const buttons = Array.from(
            root.current?.querySelectorAll<HTMLButtonElement>(
              '[role="menuitem"]',
            ) ?? [],
          );
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          buttons[
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    buttons.length) %
                  buttons.length
          ]?.focus();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setMenu(null);
      }}
    >
      {(["add", "more"] as const).map((kind) => (
        <button
          key={kind}
          className="wm-area-tool"
          disabled={disabled}
          aria-label={`${kind === "add" ? "Add to" : "Manage"} ${title}`}
          aria-haspopup="menu"
          aria-expanded={menu === kind}
          onClick={(event) => {
            trigger.current = event.currentTarget;
            setMenu(menu === kind ? null : kind);
          }}
        >
          {kind === "add" ? "+" : "⋯"}
        </button>
      ))}
      {menu && (
        <div
          role="menu"
          aria-label={`${menu === "add" ? "Add to" : "Manage"} ${title}`}
          className={`wm-area-menu ${placement.start ? "wm-menu-start" : ""} ${placement.above ? "wm-menu-above" : ""}`}
        >
          {menu === "add" ? (
            <>
              <button role="menuitem" onClick={() => choose("createTask")}>
                New task
              </button>
              <button role="menuitem" onClick={() => choose("session")}>
                New session
              </button>
              <button role="menuitem" onClick={() => choose("attachSession")}>
                Connect existing session
              </button>
            </>
          ) : (
            <>
              <button role="menuitem" onClick={() => choose("editProject")}>
                Edit project
              </button>
              <button role="menuitem" onClick={() => choose("focus")}>
                {focused ? "Remove focus" : "Bring into focus"}
              </button>
              <button
                role="menuitem"
                className="wm-menu-separated"
                onClick={() => choose("hide")}
              >
                {hidden ? "Restore to Overview" : "Hide from Overview"}
                <small>Tasks stay open. Agents keep running.</small>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function useAreaManager(props: {
  snapshot: Snapshot | null;
  projectItems: WorkItem[];
  threads: readonly PluginSidebarThread[];
  preferences: Record<string, Preference>;
  workspaceId?: string | null;
  blocked: boolean;
  onResult: (result: ManagementResult) => Promise<void>;
  onVisibility: (id: string, hidden: boolean) => Promise<void>;
  onFocus: (id: string) => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<View | null>(null);
  const [options, setOptions] = useState<ManagementOptions | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const loadVersion = useRef(0);
  const initiator = useRef<HTMLElement | null>(null);
  const load = async () => {
    const version = ++loadVersion.current;
    setError("");
    try {
      const result = await rpc.call("managementOptions");
      if (version === loadVersion.current) setOptions(result);
      return result;
    } catch (cause) {
      if (version === loadVersion.current)
        setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  };
  const close = (restoreFocus = true) => {
    if (lock.current) return;
    loadVersion.current++;
    setView(null);
    if (restoreFocus)
      requestAnimationFrame(
        () => initiator.current?.isConnected && initiator.current.focus(),
      );
  };
  const open = (mode: Mode = "list", projectId?: string) => {
    if (lock.current || props.blocked) return;
    initiator.current = document.activeElement as HTMLElement;
    setView({ mode, projectId });
    setOptions(null);
    void load();
  };
  const perform = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const submit = (input: ManagementInput) =>
    perform(async () => {
      const result = await rpc.call("manage", input);
      await props.onResult(result);
      setView(null);
    });
  const inline = view?.mode === "createTask" || view?.mode === "attachSession";
  const project = options?.projects.find((p) => p.id === view?.projectId);
  const content = view && (
    <section
      className={inline ? "wm-management-inline" : "wm-preview wm-manager"}
      aria-label={
        inline
          ? `${view.mode === "createTask" ? "New task" : "Connect session"} in project`
          : "Manage areas"
      }
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="wm-preview-top">
        <strong>
          {view.mode === "list"
            ? "Manage areas"
            : view.mode === "createProject"
              ? "New project"
              : view.mode === "editProject"
                ? "Edit project"
                : view.mode === "createTask"
                  ? "New task"
                  : "Connect existing session"}
        </strong>
        <button
          aria-label="Close area controls"
          disabled={busy}
          onClick={() => close()}
        >
          <Icon name="X" />
        </button>
      </div>
      {error && (
        <div className="wm-error" role="alert">
          {error}
          <button disabled={busy} onClick={() => void load()}>
            Refresh details
          </button>
        </div>
      )}
      {!options ? (
        <p role="status">
          {error ? "Project details are unavailable." : "Loading projects…"}
        </p>
      ) : view.mode === "list" ? (
        <>
          <p className="wm-manager-hint">
            Areas are your Tasks projects. Hidden areas remain in search and
            attention filters.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || props.blocked}
            onClick={() => setView({ mode: "createProject" })}
          >
            <span aria-hidden="true">+</span> New project
          </Button>
          <AreaList
            options={options}
            snapshot={props.snapshot}
            preferences={props.preferences}
            projectItems={props.projectItems}
            disabled={busy || props.blocked}
            onEdit={(projectId) => setView({ mode: "editProject", projectId })}
            onOpen={(id) => {
              setView(null);
              props.onOpen(id);
            }}
            onVisibility={(id, hidden) =>
              void perform(() => props.onVisibility(id, hidden))
            }
            onFocus={(id) => void perform(() => props.onFocus(id))}
          />
        </>
      ) : view.mode === "createProject" || view.mode === "editProject" ? (
        <ProjectForm
          key={`${view.mode}:${project?.id ?? "new"}:${JSON.stringify(project)}`}
          project={project}
          editing={view.mode === "editProject"}
          options={options}
          workspaceId={props.workspaceId}
          disabled={busy || props.blocked}
          onSubmit={submit}
        />
      ) : project ? (
        <WorkForm
          key={`${view.mode}:${project.id}`}
          mode={view.mode}
          project={project}
          snapshot={props.snapshot}
          threads={props.threads}
          disabled={busy || props.blocked}
          onSubmit={submit}
        />
      ) : (
        <p>Project no longer exists. Refresh the map.</p>
      )}
    </section>
  );
  return {
    open,
    close,
    busy,
    active: !!view,
    inlineProjectId: inline ? view?.projectId : undefined,
    pane: inline ? null : content,
    inline: inline ? content : null,
  };
}

function AreaList({
  options,
  snapshot,
  preferences,
  projectItems,
  disabled,
  onEdit,
  onOpen,
  onVisibility,
  onFocus,
}: {
  options: ManagementOptions;
  snapshot: Snapshot | null;
  preferences: Record<string, Preference>;
  projectItems: WorkItem[];
  disabled: boolean;
  onEdit: (id: string) => void;
  onOpen: (id: string) => void;
  onVisibility: (id: string, hidden: boolean) => void;
  onFocus: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <>
      <input
        className="wm-management-input"
        aria-label="Find an area"
        placeholder="Find an area…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="wm-manager-list">
        {options.projects
          .filter((p) =>
            `${p.name} ${p.prefix}`.toLowerCase().includes(query.toLowerCase()),
          )
          .map((p) => {
            const tasks =
              snapshot?.tasks.filter((task) => task.projectId === p.id) ?? [];
            const open = tasks.filter(
              (task) => !["done", "canceled"].includes(task.status),
            ).length;
            const pref = preferences[`project:${p.id}`];
            const item = projectItems.find(
              (item) => item.id === `project:${p.id}`,
            );
            const inherited = !!item?.children.some((child) => child.focus);
            return (
              <article key={p.id} className="wm-managed-area">
                <div className="wm-managed-title">
                  <ProjectDot color={p.color} />
                  <button disabled={disabled} onClick={() => onOpen(p.id)}>
                    {p.name}
                  </button>
                  <span>{p.prefix}</span>
                </div>
                <small>
                  {options.folders.find((f) => f.id === p.folderId)?.name ??
                    "No folder"}{" "}
                  · {open ? `${open} open tasks` : "No open tasks"}
                  {tasks.length > open
                    ? ` · ${tasks.length - open} closed`
                    : ""}
                  {pref?.hidden ? " · Hidden" : ""}
                </small>
                <div className="wm-managed-actions">
                  <button disabled={disabled} onClick={() => onEdit(p.id)}>
                    Edit
                  </button>
                  <button
                    disabled={disabled || inherited}
                    aria-pressed={!!item?.focus}
                    title={
                      inherited
                        ? "Focused tasks keep this area in focus. Change their focus first."
                        : undefined
                    }
                    onClick={() => onFocus(p.id)}
                  >
                    {inherited ? "Focus from tasks" : "Focus area"}
                  </button>
                  <button
                    disabled={disabled}
                    aria-label={`${pref?.hidden ? "Restore" : "Hide"} ${p.name}`}
                    onClick={() => onVisibility(p.id, !pref?.hidden)}
                  >
                    {pref?.hidden ? "Restore" : "Hide"}
                  </button>
                  <UrlLink href="/plugins/tasks/tasks">Tasks ↗</UrlLink>
                </div>
              </article>
            );
          })}
      </div>
    </>
  );
}

function ProjectForm({
  project,
  editing,
  options,
  workspaceId,
  disabled,
  onSubmit,
}: {
  project?: ManagedProject;
  editing: boolean;
  options: ManagementOptions;
  workspaceId?: string | null;
  disabled: boolean;
  onSubmit: (input: ManagementInput) => Promise<void>;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [prefix, setPrefix] = useState(project?.prefix ?? "");
  const [color, setColor] = useState(project?.color ?? palette[0]);
  const [folderId, setFolderId] = useState(
    project?.folderId ??
      (editing
        ? ""
        : options.folders.length === 1
          ? options.folders[0].id
          : ""),
  );
  const [workspace, setWorkspace] = useState(
    project?.linkedBbProjectId ?? (editing ? "" : (workspaceId ?? "")),
  );
  const attempt = useRef<{ signature: string; id: string } | null>(null);
  if (editing && !project) return <p>Project no longer exists.</p>;
  return (
    <form
      className="wm-management-form"
      onSubmit={(event) => {
        event.preventDefault();
        const fields = {
          name,
          color,
          folderId: folderId || null,
          linkedBbProjectId: workspace || null,
        };
        const signature = JSON.stringify({ ...fields, prefix });
        if (attempt.current?.signature !== signature)
          attempt.current = { signature, id: crypto.randomUUID() };
        void onSubmit(
          project
            ? {
                action: "editProject",
                projectId: project.id,
                expected: projectFields.parse(project),
                ...fields,
              }
            : {
                action: "createProject",
                requestId: attempt.current.id,
                prefix,
                ...fields,
              },
        );
      }}
    >
      <fieldset disabled={disabled}>
        <label>
          Name
          <input
            autoFocus
            required
            maxLength={180}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Task prefix
          <input
            required
            readOnly={editing}
            pattern="[A-Z][A-Z0-9]{0,9}"
            maxLength={10}
            placeholder="E.g. LAUNCH"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.toUpperCase())}
          />
        </label>
        <div
          className="wm-color-choices"
          role="group"
          aria-label="Project color"
        >
          {[...new Set([...palette, color])].map((value, index) => (
            <button
              key={value}
              type="button"
              aria-label={`Project color ${index + 1}`}
              aria-pressed={color === value}
              style={{ backgroundColor: value }}
              onClick={() => setColor(value)}
            />
          ))}
        </div>
        <label>
          Folder
          <select
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
          >
            <option value="">No folder</option>
            {options.folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          BB workspace
          <select
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          >
            <option value="">No linked workspace</option>
            {options.bbProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <small>
          New sessions can use the linked workspace. Project color is shown as a
          small dot.
        </small>
        <Button type="submit" size="sm" disabled={!name.trim() || !prefix}>
          {disabled ? "Saving…" : editing ? "Save project" : "Create project"}
        </Button>
      </fieldset>
    </form>
  );
}

function WorkForm({
  mode,
  project,
  snapshot,
  threads,
  disabled,
  onSubmit,
}: {
  mode: "createTask" | "attachSession";
  project: ManagedProject;
  snapshot: Snapshot | null;
  threads: readonly PluginSidebarThread[];
  disabled: boolean;
  onSubmit: (input: ManagementInput) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [query, setQuery] = useState("");
  const tasks =
    snapshot?.tasks.filter(
      (t) =>
        t.projectId === project.id && !["done", "canceled"].includes(t.status),
    ) ?? [];
  const [taskId, setTaskId] = useState(tasks[0]?.id ?? "");
  const attempt = useRef<{ signature: string; id: string } | null>(null);
  const task = tasks.find((t) => t.id === taskId);
  const sessions = threads.filter(
    (t) =>
      !t.isArchived &&
      !task?.threadIds.includes(t.id) &&
      (t.title ?? t.titleFallback ?? "Session")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return mode === "createTask" ? (
    <form
      className="wm-management-form"
      onSubmit={(event) => {
        event.preventDefault();
        const signature = JSON.stringify({ title, description });
        if (attempt.current?.signature !== signature)
          attempt.current = { signature, id: crypto.randomUUID() };
        void onSubmit({
          action: "createTask",
          requestId: attempt.current.id,
          projectId: project.id,
          title,
          description,
        });
      }}
    >
      <fieldset disabled={disabled}>
        <small>
          {project.prefix} · {project.name} · Starts in backlog
        </small>
        <label>
          Task title
          <input
            autoFocus
            required
            maxLength={180}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Details <span>(optional)</span>
          <textarea
            rows={3}
            maxLength={30000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <Button type="submit" size="sm" disabled={!title.trim()}>
          {disabled ? "Adding…" : "Add task"}
        </Button>
      </fieldset>
    </form>
  ) : (
    <div className="wm-management-form">
      <label>
        Connect to task
        <select
          disabled={disabled}
          value={taskId}
          onChange={(e) => setTaskId(e.target.value)}
        >
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.key} · {t.title}
            </option>
          ))}
        </select>
      </label>
      {!tasks.length ? (
        <p>Add an open task to this project first.</p>
      ) : (
        <>
          <input
            autoFocus
            className="wm-management-input"
            aria-label="Find a session to connect"
            placeholder="Find a session…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <small>
            {task?.key} · Connecting preserves the session's history and current
            activity.
          </small>
          <div className="wm-connections">
            {sessions.slice(0, 30).map((t) => (
              <div key={t.id} className="wm-connect-row">
                <span>
                  {t.title}
                  <small>{t.providerId ?? "BB"}</small>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  aria-label={`Connect ${t.title}`}
                  onClick={() =>
                    void onSubmit({
                      action: "attachSession",
                      projectId: project.id,
                      taskId,
                      threadId: t.id,
                    })
                  }
                >
                  Connect
                </Button>
              </div>
            ))}
            {!sessions.length && <p>No unconnected sessions match.</p>}
            {sessions.length > 30 && (
              <small>Search to narrow {sessions.length} sessions.</small>
            )}
          </div>
        </>
      )}
    </div>
  );
}
