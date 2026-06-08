import { useEffect, useRef, useState, type ReactNode } from "react";

import type { Row } from "../session";

interface TranscriptProps {
  rows: Row[];
  streaming: boolean;
  onApprove: (
    approvalId: string,
    decision: "allow" | "deny",
    remember: boolean,
  ) => void;
}

/**
 * Lightweight rich-text rendering: split on triple-backtick fences and render
 * code blocks as <pre>. Everything else is plain wrapped text. Handles an
 * unterminated fence during streaming (trailing part rendered as code).
 */
function renderRich(text: string): ReactNode {
  const parts = text.split("```");
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const newline = part.indexOf("\n");
      const body = newline >= 0 ? part.slice(newline + 1) : part;
      return (
        <pre className="code" key={i}>
          {body}
        </pre>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

function statusGlyph(status?: string): string {
  switch (status) {
    case "in_progress":
      return "…";
    case "completed":
    case "decided":
      return "✓";
    case "failed":
      return "✗";
    case "interrupted":
    case "canceled":
      return "⊘";
    default:
      return "";
  }
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="msg user">
      <div className="msg-body">{text}</div>
    </div>
  );
}

function AssistantMessage({ text, cursor }: { text: string; cursor: boolean }) {
  return (
    <div className="msg assistant">
      <div className={"msg-body" + (cursor ? " cursor" : "")}>
        {text ? renderRich(text) : cursor ? "" : null}
      </div>
    </div>
  );
}

function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <div className="reasoning">
      <button className="collapse-head" onClick={() => setOpen((o) => !o)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span>Thought process</span>
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  );
}

function ToolCall({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(row.toolInput?.trim() || row.text.trim());
  return (
    <div className={"tool " + (row.status ?? "")}>
      <button
        className="collapse-head tool-head"
        onClick={() => hasDetail && setOpen((o) => !o)}
        disabled={!hasDetail}
      >
        <span className="chev">{hasDetail ? (open ? "▾" : "▸") : "·"}</span>
        <span className="tool-title">{row.title || row.toolName || "tool"}</span>
        <span className={"tool-status " + (row.status ?? "")}>
          {statusGlyph(row.status)}
        </span>
      </button>
      {open && hasDetail && (
        <div className="tool-body">
          {row.toolInput?.trim() && (
            <pre className="code">{row.toolInput}</pre>
          )}
          {row.text.trim() && <pre className="code result">{row.text}</pre>}
        </div>
      )}
    </div>
  );
}

function Approval({
  row,
  onApprove,
}: {
  row: Row;
  onApprove: TranscriptProps["onApprove"];
}) {
  return (
    <div className="block approval">
      <div className="block-title">⚠ Approval required · {row.title}</div>
      {row.text.trim() && <div className="block-body">{row.text}</div>}
      {row.approvalId && row.status === "pending" && (
        <div className="approval-actions">
          <button
            className="primary"
            onClick={() => onApprove(row.approvalId!, "allow", false)}
          >
            Allow
          </button>
          <button
            className="danger"
            onClick={() => onApprove(row.approvalId!, "deny", false)}
          >
            Deny
          </button>
        </div>
      )}
      {row.decision && <div className="note">decision: {row.decision}</div>}
    </div>
  );
}

export function Transcript({ rows, streaming, onApprove }: TranscriptProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // Only auto-scroll when the user is already near the bottom, so reading
  // history isn't yanked away by streaming deltas.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    if (pinnedRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="transcript" ref={containerRef} onScroll={onScroll}>
        <div className="empty">Type a message below to start the conversation.</div>
        <div ref={endRef} />
      </div>
    );
  }

  return (
    <div className="transcript" ref={containerRef} onScroll={onScroll}>
      {rows.map((row, i) => {
        const last = i === rows.length - 1;
        switch (row.kind) {
          case "user":
            return <UserMessage key={row.key} text={row.text} />;
          case "message":
            return (
              <AssistantMessage
                key={row.key}
                text={row.text}
                cursor={streaming && last && row.status === "in_progress"}
              />
            );
          case "reasoning":
            return <Reasoning key={row.key} text={row.text} />;
          case "tool":
            return <ToolCall key={row.key} row={row} />;
          case "approval":
            return <Approval key={row.key} row={row} onApprove={onApprove} />;
          case "error":
            return (
              <div className="block error" key={row.key}>
                <div className="block-title">✗ Error</div>
                <div className="block-body">{row.text}</div>
              </div>
            );
          case "compaction":
            return (
              <div className="note" key={row.key}>
                — context compacted —
              </div>
            );
          case "status":
          default:
            return row.text.trim() ? (
              <div className="note" key={row.key}>
                {row.text}
              </div>
            ) : null;
        }
      })}
      <div ref={endRef} />
    </div>
  );
}
