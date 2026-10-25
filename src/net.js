import { toFaceCoordinates } from './polyhedra.js';

// Glue tabs are trapezoids on one side of every cut edge. Their sides lean in
// by less than the 36° gap left at a dodecahedron's vertices, the narrowest of
// the five solids, so a tab never runs into the face across the gap.
const TAB_HEIGHT = 0.15;
const TAB_ANGLE = (30 * Math.PI) / 180;
// Sizes on the printed net, in world units.
const MARGIN = 0.1;
const LINE_WIDTH = 0.005;
const FOLD_DASHES = [0.04, 0.03];
const LINE_COLOR = '#1d1d1f';
const TAB_COLOR = '#dedad2';
// Safari refuses to draw canvases with more pixels than this.
const MAX_PIXELS = 16_000_000;
const EPSILON = 1e-6;

const IDENTITY = { xx: 1, xy: 0, yx: 0, yy: 1, x: 0, y: 0 };

const apply = ({ xx, xy, yx, yy, x, y }, [px, py]) => [xx * px + xy * py + x, yx * px + yy * py + y];

// The rotation and translation taking the segment from a to b onto the one
// from A to B, which has the same length.
function rigidMap([ax, ay], [bx, by], [Ax, Ay], [Bx, By]) {
  const [dx, dy] = [bx - ax, by - ay];
  const [Dx, Dy] = [Bx - Ax, By - Ay];
  const lengthSq = dx * dx + dy * dy;
  const cos = (dx * Dx + dy * Dy) / lengthSq;
  const sin = (dx * Dy - dy * Dx) / lengthSq;
  return { xx: cos, xy: -sin, yx: sin, yy: cos, x: Ax - cos * ax + sin * ay, y: Ay - sin * ax - cos * ay };
}

// A rotation about the origin, applied after `map`.
function rotate({ xx, xy, yx, yy, x, y }, angle) {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  return {
    xx: cos * xx - sin * yx,
    xy: cos * xy - sin * yy,
    yx: sin * xx + cos * yx,
    yy: sin * xy + cos * yy,
    x: cos * x - sin * y,
    y: sin * x + cos * y,
  };
}

function bounds(points) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

// Tests whether two convex polygons overlap by more than touching.
function overlaps(p, q) {
  for (const polygon of [p, q]) {
    for (let i = 0; i < polygon.length; i++) {
      const [x1, y1] = polygon[i];
      const [x2, y2] = polygon[(i + 1) % polygon.length];
      const length = Math.hypot(x2 - x1, y2 - y1);
      const project = (points) => points.map(([x, y]) => ((y2 - y1) * x - (x2 - x1) * y) / length);
      const ps = project(p);
      const qs = project(q);
      if (Math.max(...ps) < Math.min(...qs) + EPSILON || Math.max(...qs) < Math.min(...ps) + EPSILON) return false;
    }
  }
  return true;
}

// A glue tab on the outside of the net edge from p to q, which runs
// counter-clockwise around its face.
function tab([px, py], [qx, qy]) {
  const length = Math.hypot(qx - px, qy - py);
  const [dx, dy] = [(qx - px) / length, (qy - py) / length];
  const height = TAB_HEIGHT * length;
  const inset = height / Math.tan(TAB_ANGLE);
  return [
    [px, py],
    [px + inset * dx + height * dy, py + inset * dy - height * dx],
    [qx - inset * dx + height * dy, qy - inset * dy - height * dx],
    [qx, qy],
  ];
}

