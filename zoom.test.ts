import { expect, it } from "vitest";
import { buildMap, arrangeMap, selectVisible } from "./model";
import { data, thread, now } from "./fixtures";
import { snapZoom, zoomDensity, zoomVisible, extendOrbit } from "./zoom";

it("retains an anchor without evicting work when the selection has unused capacity", () => {
  const items = buildMap(
    data([]),
    [thread({ id: "anchor" }), thread({ id: "quiet" })],
    {},
    now,
  );
  // A working signal without a live thread can be absent from the selector's buckets.
  const anchor = {
    ...items.find((item) => item.id === "thread:anchor")!,
    signal: "working" as const,
    threads: [],
  };
  const quiet = items.find((item) => item.id === "thread:quiet")!;
  expect(zoomVisible([anchor, quiet], [], 3, 0, anchor.id)).toEqual([
    quiet,
    anchor,
  ]);
  expect(zoomVisible([anchor], [], 3, 0, anchor.id)).toEqual([anchor]);
  expect(zoomVisible([anchor], [], 0, 0, anchor.id)).toEqual([]);
});

it("preserves actual density, adds work as zoom decreases, and reveals detail as it increases", () => {
  expect(zoomDensity(1, 1200)).toMatchObject({
    roots: 13,
    tasks: 4,
    detail: 0,
    lines: 2,
  });
  expect(zoomDensity(1, 800, true)).toMatchObject({ roots: 10, tasks: 6 });
  expect(zoomDensity(0.6, 1200, true)).toMatchObject({
    roots: 32,
    tasks: 17,
    excerpt: 0,
  });
  expect(zoomDensity(1.6, 1200)).toMatchObject({
    roots: 5,
    tasks: 2,
    detail: 1,
    lines: 6,
  });
  expect([0.2, 0.98, 1.02, 2, NaN].map(snapZoom)).toEqual([0.6, 1, 1, 1.6, 1]);
});

it("adds unique roots around the unchanged core and retains the pointer's area when zooming back in", () => {
  const items = buildMap(
    data([]),
    Array.from({ length: 40 }, (_, i) =>
      thread({ id: `t${i}`, isPinned: i === 0 }),
    ),
    {},
    now,
  );
  const baseline = selectVisible(items, 13, 0);
  const more = zoomVisible(items, baseline, 32, 0);
  expect(more).toHaveLength(32);
  expect(new Set(more.map((item) => item.id)).size).toBe(32);
  expect(more.slice(0, 13)).toEqual(baseline);
  const base = arrangeMap(baseline);
  const orbit = extendOrbit(base, more);
  for (const zone of ["anchor", "near", "west", "east"] as const)
    expect(orbit[zone]).toEqual(base[zone]);
  const retained = zoomVisible(items, baseline, 13, 0, more[25].id);
  expect(retained).toHaveLength(13);
  expect(retained).toContain(more[25]);
  const reset = extendOrbit(base, retained);
  const all = [
    reset.anchor,
    ...reset.near,
    ...reset.west,
    ...reset.east,
    ...reset.north,
    ...reset.south,
  ];
  expect(all).toHaveLength(13);
  expect(all).toContain(more[25]);
});

it("keeps attention at the center when running agents precede it in the baseline", () => {
  const items = buildMap(
    data([]),
    [
      ...Array.from({ length: 6 }, (_, i) =>
        thread({ id: `running${i}`, indicator: "runtime" }),
      ),
      thread({ id: "waiting", indicator: "unread-success" }),
    ],
    {},
    now,
  );
  const base = selectVisible(items, 13, 0);
  const visible = zoomVisible(items, base, zoomDensity(1.6, 1200).roots, 0);
  const orbit = extendOrbit(arrangeMap(base), visible);
  expect(visible).toHaveLength(5);
  expect(orbit.anchor?.id).toBe("thread:waiting");
});
