import { useState } from "react";
import type { CreateChatRequest, CreateProjectRequest } from "./types";

interface DialogShellProps {
  eyebrow: string;
  title: string;
  description: string;
  onClose(): void;
  onSubmit(event: React.FormEvent): void;
  children: React.ReactNode;
  submitLabel: string;
  busy: boolean;
  submitDisabled?: boolean;
  /**
   * Why the last attempt failed. It has to render inside the dialog: the app's
   * banner sits behind the backdrop, so a rejected submit looked like nothing
   * happening at all.
   */
  error?: string | null;
}

function DialogShell({
  eyebrow,
  title,
  description,
  onClose,
  onSubmit,
  children,
  submitLabel,
  busy,
  submitDisabled = false,
  error = null,
}: DialogShellProps) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        onSubmit={onSubmit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
        {error !== null && error.length > 0 && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <div className="modal-footer">
          <button type="button" className="button button-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="button button-primary" disabled={busy || submitDisabled}>
            {busy ? <span className="spinner" aria-label="Loading" /> : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export function CreateManagedProjectDialog({
  busy,
  error,
  onClose,
  onCreateManaged,
}: {
  busy: boolean;
  error?: string | null;
  onClose(): void;
  onCreateManaged(body: Extract<CreateProjectRequest, { kind: "managed" }>): void;
}) {
  const [displayName, setDisplayName] = useState("");

  return (
    <DialogShell
      eyebrow="Projects"
      title="Create a project"
      description="Creates a managed repository under the Launchpad projects root."
      onClose={onClose}
      busy={busy}
      error={error ?? null}
      submitLabel="Create project"
      onSubmit={(event) => {
        event.preventDefault();
        onCreateManaged({ kind: "managed", displayName: displayName.trim() });
      }}
    >
      <label>
        Display name
        <input
          autoFocus
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Todo Flow"
          required
          maxLength={80}
        />
      </label>
    </DialogShell>
  );
}

export function OpenExternalProjectDialog({
  busy,
  error,
  onClose,
  onOpenExternal,
}: {
  busy: boolean;
  error?: string | null;
  onClose(): void;
  onOpenExternal(body: Extract<CreateProjectRequest, { kind: "external" }>): void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  // Empty, not the literal "HEAD": the field was pre-filled with it, so typing
  // a branch name appended to it and opened `HEADrelease-2.0`. Submitting falls
  // back to HEAD, and the placeholder says so.
  const [revision, setRevision] = useState("");

  return (
    <DialogShell
      eyebrow="Projects"
      title="Open a project"
      description="Registers a server-local folder as an external Project without changing the working tree."
      onClose={onClose}
      busy={busy}
      error={error ?? null}
      submitLabel="Open project"
      onSubmit={(event) => {
        event.preventDefault();
        onOpenExternal({
          kind: "external",
          displayName: displayName.trim(),
          repositoryPath: repositoryPath.trim(),
          revision: revision.trim() || "HEAD",
        });
      }}
    >
      <label>
        Display name
        <input
          autoFocus
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="CodeJam"
          required
          maxLength={80}
        />
      </label>
      <label>
        Folder path
        <input
          value={repositoryPath}
          onChange={(event) => setRepositoryPath(event.target.value)}
          placeholder="/Users/me/repos/CodeJam"
          required
          maxLength={4096}
        />
      </label>
      {/* "What is the purpose of revision?" -- it answers which commit of the
          repository to open, and almost nobody wants anything but the one
          already checked out. As a field beside the folder path it read as a
          required decision in vocabulary the form never explained, so it keeps
          working and stops asking. */}
      <details className="dialog-advanced">
        <summary>Advanced</summary>
        <label>
          Revision
          <input
            value={revision}
            onChange={(event) => setRevision(event.target.value)}
            placeholder="HEAD"
            maxLength={256}
          />
        </label>
        <p className="dialog-hint">
          Which branch, tag or commit to open. HEAD is whatever the repository
          currently has checked out.
        </p>
      </details>
    </DialogShell>
  );
}

/**
 * Names are unique across every project, so the clash is knowable here, before
 * anything is sent. Waiting for the server turned a typo into a rejected
 * submit; catching it as the operator types turns it into a hint.
 */
export function nameConflict(name: string, takenNames: string[]): string | null {
  const normalized = name.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const clash = takenNames.find((taken) => taken.trim().toLowerCase() === normalized);
  return clash === undefined
    ? null
    : 'The name "' + clash +
        '" is already in use. Chat names are shared globally across every project, so choose a different title.';
}

export function CreateProjectChatDialog({
  projectId,
  busy,
  error,
  takenNames = [],
  onClearError,
  onClose,
  onCreateChat,
}: {
  projectId: string;
  busy: boolean;
  error?: string | null;
  /** Every chat name already in use, so a clash is caught before submitting. */
  takenNames?: string[];
  onClearError?(): void;
  onClose(): void;
  onCreateChat(projectId: string, body: CreateChatRequest): void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [role, setRole] = useState<"standalone" | "leader">("standalone");
  const [showDetails, setShowDetails] = useState(false);
  const conflict = nameConflict(name, takenNames);

  return (
    <DialogShell
      eyebrow="Chats"
      title="New chat"
      description="Starts a Chat that inherits this Project baseline."
      onClose={onClose}
      busy={busy}
      submitDisabled={conflict !== null}
      error={error ?? null}
      submitLabel="Create chat"
      onSubmit={(event) => {
        event.preventDefault();
        if (conflict !== null) return;
        onCreateChat(projectId, {
          name: name.trim(),
          description: description.trim(),
          instructions: instructions.trim(),
          role,
        });
      }}
    >
      <div className="dialog-field">
        <label htmlFor="new-chat-title">Title</label>
        <input
          id="new-chat-title"
          autoFocus
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (error) onClearError?.();
          }}
          placeholder="Fix project outcome persistence"
          required
          maxLength={80}
          aria-invalid={conflict !== null}
          aria-describedby={conflict === null ? undefined : "chat-title-conflict"}
        />
        {conflict !== null && (
          <span id="chat-title-conflict" className="field-error" role="alert">
            {conflict}
          </span>
        )}
      </div>
      {/* Sent explicitly. Omitting it let the server default decide, which made
          every Project chat a leader with no way to ask for anything else. */}
      <div className="dialog-field">
        <label htmlFor="new-chat-role">Role</label>
        <select
          id="new-chat-role"
          value={role}
          onChange={(event) =>
            setRole(event.target.value as "standalone" | "leader")
          }
        >
          <option value="standalone">Standalone</option>
          <option value="leader">Leader</option>
        </select>
      </div>
      <button
        type="button"
        className="button button-ghost dialog-details-toggle"
        onClick={() => setShowDetails((value) => !value)}
      >
        {showDetails ? "Hide details" : "More options"}
      </button>
      {showDetails && (
        <>
          <label>
            Description
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional summary"
              maxLength={500}
            />
          </label>
          <label>
            Instructions
            <textarea
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={5}
              maxLength={10_000}
            />
          </label>
        </>
      )}
    </DialogShell>
  );
}
