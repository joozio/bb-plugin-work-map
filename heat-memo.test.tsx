// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { buildMap } from "./model";
import { data, now, task } from "./fixtures";
import { useHeatModel } from "./heat-memo";

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
