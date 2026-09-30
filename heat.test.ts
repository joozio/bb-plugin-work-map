import { describe, expect, it } from "vitest";
import { now, task, thread } from "./fixtures";
import type { WorkItem } from "./model";
import { buildMap } from "./model";
import { data } from "./fixtures";
import {
  SESSIONS_AREA,
  buildHeat,
  cardGrid,
  evenOut,
  expandedWeights,
  heatOrder,
  heatPull,
  heatStats,
  heatLevel,
  heatTone,
  needsYou,
  partition,
  place,
  staleDays,
  tileText,
  treemap,
  waitDays,
  waitingSince,
  withFloor,
  type HeatTone,
  type Rect,
  type Weighted,
} from "./heat";

const DAY = 86400000;
const BOARD: Rect = { x: 0, y: 0, w: 1280, h: 720 };
function item(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "task:a",
    title: "A task",
    kind: "task",
    summary: "",
    nextAction: "",
    focus: false,
    signal: "inactive",
    attention: null,
    unreadResults: 0,
    reason: "Inactive",
    score: 0,
    changed: false,
    updatedAt: now,
    activityAt: now,
    recent: true,
    threads: [],
    children: [],
    scope: "TEST",
    issue: false,
    bbProjectId: "proj_test",
    ...overrides,
  };
}
const project = (id: string, children: WorkItem[]): WorkItem =>
  item({
    id: `project:${id}`,
    kind: "project",
    title: id,
    children,
    scope: id,
  });
const running = () => [thread({ id: "thr_run", indicator: "runtime" })];
const area = (rect: Rect) => rect.w * rect.h;
function overlap(a: Rect, b: Rect) {
  return (
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  );
}
const weights = (count: number): Weighted[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `i${index}`,
    // Deterministic but uneven, including repeated weights and a tiny tail.
    weight: Math.round((1 + ((index * 37) % 23) / 2.5) * 100) / 100,
  }));

describe("treemap geometry", () => {
  it("fills the rectangle exactly and never overlaps, at every size", () => {
    for (const count of [1, 2, 3, 5, 9, 17, 40]) {
      const rects = [...treemap(weights(count), BOARD).values()];
      expect(rects).toHaveLength(count);
      const covered = rects.reduce((sum, rect) => sum + area(rect), 0);
      expect(covered).toBeCloseTo(area(BOARD), 5);
      for (const rect of rects) {
        expect(rect.w).toBeGreaterThan(0);
        expect(rect.h).toBeGreaterThan(0);
        expect(rect.x).toBeGreaterThanOrEqual(-1e-9);
        expect(rect.y).toBeGreaterThanOrEqual(-1e-9);
        expect(rect.x + rect.w).toBeLessThanOrEqual(BOARD.w + 1e-9);
        expect(rect.y + rect.h).toBeLessThanOrEqual(BOARD.h + 1e-9);
      }
      for (let a = 0; a < rects.length; a++)
        for (let b = a + 1; b < rects.length; b++)
          expect(overlap(rects[a], rects[b])).toBeLessThan(1e-9);
    }
  });
  it("places the same work in the same place whatever order it arrives in", () => {
    const base = weights(12);
    const shuffled = [...base].reverse();
    const first = treemap(base, BOARD);
    const second = treemap(shuffled, BOARD);
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [id, rect] of first) expect(second.get(id)).toEqual(rect);
  });
  it("breaks equal weights by id, so a refresh cannot reshuffle the board", () => {
    const tied = [
      { id: "b", weight: 3 },
      { id: "a", weight: 3 },
      { id: "c", weight: 3 },
    ];
    expect(heatOrder(tied).map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(treemap(tied, BOARD).get("a")).toEqual(
      treemap([...tied].reverse(), BOARD).get("a"),
    );
  });
  it("keeps every neighbour in its strip while one item expands", () => {
    const items = heatOrder(weights(11));
    const rows = partition(items, BOARD);
    const before = place(
      rows,
      new Map(items.map((entry) => [entry.id, entry.weight])),
      BOARD,
    );
    const grown = expandedWeights(items, "i4", 0.6);
    const after = place(rows, grown, BOARD);
    // Same strips, same order inside them: expansion resizes, it never moves work.
    expect(partition(items, BOARD)).toEqual(rows);
    for (const row of rows) {
      const line = (rects: Map<string, Rect>) =>
        row.ids.map((id) => rects.get(id)!);
      const order = (rects: Rect[]) =>
        rects.map((rect) => (row.alongHeight ? rect.y : rect.x));
      const positions = order(line(after));
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(line(after).map((rect) => rect.w > 0 && rect.h > 0)).toEqual(
        line(before).map(() => true),
      );
    }
    expect(area(after.get("i4")!) / area(BOARD)).toBeCloseTo(0.6, 2);
    const covered = [...after.values()].reduce(
      (sum, rect) => sum + area(rect),
      0,
    );
    expect(covered).toBeCloseTo(area(BOARD), 5);
  });
  it("leaves a single item and an unknown target untouched", () => {
    const one = [{ id: "only", weight: 2 }];
    expect(expandedWeights(one, "only", 0.6).get("only")).toBe(2);
    const pair = weights(2);
    expect(expandedWeights(pair, "missing", 0.6)).toEqual(
      new Map(pair.map((entry) => [entry.id, entry.weight])),
    );
    expect([...treemap(one, BOARD).values()][0]).toEqual(BOARD);
  });
});

