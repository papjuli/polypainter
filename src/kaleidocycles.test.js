import assert from 'node:assert/strict';
import { Matrix4, Vector3 } from 'three';
import { POLYHEDRA, atTurn, faceAt, projectToSurface, toFaceCoordinates } from './polyhedra.js';
import { dabFootprint, strokeDabs } from './painter.js';
import { symmetryGroups } from './symmetry.js';

const EPSILON = 1e-6;
// Turns sampled along the motion, unevenly so they don't line up with its
// symmetries.
const TURNS = Array.from({ length: 23 }, (_, k) => (k + 0.37 * Math.sin(k)) / 23);

const kaleidocycles = [...POLYHEDRA.values()].filter((polyhedron) => polyhedron.ring);
assert.ok(kaleidocycles.length > 0);

// The point at face coordinates (x, y) on face f of a solid as it stands.
function pointOn({ faceFrames }, f, x, y) {
  const { center, right, up } = faceFrames[f];
  return center.clone().addScaledVector(right, x).addScaledVector(up, y);
}

// Whether a point lies on face f of a solid as it stands.
function onFace({ vertices, faces, faceFrames }, f, point) {
  const { normal, offset } = faceFrames[f];
  if (Math.abs(normal.dot(point) - offset) > EPSILON) return false;
  return faces[f].every((a, i) => {
    const [start, end] = [vertices[a], vertices[faces[f][(i + 1) % faces[f].length]]];
    return end.clone().sub(start).cross(point.clone().sub(start)).dot(normal) > -EPSILON;
  });
}

// Whether two tetrahedra overlap by more than touching, by the separating axis
// test over their faces' normals and their edges' cross products.
function overlap(a, b) {
  const edges = (t) => [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]].map(([i, j]) => t[j].clone().sub(t[i]));
  const axes = [...edges(a), ...edges(b)].flatMap((e, i, all) => all.slice(i + 1).map((f) => e.clone().cross(f)));
  return axes.every((axis) => {
    if (axis.lengthSq() < EPSILON) return true;
    axis.normalize();
    const [pa, pb] = [a, b].map((t) => t.map((p) => p.dot(axis)));
    return Math.min(Math.max(...pa) - Math.min(...pb), Math.max(...pb) - Math.min(...pa)) > EPSILON;
  });
}

