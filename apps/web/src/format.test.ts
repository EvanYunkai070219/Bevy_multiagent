import { afterEach, describe, expect, it, vi } from "vitest";
import { formatClock, formatStamp, formatFullStamp, UI_LOCALE } from "./format";

afterEach(() => vi.restoreAllMocks());

/**
 * These read "does it say August" on an en-US machine whatever the code does,
 * so they would have passed throughout the bug. What actually broke was the
 * locale argument: three formatters passed `undefined`, which means "whatever
 * the viewer's browser is set to", and a Chinese browser rendered the interface
 * as `8月29日 15:59` inside an English page. So the assertion is on the
 * argument -- the rule is that timestamps never follow the viewer.
 */
describe("timestamp formatting", () => {
  it("never inherits the viewer's locale", () => {
    const real = Intl.DateTimeFormat as unknown as new (
      ...args: unknown[]
    ) => Intl.DateTimeFormat;
    // A plain arrow is not constructible, and `new Intl.DateTimeFormat(...)` is
    // exactly what the code under test does.
    const spy = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      return new real(...args);
    } as unknown as typeof Intl.DateTimeFormat);
    formatClock("2026-08-29T15:59:00.000Z");
    formatStamp("2026-08-29T15:59:00.000Z");
    formatFullStamp("2026-08-29T15:59:00.000Z");
    expect(spy).toHaveBeenCalledTimes(3);
    for (const call of spy.mock.calls) expect(call[0]).toBe(UI_LOCALE);
  });

  it("writes the month in English", () => {
    expect(formatStamp("2026-08-29T15:59:00.000Z")).toContain("Aug");
    expect(formatFullStamp("2026-08-29T15:59:00.000Z")).toContain("Aug");
  });

  it("leaves an unparseable value alone rather than printing Invalid Date", () => {
    expect(formatFullStamp("not a date")).toBe("not a date");
    expect(formatFullStamp("")).toBe("");
  });
});
