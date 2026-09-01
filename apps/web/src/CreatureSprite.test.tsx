// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CreatureSprite } from "./CreatureSprite";
import type { Creature } from "./creatures";

const otter: Creature = {
  id: "otter",
  displayName: "Otter",
  sprite: "/creatures/otter.png",
  affinity: "code",
};

afterEach(cleanup);

describe("CreatureSprite", () => {
  it("names the creature for a reader who cannot see it", () => {
    render(<CreatureSprite creature={otter} state="working" name="Byte" />);
    expect(screen.getByAltText("Otter")).toBeDefined();
  });

  it("carries its state on the class so motion is CSS, not JavaScript", () => {
    const { container } = render(
      <CreatureSprite creature={otter} state="thinking" name="Byte" />,
    );
    expect(container.querySelector(".sprite--thinking")).not.toBeNull();
  });

  it("exposes creature identity so cast members can move out of phase", () => {
    const { container } = render(
      <CreatureSprite creature={otter} state="idle" name="Byte" />,
    );
    expect(container.querySelector(".sprite")?.getAttribute("data-creature")).toBe(
      "otter",
    );
  });

  it("gives the artwork its own motion layer", () => {
    const { container } = render(
      <CreatureSprite creature={otter} state="working" name="Byte" />,
    );
    expect(container.querySelector(".sprite-art > img")).not.toBeNull();
  });

  it("marks a completed creature with a one-off cheer", () => {
    const { container } = render(
      <CreatureSprite creature={otter} state="done" name="Byte" />,
    );
    const sprite = container.querySelector<HTMLElement>(".sprite");
    expect(sprite?.getAttribute("data-motion")).toBe("cheer");
    expect(sprite?.style.getPropertyValue("--sprite-motion-duration")).toBe("2s");
  });

  it("keeps a readable mood mark when motion is unavailable", () => {
    const { container } = render(
      <CreatureSprite creature={otter} state="hurt" name="Byte" />,
    );
    expect(container.querySelector(".sprite-mood")?.textContent).toBe("✕");
  });

  it("shows a thought mark while its agent is thinking", () => {
    const { container } = render(
      <CreatureSprite creature={otter} state="thinking" name="Byte" />,
    );
    expect(container.querySelector(".sprite-mood")?.textContent).toBe("…");
  });

  it("falls back to the agent's initial when the artwork will not load", () => {
    const { container } = render(
      <CreatureSprite creature={otter} state="idle" name="Byte" />,
    );
    const image = container.querySelector("img");
    if (image === null) throw new Error("expected an image to be rendered");
    fireEvent.error(image);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".sprite-fallback")?.textContent).toBe("B");
  });
});
