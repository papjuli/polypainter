import assert from 'node:assert/strict';
import { POLYHEDRA, atTurn, toFaceCoordinates } from './polyhedra.js';
import { stampFootprint } from './painter.js';

const EPSILON = 1e-9;
const ANGLE = 0.7;

// Where a point, in the coordinates of a face a stamp reaches, is in the
// stamp's own coordinates.
function inStamp({ x, y, xAxis, yAxis }, [u, v]) {
  return [(u - x) * xAxis[0] + (v - y) * xAxis[1], (u - x) * yAxis[0] + (v - y) * yAxis[1]];
}

const near = ([a, b], [c, d]) => Math.hypot(a - c, b - d) < EPSILON;

// A stamp goes on like a sticker, laid flat across edges, so each face it
// reaches must have been reached across an edge from another, and both must
// put the ends of that edge at the same place in the stamp. A face that
// joins the stamp across no edge, or turned or mirrored the wrong way, would
// have a piece of it out of place. Kaleidocycles are stamped at a turn, which
// mustn't matter, as they are painted laid flat.
let stamps = 0;
for (const polyhedron of POLYHEDRA.values()) {
  const surface = atTurn(polyhedron, 0.3);
  const { vertices, faces, faceFrames, adjacent } = surface;
  const corners = faces.map((face, f) => face.map((i) => toFaceCoordinates(faceFrames[f], vertices[i])));
  for (let f = 0; f < faces.length; f++) {
    // Toward a corner, and large enough to reach past it onto several faces.
    const { center } = faceFrames[f];
    const corner = vertices[faces[f][0]];
    const point = center.clone().lerp(corner, 0.6);
    const radius = 0.8 * center.distanceTo(corner);
    const footprint = stampFootprint(surface, point, f, radius, ANGLE, 0);
    const pieces = new Map(footprint.map((piece) => [piece.face, piece]));
    assert.equal(pieces.size, footprint.length, `${polyhedron.id}: a face is stamped twice`);
    assert.ok(pieces.size > 1, `${polyhedron.id}: the stamp should reach past face ${f}`);

    const start = pieces.get(f);
    assert.ok(near(inStamp(start, toFaceCoordinates(faceFrames[f], point)), [0, 0]), `${polyhedron.id}: center`);
    assert.ok(near(start.xAxis, [Math.cos(ANGLE), Math.sin(ANGLE)]), `${polyhedron.id}: turn`);

    for (const piece of footprint) {
      const { xAxis: [a, b], yAxis: [c, d] } = piece;
      assert.ok(Math.abs(a * a + b * b - 1) < EPSILON && Math.abs(c * c + d * d - 1) < EPSILON, 'unit axes');
      assert.ok(Math.abs(a * c + b * d) < EPSILON, 'perpendicular axes');
      assert.ok(a * d - b * c > 0, `${polyhedron.id}: a stamp mustn't be mirrored where it is laid flat`);
      if (piece.face === f) continue;
      const g = piece.face;
      const joined = corners[g].some((from, i) => {
        const [h, j] = adjacent[g][i];
        const other = pieces.get(h);
        if (!other) return false;
        const to = corners[g][(i + 1) % corners[g].length];
        // Edge j of face h runs the other way, from `to` to `from`.
        const [hTo, hFrom] = [corners[h][j], corners[h][(j + 1) % corners[h].length]];
        return near(inStamp(piece, from), inStamp(other, hFrom)) && near(inStamp(piece, to), inStamp(other, hTo));
      });
      assert.ok(joined, `${polyhedron.id}: face ${g} of a stamp on face ${f} joins none of its neighbors`);
    }
    stamps++;
  }
}

console.log(
  `Stamps OK: ${stamps} stamps on ${POLYHEDRA.size} solids, one by every face, lie flat across the edges they ` +
    'cross, turned as asked.',
);
