// React hook owning a single thread's live session: it seeds history from the
// detail snapshot, subscribes to the SSE event stream, folds events through the
// pure reducer, and exposes the turn actions (send / steer / interrupt /
// approve).

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "./api";
import type { RuntimeEvent, SessionOptions } from "./types";
import {
  initialState,
  reduceEvent,
  seedFromDetail,
  withUserPrompt,
  type SessionState,
} from "./session";

// Every transcript-bearing event the runtime emits. EventSource delivers named
// events, so each must be subscribed explicitly.
const EVENT_NAMES = [
  "thread.started",
  "turn.started",
  "turn.lifecycle",
  "turn.steered",
  "turn.interrupt_requested",
  "turn.completed",
  "item.started",
  "item.delta",
  "item.completed",
  "item.failed",
  "approval.required",
  "approval.decided",
  "approval.timeout",
  "sandbox.denied",
  "coherence.state",
] as const;

export type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

export interface ThreadSession {
  state: SessionState;
  connection: ConnectionStatus;
  error: string | null;
  activeTurnId: string | null;
  streaming: boolean;
  send: (prompt: string, opts: SessionOptions) => Promise<void>;
  steer: (prompt: string) => Promise<void>;
  interrupt: () => Promise<void>;
  approve: (
    approvalId: string,
    decision: "allow" | "deny",
    remember: boolean,
  ) => Promise<void>;
}

export function useThreadSession(threadId: string | null): ThreadSession {
  const [state, setState] = useState<SessionState>(initialState);
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);
  // Keep a ref to the latest activeTurnId so steer/interrupt read fresh values
  // without re-creating callbacks on every delta.
  const activeTurnRef = useRef<string | null>(null);
  activeTurnRef.current = state.activeTurnId;

  const apply = useCallback((ev: RuntimeEvent) => {
    setState((prev) => reduceEvent(prev, ev));
  }, []);

  useEffect(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    setState(initialState());
    setError(null);

    if (!threadId) {
      setConnection("idle");
      return;
    }

    let cancelled = false;
    setConnection("connecting");

    // Seed turn structure + user prompts from the detail snapshot, then open
    // the stream which replays full item history from seq 0.
    api
      .getThread(threadId)
      .then((detail) => {
        if (cancelled) return;
        setState(seedFromDetail(detail));
      })
      .catch(() => {
        // A brand-new thread may not have a detail yet; the stream still works.
      })
      .finally(() => {
        if (cancelled) return;
        const source = new EventSource(api.threadEventsUrl(threadId, 0));
        sourceRef.current = source;
        source.onopen = () => !cancelled && setConnection("open");
        source.onerror = () => {
          if (cancelled) return;
          // EventSource auto-reconnects; surface a soft warning meanwhile.
          setConnection((c) => (c === "open" ? "error" : c));
        };
        for (const name of EVENT_NAMES) {
          source.addEventListener(name, (raw) => {
            if (cancelled) return;
            const messageEvent = raw as MessageEvent;
            let data: Record<string, unknown> = {};
            try {
              data = JSON.parse(messageEvent.data || "{}");
            } catch {
              return;
            }
            apply({ ...(data as unknown as RuntimeEvent), event: name });
          });
        }
      });

    return () => {
      cancelled = true;
      sourceRef.current?.close();
      sourceRef.current = null;
      setConnection("closed");
    };
  }, [threadId, apply]);

  const send = useCallback(
    async (prompt: string, opts: SessionOptions) => {
      if (!threadId) throw new Error("No thread selected");
      const trimmed = prompt.trim();
      if (!trimmed) return;
      const res = await api.startTurn(threadId, trimmed, opts);
      const turnId = res.turn?.id;
      if (turnId) {
        // Optimistically render the prompt; the stream fills in the response.
        setState((prev) => withUserPrompt(prev, turnId, trimmed));
      }
    },
    [threadId],
  );

  const steer = useCallback(
    async (prompt: string) => {
      const turnId = activeTurnRef.current;
      if (!threadId || !turnId) throw new Error("No active turn to steer");
      const trimmed = prompt.trim();
      if (!trimmed) return;
      await api.steerTurn(threadId, turnId, trimmed);
    },
    [threadId],
  );

  const interrupt = useCallback(async () => {
    const turnId = activeTurnRef.current;
    if (!threadId || !turnId) throw new Error("No active turn to interrupt");
    await api.interruptTurn(threadId, turnId);
  }, [threadId]);

  const approve = useCallback(
    async (
      approvalId: string,
      decision: "allow" | "deny",
      remember: boolean,
    ) => {
      await api.decideApproval(approvalId, decision, remember);
    },
    [],
  );

  return {
    state,
    connection,
    error,
    activeTurnId: state.activeTurnId,
    streaming: state.streaming,
    send,
    steer,
    interrupt,
    approve,
  };
}
