// Writes a painted solid as a binary glTF file (.glb), which Blender and most
// other 3D apps import with the paint as the solid's texture.

// The codes glTF uses for its data types, buffer targets and texture filters.
const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const LINEAR = 9729;
const LINEAR_MIPMAP_LINEAR = 9987;
const CLAMP_TO_EDGE = 33071;

// The file's magic number and chunk types, as little-endian ASCII.
const MAGIC = 0x46546c67; // 'glTF'
const JSON_CHUNK = 0x4e4f534a; // 'JSON'
const BINARY_CHUNK = 0x004e4942; // 'BIN\0'

// Chunks, and the data each accessor reads, start on 4 byte boundaries.
const align = (length) => Math.ceil(length / 4) * 4;

// `png` holds the bytes of the atlas as painter.toCanvas() draws it. glTF
// counts texture coordinates from the image's top row, and the canvas has
// the atlas's bottom row on top, so the atlas's coordinates carry over as
// they are. `alphaCutoff` clips the holes left by transparent paint, or is
// null for a solid without any.
export function modelFile({ name, vertices, faces }, layout, png, { roughness, metalness, alphaCutoff }) {
  // Each face has corners of its own, since they lie in the face's own cell
  // of the atlas. It is split into a fan of triangles from its first corner,
  // as in the app, which works because every face is convex. The file has no
  // normals, which tells readers to shade every triangle flat. Blender then
  // marks every face flat, where with normals it marks some smooth, as
  // rounding makes them differ from its own by a hair.
  const cornerCount = faces.reduce((count, face) => count + face.length, 0);
  const positions = new Float32Array(cornerCount * 3);
  const uvs = new Float32Array(cornerCount * 2);
  const indices = new Uint32Array((cornerCount - 2 * faces.length) * 3);
  let corner = 0;
  let index = 0;
  faces.forEach((face, f) => {
    const first = corner;
    for (const i of face) {
      positions.set(vertices[i].toArray(), corner * 3);
      uvs.set(layout.uv(f, vertices[i]), corner * 2);
      corner++;
    }
    for (let i = 1; i < face.length - 1; i++) {
      indices.set([first, first + i, first + i + 1], index);
      index += 3;
    }
  });

  // The binary chunk holds these one after another, the image last because
  // it is the only one whose length isn't a multiple of 4.
  const parts = [
    { data: positions, target: ARRAY_BUFFER },
    { data: uvs, target: ARRAY_BUFFER },
    { data: indices, target: ELEMENT_ARRAY_BUFFER },
    { data: png },
  ];
  let byteLength = 0;
  const bufferViews = parts.map(({ data, target }) => {
    const view = { buffer: 0, byteOffset: align(byteLength), byteLength: data.byteLength, target };
    byteLength = view.byteOffset + view.byteLength;
    return view;
  });

  // Readers use the bounds of the positions without reading them, so they
  // must match the stored values exactly, which these are read back from.
  const bounds = (pick) => [0, 1, 2].map((axis) => pick(...positions.filter((_, i) => i % 3 === axis)));

  const gltf = {
    asset: { version: '2.0', generator: 'PolyPainter' },
    scene: 0,
    scenes: [{ name, nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [
      {
        name,
        primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }],
      },
    ],
    materials: [
      {
        name: `${name} paint`,
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: metalness,
          roughnessFactor: roughness,
        },
        // The inside of the solid shows through its holes.
        doubleSided: true,
        ...(alphaCutoff === null ? {} : { alphaMode: 'MASK', alphaCutoff }),
      },
    ],
    textures: [{ sampler: 0, source: 0 }],
    // Each face's cell has a margin painted as the face's extension, so
    // filtering at the faces' edges doesn't reach the cells around them.
    samplers: [{ magFilter: LINEAR, minFilter: LINEAR_MIPMAP_LINEAR, wrapS: CLAMP_TO_EDGE, wrapT: CLAMP_TO_EDGE }],
    images: [{ name: `${name} paint`, mimeType: 'image/png', bufferView: 3 }],
    accessors: [
      { bufferView: 0, componentType: FLOAT, count: cornerCount, type: 'VEC3', min: bounds(Math.min), max: bounds(Math.max) },
      { bufferView: 1, componentType: FLOAT, count: cornerCount, type: 'VEC2' },
      { bufferView: 2, componentType: UNSIGNED_INT, count: indices.length, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength }],
  };

  // The file has a 12 byte header, then the JSON chunk, padded with spaces,
  // and the binary chunk, padded with zeros. Each chunk starts with its
  // length and type. glTF is little-endian, like the typed arrays on every
  // platform browsers run on, so those are copied in as they are.
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = align(json.length);
  const binaryStart = 12 + 8 + jsonLength + 8;
  const file = new Uint8Array(binaryStart + align(byteLength));
  const view = new DataView(file.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, file.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  file.fill(0x20, 20, 20 + jsonLength);
  file.set(json, 20);
  view.setUint32(binaryStart - 8, align(byteLength), true);
  view.setUint32(binaryStart - 4, BINARY_CHUNK, true);
  parts.forEach(({ data }, i) => {
    file.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), binaryStart + bufferViews[i].byteOffset);
  });
  return file;
}
