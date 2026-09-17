import { describe, expect, it } from "vitest";
import { previewExcerpt, sessionPreview } from "./preview";

describe("session excerpts", () => {
  it("keeps Markdown paragraphs, lists, tables and code intact in the response", () => {
    const text =
      "## Options\n\nChoose **one**.\n\n- First\n- Second\n\n| Option | Status |\n| :--- | ---: |\n| First | Ready |\n\n```ts\nconst n = 1;\n```";
    expect(sessionPreview(text).text).toBe(text);
    expect(sessionPreview(text).truncated).toBe(false);
    expect(sessionPreview(text).excerpt).not.toContain("|");
  });

  it("summarizes table-only cards with their headings, including optional outer pipes", () => {
    expect(
      previewExcerpt("| Option | Status |\n| --- | --- |\n| First | Ready |"),
    ).toBe("Table · Option · Status");
    expect(previewExcerpt("Option | Status\n:--- | ---:\nFirst | Ready")).toBe(
      "Table · Option · Status",
    );
    expect(previewExcerpt("| Status |\n| --- |\n| Ready |")).toBe(
      "Table · Status",
    );
    expect(
      previewExcerpt("| Option | Status |\n|-|-|\n| First | Ready |"),
    ).toBe("Table · Option · Status");
  });

  it("keeps prose around multiple tables and leaves ordinary pipe text alone", () => {
    expect(
      previewExcerpt(
        "Summary.\n\nA | B\n--- | ---\nx | y\n\nNext step.\n\nC | D\n--- | ---\nz | w",
      ),
    ).toBe("Summary. Next step.");
    expect(previewExcerpt("Choose A | B.")).toBe("Choose A | B.");
    expect(
      previewExcerpt(
        "| Option | Status |\n|-|-|\n| First | Ready |\n\nSee A | B for details.",
      ),
    ).toBe("See A | B for details.");
  });

  it("bounds a long table at a whole row and reports omitted content", () => {
    const row = "| First | A detailed comparison of this option. |\n";
    const source = "| Option | Notes |\n| --- | --- |\n" + row.repeat(200);
    const result = sessionPreview(source);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(6000);
    expect(result.text.endsWith(row.trimEnd())).toBe(true);
    expect(source.startsWith(result.text)).toBe(true);
    expect(result.excerpt).toBe("Table · Option · Notes");
  });

  it("bounds even a single long line, and handles an empty response", () => {
    const result = sessionPreview("a".repeat(10000));
    expect(result.text).toHaveLength(6000);
    expect(result.excerpt).toHaveLength(240);
    expect(result.truncated).toBe(true);
    expect(sessionPreview(" \n ")).toEqual({
      text: "",
      excerpt: "",
      truncated: false,
    });
  });
  it("preserves leading indentation and trailing line breaks used by Markdown", () => {
    const text = "    const sample = 1;\n";
    expect(sessionPreview(text).text).toBe(text);
  });
});
