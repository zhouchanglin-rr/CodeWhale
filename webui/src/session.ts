// Pure session-state reconstruction from the runtime SSE stream.
//
// Design notes for correctness:
//   * Events are grouped by turn; within a turn the user prompt always renders
//     first, then items in arrival order — independent of event timing.
//   * Replay is idempotent. The SSE endpoint with `since_seq=0` re-emits the
//     whole backlog, so:
//       - `item.completed` / `item.failed` are AUTHORITATIVE: they set the
//         item text from the persisted record.
//       - `item.delta` is applied only while an item is `in_progress`, so
//         replayed deltas never corrupt an already-finalized item.
//   * User prompts are not streamed as items (the runtime stores them only as
//     the turn's `input_summary`), so they are seeded from `GET /v1/threads/{id}`
//     and added optimistically on send.

import type { RuntimeEvent, ThreadDetail, TurnItemKind } from "./types";

export type BlockKind =
  | "message"
  | "reasoning"
  | "tool"
  | "compaction"
  | "status"
  | "error"
  | "approval";

export type BlockStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "interrupted"
  | "canceled"
  | "pending"
  | "decided";

export interface Block {
  id: string;
  turnId: string;
  kind: BlockKind;
  /** Primary body: message/reasoning content, or a tool's result/output. */
  text: string;
  status: BlockStatus;
  toolName?: string;
  /** Concise one-line summary shown collapsed (tools, approvals). */
  title?: string;
  /** Tool call arguments (pretty JSON), kept separate from the result. */
  toolInput?: string;
  approvalId?: string;
  decision?: string;
}

export interface TurnGroup {
  id: string;
  userText: string;
  itemOrder: string[];
  status?: string;
}

export interface SessionState {
  turnOrder: string[];
  turns: Record<string, TurnGroup>;
  blocks: Record<string, Block>;
  activeTurnId: string | null;
  streaming: boolean;
  lastSeq: number;
}

const LOOSE_TURN = "__loose__";

export function initialState(): SessionState {
  return {
    turnOrder: [],
    turns: {},
    blocks: {},
    activeTurnId: null,
    streaming: false,
    lastSeq: 0,
  };
}

function ensureTurn(state: SessionState, turnId: string): SessionState {
  if (state.turns[turnId]) return state;
  return {
    ...state,
    turnOrder: [...state.turnOrder, turnId],
    turns: {
      ...state.turns,
      [turnId]: { id: turnId, userText: "", itemOrder: [] },
    },
  };
}

/** Insert or overwrite a block, attaching it to its turn's item order once. */
function putBlock(state: SessionState, block: Block): SessionState {
  const next = ensureTurn(state, block.turnId);
  const turn = next.turns[block.turnId];
  const itemOrder = turn.itemOrder.includes(block.id)
    ? turn.itemOrder
    : [...turn.itemOrder, block.id];
  return {
    ...next,
    blocks: { ...next.blocks, [block.id]: block },
    turns: { ...next.turns, [block.turnId]: { ...turn, itemOrder } },
  };
}

function kindFromItem(kind: TurnItemKind, hasTool: boolean): BlockKind {
  if (hasTool) return "tool";
  switch (kind) {
    case "agent_message":
    case "user_message":
      return "message";
    case "agent_reasoning":
      return "reasoning";
    case "context_compaction":
      return "compaction";
    case "error":
      return "error";
    case "tool_call":
    case "file_change":
    case "command_execution":
      return "tool";
    case "status":
    default:
      return "status";
  }
}

function kindFromDelta(kind: string | undefined): BlockKind {
  switch (kind) {
    case "agent_reasoning":
      return "reasoning";
    case "tool_call":
      return "tool";
    case "agent_message":
    default:
      return "message";
  }
}

function toStatus(status: string | undefined, fallback: BlockStatus): BlockStatus {
  switch (status) {
    case "queued":
    case "in_progress":
    case "completed":
    case "failed":
    case "interrupted":
    case "canceled":
      return status;
    default:
      return fallback;
  }
}

