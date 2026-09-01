import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

export type RenameTarget =
  | { kind: "project"; id: string; currentName: string }
  | { kind: "chat"; id: string; currentName: string };

export interface RenameDialogProps {
  target: RenameTarget;
  trigger: HTMLElement | null;
  onClose(): void;
  onRename(target: RenameTarget, name: string): Promise<void>;
}

const MAX_ERROR_LENGTH = 240;

function boundedMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.slice(0, MAX_ERROR_LENGTH);
}

export function RenameDialog({ target, trigger, onClose, onRename }: RenameDialogProps) {
  const [name, setName] = useState(target.currentName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();
  const errorId = useId();
  const subject = target.kind === "chat" ? "Chat" : "Project";

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [target.id]);

  useEffect(() => {
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, [trigger]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, pending]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    const normalized = name.trim();
    if (normalized.length === 0) {
      setError("Name is required.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onRename(target, normalized);
      onClose();
    } catch (reason) {
      setError(boundedMessage(reason));
    } finally {
      setPending(false);
    }
  };

  return createPortal(
    <div
      className="modal-backdrop"
      data-testid="rename-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <form
        className="modal rename-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(event) => void submit(event)}
      >
        <div className="modal-heading">
          <h2 id={titleId}>Edit {subject.toLowerCase()} name</h2>
          <p>This changes the display name only.</p>
        </div>
        <label className="dialog-field" htmlFor={inputId}>
          <span>{subject} name</span>
          <input
            ref={inputRef}
            id={inputId}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            aria-describedby={error === null ? undefined : errorId}
            aria-invalid={error === null ? undefined : true}
            maxLength={80}
            disabled={pending}
            required
          />
        </label>
        {error !== null && (
          <p id={errorId} className="rename-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-footer">
          <button
            type="button"
            className="button button-ghost"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={pending || name.trim().length === 0}
          >
            {pending ? "Saving…" : "Save name"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
