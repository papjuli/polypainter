import * as THREE from 'three';
import { floodFill } from './fill.js';
import { faceAt, projectToSurface, toFaceCoordinates } from './polyhedra.js';

// The paint lives in a texture atlas with one cell per face.
const TEXELS_PER_UNIT = 640;
const MAX_ATLAS_SIZE = 4096;
// Each cell keeps a margin around its face, painted as the face's extension,
// so texture filtering at the face's edges doesn't pick up unpainted texels.
const CELL_MARGIN = 8;
// Distance between consecutive dabs of a stroke, relative to the brush radius.
const DAB_SPACING = 0.25;
const BATCH_SIZE = 8192;

export const BASE_COLOR = new THREE.Color('#f3efe6');

// The texture holds colors with their alpha premultiplied. Paint goes over
// what's there, and transparent paint takes it away, both in proportion to
// their coverage.
const paintBlending = {
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
};

function setPaintBlending(material, transparent) {
  material.blendSrc = transparent ? THREE.ZeroFactor : THREE.OneFactor;
}

export function createAtlasLayout({ vertices, faces, faceFrames }, maxTextureSize) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  faces.forEach((face, f) => {
    for (const i of face) {
      const [x, y] = toFaceCoordinates(faceFrames[f], vertices[i]);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  });

  const columns = Math.ceil(Math.sqrt(faces.length));
  const rows = Math.ceil(faces.length / columns);
  const maxSize = Math.min(MAX_ATLAS_SIZE, maxTextureSize);
  const density = Math.min(
    TEXELS_PER_UNIT,
    (Math.floor(maxSize / columns) - 2 * CELL_MARGIN - 1) / (maxX - minX),
    (Math.floor(maxSize / rows) - 2 * CELL_MARGIN - 1) / (maxY - minY),
  );
  const cellWidth = Math.ceil((maxX - minX) * density) + 2 * CELL_MARGIN;
  const cellHeight = Math.ceil((maxY - minY) * density) + 2 * CELL_MARGIN;

  const cells = faces.map((_, f) => {
    const left = (f % columns) * cellWidth;
    const bottom = Math.floor(f / columns) * cellHeight;
    return {
      rect: [left, bottom, left + cellWidth, bottom + cellHeight],
      // Atlas position of the face's center.
      originX: left + CELL_MARGIN - minX * density,
      originY: bottom + CELL_MARGIN - minY * density,
    };
  });

  const width = columns * cellWidth;
  const height = rows * cellHeight;
  return {
    width,
    height,
    density,
    cells,
    uv(face, point) {
      const [x, y] = toFaceCoordinates(faceFrames[face], point);
      const { originX, originY } = cells[face];
      return [(originX + x * density) / width, (originY + y * density) / height];
    },
  };
}

// Draws antialiased discs into the atlas, each clipped to its face's cell.
// Positions are in atlas texels.
const dabShader = {
  vertexShader: /* glsl */ `
    attribute vec2 dabCenter;
    attribute float dabRadius;
    attribute vec3 dabColor;
    attribute vec4 dabRect;

    varying vec2 vPosition;
    varying vec2 vCenter;
    varying float vRadius;
    varying vec3 vColor;
    varying vec4 vRect;

    void main() {
      // One texel of slack so the antialiased rim isn't cut off.
      vPosition = dabCenter + position.xy * (dabRadius + 1.0);
      vCenter = dabCenter;
      vRadius = dabRadius;
      vColor = dabColor;
      vRect = dabRect;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(vPosition, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vPosition;
    varying vec2 vCenter;
    varying float vRadius;
    varying vec3 vColor;
    varying vec4 vRect;

    void main() {
      if (any(lessThan(vPosition, vRect.xy)) || any(greaterThan(vPosition, vRect.zw))) discard;
      float coverage = clamp(vRadius - distance(vPosition, vCenter) + 0.5, 0.0, 1.0);
      if (coverage == 0.0) discard;
      gl_FragColor = vec4(vColor * coverage, coverage);
    }
  `,
};

