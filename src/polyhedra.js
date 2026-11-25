import { Vector3 } from 'three';
import { ICOSAHEDRAL, OCTAHEDRAL, PHI, TETRAHEDRAL, isRotation, orbit } from './groups.js';
import { ringFaces, ringVertices } from './kaleidocycles.js';

const EPSILON = 1e-6;

// The tribonacci constant, for the snub cube.
const TRIBONACCI = (1 + Math.cbrt(19 + 3 * Math.sqrt(33)) + Math.cbrt(19 - 3 * Math.sqrt(33))) / 3;
// For the snub dodecahedron: XI is the real root of XI³ - 2 XI = PHI.
const XI = Math.cbrt((PHI + Math.sqrt(PHI - 5 / 27)) / 2) + Math.cbrt((PHI - Math.sqrt(PHI - 5 / 27)) / 2);
const ALPHA = XI - 1 / XI;
const BETA = XI * PHI + PHI ** 2 + PHI / XI;

// The Platonic and Archimedean solids are uniform: their vertices are the
// images of one vertex, `seed`, under their symmetry group. The Catalan solids
// are the duals of the Archimedean ones, each named by `dual`. The stellated
// ones have a pyramid on each face of a `base` solid, with its shortest sides
// `spike` times the face's edges long, or sunk into it when `spike` is
// negative. The kaleidocycles are rings of `ring` tetrahedra whose hinges are
// `hinge` times as long as the distance between them (see kaleidocycles.js).
const DEFINITIONS = [
  { family: 'Platonic solids', id: 'tetrahedron', name: 'Tetrahedron', group: TETRAHEDRAL, seed: [1, 1, 1] },
  { family: 'Platonic solids', id: 'cube', name: 'Cube', group: OCTAHEDRAL, seed: [1, 1, 1] },
  { family: 'Platonic solids', id: 'octahedron', name: 'Octahedron', group: OCTAHEDRAL, seed: [1, 0, 0] },
  // Oriented as the dual of the icosahedron, so the two share the same
  // symmetry axes.
  { family: 'Platonic solids', id: 'dodecahedron', name: 'Dodecahedron', group: ICOSAHEDRAL, seed: [1, 1, 1] },
  { family: 'Platonic solids', id: 'icosahedron', name: 'Icosahedron', group: ICOSAHEDRAL, seed: [0, 1, PHI] },
  {
    family: 'Archimedean solids',
    id: 'truncated-tetrahedron',
    name: 'Truncated tetrahedron',
    group: TETRAHEDRAL,
    seed: [3, 1, 1],
  },
  { family: 'Archimedean solids', id: 'cuboctahedron', name: 'Cuboctahedron', group: OCTAHEDRAL, seed: [1, 1, 0] },
  {
    family: 'Archimedean solids',
    id: 'truncated-cube',
    name: 'Truncated cube',
    group: OCTAHEDRAL,
    seed: [Math.SQRT2 - 1, 1, 1],
  },
  {
    family: 'Archimedean solids',
    id: 'truncated-octahedron',
    name: 'Truncated octahedron',
    group: OCTAHEDRAL,
    seed: [0, 1, 2],
  },
  {
    family: 'Archimedean solids',
    id: 'rhombicuboctahedron',
    name: 'Rhombicuboctahedron',
    group: OCTAHEDRAL,
    seed: [1, 1, 1 + Math.SQRT2],
  },
  {
    family: 'Archimedean solids',
    id: 'truncated-cuboctahedron',
    name: 'Truncated cuboctahedron',
    group: OCTAHEDRAL,
    seed: [1, 1 + Math.SQRT2, 1 + 2 * Math.SQRT2],
  },
  {
    family: 'Archimedean solids',
    id: 'snub-cube',
    name: 'Snub cube',
    group: OCTAHEDRAL.filter(isRotation),
    seed: [1, 1 / TRIBONACCI, TRIBONACCI],
  },
  {
    family: 'Archimedean solids',
    id: 'icosidodecahedron',
    name: 'Icosidodecahedron',
    group: ICOSAHEDRAL,
    seed: [0, 0, PHI],
  },
  {
    family: 'Archimedean solids',
    id: 'truncated-dodecahedron',
    name: 'Truncated dodecahedron',
    group: ICOSAHEDRAL,
    seed: [1 / PHI, 0, 2 + PHI],
  },
  {
    family: 'Archimedean solids',
    id: 'truncated-icosahedron',
    name: 'Truncated icosahedron',
    group: ICOSAHEDRAL,
    seed: [0, 1, 3 * PHI],
  },
  {
    family: 'Archimedean solids',
    id: 'rhombicosidodecahedron',
    name: 'Rhombicosidodecahedron',
    group: ICOSAHEDRAL,
    seed: [1, 1, PHI ** 3],
  },
  {
    family: 'Archimedean solids',
    id: 'truncated-icosidodecahedron',
    name: 'Truncated icosidodecahedron',
    group: ICOSAHEDRAL,
    seed: [1 / PHI, 1 / PHI, 3 + PHI],
  },
  {
    family: 'Archimedean solids',
    id: 'snub-dodecahedron',
    name: 'Snub dodecahedron',
    group: ICOSAHEDRAL.filter(isRotation),
    seed: [2, 2 * ALPHA, 2 * BETA],
  },
  {
    family: 'Catalan solids',
    id: 'triakis-tetrahedron',
    name: 'Triakis tetrahedron',
    dual: 'truncated-tetrahedron',
  },
  { family: 'Catalan solids', id: 'rhombic-dodecahedron', name: 'Rhombic dodecahedron', dual: 'cuboctahedron' },
  { family: 'Catalan solids', id: 'triakis-octahedron', name: 'Triakis octahedron', dual: 'truncated-cube' },
  {
    family: 'Catalan solids',
    id: 'tetrakis-hexahedron',
    name: 'Tetrakis hexahedron',
    dual: 'truncated-octahedron',
  },
  {
    family: 'Catalan solids',
    id: 'deltoidal-icositetrahedron',
    name: 'Deltoidal icositetrahedron',
    dual: 'rhombicuboctahedron',
  },
  {
    family: 'Catalan solids',
    id: 'disdyakis-dodecahedron',
    name: 'Disdyakis dodecahedron',
    dual: 'truncated-cuboctahedron',
  },
  {
    family: 'Catalan solids',
    id: 'pentagonal-icositetrahedron',
    name: 'Pentagonal icositetrahedron',
    dual: 'snub-cube',
  },
  {
    family: 'Catalan solids',
    id: 'rhombic-triacontahedron',
    name: 'Rhombic triacontahedron',
    dual: 'icosidodecahedron',
  },
  {
    family: 'Catalan solids',
    id: 'triakis-icosahedron',
    name: 'Triakis icosahedron',
    dual: 'truncated-dodecahedron',
  },
  {
    family: 'Catalan solids',
    id: 'pentakis-dodecahedron',
    name: 'Pentakis dodecahedron',
    dual: 'truncated-icosahedron',
  },
  {
    family: 'Catalan solids',
    id: 'deltoidal-hexecontahedron',
    name: 'Deltoidal hexecontahedron',
    dual: 'rhombicosidodecahedron',
  },
  {
    family: 'Catalan solids',
    id: 'disdyakis-triacontahedron',
    name: 'Disdyakis triacontahedron',
    dual: 'truncated-icosidodecahedron',
  },
  {
    family: 'Catalan solids',
    id: 'pentagonal-hexecontahedron',
    name: 'Pentagonal hexecontahedron',
    dual: 'snub-dodecahedron',
  },
  {
    family: 'Stellations',
    id: 'stellated-octahedron',
    name: 'Stellated octahedron',
    base: 'octahedron',
    spike: 1,
  },
  {
    family: 'Stellations',
    id: 'small-stellated-dodecahedron',
    name: 'Small stellated dodecahedron',
    base: 'dodecahedron',
    spike: PHI,
  },
  {
    family: 'Stellations',
    id: 'great-dodecahedron',
    name: 'Great dodecahedron',
    base: 'icosahedron',
    spike: -1 / PHI,
  },
  {
    family: 'Stellations',
    id: 'great-stellated-dodecahedron',
    name: 'Great stellated dodecahedron',
    base: 'icosahedron',
    spike: PHI,
  },
  // The first stellation of the rhombic dodecahedron, which M.C. Escher drew
  // on a tower in his print Waterfall. The pyramids' sides from the rhombi's
  // obtuse corners are as long as the rhombi's edges. Their apexes and the
  // rhombi's acute corners are the corners of three flattened octahedra, whose
  // compound this solid is.
  {
    family: 'Stellations',
    id: 'eschers-solid',
    name: "Escher's solid",
    base: 'rhombic-dodecahedron',
    spike: 1,
  },
  // The hinges are 2/√3 times as long as the distance between them, so each
  // face is as tall as its base and its other sides are √5/2 times as long,
  // the classic proportions of Wallace Walker's kaleidocycles. That is the
  // longest a ring of six can have them and still turn: the tetrahedra across
  // the ring just touch in the middle four times a turn. A ring of six
  // regular tetrahedra jams.
  {
    family: 'Kaleidocycles',
    id: 'hexagonal-kaleidocycle',
    name: 'Hexagonal kaleidocycle',
    ring: 6,
    hinge: 2 / Math.sqrt(3),
  },
  // Rings of eight or more turn with regular tetrahedra, whose opposite edges
  // are √2 times as long as the distance between them.
  { family: 'Kaleidocycles', id: 'octagonal-kaleidocycle', name: 'Octagonal kaleidocycle', ring: 8, hinge: Math.SQRT2 },
  { family: 'Kaleidocycles', id: 'decagonal-kaleidocycle', name: 'Decagonal kaleidocycle', ring: 10, hinge: Math.SQRT2 },
];