describe("readable minimums", () => {
  it("lifts a sliver to a readable share without disturbing the order", () => {
    const items = [
      { id: "big", weight: 50 },
      { id: "mid", weight: 8 },
      { id: "sliver", weight: 0.8 },
    ];
    const floored = withFloor(items, 0.05);
    expect(floored.map((entry) => entry.id)).toEqual(["big", "mid", "sliver"]);
    const sum = floored.reduce((total, entry) => total + entry.weight, 0);
    expect(floored[2].weight / sum).toBeGreaterThanOrEqual(0.049);
    expect(floored[0].weight).toBe(50);
    expect(floored[1].weight).toBe(8);
  });
  it("shrinks the floor rather than flattening a crowded map", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      id: `i${index}`,
      weight: index === 0 ? 40 : 0.8,
    }));
    const floored = withFloor(many, 0.05);
    const sum = floored.reduce((total, entry) => total + entry.weight, 0);
    // 30 areas cannot each hold 5%; the biggest must stay clearly the biggest.
    expect(floored[0].weight / sum).toBeGreaterThan(0.3);
    expect(withFloor([], 0.05)).toEqual([]);
  });
  it("lays an expanded area out as cards in rank order, with no hole", () => {
    const ids = Array.from({ length: 17 }, (_, index) => `t${index}`);
    const grid = cardGrid(ids, { w: 600, h: 460 });
    expect(grid.size).toBe(17);
    // Rank order reads row by row, left to right; rows never overlap.
    const rects = ids.map((id) => grid.get(id)!);
    for (let index = 1; index < rects.length; index++) {
      const before = rects[index - 1];
      const here = rects[index];
      expect(
        here.y > before.y || (here.y === before.y && here.x > before.x),
      ).toBe(true);
    }
    // Every row spans the full width, the last one included.
    const rows = new Map<number, Rect[]>();
    for (const rect of rects)
      rows.set(rect.y, [...(rows.get(rect.y) ?? []), rect]);
    for (const row of rows.values()) {
      const span = row.reduce((sum, rect) => sum + rect.w, 0);
      expect(span).toBeCloseTo(100, 1);
      const equal = row.every((rect) => Math.abs(rect.w - row[0].w) < 0.01);
      expect(equal).toBe(true);
    }
    const height = [...rows.values()].reduce((sum, row) => sum + row[0].h, 0);
    expect(height).toBeCloseTo(100, 1);
    // A wide, short body takes more columns; a tall, narrow one fewer.
    expect(cardGrid(ids, { w: 350, h: 1100 }).get("t1")!.x).toBe(50);
    expect(cardGrid(ids, { w: 1400, h: 300 }).get("t1")!.x).toBeLessThan(20);
    expect(cardGrid([], { w: 1, h: 1 }).size).toBe(0);
  });
  it("evens an expanded area so its lightest tile is still a card, in the same order", () => {
    const items = [
      { id: "loud", weight: 12 },
      { id: "mid", weight: 4 },
      { id: "quiet", weight: 0.8 },
    ];
    const even = evenOut(items, 0.6);
    expect(even.map((entry) => entry.id)).toEqual(["loud", "mid", "quiet"]);
    expect(even[0].weight).toBe(12);
    expect(even[1].weight).toBeCloseTo(7.2, 3);
    expect(even[2].weight).toBeCloseTo(7.2, 3);
    // The input is left alone, and an empty or weightless list stays as it is.
    expect(items[2].weight).toBe(0.8);
    expect(evenOut([], 0.6)).toEqual([]);
    expect(evenOut([{ id: "a", weight: 0 }], 0.6)).toEqual([
      { id: "a", weight: 0 },
    ]);
  });
});

