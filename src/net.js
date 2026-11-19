import { area, simplify, traceOutlines } from './contours.js';

// Draws the nets that tools/build_nets.py lays out ahead of time, in
// src/nets/<id>.json, one net placed on the page for each assembly method.
// A net holds each face's placement, mapping its face coordinates onto the
// page, and the face's corners there, the scale, and the folds, cuts, slits
// (as cut), printSlits (as printed) and tabs, as lists of points in mm.

// The page, A4 portrait, in mm with the origin at its bottom left corner.
export const PAGE_WIDTH = 210;
export const PAGE_HEIGHT = 297;
// A whole number of pixels per mm, about 300 dpi, so the image is exactly the
// size of the page.
export const PIXELS_PER_MM = 12;
// How far the outlines of holes, cut where the paint is transparent, may
// stray from it to save points, in mm, and the smallest hole cut, in mm².
const HOLE_TOLERANCE = 0.02;
const MIN_HOLE_AREA = 1;
// Sizes on the printed page, in mm. tools/unfold.py keeps the nets a line
// width inside the page's margins, as printed lines reach past the outline.
const LINE_WIDTH = 0.3;
const FOLD_DASHES = [2.4, 1.8];
const LINE_COLOR = '#1d1d1f';
const TAB_COLOR = '#dedad2';

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
  const { folds, cuts, tabs, slits = [], printSlits = slits } = net;
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
  for (const line of [...cuts, ...printSlits]) {
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
