import { describe, expect, it } from "vitest";

import {
  initialState,
  reduceEvent,
  toRows,
  withUserPrompt,
  type SessionState,
} from "./session";
import type { RuntimeEvent } from "./types";

let seq = 0;
function ev(
  event: string,
  fields: Partial<RuntimeEvent> & { payload?: RuntimeEvent["payload"] } = {},
): RuntimeEvent {
  seq += 1;
  return {
    seq,
    event,
    kind: event,
    thread_id: "thread-1",
    turn_id: fields.turn_id ?? "turn-1",
    item_id: fields.item_id ?? null,
    timestamp: new Date().toISOString(),
    payload: fields.payload ?? {},
  };
}

function fold(events: RuntimeEvent[], from: SessionState = initialState()): SessionState {
  return events.reduce(reduceEvent, from);
}

const STREAM: RuntimeEvent[] = [
  ev("turn.started", { turn_id: "turn-1" }),
  ev("item.started", {
    turn_id: "turn-1",
    item_id: "i1",
    payload: { item: { id: "i1", turn_id: "turn-1", kind: "agent_message", status: "in_progress", summary: "" } },
  }),
  ev("item.delta", { turn_id: "turn-1", item_id: "i1", payload: { delta: "Hello ", kind: "agent_message" } }),
  ev("item.delta", { turn_id: "turn-1", item_id: "i1", payload: { delta: "world", kind: "agent_message" } }),
  ev("item.completed", {
    turn_id: "turn-1",
    item_id: "i1",
    payload: { item: { id: "i1", turn_id: "turn-1", kind: "agent_message", status: "completed", summary: "Hello world", detail: "Hello world" } },
  }),
  ev("turn.completed", { turn_id: "turn-1" }),
];

describe("session reducer", () => {
  it("accumulates streaming deltas into the message text", () => {
    // Stop before completion to observe the live, in-progress state.
    const live = fold(STREAM.slice(0, 4));
    const rows = toRows(live);
    const message = rows.find((r) => r.kind === "message");
    expect(message?.text).toBe("Hello world");
    expect(message?.status).toBe("in_progress");
    expect(live.streaming).toBe(true);
  });

  it("finalizes text authoritatively and stops streaming", () => {
    const done = fold(STREAM);
    const message = toRows(done).find((r) => r.kind === "message");
    expect(message?.text).toBe("Hello world");
    expect(message?.status).toBe("completed");
    expect(done.streaming).toBe(false);
  });

  it("is idempotent across a full backlog replay (since_seq=0)", () => {
    // Replaying the same backlog must not double the message text.
    const once = fold(STREAM);
    const twice = fold(STREAM, once);
    const message = toRows(twice).find((r) => r.kind === "message");
    expect(message?.text).toBe("Hello world");
    const messageRows = toRows(twice).filter((r) => r.kind === "message");
    expect(messageRows).toHaveLength(1);
  });

  it("renders the user prompt before its turn's items", () => {
    let state = withUserPrompt(initialState(), "turn-1", "do the thing");
    state = fold(STREAM, state);
    const rows = toRows(state);
    expect(rows[0]?.kind).toBe("user");
    expect(rows[0]?.text).toBe("do the thing");
    expect(rows[1]?.kind).toBe("message");
  });

  it("tracks approval lifecycle", () => {
    let state = fold([
      ev("turn.started", { turn_id: "turn-1" }),
      ev("approval.required", {
        turn_id: "turn-1",
        payload: { approval_id: "ap1", tool_name: "shell", description: "rm -rf build" },
      }),
    ]);
    let approval = toRows(state).find((r) => r.kind === "approval");
    expect(approval?.status).toBe("pending");
    expect(approval?.approvalId).toBe("ap1");

    state = reduceEvent(
      state,
      ev("approval.decided", { turn_id: "turn-1", payload: { approval_id: "ap1", decision: "allow" } }),
    );
    approval = toRows(state).find((r) => r.kind === "approval");
    expect(approval?.status).toBe("decided");
    expect(approval?.decision).toBe("allow");
  });
});
