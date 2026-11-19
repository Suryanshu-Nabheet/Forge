// Minimal markdown renderer for comments/answers — bold, italic, inline
// code, fenced blocks, links, lists, headings. Deliberately tiny: no HTML
// passthrough (XSS-safe by construction), no dependencies. Text outside
// supported syntax renders as plain text.

import React from "react";

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Tokenize by: `code`, **bold**, *italic*, [text](url), raw text.
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<code key={`${keyPrefix}-c${i}`} className="mono text-[0.9em] bg-[var(--bg-hover)] rounded px-1">{m[1]}</code>);
    } else if (m[2] !== undefined) {
      out.push(<strong key={`${keyPrefix}-b${i}`}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      out.push(<em key={`${keyPrefix}-i${i}`}>{m[3]}</em>);
    } else if (m[4] !== undefined && m[5] !== undefined) {
      out.push(
        <a key={`${keyPrefix}-l${i}`} href={m[5]} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline">
          {m[4]}
        </a>,
      );
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let listItems: string[] = [];
  let codeLines: string[] | null = null;
  let key = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`ul-${key++}`} className="list-disc pl-5 space-y-0.5 my-1">
        {listItems.map((li, i) => <li key={i}>{renderInline(li, `li${key}-${i}`)}</li>)}
      </ul>,
    );
    listItems = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (line.trimStart().startsWith("```")) {
      if (codeLines === null) {
        flushList();
        codeLines = [];
      } else {
        blocks.push(
          <pre key={`pre-${key++}`} className="mono text-[12px] bg-[var(--bg-hover)] border rounded p-3 overflow-x-auto my-1">
            {codeLines.join("\n")}
          </pre>,
        );
        codeLines = null;
      }
      continue;
    }
    if (codeLines !== null) {
      codeLines.push(raw);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const level = h[1]!.length;
      const sizes = ["text-[15px]", "text-[14px]", "text-[13px]", "text-[13px]"];
      blocks.push(
        <div key={`h-${key++}`} className={`${sizes[level - 1]} font-semibold mt-2 mb-1`}>{renderInline(h[2]!, `h${key}`)}</div>,
      );
      continue;
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      listItems.push(li[1]!);
      continue;
    }
    flushList();
    if (line.trim() === "") continue;
    blocks.push(<p key={`p-${key++}`} className="my-0.5">{renderInline(line, `p${key}`)}</p>);
  }
  flushList();
  if (codeLines !== null) {
    blocks.push(
      <pre key={`pre-${key++}`} className="mono text-[12px] bg-[var(--bg-hover)] border rounded p-3 overflow-x-auto my-1">
        {codeLines.join("\n")}
      </pre>,
    );
  }
  return <div className={className}>{blocks}</div>;
}
