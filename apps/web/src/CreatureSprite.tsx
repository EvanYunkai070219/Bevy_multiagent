/**
 * One creature, wearing its current state.
 *
 * There is one piece of artwork per creature and there always will be: hand
 * drawing a pose per state per cast member does not scale, and it would weld
 * the state layer to a particular set of pictures. State is carried by CSS
 * motion plus a shared mood mark instead, so any cast where each member has one
 * image supports every state with no change here.
 */
import { useState, type CSSProperties } from "react";
import type { Creature } from "./creatures";
import type { CreatureState } from "./creature-state";

/** Readable without motion, which is the point: animation is not the message. */
const MOOD: Record<CreatureState, string> = {
  done: "✦",
  searching: "◎",
  working: "",
  thinking: "…",
  hurt: "✕",
  waiting: "",
  idle: "",
};

export function CreatureSprite({
  creature,
  state,
  name,
  size = 32,
}: {
  creature: Creature;
  state: CreatureState;
  /** Whose creature this is, used for the fallback mark. */
  name: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);
  const mood = MOOD[state];
  const style = {
    width: size,
    height: size,
    ...(state === "done" ? { "--sprite-motion-duration": "2s" } : {}),
  } as CSSProperties;

  return (
    <span
      className={"sprite sprite--" + state}
      data-creature={creature.id}
      data-motion={state === "done" ? "cheer" : state}
      style={style}
      title={creature.displayName + " · " + name}
    >
      {broken ? (
        <span className="sprite-fallback">{name.slice(0, 1).toUpperCase()}</span>
      ) : (
        <span className="sprite-art">
          <img
            src={creature.sprite}
            alt={creature.displayName}
            onError={() => setBroken(true)}
          />
        </span>
      )}
      {mood.length > 0 && (
        <span className="sprite-mood" aria-hidden="true">
          {mood}
        </span>
      )}
    </span>
  );
}
