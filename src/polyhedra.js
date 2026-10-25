import { Vector3 } from 'three';
import { ICOSAHEDRAL, OCTAHEDRAL, PHI, TETRAHEDRAL, isRotation, orbit } from './groups.js';

const EPSILON = 1e-6;

// The tribonacci constant, for the snub cube.
const TRIBONACCI = (1 + Math.cbrt(19 + 3 * Math.sqrt(33)) + Math.cbrt(19 - 3 * Math.sqrt(33))) / 3;
// For the snub dodecahedron: XI is the real root of XI³ - 2 XI = PHI.
const XI = Math.cbrt((PHI + Math.sqrt(PHI - 5 / 27)) / 2) + Math.cbrt((PHI - Math.sqrt(PHI - 5 / 27)) / 2);
const ALPHA = XI - 1 / XI;
const BETA = XI * PHI + PHI ** 2 + PHI / XI;

// The convex solids are uniform: their vertices are the images of one vertex,
// `seed`, under their symmetry group. The stellated ones have a pyramid on
// each face of a Platonic solid, with sides `spike` times its edges long, or
// sunk into it when `spike` is negative.
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

// Puts a pyramid on each face of a polyhedron, with sides `spike` times the
// face's edges long, sunk into the face when `spike` is negative. The faces
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
    const height = Math.sign(spike) * Math.sqrt(side ** 2 - center.distanceToSquared(corners[0]));
    const apex = points.push(center.addScaledVector(normal, height)) - 1;
    return face.map((a, i) => [a, face[(i + 1) % face.length], apex]);
  });
  return { vertices: points, faces: sides };
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

function buildPolyhedron(definition, built) {
  const { family, id, name } = definition;
  let { vertices, faces } = definition.base
    ? stellate(built.get(definition.base), definition.spike)
    : { vertices: orbit(definition.group, definition.seed) };
  faces ??= findFaces(vertices);
  // Scale every solid to a circumradius of 1 so they appear at similar sizes.
  const radius = Math.max(...vertices.map((v) => v.length()));
  vertices = vertices.map((v) => v.clone().divideScalar(radius));
  const edges = findEdges(faces);
  const faceFrames = faces.map((face) => faceFrame(face, vertices));
  return { family, id, name, vertices, faces, edges, faceFrames };
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

// The face that a point on the solid lies on.
export function faceAt(polyhedron, point) {
  return exit(polyhedron, point).face;
}

// Moves a point near the solid along the ray from its center onto its surface.
export function projectToSurface(polyhedron, point) {
  return exit(polyhedron, point).point;
}
