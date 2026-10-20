import { describe, expect, it } from "vitest";
import { dubaiDayKey, dubaiMidnight, formatDubaiTime, parseDubai, toDubaiInput } from "@/lib/time";

describe("parseDubai", () => {
  it("reads a bare local time as Dubai (UTC+4)", () => {
    expect(parseDubai("2026-10-20 19:00")?.toISOString()).toBe("2026-10-20T15:00:00.000Z");
    expect(parseDubai("2026-10-20T19:00")?.toISOString()).toBe("2026-10-20T15:00:00.000Z");
    expect(parseDubai("2026-10-20T19:00:30")?.toISOString()).toBe("2026-10-20T15:00:30.000Z");
  });

  it("honours an explicit offset or Z", () => {
    expect(parseDubai("2026-10-20T19:00+04:00")?.toISOString()).toBe("2026-10-20T15:00:00.000Z");
    expect(parseDubai("2026-10-20T19:00:00Z")?.toISOString()).toBe("2026-10-20T19:00:00.000Z");
    expect(parseDubai("2026-10-20T19:00:00.000+0530")?.toISOString()).toBe("2026-10-20T13:30:00.000Z");
  });

  it("crosses midnight correctly", () => {
    expect(parseDubai("2026-10-21 02:00")?.toISOString()).toBe("2026-10-20T22:00:00.000Z");
  });

  it("rejects impossible dates and loose formats", () => {
    expect(parseDubai("2026-02-30 10:00")).toBeNull();
    expect(parseDubai("2026-13-01 10:00")).toBeNull();
    expect(parseDubai("tomorrow 7pm")).toBeNull();
    expect(parseDubai("20/10/2026 19:00")).toBeNull();
    expect(parseDubai("2026-10-20")).toBeNull();
    expect(parseDubai("")).toBeNull();
  });
});

describe("Dubai formatting", () => {
  const at = new Date("2026-10-20T20:30:00Z"); // 00:30 on the 21st in Dubai
  it("puts instants on the Dubai calendar day", () => {
    expect(dubaiDayKey(at)).toBe("2026-10-21");
    expect(dubaiMidnight("2026-10-21").toISOString()).toBe("2026-10-20T20:00:00.000Z");
  });
  it("round-trips through the datetime-local input", () => {
    expect(toDubaiInput(at)).toBe("2026-10-21T00:30");
    expect(parseDubai(toDubaiInput(at))?.toISOString()).toBe(at.toISOString());
    expect(formatDubaiTime(at)).toBe("00:30");
  });
});