// Draws a bucket fill over the whole atlas: its color wherever the mask is set.
const bucketShader = {
  uniforms: {
    mask: { value: null },
    color: { value: new THREE.Color() },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D mask;
    uniform vec3 color;

    varying vec2 vUv;

    void main() {
      float coverage = texture2D(mask, vUv).r;
      gl_FragColor = vec4(color * coverage, coverage);
    }
  `,
};

// Paints on a polyhedron's surface, repeating every dab by a symmetry group.
//
// A painting is { polyhedron, layout, history, redoStack }, where the history
// holds strokes, bucket fills and clears. The texture is only a rendering of
// the history, so switching paintings, undoing and redoing all redraw from it.
export class Painter {
  constructor(renderer) {
    this.renderer = renderer;
    this.painting = null;
    this.target = null;
    this.stroke = null;
    this.lastDab = null;
    this.queued = 0;
    this.queuedTransparent = false;

    this.attributes = {
      dabCenter: new THREE.InstancedBufferAttribute(new Float32Array(BATCH_SIZE * 2), 2),
      dabRadius: new THREE.InstancedBufferAttribute(new Float32Array(BATCH_SIZE), 1),
      dabColor: new THREE.InstancedBufferAttribute(new Float32Array(BATCH_SIZE * 3), 3),
      dabRect: new THREE.InstancedBufferAttribute(new Float32Array(BATCH_SIZE * 4), 4),
    };
    const geometry = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(2, 2));
    for (const [name, attribute] of Object.entries(this.attributes)) {
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
    }
    this.dabs = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({ ...dabShader, ...paintBlending, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.dabs.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.dabs);
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);

    this.bucket = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({ ...bucketShader, ...paintBlending, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.bucket.frustumCulled = false;
    this.bucketScene = new THREE.Scene();
    this.bucketScene.add(this.bucket);
  }

  get texture() {
    return this.target.texture;
  }

  get canUndo() {
    return this.painting.history.length > 0;
  }

  get canRedo() {
    return this.painting.redoStack.length > 0;
  }

  get canClear() {
    return (this.painting.history.at(-1)?.type ?? 'clear') !== 'clear';
  }

  // Switches to another painting, with a texture of its own.
  load(painting) {
    this.target?.dispose();
    const { width, height } = painting.layout;
    this.target = new THREE.WebGLRenderTarget(width, height, {
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      anisotropy: this.renderer.capabilities.getMaxAnisotropy(),
    });
    this.camera.right = width;
    this.camera.top = height;
    this.camera.updateProjectionMatrix();
    this.painting = painting;
    this.queued = 0;
    this.redraw();
  }

  // `group` is the symmetry group that repeats the stroke; `radius` is in
  // world units, `color` a linear THREE.Color, or null to paint transparent.
  beginStroke(point, { group, color, radius }) {
    this.stroke = { type: 'stroke', group, color: color?.clone() ?? null, radius, points: [] };
    this.lastDab = null;
    this.extendStroke(point);
  }

  extendStroke(point) {
    if (!this.lastDab) {
      this.addDab(point);
      return;
    }
    // Dabs go along the chord to the new point, pushed back out onto the
    // surface, so a stroke crossing an edge follows the surface around it.
    const from = this.lastDab;
    const distance = from.distanceTo(point);
    const spacing = Math.max(this.stroke.radius * DAB_SPACING, 1 / this.painting.layout.density);
    for (let travelled = spacing; travelled <= distance; travelled += spacing) {
      this.addDab(projectToSurface(this.painting.polyhedron, from.clone().lerp(point, travelled / distance)));
    }
  }

  // Breaks the stroke without ending it, e.g. when the pointer leaves the
  // solid, so it isn't joined up across the gap.
  liftStroke() {
    this.lastDab = null;
  }

  endStroke() {
    if (this.stroke.points.length > 0) this.record(this.stroke);
    this.stroke = null;
  }

  // Fills the area of about the same color around the point, and the areas
  // around its images under `group`. `color` is a linear THREE.Color, or null
  // to fill with transparent paint.
  bucketFill(point, { group, color }) {
    const { polyhedron, layout } = this.painting;
    const face = faceAt(polyhedron, point);
    const [x, y] = toFaceCoordinates(polyhedron.faceFrames[face], point);
    const seeds = group.elements.map(({ faceMaps }) => {
      const { face: image, xx, xy, yx, yy } = faceMaps[face];
      const { originX, originY } = layout.cells[image];
      return {
        face: image,
        x: originX + (xx * x + xy * y) * layout.density,
        y: originY + (yx * x + yy * y) * layout.density,
      };
    });
    const runs = floodFill(polyhedron, layout, this.readPixels(), seeds, color);
    if (runs.length === 0) return;
    const action = { type: 'bucket', color: color?.clone() ?? null, runs };
    this.record(action);
    this.apply(action);
  }

  clear() {
    const action = { type: 'clear' };
    this.record(action);
    this.apply(action);
  }

  undo() {
    const action = this.painting.history.pop();
    if (!action) return;
    this.painting.redoStack.push(action);
    this.redraw();
  }

  redo() {
    const action = this.painting.redoStack.pop();
    if (!action) return;
    this.painting.history.push(action);
    this.apply(action);
  }

  // Draws the queued dabs into the texture; call before rendering the scene.
  flush() {
    if (this.queued === 0) return;
    for (const attribute of Object.values(this.attributes)) {
      attribute.addUpdateRange(0, this.queued * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.dabs.geometry.instanceCount = this.queued;
    setPaintBlending(this.dabs.material, this.queuedTransparent);
    this.drawOver(this.scene);
    this.queued = 0;
  }

  // Renders a scene on top of the texture.
  drawOver(scene) {
    const { renderer } = this;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(null);
    renderer.autoClear = autoClear;
  }

  // The texture's pixels as RGBA bytes with the alpha premultiplied, bottom
  // row first.
  readPixels() {
    this.flush();
    const { width, height } = this.painting.layout;
    const pixels = new Uint8Array(width * height * 4);
    this.renderer.readRenderTargetPixels(this.target, 0, 0, width, height, pixels);
    return pixels;
  }

  // Copies the texture into a 2D canvas, bottom row first like the texture.
  toCanvas() {
    const { width, height } = this.painting.layout;
    const pixels = new Uint8ClampedArray(this.readPixels().buffer);
    // The canvas takes colors without the alpha premultiplied, so it is
    // divided out of the partly transparent rims of transparent paint.
    const color = new THREE.Color();
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      if (alpha === 0 || alpha === 255) continue;
      color.setRGB(pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255, THREE.SRGBColorSpace);
      const hex = color.multiplyScalar(255 / alpha).getHex();
      pixels.set([hex >> 16, (hex >> 8) & 255, hex & 255], i);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return canvas;
  }

  record(action) {
    this.painting.history.push(action);
    this.painting.redoStack.length = 0;
  }

  redraw() {
    const { history } = this.painting;
    this.fill();
    const lastClear = history.findLastIndex((action) => action.type === 'clear');
    for (const action of history.slice(lastClear + 1)) this.apply(action);
  }

  apply(action) {
    if (action.type === 'clear') {
      this.fill();
    } else if (action.type === 'bucket') {
      this.drawBucket(action);
    } else {
      for (const point of action.points) this.drawDab(point, action);
    }
  }

  // `runs` lists the filled pixels as [start, end) ranges of pixel indices.
  drawBucket({ color, runs }) {
    // Draws the dabs queued so far first, so they end up under the fill.
    this.flush();
    const { width, height } = this.painting.layout;
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < runs.length; i += 2) mask.fill(255, runs[i], runs[i + 1]);
    const texture = new THREE.DataTexture(mask, width, height, THREE.RedFormat);
    texture.needsUpdate = true;
    const { material } = this.bucket;
    material.uniforms.mask.value = texture;
    if (color !== null) material.uniforms.color.value.copy(color);
    setPaintBlending(material, color === null);
    this.drawOver(this.bucketScene);
    texture.dispose();
  }

  addDab(point) {
    this.stroke.points.push(point);
    this.drawDab(point, this.stroke);
    this.lastDab = point;
  }

  fill() {
    const { width, height } = this.painting.layout;
    this.queueDab(width / 2, height / 2, width + height, BASE_COLOR, [0, 0, width, height]);
  }

  // A dab paints where a ball around the point meets the surface, so it
  // carries on across edges and corners. On each face plane the ball cuts,
  // that is a disc around the point's projection onto the plane.
  drawDab(point, { group, color, radius }) {
    const { polyhedron, layout } = this.painting;
    const footprint = [];
    polyhedron.faceFrames.forEach((frame, face) => {
      const depth = Math.max(frame.offset - frame.normal.dot(point), 0);
      if (depth >= radius) return;
      const [x, y] = toFaceCoordinates(frame, point);
      footprint.push({ face, x, y, radius: Math.sqrt(radius * radius - depth * depth) });
    });

    for (const { faceMaps } of group.elements) {
      for (const { face, x, y, radius: discRadius } of footprint) {
        const { face: image, xx, xy, yx, yy } = faceMaps[face];
        const { originX, originY, rect } = layout.cells[image];
        this.queueDab(
          originX + (xx * x + xy * y) * layout.density,
          originY + (yx * x + yy * y) * layout.density,
          discRadius * layout.density,
          color,
          rect,
        );
      }
    }
  }

  queueDab(x, y, radius, color, rect) {
    // Transparent dabs blend differently, so they are drawn in batches of
    // their own.
    const transparent = color === null;
    if (this.queued === BATCH_SIZE || (this.queued > 0 && transparent !== this.queuedTransparent)) this.flush();
    this.queuedTransparent = transparent;
    const i = this.queued++;
    const { dabCenter, dabRadius, dabColor, dabRect } = this.attributes;
    dabCenter.setXY(i, x, y);
    dabRadius.setX(i, radius);
    if (!transparent) dabColor.setXYZ(i, color.r, color.g, color.b);
    dabRect.setXYZW(i, ...rect);
  }
}