function formatToolInput(input: unknown): string {
  if (input == null) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * A concise, human one-liner for a tool call (Claude/Codex style), derived from
 * the most meaningful argument rather than dumping the whole input object.
 */
function summarizeTool(name: string | undefined, input: unknown): string {
  const base = name ?? "tool";
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const keys = [
      "command",
      "cmd",
      "script",
      "path",
      "file_path",
      "file",
      "filename",
      "pattern",
      "query",
      "url",
      "title",
    ];
    for (const key of keys) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) {
        return `${base}  ·  ${truncate(value, 90)}`;
      }
    }
  }
  return base;
}

const TURN_DONE = new Set([
  "completed",
  "failed",
  "interrupted",
  "canceled",
  "aborted",
]);

/** Fold a single runtime event into the session state. */
export function reduceEvent(state: SessionState, ev: RuntimeEvent): SessionState {
  const seqAdvanced =
    typeof ev.seq === "number" && ev.seq > state.lastSeq
      ? { ...state, lastSeq: ev.seq }
      : state;
  state = seqAdvanced;

  const turnId = ev.turn_id ?? state.activeTurnId ?? LOOSE_TURN;
  const payload = ev.payload ?? {};

  switch (ev.event) {
    case "turn.started": {
      const s = ensureTurn(state, turnId);
      return { ...s, activeTurnId: turnId, streaming: true };
    }
    case "turn.lifecycle": {
      const s = ensureTurn(state, turnId);
      const status = payload.status;
      const turn = s.turns[turnId];
      const done = !!status && TURN_DONE.has(status);
      return {
        ...s,
        streaming: done ? false : s.streaming,
        turns: { ...s.turns, [turnId]: { ...turn, status } },
      };
    }
    case "turn.completed": {
      const s = ensureTurn(state, turnId);
      const turn = s.turns[turnId];
      return {
        ...s,
        streaming: false,
        turns: { ...s.turns, [turnId]: { ...turn, status: "completed" } },
      };
    }
    case "item.started": {
      if (!ev.item_id) return state;
      if (state.blocks[ev.item_id]) return ensureTurn(state, turnId); // replay: keep
      const item = payload.item;
      const tool = payload.tool;
      const kind = item ? kindFromItem(item.kind, !!tool) : tool ? "tool" : "status";
      const toolName = tool?.name ?? (kind === "tool" ? item?.summary : undefined);
      let text = "";
      let toolInput: string | undefined;
      let title: string | undefined;
      if (tool) {
        toolInput = formatToolInput(tool.input);
        title = summarizeTool(toolName, tool.input);
      } else if (item?.detail) {
        text = item.detail;
      }
      return putBlock(state, {
        id: ev.item_id,
        turnId,
        kind,
        text,
        status: toStatus(item?.status, "in_progress"),
        toolName,
        toolInput,
        title,
      });
    }
    case "item.delta": {
      if (!ev.item_id) return state;
      const delta = payload.delta ?? "";
      const existing = state.blocks[ev.item_id];
      if (!existing) {
        return putBlock(state, {
          id: ev.item_id,
          turnId,
          kind: kindFromDelta(payload.kind),
          text: delta,
          status: "in_progress",
        });
      }
      // Idempotent replay: never extend a finalized item.
      if (existing.status !== "in_progress") return state;
      return {
        ...state,
        blocks: {
          ...state.blocks,
          [ev.item_id]: { ...existing, text: existing.text + delta },
        },
      };
    }
    case "item.completed":
    case "item.failed": {
      if (!ev.item_id) return state;
      const item = payload.item;
      const existing = state.blocks[ev.item_id];
      const kind = existing?.kind ?? (item ? kindFromItem(item.kind, false) : "status");
      const status: BlockStatus =
        ev.event === "item.failed" ? "failed" : toStatus(item?.status, "completed");
      const text = item?.detail ?? item?.summary ?? existing?.text ?? "";
      return putBlock(state, {
        id: ev.item_id,
        turnId: existing?.turnId ?? turnId,
        kind,
        text,
        status,
        toolName: existing?.toolName ?? (kind === "tool" ? item?.summary : undefined),
        toolInput: existing?.toolInput,
        title:
          existing?.title ??
          (kind === "tool" ? existing?.toolName ?? item?.summary : undefined),
      });
    }
    case "approval.required": {
      const approvalId = payload.approval_id ?? payload.id;
      if (!approvalId || state.blocks[approvalId]) return state;
      return putBlock(state, {
        id: approvalId,
        turnId,
        kind: "approval",
        title: payload.tool_name ?? "approval required",
        text: payload.description ?? "",
        status: "pending",
        approvalId,
        toolName: payload.tool_name,
      });
    }
    case "approval.decided":
    case "approval.timeout": {
      const approvalId = payload.approval_id ?? payload.id;
      if (!approvalId) return state;
      const existing = state.blocks[approvalId];
      if (!existing) return state;
      const decision =
        ev.event === "approval.timeout" ? "timeout" : payload.decision ?? "decided";
      return {
        ...state,
        blocks: {
          ...state.blocks,
          [approvalId]: { ...existing, status: "decided", decision },
        },
      };
    }
    case "sandbox.denied": {
      const id = `denied:${ev.seq}`;
      const text = `Sandbox denied: ${payload.tool_name ?? ""}\n${payload.reason ?? ""}`.trim();
      return putBlock(state, { id, turnId, kind: "error", text, status: "failed" });
    }
    default:
      // thread.started, turn.steered, turn.interrupt_requested, coherence.state
      // carry no transcript content.
      return state;
  }
}

