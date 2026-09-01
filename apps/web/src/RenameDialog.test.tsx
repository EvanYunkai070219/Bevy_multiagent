// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenameDialog, type RenameTarget } from "./RenameDialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const target: RenameTarget = {
  kind: "chat",
  id: "chat-1",
  currentName: "Current chat name",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("RenameDialog", () => {
  it("selects the complete current name when it opens", () => {
    render(
      <RenameDialog
        target={target}
        trigger={null}
        onClose={() => undefined}
        onRename={async () => undefined}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Chat name" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(target.currentName.length);
  });

  it("stays open and blocks dismissal while the authoritative rename is pending", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const onClose = vi.fn();
    const onRename = vi.fn(() => pending.promise);

    render(
      <RenameDialog target={target} trigger={null} onClose={onClose} onRename={onRename} />,
    );

    const input = screen.getByRole("textbox", { name: "Chat name" });
    await user.clear(input);
    await user.type(input, "Requested name");
    await user.click(screen.getByRole("button", { name: "Save name" }));

    expect(onRename).toHaveBeenCalledWith(target, "Requested name");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);

    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("rename-backdrop"));
    expect(onClose).not.toHaveBeenCalled();

    pending.resolve();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("shows a bounded, described error and remains open after rejection", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <RenameDialog
        target={target}
        trigger={null}
        onClose={onClose}
        onRename={async () => {
          throw new Error("private-path/" + "x".repeat(500));
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save name" }));
    const alert = await screen.findByRole("alert");
    const input = screen.getByRole("textbox", { name: "Chat name" });

    expect(alert.textContent?.length).toBeLessThanOrEqual(240);
    expect(input.getAttribute("aria-describedby")).toBe(alert.id);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("dismisses by Escape or backdrop only while idle", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <RenameDialog
        target={target}
        trigger={null}
        onClose={onClose}
        onRename={async () => undefined}
      />,
    );

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(
      <RenameDialog
        target={{ ...target, id: "chat-2" }}
        trigger={null}
        onClose={onClose}
        onRename={async () => undefined}
      />,
    );
    await user.click(screen.getByTestId("rename-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the menu trigger after dismissal", async () => {
    const user = userEvent.setup();
    const trigger = document.createElement("button");
    trigger.textContent = "Actions";
    document.body.append(trigger);

    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <RenameDialog
          target={target}
          trigger={trigger}
          onClose={() => setOpen(false)}
          onRename={async () => undefined}
        />
      ) : null;
    }

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
