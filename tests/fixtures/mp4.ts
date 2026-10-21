/** Builds minimal ISO-BMFF files for tests (no real codec data). */
function box(type: string, ...body: Buffer[]) {
  const b = Buffer.concat(body);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + b.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, b]);
}

/** A minimal ISO-BMFF file: ftyp + moov(mvhd + trak(tkhd + mdia(hdlr))). */
export function mp4({ w, h, seconds, rotate = false, mdatBytes = 16 }: { w: number; h: number; seconds: number; rotate?: boolean; mdatBytes?: number }) {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12); // timescale
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16); // duration
  const tkhd = Buffer.alloc(84);
  // matrix: identity a=1, d=1; rotated 90° => a=0,b=1,c=-1,d=0
  const m = tkhd.length - 8 - 36;
  if (rotate) {
    tkhd.writeInt32BE(0, m);
    tkhd.writeInt32BE(0x10000, m + 4);
    tkhd.writeInt32BE(-0x10000, m + 12);
  } else {
    tkhd.writeInt32BE(0x10000, m);
    tkhd.writeInt32BE(0x10000, m + 16);
  }
  tkhd.writeUInt32BE(w * 65536, tkhd.length - 8);
  tkhd.writeUInt32BE(h * 65536, tkhd.length - 4);
  const hdlr = Buffer.alloc(24);
  hdlr.write("vide", 8, "latin1");
  return Buffer.concat([
    box("ftyp", Buffer.from("isom0000isomiso2", "latin1")),
    box("moov", box("mvhd", mvhd), box("trak", box("tkhd", tkhd), box("mdia", box("hdlr", hdlr)))),
    box("mdat", Buffer.alloc(mdatBytes)),
  ]);
}

