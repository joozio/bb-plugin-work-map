import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  useBbContext,
  UrlLink,
  ThreadChat,
  Markdown,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, Preference, Snapshot, MapTask } from "./server";
import {
  buildMap,
  arrangeMap,
  dueLabel,
  isWorking,
  needsReview,
  selectVisible,
  sessionItem,
  threadSignal,
  unreadLabel,
  type WorkItem,
} from "./model";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Icon } from "./components/ui/icon";
import { useMapMotion } from "./layout-motion";
import { useMapZoom, ZoomControls } from "./map-zoom";
import { extendOrbit, zoomDensity, zoomVisible } from "./zoom";
import { useSessionLauncher } from "./session-launcher";
import { SettlementActions, SettledToday } from "./settlement-actions";
import type { Settlement } from "./settlement-contract";
import { AreaTools, ProjectDot, useAreaManager } from "./management-ui";
import type { ManagementResult } from "./management-contract";
import { previewExcerpt, type SessionPreview } from "./preview";
import "./app.css";

type Filter = "all" | "focus" | "waiting" | "unread" | "working" | "inactive";
type Previews = Record<string, SessionPreview>;
const EMPTY: Snapshot = {
  projects: [],
  tasks: [],
  generatedAt: 0,
  warnings: [],
};
function age(timestamp: number, now: number) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  return minutes < 1
    ? "just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