const centroid = (points) => points.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(points.length);

// Orders a face's vertex indices counter-clockwise when seen from outside.
function orderAroundNormal(indices, vertices, normal) {
  const center = centroid(indices.map((i) => vertices[i]));
  const u = vertices[indices[0]].clone().sub(center).normalize();
  const w = new Vector3().crossVectors(normal, u);
  const angle = (i) => {
    const p = vertices[i].clone().sub(center);
    return Math.atan2(p.dot(w), p.dot(u));
  };
  return [...indices].sort((a, b) => angle(a) - angle(b));
}

// Finds the faces of a convex polyhedron centered at the origin: every plane
// through three vertices that has no vertex beyond it bounds a face.
function findFaces(vertices) {
  const faces = [];
  const seen = new Set();
  const n = vertices.length;
  const [ab, ac, normal] = [new Vector3(), new Vector3(), new Vector3()];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      ab.subVectors(vertices[j], vertices[i]);
      for (let k = j + 1; k < n; k++) {
        normal.crossVectors(ab, ac.subVectors(vertices[k], vertices[i]));
        if (normal.lengthSq() < EPSILON) continue;
        normal.normalize();

        let offset = normal.dot(vertices[i]);
        if (offset < 0) {
          normal.negate();
          offset = -offset;
        }
        if (vertices.some((v) => normal.dot(v) > offset + EPSILON)) continue;

        const members = [];
        vertices.forEach((v, index) => {
          if (Math.abs(normal.dot(v) - offset) < EPSILON) members.push(index);
        });
        const key = members.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        faces.push(orderAroundNormal(members, vertices, normal.clone()));
      }
    }
  }
  return faces;
}

