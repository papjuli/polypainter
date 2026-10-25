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

// Nets tried for each solid, the one coming out largest on the page winning,
// and the most attempts at finding them in one piece.
const UNFOLDINGS = 12;
const UNFOLD_ATTEMPTS = 300;

// Glue tabs are trapezoids on one side of every cut edge, TAB_HEIGHT times as
// tall as the edge is long. The gap between the faces at the end of an edge
// can be narrow, so their sides rise from the edge at a shallower angle where
// they have to, which makes them lower, leaving their tops TAB_TOP times as
// long as the edge.
const TAB_HEIGHT = 0.15;
const TAB_TOP = 0.2;
// The angles tried at the two ends of a tab, steepest first.
const TAB_ANGLES = [30, 20, 10, 5]
  .flatMap((a, _, angles) => angles.map((b) => [a, b]))
  .sort(([a, b], [c, d]) => Math.min(c, d) - Math.min(a, b) || Math.max(c, d) - Math.max(a, b))
  .map((angles) => angles.map((degrees) => (degrees * Math.PI) / 180));
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

const boxesOverlap = (a, b) =>
  a.maxX > b.minX + EPSILON && b.maxX > a.minX + EPSILON && a.maxY > b.minY + EPSILON && b.maxY > a.minY + EPSILON;

