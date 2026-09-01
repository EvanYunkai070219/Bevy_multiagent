// @vitest-environment jsdom

/**
 * The scroll rules live in `styles.css`, so this file loads the real stylesheet
 * and asks the engine how the columns actually behave — the same reasoning as
 * `CreatureSprite.motion.test.tsx`: asserting on CSS text passes while the rule
 * is unreachable.
 *
 * Two behaviours are pinned here:
 *
 * 1. The process rail scrolls by itself. It used to be ordinary page flow, so
 *    wheeling over the rail scrolled the conversation with it — the one column
 *    a reader wants to move independently was the one that could not.
 * 2. A group's fold toggle stays in reach. The toggle is the group's header;
 *    with a long open group the reader had to scroll back up just to close it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import "./styles.css";

afterEach(cleanup);

function computed(className: string, parents: string[] = []): CSSStyleDeclaration {
  let host: HTMLElement = document.body;
  for (const parent of parents) {
    const node = document.createElement("div");
    node.className = parent;
    host.appendChild(node);
    host = node;
  }
  const target = document.createElement("div");
  target.className = className;
  host.appendChild(target);
  return getComputedStyle(target);
}

describe("independent rail scrolling", () => {
  it("pins the rail to the viewport with its own scrollbar", () => {
    const style = computed("rail", ["app-shell app-shell--with-nav app-shell--with-rail"]);
    expect(style.position).toBe("sticky");
    expect(style.top).toBe("0px");
    // jsdom resolves viewport units, so 100vh comes back as the window height.
    expect(style.height).toBe(window.innerHeight + "px");
    expect(style.overflowY).toBe("auto");
  });

  it("keeps a rail scroll from spilling into the page", () => {
    const style = computed("rail", ["app-shell app-shell--with-nav app-shell--with-rail"]);
    expect(style.overscrollBehavior).toBe("contain");
  });
});

describe("reaching a group's fold toggle", () => {
  it("keeps the group header pinned while its steps scroll past", () => {
    const style = computed("stream-summary", ["stream", "stream-group"]);
    expect(style.position).toBe("sticky");
  });
});

/**
 * Truncation picks a loser on purpose. A role tag is a short constant word —
 * "WORKER" squeezed to "WOR…" says nothing — so the NAME is what gives way,
 * and it does so with an ellipsis while the full name stays in `title`.
 * Likewise a move's count is the point of its row: the label yields, the
 * number never leaves the card.
 */
describe("who gives way when a row runs out of room", () => {
  it("keeps the bench role tag whole and lets the name truncate", () => {
    const style = computed("role-tag", ["bench-list", "bench-row"]);
    expect(style.flexShrink).toBe("0");
  });

  it("keeps the party role tag whole too", () => {
    const style = computed("role-tag", ["worker-row-copy", "worker-row-head"]);
    expect(style.flexShrink).toBe("0");
  });

  it("keeps a move's count inside the card by truncating the label", () => {
    const label = computed("inspector-move-label", ["inspector-moves"]);
    expect(label.overflow).toBe("hidden");
    expect(label.textOverflow).toBe("ellipsis");
    const count = computed("inspector-move-count", ["inspector-moves"]);
    expect(count.flexShrink).toBe("0");
  });
});

/** The chat card's status dot sits beside the name, never on a clipped line. */
describe("the chat card title line", () => {
  it("lays the name and the status dot on one row", () => {
    const style = computed("agent-card-title", ["agent-card", "agent-card-copy"]);
    expect(style.display).toBe("flex");
    expect(style.overflow).toBe("visible");
  });
});

describe("the live process box", () => {
  it("bounds the whole running stream to a box that scrolls by itself", () => {
    const style = computed("stream-live-box", ["stream"]);
    expect(style.overflowY).toBe("auto");
    expect(parseInt(style.maxHeight, 10)).toBeGreaterThan(0);
    expect(style.overscrollBehavior).toBe("contain");
  });

  it("keeps the box's fold toggle pinned and reachable", () => {
    const style = computed("stream-live", ["stream"]);
    expect(style.position).toBe("sticky");
  });
});
