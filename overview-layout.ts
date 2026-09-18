import {
  arrangeMap,
  isWorking,
  needsReview,
  selectVisible,
  type WorkItem,
} from "./model";

export type CardPlacement = {
  x: number;
  y: number;
  width: number;
  height: number;
  rich: boolean;
  tasks: number;
};
export function fitOverview(
  items: WorkItem[],
  width: number,
  height: number,
  zoom = 1,
  rotation = 0,
  anchorId?: string,
) {
  if (width <= 0 || height < 130)
    return {
      orbit: {
        anchor: undefined,
        near: [],
        west: [],
        east: [],
        north: [],
        south: [],
      } as ReturnType<typeof arrangeMap>,
      placements: {} as Record<string, CardPlacement>,
    };
  const gap = width < 700 ? 10 : 16;
  const compact = zoom <= 0.8;
  const narrow = width < 700;
  const single = width < 420;
  const columns = !narrow && compact && width >= 1400 ? 2 : 1;
  const sideWidth = narrow
    ? (width - (single ? 0 : gap)) / (single ? 1 : 2)
    : (width - gap * 2) / 3.3;
  const coreWidth = narrow ? width : width - (sideWidth + gap) * 2;
  const coreX = narrow ? 0 : sideWidth + gap;
  const ordered = selectVisible(items, 32, rotation);
  const initial = arrangeMap(ordered);
  const anchor = initial.anchor;
  const orbit: ReturnType<typeof arrangeMap> = {
    anchor,
    near: [],
    west: [],
    east: [],
    north: [],
    south: [],
  };
  const placements: Record<string, CardPlacement> = {};
  if (!anchor) return { orbit, placements };
  const preferred = (item: WorkItem, rich: boolean) => {
    const base = rich
      ? item.kind === "project"
        ? 350
        : 300
      : item.kind === "project"
        ? 248
        : item.kind === "task"
          ? 186
          : 158;
    if (compact && !rich && item.kind === "project") return 225;
    return Math.round(
      base * (compact ? 0.8 : zoom > 1 ? 1 + (zoom - 1) * 0.4 : 1),
    );
  };
  const put = (
    item: WorkItem,
    x: number,
    y: number,
    w: number,
    h: number,
    rich: boolean,
  ) => {
    // Budget the heading separately from task rows. Mixed attention needs
    // room for its independent badges; it must not overflow a smaller tile.
    const taskHeight = Math.max(
      80,
      ...item.children.map(
        (child) =>
          80 +
          16 * Number(needsReview(child) && child.attention !== "review") +
          16 * Number(child.unreadResults > 0 && child.signal !== "unread") +
          16 * Number(isWorking(child) && child.signal !== "working"),
      ),
    );
    const headingHeight = rich ? (w >= 500 ? 170 : 210) : compact ? 100 : 135;
    const taskColumns = w >= 350 ? 2 : 1;
    const tasks = Math.max(
      0,
      Math.min(
        rich ? 4 : 2,
        Math.floor((h - headingHeight) / taskHeight) * taskColumns,
      ),
    );
    if (item.kind === "project" && !rich && !item.focus && tasks === 0)
      h = Math.min(h, 175);
    placements[item.id] = {
      x,
      y,
      width: w,
      height: h,
      rich,
      tasks,
    };
    return h;
  };
  const anchorBudget =
    narrow && height >= 350 ? Math.max(210, height * 0.55) : height - 22;
  const anchorHeight = Math.max(
    0,
    Math.min(preferred(anchor, true), height - 22, anchorBudget),
  );
  put(anchor, coreX, 22, coreWidth, anchorHeight, true);
  let coreUsed = anchorHeight + 22;
  const zoomTarget = items.find((item) => item.id === anchorId);
  const rest = [
    ...(zoomTarget ? [zoomTarget] : []),
    ...initial.near,
    ...ordered,
  ].filter(
    (item, i, list) =>
      item.id !== anchor.id &&
      list.findIndex((other) => other.id === item.id) === i,
  );
  if (!narrow) {
    for (const item of rest.slice(0, 2)) {
      const available = height - coreUsed - gap;
      if (available < 180) break;
      const h = Math.min(preferred(item, true), available);
      put(item, coreX, coreUsed + gap, coreWidth, h, true);
      orbit.near.push(item);
      coreUsed += gap + h;
    }
    const shift = Math.max(0, (height - coreUsed) / 2);
    for (const item of [anchor, ...orbit.near]) placements[item.id].y += shift;
  }
  const sideTop = narrow ? coreUsed + gap : 0;
  const sideHeight = Math.max(0, height - sideTop);
  const lanes = Array.from(
    { length: narrow && single ? 1 : columns * 2 },
    (_, i) => ({ used: 0, index: i }),
  );
  const laneWidth = (sideWidth - gap * (columns - 1)) / columns;
  for (const item of rest.filter((item) => !placements[item.id])) {
    const lane = [...lanes].sort(
      (a, b) => a.used - b.used || a.index - b.index,
    )[0];
    const available = sideHeight - lane.used;
    const min = item.focus ? 190 : item.kind === "project" ? 150 : 112;
    if (available < min) continue;
    const rich = item.focus && available >= 220;
    const h = Math.min(preferred(item, rich), available);
    const west = lane.index < columns;
    const offset = west
      ? 0
      : narrow
        ? sideWidth + gap
        : sideWidth + coreWidth + gap * 2;
    const placedHeight = put(
      item,
      offset + (lane.index % columns) * (laneWidth + gap),
      sideTop + lane.used,
      laneWidth,
      h,
      rich,
    );
    (west ? orbit.west : orbit.east).push(item);
    lane.used += placedHeight + gap;
  }
  return { orbit, placements };
}