// Tests whether two convex polygons overlap by more than touching.
function overlaps(p, q) {
  if (!boxesOverlap(bounds(p), bounds(q))) return false;
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

// Tests whether two polygons touch along a stretch of their edges.
function alongside(p, q) {
  return p.some(([ax, ay], i) => {
    const [bx, by] = p[(i + 1) % p.length];
    const length = Math.hypot(bx - ax, by - ay);
    const across = ([x, y]) => ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / length;
    const along = ([x, y]) => ((bx - ax) * (x - ax) + (by - ay) * (y - ay)) / length;
    return q.some((c, j) => {
      const d = q[(j + 1) % q.length];
      if (Math.abs(across(c)) > EPSILON || Math.abs(across(d)) > EPSILON) return false;
      const [start, end] = [along(c), along(d)].sort((s, t) => s - t);
      return Math.min(end, length) - Math.max(start, 0) > EPSILON;
    });
  });
}

// A glue tab on the outside of the net edge from p to q, which runs
// counter-clockwise around its face, with its sides rising from the edge at
// the given angles.
function tab([px, py], [qx, qy], [startAngle, endAngle]) {
  const length = Math.hypot(qx - px, qy - py);
  const [dx, dy] = [(qx - px) / length, (qy - py) / length];
  const [startRun, endRun] = [1 / Math.tan(startAngle), 1 / Math.tan(endAngle)];
  const height = Math.min(TAB_HEIGHT, (1 - TAB_TOP) / (startRun + endRun)) * length;
  return [
    [px, py],
    [px + height * (startRun * dx + dy), py + height * (startRun * dy - dx)],
    [qx + height * (dy - endRun * dx), qy - height * (dx + endRun * dy)],
    [qx, qy],
  ];
}

// A pseudo-random number generator, seeded so that a solid unfolds the same
// way every time.
function seededRandom(seed) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

// Unfolds a polyhedron into pieces of net, growing each breadth first across
// the edges of its faces and leaving out faces that would overlap it. Faces
// left out start more pieces. Takes the faces in their own order, or in an
// order shuffled by `random` when given.
//
// Returns the pieces as lists of faces, each face's placement, mapping its
// face coordinates into the piece, its corners there, and the edges the net
// folds along.
function growPieces({ vertices, faces, faceFrames }, random) {
  const shuffle = (list) =>
    random
      ? list
          .map((item) => [random(), item])
          .sort(([a], [b]) => a - b)
          .map(([, item]) => item)
      : list;
  const corners = faces.map((face, f) => face.map((i) => toFaceCoordinates(faceFrames[f], vertices[i])));
  const edgesOf = (f) => faces[f].map((a, i) => [i, a, faces[f][(i + 1) % faces[f].length]]);
  // Faces list their vertices counter-clockwise from outside, so the face
  // across an edge runs along it the other way.
  const faceAlong = new Map();
  faces.forEach((_, f) => {
    for (const [, a, b] of edgesOf(f)) faceAlong.set(`${a}-${b}`, f);
  });

  const pieces = [];
  const placements = [];
  const polygons = [];
  const folds = new Set();
  for (const root of shuffle(faces.map((_, f) => f))) {
    if (placements[root]) continue;
    const piece = [root];
    [placements[root], polygons[root]] = [IDENTITY, corners[root]];
    // Iterating the piece also visits the faces pushed onto it on the way.
    for (const f of piece) {
      for (const [i, a, b] of shuffle(edgesOf(f))) {
        const g = faceAlong.get(`${b}-${a}`);
        if (placements[g]) continue;
        const j = faces[g].indexOf(b);
        const placement = rigidMap(
          corners[g][(j + 1) % faces[g].length],
          corners[g][j],
          polygons[f][i],
          polygons[f][(i + 1) % faces[f].length],
        );
        const polygon = corners[g].map((p) => apply(placement, p));
        // A face lying along an edge of another face, other than the one it
        // hangs from, would leave no room for a tab between the two.
        if (piece.some((h) => overlaps(polygon, polygons[h]) || (h !== f && alongside(polygon, polygons[h])))) {
          continue;
        }
        [placements[g], polygons[g]] = [placement, polygon];
        folds.add(`${a}-${b}`).add(`${b}-${a}`);
        piece.push(g);
      }
    }
    pieces.push(piece);
  }
  return { pieces, placements, polygons, folds };
}

// Lays the pieces of a net out in rows, apart enough for their tabs, each
// turned to its smallest bounding box, at the row width that lets them come
// out largest on the page.
function packPieces({ pieces, placements, polygons, folds }) {
  const move = (piece, map) => {
    for (const f of piece) {
      placements[f] = compose(map, placements[f]);
      polygons[f] = polygons[f].map((p) => apply(map, p));
    }
  };
  const edges = polygons.flatMap((polygon) =>
    polygon.map(([x, y], i) => {
      const [nextX, nextY] = polygon[(i + 1) % polygon.length];
      return [nextX - x, nextY - y];
    }),
  );
  const gap = 3 * TAB_HEIGHT * Math.max(...edges.map(([dx, dy]) => Math.hypot(dx, dy)));
  const boxes = pieces.map((piece) => {
    const points = piece.flatMap((f) => polygons[f]);
    const turns = piece.flatMap((f) =>
      polygons[f].map(([x, y], i) => {
        const [nextX, nextY] = polygons[f][(i + 1) % polygons[f].length];
        return -Math.atan2(nextY - y, nextX - x);
      }),
    );
    const area = (angle) => {
      const { minX, maxX, minY, maxY } = bounds(points.map((p) => apply(similarity(angle), p)));
      return (maxX - minX) * (maxY - minY);
    };
    move(
      piece,
      similarity(turns.reduce((best, angle) => (area(angle) < area(best) ? angle : best))),
    );
    return bounds(piece.flatMap((f) => polygons[f]));
  });

  // Fills rows left to right, tallest pieces first.
  const order = pieces.map((_, k) => k).sort((k, l) => boxes[l].maxY - boxes[l].minY - (boxes[k].maxY - boxes[k].minY));
  const layOut = (width) => {
    const spots = [];
    let [x, y, rowHeight, right] = [0, 0, 0, 0];
    for (const k of order) {
      const { minX, maxX, minY, maxY } = boxes[k];
      if (x > 0 && x + maxX - minX > width) [x, y, rowHeight] = [0, y + rowHeight + gap, 0];
      spots[k] = [x - minX, y - minY];
      right = Math.max(right, x + maxX - minX);
      rowHeight = Math.max(rowHeight, maxY - minY);
      x += maxX - minX + gap;
    }
    const [roomX, roomY] = [PAGE_WIDTH - 2 * PAGE_MARGIN, PAGE_HEIGHT - 2 * PAGE_MARGIN];
    const [w, h] = [right, y + rowHeight];
    return { spots, fit: Math.max(Math.min(roomX / w, roomY / h), Math.min(roomX / h, roomY / w)) };
  };
  // Tries breaking the first row after each piece.
  const widths = order.map((_, n) =>
    order.slice(0, n + 1).reduce((sum, k) => sum + boxes[k].maxX - boxes[k].minX + gap, 0),
  );
  const { spots } = widths.map(layOut).reduce((best, layout) => (layout.fit > best.fit ? layout : best));
  pieces.forEach((piece, k) => move(piece, { ...IDENTITY, x: spots[k][0], y: spots[k][1] }));
  return { placements, polygons, folds };
}

// Adds the tabs, and sorts the edges of an unfolded polyhedron into those to
// fold along and those to cut along.
//
// Returns each face's placement and its corners in the net. Folds are the
// segments to fold along, cuts the lines to cut along, and tabs the glue
// tabs' outlines, all as lists of points.
function finishNet({ faces }, { placements, polygons, folds: foldEdges }) {
  const segment = (f, i) => [polygons[f][i], polygons[f][(i + 1) % faces[f].length]];
  const faceAlong = new Map();
  faces.forEach((face, f) => face.forEach((a, i) => faceAlong.set(`${a}-${face[(i + 1) % face.length]}`, f)));
  const folds = [];
  const cuts = [];
  const tabs = [];
  const taken = polygons.map((polygon) => ({ polygon, box: bounds(polygon) }));
  const clear = (outline) => {
    const box = bounds(outline);
    return !taken.some((other) => boxesOverlap(box, other.box) && overlaps(outline, other.polygon));
  };
  faces.forEach((face, f) => {
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length];
      // Takes each edge once, from the face that has it going up.
      if (a > b) return;
      if (foldEdges.has(`${a}-${b}`)) {
        folds.push(segment(f, i));
        return;
      }
      // A cut edge is on the outline twice; it gets the largest tab that is
      // clear of the rest of the net on either side.
      const g = faceAlong.get(`${b}-${a}`);
      const sides = [segment(f, i), segment(g, faces[g].indexOf(b))];
      let tabbed = null;
      for (const angles of TAB_ANGLES) {
        tabbed = sides.map((side) => ({ side, outline: tab(...side, angles) })).find(({ outline }) => clear(outline));
        if (tabbed) break;
      }
      for (const side of sides) {
        if (side === tabbed?.side) {
          tabs.push(tabbed.outline);
          taken.push({ polygon: tabbed.outline, box: bounds(tabbed.outline) });
          folds.push(side);
        } else {
          cuts.push(side);
        }
      }
    });
  });
  for (const outline of tabs) cuts.push(outline);

  return { placements, faces: polygons, folds, cuts, tabs };
}

