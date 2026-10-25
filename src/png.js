const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A pHYs chunk, giving the physical size of the pixels.
function densityChunk(pixelsPerMeter) {
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([...'pHYs'].map((c) => c.charCodeAt(0)), 4);
  view.setUint32(8, pixelsPerMeter);
  view.setUint32(12, pixelsPerMeter);
  // The unit is the meter.
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  return chunk;
}

// Sets the physical size of a PNG's pixels, so that it opens at its real
// size, by putting a pHYs chunk after its header in place of any it has.
export async function setPixelsPerMeter(blob, pixelsPerMeter) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  // The file starts with an 8 byte signature, and each chunk has its length,
  // type, data and checksum.
  const parts = [bytes.subarray(0, 8)];
  for (let start = 8; start < bytes.length; ) {
    const end = start + 12 + view.getUint32(start);
    const type = String.fromCharCode(...bytes.subarray(start + 4, start + 8));
    if (type !== 'pHYs') parts.push(bytes.subarray(start, end));
    if (type === 'IHDR') parts.push(densityChunk(pixelsPerMeter));
    start = end;
  }
  return new Blob(parts, { type: 'image/png' });
}
