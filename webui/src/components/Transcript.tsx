import { useEffect, useRef } from "react";

import type { Row } from "../session";

const LABELS: Record<Row["kind"], string> = {
  user: "you",
  message: "assistant",
  reasoning: "thinking",
  tool: "tool",
  compaction: "context",
  status: "status",
  error: "error",
  approval: "approval",
};

interface TranscriptProps {
  rows: Row[];
  streaming: boolean;
  onApprove: (
    approvalId: string,
    decision: "allow" | "deny",
    remember: boolean,
  ) => void;
}

export function Transcript({ rows, streaming, onApprove }: TranscriptProps) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  // Track whether the user is scrolled to the bottom; only auto-scroll if so,
  // so reading history isn't interrupted by streaming deltas.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  useEffect(() => {
    if (pinnedRef.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [rows]);

  if (rows.length === 0) {
    return (
      <div className="transcript" ref={containerRef} onScroll={onScroll}>
        <div className="empty">
          No messages yet. Type a prompt below to start the conversation.
        </div>
        <div ref={endRef} />
      </div>
    );
  }

  return (
    <div className="transcript" ref={containerRef} onScroll={onScroll}>
      {rows.map((row, i) => {
        const last = i === rows.length - 1;
        const showCursor =
          streaming &&
          last &&
          row.status === "in_progress" &&
          (row.kind === "message" || row.kind === "reasoning");
        return (
          <div key={row.key} className={`row ${row.kind}`}>
            <span className="label">
              {row.kind === "tool" && row.toolName ? row.toolName : LABELS[row.kind]}
              {row.status && row.kind !== "user" && (
                <span className={`badge ${row.status}`}>{row.status}</span>
              )}
            </span>
            <span className={showCursor ? "cursor" : undefined}>{row.text}</span>
            {row.kind === "approval" && row.approvalId && row.status === "pending" && (
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
            {row.kind === "approval" && row.decision && (
              <div className="thread-meta">decision: {row.decision}</div>
            )}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}
