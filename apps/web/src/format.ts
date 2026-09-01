/**
 * How this interface writes a moment in time.
 *
 * Three components each built their own `Intl.DateTimeFormat(undefined, ...)`.
 * `undefined` means "whatever the viewer's browser is set to", so a Chinese
 * browser rendered `8月29日 15:59` in the middle of an English page -- the only
 * localised string in the product, and one nobody chose. The interface is
 * written in one language, so its timestamps are too, and saying so once here
 * is what keeps the next formatter from inheriting the viewer again.
 */
export const UI_LOCALE = "en-US";

/** Time of day, for a stamp that sits next to something already dated. */
export function formatClock(value: string): string {
  return new Intl.DateTimeFormat(UI_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/** Day and time, for a run in a list of runs from the same few days. */
export function formatStamp(value: string): string {
  return new Intl.DateTimeFormat(UI_LOCALE, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * Year, day and time, for records that outlive a session. Anything that will
 * not parse is returned untouched: a skill stamped with something unexpected
 * should show what it is stamped with, not the words "Invalid Date".
 */
export function formatFullStamp(value: string): string {
  if (value === "") return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(UI_LOCALE, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}
