// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { data, now, task, thread } from "./fixtures";
import { buildMap, localDay } from "./model";
import { buildHeat, type HeatTile, type Tier } from "./heat";
import {
  HeatMap,
  fitToWords,
  foldHead,
  groupRows,
  neededHeight,
} from "./heat-view";

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
  frame(480, 90);
  const view = heat(
    ["DT-11", "DT-12", "DT-13", "DT-14", "DT-15", "DT-16"].map((key, index) =>
      task({
        id: `t${index}`,
        key,
        title: `Draft ${key}`,
        status: "in_review",
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
  // A coloured tile says why; a Later tile keeps the plain date.
  const full = (entry: HTMLElement) =>
    entry.dataset.tier === "later" ? "slipped 47d" : "slipped 47d · medium";
  // Whatever shows is one whole form of the label, never a cut one.
  for (const entry of tiles) {
    const shown = entry.querySelector(".wm-heat-meta > span + span")?.textContent;
    if (shown)
      expect(["slipped 47d · medium", "slip 47d · medium", "slipped 47d", "slip 47d"]).toContain(shown);
  }
  const bare = tiles.filter(
    (entry) => !entry.querySelector(".wm-heat-meta")!.textContent!.includes("47d"),
  );
  // At this width at least one tile cannot hold even "slip 47d" beside its key.
  expect(bare.length).toBeGreaterThan(0);
  for (const entry of bare) {
    expect(entry.getAttribute("aria-label")).toContain("slipped 47d");
    expect(entry.getAttribute("title")).toBe(full(entry));
  }
});

it("lets the label and the tier speak for a date: no edge, no hatch, whatever its age", () => {
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
      id: "old",
      key: "T-3",
      title: "Old",
      dateKind: "deadline",
      dueDate: due(-84),
    }),
  ]);
  for (const title of ["Fresh", "Old"]) {
    expect(tile(view, title).className).not.toMatch(/wm-heat-(overdue|stale|aged)/);
    expect(tile(view, title).querySelector(".wm-heat-flag")).toBeNull();
  }
  expect(tile(view, "Fresh").textContent).toContain("3d late · medium");
  // A small Later tile may say its date in the compact form, never cut.
  expect(
    tile(view, "Old").querySelector(".wm-heat-meta > span + span")!.textContent,
  ).toMatch(/^slip(ped)? 84d$/);
  expect(tile(view, "Old").getAttribute("aria-label")).toContain("slipped 84d");
  // The fresh date is current and wears Now; the slipped one is a date to tidy.
  expect(tile(view, "Fresh").dataset.tier).toBe("now");
  expect(tile(view, "Old").dataset.tier).toBe("later");
  expect(tile(view, "Old").dataset.slipped).toBe("true");
  expect(tile(view, "Fresh").dataset.slipped).toBeUndefined();
});

it("keeps a request for your hands and a failed run loud by shape: a glyph ahead of the key", () => {
  frame(1200, 700);
  const view = heat(
    [
      task({ id: "ask", key: "T-1", title: "Ask", threadIds: ["thr_ask"] }),
      task({ id: "fail", key: "T-2", title: "Fail", threadIds: ["thr_fail"] }),
      task({ id: "rev", key: "T-3", title: "Review", status: "in_review" }),
    ],
    [
      thread({ id: "thr_ask", indicator: "waiting-for-input" }),
      thread({ id: "thr_fail", indicator: "unread-error" }),
    ],
  );
  expect(tile(view, "Ask").querySelector(".wm-heat-flag")?.textContent).toBe("!");
  expect(tile(view, "Fail").querySelector(".wm-heat-flag")?.textContent).toBe("✕");
  expect(tile(view, "Review").querySelector(".wm-heat-flag")).toBeNull();
});

it("gives every area its hottest tier: a swatch by the name and the tier on the section", () => {
  frame(1200, 700);
  const view = heat([
    task({ id: "hot", key: "T-1", title: "Hot", priority: "urgent", dateKind: "deadline", dueDate: due(0) }),
    task({ id: "cold", key: "T-2", title: "Cold", priority: "low" }),
  ]);
  const area = view.container.querySelector<HTMLElement>(".wm-heat-area")!;
  expect(area.dataset.tier).toBe("now");
  const swatch = area.querySelector<HTMLElement>(".wm-heat-name .wm-heat-swatch")!;
  expect(swatch.dataset.tier).toBe("now");
  expect(swatch.getAttribute("aria-hidden")).toBe("true");
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
  const budget = (actRow: number, expanded: boolean) => {
    // A wide, low frame: beside an open card the sibling is short enough
    // that the act row decides how many rows it keeps.
    const [width, height] = expanded ? [1000, 200] : [300, 200];
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
                contentRect: { width, height: bar ? 0 : height },
                borderBoxSize: row
                  ? [{ blockSize: actRow, inlineSize: width }]
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
      [
        ...(expanded
          ? [task({ id: "big", key: "T-1", title: "Big", priority: "high" })]
          : []),
        task({ id: "card", key: "T-5", title: "Card", priority: "high" }),
      ],
      [],
      {
        tileActions: () => <div className="wm-tile-actions" />,
        ...(expanded ? { expandedItemId: "task:big" } : {}),
      },
      true,
    );
    const slot = tile(view, "Card").parentElement!;
    const rows = [
      slot.style.getPropertyValue("--wm-heat-lines"),
      slot.style.getPropertyValue("--wm-heat-line-rows"),
    ];
    expect(
      !!view.container.querySelector(".wm-heat-cards.wm-heat-flow"),
    ).toBe(!expanded);
    view.unmount();
    return rows;
  };
  // Beside an open card the squarified cards keep their budget: a desktop act
  // row leaves room for the latest word; a phone-sized one takes that room
  // back instead of pushing rows out of the card.
  expect(budget(31, true)).toEqual(["4", "2"]);
  expect(budget(90, true)).toEqual(["3", "0"]);
  // A card in a flow is as tall as what it says: the act row changes nothing.
  expect(budget(31, false)).toEqual(["3", "0"]);
  expect(budget(90, false)).toEqual(["3", "0"]);
});

