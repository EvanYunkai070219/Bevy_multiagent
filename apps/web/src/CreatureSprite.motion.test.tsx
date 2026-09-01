// @vitest-environment jsdom

/**
 * The motion rules live in `styles.css`, so this file loads the real stylesheet
 * and asks the browser engine what a sprite actually does. Asserting on the CSS
 * text instead would pass while the rule was unreachable, which is exactly the
 * bug this file exists to catch: sixteen bespoke resting animations were bound
 * to `.sprite--idle`, a state an agent leaves the moment it runs once and never
 * returns to. Every creature on screen was doing the same thing.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CreatureSprite } from "./CreatureSprite";
import { ROSTER } from "./creatures";
import type { CreatureState } from "./creature-state";
import "./styles.css";

afterEach(cleanup);

function creature(id: string) {
  const found = ROSTER.find((entry) => entry.id === id);
  if (found === undefined) throw new Error("no creature called " + id);
  return found;
}

/** What the artwork is actually doing, per the real stylesheet. */
function motionOf(id: string, state: CreatureState): string {
  const { container } = render(
    <CreatureSprite creature={creature(id)} state={state} name="Byte" />,
  );
  const image = container.querySelector("img");
  if (image === null) throw new Error("expected artwork to render");
  return getComputedStyle(image).animationName;
}

/** The keyframe body of a named animation, straight out of the live stylesheet. */
function keyframesOf(name: string): string {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSKeyframesRule && rule.name === name) return rule.cssText;
    }
  }
  throw new Error("no @keyframes called " + name);
}

describe("creature motion", () => {
  it("gives a fresh creature its own resting motion", () => {
    // Control: proves the stylesheet parsed and the cascade reaches the sprite.
    expect(motionOf("rabbit", "idle")).toBe("creature-hop");
  });

  /**
   * `done` is where a creature spends the rest of the session once its run
   * finishes. The victory turn plays once on the wrapper; underneath it the
   * artwork has to go on living, and it has to live as itself.
   */
  it("keeps a finished creature moving as itself, not frozen", () => {
    expect(motionOf("rabbit", "done")).toBe("creature-hop");
  });

  it("keeps a waiting creature moving as itself", () => {
    expect(motionOf("penguin", "waiting")).toBe("creature-waddle");
  });

  it("tells two resting creatures apart by how they move", () => {
    expect(motionOf("sloth", "done")).not.toBe(motionOf("squirrel", "done"));
  });

  it("leaves every creature at rest with a motion of its own", () => {
    const missing = ROSTER.filter(
      (entry) => motionOf(entry.id, "done").startsWith("creature-") === false,
    );
    expect(missing.map((entry) => entry.id)).toEqual([]);
  });

  /**
   * The artwork is a single flat drawing with no back side, so turning it out
   * of the screen plane shows a mirrored silhouette flattening to a line -- a
   * card flip, not an animal being pleased.
   */
  it("celebrates without turning flat artwork out of its plane", () => {
    expect(keyframesOf("sprite-cheer")).not.toMatch(/rotate(X|Y|3d)/);
  });

  it("plays the cheer over the creature's own motion, not instead of it", () => {
    const { container } = render(
      <CreatureSprite creature={creature("rabbit")} state="done" name="Byte" />,
    );
    const art = container.querySelector(".sprite-art");
    const img = container.querySelector("img");
    expect(getComputedStyle(art as Element).animationName).toBe("sprite-cheer");
    expect(getComputedStyle(img as Element).animationName).toBe("creature-hop");
  });

  /**
   * A boundary, not a regression test: resting motion says who a creature is,
   * working motion says what its agent is doing, and the second must not be
   * overwritten by the first when the resting rule widens.
   */
  it("does not let a working creature fall back to its resting motion", () => {
    expect(motionOf("rabbit", "working")).not.toBe("creature-hop");
  });
});
