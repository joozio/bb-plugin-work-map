// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { data, now, task, thread } from "./fixtures";
import { buildMap, localDay } from "./model";
import { buildHeat } from "./heat";
import { HeatMap } from "./heat-view";

const DAY = 86400000;
const due = (days: number) => localDay(now + days * DAY);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function frame(width: number, height: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        // Only the map frame has this size; an open area's action bar is empty.
        const bar = target.classList.contains("wm-heat-actions-frame");
        this.callback(
          [
            {
              target,
              contentRect: bar ? { width, height: 0 } : { width, height },
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
    },
  );
}
function heat(
  tasks: Parameters<typeof data>[0],
  threads: Parameters<typeof buildMap>[1] = [],
  props: Partial<Parameters<typeof HeatMap>[0]> = {},
  open = false,
) {
  const areas = buildHeat(buildMap(data(tasks), threads, {}, now), now);
  if (open) props = { ...props, expandedAreaId: areas[0].id };
  return render(
    <HeatMap
      areas={areas}
      now={now}
      detail={0}
      onOpenArea={() => {}}
      onOpen={() => {}}
      onDragStart={() => {}}
      onDragEnd={() => {}}
      {...props}
    />,
  );
}
const tile = (view: ReturnType<typeof render>, title: string) =>
  view.getByRole("button", { name: new RegExp(`^Preview ${title}`) });

it("renders the whole key on a narrow tile and drops the label instead of cutting it", () => {
  frame(260, 150);
  const view = heat(
    ["DT-11", "DT-12", "DT-13", "DT-14", "DT-15", "DT-16"].map((key, index) =>
      task({
        id: `t${index}`,
        key,
        title: `Draft ${key}`,
        dateKind: "deadline",
        dueDate: due(-47),
      }),
    ),
  );
  const tiles = ["DT-11", "DT-12", "DT-13", "DT-14", "DT-15", "DT-16"].map(
    (key) => tile(view, `Draft ${key}`),
  );
  const keys = tiles.map(
    (entry) => entry.querySelector(".wm-heat-key-text")?.textContent,
  );
  expect(keys).toEqual(["DT-11", "DT-12", "DT-13", "DT-14", "DT-15", "DT-16"]);
  const bare = tiles.filter(
    (entry) =>
      !entry.querySelector(".wm-heat-meta")!.textContent!.includes("overdue"),
  );
  // At this width at least one tile cannot hold "47d overdue" beside its key.
  expect(bare.length).toBeGreaterThan(0);
  for (const entry of bare) {
    expect(entry.getAttribute("aria-label")).toContain("47d overdue");
    expect(entry.getAttribute("title")).toBe("47d overdue");
  }
});

it("keeps the red edge for this fortnight's dates and marks older ones stale", () => {
  frame(1200, 700);
  const view = heat([
    task({
      id: "fresh",
      key: "T-1",
      title: "Fresh",
      dateKind: "deadline",
      dueDate: due(-3),
    }),
    task({
      id: "edge",
      key: "T-2",
      title: "Edge",
      dateKind: "deadline",
      dueDate: due(-14),
    }),
    task({
      id: "old",
      key: "T-3",
      title: "Old",
      dateKind: "deadline",
      dueDate: due(-84),
    }),
  ]);
  for (const title of ["Fresh", "Edge"]) {
    expect(tile(view, title).className).toContain("wm-heat-overdue");
    expect(tile(view, title).className).not.toContain("wm-heat-late");
  }
  const old = tile(view, "Old");
  expect(old.className).toContain("wm-heat-late");
  expect(old.className).not.toContain("wm-heat-overdue");
  expect(old.textContent).toContain("84d overdue");
});

it("shows running whole on a roomy session tile and only the dot on a narrow one", () => {
  const live = [
    thread({ id: "thr_a", title: "Work Map build", indicator: "runtime" }),
  ];
  frame(1200, 700);
  const wide = heat([], live);
  const roomy = tile(wide, "Work Map build");
  expect(roomy.className).toContain("wm-heat-running");
  expect(roomy.querySelector(".wm-heat-key-text")?.textContent).toBe("running");
  wide.unmount();
  frame(64, 700);
  const narrow = heat([], live);
  const slim = tile(narrow, "Work Map build");
  expect(slim.className).toContain("wm-heat-running");
  expect(slim.querySelector(".wm-heat-meta")?.textContent).not.toMatch(/runn/);
});

it("says agent running whole on an open card, beside its green dot", () => {
  frame(1200, 700);
  const view = heat(
    [task({ id: "run", key: "T-9", title: "Busy", threadIds: ["thr_run"] })],
    [thread({ id: "thr_run", indicator: "runtime" })],
    { tileActions: () => <div className="wm-tile-actions" /> },
    true,
  );
  const fact = tile(view, "Busy").querySelector(".wm-heat-run-fact");
  expect(fact?.textContent).toBe("agent running");
});