it("gives card acts, bulk acts and picker rows 24px, and 36px under 720px", () => {
  const css = readFileSync(join(__dirname, "app.css"), "utf8");
  const rule = (selector: string, from = 0) => {
    const at = css.indexOf(`${selector} {`, from);
    expect(at).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };
  expect(rule(".wm-tile-action")).toContain("min-height: 24px");
  // An icon-only act measured 23px wide: the minimum is square.
  expect(rule(".wm-tile-action")).toContain("min-width: 24px");
  expect(rule(".wm-tile-action")).not.toMatch(/\bheight: 20px/);
  expect(rule(".wm-task-link", css.indexOf("\n.wm-task-link {"))).toContain(
    "min-height: 24px",
  );
  expect(rule(".wm-preview-top > button")).toContain("min-height: 24px");
  expect(rule(".wm-bulk-row > button")).toContain("min-height: 24px");
  expect(rule(".wm-bulk-pick")).toContain("min-height: 24px");
  const phone = css.lastIndexOf("@media (max-width: 720px)");
  expect(
    rule(".wm-tile-action,\n  .wm-bulk-row > button,\n  .wm-bulk-pick", phone),
  ).toContain("min-height: 36px");
  expect(rule(".wm-tile-action", phone)).toContain("min-width: 36px");
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
  const folded = Number(
    /^\+(\d+)/.exec(
      more[0].querySelector(".wm-heat-group-head")!.textContent!,
    )![1],
  );
  expect(folded).toBeGreaterThan(0);
  expect(drawn.length + folded).toBe(keys.length);
  // Named, not blank: the tooltip lists the keys it holds.
  expect(more[0].getAttribute("title")!.split(", ")).toHaveLength(folded);
});

