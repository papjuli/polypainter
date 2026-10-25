import { toFaceCoordinates } from './polyhedra.js';

// How far a pixel's color may be from the color filled over, per channel out
// of 255, so the fill also takes in the faint outer rim of strokes.
const TOLERANCE = 48;

// The rotation and translation taking a to A and b to B, where the segments
// from a to b and from A to B have the same length.
function rigidMap([ax, ay], [bx, by], [Ax, Ay], [Bx, By]) {
  const [dx, dy] = [bx - ax, by - ay];
  const [Dx, Dy] = [Bx - Ax, By - Ay];
  const lengthSq = dx * dx + dy * dy;
  const cos = (dx * Dx + dy * Dy) / lengthSq;
  const sin = (dx * Dy - dy * Dx) / lengthSq;
  return (x, y) => [cos * x - sin * y + Ax - cos * ax + sin * ay, sin * x + cos * y + Ay - sin * ax - cos * ay];
}

// Each face's pixels in the atlas, as a span per row of the pixels whose
// centers lie in the face, and its edges, with a map taking atlas positions
// beyond an edge to the face across it, unfolded flat.
function faceRegions({ vertices, faces, faceFrames }, layout) {
  const outlines = faces.map((face, f) => {
    const { originX, originY } = layout.cells[f];
    return face.map((i) => {
      const [x, y] = toFaceCoordinates(faceFrames[f], vertices[i]);
      return [originX + x * layout.density, originY + y * layout.density];
    });
  });
  // Faces list their vertices counter-clockwise from outside, so the face
  // across an edge runs along it the other way.
  const edgeAlong = new Map();
  faces.forEach((face, f) => face.forEach((a, i) => edgeAlong.set(`${a}-${face[(i + 1) % face.length]}`, [f, i])));

  return outlines.map((outline, f) => {
    const n = outline.length;
    const ys = outline.map(([, y]) => y);
    const bottom = Math.ceil(Math.min(...ys) - 0.5);
    const rows = Math.floor(Math.max(...ys) - 0.5) + 1 - bottom;
    const starts = new Int32Array(rows);
    const ends = new Int32Array(rows);
    for (let k = 0; k < rows; k++) {
      const y = bottom + k + 0.5;
      let min = Infinity;
      let max = -Infinity;
      outline.forEach(([px, py], i) => {
        const [qx, qy] = outline[(i + 1) % n];
        if (py === qy || (py - y) * (qy - y) > 0) return;
        const x = px + ((y - py) * (qx - px)) / (qy - py);
        min = Math.min(min, x);
        max = Math.max(max, x);
      });
      starts[k] = Math.ceil(min - 0.5);
      // Keeps at least one pixel in a row that only grazes a corner.
      ends[k] = Math.max(Math.floor(max - 0.5) + 1, starts[k] + 1);
    }

    const edges = faces[f].map((a, i) => {
      const b = faces[f][(i + 1) % n];
      const [g, j] = edgeAlong.get(`${b}-${a}`);
      const [[ax, ay], [bx, by]] = [outline[i], outline[(i + 1) % n]];
      const length = Math.hypot(bx - ax, by - ay);
      const normal = [(by - ay) / length, (ax - bx) / length];
      const across = outlines[g];
      return {
        normal,
        offset: normal[0] * ax + normal[1] * ay,
        face: g,
        map: rigidMap(outline[i], outline[(i + 1) % n], across[(j + 1) % across.length], across[j]),
      };
    });
    return { bottom, rows, starts, ends, edges };
  });
}

function inside({ bottom, rows, starts, ends }, u, v) {
  const k = v - bottom;
  return k >= 0 && k < rows && u >= starts[k] && u < ends[k];
}

// The face pixel nearest to a pixel off the face, near enough at least.
function clampInto({ bottom, rows, starts, ends }, u, v) {
  const k = Math.min(Math.max(v - bottom, 0), rows - 1);
  return [Math.min(Math.max(u, starts[k]), ends[k] - 1), bottom + k];
}

