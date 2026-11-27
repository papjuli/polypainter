import assert from 'node:assert/strict';
import { POLYHEDRA, atTurn, toFaceCoordinates } from './polyhedra.js';
import { straightLine, traceLine } from './painter.js';

const EPSILON = 1e-9;

const onFace = ({ center, right, up }, [x, y]) => center.clone().addScaledVector(right, x).addScaledVector(up, y);
const move = ({ xx, xy, yx, yy, x, y }, [u, v]) => [xx * u + xy * v + x, yx * u + yy * v + y];
const near = ([a, b], [c, d], epsilon = EPSILON) => Math.hypot(a - c, b - d) < epsilon;
const pieceLength = ({ from, to }) => Math.hypot(to[0] - from[0], to[1] - from[1]);

// How far a point is to the left of the line from a to b, which is inside a
// face for each of its edges.
function leftOf([px, py], [ax, ay], [bx, by]) {
  return ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / Math.hypot(bx - ax, by - ay);
}

// The point a distance along a line, in space.
function pointAlong(surface, { pieces }, s) {
  for (const piece of pieces) {
    const length = pieceLength(piece);
    if (s <= length || piece === pieces.at(-1)) {
      const t = length > 0 ? Math.min(s / length, 1) : 0;
      return { face: piece.face, point: onFace(surface.faceFrames[piece.face], [0, 1].map((i) => piece.from[i] + (piece.to[i] - piece.from[i]) * t)) };
    }
    s -= length;
  }
}

// A point well inside each face, away from its center and corners, and a
// direction from it, both chosen to be in no special place.
function startOn(corners, f) {
  const [a, b] = corners[f];
  return { face: f, x: 0.3 * a[0] + 0.2 * b[0], y: 0.3 * a[1] + 0.2 * b[1] };
}
const directionFor = (f) => [Math.cos(1 + 0.7 * f), Math.sin(1 + 0.7 * f)];

// A straight line on the surface must be straight on each face it crosses,
// cross from each face into the face glued to it there, and cross each edge
// straight: laid flat, the faces on either side of the edge would put the two
// pieces in one line, so both pieces make the same angle with the edge. The
// motion kept with each piece must lay the line flat in the start face's
// coordinates, which straightLine() relies on. Kaleidocycles are checked at
// a turn, which mustn't matter.
let lines = 0;
for (const polyhedron of POLYHEDRA.values()) {
  const surface = atTurn(polyhedron, 0.3);
  const { vertices, faces, faceFrames, adjacent } = surface;
  const corners = faces.map((face, f) => face.map((i) => toFaceCoordinates(faceFrames[f], vertices[i])));
  for (let f = 0; f < faces.length; f++) {
    const start = startOn(corners, f);
    const direction = directionFor(f);
    const length = 3;
    const line = traceLine(surface, start, direction, length);
    const { pieces } = line;
    const id = `${polyhedron.id}, from face ${f}`;
    assert.equal(pieces[0].face, f, id);
    assert.ok(near(pieces[0].from, [start.x, start.y]), id);
    assert.ok(Math.abs(pieces.reduce((sum, piece) => sum + pieceLength(piece), 0) - length) < EPSILON, `${id}: length`);

    let s = 0;
    pieces.forEach((piece, k) => {
      const n = corners[piece.face].length;
      for (const end of [piece.from, piece.to]) {
        const inside = corners[piece.face].every((a, i) => leftOf(end, a, corners[piece.face][(i + 1) % n]) > -EPSILON);
        assert.ok(inside, `${id}: piece ${k} leaves its face`);
      }
      for (const [end, along] of [[piece.from, s], [piece.to, s + pieceLength(piece)]]) {
        const flat = [start.x + direction[0] * along, start.y + direction[1] * along];
        assert.ok(near(move(piece.motion, flat), end), `${id}: piece ${k} isn't laid flat along the line`);
      }
      s += pieceLength(piece);
      if (k === 0) return;

      const before = pieces[k - 1];
      const crossing = onFace(faceFrames[piece.face], piece.from);
      assert.ok(onFace(faceFrames[before.face], before.to).distanceTo(crossing) < EPSILON, `${id}: gap before piece ${k}`);
      // The edge crossed, as face `before.face` has it.
      const edge = corners[before.face].findIndex((a, i) => {
        const b = corners[before.face][(i + 1) % corners[before.face].length];
        return adjacent[before.face][i][0] === piece.face && Math.abs(leftOf(before.to, a, b)) < EPSILON;
      });
      assert.ok(edge >= 0, `${id}: piece ${k} isn't across an edge from the piece before it`);
      // A line through a corner has a piece of no length; it has no direction.
      if (pieceLength(before) < EPSILON || pieceLength(piece) < EPSILON) return;
      const face = faces[before.face];
      const along = vertices[face[(edge + 1) % face.length]].clone().sub(vertices[face[edge]]).normalize();
      const directionOf = ({ face: g, from, to }) => onFace(faceFrames[g], to).sub(onFace(faceFrames[g], from)).normalize();
      assert.ok(Math.abs(directionOf(before).dot(along) - directionOf(piece).dot(along)) < 1e-7, `${id}: bent at piece ${k}`);
    });
    lines++;
  }
}

