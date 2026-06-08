import type { ThreadSummary } from "../types";

interface SidebarProps {
  threads: ThreadSummary[];
  activeId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
}

export function Sidebar({
  threads,
  activeId,
  loading,
  onSelect,
  onNew,
  onRefresh,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">
          <span className="glyph">≋</span> CodeWhale
        </span>
        <span style={{ display: "flex", gap: 6 }}>
          <button onClick={onRefresh} title="Refresh threads">
            ⟳
          </button>
          <button className="primary" onClick={onNew} title="New session">
            + New
          </button>
        </span>
      </div>
      <div className="thread-list">
        {threads.length === 0 && (
          <div className="empty">
            {loading ? "Loading sessions…" : "No sessions yet. Start one with + New."}
          </div>
        )}
        {threads.map((t) => (
          <button
            key={t.id}
            className={"thread" + (t.id === activeId ? " active" : "")}
            onClick={() => onSelect(t.id)}
          >
            <div className="thread-title">{t.title || t.id}</div>
            <div className="thread-meta">
              {t.mode} · {t.model}
              {t.latest_turn_status ? ` · ${t.latest_turn_status}` : ""}
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}