// Steps from a pixel just off a face onto the face beyond the edge it is past,
// returning that face and pixel, or nothing past a corner.
function stepAcross(regions, f, u, v) {
  const [x, y] = [u + 0.5, v + 0.5];
  const distance = ({ normal, offset }) => normal[0] * x + normal[1] * y - offset;
  const edge = regions[f].edges.reduce((best, edge) => (distance(edge) > distance(best) ? edge : best));
  const [mx, my] = edge.map(x, y);
  const [mu, mv] = [Math.floor(mx), Math.floor(my)];
  return inside(regions[edge.face], mu, mv) ? [edge.face, mu, mv] : null;
}

// Finds what a bucket fill covers: the pixels of `pixels`, the atlas as RGBA
// bytes bottom row first, that connect to a seed through pixels close to its
// color, crossing from face to face over their edges. Seeds are { face, x, y }
// in atlas texels. Leaves out seeds already close to `color`, a THREE.Color.
//
// Returns the covered pixels as a list of [start, end) runs of pixel indices,
// with each face's margin in the atlas filled out from its edges.
export function floodFill(polyhedron, layout, pixels, seeds, color) {
  const { width, height } = layout;
  const regions = faceRegions(polyhedron, layout);
  const mask = new Uint8Array(width * height);
  const near = (i, [r, g, b]) =>
    Math.abs(pixels[4 * i] - r) <= TOLERANCE &&
    Math.abs(pixels[4 * i + 1] - g) <= TOLERANCE &&
    Math.abs(pixels[4 * i + 2] - b) <= TOLERANCE;
  const hex = color.getHex();
  const fillColor = [hex >> 16, (hex >> 8) & 255, hex & 255];

  for (const seed of seeds) {
    const [u, v] = clampInto(regions[seed.face], Math.floor(seed.x), Math.floor(seed.y));
    const start = v * width + u;
    if (mask[start] || near(start, fillColor)) continue;
    const target = [pixels[4 * start], pixels[4 * start + 1], pixels[4 * start + 2]];

    mask[start] = 1;
    const stack = [seed.face, start];
    const visit = (f, u, v) => {
      let i;
      if (inside(regions[f], u, v)) {
        i = v * width + u;
      } else {
        const step = stepAcross(regions, f, u, v);
        if (!step) return;
        [f, u, v] = step;
        i = v * width + u;
      }
      if (mask[i] || !near(i, target)) return;
      mask[i] = 1;
      stack.push(f, i);
    };
    while (stack.length > 0) {
      const i = stack.pop();
      const f = stack.pop();
      const u = i % width;
      const v = (i - u) / width;
      visit(f, u - 1, v);
      visit(f, u + 1, v);
      visit(f, u, v - 1);
      visit(f, u, v + 1);
    }
  }

  // Extends each face's edge pixels out over the rest of its cell, so texture
  // filtering at the edges doesn't pick up the old paint.
  regions.forEach((region, f) => {
    const [left, bottom, right, top] = layout.cells[f].rect;
    for (let v = bottom; v < top; v++) {
      // Rows above and below the face copy its nearest row.
      const k = Math.min(Math.max(v - region.bottom, 0), region.rows - 1);
      const [row, source] = [v * width, (region.bottom + k) * width];
      const [start, end] = [region.starts[k], region.ends[k]];
      if (row !== source) mask.copyWithin(row + start, source + start, source + end);
      mask.fill(mask[source + start], row + left, row + start);
      mask.fill(mask[source + end - 1], row + end, row + right);
    }
  });

  const runs = [];
  for (let start, end = 0; (start = mask.indexOf(1, end)) !== -1; ) {
    end = mask.indexOf(0, start);
    if (end === -1) end = mask.length;
    runs.push(start, end);
  }
  return Uint32Array.from(runs);
}