it("keeps open-area cards readable and scrolls the area body when they do not fit", () => {
  const keys = Array.from({ length: 12 }, (_, index) => `DT-${index + 1}`);
  const open = (width: number) => {
    frame(width, 260);
    return heat(
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
  };
  const columns = (view: ReturnType<typeof render>) =>
    Number(
      /^repeat\((\d+), minmax\(0, 1fr\)\)$/.exec(
        view.container.querySelector<HTMLElement>(".wm-heat-cards")!.style
          .gridTemplateColumns,
      )![1],
    );
  const view = open(420);
  const body = view.container.querySelector(
    ".wm-heat-area-open .wm-heat-body",
  )!;
  expect(body.classList).toContain("wm-heat-body-scroll");
  const cards = body.querySelector<HTMLElement>(".wm-heat-cards")!;
  expect(cards.classList).toContain("wm-heat-flow");
  // The flow is as tall as its cards; the body scrolls, nothing sets a height.
  expect(cards.style.height).toBe("");
  // 414px of body holds one 250px card a row, never a card under 150px.
  expect(columns(view)).toBe(1);
  for (const key of keys) {
    const slot = tile(view, `Draft ${key}`).parentElement!;
    expect(slot.style.height).toBe("");
    expect(slot.style.getPropertyValue("--wm-heat-lines")).toBe("3");
    expect(
      tile(view, `Draft ${key}`).querySelector(".wm-heat-title"),
    ).not.toBeNull();
  }
  view.unmount();
  // A wider area flows into as many columns as fit at about 250px each.
  const wide = open(1100);
  expect(columns(wide)).toBe(Math.floor((1100 - 6 + 4) / 254));
  expect(columns(wide)).toBeGreaterThanOrEqual(2);
});

it("keeps the orchestrator and every count on a narrow area header, in short words", () => {
  frame(180, 400);
  const areas = buildHeat(
    buildMap(
      data([task({ id: "o1", key: "T-1", title: "Held" })]),
      [],
      {},
      now,
    ),
    now,
  );
  const mapWith = (orchestrator: (typeof areas)[number]["orchestrator"]) =>
    render(
      <HeatMap
        areas={areas.map((area) => ({ ...area, orchestrator, waiting: 1 }))}
        now={now}
        onOpenArea={() => {}}
        onOpen={() => {}}
        onDragStart={() => {}}
        onDragEnd={() => {}}
      />,
    );
  const held = mapWith({
    threadId: "thr_o",
    title: "Orch",
    running: 2,
    limit: 3,
  });
  const area = held.container.querySelector(".wm-heat-area")!;
  expect(area.classList).toContain("wm-heat-area-tight");
  const line = area.querySelector(".wm-heat-name em")!;
  expect(line.textContent).toBe("1 need · orch 2/3");
  expect(line.classList).toContain("wm-heat-orchestrated");
  // The full state stays in the accessible name.
  expect(area.getAttribute("aria-label")).toContain(
    "1 need you · orchestrator · 2 of 3 running",
  );
  held.unmount();
  // Without an orchestrator the narrow header still shows its counts, short.
  const free = mapWith(null);
  const plain = free.container.querySelector(".wm-heat-name em")!;
  expect(plain.classList).not.toContain("wm-heat-orchestrated");
  expect(plain.textContent).toBe("1 need");
  expect(
    free.container.querySelector(".wm-heat-area")!.getAttribute("aria-label"),
  ).toContain("1 need you");
});

it("keeps every card's width and act tier when the picker opens, scrolling instead", () => {
  const cards = (bar: number) => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          const frame = target.classList.contains("wm-heat-actions-frame");
          this.callback(
            [
              {
                target,
                contentRect: { width: 1100, height: frame ? bar : 640 },
              } as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }
        disconnect() {}
      },
    );
    // The picker is the bar's only transient part; it is all of its height.
    const offset = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains("wm-bulk-transient") ? bar - 6 : 0;
      });
    const view = heat(
      Array.from({ length: 12 }, (_, index) =>
        task({
          id: `t${index}`,
          key: `DT-${index + 1}`,
          title: `Draft DT-${index + 1}`,
          status: "in_review",
        }),
      ),
      [],
      {
        areaActions: () => <div className="wm-bulk-transient" />,
        tileActions: () => <div className="wm-tile-actions" />,
      },
      true,
    );
    const shape = Array.from(
      view.container.querySelectorAll<HTMLElement>(
        ".wm-heat-area-open .wm-heat-slot",
      ),
      (slot) => `${slot.style.width}|${slot.dataset.acts}`,
    );
    const scrolls = !!view.container.querySelector(".wm-heat-body-scroll");
    view.unmount();
    offset.mockRestore();
    return { shape, scrolls };
  };
  const shut = cards(0);
  const picking = cards(220);
  expect(picking.shape).toEqual(shut.shape);
  expect(new Set(shut.shape.map((entry) => entry.split("|")[1]))).not.toContain(
    "icons",
  );
  expect(picking.scrolls).toBe(true);
});

it("leaves no sliver, placeholder or stray glyph on a 390px phone map", () => {
  // The phone map: 390 wide less its padding, stacked bands, scrolling.
  frame(358, 620);
  const day = (days: number) => due(days);
  const projects = [
    { id: "dt", prefix: "DT", name: "Digital Thoughts", n: 12 },
    { id: "wiz", prefix: "WIZ", name: "Wiz", n: 10 },
    { id: "frg", prefix: "FRG", name: "Forge", n: 8 },
    { id: "pm", prefix: "PM", name: "Project Money", n: 3 },
  ];
  const tasks = projects.flatMap((project) =>
    Array.from({ length: project.n }, (_, index) =>
      task({
        id: `${project.id}${index}`,
        projectId: project.id,
        key: `${project.prefix}-${index + 1}`,
        title: `${project.name} task ${index + 1}`,
        status: "in_review",
        dateKind: "deadline",
        dueDate: day(-3 - index * 7),
      }),
    ),
  );
  // Wiz's undated 40-day task: the dashed placeholder on the phone.
  tasks.push(
    task({
      id: "wiz-aged",
      projectId: "wiz",
      key: "WIZ-9",
      title: "Context rightsizing proposal",
      status: "in_review",
      createdAt: new Date(now - 40 * 86400000).toISOString(),
    }),
  );
  const roots = buildMap(
    {
      ...data(tasks),
      projects: projects.map(({ id, prefix, name }) => ({ id, prefix, name })),
    },
    [],
    {},
    now,
  );
  const view = render(
    <HeatMap
      areas={buildHeat(roots, now)}
      now={now}
      onOpenArea={() => {}}
      onOpen={() => {}}
      onDragStart={() => {}}
      onDragEnd={() => {}}
    />,
  );
  const tiles = Array.from(
    view.container.querySelectorAll<HTMLElement>(".wm-heat-tile"),
  );
  expect(tiles.length).toBeGreaterThan(0);
  // Nothing drawn too small for its words: no tiny, no sliver.
  expect(
    view.container.querySelectorAll(".wm-heat-tiny, .wm-heat-sliver"),
  ).toHaveLength(0);
  for (const tile of tiles.filter(
    (entry) => !entry.classList.contains("wm-heat-group"),
  )) {
    expect(tile.querySelector(".wm-heat-title")).not.toBeNull();
    expect(tile.querySelector(".wm-heat-key-text")?.textContent).toMatch(
      /^[A-Z]+-\d+$/,
    );
  }
  // The aged task is either a titled tile or named in its area's +N more.
  const aged = view.queryByRole("button", {
    name: /^Preview Context rightsizing proposal\./,
  });
  const more = Array.from(
    view.container.querySelectorAll(".wm-heat-more"),
    (entry) => entry.getAttribute("title") ?? "",
  );
  expect(
    !!aged?.querySelector(".wm-heat-title") ||
      more.some((names) => names.split(", ").includes("WIZ-9")),
  ).toBe(true);
});

