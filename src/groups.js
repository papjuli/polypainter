import { Matrix3, Matrix4, Vector3 } from 'three';

export const PHI = (1 + Math.sqrt(5)) / 2;
const EPSILON = 1e-6;

const key = (matrix) => matrix.elements.map((value) => Math.round(value / EPSILON)).join(',');

// The group the given matrices generate, as all of its elements.
function generate(generators) {
  const elements = [new Matrix3()];
  const seen = new Set(elements.map(key));
  // Iterating the list also visits the elements pushed onto it on the way.
  for (const element of elements) {
    for (const generator of generators) {
      const product = generator.clone().multiply(element);
      if (seen.has(key(product))) continue;
      seen.add(key(product));
      elements.push(product);
    }
  }
  return elements;
}

const cycle = new Matrix3().set(0, 0, 1, 1, 0, 0, 0, 1, 0);
const mirror = new Matrix3().set(-1, 0, 0, 0, 1, 0, 0, 0, 1);
const quarterTurn = new Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0);
const fifthTurn = new Matrix3().setFromMatrix4(
  new Matrix4().makeRotationAxis(new Vector3(0, 1, PHI).normalize(), (2 * Math.PI) / 5),
);

// The full symmetry groups of the octahedron with vertices (±1, 0, 0) and so
// on, and of the icosahedron with vertices (0, ±1, ±PHI) and so on. Every
// solid is placed so that its symmetries are in one of them, and the two share
// the pyritohedral symmetries, which permute the axes cyclically.
export const OCTAHEDRAL = generate([cycle, mirror, quarterTurn]);
export const ICOSAHEDRAL = generate([cycle, mirror, fifthTurn]);

export const isRotation = (matrix) => matrix.determinant() > 0;

// A test for whether a matrix is in a group.
export function memberOf(group) {
  const keys = new Set(group.map(key));
  return (matrix) => keys.has(key(matrix));
}

// The symmetries of the tetrahedron with vertices (1, 1, 1), (1, -1, -1) and
// so on: the signed permutations that flip an even number of signs.
export const TETRAHEDRAL = OCTAHEDRAL.filter(
  (matrix) => matrix.elements.reduce((sign, value) => sign * (value || 1), 1) > 0,
);

// The points a group's elements take a point to.
export function orbit(group, point) {
  const points = [];
  for (const matrix of group) {
    const image = new Vector3(...point).applyMatrix3(matrix);
    if (!points.some((other) => other.distanceToSquared(image) < EPSILON)) points.push(image);
  }
  return points;
}