/** Attach an optimistic user prompt to a turn (called on send). */
export function withUserPrompt(
  state: SessionState,
  turnId: string,
  text: string,
): SessionState {
  const s = ensureTurn(state, turnId);
  const turn = s.turns[turnId];
  return {
    ...s,
    activeTurnId: turnId,
    streaming: true,
    turns: { ...s.turns, [turnId]: { ...turn, userText: text } },
  };
}

/**
 * Build initial state from a thread detail snapshot.
 *
 * Only turn structure + user prompts are seeded here. Item content (assistant
 * messages, reasoning, tools) is intentionally NOT seeded: the SSE stream
 * opened with `since_seq=0` replays the full item backlog, and reconstructing
 * items from a single source avoids double-counting an in-progress item whose
 * partial text would otherwise be both seeded and re-appended via delta replay.
 */
export function seedFromDetail(detail: ThreadDetail): SessionState {
  let state = initialState();
  for (const turn of detail.turns) {
    state = ensureTurn(state, turn.id);
    state = {
      ...state,
      turns: {
        ...state.turns,
        [turn.id]: {
          ...state.turns[turn.id],
          userText: turn.input_summary ?? "",
          status: turn.status,
        },
      },
    };
  }
  const lastTurn = detail.turns[detail.turns.length - 1];
  state.activeTurnId = lastTurn ? lastTurn.id : null;
  return state;
}

/** Flatten state into render rows: each turn's prompt then its items. */
export interface Row {
  key: string;
  turnId: string;
  kind: BlockKind | "user";
  text: string;
  status?: BlockStatus;
  toolName?: string;
  title?: string;
  toolInput?: string;
  approvalId?: string;
  decision?: string;
}

export function toRows(state: SessionState): Row[] {
  const rows: Row[] = [];
  for (const turnId of state.turnOrder) {
    const turn = state.turns[turnId];
    if (!turn) continue;
    if (turn.userText.trim()) {
      rows.push({
        key: `user:${turnId}`,
        turnId,
        kind: "user",
        text: turn.userText,
      });
    }
    for (const itemId of turn.itemOrder) {
      const block = state.blocks[itemId];
      if (!block) continue;
      rows.push({
        key: block.id,
        turnId,
        kind: block.kind,
        text: block.text,
        status: block.status,
        toolName: block.toolName,
        title: block.title,
        toolInput: block.toolInput,
        approvalId: block.approvalId,
        decision: block.decision,
      });
    }
  }
  return rows;
}