it("shows a closed task as done in an open area even while its orchestrator runs", () => {
  frame(1200, 700);
  const view = heat(
    [
      task({
        id: "d",
        key: "ORCHD-1",
        title: "Closed one",
        status: "done",
        threadIds: ["thr_orch"],
      }),
      task({
        id: "c",
        key: "ORCHD-2",
        title: "Dropped one",
        status: "canceled",
        threadIds: ["thr_orch"],
      }),
      task({
        id: "o",
        key: "ORCHD-3",
        title: "Live one",
        threadIds: ["thr_orch"],
      }),
    ],
    [thread({ id: "thr_orch", indicator: "runtime" })],
    { tileActions: () => <div className="wm-tile-actions" /> },
    true,
  );
  for (const [title, word] of [
    ["Closed one", "done"],
    ["Dropped one", "canceled"],
  ]) {
    const card = tile(view, title);
    expect(card.className).not.toContain("wm-heat-running");
    expect(card.className).toContain("wm-heat-quiet");
    expect(card.querySelector(".wm-heat-run-fact")).toBeNull();
    expect(
      Array.from(
        card.querySelectorAll(".wm-heat-facts em"),
        (e) => e.textContent,
      ),
    ).toContain(word);
    expect(card.textContent).not.toContain("running");
    expect(card.getAttribute("aria-label")).toContain(
      word === "done" ? "Done" : "Canceled",
    );
  }
  // Only the open task is live, and only it counts as running.
  expect(tile(view, "Live one").className).toContain("wm-heat-running");
  expect(
    view.container.querySelector(".wm-heat-area")!.getAttribute("aria-label"),
  ).toContain("1 running");
});

it("lists a group tile's members as rows when it has the room, and never draws it empty", () => {
  frame(260, 150);
  // Twelve drafts in a tiny area: most fold. The fold tile lists what it can.
  const keys = Array.from({ length: 12 }, (_, i) => `DT-${i + 1}`);
  const opened: string[] = [];
  const view = heat(
    keys.map((key, i) =>
      task({ id: `t${i}`, key, title: `Draft ${key}`, dateKind: "deadline", dueDate: due(-40 - i) }),
    ),
    [],
    { onOpen: (item) => opened.push(item.id) },
  );
  const group = view.container.querySelector(".wm-heat-more")!;
  expect(group).not.toBeNull();
  const rows = Array.from(group.querySelectorAll<HTMLElement>(".wm-heat-row"));
  // Either the tile is too short for rows, or it lists members and the rest.
  const bb = group.getBoundingClientRect();
  if (rows.length) {
    const rest = rows.filter((row) => row.classList.contains("wm-heat-row-rest"));
    expect(rows.length - rest.length).toBeGreaterThan(0);
    for (const row of rows.filter((row) => !rest.includes(row))) {
      expect(row.querySelector("b")?.textContent).toMatch(/^DT-\d+$/);
      expect(row.querySelector(".wm-heat-row-dot")).not.toBeNull();
    }
    fireEvent.click(rows[0]);
    expect(opened).toHaveLength(1);
  }
  void bb;
});

it("fits as many member rows as the tile's height allows, keeping one for the remainder", () => {
  expect(groupRows(40, 12)).toBe(0);
  expect(groupRows(66, 12)).toBe(2);
  expect(groupRows(100, 12)).toBe(3);
  expect(groupRows(400, 12)).toBe(12);
  expect(groupRows(400, 3)).toBe(3);
});

it("never lets a fold hide running sessions as a neutral block, and opens the strongest one", () => {
  // Twelve finished sessions and three running ones.
  const threads = [
    ...Array.from({ length: 12 }, (_, i) =>
      thread({ id: `thr_q${i}`, title: `Finished ${i}`, updatedAt: now - (i + 1) * 3600000 }),
    ),
    ...Array.from({ length: 3 }, (_, i) =>
      thread({ id: `thr_r${i}`, title: `Running ${i}`, indicator: "runtime" }),
    ),
  ];
  const sessions = (width: number, height: number) => {
    frame(width, height);
    const opened: string[] = [];
    const view = heat([], threads, { onOpen: (item) => opened.push(item.id) });
    const area = view.container.querySelector(".wm-heat-area")!;
    return { view, area, opened };
  };
  // Tiny: everything folds, and the fold says how many are running.
  const tiny = sessions(150, 120);
  // The header keeps its running count however narrow it is.
  expect(tiny.area.classList).toContain("wm-heat-area-tight");
  expect(tiny.area.querySelector(".wm-heat-name em")!.textContent).toBe("3 run");
  const more = tiny.area.querySelector<HTMLElement>(".wm-heat-more")!;
  expect(more.classList).toContain("wm-heat-running");
  expect(more.classList).toContain("wm-heat-working");
  expect(more.classList).not.toContain("wm-heat-quiet");
  expect(more.querySelector(".wm-heat-group-head")!.textContent).toMatch(/· 3 run/);
  // The head opens a running session, not whichever came first.
  fireEvent.click(more.querySelector(".wm-heat-group-head")!);
  expect(tiny.opened[0]).toMatch(/thr_r/);
  tiny.view.unmount();
  // A little more room: the quiet ones fold first and the running ones are drawn.
  const small = sessions(260, 170);
  const fold = small.area.querySelector<HTMLElement>(".wm-heat-more")!;
  const running = small.area.querySelectorAll(".wm-heat-tile[data-work-id].wm-heat-running");
  expect(running.length).toBeGreaterThan(0);
  expect(fold.querySelector(".wm-heat-group-head")!.textContent).toBe(
    `+14 more · ${3 - running.length} running`,
  );
  // Drawn tiles are only running ones while one of them is folded.
  expect(
    small.area.querySelectorAll(".wm-heat-tile[data-work-id]:not(.wm-heat-running)"),
  ).toHaveLength(0);
});

