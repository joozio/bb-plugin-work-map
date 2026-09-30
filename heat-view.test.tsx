// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
      onOpenArea={() => {}}
      onOpen={() => {}}
      onDragStart={() => {}}
      onDragEnd={() => {}}
      {...props}
    />,
  );
}
const tile = (view: ReturnType<typeof render>, title: string) =>
  view.getByRole("button", { name: new RegExp(`^Preview ${title}\\.`) });

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
  frame(76, 700);
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

it("budgets a card's rows from the measured act row, not an assumed one", () => {
  const budget = (actRow: number) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          const row = target.classList.contains("wm-tile-actions");
          const bar = target.classList.contains("wm-heat-actions-frame");
          this.callback(
            [
              {
                target,
                contentRect: { width: 300, height: bar ? 0 : 200 },
                borderBoxSize: row
                  ? [{ blockSize: actRow, inlineSize: 300 }]
                  : [],
              } as unknown as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }
        disconnect() {}
      },
    );
    const view = heat(
      [task({ id: "card", key: "T-5", title: "Card", priority: "high" })],
      [],
      { tileActions: () => <div className="wm-tile-actions" /> },
      true,
    );
    const slot = tile(view, "Card").parentElement!;
    const rows = [
      slot.style.getPropertyValue("--wm-heat-lines"),
      slot.style.getPropertyValue("--wm-heat-line-rows"),
    ];
    view.unmount();
    return rows;
  };
  // A desktop act row leaves room for the latest word; a phone-sized one
  // takes that room back instead of pushing rows out of the card.
  expect(budget(31)).toEqual(["4", "2"]);
  expect(budget(90)).toEqual(["3", "0"]);
});

it("gives card acts, bulk acts and picker rows 24px, and 36px under 720px", () => {
  const css = readFileSync(join(__dirname, "app.css"), "utf8");
  const rule = (selector: string, from = 0) => {
    const at = css.indexOf(`${selector} {`, from);
    expect(at).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };
  expect(rule(".wm-tile-action")).toContain("min-height: 24px");
  expect(rule(".wm-tile-action")).not.toMatch(/\bheight: 20px/);
  expect(rule(".wm-bulk-row > button")).toContain("min-height: 24px");
  expect(rule(".wm-bulk-pick")).toContain("min-height: 24px");
  const phone = css.lastIndexOf("@media (max-width: 720px)");
  expect(
    rule(".wm-tile-action,\n  .wm-bulk-row > button,\n  .wm-bulk-pick", phone),
  ).toContain("min-height: 36px");
});

it("draws no titleless tile in a small area: the unreadable ones fold into a named +N more", () => {
  frame(320, 170);
  const keys = Array.from({ length: 14 }, (_, index) => `DT-${index + 1}`);
  const view = heat(
    keys.map((key, index) =>
      task({
        id: `t${index}`,
        key,
        title: `Draft ${key}`,
        status: "in_review",
        dateKind: "deadline",
        dueDate: due(index - 7),
      }),
    ),
  );
  const tiles = Array.from(
    view.container.querySelectorAll<HTMLElement>(".wm-heat-tile"),
  );
  const more = tiles.filter((tile) => tile.classList.contains("wm-heat-more"));
  expect(more).toHaveLength(1);
  const drawn = tiles.filter(
    (tile) => !tile.classList.contains("wm-heat-group"),
  );
  // Every drawn task tile has its key and a title line.
  for (const tile of drawn) {
    expect(tile.querySelector(".wm-heat-title")).not.toBeNull();
    expect(tile.querySelector(".wm-heat-key-text")?.textContent).toMatch(
      /^DT-\d+$/,
    );
  }
  const folded = Number(/\+(\d+) more/.exec(more[0].textContent!)![1]);
  expect(folded).toBeGreaterThan(0);
  expect(drawn.length + folded).toBe(keys.length);
  // Named, not blank: the tooltip lists the keys it holds.
  expect(more[0].getAttribute("title")!.split(", ")).toHaveLength(folded);
});

it("keeps open-area cards readable and scrolls the area body when they do not fit", () => {
  frame(420, 260);
  const keys = Array.from({ length: 12 }, (_, index) => `DT-${index + 1}`);
  const view = heat(
    keys.map((key, index) =>
      task({
        id: `t${index}`,
        key,
        title: `Draft ${key}`,
        status: "in_review",
      }),
    ),
    [],
    { tileActions: () => <div className="wm-tile-actions" /> },
    true,
  );
  const body = view.container.querySelector(
    ".wm-heat-area-open .wm-heat-body",
  )!;
  expect(body.classList).toContain("wm-heat-body-scroll");
  const cards = body.querySelector<HTMLElement>(".wm-heat-cards")!;
  const height = parseFloat(cards.style.height);
  expect(height).toBeGreaterThan(260);
  for (const key of keys) {
    const slot = tile(view, `Draft ${key}`).parentElement!;
    // Two title lines plus the act row, never less.
    expect(
      (parseFloat(slot.style.height) / 100) * height,
    ).toBeGreaterThanOrEqual(4 + 12 + 14.35 + 31 + 2 * 14.03 - 0.01);
    expect(
      tile(view, `Draft ${key}`).querySelector(".wm-heat-title"),
    ).not.toBeNull();
  }
});