// Puts a pyramid on each face of a polyhedron, with its apex above the face's
// center and its shortest sides `spike` times the face's edges long, sunk into
// the face when `spike` is negative. The shortest sides run to the corners
// nearest the center, which on a regular face are all of them. The faces
// themselves are hidden, leaving the pyramids' sides.
function stellate({ vertices, faces }, spike) {
  const points = [...vertices];
  const sides = faces.flatMap((face) => {
    const corners = face.map((i) => vertices[i]);
    const center = centroid(corners);
    const normal = new Vector3()
      .subVectors(corners[1], corners[0])
      .cross(new Vector3().subVectors(corners[2], corners[0]))
      .normalize();
    const side = spike * corners[0].distanceTo(corners[1]);
    const nearest = Math.min(...corners.map((corner) => center.distanceToSquared(corner)));
    const height = Math.sign(spike) * Math.sqrt(side ** 2 - nearest);
    const apex = points.push(center.addScaledVector(normal, height)) - 1;
    return face.map((a, i) => [a, face[(i + 1) % face.length], apex]);
  });
  return { vertices: points, faces: sides };
}

// Turns a face's vertex list to start at the corner from which the corners'
// distances from the center and the edges' lengths, read counter-clockwise,
// come out largest. The first edge sets the face's frame, and the symmetries
// that keep the solid's orientation keep this choice, so faces they take to
// each other get the same face coordinates, and fit the same atlas cell.
function startAtCorner(face, vertices) {
  const n = face.length;
  const readings = face.flatMap((a, i) => {
    const b = face[(i + 1) % n];
    return [vertices[a].length(), vertices[a].distanceTo(vertices[b])];
  });
  // Compares the readings from two corners, ignoring rounding.
  const compare = (s, t) => {
    for (let k = 0; k < 2 * n; k++) {
      const difference = readings[(2 * s + k) % (2 * n)] - readings[(2 * t + k) % (2 * n)];
      if (Math.abs(difference) > EPSILON) return difference;
    }
    return 0;
  };
  let start = 0;
  for (let s = 1; s < n; s++) if (compare(s, start) > 0) start = s;
  return [...face.slice(start), ...face.slice(0, start)];
}