it("names a fold by what it hides, in short words when the full ones do not fit", () => {
  const fold = (members: number, waiting: number, running: number) =>
    ({
      id: "more:a",
      weight: 1,
      tone: "quiet",
      item: null,
      members: Array.from({ length: members }, (_, i) => ({ id: `m${i}` })),
      stale: 0,
      waited: 0,
      pull: 0,
      tier: "later",
      reason: "",
      compact: "",
      slipped: false,
      timing: null,
      overflow: true,
      waiting,
      running,
    }) as unknown as Parameters<typeof foldHead>[0];
  expect(foldHead(fold(16, 0, 3), 400)).toBe("+16 more · 3 running");
  expect(foldHead(fold(16, 2, 3), 400)).toBe("+16 more · 2 need you · 3 running");
  expect(foldHead(fold(16, 2, 3), 110)).toBe("+16 · 2 need · 3 run");
  expect(foldHead(fold(2, 2, 0), 400)).toBe("+2 need you");
  expect(foldHead(fold(3, 0, 3), 60)).toBe("+3 run");
  expect(foldHead(fold(9, 0, 0), 400)).toBe("+9 more");
});

it("gives every open-area card two whole title lines, with slack for rounding", () => {
  // A 1024 laptop's open area: about 400 by 250 for cards once the bar is one row.
  for (const [width, height] of [
    [406, 300],
    [600, 420],
    [333, 260],
  ]) {
    frame(width, height);
    const keys = Array.from({ length: 14 }, (_, i) => `DT-${i + 1}`);
    const view = heat(
      keys.map((key, i) =>
        task({
          id: `t${i}`,
          key,
          title: `Draft ${key}: a title long enough to need two lines`,
          status: "in_review",
        }),
      ),
      [],
      { tileActions: () => <div className="wm-tile-actions" /> },
      true,
    );
    const cards = Array.from(
      view.container.querySelectorAll<HTMLElement>(
        ".wm-heat-area-open .wm-heat-slot[data-acts]",
      ),
    );
    expect(cards.length).toBe(14);
    for (const card of cards)
      expect(
        Number(card.style.getPropertyValue("--wm-heat-lines")),
      ).toBeGreaterThanOrEqual(2);
    view.unmount();
  }
});

it("says why a Now tile is red in its label row and in its accessible name", () => {
  frame(1200, 700);
  const view = heat([
    task({ id: "soon", key: "T-1", title: "Soon", status: "in_review", priority: "high", dateKind: "deadline", dueDate: due(1) }),
  ]);
  const soon = tile(view, "Soon");
  expect(soon.dataset.tier).toBe("now");
  expect(soon.querySelector(".wm-heat-rank")?.textContent).toBe("1");
  expect(soon.querySelector(".wm-heat-meta > span + span")?.textContent).toBe(
    "due tomorrow · high",
  );
  expect(soon.getAttribute("aria-label")).toContain(
    "Now, 1 of 3: due tomorrow · high",
  );
});

it("falls back to the compact reason, then the compact date, on a narrow Now tile, and never cuts the key", () => {
  const shown = (width: number) => {
    // One area holding one tile: the tile is the frame less the header and padding.
    frame(width, 140);
    const view = heat([
      task({ id: "soon", key: "T-1", title: "Soon", status: "in_review", priority: "high", dateKind: "deadline", dueDate: due(1) }),
    ]);
    const soon = tile(view, "Soon");
    const out = {
      key: soon.querySelector(".wm-heat-key-text")?.textContent,
      label: soon.querySelector(".wm-heat-meta > span + span")?.textContent ?? "",
      title: soon.getAttribute("title"),
      name: soon.getAttribute("aria-label"),
    };
    view.unmount();
    return out;
  };
  expect(shown(400).label).toBe("due tomorrow · high");
  for (const [width, label] of [
    [150, "tmrw · high"],
    [106, "tmrw"],
    [70, ""],
  ] as const) {
    const out = shown(width);
    expect(out.key).toBe("T-1");
    expect(out.label).toBe(label);
    // What the row drops is still on the title and the accessible name.
    expect(out.title).toBe("due tomorrow · high");
    expect(out.name).toContain("Now, 1 of 3: due tomorrow · high");
  }
});

