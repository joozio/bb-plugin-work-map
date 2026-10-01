// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { parseBlocks, safeHref, SafeMarkdown } from "./markdown";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  UrlLink: (props: Record<string, unknown>) => <a {...props} />,
}));
afterEach(cleanup);

describe("task text as Markdown", () => {
  it("renders headings, lists, task boxes, quotes, code, rules and tables as elements", () => {
    const text = [
      "# Plan",
      "Some *lead* with **weight** and `code` and ~~gone~~.",
      "",
      "- first",
      "- [x] done box",
      "  continued line",
      "- [ ] open box",
      "",
      "1. one",
      "2. two",
      "",
      "> quoted words",
      "",
      "```sh",
      "echo <b>raw</b>",
      "```",
      "",
      "---",
      "",
      "| a | b |",
      "|---|---:|",
      "| 1 | 2 |",
    ].join("\n");
    const { container } = render(<SafeMarkdown text={text} />);
    expect(container.querySelector("h4")?.textContent).toBe("Plan");
    expect(container.querySelector("em")?.textContent).toBe("lead");
    expect(container.querySelector("strong")?.textContent).toBe("weight");
    expect(container.querySelector("p code")?.textContent).toBe("code");
    expect(container.querySelector("del")?.textContent).toBe("gone");
    const items = Array.from(container.querySelectorAll("ul li"));
    expect(items.map((li) => li.textContent)).toEqual([
      "first",
      "☑done boxcontinued line",
      "☐open box",
    ]);
    expect(items[1].getAttribute("data-checked")).toBe("true");
    expect(
      Array.from(container.querySelectorAll("ol li"), (li) => li.textContent),
    ).toEqual(["one", "two"]);
    expect(container.querySelector("blockquote p")?.textContent).toBe(
      "quoted words",
    );
    expect(container.querySelector("pre code")?.textContent).toBe(
      "echo <b>raw</b>",
    );
    expect(container.querySelector("pre b")).toBeNull();
    expect(container.querySelector("hr")).toBeTruthy();
    expect(container.querySelector("th")?.textContent).toBe("a");
    expect(container.querySelectorAll("th")[1].getAttribute("style")).toContain(
      "right",
    );
    expect(container.querySelector("td")?.textContent).toBe("1");
  });
  it("keeps raw HTML and scripts as text and follows only safe links", () => {
    const text = [
      '<script>alert(1)</script> <img src=x onerror="alert(2)"> <b>bold?</b>',
      "[run](javascript:alert(3)) [data](data:text/html,x) [ok](https://example.test/a) [app](/plugins/tasks/tasks/task/ABC-1)",
      "![shot](https://example.test/shot.png) <https://example.test/auto> and https://example.test/bare. end",
    ].join("\n\n");
    const { container } = render(<SafeMarkdown text={text} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.innerHTML).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(container.innerHTML).toContain("&lt;img src=x onerror=");
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "https://example.test/a",
      "/plugins/tasks/tasks/task/ABC-1",
      "https://example.test/shot.png",
      "https://example.test/auto",
      "https://example.test/bare",
    ]);
    expect(container.textContent).toContain("[run](javascript:alert(3))");
    expect(container.textContent).toContain("[data](data:text/html,x)");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[2].textContent).toBe("Image: shot");
    expect(container.textContent).toContain("https://example.test/bare. end");
    expect(safeHref("JAVASCRIPT:void(0)")).toBeNull();
    expect(safeHref("//evil.test")).toBeNull();
    expect(safeHref(" https://a.test/x ")).toBe("https://a.test/x");
  });
  it("keeps single newlines as line breaks and parses nested lists and lazy text", () => {
    const text = "Line one\nLine two\n\n- outer\n  - inner\n- next\nlazy tail";
    const blocks = parseBlocks(text);
    expect(blocks[0]).toEqual({ type: "p", text: "Line one\nLine two" });
    const list = blocks[1];
    expect(list.type).toBe("list");
    if (list.type !== "list") return;
    expect(list.items).toHaveLength(2);
    expect(list.items[0].blocks.map((b) => b.type)).toEqual(["p", "list"]);
    expect(list.items[1].blocks).toEqual([{ type: "p", text: "next\nlazy tail" }]);
    const { container } = render(<SafeMarkdown text={text} />);
    expect(container.querySelectorAll("p br")).toHaveLength(1);
    expect(container.querySelector("ul ul li")?.textContent).toBe("inner");
  });
  it("renders a structured task description the way agents write them", () => {
    const text =
      "Why: the thing broke twice.\n\nWhat happened:\n1. First step ran.\n2. Second step failed (see `log.txt`).\n\nNEXT STEP: pick 1 or 2.\n\nEvidence: automation/logs/x.log";
    const { container } = render(<SafeMarkdown text={text} />);
    expect(container.querySelectorAll("p")).toHaveLength(4);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("ol")?.getAttribute("start")).toBeNull();
  });
});