// Unfolds a polyhedron into nets in a few ways, in as few pieces as it can.
function unfold(polyhedron) {
  const random = seededRandom(1);
  let nets = [];
  for (let attempt = 0; attempt < UNFOLD_ATTEMPTS; attempt++) {
    // The first attempt takes the faces in their own order.
    const unfolded = growPieces(polyhedron, attempt === 0 ? null : random);
    const fewest = nets[0]?.pieces.length ?? Infinity;
    if (unfolded.pieces.length < fewest) nets = [unfolded];
    else if (unfolded.pieces.length === fewest && nets.length < UNFOLDINGS) nets.push(unfolded);
    if (nets.length === UNFOLDINGS && fewest === 1) break;
  }
  return nets.map((unfolded) => finishNet(polyhedron, packPieces(unfolded)));
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
function placeOnPage({ placements, faces, folds, cuts, tabs }) {
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
    scale: best.scale,
  };
}

// Unfolds a polyhedron and places it on the page, picking the net that comes
// out largest there.
export function netOnPage(polyhedron) {
  return unfold(polyhedron)
    .map(placeOnPage)
    .reduce((best, net) => (net.scale > best.scale ? net : best));
}

// Grows a convex polygon that runs counter-clockwise outward by `amount`,
// cutting its corners off, so no point moves further than that.
function grow(polygon, amount) {
  const outward = ([ax, ay], [bx, by]) => {
    const length = Math.hypot(bx - ax, by - ay);
    return [(amount * (by - ay)) / length, (amount * (ax - bx)) / length];
  };
  return polygon.flatMap(([x, y], i) => {
    const [inX, inY] = outward(polygon.at(i - 1), [x, y]);
    const [outX, outY] = outward([x, y], polygon[(i + 1) % polygon.length]);
    return [
      [x + inX, y + inY],
      [x + outX, y + outY],
    ];
  });
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
function drawFaces(context, { placements, faces, scale }, layout, atlas) {
  // Shrinking an image smoothly is slow to do for every face, so where the
  // faces come out smaller than in the atlas, it is shrunk to their size once.
  const shrink = Math.min((PIXELS_PER_MM * scale) / layout.density, 1);
  let source = atlas;
  if (shrink < 1) {
    source = document.createElement('canvas');
    source.width = Math.ceil(atlas.width * shrink);
    source.height = Math.ceil(atlas.height * shrink);
    const sourceContext = source.getContext('2d');
    sourceContext.imageSmoothingQuality = 'high';
    sourceContext.drawImage(atlas, 0, 0, atlas.width * shrink, atlas.height * shrink);
  } else {
    context.imageSmoothingQuality = 'high';
  }

  // Atlas texels are (originX, originY) + density × face coordinates, and
  // those of the source `shrink` times as much.
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
      (k * xx) / shrink,
      (-k * yx) / shrink,
      (k * xy) / shrink,
      (-k * yy) / shrink,
      canvasX(x) - k * (xx * originX + xy * originY),
      canvasY(y) + k * (yx * originX + yy * originY),
    );
    const cell = [left, bottom, right - left, top - bottom].map((value) => value * shrink);
    context.drawImage(source, ...cell, ...cell);
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
