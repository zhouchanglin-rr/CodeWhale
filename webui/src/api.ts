// Thin typed client for the CodeWhale runtime API.
//
// Auth: the runtime accepts a bearer token via the `Authorization` header for
// fetch calls, and via a `?token=` query param for the SSE endpoint (since
// EventSource cannot set headers). The token is held in localStorage.

import type {
  SessionOptions,
  StartTurnResponse,
  ThreadDetail,
  ThreadRecord,
  ThreadSummary,
} from "./types";

const TOKEN_KEY = "codewhale_runtime_token";

/** Base URL for the runtime API. Empty string => same-origin (Vite proxy). */
const BASE = (import.meta.env.VITE_RUNTIME_BASE ?? "").replace(/\/$/, "");

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token.trim());
}

/** Lift a `?token=` value out of the URL into storage, then scrub the URL. */
export function captureTokenFromUrl(): void {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("token");
  if (!fromUrl) return;
  setToken(fromUrl);
  params.delete("token");
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: authHeaders((init.headers as Record<string, string>) ?? {}),
  });
  if (!res.ok) {
    let message = await res.text();
    try {
      const parsed = JSON.parse(message);
      message = parsed?.error?.message ?? message;
    } catch {
      // keep raw body
    }
    throw new ApiError(message || `HTTP ${res.status}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function listThreads(limit = 60): Promise<ThreadSummary[]> {
  return request<ThreadSummary[]>(
    `/v1/threads/summary?limit=${limit}&include_archived=false`,
  );
}

export function getThread(id: string): Promise<ThreadDetail> {
  return request<ThreadDetail>(`/v1/threads/${encodeURIComponent(id)}`);
}

export function createThread(opts: SessionOptions): Promise<ThreadRecord> {
  return request<ThreadRecord>("/v1/threads", {
    method: "POST",
    body: JSON.stringify({
      mode: "agent",
      allow_shell: opts.allowShell,
      trust_mode: opts.trustMode,
      auto_approve: opts.autoApprove,
    }),
  });
}

export function startTurn(
  threadId: string,
  prompt: string,
  opts: SessionOptions,
): Promise<StartTurnResponse> {
  return request<StartTurnResponse>(
    `/v1/threads/${encodeURIComponent(threadId)}/turns`,
    {
      method: "POST",
      body: JSON.stringify({
        prompt,
        allow_shell: opts.allowShell,
        trust_mode: opts.trustMode,
        auto_approve: opts.autoApprove,
      }),
    },
  );
}

export function steerTurn(
  threadId: string,
  turnId: string,
  prompt: string,
): Promise<unknown> {
  return request(
    `/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(
      turnId,
    )}/steer`,
    { method: "POST", body: JSON.stringify({ prompt }) },
  );
}

export function interruptTurn(
  threadId: string,
  turnId: string,
): Promise<unknown> {
  return request(
    `/v1/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(
      turnId,
    )}/interrupt`,
    { method: "POST", body: "{}" },
  );
}

export function decideApproval(
  approvalId: string,
  decision: "allow" | "deny",
  remember: boolean,
): Promise<{ decision?: string }> {
  return request(`/v1/approvals/${encodeURIComponent(approvalId)}`, {
    method: "POST",
    body: JSON.stringify({ decision, remember }),
  });
}

/** Build the SSE URL for a thread, embedding the token as a query param. */
export function threadEventsUrl(threadId: string, sinceSeq = 0): string {
  const token = getToken();
  const params = new URLSearchParams({ since_seq: String(sinceSeq) });
  if (token) params.set("token", token);
  return `${BASE}/v1/threads/${encodeURIComponent(threadId)}/events?${params.toString()}`;
}
