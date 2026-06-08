// Wire types mirroring the CodeWhale runtime API (crates/tui/src/runtime_api.rs
// and runtime_threads.rs). Only the fields the web client consumes are typed;
// unknown fields are tolerated.

/** Lifecycle of a single transcript item, snake_case on the wire. */
export type TurnItemStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "interrupted"
  | "canceled";

/** Item kind, snake_case on the wire (TurnItemKind). */
export type TurnItemKind =
  | "user_message"
  | "agent_message"
  | "agent_reasoning"
  | "tool_call"
  | "file_change"
  | "command_execution"
  | "context_compaction"
  | "status"
  | "error";

/** `GET /v1/threads/summary` element. */
export interface ThreadSummary {
  id: string;
  title: string;
  preview: string;
  model: string;
  mode: string;
  archived: boolean;
  updated_at: string;
  latest_turn_id?: string | null;
  latest_turn_status?: string | null;
}

/** A persisted turn item (TurnItemRecord). */
export interface TurnItemRecord {
  id: string;
  turn_id: string;
  kind: TurnItemKind;
  status: TurnItemStatus;
  summary: string;
  detail?: string | null;
  metadata?: unknown;
  started_at?: string | null;
  ended_at?: string | null;
}

/** A persisted turn (TurnRecord). */
export interface TurnRecord {
  id: string;
  thread_id: string;
  status: string;
  input_summary: string;
  created_at: string;
  item_ids: string[];
  error?: string | null;
}

/** Thread metadata (ThreadRecord). */
export interface ThreadRecord {
  id: string;
  model: string;
  mode: string;
  allow_shell: boolean;
  trust_mode: boolean;
  auto_approve: boolean;
  archived: boolean;
  title?: string | null;
  updated_at: string;
  latest_turn_id?: string | null;
}

/** `GET /v1/threads/{id}` full detail. */
export interface ThreadDetail {
  thread: ThreadRecord;
  turns: TurnRecord[];
  items: TurnItemRecord[];
}

/** `POST /v1/threads/{id}/turns` response. */
export interface StartTurnResponse {
  thread: ThreadRecord;
  turn: TurnRecord;
}

/**
 * The SSE event envelope (RuntimeEventEnvelope). `event` is the SSE event name;
 * `payload` carries the event-specific body emitted by the runtime.
 */
export interface RuntimeEvent {
  seq: number;
  event: string;
  kind: string;
  thread_id: string;
  turn_id?: string | null;
  item_id?: string | null;
  timestamp: string;
  payload: RuntimeEventPayload;
}

/** Loosely-typed payload union; access is guarded at the use site. */
export interface RuntimeEventPayload {
  status?: string;
  delta?: string;
  /** On item.delta: discriminates agent_message / agent_reasoning / tool_call. */
  kind?: string;
  item?: TurnItemRecord;
  tool?: { id?: string; name?: string; input?: unknown };
  approval_id?: string;
  id?: string;
  tool_name?: string;
  description?: string;
  reason?: string;
  decision?: string;
  [extra: string]: unknown;
}

/** Options applied to a new thread / turn. */
export interface SessionOptions {
  allowShell: boolean;
  autoApprove: boolean;
  trustMode: boolean;
}
