import { useState, type KeyboardEvent } from "react";

import type { SessionOptions } from "../types";

interface ComposerProps {
  options: SessionOptions;
  setOptions: (opts: SessionOptions) => void;
  streaming: boolean;
  hasActiveTurn: boolean;
  disabled: boolean;
  onSend: (prompt: string) => void;
  onSteer: (prompt: string) => void;
  onInterrupt: () => void;
}

export function Composer({
  options,
  setOptions,
  streaming,
  hasActiveTurn,
  disabled,
  onSend,
  onSteer,
  onInterrupt,
}: ComposerProps) {
  const [text, setText] = useState("");

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText("");
  };

  const steer = () => {
    const value = text.trim();
    if (!value) return;
    onSteer(value);
    setText("");
  };

  // Enter sends; Shift+Enter inserts a newline (terminal-composer convention).
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const toggle = (key: keyof SessionOptions) => () =>
    setOptions({ ...options, [key]: !options[key] });

  return (
    <div className="composer">
      <textarea
        value={text}
        placeholder={
          disabled
            ? "Select or create a session to start…"
            : "Message  (Enter to send · Shift+Enter for newline)"
        }
        spellCheck
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="composer-row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={options.allowShell}
            onChange={toggle("allowShell")}
          />
          shell
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={options.autoApprove}
            onChange={toggle("autoApprove")}
          />
          auto-approve
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={options.trustMode}
            onChange={toggle("trustMode")}
          />
          trust
        </label>
        <span className="spacer" />
        {streaming && (
          <button className="danger" onClick={onInterrupt} title="Interrupt turn">
            Interrupt
          </button>
        )}
        <button
          className="warn"
          onClick={steer}
          disabled={disabled || !hasActiveTurn || !text.trim()}
          title="Inject input into the running turn"
        >
          Steer
        </button>
        <button
          className="primary"
          onClick={submit}
          disabled={disabled || !text.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
