// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { Settlement } from "./settlement-contract";
import { SettledToday } from "./settlement-actions";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => ({ call: vi.fn() }),
  UrlLink: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
const receipt = (id = "first", title = "Review proposal"): Settlement => ({
  id,
  title,
  at: 1,
  action: "review",
  taskId: "task1",
  taskKey: "TEST-1",
  threadId: null,
  nextAction: "Check the numbers",
  reviewer: "",
  checkAfter: null,
  taskUpdated: true,
  archivedThreadIds: [],
  undone: false,
  warning: null,
});

it("shows a compact receipt, closes without undoing, and reopens its full history", () => {
  const onUndo = vi.fn();
  const view = render(
    <SettledToday
      rows={[receipt(), receipt("older", "Earlier work")]}
      onUndo={onUndo}
      pending={null}
      error=""
    />,
  );
  expect(view.queryByText("Check the numbers")).toBeNull();
  expect(view.queryByText("Earlier work")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Close settled today" }));
  expect(view.queryByRole("region", { name: "Settled today" })).toBeNull();
  const reopen = view.getByRole("button", {
    name: "Settled today · 2 · Show history",
  });
  expect(document.activeElement).toBe(reopen);
  expect(onUndo).not.toHaveBeenCalled();
  fireEvent.click(reopen);
  expect(view.getByText("Earlier work")).toBeTruthy();
  expect(view.getAllByText("Check the numbers")).toHaveLength(2);
  expect(document.activeElement).toBe(
    view.getByRole("button", { name: "Close settled today" }),
  );
  fireEvent.click(view.getAllByRole("button", { name: "Undo" })[1]);
  expect(onUndo).toHaveBeenCalledExactlyOnceWith("older");
});

it("stays dismissed through refresh, reordering and remount, but reveals new work", () => {
  const props = { onUndo: vi.fn(), pending: null, error: "" };
  const first = receipt(),
    older = receipt("older");
  const view = render(<SettledToday {...props} rows={[first, older]} />);
  fireEvent.click(view.getByRole("button", { name: "Close settled today" }));
  view.rerender(
    <SettledToday {...props} rows={[{ ...older }, { ...first }]} />,
  );
  expect(view.queryByRole("region", { name: "Settled today" })).toBeNull();
  view.unmount();
  const again = render(<SettledToday {...props} rows={[first, older]} />);
  expect(again.queryByRole("region", { name: "Settled today" })).toBeNull();
  again.rerender(
    <SettledToday
      {...props}
      rows={[receipt("new", "New work"), first, older]}
    />,
  );
  expect(again.getByRole("region", { name: "Settled today" })).toBeTruthy();
  expect(again.getByText("New work")).toBeTruthy();
});

it("can close during Undo and reveals a subsequent failure", () => {
  const props = { rows: [receipt()], onUndo: vi.fn() };
  const view = render(<SettledToday {...props} pending="first" error="" />);
  expect(view.getByRole("button", { name: "Undoing…" })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(view.getByRole("button", { name: "Close settled today" }));
  expect(view.queryByRole("region", { name: "Settled today" })).toBeNull();
  view.rerender(
    <SettledToday
      {...props}
      pending={null}
      error="Task changed; Undo was not applied."
    />,
  );
  expect(view.getByRole("alert").textContent).toContain("Task changed");
  fireEvent.click(view.getByRole("button", { name: "Close settled today" }));
  view.rerender(<SettledToday {...props} pending={null} error="" />);
  expect(view.queryByRole("region", { name: "Settled today" })).toBeNull();
});

it("offers details for a single receipt, preserves warnings, and closes on Escape", () => {
  const onUndo = vi.fn();
  const view = render(
    <SettledToday
      rows={[{ ...receipt(), warning: "Session stayed open." }]}
      onUndo={onUndo}
      pending={null}
      error=""
    />,
  );
  expect(view.getByRole("status").textContent).toBe("Session stayed open.");
  fireEvent.click(view.getByRole("button", { name: "Details" }));
  expect(view.getByText("Check the numbers")).toBeTruthy();
  expect(
    view.getByRole("link", { name: "Task ↗" }).getAttribute("href"),
  ).toContain("TEST-1");
  fireEvent.keyDown(view.getByRole("button", { name: "Undo" }), {
    key: "Escape",
  });
  expect(view.queryByRole("region", { name: "Settled today" })).toBeNull();
  expect(onUndo).not.toHaveBeenCalled();
});

it("keeps dismiss and reopen usable when session storage is unavailable", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw Error("unavailable");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("unavailable");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw Error("unavailable");
  });
  const view = render(
    <SettledToday
      rows={[receipt()]}
      onUndo={vi.fn()}
      pending={null}
      error=""
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "Close settled today" }));
  fireEvent.click(
    view.getByRole("button", { name: "Settled today · 1 · Show history" }),
  );
  expect(view.getByRole("region", { name: "Settled today" })).toBeTruthy();
});

it("makes a load error with no receipts dismissible", () => {
  const view = render(
    <SettledToday
      rows={[]}
      onUndo={vi.fn()}
      pending={null}
      error="Could not load settled work."
    />,
  );
  expect(view.getByRole("alert")).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Close settled today" }));
  expect(view.queryByRole("alert")).toBeNull();
  fireEvent.click(
    view.getByRole("button", { name: "Settled today · Show history" }),
  );
  expect(
    within(view.getByRole("region", { name: "Settled today" })).getByRole(
      "alert",
    ),
  ).toBeTruthy();
});
