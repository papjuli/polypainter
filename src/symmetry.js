import { Matrix3, Matrix4 } from 'three';
import { ICOSAHEDRAL, OCTAHEDRAL, TETRAHEDRAL, isRotation, memberOf } from './groups.js';
import { atTurn, toFaceCoordinates } from './polyhedra.js';

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
// on the face to face coordinates on its image. A motion taking the solid to
// itself as it stands at another turn maps onto that turn's `targetFrames`.
function faceMaps(matrix, faceFrames, targetFrames = faceFrames) {
  return faceFrames.map(({ center, right, up }) => {
    const image = center.clone().applyMatrix3(matrix);
    const face = targetFrames.findIndex((frame) => frame.center.distanceToSquared(image) < EPSILON);
    const target = targetFrames[face];
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

// Whether a symmetry mirrors the faces, from its map of the first face.
const mirrors = (maps) => maps[0].xx * maps[0].yy - maps[0].xy * maps[0].yx < 0;

// The symmetry doing `inner`, then `outer`.
function compose(outer, inner) {
  return inner.map(({ face, xx, xy, yx, yy }) => {
    const next = outer[face];
    return {
      face: next.face,
      xx: next.xx * xx + next.xy * yx,
      xy: next.xx * xy + next.xy * yy,
      yx: next.yx * xx + next.yy * yx,
      yy: next.yx * xy + next.yy * yy,
    };
  });
}

const mapsKey = (maps) =>
  maps.map(({ face, xx, xy, yx, yy }) => [face, ...[xx, xy, yx, yy].map((value) => Math.round(value / EPSILON))]).join(';');

// The group that symmetries, given by their face maps, generate.
function generate(generators, faceCount) {
  const identity = Array.from({ length: faceCount }, (_, face) => ({ face, xx: 1, xy: 0, yx: 0, yy: 1 }));
  const elements = [identity];
  const seen = new Set([mapsKey(identity)]);
  // Iterating the list also visits the elements pushed onto it on the way.
  for (const element of elements) {
    for (const generator of generators) {
      const product = compose(generator, element);
      if (seen.has(mapsKey(product))) continue;
      seen.add(mapsKey(product));
      elements.push(product);
    }
  }
  return elements;
}

// The symmetries of a solid's surface as a surface, without regard to how it
// sits in space: the ways of laying its faces onto its faces, each fitting
// exactly, that keep faces next to each other next to each other. On a convex
// solid these are its symmetries, but a kaleidocycle has more, since it is
// flexible, and laid flat it is a parallelogram of triangles whose opposite
// sides join up.
//
// Each one is found from where it takes face 0, and which of its corners goes
// to which: the face across each edge then has to go to the face across that
// edge's image, and so on over the whole surface.
function surfaceSymmetries({ vertices, faces, faceFrames, adjacent }) {
  const corners = faces.map((face, f) => face.map((i) => toFaceCoordinates(faceFrames[f], vertices[i])));
  const found = [];
  faces.forEach((image, g) => {
    if (image.length !== faces[0].length) return;
    const n = image.length;
    for (let start = 0; start < n; start++) {
      for (const direction of [1, -1]) {
        // Which face each face goes to, and to which of its corners each
        // corner goes, corner k going to corner start + direction k.
        const placed = new Map([[0, { face: g, start, direction }]]);
        const queue = [0];
        let fits = true;
        while (fits && queue.length > 0) {
          const f = queue.shift();
          const { face, start: s, direction: d } = placed.get(f);
          const m = faces[face].length;
          const cornerOf = (k) => (((s + d * k) % m) + m) % m;
          faces[f].forEach((_, i) => {
            const [across, j] = adjacent[f][i];
            // The edge from corner i to i + 1 goes to the edge between their
            // images, which runs the other way round the image face when the
            // symmetry mirrors.
            const [imageAcross, imageJ] = adjacent[face][d > 0 ? cornerOf(i) : cornerOf(i + 1)];
            const k = faces[imageAcross].length;
            // Corner j of the face across is corner i + 1 of this face, and
            // corner j + 1 is corner i.
            const next = {
              face: imageAcross,
              start: d > 0 ? (((imageJ - j) % k) + k) % k : (((imageJ + 1 + j) % k) + k) % k,
              direction: d,
            };
            const before = placed.get(across);
            if (!before) {
              placed.set(across, next);
              queue.push(across);
            } else if (before.face !== next.face || before.start !== next.start) {
              fits = false;
            }
          });
        }
        if (!fits || placed.size !== faces.length) continue;

        // The faces have to fit their images exactly. Their frames are
        // centered on their corners' average, which the map keeps, so the map
        // of face coordinates is linear.
        const maps = [];
        for (let f = 0; fits && f < faces.length; f++) {
          const { face, start: s, direction: d } = placed.get(f);
          const m = faces[face].length;
          const to = (k) => corners[face][(((s + d * k) % m) + m) % m];
          const [[ax, ay], [bx, by]] = corners[f];
          const [[Ax, Ay], [Bx, By]] = [to(0), to(1)];
          const det = ax * by - ay * bx;
          const map = {
            face,
            xx: (Ax * by - Bx * ay) / det,
            xy: (Bx * ax - Ax * bx) / det,
            yx: (Ay * by - By * ay) / det,
            yy: (By * ax - Ay * bx) / det,
          };
          fits =
            Math.abs(map.xx * map.xx + map.yx * map.yx - 1) < EPSILON &&
            Math.abs(map.xx * map.xy + map.yx * map.yy) < EPSILON &&
            corners[f].every(([x, y], k) => {
              const [X, Y] = to(k);
              return Math.hypot(map.xx * x + map.xy * y - X, map.yx * x + map.yy * y - Y) < EPSILON;
            });
          maps.push(map);
        }
        if (fits) found.push(maps);
      }
    }
  });
  return found;
}

const turnAboutAxis = (angle) => new Matrix3().setFromMatrix4(new Matrix4().makeRotationY(angle));

// A kaleidocycle's symmetries come from its motion as much as its shape. As
// it stands, it only looks the same turned about its axis by two of its N
// tetrahedra. But a quarter of the way through its motion, it has the same
// shape again, turned by one tetrahedron, with other faces in their places:
// it shows four sides in turn, each a set of N faces, one from each
// tetrahedron, before it shows the first again. The groups add the motion's
// half and quarter turns to the turns about the axis, and then any symmetry
// of the surface, mirrors last.
function kaleidocycleGroups(polyhedron) {
  const { faces, faceFrames, ring } = polyhedron;
  const turnRing = faceMaps(turnAboutAxis((4 * Math.PI) / ring.count), faceFrames);
  const quarterTurn = faceMaps(turnAboutAxis((2 * Math.PI) / ring.count), faceFrames, atTurn(polyhedron, 0.25).faceFrames);
  const halfTurn = compose(quarterTurn, quarterTurn);
  const surface = surfaceSymmetries(polyhedron);
  const groups = [
    { id: 'C1', name: 'None', elements: generate([], faces.length) },
    { id: 'ring', name: 'Around the ring', elements: generate([turnRing], faces.length), preferred: true },
    { id: 'half-turn', name: 'Every half turn', elements: generate([turnRing, halfTurn], faces.length) },
    { id: 'quarter-turn', name: 'Every quarter turn', elements: generate([turnRing, quarterTurn], faces.length) },
    { id: 'faces', name: 'Every face', elements: surface.filter((maps) => !mirrors(maps)) },
    { id: 'faces-mirrored', name: 'Every face, mirrored', elements: surface },
  ];
  return groups.map(({ elements, ...group }) => ({
    ...group,
    label: group.name,
    order: elements.length,
    elements: elements.map((maps) => ({ faceMaps: maps })),
    reflections: elements.some(mirrors),
  }));
}

// The named symmetry groups available on a polyhedron, smallest first. Each
// has a label for the menu, and one, the solid's rotations as in Escher's
// designs, is marked as preferred.
export function symmetryGroups(polyhedron) {
  if (polyhedron.ring) return kaleidocycleGroups(polyhedron);
  const elements = fullSymmetryGroup(polyhedron).map((matrix) => ({
    matrix,
    faceMaps: faceMaps(matrix, polyhedron.faceFrames),
  }));

  const groups = NAMED_GROUPS.map(({ contains, ...group }) => {
    const members = elements.filter(({ matrix }) => contains(matrix));
    return {
      ...group,
      label: group.order === 1 ? group.name : `${group.name} (${group.id})`,
      elements: members,
      reflections: members.some(({ matrix }) => !isRotation(matrix)),
    };
  }).filter((group) => group.elements.length === group.order);
  groups.findLast((group) => !group.reflections).preferred = true;
  return groups;
}
