import { describe, expect, it } from "vitest";
import { data, now, task } from "./fixtures";
import { buildMap, localDay } from "./model";
import type { MapTask } from "./server";
import type { WorkItem } from "./model";
import { buildHeat, heatLevel, heatPull, heatStats } from "./heat";
import { heatTiming } from "./heat-timing";

const DAY = 86400000;
const iso = (days: number) => new Date(now - days * DAY).toISOString();
const due = (days: number) => localDay(now + days * DAY);
const item = (fields: Partial<MapTask> = {}, at = now) =>
  buildMap(data([task(fields)]), [], {}, at)[0].children[0];

describe("task timing drives Heat", () => {
  it("increases size at two weeks, one week, three days, tomorrow, today and overdue", () => {
    const offsets = [21, 14, 7, 3, 1, 0, -1, -14];
    const items = offsets.map((days) =>
      item({ dueDate: due(days), dateKind: "deadline" }),
    );
    const weights = items.map((entry) => heatPull(entry, now));
    weights
      .slice(1)
      .forEach((weight, index) =>
        expect(weight).toBeGreaterThan(weights[index]),
      );
    expect(items.map((entry) => heatLevel(entry, now))).toEqual([
      1, 1, 1, 2, 3, 4, 4, 4,
    ]);
    expect(items.map((entry) => heatTiming(entry, now)!.label)).toEqual([
      "Due in 21d",
      "Due in 14d",
      "Due in 7d",
      "Due in 3d",
      "Due tomorrow",
      "Due today",
      "1d overdue",
      "14d overdue",
    ]);
  });

  it("peaks overdue in its first week, then decays: a date long past is stale, not urgent", () => {
    const at = (days: number) =>
      heatTiming(item({ dueDate: due(days), dateKind: "deadline" }), now)!;
    expect(at(-1).weight).toBeCloseTo(10 + 2 / 7);
    expect(at(-7).weight).toBe(12);
    expect(at(-8).weight).toBe(12);
    expect(at(-30).weight).toBe(8);
    expect(at(-31).weight).toBe(7);
    expect(at(-84).weight).toBe(7);
    // Stale overdue still outweighs a 30-day undated task, never due today.
    const undated30 = heatTiming(item({ createdAt: iso(30) }), now)!;
    expect(at(-84).weight).toBeGreaterThan(undated30.weight);
    expect(at(-84).weight).toBeLessThan(at(0).weight);
    expect(heatPull(item({ dueDate: due(-3) }), now)).toBeGreaterThan(
      heatPull(item({ dueDate: due(-84) }), now),
    );
    expect([-14, -15, -60, -61, -84].map((days) => at(days).level)).toEqual([
      4, 3, 3, 2, 2,
    ]);
    expect([-1, -14, -15, -84].map((days) => at(days).late)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    // Overdue keeps meaning past the date, and the label is unchanged.
    expect(at(-84).overdue).toBe(true);
    expect(at(-84).label).toBe("84d overdue");
    expect(at(0).late).toBe(false);
    expect(undated30.late).toBe(false);
  });

  it("uses the current date for recurring work regardless of creation, edits or review history", () => {
    const fresh = item({
      dueDate: due(7),
      status: "in_review",
      createdAt: iso(0),
    });
    const recurring = item({
      dueDate: due(7),
      status: "in_review",
      createdAt: iso(300),
      updatedAt: iso(0),
      statusSince: iso(40),
    });
    expect(heatPull(recurring, now)).toBe(heatPull(fresh, now));
    expect(heatLevel(recurring, now)).toBe(heatLevel(fresh, now));
    expect(heatTiming(recurring, now)!.kind).toBe("due");
    const overdue = item({ ...recurring.task, dueDate: due(-1) });
    expect(heatPull(overdue, now)).toBeGreaterThan(heatPull(recurring, now));
  });

  it("keeps due dates primary over priority, review age and CHECK AFTER", () => {
    const far = item({
      dueDate: due(14),
      priority: "urgent",
      status: "in_review",
      createdAt: iso(300),
      statusSince: iso(100),
    });
    const near = item({ dueDate: due(3), priority: "none" });
    expect(heatPull(near, now)).toBeGreaterThan(heatPull(far, now));
    const waiting = item({
      dueDate: due(-1),
      lifecycle: "waiting",
      waitingOn: "Reviewer",
      checkAfter: due(7),
    });
    expect(heatTiming(waiting, now)!.overdue).toBe(true);
  });

  it("raises undated backlog work at one week, 30, 60 and 90 days despite maintenance edits", () => {
    const ages = [0, 7, 30, 60, 90, 180];
    const entries = ages.map((age) =>
      item({
        status: "backlog",
        createdAt: iso(age),
        updatedAt: iso(0),
        dueDate: null,
      }),
    );
    const weights = entries.map((entry) => heatPull(entry, now));
    weights
      .slice(1)
      .forEach((weight, index) =>
        expect(weight).toBeGreaterThan(weights[index]),
      );
    expect(entries.map((entry) => heatTiming(entry, now)!.label)).toEqual(
      ages.map((age) => `${age}d old`),
    );
    expect(entries.map((entry) => heatLevel(entry, now))).toEqual([
      1, 1, 2, 3, 4, 4,
    ]);
    expect(
      heatPull(item({ createdAt: iso(90), updatedAt: iso(60) }), now),
    ).toBe(heatPull(item({ createdAt: iso(90), updatedAt: iso(0) }), now));
  });

  it("switches drivers when a date is added or removed", () => {
    const aged = item({ createdAt: iso(90), dueDate: null });
    const scheduled = item({ ...aged.task, dueDate: due(14) });
    expect(heatTiming(aged, now)!.kind).toBe("age");
    expect(heatTiming(scheduled, now)!.kind).toBe("due");
    expect(heatPull(scheduled, now)).toBeLessThan(heatPull(aged, now));
  });

  it("keeps near dates and 30-day undated backlog out of quiet groups and caps", () => {
    const roots = buildMap(
      data([
        ...Array.from({ length: 12 }, (_, index) =>
          task({ id: `recent${index}`, status: "backlog", createdAt: iso(0) }),
        ),
        task({ id: "old", status: "backlog", createdAt: iso(90) }),
        task({ id: "near", dueDate: due(3) }),
        task({ id: "late", dueDate: due(-1) }),
      ]),
      [],
      {},
      now,
    );
    const [area] = buildHeat(roots, now);
    expect(
      area.tiles.filter((tile) => tile.item).map((tile) => tile.id),
    ).toEqual(expect.arrayContaining(["task:old", "task:near", "task:late"]));
    const group = area.tiles.find((tile) => !tile.item)!;
    expect(
      group.members.every((member) => member.id.startsWith("task:recent")),
    ).toBe(true);
    const prominentWeight = area.tiles
      .filter((tile) => tile.timing?.prominent)
      .reduce((sum, tile) => sum + tile.weight, 0);
    expect(area.weight).toBeGreaterThanOrEqual(prominentWeight);
    expect(heatStats([area], now)).toMatchObject({ overdue: 1, aged: 1 });
  });

  it("names planned dates honestly with the same timing thresholds", () => {
    expect(
      heatTiming(item({ dueDate: due(-1), dateKind: "plan" }), now)!.label,
    ).toBe("1d past plan");
    expect(
      heatTiming(item({ dueDate: due(1), dateKind: "plan" }), now)!.label,
    ).toBe("Planned tomorrow");
  });

  it("compares local calendar dates across midnight and daylight-saving transitions", () => {
    const before = new Date(2026, 9, 24, 23, 59).getTime();
    const after = new Date(2026, 9, 25, 0, 1).getTime();
    const deadline = item(
      { dueDate: "2026-10-25", dateKind: "deadline" },
      before,
    );
    expect(heatTiming(deadline, before)!.days).toBe(1);
    expect(heatTiming(deadline, after)!.days).toBe(0);
    const nextDay = new Date(2026, 9, 26, 0, 1).getTime();
    const old = item(
      { createdAt: new Date(2026, 9, 25, 0, 30).toISOString() },
      nextDay,
    );
    expect(heatTiming(old, nextDay)!.days).toBe(1);
  });

  it.each(["bad", "2026-02-30", "2026-13-01", "2026-9-17"])(
    "does not invent urgency from invalid due date %s",
    (dueDate) => {
      expect(
        heatTiming(item({ dueDate, createdAt: iso(300) }), now),
      ).toBeNull();
    },
  );

  it.each([undefined, "bad", "2026-02-30T12:00:00Z", iso(-1)])(
    "does not invent creation age from %s",
    (createdAt) => {
      expect(heatTiming(item({ createdAt }), now)).toBeNull();
    },
  );

  it("does not age closed tasks or standalone sessions", () => {
    const entry = item({ createdAt: iso(300) });
    for (const status of ["done", "canceled"]) {
      expect(
        heatTiming({ ...entry, task: { ...entry.task!, status } }, now),
      ).toBeNull();
    }
    expect(
      heatTiming({ ...entry, task: undefined, kind: "thread" }, now),
    ).toBeNull();
  });
});

describe("a snooze label", () => {
  it("counts calendar days, so a fresh 7-day snooze reads 7d whatever the map's clock", () => {
    const at = new Date("2026-10-01T01:48:00").getTime();
    const until = at + 7 * 86400000;
    const item = { task: task({ status: "in_review" }), snoozedUntil: until } as unknown as WorkItem;
    // The map's clock lagging the click by three minutes used to round up to 8d.
    expect(heatTiming(item, at - 180000)?.label).toBe("snoozed 7d");
    expect(heatTiming(item, at)?.label).toBe("snoozed 7d");
    expect(heatTiming(item, at + 6 * 86400000)?.label).toBe("snoozed 1d");
  });
});
