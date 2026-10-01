import { describe, expect, it } from "vitest";
import { data, now, task } from "./fixtures";
import { buildMap, localDay } from "./model";
import type { MapTask } from "./server";
import type { WorkItem } from "./model";
import { buildHeat, heatPull, heatStats } from "./heat";
import {
  SLIPPED_DAYS,
  SLIPPED_NEAR,
  ageNear,
  dueNear,
  heatTiming,
  ramp,
} from "./heat-timing";

const DAY = 86400000;
const iso = (days: number) => new Date(now - days * DAY).toISOString();
const due = (days: number) => localDay(now + days * DAY);
const item = (fields: Partial<MapTask> = {}, at = now) =>
  buildMap(data([task(fields)]), [], {}, at)[0].children[0];

describe("task timing drives Heat", () => {
  it("increases size at two weeks, one week, three days, tomorrow and today, holds a week past due, then eases to the slipped mark", () => {
    const offsets = [21, 14, 7, 3, 1, 0, -1, -14];
    const items = offsets.map((days) =>
      item({ dueDate: due(days), dateKind: "deadline" }),
    );
    const weights = items.map((entry) => heatPull(entry, now));
    // Rising to today.
    weights
      .slice(1, 6)
      .forEach((weight, index) =>
        expect(weight).toBeGreaterThan(weights[index]),
      );
    // Yesterday pulls as hard as today: the peak is a plateau over the first
    // week past due. Two weeks past it has started to fade, still above a
    // date three days ahead.
    expect(weights[6]).toBe(weights[5]);
    expect(weights[7]).toBeLessThan(weights[6]);
    expect(weights[7]).toBeGreaterThan(weights[3]);
    expect(dueNear(21)).toBeLessThan(dueNear(14));
    expect(dueNear(30)).toBe(dueNear(300));
    // The ramp holds its ends and draws straight lines between its points.
    expect(ramp([[0, 1], [10, 0]], -5)).toBe(1);
    expect(ramp([[0, 1], [10, 0]], 2.5)).toBe(0.75);
    expect(ramp([[0, 1], [10, 0]], 50)).toBe(0);
    expect(ageNear(0)).toBe(0.2);
    expect(ageNear(45)).toBeCloseTo(0.34);
    expect(ageNear(400)).toBe(0.5);
    expect(items.map((entry) => heatTiming(entry, now)!.label)).toEqual([
      "Due in 21d",
      "Due in 14d",
      "Due in 7d",
      "Due in 3d",
      "Due tomorrow",
      "Due today",
      "1d late",
      "14d late",
    ]);
  });

  it("peaks overdue in its first week, eases to the slipped mark, then holds flat: a date long past is a date to tidy, not urgency", () => {
    const at = (days: number) =>
      heatTiming(item({ dueDate: due(days), dateKind: "deadline" }), now)!;
    // The peak holds for the first week past due, then eases to 85% at two weeks.
    expect(at(0).near).toBe(1);
    expect(at(-1).near).toBe(1);
    expect(at(-7).near).toBe(1);
    expect(at(-14).near).toBeCloseTo(0.85);
    // Past two weeks the date has slipped: a flat pull, whatever the count.
    for (const days of [15, 21, 30, 60, 84, 180, 400])
      expect(at(-days).near).toBe(SLIPPED_NEAR);
    expect(at(-84).near).toBe(at(-15).near);
    expect(dueNear(-(SLIPPED_DAYS + 1))).toBe(SLIPPED_NEAR);
    // Fading never crosses: every day past due pulls at most what the day before did.
    for (let days = 1; days < 200; days++)
      expect(at(-days).near).toBeLessThanOrEqual(at(-days + 1).near);
    // A slipped date sits under a date this week and over a date a month out.
    expect(at(-84).near).toBeLessThan(at(7).near);
    expect(at(-84).near).toBeGreaterThan(at(30).near);
    expect(at(-84).near).toBeLessThan(at(0).near);
    expect(heatPull(item({ dueDate: due(-3) }), now)).toBeGreaterThan(
      heatPull(item({ dueDate: due(-84) }), now),
    );
    const undated30 = heatTiming(item({ createdAt: iso(30) }), now)!;
    expect([-1, -14, -15, -84].map((days) => at(days).slipped)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    // Overdue keeps meaning past the date; a slipped date says so and is not prominent.
    expect(at(-84).overdue).toBe(true);
    expect(at(-84).label).toBe("slipped 84d");
    expect(at(-84).prominent).toBe(false);
    expect(at(-14).label).toBe("14d late");
    expect(at(-14).prominent).toBe(true);
    expect(at(0).slipped).toBe(false);
    expect(undated30.slipped).toBe(false);
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
    expect(heatTiming(recurring, now)!.kind).toBe("due");
    const overdue = item({ ...recurring.task, dueDate: due(-1) });
    expect(heatPull(overdue, now)).toBeGreaterThan(heatPull(recurring, now));
  });

  it("multiplies priority with the date, and ignores review age and CHECK AFTER", () => {
    const far = item({
      dueDate: due(14),
      priority: "urgent",
      status: "in_review",
      createdAt: iso(300),
      statusSince: iso(100),
    });
    const today = item({ dueDate: due(0), priority: "medium", status: "in_review" });
    const soon = item({ dueDate: due(3), priority: "none", status: "in_review" });
    // A medium task due today still beats an urgent one two weeks out; an
    // unset priority three days out does not.
    expect(heatPull(today, now)).toBeGreaterThan(heatPull(far, now));
    expect(heatPull(far, now)).toBeGreaterThan(heatPull(soon, now));
    // Review age moves nothing: the same task, fresh in review, pulls the same.
    expect(heatPull({ ...far, task: { ...far.task!, statusSince: iso(0), createdAt: iso(1) } }, now)).toBe(heatPull(far, now));
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

describe("compact timing labels", () => {
  it("keeps the number and drops the words a narrow tile cannot hold", () => {
    const day = 86400000;
    const at = (days: number) => {
      const date = new Date(now + days * day);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    };
    const timing = (dueDate: string) =>
      heatTiming(
        { task: { status: "todo", dueDate, dateKind: "deadline" } } as unknown as WorkItem,
        now,
      );
    const compact = (dueDate: string) => timing(dueDate)?.compact;
    expect([-1, -14, -15].map((days) => timing(at(days))?.label)).toEqual([
      "1d late",
      "14d late",
      "slipped 15d",
    ]);
    expect(compact(at(-1))).toBe("1d late");
    expect(compact(at(-14))).toBe("14d late");
    expect(compact(at(-15))).toBe("slip 15d");
    expect(compact(at(-38))).toBe("slip 38d");
    expect(compact(at(0))).toBe("today");
    expect(compact(at(1))).toBe("tmrw");
    expect(compact(at(3))).toBe("in 3d");
  });
});
