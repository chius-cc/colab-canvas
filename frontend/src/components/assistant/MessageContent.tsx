import { Fragment, type ReactNode } from "react";

function renderInline(text: string): ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return tokens.map((tok, i) => {
    if (tok.startsWith("`") && tok.endsWith("`") && tok.length >= 2) {
      return (
        <code
          key={i}
          className="rounded bg-[#F2EFE9] px-1 py-0.5 font-mono text-[11.5px] text-[#1A1D24]"
        >
          {tok.slice(1, -1)}
        </code>
      );
    }
    if (tok.startsWith("**") && tok.endsWith("**") && tok.length >= 4) {
      return (
        <strong key={i} className="font-semibold text-[#1A1D24]">
          {tok.slice(2, -2)}
        </strong>
      );
    }
    return <Fragment key={i}>{tok}</Fragment>;
  });
}

export function MessageContent({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let listItems: string[] = [];
  let paraLines: string[] = [];

  const flushPara = (key: string) => {
    if (paraLines.length === 0) return;
    blocks.push(
      <p key={key} className="leading-relaxed text-[#1A1D24]">
        {renderInline(paraLines.join(" "))}
      </p>
    );
    paraLines = [];
  };

  const flushList = (key: string) => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={key} className="list-disc pl-5 space-y-1 text-[#1A1D24]">
        {listItems.map((item, idx) => (
          <li key={idx} className="leading-relaxed">
            {renderInline(item)}
          </li>
        ))}
      </ul>
    );
    listItems = [];
  };

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) {
      flushPara(`p-${idx}`);
      flushList(`l-${idx}`);
      return;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushPara(`p-${idx}`);
      flushList(`l-${idx}`);
      blocks.push(
        <h4
          key={`h-${idx}`}
          className="font-semibold text-[#1A1D24] pt-1 text-[13.5px]"
        >
          {renderInline(headingMatch[2])}
        </h4>
      );
      return;
    }

    const bulletMatch = line.match(/^[-*•]\s+(.+)$/) || line.match(/^\d+\.\s+(.+)$/);
    if (bulletMatch) {
      flushPara(`p-${idx}`);
      listItems.push(bulletMatch[1]);
      return;
    }

    flushList(`l-${idx}`);
    paraLines.push(line);
  });

  flushPara("p-end");
  flushList("l-end");

  return <div className="space-y-2 text-[13px]">{blocks}</div>;
}
