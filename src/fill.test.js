import assert from 'node:assert/strict';
import { Color, Vector3 } from 'three';
import { floodFill } from './fill.js';
import { createAtlasLayout } from './painter.js';
import { POLYHEDRA, faceAt, projectToSurface, toFaceCoordinates } from './polyhedra.js';

const PAINT = new Color(0x2040ff);

// The pixel covered by a seed at a point on the surface.
function seedAt(polyhedron, layout, point) {
  const face = faceAt(polyhedron, point);
  const [x, y] = toFaceCoordinates(polyhedron.faceFrames[face], point);
  const { originX, originY } = layout.cells[face];
  return { face, x: originX + x * layout.density, y: originY + y * layout.density };
}

function maskOf(layout, runs) {
  const mask = new Uint8Array(layout.width * layout.height);
  for (let i = 0; i < runs.length; i += 2) mask.fill(1, runs[i], runs[i + 1]);
  return mask;
}

// The cosine of the angle from `axis` to the point on the solid at each atlas
// pixel whose center lies in a face, and NaN at the other pixels.
function cosinesFrom(axis, polyhedron, layout) {
  const { vertices, faces, faceFrames } = polyhedron;
  const cosines = new Float32Array(layout.width * layout.height).fill(NaN);
  faces.forEach((face, f) => {
    const { center, right, up } = faceFrames[f];
    const { originX, originY, rect } = layout.cells[f];
    // Each edge as a line a x + b y = c in face coordinates. The face's corners
    // run counter-clockwise, so its inside is where a x + b y > c for all.
    const outline = face.map((i) => toFaceCoordinates(faceFrames[f], vertices[i]));
    const lines = outline.map(([ax, ay], i) => {
      const [bx, by] = outline[(i + 1) % outline.length];
      return [ay - by, bx - ax, (ay - by) * ax + (bx - ax) * ay];
    });
    // The point on the solid at face coordinates (x, y) is
    // center + x right + y up, so its dot product with the axis and its
    // squared length are quadratic in x and y.
    const [c0, cr, cu] = [center.dot(axis), right.dot(axis), up.dot(axis)];
    const [rc, uc] = [right.dot(center), up.dot(center)];
    for (let v = rect[1]; v < rect[3]; v++) {
      const y = (v + 0.5 - originY) / layout.density;
      // The pixel centers in the face in this row, from where it crosses the
      // edges.
      let [first, last] = [rect[0], rect[2] - 1];
      for (const [a, b, c] of lines) {
        const u = originX + ((c - b * y) / a) * layout.density - 0.5;
        if (a > 0) first = Math.max(first, Math.floor(u) + 1);
        else if (a < 0) last = Math.min(last, Math.ceil(u) - 1);
        else if (b * y <= c) last = -1;
      }
      for (let u = first; u <= last; u++) {
        const x = (u + 0.5 - originX) / layout.density;
        const lengthSq = center.lengthSq() + 2 * (x * rc + y * uc) + x * x + y * y;
        cosines[v * layout.width + u] = (c0 + x * cr + y * cu) / Math.sqrt(lengthSq);
      }
    }
  });
  return cosines;
}

// A fill over an unpainted solid, at the atlas size the app uses, reaches
// every pixel of every face and so also fills every cell's margin. This
// catches fills that can't cross an edge, as happened along the spikes' base
// edges on the great stellated dodecahedron, which run straight across the
// atlas, and fills that miss the pixel at a corner.
const blank = new Uint8Array(4096 * 4096 * 4).fill(200);
for (const [id, polyhedron] of POLYHEDRA) {
  const layout = createAtlasLayout(polyhedron, 4096);
  const seed = seedAt(polyhedron, layout, projectToSurface(polyhedron, new Vector3(1, 2, 3)));
  const mask = maskOf(layout, floodFill(polyhedron, layout, blank, [seed], PAINT));
  layout.cells.forEach(({ rect: [left, bottom, right, top] }, f) => {
    for (let v = bottom; v < top; v++) {
      const row = mask.subarray(v * layout.width + left, v * layout.width + right);
      assert.equal(row.indexOf(0), -1, `${id}: the fill misses part of face ${f}'s cell in row ${v}`);
    }
  });
}

// A band painted around the solid stops a fill: it covers the side it starts
// on and leaves the other side alone. The band runs at a fixed angle from an
// axis through the center, so both sides are connected even on the stellated
// solids, which are only star-shaped around the center.
const AXIS = new Vector3(1, 2, 3).normalize();
const BAND_ANGLE = 1.2;
const BAND_HALF_WIDTH = 0.05;
// Past the band, and well inside the side the fill starts on, where a pixel
// can't be cut off from the rest of that side by the band's jagged edge.
const [beyond, within] = [Math.cos(BAND_ANGLE + BAND_HALF_WIDTH), Math.cos(BAND_ANGLE - 2 * BAND_HALF_WIDTH)];
for (const [id, polyhedron] of POLYHEDRA) {
  const layout = createAtlasLayout(polyhedron, 2048);
  const cosines = cosinesFrom(AXIS, polyhedron, layout);
  const pixels = new Uint8Array(layout.width * layout.height * 4).fill(200);
  const [low, high] = [Math.cos(BAND_ANGLE + BAND_HALF_WIDTH), Math.cos(BAND_ANGLE - BAND_HALF_WIDTH)];
  cosines.forEach((cosine, i) => {
    if (cosine > low && cosine < high) pixels.fill(0, 4 * i, 4 * i + 3);
  });
  const seed = seedAt(polyhedron, layout, projectToSurface(polyhedron, AXIS));
  const mask = maskOf(layout, floodFill(polyhedron, layout, pixels, [seed], PAINT));
  let [leaked, missed] = [0, 0];
  cosines.forEach((cosine, i) => {
    if (cosine < beyond) leaked += mask[i];
    else if (cosine > within) missed += 1 - mask[i];
  });
  assert.equal(leaked, 0, `${id}: the fill leaks past the band`);
  assert.equal(missed, 0, `${id}: the fill stops short of the band`);
}

console.log(`Fills of ${POLYHEDRA.size} solids OK: they reach every face of an unpainted solid and stop at a painted band.`);
