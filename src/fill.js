import { toFaceCoordinates } from './polyhedra.js';

// How far a pixel's color may be from the color filled over, per channel out
// of 255, so the fill also takes in the faint outer rim of strokes.
const TOLERANCE = 48;

// How far off the line from the color filled over to a neighbor's color a
// pixel at the rim of the fill may be and still count as a blend of the two,
// as a fraction of the distance between them, plus a little for rounding.
const OFF_BLEND = 0.1;
const OFF_BLEND_ROUNDING = 0.01;

// The atlas stores colors in sRGB with the alpha premultiplied in linear light,
// which is how the GPU blends them, so the rim of a fill is worked out there.
const LINEAR = Float32Array.from({ length: 256 }, (_, byte) => {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

// What the fill does to each pixel: nothing, cover it with the fill color, or
// blend the fill color in at its rim.
const UNTOUCHED = 0;
const TAKEN = 1;
const BLENDED = 2;

// How far, in pixels, a step across an edge may go from where it lands to the
// nearest pixel of the face there. Of the four pixel centers around a point
// inside an edge, at least one is inside the edge too, so a pixel's diagonal
// reaches a pixel of the face from anywhere along the edge away from corners.
const STEP_REACH = Math.SQRT2;

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
    // The pixels in row v whose centers lie in the face, as [start, end).
    const span = (v) => {
      const y = v + 0.5;
      let min = Infinity;
      let max = -Infinity;
      outline.forEach(([px, py], i) => {
        const [qx, qy] = outline[(i + 1) % n];
        if (py === qy || (py - y) * (qy - y) > 0) return;
        const x = px + ((y - py) * (qx - px)) / (qy - py);
        min = Math.min(min, x);
        max = Math.max(max, x);
      });
      return [Math.ceil(min - 0.5), Math.floor(max - 0.5) + 1];
    };
    const ys = outline.map(([, y]) => y);
    let bottom = Math.ceil(Math.min(...ys) - 0.5);
    let top = Math.floor(Math.max(...ys) - 0.5) + 1;
    // Leaves out the end rows that only graze a corner, passing it between
    // pixel centers. A pixel kept there can be cut off from the face's other
    // pixels, so no fill reaches it, and the margin beyond it, which copies
    // it, stays unfilled too.
    const grazes = (v) => {
      const [start, end] = span(v);
      return end <= start;
    };
    while (top - bottom > 1 && grazes(bottom)) bottom++;
    while (top - bottom > 1 && grazes(top - 1)) top--;
    const rows = top - bottom;
    const starts = new Int32Array(rows);
    const ends = new Int32Array(rows);
    for (let k = 0; k < rows; k++) {
      const [start, end] = span(bottom + k);
      starts[k] = start;
      // Keeps at least one pixel in any other row too narrow to hold one.
      ends[k] = Math.max(end, start + 1);
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
//
// The pixel's center lands as far inside the face beyond as it was outside
// this one, often less than half a pixel. The pixel it lands in can then have
// its center outside that face, so it isn't one of the face's pixels. Along an
// edge that runs straight across the atlas, that happens at every pixel, and
// the fill could never cross it. So the step goes to the face's pixel nearest
// to where the center lands.
function stepAcross(regions, f, u, v) {
  const [x, y] = [u + 0.5, v + 0.5];
  const distance = ({ normal, offset }) => normal[0] * x + normal[1] * y - offset;
  const edge = regions[f].edges.reduce((best, edge) => (distance(edge) > distance(best) ? edge : best));
  const [mx, my] = edge.map(x, y);
  const region = regions[edge.face];
  let nearest = null;
  let nearestSq = STEP_REACH * STEP_REACH;
  for (let mv = Math.ceil(my - 0.5 - STEP_REACH); mv <= my - 0.5 + STEP_REACH; mv++) {
    for (let mu = Math.ceil(mx - 0.5 - STEP_REACH); mu <= mx - 0.5 + STEP_REACH; mu++) {
      const distanceSq = (mu + 0.5 - mx) ** 2 + (mv + 0.5 - my) ** 2;
      if (distanceSq <= nearestSq && inside(region, mu, mv)) {
        nearest = [edge.face, mu, mv];
        nearestSq = distanceSq;
      }
    }
  }
  return nearest;
}

// The pixel at (u, v) in the atlas if its center lies in face f, or else the
// pixel a step across the edge it is past lands on, as [face, pixel index].
// Returns nothing past a corner.
function pixelAt(regions, width, f, u, v) {
  if (inside(regions[f], u, v)) return [f, v * width + u];
  const step = stepAcross(regions, f, u, v);
  return step && [step[0], step[2] * width + step[1]];
}

// Finds what a bucket fill covers: the pixels of `pixels`, the atlas as RGBA
// bytes with the alpha premultiplied, bottom row first, that connect to a seed
// through pixels close to its color, crossing from face to face over their
// edges. Seeds are { face, x, y } in atlas texels. Leaves out seeds already
// close to `color`, a THREE.Color, or null for transparent paint.
//
// Pixels at the soft rim of a stroke, too far from the color filled over to
// be covered, still hold some of it. The fill replaces that share with its own
// color and keeps the rest, so the rim stays smooth instead of showing a halo
// of the old color.
//
// Returns { runs, rim }: the covered pixels as a list of [start, end) runs of
// pixel indices, and the rim as `pixels`, their indices, and `colors`, the
// colors they take, as linear RGBA with the alpha premultiplied. Each face's
// margin in the atlas is filled out from its edges.
export function floodFill(polyhedron, layout, pixels, seeds, color) {
  const { width, height } = layout;
  const regions = faceRegions(polyhedron, layout);
  const mask = new Uint8Array(width * height);
  // The colors of the pixels marked BLENDED, by pixel index.
  const rimColors = new Map();
  const near = (i, [r, g, b, a]) =>
    Math.abs(pixels[4 * i] - r) <= TOLERANCE &&
    Math.abs(pixels[4 * i + 1] - g) <= TOLERANCE &&
    Math.abs(pixels[4 * i + 2] - b) <= TOLERANCE &&
    Math.abs(pixels[4 * i + 3] - a) <= TOLERANCE;
  const linearAt = (i) => [
    LINEAR[pixels[4 * i]],
    LINEAR[pixels[4 * i + 1]],
    LINEAR[pixels[4 * i + 2]],
    pixels[4 * i + 3] / 255,
  ];
  // With the alpha premultiplied, transparent paint is zero in every channel.
  const hex = color?.getHex() ?? 0;
  const fillColor = [hex >> 16, (hex >> 8) & 255, hex & 255, color ? 255 : 0];
  const fillLinear = color ? [color.r, color.g, color.b, 1] : [0, 0, 0, 0];

  // The difference from `target` to the color of pixel i, written into `out`,
  // and its squared length.
  const difference = (i, target, out) => {
    let lengthSq = 0;
    for (let k = 0; k < 4; k++) {
      const byte = pixels[4 * i + k];
      out[k] = (k < 3 ? LINEAR[byte] : byte / 255) - target[k];
      lengthSq += out[k] * out[k];
    }
    return lengthSq;
  };
  const [toP, toN, toS] = [new Float64Array(4), new Float64Array(4), new Float64Array(4)];

  // How much of a pixel's color is something other than `target`, from 0 to
  // 1. The pixel is taken to be a blend of the target and the neighbor
  // farthest from it, as at the rim of a stroke, where that neighbor is the
  // stroke's solid color. A pixel farther from the target than all its
  // neighbors, or off the line between the target and that neighbor, holds
  // none of the target.
  const otherShare = (i, target) => {
    const u = i % width;
    const v = (i - u) / width;
    let farthestSq = difference(i, target, toP);
    let farthest = -1;
    for (let nv = Math.max(v - 1, 0); nv <= Math.min(v + 1, height - 1); nv++) {
      for (let nu = Math.max(u - 1, 0); nu <= Math.min(u + 1, width - 1); nu++) {
        const distanceSq = difference(nv * width + nu, target, toN);
        if (distanceSq > farthestSq) [farthestSq, farthest] = [distanceSq, nv * width + nu];
      }
    }
    if (farthest === -1) return 1;
    difference(farthest, target, toS);
    let share = 0;
    for (let k = 0; k < 4; k++) share += toP[k] * toS[k];
    share /= farthestSq;
    if (share <= 0) return 1;
    let offSq = 0;
    for (let k = 0; k < 4; k++) offSq += (toP[k] - share * toS[k]) ** 2;
    const offMax = OFF_BLEND * Math.sqrt(farthestSq) + OFF_BLEND_ROUNDING;
    return offSq <= offMax * offMax ? Math.min(share, 1) : 1;
  };

  for (const seed of seeds) {
    const [u, v] = clampInto(regions[seed.face], Math.floor(seed.x), Math.floor(seed.y));
    const start = v * width + u;
    if (mask[start] === TAKEN || near(start, fillColor)) continue;
    const target = [pixels[4 * start], pixels[4 * start + 1], pixels[4 * start + 2], pixels[4 * start + 3]];
    const targetLinear = linearAt(start);

    mask[start] = TAKEN;
    const stack = [seed.face, start];
    // Pixels next to the fill that it doesn't cover, as face, pixel index and
    // the other share of the pixel they were reached from, 0 from a covered
    // pixel.
    const rim = [];
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
      if (mask[i] === TAKEN) return;
      if (near(i, target)) {
        mask[i] = TAKEN;
        stack.push(f, i);
      } else if (mask[i] === UNTOUCHED) {
        rim.push(f, i, 0);
      }
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

    // Blends the fill into the rim around what it covers, going outward for
    // as long as the pixels hold less and less of the target. On a soft edge
    // seen at an angle, more than one pixel across can hold some of it, but
    // past a thin line the pixels hold more of it again, so the rim stops at
    // the line rather than reaching across it.
    while (rim.length > 0) {
      const from = rim.pop();
      const i = rim.pop();
      const f = rim.pop();
      if (mask[i] !== UNTOUCHED) continue;
      const share = otherShare(i, targetLinear);
      if (share <= from || 1 - share < 1 / 255) continue;
      mask[i] = BLENDED;
      const blend = linearAt(i).map((value, k) => value + (1 - share) * (fillLinear[k] - targetLinear[k]));
      const alpha = Math.min(Math.max(blend[3], 0), 1);
      rimColors.set(i, [...blend.slice(0, 3).map((value) => Math.min(Math.max(value, 0), alpha)), alpha]);
      const u = i % width;
      const v = (i - u) / width;
      for (const [nu, nv] of [[u - 1, v], [u + 1, v], [u, v - 1], [u, v + 1]]) {
        const step = pixelAt(regions, width, f, nu, nv);
        if (step && mask[step[1]] === UNTOUCHED) rim.push(step[0], step[1], share);
      }
    }
  }

  // Extends each face's edge pixels out over the rest of its cell, so texture
  // filtering at the edges doesn't pick up the old paint.
  const copyRim = (to, from, count) => {
    for (let k = 0; k < count; k++) {
      if (mask[from + k] === BLENDED) rimColors.set(to + k, rimColors.get(from + k));
    }
  };
  const fillRim = (to, end, from) => {
    if (mask[from] !== BLENDED) return;
    for (let i = to; i < end; i++) rimColors.set(i, rimColors.get(from));
  };
  regions.forEach((region, f) => {
    const [left, bottom, right, top] = layout.cells[f].rect;
    for (let v = bottom; v < top; v++) {
      // Rows above and below the face copy its nearest row.
      const k = Math.min(Math.max(v - region.bottom, 0), region.rows - 1);
      const [row, source] = [v * width, (region.bottom + k) * width];
      const [start, end] = [region.starts[k], region.ends[k]];
      if (row !== source) {
        mask.copyWithin(row + start, source + start, source + end);
        copyRim(row + start, source + start, end - start);
      }
      mask.fill(mask[source + start], row + left, row + start);
      fillRim(row + left, row + start, source + start);
      mask.fill(mask[source + end - 1], row + end, row + right);
      fillRim(row + end, row + right, source + end - 1);
    }
  });

  const rimPixels = [];
  const colors = [];
  for (const [i, rimColor] of rimColors) {
    if (mask[i] !== BLENDED) continue;
    rimPixels.push(i);
    colors.push(...rimColor);
    mask[i] = UNTOUCHED;
  }

  const runs = [];
  for (let start, end = 0; (start = mask.indexOf(TAKEN, end)) !== -1; ) {
    end = mask.indexOf(UNTOUCHED, start);
    if (end === -1) end = mask.length;
    runs.push(start, end);
  }
  return {
    runs: Uint32Array.from(runs),
    rim: { pixels: Uint32Array.from(rimPixels), colors: Float32Array.from(colors) },
  };
}