it("gives a Later tile its plain date and no reason, and marks a slipped one", () => {
  frame(1200, 700);
  const view = heat([
    task({ id: "a", key: "T-1", title: "Tomorrow", status: "in_review", priority: "high", dateKind: "deadline", dueDate: due(1) }),
    task({ id: "b", key: "T-2", title: "This week", status: "in_review", dateKind: "deadline", dueDate: due(3) }),
    task({ id: "c", key: "T-3", title: "Slipped", status: "in_review", dateKind: "deadline", dueDate: due(-21) }),
  ]);
  const slipped = tile(view, "Slipped");
  expect(slipped.dataset.tier).toBe("later");
  expect(slipped.dataset.slipped).toBe("true");
  expect(slipped.querySelector(".wm-heat-meta > span + span")?.textContent).toBe(
    "slipped 21d",
  );
  expect(slipped.querySelector(".wm-heat-rank")).toBeNull();
  const name = slipped.getAttribute("aria-label")!;
  expect(name).toContain(". Later.");
  expect(name).not.toMatch(/Now|Next:/);
  expect(tile(view, "This week").dataset.tier).toBe("next");
  expect(tile(view, "This week").getAttribute("aria-label")).toContain(
    "Next: due in 3d",
  );
  expect(tile(view, "This week").dataset.slipped).toBeUndefined();
});

it("puts the date fixes on a slipped tile in tidy mode where they fit: one row, two rows, or none", () => {
  const fixes = (item: { id: string }) => (
    <div className="wm-date-fixes" data-for={item.id} />
  );
  // One area holding one tile: the tile is the frame less 6px across and 37px down.
  const slot = (
    width: number,
    height: number,
    options: { dueDate?: string; tidy?: boolean } = {},
  ) => {
    frame(width + 6, height + 37);
    const tidy = options.tidy ?? true;
    const areas = buildHeat(
      buildMap(
        data([
          task({
            id: "late",
            key: "T-1",
            title: "Late",
            dateKind: "deadline",
            dueDate: options.dueDate ?? due(-21),
          }),
        ]),
        [],
        {},
        now,
      ),
      now,
      { tidy },
    );
    const view = render(
      <HeatMap
        areas={areas}
        now={now}
        onOpenArea={() => {}}
        onOpen={() => {}}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        tidy={tidy}
        dateFixes={fixes}
      />,
    );
    const at = tile(view, "Late").closest<HTMLElement>(".wm-heat-slot")!;
    const out = {
      fixes: at.dataset.fixes,
      footer: !!at.querySelector(".wm-tile-fixes .wm-date-fixes"),
      tidy: view.container.querySelector<HTMLElement>(".wm-heat")!.dataset.tidy,
    };
    view.unmount();
    return out;
  };
  expect(slot(280, 80)).toEqual({ fixes: "row", footer: true, tidy: "true" });
  expect(slot(200, 80)).toEqual({ fixes: undefined, footer: false, tidy: "true" });
  expect(slot(120, 100)).toEqual({ fixes: "grid", footer: true, tidy: "true" });
  expect(slot(80, 50)).toEqual({ fixes: undefined, footer: false, tidy: "true" });
  // A date that has not slipped never gets them, however roomy the tile.
  expect(slot(280, 80, { dueDate: due(-3) })).toEqual({
    fixes: undefined,
    footer: false,
    tidy: "true",
  });
  // Outside tidy mode the prop is ignored and the map is not marked.
  expect(slot(280, 80, { tidy: false })).toEqual({
    fixes: undefined,
    footer: false,
    tidy: undefined,
  });
});

it("puts the ask on a big map tile, with where it came from, and keeps it off a narrow one", () => {
  const map = (width: number, height: number, overrides: Parameters<typeof task>[0]) => {
    frame(width, height);
    const view = heat([task({ id: "w", key: "T-1", title: "Write the post", ...overrides })]);
    const button = tile(view, "Write the post");
    const out = {
      ask: button.querySelector<HTMLElement>(".wm-heat-ask-text"),
      lines: Number(
        button.parentElement!.style.getPropertyValue("--wm-heat-ask-lines"),
      ),
      context: button.querySelector(".wm-heat-context")?.textContent,
    };
    return { view, ...out };
  };
  const asked = map(1400, 800, {
    summary:
      "A long summary of everything the draft went through: three rounds of edits, a new opening, the links checked and the images sized for the post.",
    ask: "Pick the title and post it.",
    askFrom: "comment",
  });
  expect(asked.ask?.textContent).toBe("Pick the title and post it.");
  expect(asked.ask?.dataset.askFrom).toBe("comment");
  expect(asked.lines).toBeGreaterThanOrEqual(1);
  asked.view.unmount();
  // Without an ask of its own the tile says the next step.
  const next = map(1400, 800, { nextAction: "Choose a direction" });
  expect(next.ask?.textContent).toBe("Choose a direction");
  expect(next.ask?.dataset.askFrom).toBeUndefined();
  next.view.unmount();
  // Under 120px wide the words of an ask do not fit: the tile keeps its title.
  const narrow = map(110, 700, { ask: "Pick the title and post it." });
  expect(narrow.ask).toBeNull();
  expect(narrow.lines).toBe(0);
  narrow.view.unmount();
  // One line of context under the ask: the sessions attached.
  const sessions = map(1400, 800, {
    ask: "Pick the title and post it.",
    sessionLinks: [
      { threadId: "thr_a", title: "A", attachedAt: new Date(now).toISOString() },
      { threadId: "thr_b", title: "B", attachedAt: new Date(now).toISOString() },
    ],
  });
  expect(sessions.context).toBe("2 sessions");
  sessions.view.unmount();
});

