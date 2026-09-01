import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface PositionedActionMenuProps {
  trigger: HTMLElement;
  onDismiss(): void;
  children: ReactNode;
}

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 4;

function clamp(value: number, maximum: number): number {
  return Math.max(VIEWPORT_MARGIN, Math.min(value, Math.max(VIEWPORT_MARGIN, maximum)));
}

function enabledMenuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])',
    ),
  );
}

export function PositionedActionMenu({
  trigger,
  onDismiss,
  children,
}: PositionedActionMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: VIEWPORT_MARGIN, top: VIEWPORT_MARGIN });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    let left = triggerRect.left;
    if (left + menuRect.width > window.innerWidth - VIEWPORT_MARGIN) {
      left = triggerRect.right - menuRect.width;
    }

    let top = triggerRect.bottom + TRIGGER_GAP;
    if (top + menuRect.height > window.innerHeight - VIEWPORT_MARGIN) {
      top = triggerRect.top - menuRect.height - TRIGGER_GAP;
    }

    setPosition({
      left: clamp(left, window.innerWidth - menuRect.width - VIEWPORT_MARGIN),
      top: clamp(top, window.innerHeight - menuRect.height - VIEWPORT_MARGIN),
    });
    enabledMenuItems(menu)[0]?.focus();
  }, [trigger]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || trigger.contains(target)) return;
      onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      const menu = menuRef.current;
      if (menu === null) return;
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        onDismiss();
        trigger.focus();
        return;
      }

      const items = enabledMenuItems(menu);
      if (items.length === 0) return;
      const currentIndex = items.findIndex((item) => item === document.activeElement);
      let nextIndex: number | null = null;
      if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
      if (event.key === "ArrowUp") {
        nextIndex = (currentIndex <= 0 ? items.length : currentIndex) - 1;
      }
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = items.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      items[nextIndex]?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [onDismiss, trigger]);

  return createPortal(
    <div
      ref={menuRef}
      className="chat-menu"
      role="menu"
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        maxWidth: "calc(100vw - 16px)",
        maxHeight: "calc(100vh - 16px)",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
