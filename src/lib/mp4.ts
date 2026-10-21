/**
 * Just enough of ISO-BMFF (MP4 / MOV) to vet a reel without ffprobe, which
 * the Shipyard container does not have: duration from `mvhd`, and the display
 * size of the video track from `tkhd` (rotation matrix applied, so a phone
 * clip stored landscape-with-rotate reads as the vertical video it is).
 */
export type VideoInfo = { width: number; height: number; durationSec: number };

type Box = { type: string; start: number; end: number; body: number };

function* boxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let at = start;
  while (at + 8 <= end) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > end) return;
      size = Number(buf.readBigUInt64BE(at + 8));
      body = at + 16;
    } else if (size === 0) size = end - at;
    if (size < 8 || at + size > end) return;
    yield { type, start: at, end: at + size, body };
    at += size;
  }
}

function child(buf: Buffer, parent: Box, type: string): Box | undefined {
  for (const b of boxes(buf, parent.body, parent.end)) if (b.type === type) return b;
}

export function probeMp4(buf: Buffer): VideoInfo | null {
  const top = [...boxes(buf, 0, buf.length)];
  if (!top.some((b) => b.type === "ftyp")) return null;
  const moov = top.find((b) => b.type === "moov");
  if (!moov) return null;

  let durationSec = 0;
  const mvhd = child(buf, moov, "mvhd");
  if (mvhd) {
    const v = buf.readUInt8(mvhd.body);
    if (v === 1) {
      const timescale = buf.readUInt32BE(mvhd.body + 20);
      durationSec = Number(buf.readBigUInt64BE(mvhd.body + 24)) / (timescale || 1);
    } else {
      const timescale = buf.readUInt32BE(mvhd.body + 12);
      durationSec = buf.readUInt32BE(mvhd.body + 16) / (timescale || 1);
    }
  }

  for (const trak of boxes(buf, moov.body, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = child(buf, trak, "mdia");
    const hdlr = mdia && child(buf, mdia, "hdlr");
    const handler = hdlr ? buf.toString("latin1", hdlr.body + 8, hdlr.body + 12) : "";
    const tkhd = child(buf, trak, "tkhd");
    if (!tkhd || (handler && handler !== "vide")) continue;
    // Width/height are the last 8 bytes (16.16 fixed); the matrix sits just before.
    const w = buf.readUInt32BE(tkhd.end - 8) / 65536;
    const h = buf.readUInt32BE(tkhd.end - 4) / 65536;
    if (!w || !h) continue;
    const matrixAt = tkhd.end - 8 - 36;
    const b = buf.readInt32BE(matrixAt + 4); // non-zero b = rotated 90/270°
    const rotated = b !== 0;
    return { width: Math.round(rotated ? h : w), height: Math.round(rotated ? w : h), durationSec };
  }
  return null;
}