describe("fitting a tile to its words", () => {
  const workItem = (ask: string, title = "Ship it") =>
    buildMap(
      data([task({ id: "w", title, ask, summary: "", nextAction: "" })]),
      [],
      {},
      now,
    )[0].children[0];
  const tileOf = (
    id: string,
    weight: number,
    tier: Tier,
    ask: string,
  ): HeatTile => ({
    id,
    weight,
    pull: 0,
    tone: "review",
    item: { ...workItem(ask), id },
    members: [],
    stale: 0,
    waited: null,
    tier,
    reason: "",
    compact: "",
    slipped: false,
    timing: null,
  });
  const long =
    "Read the three drafts side by side, pick the one whose opening lands, merge the best examples from the other two into it and send it back for a last pass before Friday.";

  it("needs more height for a longer ask and none for a group tile", () => {
    const short = neededHeight(tileOf("a", 1, "later", "Post it."), 300);
    const longer = neededHeight(tileOf("a", 1, "later", long), 300);
    expect(short).toBeGreaterThan(0);
    expect(longer).toBeGreaterThan(short);
    // Under 120px no ask is drawn, so it costs nothing.
    expect(neededHeight(tileOf("a", 1, "later", long), 100)).toBe(
      neededHeight(tileOf("a", 1, "later", "Post it."), 100),
    );
    expect(neededHeight({ ...tileOf("g", 1, "later", ""), item: null }, 300)).toBe(0);
  });

  it("leaves tiles that already fit their words alone", () => {
    const tiles = [tileOf("a", 1, "later", long), tileOf("b", 0.8, "next", long)];
    const height = neededHeight(tiles[0], 200) + 6;
    const rects = new Map([
      ["a", { x: 0, y: 0, w: 50, h: 100 }],
      ["b", { x: 50, y: 0, w: 50, h: 100 }],
    ]);
    expect(fitToWords(tiles, rects, { w: 400, h: height })).toBeNull();
  });

  it("shrinks a tall tile to its words, never under half its original weight", () => {
    const tall = [tileOf("a", 1, "later", "Post.")];
    const rects = new Map([["a", { x: 0, y: 0, w: 100, h: 100 }]]);
    const size = { w: 200, h: 2000 };
    expect(fitToWords(tall, rects, size)![0].weight).toBe(0.5);
    // Half of the weight before any fitting, not of the current one.
    expect(fitToWords(tall, rects, size, new Map([["a", 0.8]]))![0].weight).toBe(0.4);
  });

  it("keeps a Now tile at least 1.1 times the heaviest other tile of its area", () => {
    const tiles = [tileOf("now", 1, "now", "Post."), tileOf("later", 0.8, "later", long)];
    const rects = new Map([
      ["now", { x: 0, y: 0, w: 50, h: 100 }],
      ["later", { x: 50, y: 0, w: 50, h: 100 }],
    ]);
    // 150px tall: the Later tile's long ask fills it; the Now tile's one word does not.
    const fitted = fitToWords(tiles, rects, { w: 400, h: 150 })!;
    const by = new Map(fitted.map((t) => [t.id, t.weight]));
    expect(by.get("later")).toBe(0.8);
    expect(by.get("now")!).toBeLessThan(1);
    expect(by.get("now")!).toBeCloseTo(0.8 * 1.1, 4);
  });
});