function Status({ item }: { item: WorkItem }) {
  return (
    <span
      className={`wm-statuses ${item.kind === "project" ? "wm-project-summary" : ""}`}
    >
      <span
        className={`wm-status wm-${item.signal}`}
        data-attention={item.attention ?? undefined}
      >
        {item.signal === "unread" && item.kind !== "project" ? (
          <Icon
            name="MessageSquare"
            className="wm-result-icon"
            aria-hidden="true"
          />
        ) : (
          <i aria-hidden="true" />
        )}
        {item.reason}
      </span>
      {needsReview(item) && item.attention !== "review" && (
        <span className="wm-status wm-waiting" data-attention="review">
          <i aria-hidden="true" />
          Needs review
        </span>
      )}
      {item.kind !== "project" &&
        item.signal !== "unread" &&
        item.unreadResults > 0 && (
          <span className="wm-status wm-unread">
            <Icon
              name="MessageSquare"
              className="wm-result-icon"
              aria-hidden="true"
            />
            {unreadLabel(item.unreadResults)}
          </span>
        )}
    </span>
  );
}
function WorkMap() {
  const rpc = useRpc<typeof rpcContract>();
  const sidebar = experimental_useSidebarThreads();
  const actions = experimental_useSidebarThreadActions();
  const bbContext = useBbContext();
  const threadsRef = useRef(sidebar.threads);
  threadsRef.current = sidebar.threads;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [preferences, setPreferences] = useState<Record<string, Preference>>(
    {},
  );
  const [previews, setPreviews] = useState<Previews>({});
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState<WorkItem | null>(null);
  const [expandedArea, setExpandedArea] = useState<WorkItem | null>(null);
  const [previewMode, setPreviewMode] = useState<"inline" | "pane">("inline");
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [chatTarget, setChatTarget] = useState<{
    itemId: string;
    threadId: string;
  } | null>(null);
  const chatToggleRef = useRef<HTMLButtonElement>(null);
  const [chatFocusRequest, setChatFocusRequest] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [rotation, setRotation] = useState(0);
  const [rotate, setRotate] = useState(
    () =>
      typeof window.matchMedia !== "function" ||
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [settling, setSettling] = useState(false);
  const [settled, setSettled] = useState<Settlement[]>([]);
  const [settledError, setSettledError] = useState("");
  const [undoing, setUndoing] = useState<string | null>(null);
  const undoLock = useRef(false);
  const live = useRef(true);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const returnFocus = useRef<HTMLElement | null>(null);
  const returnItemId = useRef<string | null>(null);
  const overviewScroll = useRef(0);
  const panelRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [inspectionLayout, setInspectionLayout] = useState<ReturnType<
    typeof arrangeMap
  > | null>(null);
  const [browseLayout, setBrowseLayout] = useState<WorkItem[] | null>(null);
  const [createdItemId, setCreatedItemId] = useState<string | null>(null);
  const [mapWidth, setMapWidth] = useState(1280);
  useEffect(() => {
    if (!canvasRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setMapWidth(entry.contentRect.width),
    );
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, []);
  const report = useCallback((cause: unknown) => {
    if (live.current)
      setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refresh = useCallback(
    async (fresh = false) => {
      try {
        const [data, prefs] = await Promise.all([
          rpc.call("snapshot", fresh ? { fresh: true } : null),
          rpc.call("preferences"),
        ]);
        if (live.current) {
          setSnapshot(data);
          setPreferences(prefs);
          setRefreshError("");
          setNow(Date.now());
          if (!selectionRef.current) setInspectionLayout(null);
        }
      } catch (cause) {
        if (live.current)
          setRefreshError(
            cause instanceof Error ? cause.message : String(cause),
          );
      }
    },
    [rpc],
  );
  const launcher = useSessionLauncher(() => void refresh(true));
  const loadSettled = useCallback(async () => {
    try {
      const rows = await rpc.call("settledToday");
      if (live.current) {
        setSettled(rows);
        setSettledError("");
      }
    } catch (cause) {
      if (live.current)
        setSettledError(
          `Could not load settled work: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
    }
  }, [rpc]);
  useEffect(() => {
    void loadSettled();
    const timer = setInterval(() => {
      if (!document.hidden) void loadSettled();
    }, 60_000);
    return () => clearInterval(timer);
  }, [loadSettled]);
  useRealtime("settlements-changed", () => {
    void loadSettled();
    void refresh(true);
  });
  const startSession = (item?: WorkItem) => {
    setChatTarget(null);
    if (manager.active) manager.close(false);
    if (!item) {
      setSelection(null);
      setExpandedArea(null);
      setActiveSession(null);
      setBrowseLayout(null);
      if (canvasRef.current) canvasRef.current.scrollTop = 0;
    }
    const project = snapshot?.projects.find(
      (p) => p.id === (item?.task?.projectId ?? item?.id.slice(8)),
    );
    launcher.open({
      id: item?.id ?? "global",
      title: item
        ? `${item.task?.key ? `${item.task.key} · ` : ""}${item.title}`
        : "Work Map",
      projectId:
        (item ? project?.linkedBbProjectId : bbContext.projectId) ?? undefined,
      taskId: item?.task?.id,
      prompt: item
        ? `${item.task ? `Task ${item.task.key}` : "Project"}: ${item.title}\n${item.summary}${item.nextAction ? `\nNext step: ${item.nextAction}` : ""}\n\n`
        : undefined,
    });
  };
  useEffect(() => {
    live.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 60000);
    const visibility = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      live.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [refresh]);
  useRealtime("preferences-changed", () => {
    rpc.call("preferences").then((p) => {
      if (live.current) setPreferences(p);
    }, report);
  });
  useRealtime("projects-changed", () => void refresh(true));
  const items = useMemo(
    () =>
      buildMap(
        snapshot ?? EMPTY,
        sidebar.threads,
        preferences,
        now,
        selection?.task?.id,
      ),
    [snapshot, sidebar.threads, preferences, now, selection?.task?.id],
  );
  const leaves = useMemo(
    () => items.flatMap((i) => (i.kind === "project" ? i.children : [i])),
    [items],
  );
  const itemById = useMemo(
    () => new Map([...items, ...leaves].map((item) => [item.id, item])),
    [items, leaves],
  );
  const setAreaVisibility = async (projectId: string, hidden: boolean) => {
    const id = `project:${projectId}`;
    const preference = await rpc.call("setPreference", { id, hidden });
    setPreferences((previous) => ({ ...previous, [id]: preference }));
    setInspectionLayout(null);
    setBrowseLayout(null);
    if (
      hidden &&
      (selection?.id === id || selection?.task?.projectId === projectId)
    ) {
      setSelection(null);
      setExpandedArea(null);
    }
  };
  const manager = useAreaManager({
    snapshot,
    projectItems: items,
    threads: sidebar.threads,
    preferences,
    workspaceId: bbContext.projectId,
    blocked: settling || launcher.busy,
    onResult: async (result: ManagementResult) => {
      if (result.threadId) {
        const linkedId = `thread:${result.threadId}`;
        const keep = (item: WorkItem) => item.id !== linkedId;
        setInspectionLayout(
          (layout) =>
            layout && {
              anchor:
                layout.anchor && keep(layout.anchor)
                  ? layout.anchor
                  : undefined,
              near: layout.near.filter(keep),
              west: layout.west.filter(keep),
              east: layout.east.filter(keep),
              north: layout.north.filter(keep),
              south: layout.south.filter(keep),
            },
        );
        setBrowseLayout((layout) => layout?.filter(keep) ?? null);
      }
      if (result.task) setCreatedItemId(`task:${result.task.id}`);
      else if (result.project) setCreatedItemId(`project:${result.project.id}`);
      await refresh(true);
    },
    onVisibility: setAreaVisibility,
    onFocus: async (id) => {
      const item = itemById.get(`project:${id}`);
      if (item) await saveFocus(item, !item.focus);
    },
    onOpen: (id) => {
      const item = itemById.get(`project:${id}`);
      if (item) openPreview(item);
    },
  });
  const tasksBySession = useMemo(() => {
    const index = new Map<string, MapTask[]>();
    for (const task of snapshot?.tasks ?? []) {
      const sessionIds = new Set([
        ...task.threadIds,
        ...(task.commentSessions ?? []).map((session) => session.threadId),
      ]);
      for (const id of sessionIds)
        index.set(id, [...(index.get(id) ?? []), task]);
    }
    return index;
  }, [snapshot]);
  const needle = query.trim().toLowerCase();
  const zoomDisabled = settling || launcher.busy || manager.busy || dragging;
  const zoomControl = useMapZoom(
    canvasRef,
    worldRef,
    selection?.id ?? expandedArea?.id,
    zoomDisabled,
  );
  const { zoom } = zoomControl;
  const density = zoomDensity(zoom, mapWidth);
  const matches = (item: WorkItem) =>
    (!needle ||
      `${item.title} ${item.kind === "project" ? "" : item.summary} ${item.task?.key ?? ""} ${item.scope}`
        .toLowerCase()
        .includes(needle)) &&
    (filter === "all" ||
      (filter === "focus"
        ? item.focus
        : filter === "working"
          ? isWorking(item)
          : filter === "unread"
            ? item.unreadResults > 0
            : item.signal === filter));
  // Search includes every open task, including tasks outside the current map.
  const candidates = (
    needle
      ? [...items.filter((i) => i.kind === "project"), ...leaves]
      : filter === "all" || filter === "focus"
        ? items
        : leaves
  )
    .filter(matches)
    .filter(
      (item) =>
        !(
          filter === "all" &&
          !needle &&
          !expanded &&
          preferences[item.id]?.hidden
        ),
    )
    .filter(
      (item) =>
        !(
          filter === "all" &&
          !needle &&
          !expanded &&
          item.kind === "project" &&
          !item.children.length &&
          !item.focus
        ),
    )
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const baseline = selectVisible(
    candidates,
    mapWidth >= 1100 ? 13 : 10,
    rotation,
  );
  const browseCount =
    filter === "all" && !needle
      ? items.filter(matches).length
      : candidates.length;
  const visible =
    expanded || needle || filter !== "all"
      ? candidates
      : zoomVisible(
          candidates,
          baseline,
          density.roots,
          rotation,
          zoom === 1 ? undefined : zoomControl.anchorId,
        );
  const spatial = !expanded && !needle && filter === "all";
  // Keep every area in its original slot while it is being explored.
  const currentItem = (item: WorkItem) => {
    if (!itemById.has(item.id) && item.kind === "thread") {
      const thread = sidebar.threads.find(
        (thread) => thread.id === item.threads[0]?.id,
      );
      if (thread) return sessionItem(thread, now);
    }
    const latest = itemById.get(item.id) ?? item;
    if (latest.kind !== "project") return latest;
    const originalIds = new Set(item.children.map((child) => child.id));
    return {
      ...latest,
      children: [
        ...item.children
          .map((child) =>
            latest.children.find((current) => current.id === child.id),
          )
          .filter((child): child is WorkItem => !!child),
        ...latest.children.filter((child) => !originalIds.has(child.id)),
      ],
    };
  };
  const selected = selection ? currentItem(selection) : null;
  const area = expandedArea ? currentItem(expandedArea) : null;
  const orbit =
    spatial && inspectionLayout
      ? {
          anchor:
            inspectionLayout.anchor && currentItem(inspectionLayout.anchor),
          near: inspectionLayout.near.map(currentItem),
          west: inspectionLayout.west.map(currentItem),
          east: inspectionLayout.east.map(currentItem),
          north: inspectionLayout.north.map(currentItem),
          south: inspectionLayout.south.map(currentItem),
        }
      : extendOrbit(arrangeMap(baseline), visible);
  const shown = spatial
    ? [
        orbit.anchor,
        ...orbit.near,
        ...orbit.west,
        ...orbit.east,
        ...orbit.north,
        ...orbit.south,
      ].filter((item): item is WorkItem => !!item)
    : (browseLayout?.map(currentItem) ?? visible);
  const inspecting = !!area && !!selected && previewMode === "inline";
  const expandedZone = inspecting
    ? ((["west", "east", "north", "south"] as const).find((zone) =>
        orbit[zone].some((item) => item.id === area.id),
      ) ?? "core")
    : "";
  const captureLayout = useMapMotion(
    canvasRef,
    `${spatial}:${mapWidth}:${zoom}:${selected?.id ?? ""}:${previewMode}:${chatTarget?.threadId ?? ""}:${launcher.context?.id ?? ""}:${launcher.threadId ?? ""}:${shown.map((item) => `${item.id}:${item.signal}:${item.attention}:${item.unreadResults}:${item.focus}`).join("|")}`,
    zoom,
  );
  useEffect(() => {
    setInspectionLayout(null);
    setBrowseLayout(null);
  }, [filter, query, expanded, rotation]);
  const counts = {
    focus: items.filter((i) => i.focus).length,
    waiting: leaves.filter((i) => i.signal === "waiting").length,
    unread: leaves.filter((i) => i.unreadResults > 0).length,
    working: leaves.filter(isWorking).length,
    inactive: leaves.filter((i) => i.signal === "inactive").length,
  };
  const hiddenImportant = items.filter(
    (i) =>
      !preferences[i.id]?.hidden &&
      (i.focus || i.signal !== "inactive") &&
      !shown.some((s) => s.id === i.id),
  ).length;
  const visibleThreads = shown
    .flatMap((i) => (i.kind === "thread" ? i.threads : []))
    .map((t) => t.id)
    .slice(0, 12)
    .sort()
    .join(",");
  const detailExcerpts = useMemo(() => {
    if (zoom <= 1) return {} as Record<string, string>;
    const limit = Math.round(240 + density.detail * 560);
    return Object.fromEntries(
      visibleThreads.split(",").flatMap((id) => {
        const preview = previews[id];
        return preview?.text && !preview.error
          ? [[id, previewExcerpt(preview.text, limit)]]
          : [];
      }),
    );
  }, [zoom, density.detail, visibleThreads, previews]);
  useEffect(() => {
    if (!visibleThreads) return;
    let canceled = false;
    const fetch = () =>
      rpc
        .call("previews", { threadIds: visibleThreads.split(",") })
        .then((result) => {
          if (!canceled) setPreviews((current) => ({ ...current, ...result }));
        }, report);
    void fetch();
    const timer = setInterval(() => {
      if (!document.hidden) void fetch();
    }, 30000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [rpc, visibleThreads, report]);
  useEffect(() => {
    if (
      !rotate ||
      zoom !== 1 ||
      launcher.context ||
      manager.active ||
      hovered ||
      selected ||
      dragging ||
      query ||
      expanded ||
      filter !== "all"
    )
      return;
    const timer = setInterval(() => {
      if (!document.hidden) setRotation((r) => r + 1);
    }, 45000);
    return () => clearInterval(timer);
  }, [
    rotate,
    manager.active,
    zoom,
    hovered,
    selected?.id,
    dragging,
    query,
    expanded,
    filter,
    launcher.context,
  ]);

  const previewId =
    selected?.kind === "project"
      ? null
      : (activeSession ?? selected?.threads[0]?.id);
  const livePreviewThread = sidebar.threads.find((t) => t.id === previewId);
  const previewThread =
    livePreviewThread ?? selected?.threads.find((t) => t.id === previewId);
  const canChat = !!livePreviewThread && !livePreviewThread.isArchived;
  const chatOpen =
    canChat &&
    chatTarget?.itemId === selected?.id &&
    chatTarget?.threadId === previewId;
  useEffect(() => {
    setChatTarget(null);
  }, [selected?.id, previewId, canChat]);
  useEffect(() => {
    // Change the nonce after mounting or moving the native chat, so focus does
    // not depend on whether the host treats an initial prop as a request.
    if (chatOpen) setChatFocusRequest((request) => request + 1);
  }, [chatOpen, previewMode]);
  const closeChat = () => {
    setChatTarget(null);
    requestAnimationFrame(() =>
      chatToggleRef.current?.focus({ preventScroll: true }),
    );
  };
  const relatedTasks = previewId ? (tasksBySession.get(previewId) ?? []) : [];
  const linkedSessions = selected?.task
    ? (selected.task.sessionLinks ??
      selected.task.threadIds.map((threadId) => ({
        threadId,
        title:
          sidebar.threads.find((t) => t.id === threadId)?.title ?? "Session",
        attachedAt: "",
        liveStatus: undefined,
      })))
    : [];
  const commentingSessions =
    selected?.task?.commentSessions?.filter(
      (session) => !selected.task?.threadIds.includes(session.threadId),
    ) ?? [];
  const previewAttention = previewThread?.latestAttentionAt;
  function sessionState(threadId: string, lastStatus?: string) {
    const thread = sidebar.threads.find((item) => item.id === threadId);
    if (thread?.isArchived) return "Archived";
    if (thread) return sessionItem(thread, now).reason;
    return lastStatus
      ? `Last recorded: ${lastStatus} · Not in active sessions`
      : "Not in active sessions";
  }
  const loadKey = `${selected?.id ?? ""}:${previewId ?? ""}:${previewAttention ?? ""}`;
  const [loadedKey, setLoadedKey] = useState("");
  const [previewFailure, setPreviewFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [previewRetry, setPreviewRetry] = useState(0);
  useEffect(() => {
    // The native chat owns its loading and read tracking while it is visible.
    if (!selected || selected.kind === "project" || chatOpen) return;
    let canceled = false;
    let responseLoaded = !previewId;
    setPreviewFailure(null);
    setLoadedKey("");
    const viewed = selected;
    const read = async () => {
      try {
        if (previewId) {
          const result = await rpc.call("previews", {
            threadIds: [previewId],
            fresh: true,
          });
          if (canceled) return;
          setPreviews((current) => ({ ...current, ...result }));
          setLoadedKey(loadKey);
          responseLoaded = true;
          // Only the displayed, successfully loaded finished response is marked seen.
          // Projects and sibling sessions are never bulk-acknowledged.
          const thread = previewThread;
          const latest = threadsRef.current.find((t) => t.id === previewId);
          if (
            result[previewId]?.text &&
            !result[previewId].error &&
            thread?.indicator === "unread-success" &&
            latest?.indicator === "unread-success" &&
            latest.latestAttentionAt === thread.latestAttentionAt
          )
            await actions.setRead(previewId, true);
        }
        if (!canceled && viewed.task && viewed.changed) {
          const pref = await rpc.call("setPreference", {
            id: viewed.id,
            seenAt: Date.parse(viewed.task.updatedAt),
          });
          if (!canceled)
            setPreferences((current) => ({ ...current, [viewed.id]: pref }));
        }
      } catch (cause) {
        if (!canceled) {
          if (!responseLoaded)
            setPreviewFailure({
              key: loadKey,
              message:
                "Session preview could not be loaded. Retry or open the full session.",
            });
          else report(cause);
        }
      }
    };
    void read();
    return () => {
      canceled = true;
    };
  }, [rpc, selected?.id, previewId, previewAttention, previewRetry, chatOpen]);
  const openPreview = (item: WorkItem) => {
    if (launcher.busy || manager.busy) return;
    if (manager.active) manager.close(false);
    if (launcher.context) launcher.close();
    if (
      previewMode === "inline" &&
      (selected?.id === item.id ||
        (item.kind === "project" && area?.id === item.id))
    ) {
      collapseDetails();
      return;
    }
    if (!selectionRef.current) {
      returnFocus.current = document.activeElement as HTMLElement;
      overviewScroll.current = canvasRef.current?.scrollTop ?? 0;
    }
    returnItemId.current = item.id;
    const parent = needle
      ? undefined
      : (spatial ? candidates : shown).find(
          (candidate) =>
            candidate.kind === "project" &&
            candidate.children.some((child) => child.id === item.id),
        );
    if (spatial) {
      const layout = inspectionLayout ?? orbit;
      const root = parent ?? item;
      // A connected task outside the overview joins the outer row without moving existing areas.
      setInspectionLayout(
        shown.some((shownItem) => shownItem.id === root.id)
          ? layout
          : { ...layout, south: [...layout.south, root] },
      );
    } else {
      const root = parent ?? item;
      setBrowseLayout(
        shown.some((shownItem) => shownItem.id === root.id)
          ? shown
          : [...shown, root],
      );
    }
    setExpandedArea(parent ?? item);
    setPreviewMode("inline");
    setSelection(item);
    setActiveSession(null);
  };
  useEffect(() => {
    if (!createdItemId || manager.busy) return;
    const item = itemById.get(createdItemId);
    if (item) {
      setCreatedItemId(null);
      if (selected?.id === item.id) setSelection(item);
      else if (area?.id !== item.id) openPreview(item);
    }
  }, [createdItemId, itemById, manager.busy]);
  const manageArea = (
    item: WorkItem,
    action: Parameters<React.ComponentProps<typeof AreaTools>["onAction"]>[0],
  ) => {
    if (action === "focus") {
      void saveFocus(item, !item.focus);
      return;
    }
    if (action === "hide") {
      void setAreaVisibility(
        item.id.slice(8),
        !preferences[item.id]?.hidden,
      ).catch(report);
      return;
    }
    if (action === "editProject") {
      setPreviewMode("inline");
      manager.open(action, item.id.slice(8));
      return;
    }
    if (area?.id !== item.id || !selected || previewMode !== "inline")
      openPreview(item);
    if (action === "session") {
      manager.close();
      startSession(item);
    } else manager.open(action, item.id.slice(8));
  };
  const close = () => {
    if (launcher.busy || manager.busy) return;
    if (manager.active) manager.close(false);
    if (launcher.context) launcher.close();
    const areaId = area?.id;
    const index = shown.findIndex((item) => item.id === areaId);
    const nextId =
      [...shown.slice(index + 1), ...shown.slice(0, index).reverse()].find(
        (item) => candidates.some((candidate) => candidate.id === item.id),
      )?.id ?? candidates[0]?.id;
    if (canvasRef.current) canvasRef.current.scrollTop = overviewScroll.current;
    setSelection(null);
    setExpandedArea(null);
    setActiveSession(null);
    setChatTarget(null);
    setBrowseLayout(null);
    requestAnimationFrame(() => {
      const trigger = returnItemId.current
        ? canvasRef.current?.querySelector<HTMLElement>(
            `[data-work-id="${returnItemId.current}"]`,
          )
        : null;
      const areaTrigger = areaId
        ? canvasRef.current?.querySelector<HTMLElement>(
            `[data-work-id="${areaId}"]`,
          )
        : null;
      const nextTrigger = nextId
        ? canvasRef.current?.querySelector<HTMLElement>(
            `[data-work-id="${nextId}"]`,
          )
        : null;
      const activeFilter = canvasRef.current
        ?.closest(".wm-root")
        ?.querySelector<HTMLElement>('.wm-filter[aria-pressed="true"]');
      (
        trigger ??
        areaTrigger ??
        nextTrigger ??
        activeFilter ??
        returnFocus.current
      )?.focus({
        preventScroll: true,
      });
    });
  };
  const collapseDetails = () => {
    if (launcher.context) {
      launcher.close();
      return;
    }
    if (chatOpen) {
      closeChat();
      return;
    }
    if (
      previewMode === "inline" &&
      selected?.kind === "task" &&
      area?.kind === "project"
    ) {
      setSelection(area);
      setActiveSession(null);
    } else close();
  };
  const afterSettlement = (result: Settlement) => {
    captureLayout();
    setSettled((rows) => [
      result,
      ...rows.filter((row) => row.id !== result.id),
    ]);
    setSettledError("");
    close();
    setInspectionLayout(null);
    void refresh(true);
  };
  const undoSettlement = async (id: string) => {
    if (undoLock.current) return;
    undoLock.current = true;
    setUndoing(id);
    setSettledError("");
    try {
      const result = await rpc.call("undoSettlement", { id });
      captureLayout();
      setSettled((rows) => rows.filter((row) => row.id !== id));
      setNotice(
        result.warning ||
          `Undone.${result.taskUpdated ? " Task fields restored." : ""}${result.archivedThreadIds.length ? " Session reopened; stopped agents remain stopped." : ""}`,
      );
      await refresh(true);
    } catch (cause) {
      setSettledError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      undoLock.current = false;
      setUndoing(null);
    }
  };
  function settleControls(item?: WorkItem, createdThreadId?: string) {
    const threadId =
      createdThreadId ??
      (item?.kind === "thread" ||
      (previewId && item?.task?.threadIds.includes(previewId))
        ? previewId
        : undefined);
    const thread = sidebar.threads.find((thread) => thread.id === threadId);
    return (
      <SettlementActions
        key={item?.id ?? `created:${threadId}`}
        task={item?.task}
        thread={
          threadId
            ? {
                id: threadId,
                title:
                  thread?.title ?? launcher.context?.title ?? "Viewed session",
                running: thread ? threadSignal(thread) === "working" : true,
                archived: thread?.isArchived ?? false,
              }
            : undefined
        }
        disabled={launcher.busy || undoing !== null}
        onBusy={setSettling}
        onSettled={afterSettlement}
      />
    );
  }
  useEffect(() => {
    if (selection) {
      panelRef.current?.focus({ preventScroll: true });
      if (previewMode === "pane")
        panelRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [selection?.id, previewMode]);
  const saveFocus = async (item: WorkItem, focus: boolean) => {
    if (busy) return;
    if (
      !focus &&
      item.kind === "project" &&
      item.children.some((child) => child.focus)
    ) {
      setNotice(
        "This project contains focused tasks. Open it and remove their focus first.",
      );
      return;
    }
    setNotice("");
    setBusy(true);
    try {
      if (item.kind === "thread")
        await actions.setPinned(item.threads[0].id, focus);
      else {
        if (!focus && item.kind === "task")
          await Promise.all(
            item.threads
              .filter((t) => t.isPinned)
              .map((t) => actions.setPinned(t.id, false)),
          );
        const pref = await rpc.call("setPreference", { id: item.id, focus });
        setPreferences((current) => ({ ...current, [item.id]: pref }));
        // A pinned child keeps its project in focus until that child is unpinned.
      }
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const drop = (event: DragEvent, focus: boolean) => {
    event.preventDefault();
    captureLayout();
    setDragging(false);
    const id = event.dataTransfer.getData("application/x-bb-work-map");
    const item = [...items, ...leaves].find((i) => i.id === id);
    if (item) void saveFocus(item, focus);
  };
  function tile(item: WorkItem, small = false) {
    const inspecting = selected?.id === item.id && previewMode === "inline";
    const showExcerpt = !small || zoom > 1;
    const excerpt =
      item.kind === "thread"
        ? detailExcerpts[item.threads[0]?.id] ||
          previews[item.threads[0]?.id]?.excerpt ||
          item.summary
        : item.nextAction || item.summary;
    const due = item.task ? dueLabel(item.task, now) : "";
    const zoomDetail =
      item.kind !== "thread" && item.summary !== excerpt ? item.summary : "";
    const relatedCount =
      item.kind === "thread"
        ? (tasksBySession.get(item.threads[0].id)?.length ?? 0)
        : new Set([
            ...(item.task?.threadIds ?? []),
            ...(item.task?.commentSessions ?? []).map(
              (session) => session.threadId,
            ),
          ]).size;
    return (
      <article
        key={item.id}
        className={`wm-item ${item.focus ? "wm-focused" : ""} ${inspecting ? "wm-item-expanded" : ""}`}
      >
        <button
          data-work-id={item.id}
          aria-expanded={inspecting}
          aria-controls={inspecting ? `detail-${item.id}` : undefined}
          type="button"
          className={`wm-tile wm-${item.signal} ${isWorking(item) ? "wm-has-working" : ""} ${item.focus ? "wm-focused" : ""} ${small ? "wm-small" : ""} ${selected?.id === item.id ? "wm-selected" : ""}`}
          data-attention={item.attention ?? undefined}
          data-kind={item.kind}
          data-has-results={item.unreadResults > 0 || undefined}
          onClick={() => openPreview(item)}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData("application/x-bb-work-map", item.id);
            event.dataTransfer.effectAllowed = "move";
            setDragging(true);
          }}
          onDragEnd={() => setDragging(false)}
          aria-label={[
            `Preview ${item.title}`,
            item.reason,
            needsReview(item) && item.attention !== "review"
              ? "Needs review"
              : "",
            item.signal !== "unread" && item.unreadResults
              ? unreadLabel(item.unreadResults)
              : "",
            item.focus ? "In focus" : "",
            item.task ? `${item.task.priority} priority` : "",
            due,
            item.changed ? "Updated" : "",
            showExcerpt && !(inspecting && item.kind === "task") ? excerpt : "",
            zoom > 1 && !(inspecting && item.kind === "task") ? zoomDetail : "",
          ]
            .filter(Boolean)
            .join(". ")}
        >
          <span className="wm-tile-meta">
            <span>
              {item.task?.key ?? item.scope}
              {(!small || zoom > 1) && relatedCount > 0
                ? ` · ${relatedCount} ${item.kind === "thread" ? (relatedCount === 1 ? "related task" : "related tasks") : relatedCount === 1 ? "session" : "sessions"}`
                : ""}
              {zoom > 1 && item.task ? ` · ${item.task.priority} priority` : ""}
            </span>
            {item.focus && (
              <span className="wm-pin">
                <Icon name="Pin" /> Focus
              </span>
            )}
            {item.changed && <span className="wm-changed">Updated</span>}
          </span>
          <strong>{item.title}</strong>
          {showExcerpt && !(inspecting && item.kind === "task") && (
            <span className="wm-excerpt">
              {zoom > 1 && item.nextAction && (
                <span className="wm-detail-label">Next: </span>
              )}
              {excerpt}
            </span>
          )}
          {zoom > 1 && zoomDetail && !(inspecting && item.kind === "task") && (
            <span className="wm-zoom-details">
              <span className="wm-detail-label">Status</span> {zoomDetail}
            </span>
          )}
          <span className="wm-tile-bottom">
            <Status item={item} />
            {item.signal !== "working" && isWorking(item) && (
              <span className="wm-status wm-working">
                <i />
                Agent working
              </span>
            )}
            {due && <span className="wm-due">{due}</span>}
          </span>
        </button>
        {inspecting && details()}
      </article>
    );
  }
  function island(item: WorkItem) {
    if (item.kind !== "project" || needle) return tile(item);
    const hasWorking = isWorking(item);
    const inspecting =
      area?.id === item.id && previewMode === "inline" && !!selected;
    const compact =
      !!area && !!selected && previewMode === "inline" && !inspecting;
    const taskLimit = compact
      ? 2
      : zoomDensity(zoom, mapWidth, item.focus).tasks;
    const children =
      inspecting &&
      selected?.task?.projectId === item.id.slice(8) &&
      !item.children.some((child) => child.id === selected.id)
        ? [...item.children, selected]
        : item.children;
    return (
      <article
        key={item.id}
        className={`wm-island wm-${item.signal} ${item.focus ? "wm-focused" : ""} ${hasWorking ? "wm-has-working" : ""} ${inspecting ? "wm-area-expanded" : ""}`}
        data-has-results={item.unreadResults > 0 || undefined}
        data-kind="project"
      >
        <button
          className="wm-island-heading"
          data-work-id={item.id}
          aria-expanded={inspecting}
          aria-controls={inspecting ? `area-${item.id}` : undefined}
          onClick={() => openPreview(item)}
          aria-label={`Open project ${item.title}. ${item.reason}${item.focus ? ". In focus" : ""}. ${item.summary}`}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData("application/x-bb-work-map", item.id);
            setDragging(true);
          }}
          onDragEnd={() => setDragging(false)}
        >
          <span className="wm-tile-meta">
            <span>
              <ProjectDot
                color={
                  snapshot?.projects.find(
                    (project) => `project:${project.id}` === item.id,
                  )?.color
                }
              />
              {item.scope} · {item.children.length} tasks
            </span>
            {item.focus && (
              <span className="wm-pin">
                <Icon name="Pin" /> Focus
              </span>
            )}
          </span>
          <strong>{item.title}</strong>
          <span className="wm-excerpt">{item.summary}</span>
          <span className="wm-project-status">
            <Status item={item} />
          </span>
        </button>
        <AreaTools
          title={item.title}
          disabled={launcher.busy || manager.busy || settling}
          focused={item.focus}
          hidden={!!preferences[item.id]?.hidden}
          onAction={(action) => manageArea(item, action)}
        />
        {inspecting ? (
          <section
            id={`area-${item.id}`}
            className="wm-expanded-project"
            aria-label={`Expanded: ${item.title}`}
          >
            <div
              className="wm-area-actions"
              ref={
                selected?.id === item.id
                  ? (panelRef as React.RefObject<HTMLDivElement>)
                  : undefined
              }
              tabIndex={-1}
            >
              <Button
                size="sm"
                onClick={() => startSession(item)}
                disabled={launcher.busy}
              >
                <Icon name="MessageCirclePlus" /> New session
              </Button>
              <Button size="sm" variant="outline" onClick={close}>
                Collapse area
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setSelection(item);
                  setPreviewMode("pane");
                }}
              >
                Open in side pane
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  busy || (item.focus && children.some((child) => child.focus))
                }
                onClick={() => void saveFocus(item, !item.focus)}
              >
                {item.focus ? "Project in focus" : "Focus project"}
              </Button>
            </div>
            {manager.inlineProjectId === item.id.slice(8) && manager.inline}
            {launcher.context?.id === item.id && (
              <>
                {launcher.view}
                {launcher.threadId &&
                  settleControls(undefined, launcher.threadId)}
              </>
            )}
            <div className="wm-island-tasks wm-expanded-tasks">
              {children.map((child) => tile(child))}
            </div>
            {completedTasks(item)}
          </section>
        ) : (
          <>
            <div className="wm-island-tasks">
              {zoomVisible(
                item.children,
                selectVisible(item.children, taskLimit),
                taskLimit,
                0,
                zoom === 1 ? undefined : zoomControl.anchorWorkId,
              ).map((child) => tile(child, true))}
            </div>
            <button
              className="wm-project-more"
              onClick={() => openPreview(item)}
            >
              {compact && item.children.length > taskLimit
                ? `+${item.children.length - taskLimit} more tasks`
                : `Explore ${item.children.length} tasks`}{" "}
              <span aria-hidden="true">↗</span>
            </button>
          </>
        )}
      </article>
    );
  }
  function mapArea(item: WorkItem) {
    const expandedHere = inspecting && area?.id === item.id;
    return (
      <div
        key={item.id}
        data-layout-id={item.id}
        className={`wm-map-area ${expandedHere ? "wm-map-area-expanded" : inspecting ? "wm-map-area-compact" : ""}`}
      >
        {island(item)}
      </div>
    );
  }
  const focusedProject =
    selected?.kind === "project" && selected.children.some((c) => c.focus);
  function completedTasks(project: WorkItem) {
    const completed =
      snapshot?.tasks.filter(
        (t) =>
          `project:${t.projectId}` === project.id &&
          !project.children.some((child) => child.task?.id === t.id),
      ) ?? [];
    return completed.length ? (
      <details className="wm-completed">
        <summary>{completed.length} completed or canceled tasks</summary>
        {completed.map((t) => (
          <UrlLink key={t.id} href={`/plugins/tasks/tasks/task/${t.key}`}>
            <span>
              {t.key} · {t.status}
            </span>
            {t.title}
          </UrlLink>
        ))}
      </details>
    ) : null;
  }
  const preview = previewId ? previews[previewId] : null;
  function details(pane = false) {
    if (!selected) return null;
    const Element = pane ? "aside" : "section";
    return (
      <Element
        className={`${pane ? "wm-preview" : "wm-inline-detail"} ${selected.task ? "wm-task-detail" : ""}`}
        id={`detail-${selected.id}`}
        ref={panelRef}
        tabIndex={-1}
        aria-label={`${pane ? "Preview" : "Expanded"}: ${selected.title}`}
      >
        <div className="wm-preview-top">
          <button
            onClick={collapseDetails}
            aria-label={pane ? "Close preview" : "Collapse details"}
          >
            <Icon name="ArrowLeft" />{" "}
            {pane ? "Back to map" : "Collapse details"}
          </button>
          <span>
            {selected.kind === "project"
              ? "PROJECT"
              : (selected.task?.key ?? "SESSION")}
          </span>
        </div>
        {pane && (
          <>
            <Status item={selected} />
            <h2>{selected.title}</h2>
          </>
        )}
        <div className="wm-preview-actions">
          {selected.kind === "project" && (
            <AreaTools
              title={selected.title}
              disabled={launcher.busy || manager.busy || settling}
              focused={selected.focus}
              hidden={!!preferences[selected.id]?.hidden}
              onAction={(action) => manageArea(selected, action)}
            />
          )}
          {selected.kind === "project" && (
            <Button
              size="sm"
              disabled={launcher.busy}
              onClick={() => startSession(selected)}
            >
              <Icon name="MessageCirclePlus" /> New session
            </Button>
          )}
          <Button
            size="sm"
            variant={selected.task ? "ghost" : "outline"}
            onClick={() => setPreviewMode(pane ? "inline" : "pane")}
          >
            {pane ? "Expand in map" : "Open in side pane"}
          </Button>
          <Button
            size="sm"
            variant={
              selected.focus ? "secondary" : selected.task ? "ghost" : "outline"
            }
            disabled={busy || !!focusedProject}
            onClick={() => void saveFocus(selected, !selected.focus)}
          >
            <Icon name="Pin" />
            {selected.focus ? "In focus" : "Bring into focus"}
          </Button>
          {selected.task && (
            <UrlLink
              className="wm-task-link"
              href={`/plugins/tasks/tasks/task/${selected.task.key}`}
            >
              Open task ↗
            </UrlLink>
          )}
        </div>
        {selected.kind === "project" &&
          manager.inlineProjectId === selected.id.slice(8) &&
          manager.inline}
        {launcher.context?.id === selected.id && launcher.view}
        {selected.kind === "project" &&
          launcher.context?.id === selected.id &&
          launcher.threadId &&
          settleControls(undefined, launcher.threadId)}
        {selected.kind === "thread" &&
          settleControls(
            selected,
            launcher.context?.id === selected.id
              ? (launcher.threadId ?? undefined)
              : undefined,
          )}
        {focusedProject && (
          <p className="wm-preview-description">
            A focused task keeps this project in focus. Change that task's focus
            to move the project out.
          </p>
        )}
        {selected.kind === "task" &&
          selected.threads.some((t) => t.isPinned) && (
            <p className="wm-preview-description">
              This task inherits focus from pinned sessions. Removing focus also
              unpins those sessions in BB.
            </p>
          )}
        {selected.kind === "project" ? (
          <>
            <p className="wm-preview-description">
              {selected.children.length} open or unreviewed tasks. Activity and
              focus roll up from the tasks below.
            </p>
            <div className="wm-project-list">
              {selected.children.map((child) => tile(child))}
            </div>
            {completedTasks(selected)}
          </>
        ) : (
          <>
            {selected.task && (
              <>
                <section
                  className="wm-detail-section wm-task-summary"
                  aria-label="Task summary"
                >
                  {selected.summary &&
                    selected.summary !== selected.nextAction && (
                      <>
                        <h3>Current status</h3>
                        <p>{selected.summary}</p>
                      </>
                    )}
                  {selected.nextAction && (
                    <div className="wm-next">
                      <h3>Next step</h3>
                      <p>{selected.nextAction}</p>
                    </div>
                  )}
                  {!selected.summary && !selected.nextAction && (
                    <p>No status summary recorded yet.</p>
                  )}
                </section>
                <dl className="wm-facts">
                  <div>
                    <dt>Project</dt>
                    <dd>{selected.scope}</dd>
                  </div>
                  <div>
                    <dt>Priority</dt>
                    <dd>{selected.task.priority}</dd>
                  </div>
                  {selected.task.dueDate && (
                    <div>
                      <dt>
                        {selected.task.dateKind === "plan"
                          ? "Planned date"
                          : "Due date"}
                      </dt>
                      <dd>{selected.task.dueDate}</dd>
                    </div>
                  )}
                  {selected.task.waitingOn &&
                    selected.task.waitingOn.toLowerCase() !== "none" && (
                      <div>
                        <dt>Waiting on</dt>
                        <dd>{selected.task.waitingOn}</dd>
                      </div>
                    )}
                </dl>
              </>
            )}
            {selected.task && (
              <section
                className="wm-detail-section wm-connections wm-task-sessions"
                aria-label="Connected sessions"
              >
                <div className="wm-section-heading">
                  <h3>
                    Sessions{" "}
                    <span>
                      {linkedSessions.length + commentingSessions.length}
                    </span>
                  </h3>
                  <Button
                    size="sm"
                    variant={canChat ? "ghost" : "default"}
                    disabled={launcher.busy}
                    onClick={() => startSession(selected)}
                  >
                    <Icon name="MessageCirclePlus" /> New session
                  </Button>
                </div>
                <div className="wm-session-options">
                  {linkedSessions.map((session) => (
                    <button
                      key={session.threadId}
                      aria-pressed={previewId === session.threadId}
                      title={`Attached to task · ${sessionState(session.threadId, session.liveStatus)}${session.attachedAt ? ` · ${session.attachedAt.slice(0, 10)}` : ""}`}
                      onClick={() => setActiveSession(session.threadId)}
                    >
                      <strong>
                        {sidebar.threads.find((t) => t.id === session.threadId)
                          ?.title ?? session.title}
                      </strong>
                      <span>
                        {sidebar.threads.some((t) => t.id === session.threadId)
                          ? sessionState(session.threadId)
                          : "Not in active sessions"}{" "}
                        · Attached
                      </span>
                    </button>
                  ))}
                  {commentingSessions.map((session) => (
                    <button
                      key={session.threadId}
                      aria-pressed={previewId === session.threadId}
                      title={`Commented on task · ${sessionState(session.threadId)} · ${session.at.slice(0, 10)}`}
                      onClick={() => setActiveSession(session.threadId)}
                    >
                      <strong>
                        {sidebar.threads.find((t) => t.id === session.threadId)
                          ?.title ??
                          session.title ??
                          session.threadId}
                      </strong>
                      <span>
                        {sidebar.threads.some((t) => t.id === session.threadId)
                          ? sessionState(session.threadId)
                          : "Not in active sessions"}{" "}
                        · Contributed
                      </span>
                    </button>
                  ))}
                </div>
                {!previewId && (
                  <p className="wm-session-hint">
                    {linkedSessions.length || commentingSessions.length
                      ? "Choose a session to read or continue it."
                      : "Start a session to work on this task."}
                  </p>
                )}
              </section>
            )}
            {previewId ? (
              <section className="wm-session-view">
                <div className="wm-session-controls">
                  {canChat && (
                    <Button
                      ref={chatToggleRef}
                      size="sm"
                      variant={chatOpen ? "outline" : "default"}
                      aria-expanded={chatOpen}
                      aria-controls={chatOpen ? `chat-${previewId}` : undefined}
                      disabled={launcher.busy}
                      onClick={() => {
                        if (chatOpen) closeChat();
                        else {
                          if (launcher.context) launcher.close();
                          setChatTarget({
                            itemId: selected.id,
                            threadId: previewId,
                          });
                        }
                      }}
                    >
                      {chatOpen ? "Back to summary" : "Chat here"}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => actions.open(previewId)}
                  >
                    <Icon name="ArrowUpRight" />
                    Open full session
                  </Button>
                </div>
                {chatOpen ? (
                  <section
                    id={`chat-${previewId}`}
                    className="wm-live-session"
                    aria-label={`Live session: ${previewThread?.title ?? selected.title}`}
                  >
                    <div className="wm-live-heading">
                      <strong>{previewThread?.title ?? selected.title}</strong>
                      <span>{sessionState(previewId)}</span>
                    </div>
                    <ThreadChat
                      key={previewId}
                      threadId={previewId}
                      variant="compact"
                      layout="contained"
                      permissionPolicy="inherit"
                      focusRequest={chatFocusRequest}
                      className="wm-live-chat"
                    />
                  </section>
                ) : (
                  <div className="wm-detail-section wm-session-summary">
                    <h3>
                      {previewThread &&
                      threadSignal(previewThread) === "working"
                        ? "Latest response · session is working"
                        : "Latest session response"}
                    </h3>
                    {previewFailure?.key !== loadKey &&
                    loadedKey === loadKey &&
                    preview?.text &&
                    !preview.error ? (
                      <div
                        className="wm-response"
                        role="region"
                        aria-label="Session response"
                        tabIndex={0}
                      >
                        <Markdown content={preview.text} />
                      </div>
                    ) : (
                      <p>
                        {previewFailure?.key === loadKey
                          ? previewFailure.message
                          : loadedKey !== loadKey
                            ? "Loading session preview…"
                            : preview?.text ||
                              "No response yet. Open the chat to follow its progress."}
                      </p>
                    )}
                    {(previewFailure?.key === loadKey || preview?.error) && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setPreviewRetry((n) => n + 1)}
                      >
                        Retry preview
                      </Button>
                    )}
                    <p className="wm-excerpt-note">
                      {loadedKey === loadKey &&
                        !preview?.error &&
                        preview?.truncated &&
                        "Shortened response. Open the full session for the rest. "}
                      {canChat
                        ? "Latest excerpt. Chat here to reply and follow the session live."
                        : previewThread?.isArchived
                          ? "Archived session. Open the full session to view or reopen it."
                          : "This session is not in BB's active list. Open the full session to check it."}
                    </p>
                  </div>
                )}
                {relatedTasks.length > 0 && (
                  <div className="wm-detail-section wm-connections wm-related-tasks">
                    <h3>Tasks connected to this session</h3>
                    {relatedTasks.map((task) => {
                      const related = leaves.find(
                        (item) => item.task?.id === task.id,
                      );
                      const content = (
                        <>
                          <strong>
                            {task.key} · {task.title}
                          </strong>
                          <span>
                            {task.threadIds.includes(previewId)
                              ? "Attached session"
                              : "Commented on this task"}
                          </span>
                        </>
                      );
                      return related && related.id !== selected.id ? (
                        <button
                          key={task.id}
                          onClick={() => openPreview(related)}
                        >
                          {content}
                        </button>
                      ) : (
                        <UrlLink
                          key={task.id}
                          href={`/plugins/tasks/tasks/task/${task.key}`}
                        >
                          {content}
                        </UrlLink>
                      );
                    })}
                  </div>
                )}
                <button
                  className="wm-split"
                  onClick={() => actions.open(previewId, { split: true })}
                >
                  Open alongside ↗
                </button>
                {previewThread?.isPinned && selected.kind === "task" && (
                  <button
                    className="wm-split"
                    onClick={() => {
                      actions.setPinned(previewId, false).catch(report);
                    }}
                  >
                    Unpin this session
                  </button>
                )}
                {previewThread?.indicator === "unread-error" && (
                  <button
                    className="wm-split"
                    onClick={() => {
                      actions.setRead(previewId, true).catch(report);
                    }}
                  >
                    Mark error seen
                  </button>
                )}
              </section>
            ) : null}
            {selected.task &&
              settleControls(
                selected,
                launcher.context?.id === selected.id
                  ? (launcher.threadId ?? undefined)
                  : undefined,
              )}
          </>
        )}
      </Element>
    );
  }
  return (
    <div
      className="wm-root"
      onClickCapture={(event) => {
        if (settling || manager.busy) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (
          launcher.busy &&
          !(event.target as HTMLElement).closest(".wm-session-launcher")
        ) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        captureLayout();
      }}
      onKeyDownCapture={(event) => {
        if (settling || manager.busy) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        captureLayout();
      }}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !settling &&
          !event.defaultPrevented &&
          (selection || launcher.context)
        ) {
          event.stopPropagation();
          collapseDetails();
        }
      }}
    >
      <header className="wm-toolbar">
        <div className="wm-intro">
          <span className="wm-eyebrow">FOCUS, ACTIVITY & ATTENTION</span>
          <h1>What needs you now.</h1>
        </div>
        <div className="wm-tools">
          <Button disabled={launcher.busy} onClick={() => startSession()}>
            <Icon name="MessageCirclePlus" /> New session
          </Button>
          <Button
            variant="outline"
            disabled={launcher.busy || manager.busy}
            onClick={() => {
              setPreviewMode("inline");
              manager.open("createProject");
            }}
          >
            New project
          </Button>
          <Input
            disabled={launcher.busy}
            value={query}
            onChange={(event) => {
              if (manager.active) manager.close(false);
              if (launcher.context) launcher.close();
              setSelection(null);
              setExpandedArea(null);
              setQuery(event.target.value);
            }}
            placeholder="Find a task or session…"
            aria-label="Find a task or session"
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Refresh map"
            onClick={() => void refresh(true)}
          >
            <Icon name="RefreshCw" />
          </Button>
        </div>
      </header>
      <div className="wm-filterbar">
        <div className="wm-filters" role="group" aria-label="Filter work">
          {(
            [
              ["all", "Overview"],
              ["focus", "In focus"],
              ["waiting", "Waiting for you"],
              ["unread", "Ready to read"],
              ["working", "Working"],
              ["inactive", "Inactive"],
            ] as [Filter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              className={`wm-filter wm-${value}`}
              aria-pressed={filter === value}
              disabled={launcher.busy}
              onClick={() => {
                if (manager.active) manager.close(false);
                if (launcher.context) launcher.close();
                setSelection(null);
                setExpandedArea(null);
                setFilter(value);
                setExpanded(false);
              }}
            >
              <i />
              {label}
              {value !== "all" && <b>{counts[value]}</b>}
            </button>
          ))}
        </div>
        <ZoomControls {...zoomControl} disabled={zoomDisabled} />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Manage areas"
          disabled={launcher.busy || manager.busy}
          onClick={() => {
            setPreviewMode("inline");
            manager.open();
          }}
        >
          <Icon name="Settings" />
        </Button>
        <span className="wm-live">
          <i />
          {snapshot
            ? `Updated ${age(snapshot.generatedAt, now)}`
            : "Connecting"}
        </span>
      </div>
      {error && (
        <div role="alert" className="wm-error">
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {refreshError && (
        <div role="alert" className="wm-error">
          <span>
            {snapshot
              ? "Showing the last loaded tasks. "
              : "Could not load tasks. "}
            {refreshError}
          </span>
          <button onClick={() => void refresh()}>Retry refresh</button>
        </div>
      )}
      {notice && (
        <div role="status" className="wm-notice">
          {notice}
          <button onClick={() => setNotice("")}>Dismiss</button>
        </div>
      )}
      {sidebar.status === "error" && (
        <div role="alert" className="wm-error">
          Session status is unavailable. Tasks remain visible; refresh BB to
          reconnect.
        </div>
      )}
      {!!snapshot?.warnings.length && (
        <div className="wm-error" role="status">
          {snapshot.warnings.length} task connections could not be loaded.
          Attached or contributing sessions may be missing.
        </div>
      )}
      <div
        className={`wm-body ${manager.pane || (selected && previewMode === "pane") ? "wm-with-preview" : ""}`}
      >
        <main
          className="wm-canvas"
          ref={canvasRef}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocusCapture={() => setHovered(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              setHovered(false);
          }}
        >
          {launcher.context?.id === "global" && (
            <>
              {launcher.view}
              {launcher.threadId &&
                settleControls(undefined, launcher.threadId)}
            </>
          )}
          {dragging && (
            <div className="wm-dropzones">
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => drop(e, true)}
              >
                Drop here to bring into focus
              </div>
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => drop(e, false)}
              >
                Drop here to remove your focus
              </div>
            </div>
          )}
          {!snapshot ? (
            <div className="wm-empty" role="status">
              {refreshError
                ? "Task data is unavailable. Use Retry refresh above."
                : "Gathering your projects and sessions…"}
            </div>
          ) : shown.length === 0 ? (
            <div className="wm-empty">
              <Icon name="Search" />
              <h2>
                {needle ? "No matching work" : "Nothing here needs attention"}
              </h2>
              <p>
                {needle
                  ? "Try a task key, project name or a few words from its title."
                  : "Choose Overview to see the rest of your work."}
              </p>
            </div>
          ) : (
            <div
              ref={worldRef}
              className={`wm-map-world ${zoom < 1 ? "wm-zoomed-out" : zoom > 1 ? "wm-zoomed-in" : ""}`}
              data-zoom={Math.round(zoom * 100)}
              data-detail={
                zoom <= 0.8 ? "compact" : zoom > 1 ? "detail" : "overview"
              }
              style={
                {
                  width: "100%",
                  containerType: "inline-size",
                  "--wm-zoom-detail": density.detail,
                  "--wm-zoom-compact": density.compact,
                  "--wm-zoom-lines": density.lines,
                } as CSSProperties
              }
            >
              <div className="wm-map-caption">
                <span>
                  {spatial
                    ? "YOUR WORK, AROUND YOUR FOCUS"
                    : filter === "focus"
                      ? "IN FOCUS"
                      : needle
                        ? "SEARCH RESULTS"
                        : filter === "all"
                          ? "ALL WORK"
                          : "MATCHING WORK"}
                </span>
                <span>
                  {zoom !== 1 && spatial
                    ? inspectionLayout
                      ? `${shown.length} areas and sessions · Layout held while expanded`
                      : `${shown.length === candidates.length ? `All ${shown.length}` : `${shown.length} of ${candidates.length}`} areas and sessions · ${zoom < 1 ? "Compact" : "Detail"}`
                    : "Click to expand · Pinch to zoom · Drag to focus"}
                </span>
              </div>
              {spatial ? (
                <section
                  className={`wm-spatial ${inspecting ? `wm-inspecting wm-expand-${expandedZone}` : ""}`}
                  aria-label="Work arranged around your focus"
                >
                  <div className="wm-orbit-rings" aria-hidden="true" />
                  <section
                    className="wm-orbit-core"
                    aria-label="Work at the center"
                  >
                    {orbit.anchor && (
                      <div className="wm-orbit-anchor">
                        <span
                          className={`wm-center-label wm-${orbit.anchor.focus ? "focused" : orbit.anchor.signal}`}
                        >
                          {orbit.anchor.focus
                            ? "IN FOCUS"
                            : orbit.anchor.signal === "waiting"
                              ? orbit.anchor.attention === "review"
                                ? "NEEDS REVIEW"
                                : orbit.anchor.attention === "followup"
                                  ? "FOLLOW-UP DUE"
                                  : orbit.anchor.attention === "error"
                                    ? "RUN FAILED"
                                    : "NEEDS YOUR INPUT"
                              : orbit.anchor.signal === "unread"
                                ? "READY TO READ"
                                : isWorking(orbit.anchor)
                                  ? "WORKING NOW"
                                  : "IN VIEW"}
                        </span>
                        {mapArea(orbit.anchor)}
                      </div>
                    )}
                    <div className="wm-orbit-near wm-near-above">
                      {orbit.near[0] && mapArea(orbit.near[0])}
                    </div>
                    <div className="wm-orbit-near wm-near-below">
                      {orbit.near[1] && mapArea(orbit.near[1])}
                    </div>
                  </section>
                  <section
                    className="wm-orbit-west wm-orbit-side"
                    aria-label="Work to the left"
                  >
                    {orbit.west.map(mapArea)}
                  </section>
                  <section
                    className="wm-orbit-east wm-orbit-side"
                    aria-label="Work to the right"
                  >
                    {orbit.east.map(mapArea)}
                  </section>
                  <section
                    className="wm-orbit-north wm-orbit-far"
                    aria-label="Outer work above"
                  >
                    {orbit.north.map(mapArea)}
                  </section>
                  <section
                    className="wm-orbit-south wm-orbit-far"
                    aria-label="Outer work below"
                  >
                    {orbit.south.map(mapArea)}
                  </section>
                </section>
              ) : (
                <section className="wm-results" aria-label="Matching work">
                  {shown.map((item) => (
                    <div
                      key={item.id}
                      className="wm-result"
                      data-layout-id={item.id}
                    >
                      {!matches(item) && (
                        <p className="wm-result-retained">
                          No longer matches this view · kept here while you read
                        </p>
                      )}
                      {island(item)}
                    </div>
                  ))}
                </section>
              )}
              {browseCount > visible.length && (
                <button
                  className="wm-more"
                  onClick={() => {
                    setSelection(null);
                    setExpandedArea(null);
                    setActiveSession(null);
                    setExpanded(true);
                  }}
                >
                  {hiddenImportant
                    ? `${hiddenImportant} more active or focused areas · `
                    : ""}
                  Show all {browseCount} areas and sessions{" "}
                  <span aria-hidden="true">↗</span>
                </button>
              )}
            </div>
          )}
          <SettledToday
            rows={settled}
            onUndo={(id) => void undoSettlement(id)}
            pending={undoing}
            error={settledError}
          />
          <footer className="wm-footer">
            <span>
              <span className="wm-legend-focus">Coral ring · Focus</span>
              {" · "}
              <span className="wm-legend-working">
                Green bar · Agent working
              </span>
              {" · "}
              <span className="wm-legend-waiting">Amber · Action needed</span>
              {" · "}
              <span className="wm-legend-unread">Blue · Ready to read</span>
              {" · "}
              {spatial
                ? "Quieter work sits farther out."
                : "Ordered by importance and attention."}
            </span>
            <button aria-pressed={rotate} onClick={() => setRotate((r) => !r)}>
              {rotate
                ? zoom !== 1
                  ? "Rotation paused while zoomed"
                  : "Rotation on"
                : "Rotation paused"}
            </button>
          </footer>
        </main>
        {manager.pane || (selected && previewMode === "pane" && details(true))}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "map",
    title: "Work Map",
    icon: "Layers",
    path: "map",
    component: WorkMap,
  });
});
