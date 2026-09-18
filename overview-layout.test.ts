import { expect, it } from "vitest";
import { buildMap } from "./model";
import { fitOverview } from "./overview-layout";
import { data, task, thread, now } from "./fixtures";
const fixture = () =>
  buildMap(
    {
      ...data(
        Array.from({ length: 24 }, (_, i) =>
          task({ id: `t${i}`, projectId: `p${Math.floor(i / 4)}` }),
        ),
      ),
      projects: Array.from({ length: 6 }, (_, i) => ({
        id: `p${i}`,
        name: `Project ${i}`,
        prefix: `P${i}`,
      })),
    },
    Array.from({ length: 24 }, (_, i) =>
      thread({
        id: `thr_${i}`,
        isPinned: i === 0,
        indicator: i === 1 ? "unread-success" : "none",
      }),
    ),
    {},
    now,
  );
it("fits every root without overlap at short, narrow and large dimensions", () => {
  for (const width of [340, 480, 800, 1280, 1800])
    for (const height of [180, 340, 600, 900])
      for (const zoom of [0.6, 1, 1.6]) {
        const { placements } = fitOverview(fixture(), width, height, zoom);
        const boxes = Object.values(placements);
        for (const a of boxes) {
          expect(a.x).toBeGreaterThanOrEqual(0);
          expect(a.y).toBeGreaterThanOrEqual(0);
          expect(a.x + a.width).toBeLessThanOrEqual(width + 0.01);
          expect(a.y + a.height).toBeLessThanOrEqual(height + 0.01);
          for (const b of boxes.filter((b) => a !== b))
            expect(
              a.x + a.width <= b.x + 0.01 ||
                b.x + b.width <= a.x + 0.01 ||
                a.y + a.height <= b.y + 0.01 ||
                b.y + b.height <= a.y + 0.01,
            ).toBe(true);
        }
      }
});
it("gives larger screens more roots and keeps a rich priority card on small screens", () => {
  const small = fitOverview(fixture(), 480, 340);
  const large = fitOverview(fixture(), 1800, 900);
  expect(Object.keys(large.placements).length).toBeGreaterThan(
    Object.keys(small.placements).length,
  );
  expect(small.orbit.anchor?.id).toBe("thread:thr_0");
  expect(small.placements[small.orbit.anchor!.id].rich).toBe(true);
  expect(
    Object.keys(fitOverview(fixture(), 1800, 900, 0.6).placements).length,
  ).toBeGreaterThan(Object.keys(large.placements).length);
});
it("retains the item being zoomed toward and handles empty work", () => {
  const zoomed = fitOverview(fixture(), 800, 400, 1.6, 0, "thread:thr_20");
  expect(zoomed.orbit.anchor?.id).toBe("thread:thr_0");
  expect(zoomed.placements["thread:thr_20"]).toBeTruthy();
  expect(fitOverview([], 800, 400).placements).toEqual({});
});