// The dual of a convex solid centered at the origin: a vertex for each face,
// at the pole of its plane, and a face for each vertex, through the poles of
// the faces around it, which lie in one plane. Face f of the solid becomes
// vertex f of the dual, and vertex v becomes face v.
function dualize({ vertices, faces, faceFrames }) {
  const poles = faceFrames.map(({ normal, offset }) => normal.clone().divideScalar(offset));
  const sides = vertices.map((vertex, v) => {
    const around = faces.flatMap((face, f) => (face.includes(v) ? [f] : []));
    return startAtCorner(orderAroundNormal(around, poles, vertex.clone().normalize()), poles);
  });
  return { vertices: poles, faces: sides };
}

// A solid's vertices and faces, before scaling. Convex solids built from a
// seed vertex leave their faces to be found.
function shape(definition, built) {
  if (definition.base) return stellate(built.get(definition.base), definition.spike);
  if (definition.dual) return dualize(built.get(definition.dual));
  return { vertices: orbit(definition.group, definition.seed) };
}

// Which face lies across each edge of each face, as [face, edge], where edge
// i runs from the face's vertex i to the next. Faces list their vertices
// counter-clockwise from outside, so the face across an edge runs along it
// the other way.
function findAdjacent(faces) {
  const along = new Map();
  faces.forEach((face, f) => face.forEach((a, i) => along.set(`${a}-${face[(i + 1) % face.length]}`, [f, i])));
  return faces.map((face) => face.map((a, i) => along.get(`${face[(i + 1) % face.length]}-${a}`)));
}

function findEdges(faces) {
  const edges = new Map();
  for (const face of faces) {
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length];
      edges.set(`${Math.min(a, b)}-${Math.max(a, b)}`, [a, b]);
    });
  }
  return [...edges.values()];
}

