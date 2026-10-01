import { Fragment, type CSSProperties, type ReactNode } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";

/**
 * Task text rendered as Markdown through React elements only: headings,
 * lists, quotes, code, tables and links. Nothing is ever set as HTML, so a
 * tag or a script inside a task or a comment stays the text it was typed as.
 * A link is only ever http, https, mailto or an in-app path; an image becomes
 * a link to its file, so nothing in the text loads or runs on its own.
 */
export type Block =
  | { type: "p"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "quote"; blocks: Block[] }
  | {
      type: "list";
      ordered: boolean;
      start: number;
      items: { blocks: Block[]; checked: boolean | null }[];
    }
  | { type: "hr" }
  | {
      type: "table";
      head: string[];
      rows: string[][];
      align: ("left" | "center" | "right" | null)[];
    };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const MARKER = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|?\s*$|^\s*[^|\n]+\|[^\n]*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function startsBlock(line: string) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    MARKER.test(line)
  );
}
function splitRow(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (trimmed[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += trimmed[i];
  }
  cells.push(cell.trim());
  return cells;
}

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let match = line.match(FENCE);
    if (match) {
      const fence = match[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang: match[2], text: body.join("\n") });
      continue;
    }
    match = line.match(HEADING);
    if (match) {
      blocks.push({ type: "h", level: match[1].length, text: match[2] });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (lines[i].trim() && !startsBlock(lines[i]) && body.length))) {
        body.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(body.join("\n")) });
      continue;
    }
    match = line.match(MARKER);
    if (match) {
      const indent = match[1].length;
      const ordered = /\d/.test(match[2]);
      const items: { blocks: Block[]; checked: boolean | null }[] = [];
      while (i < lines.length) {
        const head = lines[i].match(MARKER);
        if (!head || head[1].length !== indent || /\d/.test(head[2]) !== ordered)
          break;
        const width = head[1].length + head[2].length + 1;
        let first = head[3];
        let checked: boolean | null = null;
        const box = first.match(/^\[([ xX])\]\s+(.*)$/);
        if (box) {
          checked = box[1] !== " ";
          first = box[2];
        }
        const body = [first];
        i++;
        // Indented lines belong to the item; a blank line keeps it only when an
        // indented line follows; an unindented line that opens no block runs
        // on lazily.
        while (i < lines.length) {
          const next = lines[i];
          if (!next.trim()) {
            const after = lines[i + 1];
            if (after !== undefined && /^\s+\S/.test(after) && !(after.match(MARKER)?.[1].length === indent)) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          const lead = next.match(/^\s*/)![0].length;
          if (lead > indent) {
            body.push(next.slice(Math.min(lead, width)));
            i++;
            continue;
          }
          if (lead === indent && next.match(MARKER)) break;
          if (startsBlock(next)) break;
          body.push(next);
          i++;
        }
        items.push({ blocks: parseBlocks(body.join("\n")), checked });
      }
      blocks.push({
        type: "list",
        ordered,
        start: ordered ? parseInt(match[2], 10) || 1 : 1,
        items,
      });
      continue;
    }
    if (
      line.includes("|") &&
      TABLE_ROW.test(line) &&
      lines[i + 1] !== undefined &&
      TABLE_RULE.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((cell) =>
        /^:-+:$/.test(cell)
          ? "center"
          : /^-+:$/.test(cell)
            ? "right"
            : /^:-+$/.test(cell)
              ? "left"
              : null,
      );
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", head, rows, align });
      continue;
    }
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", text: para.join("\n") });
  }
  return blocks;
}

