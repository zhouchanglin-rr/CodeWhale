import { useCallback, useEffect, useState } from "react";

import * as api from "./api";
import { Composer } from "./components/Composer";
import { Sidebar } from "./components/Sidebar";
import { Transcript } from "./components/Transcript";
import { toRows } from "./session";
import type { SessionOptions, ThreadSummary } from "./types";
import { useThreadSession } from "./useThreadSession";

const DEFAULT_OPTIONS: SessionOptions = {
  allowShell: false,
  autoApprove: false,
  trustMode: false,
};

export function App() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [options, setOptions] = useState<SessionOptions>(DEFAULT_OPTIONS);
  const [token, setTokenState] = useState<string>(() => api.getToken());
  const [error, setError] = useState<string | null>(null);

  const session = useThreadSession(selectedId);

  const refreshThreads = useCallback(async () => {
    setLoadingThreads(true);
    try {
      const list = await api.listThreads();
      setThreads(list);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingThreads(false);
    }
  }, []);

  useEffect(() => {
    api.captureTokenFromUrl();
    setTokenState(api.getToken());
    void refreshThreads();
  }, [refreshThreads]);

  const saveToken = () => {
    api.setToken(token);
    void refreshThreads();
  };

  const newThread = useCallback(async () => {
    try {
      const thread = await api.createThread(options);
      await refreshThreads();
      setSelectedId(thread.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [options, refreshThreads]);

  const handleSend = useCallback(
    async (prompt: string) => {
      try {
        let threadId = selectedId;
        if (!threadId) {
          const thread = await api.createThread(options);
          threadId = thread.id;
          setSelectedId(threadId);
          await refreshThreads();
          // The session hook attaches on the next render; defer the turn so the
          // stream is connected before the prompt is sent.
          setTimeout(() => {
            void api
              .startTurn(thread.id, prompt, options)
              .then(() => refreshThreads())
              .catch((e) =>
                setError(e instanceof Error ? e.message : String(e)),
              );
          }, 150);
          return;
        }
        await session.send(prompt, options);
        void refreshThreads();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [selectedId, options, session, refreshThreads],
  );

  const handleSteer = useCallback(
    async (prompt: string) => {
      try {
        await session.steer(prompt);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [session],
  );

  const handleInterrupt = useCallback(async () => {
    try {
      await session.interrupt();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [session]);

  const handleApprove = useCallback(
    (approvalId: string, decision: "allow" | "deny", remember: boolean) => {
      void session.approve(approvalId, decision, remember).catch((e) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
    },
    [session],
  );

  const rows = toRows(session.state);
  const activeThread = threads.find((t) => t.id === selectedId);

  return (
    <div className="app">
      <Sidebar
        threads={threads}
        activeId={selectedId}
        loading={loadingThreads}
        onSelect={setSelectedId}
        onNew={() => void newThread()}
        onRefresh={() => void refreshThreads()}
      />
      <main className="main">
        <div className="token-bar">
          <input
            type="password"
            value={token}
            placeholder="Runtime token (from `codewhale serve --mobile`)"
            onChange={(e) => setTokenState(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && saveToken()}
            autoComplete="off"
            spellCheck={false}
          />
          <button onClick={saveToken}>Save</button>
        </div>
        <div className="main-head">
          <strong>
            {activeThread ? activeThread.title || activeThread.id : "No session selected"}
          </strong>
          <span className="thread-meta">
            <span className={`dot ${session.connection}`} />
            {session.connection}
            {session.streaming ? " · running" : ""}
          </span>
        </div>
        {error && <div className="notice">⚠ {error}</div>}
        <Transcript
          rows={rows}
          streaming={session.streaming}
          onApprove={handleApprove}
        />
        <Composer
          options={options}
          setOptions={setOptions}
          streaming={session.streaming}
          hasActiveTurn={!!session.activeTurnId}
          disabled={false}
          onSend={(p) => void handleSend(p)}
          onSteer={(p) => void handleSteer(p)}
          onInterrupt={() => void handleInterrupt()}
        />
      </main>
    </div>
  );
}