// A face's plane and a 2D frame in it: `up` points from the center to the
// middle of the face's first edge, and (right, up, normal) is right-handed, so
// face coordinates are not mirrored when seen from outside.
function faceFrame(face, vertices) {
  const [a, b, c] = face.map((i) => vertices[i]);
  const center = centroid(face.map((i) => vertices[i]));
  const normal = new Vector3()
    .subVectors(b, a)
    .cross(new Vector3().subVectors(c, a))
    .normalize();
  const up = a.clone().add(b).multiplyScalar(0.5).sub(center).normalize();
  const right = new Vector3().crossVectors(up, normal);
  return { center, normal, offset: normal.dot(center), right, up };
}

// How finely a kaleidocycle's motion is sampled to find how far out its
// corners reach. A quarter turn later it has the same shape, turned about its
// axis, so a quarter turn is enough.
const RING_SAMPLES = 64;

function buildPolyhedron(definition, built) {
  const { family, id, name } = definition;
  if (definition.ring) return buildKaleidocycle(definition);
  let { vertices, faces } = shape(definition, built);
  faces ??= findFaces(vertices);
  // Scale every solid to have its farthest vertices at a distance of 1, so they
  // appear at similar sizes.
  const radius = Math.max(...vertices.map((v) => v.length()));
  vertices = vertices.map((v) => v.clone().divideScalar(radius));
  const edges = findEdges(faces);
  const faceFrames = faces.map((face) => faceFrame(face, vertices));
  const adjacent = findAdjacent(faces);
  return { family, id, name, vertices, faces, edges, faceFrames, adjacent, starShaped: true };
}

// A kaleidocycle as it stands at turn 0, where all its hinges are alike, and
// `ring`, which atTurn() uses to turn it. Its faces don't depend on the turn,
// since the tetrahedra only move as a whole, but its vertices and face frames
// do. It is a ring, so it isn't star-shaped around its center. Like the other
// solids, it is scaled so its corners reach out to a distance of 1, as far as
// they ever do as it turns.
function buildKaleidocycle({ family, id, name, ring: count, hinge }) {
  let radius = 0;
  for (let k = 0; k < RING_SAMPLES; k++) {
    for (const vertex of ringVertices(count, hinge, k / RING_SAMPLES / 4)) radius = Math.max(radius, vertex.length());
  }
  const vertices = ringVertices(count, hinge, 0).map((v) => v.divideScalar(radius));
  const { faces, adjacent } = ringFaces(count, vertices);
  const edges = findEdges(faces);
  const faceFrames = faces.map((face) => faceFrame(face, vertices));
  return {
    family,
    id,
    name,
    vertices,
    faces,
    edges,
    faceFrames,
    adjacent,
    starShaped: false,
    ring: { count, hinge, radius },
  };
}

// Kaleidocycles turned some way, by solid and turn, as atTurn() last made
// them. Redrawing a painting replays its strokes, each at the turn it was
// painted at, so this keeps more than one.
const turned = new WeakMap();
const TURNED_KEPT = 32;

// A solid `turn` of the way around its motion, from 0 to 1, with the same
// faces and face indices, but its vertices and face frames moved. The face
// coordinates of a point on a face don't change as it turns. Solids that don't
// turn stay as they are.
export function atTurn(polyhedron, turn) {
  if (!polyhedron.ring || !turn) return polyhedron;
  if (!turned.has(polyhedron)) turned.set(polyhedron, new Map());
  const cache = turned.get(polyhedron);
  if (!cache.has(turn)) {
    const { count, hinge, radius } = polyhedron.ring;
    const vertices = ringVertices(count, hinge, turn).map((v) => v.divideScalar(radius));
    const faceFrames = polyhedron.faces.map((face) => faceFrame(face, vertices));
    if (cache.size >= TURNED_KEPT) cache.delete(cache.keys().next().value);
    cache.set(turn, { ...polyhedron, vertices, faceFrames });
  }
  return cache.get(turn);
}

