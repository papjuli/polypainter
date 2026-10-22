import { Matrix3, Vector3 } from 'three';
import { PHI, cyclicPermutations, withSigns } from './polyhedra.js';

const EPSILON = 1e-6;

const isRotation = (matrix) => matrix.determinant() > 0;

const isIdentity = (matrix) =>
  matrix.elements.every((value, i) => Math.abs(value - (i % 4 === 0 ? 1 : 0)) < EPSILON);

// Tests whether a linear map takes a point set to itself.
function preserves(coordinates) {
  const points = coordinates.map((c) => new Vector3(...c));
  return (matrix) =>
    points.every((point) => {
      const image = point.clone().applyMatrix3(matrix);
      return points.some((other) => other.distanceToSquared(image) < EPSILON);
    });
}

const preservesTetrahedron = preserves([
  [1, 1, 1],
  [1, -1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
]);
const preservesOctahedron = preserves(cyclicPermutations([1, 0, 0]).flatMap(withSigns));
const preservesIcosahedron = preserves(cyclicPermutations([0, 1, PHI]).flatMap(withSigns));
// The icosahedron's vertex pattern with a ratio other than PHI keeps only the
// pyritohedral symmetries.
const preservesPyritohedron = preserves(cyclicPermutations([0, 1, 2]).flatMap(withSigns));

// The polyhedral point groups, in Schoenflies and orbifold notation. All
// solids share the same orientation, so a group is a symmetry group of a
// solid exactly when all of its elements are symmetries of that solid.
const NAMED_GROUPS = [
  { id: 'C1', name: 'None', order: 1, contains: isIdentity },
  {
    id: 'T',
    name: 'Chiral tetrahedral',
    orbifold: '332',
    order: 12,
    contains: (m) => isRotation(m) && preservesTetrahedron(m),
  },
  { id: 'Td', name: 'Full tetrahedral', orbifold: '*332', order: 24, contains: preservesTetrahedron },
  { id: 'Th', name: 'Pyritohedral', orbifold: '3*2', order: 24, contains: preservesPyritohedron },
  {
    id: 'O',
    name: 'Chiral octahedral',
    orbifold: '432',
    order: 24,
    contains: (m) => isRotation(m) && preservesOctahedron(m),
  },
  { id: 'Oh', name: 'Full octahedral', orbifold: '*432', order: 48, contains: preservesOctahedron },
  {
    id: 'I',
    name: 'Chiral icosahedral',
    orbifold: '532',
    order: 60,
    contains: (m) => isRotation(m) && preservesIcosahedron(m),
  },
  { id: 'Ih', name: 'Full icosahedral', orbifold: '*532', order: 120, contains: preservesIcosahedron },
];

// Columns: a face center, one of its vertices, and the next vertex along an edge.
function flagMatrix(center, vertex, neighbor) {
  return new Matrix3().set(
    center.x, vertex.x, neighbor.x,
    center.y, vertex.y, neighbor.y,
    center.z, vertex.z, neighbor.z,
  );
}

// The symmetries of a regular polyhedron act simply transitively on its flags
// (face, vertex, edge), so there is exactly one symmetry per flag: the linear
// map taking a reference flag to it.
function fullSymmetryGroup({ vertices, faces, faceFrames }) {
  const referenceInverse = flagMatrix(
    faceFrames[0].center,
    vertices[faces[0][0]],
    vertices[faces[0][1]],
  ).invert();

  const matrices = [];
  faces.forEach((face, f) => {
    face.forEach((vertex, i) => {
      for (const step of [1, -1]) {
        const neighbor = face[(i + step + face.length) % face.length];
        matrices.push(
          flagMatrix(faceFrames[f].center, vertices[vertex], vertices[neighbor]).multiply(
            referenceInverse,
          ),
        );
      }
    });
  });
  return matrices;
}

// Where a symmetry takes each face, and the 2x2 matrix taking face coordinates
// on the face to face coordinates on its image.
function faceMaps(matrix, faceFrames) {
  return faceFrames.map(({ center, right, up }) => {
    const image = center.clone().applyMatrix3(matrix);
    const face = faceFrames.findIndex((frame) => frame.center.distanceToSquared(image) < EPSILON);
    const target = faceFrames[face];
    const mappedRight = right.clone().applyMatrix3(matrix);
    const mappedUp = up.clone().applyMatrix3(matrix);
    return {
      face,
      xx: target.right.dot(mappedRight),
      xy: target.right.dot(mappedUp),
      yx: target.up.dot(mappedRight),
      yy: target.up.dot(mappedUp),
    };
  });
}

// The named symmetry groups available on a polyhedron, smallest first.
export function symmetryGroups(polyhedron) {
  const elements = fullSymmetryGroup(polyhedron).map((matrix) => ({
    matrix,
    faceMaps: faceMaps(matrix, polyhedron.faceFrames),
  }));

  return NAMED_GROUPS.map(({ contains, ...group }) => {
    const members = elements.filter(({ matrix }) => contains(matrix));
    return {
      ...group,
      elements: members,
      reflections: members.some(({ matrix }) => !isRotation(matrix)),
    };
  }).filter((group) => group.elements.length === group.order);
}