/** A link target the renderer will follow; anything else stays as text. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (/^https?:\/\/\S+$/i.test(url) || /^mailto:\S+$/i.test(url)) return url;
  if (/^\/(?!\/)[^\s]*$/.test(url)) return url;
  return null;
}
const ESCAPABLE = /[\\`*_~[\]()!#>|-]/;
const ENDS_LINK = /[.,;:!?)\]'"]+$/;

let keys = 0;
function link(href: string, children: ReactNode, title?: string) {
  const key = `l${keys++}`;
  return href.startsWith("/") ? (
    <UrlLink key={key} href={href} title={title}>
      {children}
    </UrlLink>
  ) : (
    <a
      key={key}
      href={href}
      title={title}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}
export function inline(src: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let text = "";
  let i = 0;
  const flush = () => {
    if (text) out.push(text);
    text = "";
  };
  while (i < src.length) {
    const c = src[i];
    let m: RegExpMatchArray | null = null;
    if (c === "\\" && ESCAPABLE.test(src[i + 1] ?? "")) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      flush();
      out.push(<br key={`b${keys++}`} />);
      i++;
      continue;
    }
    if (c === "`" && (m = src.slice(i).match(/^(`+)([\s\S]*?[^`])\1(?!`)/))) {
      flush();
      out.push(<code key={`c${keys++}`}>{m[2].trim()}</code>);
      i += m[0].length;
      continue;
    }
    if (
      (c === "[" || (c === "!" && src[i + 1] === "[")) &&
      depth < 3 &&
      (m = src
        .slice(i)
        .match(
          /^(!?)\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+"([^"]*)")?\s*\)/,
        ))
    ) {
      const href = safeHref(m[3]);
      flush();
      if (href) {
        const label = m[2] || m[3];
        out.push(
          link(
            href,
            m[1] ? `Image: ${label}` : inline(label, depth + 1),
            m[4],
          ),
        );
      } else text += m[0];
      i += m[0].length;
      continue;
    }
    if (c === "<" && (m = src.slice(i).match(/^<((?:https?:\/\/|mailto:)[^\s>]+)>/))) {
      flush();
      out.push(link(m[1], m[1]));
      i += m[0].length;
      continue;
    }
    if (
      c === "h" &&
      (i === 0 || /[\s(["']/.test(src[i - 1])) &&
      (m = src.slice(i).match(/^https?:\/\/[^\s<]+/))
    ) {
      const url = m[0].replace(ENDS_LINK, "");
      flush();
      out.push(link(url, url));
      i += url.length;
      continue;
    }
    if (
      (c === "*" || c === "_") &&
      src[i + 1] === c &&
      (m = src.slice(i).match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/))
    ) {
      flush();
      out.push(<strong key={`s${keys++}`}>{inline(m[2], depth + 1)}</strong>);
      i += m[0].length;
      continue;
    }
    if (
      (c === "*" || (c === "_" && (i === 0 || !/\w/.test(src[i - 1])))) &&
      (m = src.slice(i).match(/^(\*|_)(?=[^\s*_])([\s\S]*?[^\s*_])\1(?![\w*_])/))
    ) {
      flush();
      out.push(<em key={`e${keys++}`}>{inline(m[2], depth + 1)}</em>);
      i += m[0].length;
      continue;
    }
    if (c === "~" && src[i + 1] === "~" && (m = src.slice(i).match(/^~~(?=\S)([\s\S]*?\S)~~/))) {
      flush();
      out.push(<del key={`d${keys++}`}>{inline(m[1], depth + 1)}</del>);
      i += m[0].length;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

function render(blocks: Block[]): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `k${index}`;
    switch (block.type) {
      case "p":
        return <p key={key}>{inline(block.text)}</p>;
      case "h": {
        // A task's own headings sit under the panel's, so they start at h4.
        const Tag = `h${Math.min(6, block.level + 3)}` as "h4" | "h5" | "h6";
        return <Tag key={key}>{inline(block.text)}</Tag>;
      }
      case "code":
        return (
          <pre key={key} data-lang={block.lang || undefined}>
            <code>{block.text}</code>
          </pre>
        );
      case "quote":
        return <blockquote key={key}>{render(block.blocks)}</blockquote>;
      case "hr":
        return <hr key={key} />;
      case "list": {
        const Tag = block.ordered ? "ol" : "ul";
        return (
          <Tag key={key} start={block.ordered && block.start !== 1 ? block.start : undefined}>
            {block.items.map((item, at) => (
              <li
                key={at}
                className={item.checked === null ? undefined : "wm-md-task"}
                data-checked={item.checked === null ? undefined : item.checked}
              >
                {item.checked !== null && (
                  <span aria-hidden="true" className="wm-md-box">
                    {item.checked ? "☑" : "☐"}
                  </span>
                )}
                {item.blocks.length === 1 && item.blocks[0].type === "p"
                  ? inline(item.blocks[0].text)
                  : render(item.blocks)}
              </li>
            ))}
          </Tag>
        );
      }
      case "table": {
        const style = (at: number): CSSProperties | undefined =>
          block.align[at] ? { textAlign: block.align[at]! } : undefined;
        return (
          <div key={key} className="wm-md-table">
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, at) => (
                    <th key={at} style={style(at)}>
                      {inline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {block.head.map((_, at) => (
                      <td key={at} style={style(at)}>
                        {inline(row[at] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
    }
  });
}

export function SafeMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  keys = 0;
  return (
    <div className={`wm-md ${className ?? ""}`.trim()}>
      {render(parseBlocks(text)).map((node, at) => (
        <Fragment key={at}>{node}</Fragment>
      ))}
    </div>
  );
}
