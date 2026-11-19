// Prints the solids as JSON for tools/build_nets.py: their names, each face's
// vertex indices, counter-clockwise from outside, and its corners in the
// face's own 2D coordinates, which the nets map onto the page. Taking them
// from src/polyhedra.js keeps the nets in step with the faces the app paints.
import { POLYHEDRA, toFaceCoordinates } from '../src/polyhedra.js';

const solids = [...POLYHEDRA.values()].map(({ id, name, vertices, faces, faceFrames }) => ({
  id,
  name,
  faces,
  corners: faces.map((face, f) => face.map((i) => toFaceCoordinates(faceFrames[f], vertices[i]))),
}));
process.stdout.write(JSON.stringify(solids));
