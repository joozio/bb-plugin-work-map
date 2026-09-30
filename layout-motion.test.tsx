// @vitest-environment jsdom
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { keyMovesLayout, useMapMotion } from "./layout-motion";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("animates background reordering without stretching text or treating scrolling as movement", () => {
  const cancel = vi.fn();
  const animate = vi.fn(
    (_keyframes: Keyframe[], _options: KeyframeAnimationOptions) => ({
      cancel,
      playState: "finished",
    }),
  );
  const original = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "animate",
  );
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  let offset = 0;
  let zoom = 1;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const top = offset - (this.parentElement?.scrollTop ?? 0);
      return {
        x: 0,
        y: top,
        left: 0,
        top,
        width: 250,
        height: 180,
        right: 250,
        bottom: top + 180,
        toJSON() {},
      };
    },
  );
  function Example({ version }: { version: number }) {
    const ref = useRef<HTMLDivElement>(null);
    useMapMotion(ref, String(version), zoom);
    return (
      <div ref={ref} data-testid="canvas">
        <div data-layout-id="one">Task</div>
      </div>
    );
  }
  const view = render(<Example version={0} />);
  offset = 90;
  view.rerender(<Example version={1} />);
  expect(animate).toHaveBeenCalledOnce();
  // Zoom uses camera compensation; it must not also animate stale geometry.
  zoom = 0.6;
  offset = 140;
  view.rerender(<Example version={3} />);
  expect(animate).toHaveBeenCalledOnce();
  offset = 200;
  view.rerender(<Example version={4} />);
  expect(animate.mock.calls[1]?.[0]?.[0]).toMatchObject({
    transform: "translate(0px, -60px)",
  });
  expect(animate.mock.calls[0]).toEqual([
    [
      expect.objectContaining({ transform: "translate(0px, -90px)" }),
      expect.objectContaining({ transform: "none" }),
    ],
    expect.objectContaining({ duration: 320 }),
  ]);
  view.getByTestId("canvas").scrollTop = 70;
  view.rerender(<Example version={5} />);
  expect(animate).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(cancel).toHaveBeenCalled();
  if (original)
    Object.defineProperty(HTMLElement.prototype, "animate", original);
  else delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

it("measures on keys that can move the map, never on typing in an editor", () => {
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  const inner = document.createElement("span");
  editor.append(inner);
  const button = document.createElement("button");
  const textarea = document.createElement("textarea");
  const plain = document.createElement("div");
  document.body.append(editor, button, textarea, plain);
  for (const key of ["a", " ", "Enter", "Escape"]) {
    expect(keyMovesLayout({ key, target: inner })).toBe(false);
    expect(keyMovesLayout({ key, target: textarea })).toBe(false);
  }
  expect(keyMovesLayout({ key: "a", target: button })).toBe(false);
  expect(keyMovesLayout({ key: "Escape", target: button })).toBe(true);
  expect(keyMovesLayout({ key: "Enter", target: button })).toBe(true);
  expect(keyMovesLayout({ key: " ", target: button })).toBe(true);
  expect(keyMovesLayout({ key: " ", target: plain })).toBe(false);
  expect(keyMovesLayout({ key: "Escape", target: plain })).toBe(true);
  document.body.replaceChildren();
});
