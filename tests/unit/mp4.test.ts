import { describe, expect, it } from "vitest";
import { probeMp4 } from "@/lib/mp4";
import { mp4 } from "../fixtures/mp4";

describe("probeMp4", () => {
  it("reads display size and duration", () => {
    expect(probeMp4(mp4({ w: 1080, h: 1920, seconds: 15.6 }))).toEqual({ width: 1080, height: 1920, durationSec: 15.6 });
  });
  it("applies a 90° rotation matrix (phone clips stored landscape)", () => {
    expect(probeMp4(mp4({ w: 1920, h: 1080, seconds: 10, rotate: true }))).toMatchObject({ width: 1080, height: 1920 });
  });
  it("returns null for something that is not an MP4", () => {
    expect(probeMp4(Buffer.from("definitely not a video file"))).toBeNull();
  });
});