for (const polyhedron of kaleidocycles) {
  const { id, faces, adjacent, ring } = polyhedron;
  assert.equal(faces.length, 4 * ring.count, id);

  // Each edge's two sides run along it opposite ways, and each face is the
  // other's neighbor. The faces around each corner add up to a full turn, so
  // laid flat the surface is a flat torus.
  adjacent.forEach((row, f) =>
    row.forEach(([g, j], i) => {
      assert.deepEqual(adjacent[g][j], [f, i], id);
      assert.equal(faces[g][j], faces[f][(i + 1) % 3], id);
      assert.equal(faces[g][(j + 1) % 3], faces[f][i], id);
    }),
  );
  const angles = new Map();
  faces.forEach((face) =>
    face.forEach((a, i) => {
      const [p, q, r] = [0, 1, 2].map((k) => polyhedron.vertices[face[(i + k) % 3]]);
      const angle = q.clone().sub(p).angleTo(r.clone().sub(p));
      angles.set(a, (angles.get(a) ?? 0) + angle);
    }),
  );
  for (const sum of angles.values()) assert.ok(Math.abs(sum - 2 * Math.PI) < EPSILON, id);

  const rest = faces.map((face, f) => face.map((i) => toFaceCoordinates(polyhedron.faceFrames[f], polyhedron.vertices[i])));
  for (const turn of TURNS) {
    const turned = atTurn(polyhedron, turn);
    const name = `${id} at ${turn.toFixed(3)}`;
    // The tetrahedra move as a whole, so every face keeps its shape and its
    // face coordinates, and the ring stays within reach of the camera's fit.
    faces.forEach((face, f) => {
      const frame = turned.faceFrames[f];
      face.forEach((i, k) => {
        const [x, y] = toFaceCoordinates(frame, turned.vertices[i]);
        assert.ok(Math.hypot(x - rest[f][k][0], y - rest[f][k][1]) < EPSILON, name);
        assert.ok(Math.abs(frame.normal.dot(turned.vertices[i]) - frame.offset) < EPSILON, name);
      });
    });
    for (const vertex of turned.vertices) assert.ok(vertex.length() < 1 + 1e-3, name);

    // No two tetrahedra go through each other.
    const tetrahedra = Array.from({ length: ring.count }, (_, k) =>
      [...new Set(faces.slice(4 * k, 4 * k + 4).flat())].map((i) => turned.vertices[i]),
    );
    tetrahedra.forEach((a, k) => {
      for (const b of tetrahedra.slice(k + 1)) assert.ok(!overlap(a, b), name);
    });

    // A point on a face, at any turn, is found on a face it lies on, and a
    // point just off the solid goes back onto it. Where the hexagonal ring's
    // tetrahedra touch across the middle, two faces meet, and either will do.
    faces.forEach((_, f) => {
      const point = pointOn(turned, f, 0.01 * Math.sin(f), 0.01 * Math.cos(f));
      assert.ok(onFace(turned, faceAt(turned, point), point), name);
      const moved = point.clone().addScaledVector(turned.faceFrames[f].normal, 1e-4);
      const projected = projectToSurface(turned, moved);
      assert.ok(projected.distanceTo(moved) < 1e-4 + EPSILON, name);
      assert.ok(onFace(turned, faceAt(turned, projected), projected), name);
    });
  }

  // A dab is a disc on the surface laid flat. Beside the middle of a hinge, it
  // reaches the other tetrahedron's face across the gap, but not the two faces
  // behind the hinge, which meet it in space. Near a corner, it reaches every
  // face around the corner. It paints the same at every turn, and its pieces
  // on faces glued together line up across the edge between them, as they do
  // when the two are unfolded flat.
  //
  // A stroke zigzagging along a hinge, over the faces in front of it, stays
  // on them, even where they make a ridge, which the chord between its points
  // cuts under. A stroke doesn't join up with a point on the tetrahedron
  // across the ring, which is much further away on the surface than in
  // space.
  faces.forEach((face, f) => {
    const [a, b, apex] = rest[f];
    const hinge = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const toward = (from, to, part) => [0, 1].map((k) => from[k] + part * (to[k] - from[k]));
    const middle = toward(a, b, 0.5);
    const dabs = [
      { at: toward(middle, apex, 0.1), radius: 0.2 * hinge, reaches: [f, adjacent[f][0][0]] },
      {
        at: toward(a, toward(b, apex, 0.5), 0.05),
        radius: 0.3 * hinge,
        reaches: faces.flatMap((other, g) => (other.includes(face[0]) ? [g] : [])),
      },
    ];
    assert.equal(dabs[1].reaches.length, 6, id);
    const front = [f, adjacent[f][0][0]];
    const across = 4 * ((Math.floor(f / 4) + ring.count / 2) % ring.count);
    for (const turn of TURNS) {
      const turned = atTurn(polyhedron, turn);
      const name = `${id} stroke on ${f} at ${turn.toFixed(3)}`;
      const [start, end] = face.slice(0, 2).map((i) => turned.vertices[i]);
      const zigzag = [0.3, 0.4, 0.5, 0.6, 0.7].map((t, k) => {
        const g = front[k % 2];
        const point = start.clone().lerp(end, t);
        return { face: g, point: point.lerp(turned.vertices[faces[g][2]], 0.03) };
      });
      zigzag.slice(1).forEach((to, k) => {
        const from = zigzag[k];
        const dabs = strokeDabs(turned, from.point, from.face, to.point, 0.01 * hinge);
        assert.ok(dabs.length > 0, name);
        for (const dab of dabs) assert.ok(front.includes(dab.face) && onFace(turned, dab.face, dab.point), name);
      });
      const far = pointOn(turned, across, 0, 0);
      assert.equal(strokeDabs(turned, zigzag[0].point, f, far, 0.01 * hinge), null, name);
    }
    for (const { at, radius, reaches } of dabs) {
      let first = null;
      for (const turn of [0, ...TURNS.slice(0, 6)]) {
        const turned = atTurn(polyhedron, turn);
        const footprint = new Map(
          dabFootprint(turned, pointOn(turned, f, ...at), f, radius, 0).map((disc) => [disc.face, disc]),
        );
        const name = `${id} dab on ${f} at ${turn.toFixed(3)}`;
        assert.deepEqual([...footprint.keys()].sort((p, q) => p - q), [...reaches].sort((p, q) => p - q), name);
        first ??= footprint;
        for (const [g, { x, y }] of footprint) {
          assert.ok(Math.hypot(x - first.get(g).x, y - first.get(g).y) < EPSILON, name);
        }
      }
      // The distance of a point along an edge of a face and to its left.
      const edgeCoordinates = (g, j, { x, y }) => {
        const [[sx, sy], [ex, ey]] = [rest[g][j], rest[g][(j + 1) % 3]];
        const length = Math.hypot(ex - sx, ey - sy);
        const [ux, uy] = [(ex - sx) / length, (ey - sy) / length];
        return [length, (x - sx) * ux + (y - sy) * uy, (y - sy) * ux - (x - sx) * uy];
      };
      for (const [g, disc] of first) {
        adjacent[g].forEach(([h, j], i) => {
          if (!first.has(h)) return;
          const [length, along, left] = edgeCoordinates(g, i, disc);
          const [, alongThere, leftThere] = edgeCoordinates(h, j, first.get(h));
          assert.ok(Math.abs(alongThere - (length - along)) < EPSILON && Math.abs(leftThere + left) < EPSILON, id);
        });
      }
    }
  });

  // Each group's copies are what its name says. A copy of a point lands
  // where the point goes when the solid is turned about its axis by a whole
  // number of tetrahedra and moved a whole number of quarters of the way
  // through its motion: none for the turns around the ring, and halves or
  // quarters for the groups named after them.
  const groups = new Map(symmetryGroups(polyhedron).map((group) => [group.id, group]));
  const n = ring.count;
  assert.deepEqual(
    [...groups.values()].map((group) => [group.id, group.order]),
    [['C1', 1], ['ring', n / 2], ['half-turn', n], ['quarter-turn', 2 * n], ['faces', 4 * n], ['faces-mirrored', 8 * n]],
    id,
  );
  assert.ok(groups.get('ring').preferred, id);
  const samples = faces.map((_, f) => [f, 0.03, -0.02]);
  const movedBy = ({ faceMaps }, quarters) =>
    [0.1, 0.6].every((turn) => {
      const from = atTurn(polyhedron, turn);
      const to = atTurn(polyhedron, (turn + quarters / 4) % 1);
      return Array.from({ length: n }, (_, k) => new Matrix4().makeRotationY((2 * Math.PI * k) / n)).some(
        (rotation) =>
          samples.every(([f, x, y]) => {
            const { face, xx, xy, yx, yy } = faceMaps[f];
            const image = pointOn(to, face, xx * x + xy * y, yx * x + yy * y);
            return pointOn(from, f, x, y).applyMatrix4(rotation).distanceTo(image) < EPSILON;
          }),
      );
    });
  for (const [groupId, quarters] of [['ring', [0]], ['half-turn', [0, 2]], ['quarter-turn', [0, 1, 2, 3]]]) {
    for (const element of groups.get(groupId).elements) {
      assert.ok(quarters.some((q) => movedBy(element, q)), `${id} ${groupId}`);
    }
  }

  // Every copy of every group fits its face exactly, and keeps faces next to
  // each other next to each other, as a symmetry of the surface does. The
  // groups named after the motion are among them.
  // Rounded, with -0 as 0.
  const key = ({ faceMaps }) =>
    faceMaps.map(({ face, ...matrix }) => `${face}:${Object.values(matrix).map((v) => Math.round(v * 1e4) + 0)}`).join(' ');
  const surface = new Set(groups.get('faces-mirrored').elements.map(key));
  for (const group of groups.values()) {
    assert.equal(new Set(group.elements.map(key)).size, group.order, `${id} ${group.id}`);
    for (const element of group.elements) {
      assert.ok(surface.has(key(element)), `${id} ${group.id}`);
      const { faceMaps } = element;
      faces.forEach((_, f) => {
        const { face, xx, xy, yx, yy } = faceMaps[f];
        const images = rest[f].map(([x, y]) => [xx * x + xy * y, yx * x + yy * y]);
        for (const [x, y] of images) {
          assert.ok(rest[face].some(([u, v]) => Math.hypot(u - x, v - y) < EPSILON), `${id} ${group.id}`);
        }
        adjacent[f].forEach(([g]) => {
          assert.ok(adjacent[face].some(([h]) => h === faceMaps[g].face), `${id} ${group.id}`);
        });
      });
      const mirrored = faceMaps[0].xx * faceMaps[0].yy - faceMaps[0].xy * faceMaps[0].yx < 0;
      assert.ok(group.reflections || !mirrored, `${id} ${group.id}`);
    }
  }
}

console.log(
  `Kaleidocycles OK: ${kaleidocycles.length} rings keep their tetrahedra whole and apart as they turn, and their ` +
    'symmetries repeat strokes as named.',
);
