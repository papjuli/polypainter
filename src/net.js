import { area, simplify, traceOutlines } from './contours.js';
import { toFaceCoordinates } from './polyhedra.js';

// The page, A4 portrait, in mm with the origin at its bottom left corner.
export const PAGE_WIDTH = 210;
export const PAGE_HEIGHT = 297;
// A whole number of pixels per mm, about 300 dpi, so the image is exactly the
// size of the page.
export const PIXELS_PER_MM = 12;
// Silhouette Studio's print and cut wants the edges of the page clear, and
// the top left, top right and bottom left corners for its registration marks.
// These leave the room its default marks take, with some to spare.
const PAGE_MARGIN = 16;
const CORNER_SIZE = 41;
// Bisection steps when fitting a net onto the page, and the positions tried
// across the page in each direction at each step.
const FIT_STEPS = 20;
const FIT_POSITIONS = 9;
// How far the outlines of holes, cut where the paint is transparent, may
// stray from it to save points, in mm, and the smallest hole cut, in mm².
const HOLE_TOLERANCE = 0.02;
const MIN_HOLE_AREA = 1;

// Glue tabs are trapezoids on one side of every cut edge. Their sides lean in
// by less than the 36° gap left at a dodecahedron's vertices, the narrowest of
// the five solids, so a tab never runs into the face across the gap.
const TAB_HEIGHT = 0.15;
const TAB_ANGLE = (30 * Math.PI) / 180;
// Sizes on the printed page, in mm.
const LINE_WIDTH = 0.3;
const FOLD_DASHES = [2.4, 1.8];
const LINE_COLOR = '#1d1d1f';
const TAB_COLOR = '#dedad2';
const EPSILON = 1e-6;

// The net keeps a line width further from the edges and corners, as printed
// lines reach past its outline by half their width, and faces are drawn a
// pixel larger.
const FIT_MARGIN = PAGE_MARGIN + LINE_WIDTH;
const FIT_CORNER_SIZE = CORNER_SIZE + LINE_WIDTH;
const square = (left, bottom, size) => [
  [left, bottom],
  [left + size, bottom],
  [left + size, bottom + size],
  [left, bottom + size],
];
const MARK_CORNERS = [
  square(0, PAGE_HEIGHT - FIT_CORNER_SIZE, FIT_CORNER_SIZE),
  square(PAGE_WIDTH - FIT_CORNER_SIZE, PAGE_HEIGHT - FIT_CORNER_SIZE, FIT_CORNER_SIZE),
  square(0, 0, FIT_CORNER_SIZE),
];
const MARK_CORNER_BOUNDS = MARK_CORNERS.map(bounds);

// The positions tried for a net at each scale, as fractions of the room it
// has to move across the page, nearest the middle first.
const FIT_GRID = Array.from({ length: FIT_POSITIONS ** 2 }, (_, i) => [
  (i % FIT_POSITIONS) / (FIT_POSITIONS - 1),
  Math.floor(i / FIT_POSITIONS) / (FIT_POSITIONS - 1),
]).sort(([a, b], [c, d]) => Math.hypot(a - 0.5, b - 0.5) - Math.hypot(c - 0.5, d - 0.5));

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

// A rotation by `angle` about the origin and scaling by `scale`, followed by
// a move by (x, y).
function similarity(angle, scale = 1, x = 0, y = 0) {
  const [cos, sin] = [scale * Math.cos(angle), scale * Math.sin(angle)];
  return { xx: cos, xy: -sin, yx: sin, yy: cos, x, y };
}