export const POLYHEDRA = DEFINITIONS.reduce(
  (built, definition) => built.set(definition.id, buildPolyhedron(definition, built)),
  new Map(),
);

// Coordinates of a point in a face's 2D frame, centered on the face.
export function toFaceCoordinates({ center, right, up }, point) {
  const relative = point.clone().sub(center);
  return [relative.dot(right), relative.dot(up)];
}

// Where the ray from the center through a point leaves the solid: the face
// it crosses there, and the point where it does. Every solid is star-shaped
// around its center, so the ray leaves it through just one face; the one it
// passes furthest inside of wins, for points on edges.
function exit({ vertices, faces, faceFrames }, point) {
  let best = { face: 0, point, inside: -Infinity };
  const [along, toPoint] = [new Vector3(), new Vector3()];
  faceFrames.forEach(({ normal, offset }, f) => {
    const toward = normal.dot(point);
    if (toward <= 0) return;
    const crossing = point.clone().multiplyScalar(offset / toward);
    // How far inside the face's edges the crossing is.
    const inside = Math.min(
      ...faces[f].map((a, i) => {
        const b = faces[f][(i + 1) % faces[f].length];
        along.subVectors(vertices[b], vertices[a]);
        toPoint.subVectors(crossing, vertices[a]);
        return along.cross(toPoint).dot(normal) / vertices[a].distanceTo(vertices[b]);
      }),
    );
    if (inside > best.inside) best = { face: f, point: crossing, inside };
  });
  return best;
}

// The point on the solid nearest to a point, and the face it is on, for
// solids that aren't star-shaped. Of faces equally near, as at an edge, the
// one the point is furthest inside of wins.
function nearest({ vertices, faces, faceFrames }, point) {
  let best = { face: 0, point, distanceSq: Infinity, inside: -Infinity };
  const [along, toPoint, closest] = [new Vector3(), new Vector3(), new Vector3()];
  faceFrames.forEach(({ normal, offset }, f) => {
    const projected = point.clone().addScaledVector(normal, offset - normal.dot(point));
    // How far inside the face's edges the point's projection onto its plane
    // is, and the nearest point on its outline in case that is outside.
    let inside = Infinity;
    let edgePoint = null;
    let edgeDistanceSq = Infinity;
    faces[f].forEach((a, i) => {
      const [start, end] = [vertices[a], vertices[faces[f][(i + 1) % faces[f].length]]];
      along.subVectors(end, start);
      toPoint.subVectors(projected, start);
      inside = Math.min(inside, along.clone().cross(toPoint).dot(normal) / along.length());
      const t = Math.min(Math.max(toPoint.dot(along) / along.lengthSq(), 0), 1);
      closest.copy(start).addScaledVector(along, t);
      if (closest.distanceToSquared(point) < edgeDistanceSq) {
        edgeDistanceSq = closest.distanceToSquared(point);
        edgePoint = closest.clone();
      }
    });
    const onFace = inside >= 0 ? projected : edgePoint;
    const distanceSq = onFace.distanceToSquared(point);
    if (distanceSq < best.distanceSq - 1e-12 || (distanceSq < best.distanceSq + 1e-12 && inside > best.inside)) {
      best = { face: f, point: onFace, distanceSq, inside };
    }
  });
  return best;
}

const locate = (polyhedron, point) => (polyhedron.starShaped ? exit : nearest)(polyhedron, point);

// The face that a point on the solid lies on.
export function faceAt(polyhedron, point) {
  return locate(polyhedron, point).face;
}

// Moves a point near the solid onto its surface: along the ray from its center
// on solids star-shaped around it, or else to the nearest point on it.
export function projectToSurface(polyhedron, point) {
  return locate(polyhedron, point).point;
}

// The same point, with the face it lands on.
export function surfacePoint(polyhedron, point) {
  const { face, point: onSurface } = locate(polyhedron, point);
  return { face, point: onSurface };
}
