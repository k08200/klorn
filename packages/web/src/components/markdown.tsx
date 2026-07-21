"use client";

import type React from "react";

/**
 * Lightweight markdown renderer — handles code blocks, inline code, bold, italic, lists.
 * No external dependencies.
 */
export function Markdown({ content }: { content: string }) {
  const blocks = parseBlocks(content);

  return (
    <div className="text-sm leading-relaxed space-y-2">
      {blocks.map((block, i) => {
        if (block.type === "code") {
          return (
            <div key={i} className="relative group">
              {block.lang && (
                <span className="text-[10px] text-slate-400 absolute top-2 right-2">
                  {block.lang}
                </span>
              )}
              <pre className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 overflow-x-auto text-xs font-mono">
                <code>{block.text}</code>
              </pre>
            </div>
          );
        }

        return (
          <p key={i} className="whitespace-pre-wrap">
            {renderInline(block.text)}
          </p>
        );
      })}
    </div>
  );
}

interface Block {
  type: "text" | "code";
  text: string;
  lang?: string;
}

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const codeRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) blocks.push({ type: "text", text });
    }
    blocks.push({ type: "code", text: match[2].trim(), lang: match[1] || undefined });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) blocks.push({ type: "text", text });
  }

  if (blocks.length === 0 && content.trim()) {
    blocks.push({ type: "text", text: content });
  }

  return blocks;
}

function renderInline(text: string): (string | React.ReactNode)[] {
  const parts: (string | React.ReactNode)[] = [];
  // Match **bold**, *italic*, `code`
  const inlineRegex = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }

    if (match[2]) {
      parts.push(
        <strong key={key++} className="font-semibold">
          {match[2]}
        </strong>,
      );
    } else if (match[3]) {
      parts.push(
        <em key={key++} className="italic">
          {match[3]}
        </em>,
      );
    } else if (match[4]) {
      parts.push(
        <code
          key={key++}
          className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded text-xs font-mono"
        >
          {match[4]}
        </code>,
      );
    }

    lastIdx = match.index + match[0].length;
  }

  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }

  return parts;
}
