import { plainText } from "./model";

const MAX_PREVIEW = 6000;
const MAX_EXCERPT = 240;

function tableCells(line: string) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

/** A card gets prose or table headings, never flattened table rows. */
export function previewExcerpt(markdown: string, limit = MAX_EXCERPT): string {
  const lines = markdown.replace(/```[\s\S]*?```/g, " [code] ").split(/\r?\n/);
  const prose: string[] = [];
  let tableHeading = "";
  for (let i = 0; i < lines.length; i++) {
    const separator = lines[i + 1];
    if (
      lines[i].includes("|") &&
      separator?.includes("|") &&
      tableCells(separator).every((cell) => /^:?-+:?$/.test(cell))
    ) {
      tableHeading ||= `Table · ${tableCells(lines[i]).filter(Boolean).join(" · ")}`;
      i += 2;
      while (i < lines.length && lines[i].includes("|")) i++;
      i--;
    } else prose.push(lines[i]);
  }
  const text = plainText(prose.join("\n")) || plainText(tableHeading);
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** Keep Markdown intact; prefer a whole line when bounding a long response. */
export function sessionPreview(output: string) {
  const source = output.trim() ? output : "";
  const truncated = source.length > MAX_PREVIEW;
  let text = source.slice(0, MAX_PREVIEW);
  if (truncated) {
    const lastLine = text.lastIndexOf("\n");
    if (lastLine >= MAX_PREVIEW / 2) text = text.slice(0, lastLine);
  }
  return { text, excerpt: previewExcerpt(text), truncated };
}

export type SessionPreview = ReturnType<typeof sessionPreview> & {
  error: boolean;
};
