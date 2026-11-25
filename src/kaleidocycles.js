import { Matrix4, Vector3 } from 'three';

// A kaleidocycle is a ring of identical tetrahedra, each joined to the next
// by a hinge along an edge, that turns through its own middle without end.
// Each tetrahedron's two hinges are opposite edges of it, at right angles to
// each other, of the same length, with the line between their midpoints at
// right angles to both. Its four faces are alike: isosceles triangles with a
// hinge as their base.
//
// Going around the ring, each hinge is a quarter turn from the last around
// the line to the next, alternately one way and the other. A ring of six is
// one of the chains of six hinges that Bricard found can move. Longer rings
// can move in more ways; these move the way that keeps their symmetry, with
// the angles at the hinges taking turns between two values, θ and φ, which
// keep cos(θ/2) cos(φ/2) = cos(2π/N) for a ring of N tetrahedra. One full
// turn of the ring goes once around that curve, as each tetrahedron rolls
// over once around the ring's core.
//
// Lengths are in units of the distance between a tetrahedron's hinges.

// The direction of a hinge in its own frame.
const HINGE_DIRECTION = new Vector3(0, 0, 1);

// The angles at the even and odd hinges `turn` of the way around the ring's
// motion, starting where they are equal and every hinge is alike. The point
// on the curve is found along a ray from (0, 0) in the (θ, φ) plane, so turns
// go evenly around it. Along the ray the product of cosines falls from 1 to
// 0, crossing cos(2π/N) once, where both angles are below a half turn.
export function hingeAngles(count, turn) {
  const target = Math.cos((2 * Math.PI) / count);
  const direction = Math.PI / 4 + 2 * Math.PI * turn;
  const [s, c] = [Math.sin(direction), Math.cos(direction)];
  const product = (r) => Math.cos((r * s) / 2) * Math.cos((r * c) / 2);
  let low = 0;
  let high = Math.PI / Math.max(Math.abs(s), Math.abs(c));
  for (let step = 0; step < 60; step++) {
    const middle = (low + high) / 2;
    if (product(middle) > target) low = middle;
    else high = middle;
  }
  const r = (low + high) / 2;
  return [r * s, r * c];
}

// The step from one hinge's frame to the next: a turn by `angle` about the
// hinge, which lies along z, a unit step along the line to the next hinge,
// along x, and a quarter turn about that line, alternately one way and the
// other.
function link(angle, even) {
  return new Matrix4()
    .makeRotationZ(angle)
    .multiply(new Matrix4().makeTranslation(1, 0, 0))
    .multiply(new Matrix4().makeRotationX(even ? Math.PI / 2 : -Math.PI / 2));
}

// The ends of the hinges of a ring of `count` tetrahedra with hinges
// `hinge` times as long as the distance between them, `turn` of the way
// around its motion: vertex 2k and 2k + 1 are the ends of hinge k, which
// tetrahedra k - 1 and k share. The ring's axis is y, the hinges' midpoints
// are centered on it, and hinge 0's midpoint is in the direction of x, so
// the ring stays in place as it turns, as the midpoints only move in and out
// and up and down.
export function ringVertices(count, hinge, turn) {
  const [theta, phi] = hingeAngles(count, turn);
  const frames = [new Matrix4()];
  for (let k = 0; k < count - 1; k++) {
    frames.push(frames[k].clone().multiply(link(k % 2 === 0 ? theta : phi, k % 2 === 0)));
  }
  const midpoints = frames.map((frame) => new Vector3().setFromMatrixPosition(frame));
  const directions = frames.map((frame) => HINGE_DIRECTION.clone().transformDirection(frame));

  // Two steps along the ring turn it about its axis by 4π/N.
  const step = link(theta, true).multiply(link(phi, false));
  const axis = rotationAxis(step);
  const center = midpoints.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(count);
  const toward = midpoints[0].clone().sub(center);
  const x = toward.addScaledVector(axis, -toward.dot(axis)).normalize();
  const z = new Vector3().crossVectors(x, axis);
  // Rows of the matrix taking the ring's frame to x, y = axis and z.
  const ring = new Matrix4().makeBasis(x, axis, z).transpose();

  return midpoints.flatMap((midpoint, k) =>
    [-1, 1].map((end) =>
      midpoint
        .clone()
        .addScaledVector(directions[k], (end * hinge) / 2)
        .sub(center)
        .applyMatrix4(ring),
    ),
  );
}

// The axis of the rotation in a rigid motion, which turns by less than a half
// turn, from the antisymmetric part of its rotation.
function rotationAxis(matrix) {
  const e = matrix.elements;
  return new Vector3(e[6] - e[9], e[8] - e[2], e[1] - e[4]).normalize();
}

// The faces of the ring, four per tetrahedron, tetrahedron by tetrahedron,
// each with its hinge first, so all of them have the same face coordinates,
// and counter-clockwise when seen from outside, which is away from the rest
// of its tetrahedron. Also which face lies across each edge of each face, as
// [face, edge], since a hinge has four faces, two from each tetrahedron.
export function ringFaces(count, vertices) {
  const end = (k, side) => (2 * k + side) % (2 * count);
  const faces = [];
  for (let k = 0; k < count; k++) {
    const corners = [end(k, 0), end(k, 1), end(k + 1, 0), end(k + 1, 1)];
    const middle = corners.reduce((sum, i) => sum.add(vertices[i]), new Vector3()).divideScalar(4);
    for (const [a, b, apexes] of [
      [corners[0], corners[1], [corners[2], corners[3]]],
      [corners[2], corners[3], [corners[0], corners[1]]],
    ]) {
      for (const apex of apexes) {
        const normal = new Vector3()
          .subVectors(vertices[b], vertices[a])
          .cross(new Vector3().subVectors(vertices[apex], vertices[a]));
        faces.push(normal.dot(new Vector3().subVectors(vertices[a], middle)) > 0 ? [a, b, apex] : [b, a, apex]);
      }
    }
  }

  // Edges other than hinges have two faces, which run along them opposite
  // ways. Of the four faces on a hinge, each pairs with the face of the other
  // tetrahedron that it faces across the gap between them, not across the
  // inside of its own tetrahedron. Going around the hinge, each tetrahedron
  // fills a wedge between its two faces, so each face pairs with the nearer
  // face of the other tetrahedron on its outer side.
  const along = new Map();
  faces.forEach((face, f) => {
    face.forEach((a, i) => {
      const key = `${a}-${face[(i + 1) % 3]}`;
      along.set(key, [...(along.get(key) ?? []), [f, i]]);
    });
  });
  const adjacent = faces.map((face, f) =>
    face.map((a, i) => {
      const b = face[(i + 1) % 3];
      const across = along.get(`${b}-${a}`);
      if (across.length === 1) return across[0];
      const [axisStart, axisEnd] = [vertices[a], vertices[b]];
      const axis = new Vector3().subVectors(axisEnd, axisStart).normalize();
      // The angle around the hinge, from this face's outward side, to each
      // candidate face, turning away from this face's own tetrahedron.
      const outward = (g) => {
        const apex = vertices[faces[g][2]].clone().sub(axisStart);
        return apex.addScaledVector(axis, -apex.dot(axis)).normalize();
      };
      const own = outward(f);
      const angleTo = (g) => {
        const other = outward(g);
        const angle = Math.atan2(new Vector3().crossVectors(own, other).dot(axis), own.dot(other));
        return (angle + 2 * Math.PI) % (2 * Math.PI);
      };
      return across.reduce((best, candidate) => (angleTo(candidate[0]) < angleTo(best[0]) ? candidate : best));
    }),
  );
  return { faces, adjacent };
}
