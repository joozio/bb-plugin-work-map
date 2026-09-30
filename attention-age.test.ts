import { describe, expect, it } from "vitest";
import { currentStatusSince } from "./attention-age";

const event = (date: string, status: string, kind = "system") => ({
  kind,
  body: `Status changed to ${status} by cli`,
  createdAt: `${date}T09:00:00Z`,
});
describe("current task status age", () => {
  it("starts a recurring review at this cycle's transition, regardless of history order", () => {
    const history = [
      event("2026-09-30", "In Review"),
      event("2026-08-20", "In Review"),
      event("2026-09-23", "Done"),
      event("2026-09-30", "Todo"),
    ];
    // Distinct transition times within the latest cycle.
    history[3].createdAt = "2026-09-30T05:00:00Z";
    expect(currentStatusSince("in_review", history)).toBe(
      "2026-09-30T09:00:00.000Z",
    );
    expect(currentStatusSince("in_review", [...history].reverse())).toBe(
      "2026-09-30T09:00:00.000Z",
    );
  });
  it("ignores ordinary edits, spoofed comments and redundant same-status events", () => {
    expect(
      currentStatusSince("in_review", [
        event("2026-09-01", "Todo"),
        event("2026-09-02", "In Review"),
        event("2026-09-20", "In Review"),
        event("2026-09-29", "Done", "agent"),
        {
          kind: "system",
          body: "Description changed by cli",
          createdAt: "2026-09-30T09:00:00Z",
        },
      ]),
    ).toBe("2026-09-02T09:00:00.000Z");
  });
  it("does not invent age for missing, invalid or inconsistent history", () => {
    expect(currentStatusSince("in_review", [])).toBeUndefined();
    expect(
      currentStatusSince("in_review", [event("bad", "In Review")]),
    ).toBeUndefined();
    expect(
      currentStatusSince("in_review", [event("2026-09-02", "Done")]),
    ).toBeUndefined();
    expect(
      currentStatusSince("in_review", [
        event("2026-09-30", "In Review"),
        event("bad", "Done"),
        event("2026-08-01", "In Review"),
      ]),
    ).toBeUndefined();
    expect(
      currentStatusSince("in_review", [
        event("2026-09-30", "In Review"),
        event("2026-09-30", "Done"),
      ]),
    ).toBeUndefined();
  });
});