// Unfolds a polyhedron into a net by cutting the edges that a breadth-first
// spanning tree of its faces doesn't cross. No edge unfolding of a Platonic
// solid overlaps itself, so any spanning tree will do.
//
// Returns each face's placement, mapping its face coordinates into the net,
// and its corners there. Folds are the segments to fold along, cuts the lines
// to cut along, and tabs the glue tabs' outlines, all as lists of points.
export function unfold({ vertices, faces, faceFrames }) {
  const corners = faces.map((face, f) => face.map((i) => toFaceCoordinates(faceFrames[f], vertices[i])));
  const edgesOf = (f) => faces[f].map((a, i) => [i, a, faces[f][(i + 1) % faces[f].length]]);
  // Faces list their vertices counter-clockwise from outside, so the face
  // across an edge runs along it the other way.
  const faceAlong = new Map();
  faces.forEach((_, f) => {
    for (const [, a, b] of edgesOf(f)) faceAlong.set(`${a}-${b}`, f);
  });

  let placements = [IDENTITY];
  const treeEdges = new Set();
  // Iterating the queue also visits the faces pushed onto it on the way.
  const queue = [0];
  for (const f of queue) {
    for (const [i, a, b] of edgesOf(f)) {
      const g = faceAlong.get(`${b}-${a}`);
      if (placements[g]) continue;
      const j = faces[g].indexOf(b);
      placements[g] = rigidMap(
        corners[g][(j + 1) % faces[g].length],
        corners[g][j],
        apply(placements[f], corners[f][i]),
        apply(placements[f], corners[f][(i + 1) % faces[f].length]),
      );
      treeEdges.add(`${a}-${b}`).add(`${b}-${a}`);
      queue.push(g);
    }
  }

  // Lines the net up with whichever of its edges gives it the smallest
  // bounding box, to make the best use of the paper.
  const place = (maps) => corners.map((points, f) => points.map((p) => apply(maps[f], p)));
  const areaTurnedBy = (angle) => {
    const { minX, maxX, minY, maxY } = bounds(place(placements.map((map) => rotate(map, angle))).flat());
    return (maxX - minX) * (maxY - minY);
  };
  const turns = place(placements).flatMap((polygon) =>
    polygon.map(([px, py], i) => {
      const [qx, qy] = polygon[(i + 1) % polygon.length];
      return -Math.atan2(qy - py, qx - px);
    }),
  );
  const turn = turns.reduce((best, angle) => (areaTurnedBy(angle) < areaTurnedBy(best) ? angle : best));
  placements = placements.map((map) => rotate(map, turn));

  const netFaces = place(placements);
  const segment = (f, i) => [netFaces[f][i], netFaces[f][(i + 1) % faces[f].length]];
  const folds = [];
  const cuts = [];
  const tabs = [];
  faces.forEach((_, f) => {
    for (const [i, a, b] of edgesOf(f)) {
      // Takes each edge once, from the face that has it going up.
      if (a > b) continue;
      if (treeEdges.has(`${a}-${b}`)) {
        folds.push(segment(f, i));
        continue;
      }
      // A cut edge is on the outline twice; it gets a tab on the first side
      // where the tab is clear of the rest of the net.
      const g = faceAlong.get(`${b}-${a}`);
      const sides = [segment(f, i), segment(g, faces[g].indexOf(b))];
      const tabbed = sides.findIndex((side) => {
        const outline = tab(...side);
        return ![...netFaces, ...tabs].some((polygon) => overlaps(outline, polygon));
      });
      sides.forEach((side, k) => {
        if (k === tabbed) {
          tabs.push(tab(...side));
          folds.push(side);
        } else {
          cuts.push(side);
        }
      });
    }
  });
  for (const outline of tabs) cuts.push(outline);

  return { placements, faces: netFaces, folds, cuts, tabs };
}

// Grows a regular polygon outward by `amount`.
function grow(polygon, amount) {
  const cx = polygon.reduce((sum, [x]) => sum + x, 0) / polygon.length;
  const cy = polygon.reduce((sum, [, y]) => sum + y, 0) / polygon.length;
  const [[ax, ay], [bx, by]] = polygon;
  const factor = 1 + amount / Math.hypot((ax + bx) / 2 - cx, (ay + by) / 2 - cy);
  return polygon.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

// Draws a net, painting each face from `atlas`, a canvas holding the painter's
// texture with its bottom row first. Uses the texture's resolution unless the
// canvas would get too large.
export function drawNet({ placements, faces, folds, cuts, tabs }, layout, atlas) {
  const { minX, maxX, minY, maxY } = bounds([...faces, ...tabs].flat());
  const [width, height] = [maxX - minX + 2 * MARGIN, maxY - minY + 2 * MARGIN];
  const scale = Math.min(layout.density, Math.sqrt(MAX_PIXELS / (width * height)));

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext('2d');
  // The canvas's y axis points down.
  const pageX = (x) => (x - minX + MARGIN) * scale;
  const pageY = (y) => (maxY + MARGIN - y) * scale;
  const trace = (points, close = false) => {
    context.beginPath();
    for (const [x, y] of points) context.lineTo(pageX(x), pageY(y));
    if (close) context.closePath();
  };

  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = TAB_COLOR;
  for (const outline of tabs) {
    trace(outline, true);
    context.fill();
  }

  // Atlas texels are (originX, originY) + density × face coordinates.
  context.imageSmoothingQuality = 'high';
  const k = scale / layout.density;
  faces.forEach((polygon, f) => {
    const { xx, xy, yx, yy, x, y } = placements[f];
    const {
      originX,
      originY,
      rect: [left, bottom, right, top],
    } = layout.cells[f];
    context.save();
    // Overlaps the neighboring faces by a pixel, so no gap shows between them.
    trace(grow(polygon, 1 / scale), true);
    context.clip();
    context.setTransform(
      k * xx,
      -k * yx,
      k * xy,
      -k * yy,
      pageX(x) - k * (xx * originX + xy * originY),
      pageY(y) + k * (yx * originX + yy * originY),
    );
    const [cellWidth, cellHeight] = [right - left, top - bottom];
    context.drawImage(atlas, left, bottom, cellWidth, cellHeight, left, bottom, cellWidth, cellHeight);
    context.restore();
  });

  context.strokeStyle = LINE_COLOR;
  context.lineWidth = LINE_WIDTH * scale;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  for (const line of cuts) {
    trace(line);
    context.stroke();
  }
  context.setLineDash(FOLD_DASHES.map((length) => length * scale));
  context.globalAlpha = 0.5;
  for (const line of folds) {
    trace(line);
    context.stroke();
  }
  return canvas;
}
