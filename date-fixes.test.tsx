// @vitest-environment jsdom
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Settlement } from "./settlement-contract";
import { task } from "./fixtures";

// Local calendar arithmetic is the point here, so pin a zone with DST.
const zone = process.env.TZ;
process.env.TZ = "Europe/Warsaw";
const { DATE_FIX_LABEL, DateFixes, dateFix } = await import("./date-fixes");

const call = vi.hoisted(() => vi.fn());
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => ({ call }) }));
afterEach(() => {
  cleanup();
  call.mockReset();
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

describe("dateFix", () => {
  it("offers today, a week ahead and no date", () => {
    const now = at(2026, 10, 1, 9);
    expect(dateFix("today", now)).toBe("2026-10-01");
    expect(dateFix("week", now)).toBe("2026-10-08");
    expect(dateFix("none", now)).toBeNull();
    expect(DATE_FIX_LABEL).toEqual({
      today: "Today",
      week: "+1 week",
      month: "+1 month",
      none: "No date",
    });
  });
  it.each([
    ["2026-01-31", "2026-02-28", at(2026, 1, 31)],
    ["2028-01-31", "2028-02-29", at(2028, 1, 31)],
    ["2026-03-31", "2026-04-30", at(2026, 3, 31)],
    ["2026-12-15", "2027-01-15", at(2026, 12, 15)],
    ["2026-09-10", "2026-10-10", at(2026, 9, 10, 23, 59)],
  ])("moves %s a calendar month to %s", (_, day, now) => {
    expect(dateFix("month", now)).toBe(day);
  });
  it.each([
    // Clocks go back on 2026-10-25: adding 168 hours would land on the 26th.
    ["2026-10-20", "2026-10-27", at(2026, 10, 20, 0, 30)],
    // Clocks go forward on 2027-03-28: adding 168 hours would land on 2 April.
    ["2027-03-25", "2027-04-01", at(2027, 3, 25, 23, 30)],
  ])(
    "keeps a week from %s on the calendar across a DST change: %s",
    (_, day, now) => {
      expect(dateFix("week", now)).toBe(day);
    },
  );
});

describe("DateFixes", () => {
  const now = at(2026, 10, 1, 9);
  const slipped = task({
    id: "task70",
    key: "WIZ-70",
    dueDate: "2026-09-10",
    updatedAt: "2026-09-20T10:00:00.000Z",
    nextAction: "Send the draft",
  });
  const result = (patch: Partial<Settlement> = {}): Settlement => ({
    id: "1789650000000-bdc50aee-584d-42db-9406-9199ad461c1a",
    at: now,
    title: "WIZ-70 · Review proposal",
    action: "date",
    taskId: "task70",
    taskKey: "WIZ-70",
    threadId: null,
    nextAction: "Send the draft",
    reviewer: "",
    checkAfter: null,
    dueDate: "2026-10-08",
    previousDueDate: "2026-09-10",
    taskUpdated: true,
    archivedThreadIds: [],
    undone: false,
    warning: null,
    ...patch,
  });
  const mount = (props: { disabled?: boolean } = {}) => {
    const onSettled = vi.fn();
    const onBusy = vi.fn();
    const onTile = vi.fn();
    const view = render(
      <div onClick={onTile}>
        <DateFixes
          task={slipped}
          now={now}
          disabled={props.disabled ?? false}
          onBusy={onBusy}
          onSettled={onSettled}
        />
      </div>,
    );
    const button = (name: string) => view.getByRole("button", { name });
    return { view, button, onSettled, onBusy, onTile };
  };
  const names = [
    "Move WIZ-70 to 2026-10-01",
    "Move WIZ-70 to 2026-10-08",
    "Move WIZ-70 to 2026-11-01",
    "Clear the date on WIZ-70",
  ];

  it("names each fix by its outcome", () => {
    const { view } = mount();
    const group = view.getByRole("group", { name: "Fix the date on WIZ-70" });
    const buttons = Array.from(group.querySelectorAll("button"));
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(names);
    expect(buttons.map((b) => b.title)).toEqual(names);
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Today",
      "+1 week",
      "+1 month",
      "No date",
    ]);
    expect(buttons.map((b) => b.className)).toEqual(
      ["today", "week", "month", "none"].map(
        (c) => `wm-date-fix wm-date-fix-${c}`,
      ),
    );
  });

  it.each([
    [names[0], "2026-10-01"],
    [names[1], "2026-10-08"],
    [names[2], "2026-11-01"],
    [names[3], null],
  ])("%s sends a date settlement", async (name, dueDate) => {
    const settled = result({ dueDate });
    call.mockResolvedValue(settled);
    const { button, onSettled, onTile } = mount();
    fireEvent.click(button(name));
    expect(call).toHaveBeenCalledExactlyOnceWith("settle", {
      id: expect.stringMatching(/^\d{13}-[0-9a-f-]{36}$/),
      action: "date",
      taskId: "task70",
      expectedUpdatedAt: "2026-09-20T10:00:00.000Z",
      dueDate,
      nextAction: "Send the draft",
      reviewBy: "me",
      reviewer: "",
    });
    expect(onTile).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(onSettled).toHaveBeenCalledExactlyOnceWith(settled),
    );
  });

  it("holds every fix while one is saving and never starts a second call", async () => {
    let resolve!: (value: Settlement) => void;
    call.mockReturnValue(new Promise((r) => (resolve = r)));
    const { view, button, onBusy, onSettled } = mount();
    const week = button(names[1]);
    act(() => {
      week.click();
      week.click();
      button(names[0]).click();
    });
    expect(call).toHaveBeenCalledOnce();
    expect(onBusy).toHaveBeenCalledExactlyOnceWith(true);
    expect(week.textContent).toBe("…");
    expect(
      view.getAllByRole("button").every((b) => b.hasAttribute("disabled")),
    ).toBe(true);
    await act(async () => resolve(result()));
    expect(onBusy).toHaveBeenLastCalledWith(false);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(week.textContent).toBe("+1 week");
    expect(
      view.getAllByRole("button").some((b) => b.hasAttribute("disabled")),
    ).toBe(false);
  });

  it("shows why a date did not change, and clears it on the next click", async () => {
    call.mockResolvedValueOnce(
      result({
        taskUpdated: false,
        warning: "The date is already 2026-10-01.",
      }),
    );
    const { view, button, onSettled } = mount();
    fireEvent.click(button(names[0]));
    expect((await view.findByRole("alert")).textContent).toBe(
      "The date is already 2026-10-01.",
    );
    expect(onSettled).not.toHaveBeenCalled();
    call.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(button(names[1]));
    expect(view.queryByRole("alert")).toBeNull();
  });

  it("shows a refused fix and retries it under the same id", async () => {
    call.mockRejectedValueOnce(
      new Error(
        "This task changed since you opened it. Refresh before settling it.",
      ),
    );
    const { view, button, onSettled } = mount();
    fireEvent.click(button(names[2]));
    expect((await view.findByRole("alert")).textContent).toContain(
      "changed since",
    );
    call.mockResolvedValueOnce(result({ dueDate: "2026-11-01" }));
    fireEvent.click(button(names[2]));
    await vi.waitFor(() => expect(onSettled).toHaveBeenCalledOnce());
    expect(call.mock.calls[1][1].id).toBe(call.mock.calls[0][1].id);
    call.mockResolvedValueOnce(result({ dueDate: null }));
    fireEvent.click(button(names[3]));
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call.mock.calls[2][1].id).not.toBe(call.mock.calls[0][1].id);
  });

  it("does nothing while the map holds its acts", () => {
    const { view, button } = mount({ disabled: true });
    fireEvent.click(button(names[0]));
    expect(call).not.toHaveBeenCalled();
    expect(
      view.getAllByRole("button").every((b) => b.hasAttribute("disabled")),
    ).toBe(true);
  });
});