// The map applying `inner`, then `outer`.
function compose(outer, inner) {
  return {
    xx: outer.xx * inner.xx + outer.xy * inner.yx,
    xy: outer.xx * inner.xy + outer.xy * inner.yy,
    yx: outer.yx * inner.xx + outer.yy * inner.yx,
    yy: outer.yx * inner.xy + outer.yy * inner.yy,
    x: outer.xx * inner.x + outer.xy * inner.y + outer.x,
    y: outer.yx * inner.x + outer.yy * inner.y + outer.y,
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

  const placements = [IDENTITY];
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

  const netFaces = corners.map((points, f) => points.map((p) => apply(placements[f], p)));
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

// Where polygons scaled by `scale` fit on the page, inside its margins and
// clear of the registration marks' corners, as the move to put them there.
function findPlace(polygons, scale) {
  const boxes = polygons.map(bounds);
  const { minX, maxX, minY, maxY } = bounds(polygons.flat());
  const [left, right] = [FIT_MARGIN - scale * minX, PAGE_WIDTH - FIT_MARGIN - scale * maxX];
  const [bottom, top] = [FIT_MARGIN - scale * minY, PAGE_HEIGHT - FIT_MARGIN - scale * maxY];
  if (left > right || bottom > top) return null;
  const clearAt = (x, y) =>
    polygons.every((polygon, i) =>
      MARK_CORNERS.every((corner, j) => {
        const [box, cornerBox] = [boxes[i], MARK_CORNER_BOUNDS[j]];
        if (
          x + scale * box.minX >= cornerBox.maxX ||
          x + scale * box.maxX <= cornerBox.minX ||
          y + scale * box.minY >= cornerBox.maxY ||
          y + scale * box.maxY <= cornerBox.minY
        ) {
          return true;
        }
        return !overlaps(
          polygon.map(([px, py]) => [x + scale * px, y + scale * py]),
          corner,
        );
      }),
    );
  for (const [u, v] of FIT_GRID) {
    const [x, y] = [left + u * (right - left), bottom + v * (top - bottom)];
    if (clearAt(x, y)) return [x, y];
  }
  return null;
}

// Places a net on the page, in mm, turned and scaled to be as large as fits.
export function placeOnPage({ placements, faces, folds, cuts, tabs }) {
  const polygons = [...faces, ...tabs];
  // Tries the net with each edge of its faces along each side of the page.
  const angles = new Map();
  for (const polygon of faces) {
    polygon.forEach(([px, py], i) => {
      const [qx, qy] = polygon[(i + 1) % polygon.length];
      for (let k = 0; k < 4; k++) {
        const angle = ((k * Math.PI) / 2 - Math.atan2(qy - py, qx - px) + 4 * Math.PI) % (2 * Math.PI);
        angles.set(angle.toFixed(6), angle);
      }
    });
  }

  let best = { scale: 0 };
  for (const angle of angles.values()) {
    const turned = polygons.map((polygon) => polygon.map((p) => apply(similarity(angle), p)));
    const { minX, maxX, minY, maxY } = bounds(turned.flat());
    // Bisects up to the scale at which the net fills the space within the
    // margins, from the best scale so far, as the angle has to beat it.
    let low = best.scale;
    let high = Math.min(
      (PAGE_WIDTH - 2 * FIT_MARGIN) / (maxX - minX),
      (PAGE_HEIGHT - 2 * FIT_MARGIN) / (maxY - minY),
    );
    for (let step = 0; step < FIT_STEPS && low < high; step++) {
      const scale = (low + high) / 2;
      const place = findPlace(turned, scale);
      if (place) {
        best = { angle, scale, place };
        low = scale;
      } else {
        high = scale;
      }
    }
  }

  const map = similarity(best.angle, best.scale, ...best.place);
  const move = (points) => points.map((p) => apply(map, p));
  return {
    placements: placements.map((placement) => compose(map, placement)),
    faces: faces.map(move),
    folds: folds.map(move),
    cuts: cuts.map(move),
    tabs: tabs.map(move),
  };
}

// Grows a regular polygon outward by `amount`.
function grow(polygon, amount) {
  const cx = polygon.reduce((sum, [x]) => sum + x, 0) / polygon.length;
  const cy = polygon.reduce((sum, [, y]) => sum + y, 0) / polygon.length;
  const [[ax, ay], [bx, by]] = polygon;
  const factor = 1 + amount / Math.hypot((ax + bx) / 2 - cx, (ay + by) / 2 - cy);
  return polygon.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]);
}

// The canvas's y axis points down.
const canvasX = (x) => x * PIXELS_PER_MM;
const canvasY = (y) => (PAGE_HEIGHT - y) * PIXELS_PER_MM;