// On a cube, a line from the middle of a face toward the middle of one of its
// edges goes around the cube and back to where it started, through four
// faces.
{
  const surface = POLYHEDRA.get('cube');
  const { vertices, faces } = surface;
  const edge = vertices[faces[0][0]].distanceTo(vertices[faces[0][1]]);
  const { pieces } = traceLine(surface, { face: 0, x: 0, y: 0 }, [0, 1], 4 * edge);
  const around = pieces.map((piece) => piece.face);
  assert.equal(around.length, 5, 'around a cube');
  assert.equal(new Set(around).size, 4, 'around a cube');
  assert.equal(around.at(-1), 0, 'around a cube');
  assert.ok(near(pieces.at(-1).to, [0, 0]), 'around a cube');
}

// The pointer moves on along a path beside the line's start, going over
// edges and past corners, and the line from the start must keep up with it.
// On a convex solid there is always a straight line to the pointer. So there
// is on a kaleidocycle, whose surface lies flat around every corner. Behind
// a stellated solid's valleys, where the faces add up to more than a full
// turn, no straight line reaches, so there the line may come up short.
let steps = 0;
let missed = 0;
for (const polyhedron of POLYHEDRA.values()) {
  const surface = atTurn(polyhedron, 0.3);
  const { vertices, faces, faceFrames } = surface;
  const corners = faces.map((face, f) => face.map((i) => toFaceCoordinates(faceFrames[f], vertices[i])));
  const stellated = polyhedron.family === 'Stellations';
  let solidMissed = 0;
  let solidSteps = 0;
  const every = Math.max(1, Math.floor(faces.length / 12));
  for (let f = 0; f < faces.length; f += every) {
    const start = startOn(corners, f);
    const [dx, dy] = directionFor(f);
    // A step to the side of the start, and from there, onward beside the
    // way the line first heads.
    const aside = traceLine(surface, start, [-dy, dx], 0.1);
    const last = aside.pieces.at(-1);
    const { xx, xy, yx, yy } = last.motion;
    const onward = traceLine(surface, { face: last.face, x: last.to[0], y: last.to[1] }, [xx * dx + xy * dy, yx * dx + yy * dy], 1.5);
    const path = [];
    for (let s = 0.01; s <= aside.length; s += 0.01) path.push(pointAlong(surface, aside, s).point);
    for (let s = 0; s <= onward.length; s += 0.01) path.push(pointAlong(surface, onward, s).point);

    let line = traceLine(surface, start, [1, 0], 0);
    for (const point of path) {
      line = straightLine(surface, line, point);
      assert.equal(line.pieces[0].face, f);
      assert.ok(near(line.pieces[0].from, [start.x, start.y]));
      const end = line.pieces.at(-1);
      const reached = onFace(faceFrames[end.face], end.to).distanceTo(point) < 1e-6;
      assert.ok(reached || stellated, `${polyhedron.id}: the line from face ${f} doesn't reach the pointer`);
      solidSteps++;
      if (!reached) solidMissed++;
    }
  }
  // Even on stellated solids, the gaps are small.
  assert.ok(solidMissed < 0.2 * solidSteps, `${polyhedron.id}: ${solidMissed} of ${solidSteps} lines miss the pointer`);
  steps += solidSteps;
  missed += solidMissed;
}

console.log(
  `Lines OK: ${lines} lines on ${POLYHEDRA.size} solids go straight across the edges they cross; ` +
    `${steps - missed} of ${steps} lines followed the pointer to it, the rest behind the valleys of stellated solids.`,
);
