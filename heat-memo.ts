import { useRef } from "react";
import type { WorkItem } from "./model";
import { buildHeat, type HeatArea } from "./heat";

type Built = {
  roots: readonly WorkItem[];
  now: number;
  uncollapsed: string;
  keepQuiet: number | undefined;
  areas: HeatArea[];
};
/**
 * Heat's model, rebuilt only when what it reads changes. The app hands over a
 * fresh roots array on every render, so the array's identity says nothing;
 * each root's identity does, because the map builds its items once per
 * snapshot, preference change or clock tick. A stable result is what lets the
 * treemap's own memo skip its layout work.
 */
export function useHeatModel(
  roots: readonly WorkItem[],
  now: number,
  uncollapsed: readonly string[],
  keepQuiet?: number,
): HeatArea[] {
  const last = useRef<Built | null>(null);
  const key = uncollapsed.join(",");
  const previous = last.current;
  if (
    previous &&
    previous.now === now &&
    previous.uncollapsed === key &&
    previous.keepQuiet === keepQuiet &&
    previous.roots.length === roots.length &&
    previous.roots.every((root, index) => root === roots[index])
  )
    return previous.areas;
  const areas = buildHeat(roots, now, { uncollapsed, keepQuiet });
  last.current = { roots, now, uncollapsed: key, keepQuiet, areas };
  return areas;
}
