// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PositionedActionMenu } from "./PositionedActionMenu";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setupGeometry({
  viewport = [300, 200],
  triggerRect = rect(270, 170, 20, 20),
  menuRect = rect(0, 0, 100, 80),
}: {
  viewport?: [number, number];
  triggerRect?: DOMRect;
  menuRect?: DOMRect;
} = {}) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport[0] });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport[1] });
  const trigger = document.createElement("button");
  trigger.textContent = "Actions";
  document.body.append(trigger);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this === trigger ? triggerRect : menuRect;
  });
  return trigger;
}

describe("PositionedActionMenu", () => {
  it("focuses the first enabled item and keeps arrow, Home, and End navigation in the menu", async () => {
    const user = userEvent.setup();
    const trigger = setupGeometry({ triggerRect: rect(20, 20, 20, 20) });
    render(
      <PositionedActionMenu trigger={trigger} onDismiss={() => undefined}>
        <button role="menuitem" disabled>Unavailable</button>
        <button role="menuitem">Edit name</button>
        <button role="menuitem">Delete project</button>
      </PositionedActionMenu>,
    );

    const edit = screen.getByRole("menuitem", { name: "Edit name" });
    const remove = screen.getByRole("menuitem", { name: "Delete project" });
    expect(document.activeElement).toBe(edit);

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(remove);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(edit);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(remove);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(edit);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(remove);
    trigger.remove();
  });

  it.each(["{Tab}", "{Escape}"])(
    "dismisses on %s and returns focus without visiting unrelated controls",
    async (key) => {
      const user = userEvent.setup();
      const unrelated = document.createElement("button");
      unrelated.textContent = "Unrelated";
      document.body.append(unrelated);
      const trigger = setupGeometry({ triggerRect: rect(20, 20, 20, 20) });
      const onDismiss = vi.fn();
      render(
        <PositionedActionMenu trigger={trigger} onDismiss={onDismiss}>
          <button role="menuitem">Edit name</button>
          <button role="menuitem">Delete project</button>
        </PositionedActionMenu>,
      );

      await user.keyboard(key);
      expect(onDismiss).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(trigger);
      expect(document.activeElement).not.toBe(unrelated);
      trigger.remove();
      unrelated.remove();
    },
  );

  it("portals under body, fixes to the viewport, and flips left and above near edges", () => {
    const trigger = setupGeometry();
    render(
      <PositionedActionMenu trigger={trigger} onDismiss={() => undefined}>
        <button role="menuitem">Edit name</button>
      </PositionedActionMenu>,
    );

    const menu = screen.getByRole("menu");
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.position).toBe("fixed");
    expect(menu.style.left).toBe("190px");
    expect(menu.style.top).toBe("86px");
    trigger.remove();
  });

  it("clamps preferred coordinates to an 8px margin in a narrow viewport", () => {
    const trigger = setupGeometry({
      viewport: [150, 120],
      triggerRect: rect(-20, -20, 12, 12),
      menuRect: rect(0, 0, 200, 90),
    });
    render(
      <PositionedActionMenu trigger={trigger} onDismiss={() => undefined}>
        <button role="menuitem">Edit name</button>
      </PositionedActionMenu>,
    );

    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("8px");
    expect(menu.style.top).toBe("8px");
    expect(menu.style.maxWidth).toBe("calc(100vw - 16px)");
    expect(menu.style.maxHeight).toBe("calc(100vh - 16px)");
    trigger.remove();
  });

  it.each([
    ["outside pointer", async (user: ReturnType<typeof userEvent.setup>) => user.click(document.body)],
    ["Escape", async (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}")],
    ["scroll", async () => window.dispatchEvent(new Event("scroll"))],
    ["resize", async () => window.dispatchEvent(new Event("resize"))],
  ])("dismisses on %s", async (_name, dismiss) => {
    const user = userEvent.setup();
    const trigger = setupGeometry({ triggerRect: rect(20, 20, 20, 20) });
    const onDismiss = vi.fn();
    render(
      <PositionedActionMenu trigger={trigger} onDismiss={onDismiss}>
        <button role="menuitem">Edit name</button>
      </PositionedActionMenu>,
    );

    await dismiss(user);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    trigger.remove();
  });
});
