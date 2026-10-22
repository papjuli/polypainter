import { Vector3 } from 'three';

export const PHI = (1 + Math.sqrt(5)) / 2;
const EPSILON = 1e-6;

// All sign variants of a coordinate triple, e.g. [1, 0, 2] -> (±1, 0, ±2).
export function withSigns(triple) {
  let results = [[]];
  for (const c of triple) {
    const options = c === 0 ? [0] : [c, -c];
    results = results.flatMap((prefix) => options.map((o) => [...prefix, o]));
  }
  return results;
}

export function cyclicPermutations([a, b, c]) {
  return [
    [a, b, c],
    [b, c, a],
    [c, a, b],
  ];
}

const DEFINITIONS = [
  {
    id: 'tetrahedron',
    name: 'Tetrahedron',
    coordinates: [
      [1, 1, 1],
      [1, -1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
    ],
  },
  {
    id: 'cube',
    name: 'Cube',
    coordinates: withSigns([1, 1, 1]),
  },
  {
    id: 'octahedron',
    name: 'Octahedron',
    coordinates: cyclicPermutations([1, 0, 0]).flatMap(withSigns),
  },
  {
    id: 'dodecahedron',
    name: 'Dodecahedron',
    // Oriented as the dual of the icosahedron below, so the two share the
    // same symmetry axes.
    coordinates: [
      ...withSigns([1, 1, 1]),
      ...cyclicPermutations([0, PHI, 1 / PHI]).flatMap(withSigns),
    ],
  },
  {
    id: 'icosahedron',
    name: 'Icosahedron',
    coordinates: cyclicPermutations([0, 1, PHI]).flatMap(withSigns),
  },
];

// Orders a face's vertex indices counter-clockwise when seen from outside.
function orderAroundNormal(indices, vertices, normal) {
  const center = new Vector3();
  for (const i of indices) center.add(vertices[i]);
  center.divideScalar(indices.length);

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

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        const normal = new Vector3()
          .subVectors(vertices[j], vertices[i])
          .cross(new Vector3().subVectors(vertices[k], vertices[i]));
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
        faces.push(orderAroundNormal(members, vertices, normal));
      }
    }
  }
  return faces;
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
  const center = new Vector3();
  for (const i of face) center.add(vertices[i]);
  center.divideScalar(face.length);

  const [a, b, c] = face.map((i) => vertices[i]);
  const normal = new Vector3()
    .subVectors(b, a)
    .cross(new Vector3().subVectors(c, a))
    .normalize();
  const up = a.clone().add(b).multiplyScalar(0.5).sub(center).normalize();
  const right = new Vector3().crossVectors(up, normal);
  return { center, normal, offset: normal.dot(center), right, up };
}

function buildPolyhedron({ id, name, coordinates }) {
  // Scale every solid to a circumradius of 1 so they appear at similar sizes.
  const vertices = coordinates.map((c) => new Vector3(...c).normalize());
  const faces = findFaces(vertices);
  const edges = findEdges(faces);
  const faceFrames = faces.map((face) => faceFrame(face, vertices));
  return { id, name, vertices, faces, edges, faceFrames };
}

export const POLYHEDRA = DEFINITIONS.map(buildPolyhedron);

// Coordinates of a point in a face's 2D frame, centered on the face.
export function toFaceCoordinates({ center, right, up }, point) {
  const relative = point.clone().sub(center);
  return [relative.dot(right), relative.dot(up)];
}

// The face whose plane a point on (or inside) the solid is closest to.
export function faceAt({ faceFrames }, point) {
  let closest = 0;
  faceFrames.forEach(({ normal, offset }, i) => {
    const { normal: n, offset: d } = faceFrames[closest];
    if (normal.dot(point) / offset > n.dot(point) / d) closest = i;
  });
  return closest;
}

// Moves a point inside the solid outward from the center onto the surface.
export function projectToSurface({ faceFrames }, point) {
  const scale = Math.max(...faceFrames.map(({ normal, offset }) => normal.dot(point) / offset));
  return point.clone().divideScalar(scale);
}
