# codewhale-webui

A React (Vite + TypeScript) web interface for the CodeWhale **runtime API** — a
browser client that mirrors the TUI: multi-session switching, live streaming of
assistant messages / reasoning / tool calls, steering, interrupting, and tool
approvals.

This is the agent interaction UI. It is distinct from `web/` (the marketing
site at codewhale.net). It talks to the local runtime server exposed by
`codewhale serve --mobile`, the same REST + SSE surface that backs the built-in
`/mobile` page — but rebuilt as a proper component-based app with a transcript
that groups streaming deltas into items instead of a flat event log.

## Run it

1. Start the runtime API server (defaults to `127.0.0.1:7878`):

   ```bash
   codewhale serve --mobile
   ```

   It prints a bearer token (or set a stable one with `--auth-token` /
   `DEEPSEEK_RUNTIME_TOKEN`). Copy it.

2. Start the web UI dev server:

   ```bash
   cd webui
   npm install
   npm run dev            # http://localhost:5273
   ```

   Vite proxies `/v1` and `/health` to the runtime server, so the browser stays
   same-origin (no CORS setup needed). If the runtime runs elsewhere:

   ```bash
   VITE_RUNTIME_TARGET=http://127.0.0.1:9000 npm run dev
   ```

3. Paste the bearer token into the field at the top of the page (or open the UI
   with `?token=...` once — it is captured into `localStorage` and scrubbed from
   the URL). Then **+ New** to start a session, or pick an existing one.

## Build

```bash
npm run build           # type-check + production bundle into dist/
npm run preview         # serve the built bundle
npm test                # vitest: session-reducer correctness
```

For a production deploy, serve `dist/` from any static host and point it at the
runtime with `VITE_RUNTIME_BASE` (the runtime must allow that origin via its
`--cors-origin` flag), or reverse-proxy `/v1` to the runtime to keep it
same-origin.

## How session state stays correct

The trickiest part of a streaming agent UI is reconstructing a faithful
transcript from an event stream that is also **replayed** on (re)connect. The
runtime's SSE endpoint at `/v1/threads/{id}/events?since_seq=0` re-emits the
entire backlog, so the reducer must be idempotent.

`src/session.ts` is a pure reducer (`reduceEvent`) with these guarantees:

- **Items are grouped by turn**; within a turn the user prompt always renders
  first, then items in arrival order — independent of event timing.
- **`item.completed` / `item.failed` are authoritative**: they set an item's
  text from the persisted record, so a replayed item ends up correct regardless
  of how its deltas arrived.
- **`item.delta` only extends an `in_progress` item**, so replayed deltas can
  never corrupt an already-finalized message.
- **User prompts** are not streamed as items (the runtime stores them only as a
  turn's `input_summary`), so they are seeded from `GET /v1/threads/{id}` and
  added optimistically on send. Item *content* is sourced solely from the SSE
  stream to avoid double-counting an in-progress item.

`src/session.test.ts` exercises streaming accumulation, authoritative
finalization, idempotent full-backlog replay, user-prompt ordering, and the
approval lifecycle.

## Layout

```
webui/
├── index.html
├── vite.config.ts            # dev proxy to the runtime API + SSE passthrough
├── src/
│   ├── main.tsx              # React entry
│   ├── App.tsx               # shell: threads, selection, options, token bar
│   ├── api.ts                # typed REST client + SSE URL builder (bearer auth)
│   ├── types.ts              # wire types mirroring runtime_api / runtime_threads
│   ├── session.ts            # pure event reducer + render-row projection
│   ├── session.test.ts       # reducer unit tests
│   ├── useThreadSession.ts   # SSE lifecycle + detail seed + turn actions
│   ├── styles.css            # dark terminal palette (matches the TUI)
│   └── components/
│       ├── Sidebar.tsx       # multi-session list + new/refresh
│       ├── Transcript.tsx    # message-first transcript: prose messages, collapsible tools, tucked-away reasoning, muted status
│       └── Composer.tsx      # prompt input, shell/auto/trust toggles, send/steer/interrupt
```

## Presentation

The transcript favours readability over raw event detail, in the spirit of
Claude Code / Codex:

- **Assistant messages are primary** prose (fenced code blocks rendered as
  code), with a live cursor while streaming.
- **Tool calls collapse** to a one-line summary (`tool · <key arg>`) with a
  status glyph; click to expand the arguments and result.
- **Reasoning is hidden** behind a "Thought process" toggle.
- **Status / compaction events are muted** one-line notes; approvals and errors
  stay prominent.

## Relationship to the abstract UI layer

On the Rust side, the agent session is exposed through `EngineHandle` and the
`crates/tui/src/core/frontend.rs` abstraction (`EventHub` / `Frontend` /
`WebFrontend`). This React app is a concrete consumer of that surface over HTTP:
the runtime serializes engine events to SSE, and this client folds them back
into UI state. The TUI is the other consumer of the same session model.
