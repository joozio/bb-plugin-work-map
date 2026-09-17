import type { WorkItem } from "./model";
import { arrangeMap, selectVisible } from "./model";

export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 1.6;
export function snapZoom(value: number) {
  if (!Number.isFinite(value)) return 1;
  const bounded = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
  return Math.abs(bounded - 1) < 0.045 ? 1 : Math.round(bounded * 100) / 100;
}
export function zoomDensity(zoom: number, width: number, focused = false) {
  const detail = Math.max(0, Math.min(1, (zoom - 1) / 0.6));
  return {
    roots: Math.min(32, Math.round((width >= 1100 ? 13 : 10) / zoom ** 2)),
    tasks: Math.max(2, Math.min(18, Math.round((focused ? 6 : 4) / zoom ** 2))),
    detail,
    excerpt: Math.max(0, Math.min(1, (zoom - 0.7) / 0.3)),
    lines: 2 + Math.floor(detail * 4),
  };
}
export function zoomVisible(
  items: WorkItem[],
  base: WorkItem[],
  limit: number,
  rotation: number,
  anchorId?: string,
) {
  // Zooming out adds work without evicting something already on screen.
  const ids = new Set(base.map((item) => item.id));
  const starting =
    limit < base.length
      ? [...base].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      : base;
  const visible = [
    ...starting,
    ...selectVisible(items, limit, rotation).filter(
      (item) => !ids.has(item.id),
    ),
  ].slice(0, limit);
  const anchor = items.find((item) => item.id === anchorId);
  if (anchor && limit > 0 && !visible.some((item) => item.id === anchor.id)) {
    if (visible.length < limit) visible.push(anchor);
    else visible[visible.length - 1] = anchor;
  }
  return visible;
}
export function extendOrbit(
  base: ReturnType<typeof arrangeMap>,
  items: WorkItem[],
) {
  const visible = new Set(items.map((item) => item.id));
  base = {
    ...base,
    anchor:
      base.anchor && visible.has(base.anchor.id) ? base.anchor : undefined,
    near: base.near.filter((item) => visible.has(item.id)),
    north: base.north.filter((item) => visible.has(item.id)),
    south: base.south.filter((item) => visible.has(item.id)),
    west: base.west.filter((item) => visible.has(item.id)),
    east: base.east.filter((item) => visible.has(item.id)),
  };
  const ids = new Set(
    [
      base.anchor,
      ...base.near,
      ...base.west,
      ...base.east,
      ...base.north,
      ...base.south,
    ]
      .filter(Boolean)
      .map((item) => item!.id),
  );
  const extras = items.filter((item) => !ids.has(item.id));
  const ready = extras.filter((item) => item.unreadResults > 0);
  const outer = extras.filter((item) => !item.unreadResults);
  return {
    ...base,
    west: [...base.west, ...ready.filter((_, index) => index % 2 === 0)],
    east: [...base.east, ...ready.filter((_, index) => index % 2 === 1)],
    north: [...base.north, ...outer.filter((_, index) => index % 2 === 0)],
    south: [...base.south, ...outer.filter((_, index) => index % 2 === 1)],
  };
}
