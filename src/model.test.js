import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { modelFile } from './model.js';
import { TEXELS_PER_UNIT, createAtlasLayout } from './painter.js';
import { POLYHEDRA } from './polyhedra.js';

const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-5, `${message}: ${a} vs ${b}`);
// Stands in for the atlas image; its length is not a multiple of 4, so the
// padding after it is checked too.
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const material = { roughness: 0.8, metalness: 0 };

// Splits a .glb file into its JSON and binary chunks, checking its framing.
function parse(file, name) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67, name);
  assert.equal(view.getUint32(4, true), 2, name);
  assert.equal(view.getUint32(8, true), file.length, name);
  const jsonLength = view.getUint32(12, true);
  assert.equal(view.getUint32(16, true), 0x4e4f534a, name);
  const json = JSON.parse(new TextDecoder().decode(file.subarray(20, 20 + jsonLength)));
  const binaryStart = 20 + jsonLength + 8;
  const binaryLength = view.getUint32(binaryStart - 8, true);
  assert.equal(view.getUint32(binaryStart - 4, true), 0x004e4942, name);
  assert.equal(binaryStart + binaryLength, file.length, name);
  assert.equal(jsonLength % 4, 0, name);
  assert.equal(binaryLength % 4, 0, name);
  // The buffer may be padded by up to 3 bytes to fill the chunk.
  assert.ok(binaryLength - json.buffers[0].byteLength < 4, name);
  return { json, binary: file.subarray(binaryStart) };
}

function bufferViewBytes({ json, binary }, index, name) {
  const { buffer, byteOffset, byteLength } = json.bufferViews[index];
  assert.equal(buffer, 0, name);
  assert.ok(byteOffset + byteLength <= json.buffers[0].byteLength, name);
  return binary.slice(byteOffset, byteOffset + byteLength);
}

// An accessor's values as a typed array, with its layout checked.
function read(model, index, name) {
  const { bufferView, byteOffset = 0, componentType, count, type } = model.json.accessors[index];
  const Type = { 5126: Float32Array, 5125: Uint32Array }[componentType];
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
  assert.equal(byteOffset, 0, name);
  assert.equal(model.json.bufferViews[bufferView].byteOffset % Type.BYTES_PER_ELEMENT, 0, name);
  const bytes = bufferViewBytes(model, bufferView, name);
  assert.equal(bytes.length, count * size * Type.BYTES_PER_ELEMENT, name);
  return new Type(bytes.buffer);
}

const at = (array, i, size) => Array.from(array.subarray(i * size, (i + 1) * size));
const longFaced = [];

for (const [id, solid] of POLYHEDRA) {
  const layout = createAtlasLayout(solid, 4096);
  // The atlas fits the texture size. Its grid of cells suits the faces'
  // shape, so faces more than twice as long as they are wide still get the
  // full paint resolution.
  for (const size of [2048, 4096]) {
    const { width, height } = createAtlasLayout(solid, size);
    assert.ok(width <= size && height <= size, `${id} atlas size`);
  }
  const [left, bottom, right, top] = layout.cells[0].rect;
  const [cellWidth, cellHeight] = [right - left, top - bottom];
  if (Math.max(cellWidth, cellHeight) > 2 * Math.min(cellWidth, cellHeight)) {
    assert.equal(layout.density, TEXELS_PER_UNIT, `${id} atlas density`);
    longFaced.push(id);
  }

  const opaque = parse(modelFile(solid, layout, png, { ...material, alphaCutoff: null }), id);
  const model = parse(modelFile(solid, layout, png, { ...material, alphaCutoff: 0.5 }), id);

  // Holes are clipped only on solids painted with transparent paint, and the
  // inside shows through them.
  assert.equal(opaque.json.materials[0].alphaMode, undefined, id);
  assert.equal(model.json.materials[0].alphaMode, 'MASK', id);
  assert.equal(model.json.materials[0].alphaCutoff, 0.5, id);
  assert.equal(model.json.materials[0].doubleSided, true, id);

  // The image is the atlas, unchanged.
  const { images, textures, meshes, accessors } = model.json;
  assert.equal(images[0].mimeType, 'image/png', id);
  assert.deepEqual(bufferViewBytes(model, images[0].bufferView, id), png, id);
  assert.equal(textures[0].source, 0, id);

  const primitive = meshes[0].primitives[0];
  // Without normals, every triangle is shaded flat.
  assert.deepEqual(Object.keys(primitive.attributes).sort(), ['POSITION', 'TEXCOORD_0'], id);
  const positions = read(model, primitive.attributes.POSITION, id);
  const uvs = read(model, primitive.attributes.TEXCOORD_0, id);
  const indices = read(model, primitive.indices, id);

  // The bounds of the positions are exactly those of the stored values.
  for (let a = 0; a < 3; a++) {
    const values = positions.filter((_, i) => i % 3 === a);
    assert.equal(accessors[primitive.attributes.POSITION].min[a], Math.min(...values), id);
    assert.equal(accessors[primitive.attributes.POSITION].max[a], Math.max(...values), id);
  }

  // Every triangle lies in a face's cell of the atlas, at the coordinates the
  // app uses for its corners, and turns counter-clockwise seen from outside
  // that face, which glTF takes as its front.
  let area = 0;
  const cornerCount = positions.length / 3;
  assert.ok(indices.every((i) => i < cornerCount), id);
  for (let t = 0; t < indices.length; t += 3) {
    const corners = [...indices.subarray(t, t + 3)];
    const [a, b, c] = corners.map((i) => new Vector3(...at(positions, i, 3)));
    const [u, v] = at(uvs, corners[0], 2);
    const face = layout.cells.findIndex(({ rect }) => {
      const [x, y] = [u * layout.width, v * layout.height];
      return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3];
    });
    assert.ok(face >= 0, `${id}: triangle outside the atlas cells`);
    const { normal } = solid.faceFrames[face];
    const cross = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
    near(cross.clone().normalize().dot(normal), 1, `${id} face ${face} winding`);
    area += cross.length() / 2;
    for (const [i, point] of [a, b, c].entries()) {
      near(normal.dot(point), solid.faceFrames[face].offset, `${id} face ${face} plane`);
      const [expectedU, expectedV] = layout.uv(face, point);
      const [actualU, actualV] = at(uvs, corners[i], 2);
      near(actualU, expectedU, `${id} face ${face} u`);
      near(actualV, expectedV, `${id} face ${face} v`);
    }
  }

  // The triangles cover the faces exactly, with nothing left out or doubled.
  const faceArea = solid.faces.reduce((sum, face) => {
    const corners = face.map((i) => solid.vertices[i]);
    const doubled = corners.reduce((total, p, i) => total.add(new Vector3().crossVectors(p, corners[(i + 1) % corners.length])), new Vector3());
    return sum + doubled.length() / 2;
  }, 0);
  near(area, faceArea, `${id} area`);
}

console.log(`3D models of ${POLYHEDRA.size} solids OK; ${longFaced.length} with long faces get the full paint resolution: ${longFaced.join(', ')}`);
