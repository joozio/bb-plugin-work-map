import { useRef } from "react";
import type { WorkItem } from "./model";
import { buildHeat, type HeatArea } from "./heat";

type Built = {
  roots: readonly WorkItem[];
  now: number;
  uncollapsed: string;
  keepQuiet: number | undefined;
  hold: string | undefined;
  areas: HeatArea[];
};
function sameIds(a: readonly { id: string }[], b: readonly { id: string }[]) {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((row) => row.id));
  return b.every((row) => ids.has(row.id));
}
/**
 * The same map with the weights it had when it was held. The treemap places
 * areas and tiles from their ids and weights alone, so held weights keep every
 * rectangle and the order inside the open area where the reader left them,
 * while each tile still carries its current facts: tone, timing, title, acts.
 * A change in who is on the map cannot be held, and returns null.
 */
export function holdLayout(
  held: readonly HeatArea[],
  next: readonly HeatArea[],
): HeatArea[] | null {
  if (!sameIds(held, next)) return null;
  const current = new Map(next.map((area) => [area.id, area]));
  const areas: HeatArea[] = [];
  for (const before of held) {
    const area = current.get(before.id)!;
    if (!sameIds(before.tiles, area.tiles)) return null;
    const tiles = new Map(area.tiles.map((tile) => [tile.id, tile]));
    areas.push({
      ...area,
      weight: before.weight,
      tiles: before.tiles.map((tile) => ({
        ...tiles.get(tile.id)!,
        weight: tile.weight,
      })),
    });
  }
  return areas;
}
/**
 * Heat's model, rebuilt only when what it reads changes. The app hands over a
 * fresh roots array on every render, so the array's identity says nothing;
 * each root's identity does, because the map builds its items once per
 * snapshot, preference change or clock tick. A stable result is what lets the
 * treemap's own memo skip its layout work.
 *
 * `hold` names the open area. While it stays open the layout is held (see
 * holdLayout); closing it, or a change in membership, lays the map out again.
 */
export function useHeatModel(
  roots: readonly WorkItem[],
  now: number,
  uncollapsed: readonly string[],
  hold?: string,
  keepQuiet?: number,
): HeatArea[] {
  const last = useRef<Built | null>(null);
  const held = useRef<{ id: string; areas: HeatArea[] } | null>(null);
  const key = uncollapsed.join(",");
  const previous = last.current;
  if (
    previous &&
    previous.now === now &&
    previous.uncollapsed === key &&
    previous.keepQuiet === keepQuiet &&
    previous.hold === hold &&
    previous.roots.length === roots.length &&
    previous.roots.every((root, index) => root === roots[index])
  )
    return previous.areas;
  const built = buildHeat(roots, now, { uncollapsed, keepQuiet });
  let areas = built;
  if (!hold) held.current = null;
  else {
    const kept =
      held.current?.id === hold ? holdLayout(held.current.areas, built) : null;
    if (kept) areas = kept;
    else held.current = { id: hold, areas: built };
  }
  last.current = { roots, now, uncollapsed: key, keepQuiet, hold, areas };
  return areas;
}
