// @vitest-environment jsdom
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useMapZoom, ZoomControls } from "./map-zoom";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function Example({ disabled = false }: { disabled?: boolean }) {
  const canvas = useRef<HTMLDivElement>(null),
    world = useRef<HTMLDivElement>(null);
  const controls = useMapZoom(canvas, world, undefined, disabled);
  return (
    <>
      <ZoomControls {...controls} disabled={disabled} />
      <div ref={canvas} data-testid="canvas">
        <div ref={world} data-zoom={controls.zoom}>
          <div data-layout-id="one" data-work-id="one" data-testid="area">
            <button>Task</button>
            <textarea aria-label="Draft" />
          </div>
        </div>
      </div>
    </>
  );
}

it("keeps the same point in an area under the pointer during zoom", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const zoom = Number(this.parentElement?.dataset.zoom ?? 1);
      const viewport = this.closest('[data-testid="canvas"]');
      const area = this.dataset.layoutId === "one";
      const left = area ? 200 * zoom - (viewport?.scrollLeft ?? 0) : 0;
      const top = area ? 100 * zoom - (viewport?.scrollTop ?? 0) : 0;
      const width = area ? 200 * zoom : 800,
        height = area ? 100 * zoom : 600;
      return {
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON() {},
      };
    },
  );
  const view = render(<Example />);
  const area = view.getByTestId("area");
  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    deltaY: -80,
    clientX: 300,
    clientY: 150,
  });
  fireEvent(area, wheel);
  expect(wheel.defaultPrevented).toBe(true);
  expect(view.getByLabelText("Current map zoom").textContent).toBe("122%");
  const rect = area.getBoundingClientRect();
  expect(rect.left + rect.width / 2).toBeCloseTo(300);
  expect(rect.top + rect.height / 2).toBeCloseTo(150);
});

it("leaves ordinary scrolling and editors alone, snaps across 100, and honors disabled controls", () => {
  const view = render(<Example />);
  const task = view.getByRole("button", { name: "Task" });
  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 80,
  });
  fireEvent(task, wheel);
  expect(wheel.defaultPrevented).toBe(false);
  fireEvent.change(view.getByRole("slider"), { target: { value: "94" } });
  fireEvent.click(view.getByRole("button", { name: "Zoom in" }));
  expect(
    view.queryByRole("button", { name: "Reset to actual size" }),
  ).toBeNull();
  fireEvent.keyDown(task, { key: "+", metaKey: true });
  expect(view.getByRole("slider").getAttribute("aria-valuetext")).toBe(
    "110 percent",
  );
  fireEvent.keyDown(view.getByRole("textbox"), { key: "-" });
  fireEvent.wheel(view.getByRole("textbox"), { ctrlKey: true, deltaY: 100 });
  expect(view.getByLabelText("Current map zoom").textContent).toBe("110%");
  fireEvent.keyDown(task, { key: "0" });
  expect(view.getByLabelText("Current map zoom").textContent).toBe("110%");
  fireEvent.keyDown(task, { key: "0", ctrlKey: true });
  expect(view.getByLabelText("Current map zoom").textContent).toBe("100%");
  view.rerender(<Example disabled />);
  fireEvent.keyDown(task, { key: "+", ctrlKey: true });
  expect(view.getByLabelText("Current map zoom").textContent).toBe("100%");
});

it("holds at actual size briefly during a continuous wheel gesture", () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const view = render(<Example />);
  const task = view.getByRole("button", { name: "Task" });
  fireEvent.change(view.getByRole("slider"), { target: { value: "90" } });
  fireEvent.wheel(task, { ctrlKey: true, deltaY: -100 });
  expect(view.getByLabelText("Current map zoom").textContent).toBe("100%");
  fireEvent.wheel(task, { ctrlKey: true, deltaY: -100 });
  expect(view.getByLabelText("Current map zoom").textContent).toBe("100%");
  now += 260;
  fireEvent.wheel(task, { ctrlKey: true, deltaY: -100 });
  expect(view.getByLabelText("Current map zoom").textContent).toBe("128%");
});

it("handles Ctrl-wheel over canvas padding without passing it to browser zoom", () => {
  const view = render(<Example />);
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    deltaY: -100,
  });
  fireEvent(view.getByTestId("canvas"), event);
  expect(event.defaultPrevented).toBe(true);
  expect(view.getByLabelText("Current map zoom").textContent).toBe("128%");
});
