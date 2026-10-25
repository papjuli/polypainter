import { ICOSAHEDRAL, OCTAHEDRAL, TETRAHEDRAL, isRotation, memberOf } from './groups.js';

const EPSILON = 1e-6;

const isIdentity = (matrix) =>
  matrix.elements.every((value, i) => Math.abs(value - (i % 4 === 0 ? 1 : 0)) < EPSILON);
const isTetrahedral = memberOf(TETRAHEDRAL);
const isOctahedral = memberOf(OCTAHEDRAL);
const isIcosahedral = memberOf(ICOSAHEDRAL);

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
    contains: (m) => isRotation(m) && isTetrahedral(m),
  },
  { id: 'Td', name: 'Full tetrahedral', orbifold: '*332', order: 24, contains: isTetrahedral },
  {
    id: 'Th',
    name: 'Pyritohedral',
    orbifold: '3*2',
    order: 24,
    contains: (m) => isOctahedral(m) && isIcosahedral(m),
  },
  {
    id: 'O',
    name: 'Chiral octahedral',
    orbifold: '432',
    order: 24,
    contains: (m) => isRotation(m) && isOctahedral(m),
  },
  { id: 'Oh', name: 'Full octahedral', orbifold: '*432', order: 48, contains: isOctahedral },
  {
    id: 'I',
    name: 'Chiral icosahedral',
    orbifold: '532',
    order: 60,
    contains: (m) => isRotation(m) && isIcosahedral(m),
  },
  { id: 'Ih', name: 'Full icosahedral', orbifold: '*532', order: 120, contains: isIcosahedral },
];

// Every solid's symmetries are among these.
const CANDIDATES = [...OCTAHEDRAL, ...ICOSAHEDRAL.filter((matrix) => !isOctahedral(matrix))];

// The symmetries of a polyhedron: the candidates that take its vertices to
// its vertices.
function fullSymmetryGroup({ vertices }) {
  return CANDIDATES.filter((matrix) =>
    vertices.every((vertex) => {
      const image = vertex.clone().applyMatrix3(matrix);
      return vertices.some((other) => other.distanceToSquared(image) < EPSILON);
    }),
  );
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