describe("attention to colour", () => {
  it("reuses the map's own channels and adds no sixth kind of attention", () => {
    expect(heatTone(item({ attention: "input" }))).toBe("input");
    expect(heatTone(item({ attention: "error" }))).toBe("error");
    expect(heatTone(item({ attention: "review" }))).toBe("review");
    expect(heatTone(item({ attention: "followup" }))).toBe("followup");
    expect(heatTone(item({ attention: "unread" }))).toBe("unread");
    // A review task with no session, and an unread result with no attention.
    expect(heatTone(item({ task: task({ status: "in_review" }) }))).toBe(
      "review",
    );
    expect(heatTone(item({ unreadResults: 2 }))).toBe("unread");
    expect(heatTone(item({ threads: running() }))).toBe("working");
    expect(heatTone(item())).toBe("quiet");
  });
  it("counts only work that needs your hands as waiting on you", () => {
    const tones: HeatTone[] = [
      "input",
      "error",
      "review",
      "followup",
      "unread",
      "working",
      "quiet",
    ];
    expect(tones.filter(needsYou)).toEqual([
      "input",
      "error",
      "review",
      "followup",
    ]);
  });
  it("sizes attention above activity, and keeps the quietest tile readable", () => {
    const quiet = heatPull(item(), now);
    const input = heatPull(item({ attention: "input" }), now);
    const review = heatPull(item({ attention: "review" }), now);
    const unread = heatPull(item({ attention: "unread" }), now);
    const work = heatPull(item({ threads: running() }), now);
    expect(quiet).toBe(0.8);
    expect(input).toBeGreaterThan(review);
    expect(review).toBeGreaterThan(unread);
    expect(unread).toBeGreaterThan(work);
    expect(work).toBeGreaterThan(quiet);
    expect(input).toBeLessThanOrEqual(14);
    expect(
      heatPull(item({ attention: "input", focus: true }), now),
    ).toBeGreaterThan(input);
    expect(
      heatPull(
        item({
          attention: "review",
          task: task({ status: "in_review", priority: "urgent" }),
        }),
        now,
      ),
    ).toBeGreaterThan(
      heatPull(item({ task: task({ status: "in_review" }) }), now),
    );
  });
  it("marks work stale only after 30 days of actually waiting on you", () => {
    const old = now - 45 * DAY;
    const request = item({
      attention: "input",
      activityAt: old,
      threads: [
        thread({ indicator: "waiting-for-input", latestAttentionAt: old }),
      ],
    });
    expect(staleDays(request, now)).toBe(45);
    expect(staleDays(item({ attention: "input" }), now)).toBe(0);
    // A quiet or already-read item is old, not waiting.
    expect(staleDays(item({ activityAt: old }), now)).toBe(0);
    expect(staleDays(item({ attention: "unread", activityAt: old }), now)).toBe(
      0,
    );
    expect(heatPull(request, now)).toBeGreaterThan(
      heatPull(item({ attention: "input" }), now),
    );
  });
  it("measures the wait from when the task started needing you, not from agent activity", () => {
    const iso = (days: number) => new Date(now - days * DAY).toISOString();
    const day = (days: number) =>
      new Date(now - days * DAY).toISOString().slice(0, 10);
    const review = (overrides: Partial<ReturnType<typeof task>>) =>
      item({
        attention: "review",
        activityAt: now,
        updatedAt: now,
        task: task({ status: "in_review", dateKind: "due", ...overrides }),
      });
    // An old recurring record entered review today: the old creation and due dates do not age this cycle.
    expect(
      waitDays(
        review({ createdAt: iso(40), statusSince: iso(0), dueDate: day(7) }),
        now,
      ),
    ).toBe(0);
    // Ordinary agent edits cannot reset a proven current review period.
    expect(
      waitDays(
        review({ createdAt: iso(40), statusSince: iso(20), dueDate: day(81) }),
        now,
      ),
    ).toBe(20);
    // A future or planning date does not change when an existing review began.
    expect(
      waitDays(review({ statusSince: iso(3), dueDate: day(-4) }), now),
    ).toBe(3);
    // A planning date is a plan, not a request.
    expect(
      waitDays(
        review({ statusSince: iso(3), dueDate: day(50), dateKind: "plan" }),
        now,
      ),
    ).toBe(3);
    // Missing review history stays unknown, never guessed from creation or a maintenance edit.
    expect(
      waitDays(
        item({
          attention: "review",
          updatedAt: now - 9 * DAY,
          task: task({ createdAt: undefined, dueDate: null }),
        }),
        now,
      ),
    ).toBe(0);
    // A session waits since it asked; quiet work waits for nothing.
    expect(
      waitingSince(
        item({
          attention: "input",
          activityAt: now - 2 * DAY,
          threads: [
            thread({
              indicator: "waiting-for-input",
              latestAttentionAt: now - 2 * DAY,
            }),
          ],
        }),
        now,
      ),
    ).toBe(now - 2 * DAY);
    expect(
      waitingSince(item({ task: task({ createdAt: iso(40) }) }), now),
    ).toBe(0);
    expect(
      staleDays(review({ statusSince: iso(31), dueDate: null }), now),
    ).toBe(31);
    expect(
      staleDays(review({ statusSince: iso(30), dueDate: null }), now),
    ).toBe(0);
    expect(waitingSince(review({ statusSince: iso(-1) }), now)).toBe(0);
    const [area] = buildHeat(
      [project("unknown", [review({ createdAt: iso(40) })])],
      now,
    );
    expect(area.tiles[0].waited).toBeNull();
  });
  it("keeps deferred follow-ups quiet and starts aging only on the current check date", () => {
    const check = (days: number) =>
      new Date(now - days * DAY).toISOString().slice(0, 10);
    const followup = (days: number) =>
      buildMap(
        data([
          task({
            lifecycle: "waiting",
            waitingOn: "A partner",
            checkAfter: check(days),
            createdAt: new Date(now - 40 * DAY).toISOString(),
            dueDate: check(40),
          }),
        ]),
        [],
        {},
        now,
      )[0].children[0];
    expect(heatTone(followup(-7))).toBe("quiet");
    expect(waitDays(followup(-7), now)).toBe(0);
    expect(heatTone(followup(1))).toBe("followup");
    expect(waitDays(followup(1), now)).toBe(1);
    expect(staleDays(followup(1), now)).toBe(0);
  });
  it("ages a task's input request from its requesting session, not the task or another session", () => {
    const request = item({
      attention: "input",
      task: task({
        status: "in_review",
        statusSince: new Date(now - 40 * DAY).toISOString(),
      }),
      threads: [
        thread({
          indicator: "waiting-for-input",
          latestAttentionAt: now - DAY,
        }),
        thread({ indicator: "unread-success", latestAttentionAt: now }),
      ],
    });
    expect(waitDays(request, now)).toBe(1);
    expect(waitDays({ ...request, threads: [] }, now)).toBe(0);
  });
  it("leaves impossible follow-up calendar dates unknown instead of normalizing them", () => {
    const current = new Date("2026-03-02T12:00:00").getTime();
    const invalid = buildMap(
      data([
        task({
          lifecycle: "waiting",
          waitingOn: "Partner",
          checkAfter: "2026-02-30",
        }),
      ]),
      [],
      {},
      current,
    )[0].children[0];
    expect(waitingSince(invalid, current)).toBe(0);
    expect(
      buildHeat([project("bad-date", [invalid])], current)[0].tiles[0].waited,
    ).toBeNull();
  });
  it("does not mistake a standalone session's creation for a missing attention timestamp", () => {
    for (const indicator of ["waiting-for-input", "unread-error"] as const) {
      const session = thread({
        createdAt: now - 40 * DAY,
        latestAttentionAt: 0,
        indicator,
      });
      const root = buildMap(data([]), [session], {}, now)[0];
      expect(waitingSince(root, now)).toBe(0);
      expect(staleDays(root, now)).toBe(0);
      expect(buildHeat([root], now)[0].tiles[0].waited).toBeNull();
    }
  });
  it("does not boost a task just because it has a distant future date", () => {
    const dated = (days: number) =>
      item({
        task: task({
          dateKind: "due",
          dueDate: new Date(now + days * DAY).toISOString().slice(0, 10),
        }),
      });
    expect(heatPull(dated(30), now)).toBe(
      heatPull(item({ task: task() }), now),
    );
    expect(heatPull(dated(0), now)).toBeGreaterThan(heatPull(dated(30), now));
  });
  it("deepens task colour with creation age and focus, not review age or priority", () => {
    const iso = (days: number) => new Date(now - days * DAY).toISOString();
    const review = (priority: string, days = 0, focus = false) =>
      item({
        attention: "review",
        focus,
        task: task({
          status: "in_review",
          priority,
          statusSince: iso(0),
          createdAt: iso(days),
          dueDate: null,
        }),
      });
    expect(heatLevel(review("none"), now)).toBe(1);
    expect(heatLevel(review("low"), now)).toBe(1);
    expect(heatLevel(review("medium"), now)).toBe(1);
    expect(heatLevel(review("high"), now)).toBe(1);
    expect(heatLevel(review("urgent"), now)).toBe(1);
    expect(heatLevel(review("none", 45), now)).toBe(2);
    expect(heatLevel(review("high", 45), now)).toBe(2);
    expect(heatLevel(review("high", 90, true), now)).toBe(4);
    expect(heatLevel(review("low", 0, true), now)).toBe(2);
    expect(heatLevel(item({ attention: "input" }), now)).toBe(3);
    expect(heatLevel(item({ attention: "error" }), now)).toBe(3);
    expect(
      heatLevel(item({ attention: "unread", unreadResults: 1 }), now),
    ).toBe(1);
    expect(heatLevel(item(), now)).toBe(1);
  });
  it("moves a known leading verb out of the title and leaves everything else alone", () => {
    expect(tileText("Review draft: The Screen That Lies")).toEqual({
      ask: "draft",
      title: "The Screen That Lies",
    });
    expect(tileText("Decide: drop the VM image?")).toEqual({
      ask: "decide",
      title: "drop the VM image?",
    });
    expect(tileText("Review: Wiz architecture audit")).toEqual({
      ask: "review",
      title: "Wiz architecture audit",
    });
    // A project code or a plain title is not a verb.
    expect(tileText("HN: your comments are being killed")).toEqual({
      ask: "",
      title: "HN: your comments are being killed",
    });
    expect(tileText("Approve the droplet (1 click)")).toEqual({
      ask: "",
      title: "Approve the droplet (1 click)",
    });
    expect(tileText("Review:")).toEqual({ ask: "", title: "Review:" });
  });
  it("keeps a pinned quiet session out of the quiet cap so the Sessions area stays readable", () => {
    const pinned = Array.from({ length: 3 }, (_, index) =>
      item({ id: `thread:pin${index}`, kind: "thread", focus: true }),
    );
    const plain = Array.from({ length: 3 }, (_, index) =>
      item({ id: `thread:idle${index}`, kind: "thread" }),
    );
    const [withPins] = buildHeat(pinned, now);
    const [withoutPins] = buildHeat(plain, now);
    expect(withPins.id).toBe(SESSIONS_AREA);
    expect(withPins.weight).toBeGreaterThan(withoutPins.weight * 2);
  });
});