it("orders an open area's cards by priority, heavier first, closed last, under one label per priority", () => {
  frame(1200, 700);
  const tasks = [
    task({ id: "m1", key: "T-1", title: "Medium due", priority: "medium", status: "in_review", dateKind: "deadline", dueDate: due(1) }),
    task({ id: "h", key: "T-2", title: "High", priority: "high" }),
    task({ id: "l", key: "T-3", title: "Low", priority: "low" }),
    task({ id: "u", key: "T-4", title: "Urgent", priority: "urgent" }),
    task({ id: "m2", key: "T-5", title: "Medium plain", priority: "medium" }),
    // A closed task stays on the map while its result is unread.
    task({ id: "d", key: "T-6", title: "Done", priority: "urgent", status: "done", threadIds: ["thr_done"] }),
  ];
  const threads = [thread({ id: "thr_done", indicator: "unread-success", isUnread: true })];
  const open = (list: typeof tasks) => {
    const areas = buildHeat(buildMap(data(list), threads, {}, now), now, {
      uncollapsed: ["project:p1"],
    });
    return render(
      <HeatMap
        areas={areas}
        expandedAreaId="project:p1"
        now={now}
        onOpenArea={() => {}}
        onOpen={() => {}}
        onDragStart={() => {}}
        onDragEnd={() => {}}
        tileActions={() => <div className="wm-tile-actions" />}
      />,
    );
  };
  const view = open(tasks);
  const flow = view.container.querySelector<HTMLElement>(".wm-heat-flow")!;
  expect(
    Array.from(flow.querySelectorAll(".wm-heat-key-text"), (e) => e.textContent),
  ).toEqual(["T-4", "T-2", "T-1", "T-5", "T-3", "T-6"]);
  expect(
    view.getAllByRole("heading", { level: 4 }).map((e) => e.textContent),
  ).toEqual(["Urgent", "High", "Medium", "Low / none", "Closed"]);
  // Each label sits right before the first card of its run.
  const children = Array.from(flow.children);
  for (const [label, key] of [
    ["Urgent", "T-4"],
    ["High", "T-2"],
    ["Medium", "T-1"],
    ["Low / none", "T-3"],
    ["Closed", "T-6"],
  ]) {
    const at = children.findIndex((e) => e.textContent === label);
    expect(children[at + 1].querySelector(".wm-heat-key-text")?.textContent).toBe(key);
  }
  view.unmount();
  // One priority throughout: nothing to scan by, so no labels.
  const plain = open(tasks.map((t) => ({ ...t, priority: "medium", status: "todo" })));
  expect(plain.container.querySelector(".wm-heat-flow")).not.toBeNull();
  expect(plain.container.querySelector(".wm-heat-group-label")).toBeNull();
});

it("shows a card's acts on hover and focus by CSS only, keeps them in the tree, and never hides date fixes", () => {
  const css = readFileSync(join(__dirname, "app.css"), "utf8");
  // The whole @media block from `at`, by matching braces.
  const block = (at: number) => {
    let depth = 0;
    for (let i = css.indexOf("{", at); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) return css.slice(at, i + 1);
    }
    return "";
  };
  const media = (query: string) => {
    const out: string[] = [];
    for (let at = css.indexOf(query); at >= 0; at = css.indexOf(query, at + 1))
      out.push(block(at));
    return out;
  };
  const rule = (text: string, selector: string) => {
    const at = text.indexOf(`${selector} {`);
    expect(at).toBeGreaterThanOrEqual(0);
    return text.slice(at, text.indexOf("}", at));
  };
  const card = ".wm-heat-flow .wm-heat-slot:not(.wm-heat-slot-open)";
  const hover = media("@media (hover: hover)").find((text) =>
    text.includes(`${card} > .wm-tile-acts:not(.wm-tile-fixes) {`),
  )!;
  expect(hover).toBeDefined();
  const hidden = rule(hover, `${card} > .wm-tile-acts:not(.wm-tile-fixes)`);
  expect(hidden).toContain("opacity: 0");
  expect(hidden).toContain("pointer-events: none");
  const shown = rule(
    hover,
    `${card}:hover > .wm-tile-acts,\n  ${card}:focus-within > .wm-tile-acts`,
  );
  expect(shown).toContain("opacity: 1");
  expect(shown).toContain("pointer-events: auto");
  const touch = media("@media (hover: none)").find((text) =>
    text.includes(`${card} > .wm-tile-acts {`),
  )!;
  const kept = rule(touch, `${card} > .wm-tile-acts`);
  expect(kept).toContain("position: static");
  expect(kept).toContain("opacity: 1");

  // In the tree: every card in the flow has its three act buttons, so Tab
  // reaches them, and in tidy mode a slipped card wears its date fixes,
  // which the hover rule above never matches.
  frame(1200, 700);
  const tasks = [
    task({ id: "late", key: "T-1", title: "Late", dateKind: "deadline", dueDate: due(-21) }),
    task({ id: "fine", key: "T-2", title: "Fine", status: "in_review" }),
  ];
  const areas = buildHeat(buildMap(data(tasks), [], {}, now), now, { tidy: true });
  const view = render(
    <HeatMap
      areas={areas}
      expandedAreaId={areas[0].id}
      now={now}
      onOpenArea={() => {}}
      onOpen={() => {}}
      onDragStart={() => {}}
      onDragEnd={() => {}}
      tidy
      dateFixes={(item) => <div className="wm-date-fixes" data-for={item.id} />}
      tileActions={(item) => (
        <div className="wm-tile-acts">
          <div className="wm-tile-actions">
            {["Agent decides", "Snooze", "Done"].map((name) => (
              <button key={name} type="button">{`${name} · ${item.title}`}</button>
            ))}
          </div>
        </div>
      )}
    />,
  );
  expect(view.container.querySelector(".wm-heat-flow")).not.toBeNull();
  const fine = tile(view, "Fine").parentElement!;
  expect(fine.querySelectorAll(".wm-tile-acts:not(.wm-tile-fixes) button")).toHaveLength(3);
  const late = tile(view, "Late").parentElement!;
  expect(late.querySelector(":scope > .wm-tile-acts.wm-tile-fixes .wm-date-fixes")).not.toBeNull();
  expect(late.querySelector(":scope > .wm-tile-acts:not(.wm-tile-fixes)")).toBeNull();
});
