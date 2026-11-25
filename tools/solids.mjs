// Prints the solids as JSON for tools/build_nets.py: their names, each face's
// vertex indices, counter-clockwise from outside, its corners in the face's
// own 2D coordinates, which the nets map onto the page, and the face and edge
// across each of its edges, and for a kaleidocycle, how many tetrahedra it
// has. Taking them from src/polyhedra.js keeps the nets in step with the
// faces the app paints.
import { POLYHEDRA, toFaceCoordinates } from '../src/polyhedra.js';

const solids = [...POLYHEDRA.values()].map(({ id, name, vertices, faces, faceFrames, adjacent, ring }) => ({
  id,
  name,
  faces,
  corners: faces.map((face, f) => face.map((i) => toFaceCoordinates(faceFrames[f], vertices[i]))),
  adjacent,
  ring: ring?.count ?? null,
}));
process.stdout.write(JSON.stringify(solids));