describe("areas", () => {
  it("groups standalone sessions, collapses the finished ones, and opens on request", () => {
    const roots = [
      project("p1", [item({ id: "task:1", attention: "input" })]),
      ...Array.from({ length: 6 }, (_, index) =>
        item({ id: `thread:${index}`, kind: "thread", scope: "Session" }),
      ),
      item({ id: "thread:live", kind: "thread", threads: running() }),
    ];
    const areas = buildHeat(roots, now);
    expect(areas.map((entry) => entry.id)).toEqual([
      "project:p1",
      SESSIONS_AREA,
    ]);
    const collapsed = areas[1];
    expect(collapsed.title).toBe("Sessions");
    expect(collapsed.root).toBeNull();
    expect(collapsed.items).toHaveLength(7);
    expect(collapsed.tiles).toHaveLength(2);
    const group = collapsed.tiles.find((tile) => !tile.item)!;
    expect(group.members).toHaveLength(6);
    expect(group.tone).toBe("quiet");
    const opened = buildHeat(roots, now, { uncollapsed: [SESSIONS_AREA] }).find(
      (entry) => entry.id === SESSIONS_AREA,
    )!;
    expect(opened.tiles).toHaveLength(7);
    expect(opened.tiles.every((tile) => tile.item)).toBe(true);
  });
  it("ranks the area that needs you above a busier quiet one, and counts its header", () => {
    const loud = project("loud", [
      item({ id: "task:in", attention: "input" }),
      item({ id: "task:run", threads: running() }),
    ]);
    const quiet = project(
      "quiet",
      Array.from({ length: 14 }, (_, index) => item({ id: `task:q${index}` })),
    );
    const areas = buildHeat([quiet, loud], now);
    expect(areas.map((entry) => entry.title)).toEqual(["loud", "quiet"]);
    expect(areas[0].waiting).toBe(1);
    expect(areas[0].running).toBe(1);
    // A pile of quiet tasks is capped, and collapses behind one tile.
    expect(areas[1].weight).toBeLessThan(areas[0].weight);
    expect(areas[1].tiles).toHaveLength(5);
    expect(
      buildHeat([quiet, loud], now, { uncollapsed: [quiet.id] })[1].tiles,
    ).toHaveLength(14);
  });
  it("reports the header stats over every item, collapsed ones included", () => {
    const roots = [
      project("p1", [
        item({
          id: "task:1",
          attention: "input",
          activityAt: now - 40 * DAY,
          threads: [
            thread({
              indicator: "waiting-for-input",
              latestAttentionAt: now - 40 * DAY,
            }),
          ],
        }),
        item({ id: "task:2", attention: "unread", unreadResults: 1 }),
      ]),
      item({ id: "thread:a", kind: "thread", threads: running() }),
      item({ id: "thread:b", kind: "thread" }),
    ];
    expect(heatStats(buildHeat(roots, now), now)).toEqual({
      waiting: 1,
      unread: 1,
      running: 1,
      stale: 1,
      overdue: 0,
      aged: 0,
    });
  });
  it("lays every area inside the board without gaps", () => {
    const roots = Array.from({ length: 7 }, (_, index) =>
      project(
        `p${index}`,
        Array.from({ length: index + 1 }, (_, child) =>
          item({
            id: `task:${index}-${child}`,
            attention: child === 0 ? "input" : null,
          }),
        ),
      ),
    );
    const areas = buildHeat(roots, now);
    const rects = treemap(areas, BOARD);
    expect(rects.size).toBe(areas.length);
    const covered = [...rects.values()].reduce(
      (sum, rect) => sum + area(rect),
      0,
    );
    expect(covered).toBeCloseTo(area(BOARD), 5);
    for (const entry of areas) {
      const inner = treemap(entry.tiles, rects.get(entry.id)!);
      expect(inner.size).toBe(entry.tiles.length);
      expect(
        [...inner.values()].reduce((sum, rect) => sum + area(rect), 0),
      ).toBeCloseTo(area(rects.get(entry.id)!), 5);
    }
  });
});
