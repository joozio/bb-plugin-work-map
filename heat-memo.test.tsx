// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { buildMap } from "./model";
import { data, now, task } from "./fixtures";
import { holdLayout, useHeatModel } from "./heat-memo";
import type { HeatArea, HeatTile } from "./heat";

describe("the memoised Heat model", () => {
  const roots = buildMap(
    data([task(), task({ id: "task2", key: "TEST-2" })]),
    [],
    {},
    now,
  );
  it("gives the same array for the same inputs, even in a fresh roots array", () => {
    const view = renderHook(
      ({ list, at, open }) => useHeatModel(list, at, open),
      { initialProps: { list: [...roots], at: now, open: [] as string[] } },
    );
    const first = view.result.current;
    expect(first.length).toBeGreaterThan(0);
    view.rerender({ list: [...roots], at: now, open: [] });
    expect(view.result.current).toBe(first);
  });
  it("rebuilds when a root, the clock or the uncollapsed set changes", () => {
    const view = renderHook(
      ({ list, at, open }) => useHeatModel(list, at, open),
      { initialProps: { list: [...roots], at: now, open: [] as string[] } },
    );
    const first = view.result.current;
    view.rerender({ list: [...roots], at: now + 60_000, open: [] });
    const ticked = view.result.current;
    expect(ticked).not.toBe(first);
    view.rerender({ list: [...roots], at: now + 60_000, open: [roots[0].id] });
    const opened = view.result.current;
    expect(opened).not.toBe(ticked);
    view.rerender({
      list: [{ ...roots[0] }],
      at: now + 60_000,
      open: [roots[0].id],
    });
    expect(view.result.current).not.toBe(opened);
  });
});

describe("the layout held while an area is open", () => {
  const snapshot = (priority: "medium" | "urgent", extra = false) =>
    buildMap(
      data([
        task({ id: "a", key: "TEST-1", title: "First" }),
        task({
          id: "b",
          key: "TEST-2",
          title: "Second",
          priority,
          dueDate: priority === "urgent" ? "2026-09-17" : null,
          dateKind: "deadline",
        }),
        ...(extra ? [task({ id: "c", key: "TEST-3", title: "Third" })] : []),
      ]),
      [],
      {},
      now,
    );
  const weights = (areas: ReturnType<typeof useHeatModel>) =>
    areas.flatMap((area) => [
      [area.id, area.weight],
      ...area.tiles.map((tile) => [tile.id, tile.weight]),
    ]);
  it("keeps weights and order while facts change, and lets go on close or a new member", () => {
    const calm = snapshot("medium");
    const open = calm[0].id;
    const view = renderHook(
      ({ list, hold }) => useHeatModel(list, now, [open], hold),
      { initialProps: { list: calm, hold: open as string | undefined } },
    );
    const before = weights(view.result.current);
    const hot = snapshot("urgent");
    view.rerender({ list: hot, hold: open });
    const held = view.result.current;
    expect(weights(held)).toEqual(before);
    const second = held[0].tiles.find((tile) => tile.id === "task:b")!;
    // The facts are today's: the tile knows it is urgent and due today.
    expect(second.item?.task?.priority).toBe("urgent");
    expect(second.timing?.label).toBe("Due today");
    // Closing lets the new ranking take effect.
    view.rerender({ list: hot, hold: undefined });
    expect(weights(view.result.current)).not.toEqual(before);
    // Reopened, a new task joining the area cannot be held.
    view.rerender({ list: hot, hold: open });
    const reheld = weights(view.result.current);
    view.rerender({ list: snapshot("urgent", true), hold: open });
    expect(view.result.current[0].tiles).toHaveLength(3);
    expect(weights(view.result.current)).not.toEqual(reheld);
  });
});
describe("holding a laid-out map", () => {
  const tile = (id: string, weight: number, stale = 0) =>
    ({ id, weight, stale }) as HeatTile;
  const area = (id: string, weight: number, tiles: HeatTile[], title = id) =>
    ({ id, weight, title, tiles }) as HeatArea;

  it("keeps the held weights and order while every tile carries today's facts", () => {
    const held = [
      area("a", 3, [tile("t1", 2), tile("t2", 1)]),
      area("b", 1, [tile("t3", 1)]),
    ];
    const next = [
      area("b", 9, [tile("t3", 5, 4)], "B renamed"),
      area("a", 1, [tile("t2", 8, 7), tile("t1", 1)]),
    ];
    const kept = holdLayout(held, next)!;
    expect(kept.map((row) => [row.id, row.weight, row.title])).toEqual([
      ["a", 3, "a"],
      ["b", 1, "B renamed"],
    ]);
    expect(
      kept[0].tiles.map((row) => [row.id, row.weight, row.stale]),
    ).toEqual([
      ["t1", 2, 0],
      ["t2", 1, 7],
    ]);
  });

  it("cannot hold a map whose areas changed, by count or by id", () => {
    const held = [area("a", 1, []), area("b", 1, [])];
    expect(holdLayout(held, [area("a", 1, [])])).toBeNull();
    expect(holdLayout(held, [area("a", 1, []), area("c", 1, [])])).toBeNull();
  });

  it("cannot hold an area whose tiles were swapped for others", () => {
    expect(
      holdLayout([area("a", 1, [tile("t1", 1)])], [area("a", 1, [tile("t9", 1)])]),
    ).toBeNull();
  });
});