function pageCanvas(options) {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_WIDTH * PIXELS_PER_MM;
  canvas.height = PAGE_HEIGHT * PIXELS_PER_MM;
  return [canvas, canvas.getContext('2d', options)];
}

// Adds a line through points on the page to the context's path.
function trace(context, points, close = false) {
  const [[x0, y0], ...rest] = points;
  context.moveTo(canvasX(x0), canvasY(y0));
  for (const [x, y] of rest) context.lineTo(canvasX(x), canvasY(y));
  if (close) context.closePath();
}

// Paints each face of a net placed on the page from `atlas`, a canvas holding
// the painter's texture with its bottom row first.
function drawFaces(context, { placements, faces }, layout, atlas) {
  // Atlas texels are (originX, originY) + density × face coordinates.
  context.imageSmoothingQuality = 'high';
  const k = PIXELS_PER_MM / layout.density;
  faces.forEach((polygon, f) => {
    const { xx, xy, yx, yy, x, y } = placements[f];
    const {
      originX,
      originY,
      rect: [left, bottom, right, top],
    } = layout.cells[f];
    context.save();
    // Overlaps the neighboring faces by a pixel, so no gap shows between them.
    context.beginPath();
    trace(context, grow(polygon, 1 / PIXELS_PER_MM), true);
    context.clip();
    context.setTransform(
      k * xx,
      -k * yx,
      k * xy,
      -k * yy,
      canvasX(x) - k * (xx * originX + xy * originY),
      canvasY(y) + k * (yx * originX + yy * originY),
    );
    const [cellWidth, cellHeight] = [right - left, top - bottom];
    context.drawImage(atlas, left, bottom, cellWidth, cellHeight, left, bottom, cellWidth, cellHeight);
    context.restore();
  });
}

// Draws a net placed on the page, painting each face from `atlas`, a canvas
// holding the painter's texture with its bottom row first.
export function drawNet(net, layout, atlas) {
  const { folds, cuts, tabs } = net;
  const [canvas, context] = pageCanvas();
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = TAB_COLOR;
  for (const outline of tabs) {
    context.beginPath();
    trace(context, outline, true);
    context.fill();
  }

  drawFaces(context, net, layout, atlas);

  context.strokeStyle = LINE_COLOR;
  context.lineWidth = LINE_WIDTH * PIXELS_PER_MM;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  for (const line of cuts) {
    context.beginPath();
    trace(context, line);
    context.stroke();
  }
  context.setLineDash(FOLD_DASHES.map((length) => length * PIXELS_PER_MM));
  context.globalAlpha = 0.5;
  for (const line of folds) {
    context.beginPath();
    trace(context, line);
    context.stroke();
  }
  return canvas;
}

// Finds the outlines of the transparent paint on a net placed on the page, in
// mm, painting its faces from `atlas` as drawNet does. Leaves out specks.
export function findHoles(net, layout, atlas) {
  const [canvas, context] = pageCanvas({ willReadFrequently: true });
  const { width, height } = canvas;
  drawFaces(context, net, layout, atlas);
  const paint = context.getImageData(0, 0, width, height).data;
  // The faces are filled as one, so no seams show between them.
  context.clearRect(0, 0, width, height);
  context.beginPath();
  for (const polygon of net.faces) trace(context, polygon, true);
  context.fill();
  const cover = context.getImageData(0, 0, width, height).data;

  // How much of each pixel is a hole: on the net, without paint.
  const holes = new Float32Array(width * height);
  for (let i = 0; i < holes.length; i++) holes[i] = (cover[4 * i + 3] * (255 - paint[4 * i + 3])) / 255 ** 2;
  // Outlines run through pixel centers.
  const toPage = ([x, y]) => [(x + 0.5) / PIXELS_PER_MM, PAGE_HEIGHT - (y + 0.5) / PIXELS_PER_MM];
  return traceOutlines(holes, width, height)
    .map((outline) => simplify(outline, HOLE_TOLERANCE * PIXELS_PER_MM).map(toPage))
    .filter((outline) => Math.abs(area(outline)) >= MIN_HOLE_AREA);
}
