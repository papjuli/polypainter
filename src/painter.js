import * as THREE from 'three';
import { floodFill } from './fill.js';
import { atTurn, faceAt, surfacePoint, toFaceCoordinates } from './polyhedra.js';
import { SHAPE_DISTANCE, shapeIndex } from './shapes.js';

// The paint lives in a texture atlas with one cell per face.
const TEXELS_PER_UNIT = 640;
const MAX_ATLAS_SIZE = 4096;
// Each cell keeps a margin around its face, painted as the face's extension,
// so texture filtering at the face's edges doesn't pick up unpainted texels.
const CELL_MARGIN = 8;
// Distance between consecutive dabs of a stroke, relative to their radius.
const DAB_SPACING = 0.25;
// How far along a tapered stroke it takes to come to a point at either end,
// relative to the brush radius.
const TAPER_LENGTH = 6;
const BATCH_SIZE = 8192;

// A tapered stroke's radius, relative to the full radius, at a fraction `t`
// of the way along its taper: growing from a point, and leveling off so that
// the taper joins the rest of the stroke without a kink.
const taper = (t) => (t >= 1 ? 1 : t <= 0 ? 0 : t * (2 - t));

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

// Where a dab of `radius` around a point on a solid, on face `face`, paints:
// a disc on each face it reaches, as the disc's center in the face's
// coordinates and its radius. `margin` is how far a face's cell reaches past
// its edges, in world units.
//
// A dab paints where a ball around the point meets the surface, so it
// carries on across edges and corners. On each face plane the ball cuts,
// that is a disc around the point's projection onto the plane. On solids
// that aren't convex, the point can be in front of a face's plane as well
// as behind it. Kaleidocycles are painted differently, below.
export function dabFootprint(surface, point, face, radius, margin) {
  if (surface.ring) return flatFootprint(surface, point, face, radius, margin);
  const footprint = [];
  surface.faceFrames.forEach((frame, f) => {
    const depth = Math.abs(frame.offset - frame.normal.dot(point));
    if (depth >= radius) return;
    const [x, y] = toFaceCoordinates(frame, point);
    footprint.push({ face: f, x, y, radius: Math.sqrt(radius * radius - depth * depth) });
  });
  return footprint;
}

// The dabs of a stroke from a dab, on face `face`, toward a point further
// along it, `spacing` apart, each with the face it is on. Null if the stroke
// shouldn't be joined up to the point, as below.
//
// On most solids, dabs go along the chord to the point, pushed back out onto
// the surface, so a stroke crossing an edge follows the surface around it.
// Kaleidocycles are painted differently, below.
export function strokeDabs(surface, from, face, to, spacing) {
  if (surface.ring) return flatStrokeDabs(surface, from, face, to, spacing);
  const distance = from.distanceTo(to);
  const dabs = [];
  for (let travelled = spacing; travelled <= distance; travelled += spacing) {
    dabs.push(surfacePoint(surface, from.clone().lerp(to, travelled / distance)));
  }
  return dabs;
}

// A kaleidocycle's surface lies flat around every corner, so it is painted
// laid flat, as on the paper it is printed on, and the paint is the same at
// every turn. Laid flat, faces join up along the edges they are glued along,
// which isn't how they meet in space. At a hinge, a face is glued to the
// other tetrahedron's face on the same side; the two faces behind the hinge
// are right there in space, but far away on the surface. So are the faces of
// tetrahedra across the ring, where the hexagonal ring's touch.
//
// A dab is a disc on the surface laid flat, starting on the point's face and
// carrying on across each edge it comes near into the face glued there. A
// disc that only reaches the margin past an edge still carries on across it,
// so texture filtering at the edge finds the paint just across it.
function flatFootprint(surface, point, face, radius, margin) {
  const center = toFaceCoordinates(surface.faceFrames[face], point);
  return [...layFlat(surface, face, center, radius + margin)].map(([f, motion]) => {
    const [x, y] = move(motion, center);
    return { face: f, x, y, radius };
  });
}

// Where a stamp of `radius` around a point on a solid, on face `face`, paints:
// on each face it reaches, its center in the face's coordinates and the
// directions its x and y axes point there. `angle` is how far it is turned
// counterclockwise from pointing along the face's up axis.
//
// A stamp goes on like a sticker, laid flat across the edges it comes near,
// as kaleidocycles are painted, so that it keeps its shape on every face. A
// ball, which dabs go by, is the only shape that a solid cuts the same way
// across every edge. Over a corner a sticker leaves a gap, as on paper.
export function stampFootprint(surface, point, face, radius, angle, margin) {
  const center = toFaceCoordinates(surface.faceFrames[face], point);
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  return [...layFlat(surface, face, center, radius + margin)].map(([f, motion]) => {
    const [x, y] = move(motion, center);
    return { face: f, x, y, xAxis: linear(motion, [cos, sin]), yAxis: linear(motion, [-sin, cos]) };
  });
}

// A stroke goes in a straight line on the surface laid flat. Going by the
// chord instead, a stroke along a hinge, from one side of it to the other,
// would cut under it where the faces in front of it make a ridge, and come
// out on the faces behind it.
//
// The surface has no edge, so there is always a way there, but when it is
// much longer than the way through space, as when the pointer goes over the
// outline of one tetrahedron onto one behind it, the stroke doesn't join up.
// Nor does it past half a hinge's length: the way around a tetrahedron is
// twice as long as a hinge, and laid flat further than that, the surface
// would overlap itself.
function flatStrokeDabs(surface, from, face, to, spacing) {
  const { faceFrames } = surface;
  const corners = cornersOf(surface);
  const start = toFaceCoordinates(faceFrames[face], from);
  const [hingeStart, hingeEnd] = corners[0];
  const hinge = Math.hypot(hingeEnd[0] - hingeStart[0], hingeEnd[1] - hingeStart[1]);
  const reach = Math.min(FLAT_STROKE_REACH * from.distanceTo(to) + spacing, hinge / 2);
  const laid = layFlat(surface, face, start, reach);
  const toFace = faceAt(surface, to);
  if (!laid.has(toFace)) return null;
  const end = move(inverse(laid.get(toFace)), toFaceCoordinates(faceFrames[toFace], to));
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  if (length > reach) return null;
  const dabs = [];
  for (let travelled = spacing; travelled <= length; travelled += spacing) {
    const at = [0, 1].map((k) => start[k] + ((end[k] - start[k]) * travelled) / length);
    // The face laid flat that the dab is furthest inside of, as it may be
    // on an edge.
    let best = null;
    for (const [f, motion] of laid) {
      const [x, y] = move(motion, at);
      const inside = Math.min(...corners[f].map((a, i) => leftOf([x, y], a, corners[f][(i + 1) % corners[f].length])));
      if (!best || inside > best.inside) best = { face: f, x, y, inside };
    }
    const { center, right, up } = faceFrames[best.face];
    dabs.push({ face: best.face, point: center.clone().addScaledVector(right, best.x).addScaledVector(up, best.y) });
  }
  return dabs;
}

// How much longer than through space the way to the next point of a stroke
// on a kaleidocycle can be along its surface, for the stroke to join up.
const FLAT_STROKE_REACH = 3;

// Lays the faces of a solid around face `start` flat in its coordinates,
// crossing the edges that come within `reach` of `center`, a point on it. For
// each face laid, gives the motion taking the start face's coordinates to its
// own. A kaleidocycle's surface laid flat only overlaps itself past a hinge's
// length, which is much larger than the brush. Around a corner of another
// solid, the faces add up to less than a full turn, or more, so laid flat
// they leave a gap, or would overlap; each face is laid once, from whichever
// side reaches it first.
function layFlat(surface, start, center, reach) {
  const { adjacent } = surface;
  const corners = cornersOf(surface);
  const laid = new Map([[start, { xx: 1, xy: 0, yx: 0, yy: 1, x: 0, y: 0 }]]);
  const queue = [start];
  while (queue.length > 0) {
    const f = queue.shift();
    const motion = laid.get(f);
    const here = move(motion, center);
    corners[f].forEach((a, i) => {
      const [g, j] = adjacent[f][i];
      const b = corners[f][(i + 1) % corners[f].length];
      if (laid.has(g) || distanceToSegment(here, a, b) >= reach) return;
      // Edge j of face g runs the other way, from b to a.
      const across = edgeMotion(a, b, corners[g][(j + 1) % corners[g].length], corners[g][j]);
      laid.set(g, compose(across, motion));
      queue.push(g);
    });
  }
  return laid;
}

// The corners of each face in its own coordinates, which stay the same as a
// kaleidocycle turns.
const faceCorners = new WeakMap();
function cornersOf({ vertices, faces, faceFrames }) {
  if (!faceCorners.has(faces)) {
    faceCorners.set(
      faces,
      faces.map((face, f) => face.map((i) => toFaceCoordinates(faceFrames[f], vertices[i]))),
    );
  }
  return faceCorners.get(faces);
}

function distanceToSegment([px, py], [ax, ay], [bx, by]) {
  const [dx, dy] = [bx - ax, by - ay];
  const t = Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0), 1);
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// How far a point is to the left of the line from a to b, which is inside a
// face for each of its edges.
function leftOf([px, py], [ax, ay], [bx, by]) {
  return ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / Math.hypot(bx - ax, by - ay);
}

// Motions of the plane, as { xx, xy, yx, yy, x, y } taking (u, v) to
// (xx u + xy v + x, yx u + yy v + y).
const move = ({ xx, xy, yx, yy, x, y }, [u, v]) => [xx * u + xy * v + x, yx * u + yy * v + y];

// Where a motion, or a symmetry's map of a face, takes a direction.
const linear = ({ xx, xy, yx, yy }, [u, v]) => [xx * u + xy * v, yx * u + yy * v];

function compose(outer, inner) {
  const [x, y] = move(outer, [inner.x, inner.y]);
  return {
    xx: outer.xx * inner.xx + outer.xy * inner.yx,
    xy: outer.xx * inner.xy + outer.xy * inner.yy,
    yx: outer.yx * inner.xx + outer.yy * inner.yx,
    yy: outer.yx * inner.xy + outer.yy * inner.yy,
    x,
    y,
  };
}

// The inverse of a motion that turns without mirroring or scaling.
function inverse({ xx, xy, yx, yy, x, y }) {
  return { xx, xy: yx, yx: xy, yy, x: -(xx * x + yx * y), y: -(xy * x + yy * y) };
}

// The motion taking an edge from a to b onto one as long from c to d, without
// mirroring. On an edge of a face, from a to b in its coordinates, which runs
// from c to d in those of the face glued to it there, it takes the first face
// into the second's coordinates, as the two lie unfolded flat about it.
function edgeMotion([ax, ay], [bx, by], [cx, cy], [dx, dy]) {
  const angle = Math.atan2(dy - cy, dx - cx) - Math.atan2(by - ay, bx - ax);
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
  return { xx: cos, xy: -sin, yx: sin, yy: cos, x: cx - (cos * ax - sin * ay), y: cy - (sin * ax + cos * ay) };
}

// Draws antialiased discs and stamp shapes into the atlas, each clipped to its
// face's cell. Positions and radii are in atlas texels. A shape's axes are
// the unit vectors its x and y axes point along in the atlas, one after the
// other. They are perpendicular, so a texel's coordinates along them are
// its offset from the center projected onto each.
const dabShader = {
  vertexShader: /* glsl */ `
    attribute vec2 dabCenter;
    attribute float dabRadius;
    attribute vec3 dabColor;
    attribute vec4 dabRect;
    attribute float dabShape;
    attribute vec4 dabAxes;

    varying vec2 vPosition;
    varying vec2 vCenter;
    varying float vRadius;
    varying vec3 vColor;
    varying vec4 vRect;
    varying float vShape;
    varying vec4 vAxes;

    void main() {
      // One texel of slack so the antialiased rim isn't cut off.
      vPosition = dabCenter + position.xy * (dabRadius + 1.0);
      vCenter = dabCenter;
      vRadius = dabRadius;
      vColor = dabColor;
      vRect = dabRect;
      vShape = dabShape;
      vAxes = dabAxes;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(vPosition, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vPosition;
    varying vec2 vCenter;
    varying float vRadius;
    varying vec3 vColor;
    varying vec4 vRect;
    varying float vShape;
    varying vec4 vAxes;

    ${SHAPE_DISTANCE}

    void main() {
      if (any(lessThan(vPosition, vRect.xy)) || any(greaterThan(vPosition, vRect.zw))) discard;
      // A vector times a matrix is its dot product with each column.
      vec2 p = (vPosition - vCenter) * mat2(vAxes) / vRadius;
      // The distance functions are in units of the radius.
      float coverage = clamp(0.5 - shapeDistance(int(vShape + 0.5), p) * vRadius, 0.0, 1.0);
      if (coverage == 0.0) discard;
      gl_FragColor = vec4(vColor * coverage, coverage);
    }
  `,
};

// The axes of a dab that isn't turned: a disc's, and a stamp's that is
// pointing along its face's up axis.
const UNTURNED = [1, 0, 0, 1];

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

// Sets single pixels of the atlas to the given colors, replacing what was
// there. Positions are pixel centers in atlas texels.
const pixelShader = {
  vertexShader: /* glsl */ `
    attribute vec4 pixelColor;

    varying vec4 vColor;

    void main() {
      vColor = pixelColor;
      gl_PointSize = 1.0;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec4 vColor;

    void main() {
      gl_FragColor = vColor;
    }
  `,
};

// Paints on a polyhedron's surface, repeating every dab by a symmetry group.
//
// A painting is { polyhedron, layout, history, redoStack, turn }, where the
// history holds strokes, stamps, bucket fills and clears, and `turn` is how far a
// kaleidocycle has turned (see atTurn()). The texture is only a rendering of
// the history, so switching paintings, undoing and redoing all redraw from it.
// A stroke's points are where they were on the solid as it stood when it was
// painted, so a stroke keeps the turn it was painted at. It also keeps the
// face each point is on, as a point on an edge can't tell, and the radius of
// the dab there, which is smaller toward a tapered stroke's ends.
export class Painter {
  constructor(renderer) {
    this.renderer = renderer;
    this.painting = null;
    this.target = null;
    // A copy of the texture from before a tapered stroke, see beginStroke().
    this.snapshot = null;
    this.stroke = null;
    this.path = [];
    this.lifted = false;
    this.tapered = false;
    this.queued = 0;
    this.queuedTransparent = false;

    this.attributes = {
      dabCenter: new THREE.InstancedBufferAttribute(new Float32Array(BATCH_SIZE * 2), 2),
      dabRadius: new THREE.InstancedBufferAttribute(new Float32Array(BATCH_SIZE), 1),
      dabColor: new THREE.InstancedBufferAttribute(new Float32Array(BATCH_SIZE * 3), 3),
      dabRect: new THREE.InstancedBufferAttribute(new Float32Array(BATCH_SIZE * 4), 4),
      dabShape: new THREE.InstancedBufferAttribute(new Float32Array(BATCH_SIZE), 1),
      dabAxes: new THREE.InstancedBufferAttribute(new Float32Array(BATCH_SIZE * 4), 4),
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

    this.rimPixels = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({ ...pixelShader, blending: THREE.NoBlending, depthTest: false, depthWrite: false }),
    );
    this.rimPixels.frustumCulled = false;
    this.rimScene = new THREE.Scene();
    this.rimScene.add(this.rimPixels);
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

  // Whether transparent paint has gone on since the last clear, so the
  // surface may have holes in it.
  get hasTransparentPaint() {
    const { history } = this.painting;
    const sinceClear = history.slice(history.findLastIndex((action) => action.type === 'clear') + 1);
    return this.stroke?.color === null || sinceClear.some((action) => action.color === null);
  }

  // Switches to another painting, with a texture of its own.
  load(painting) {
    this.target?.dispose();
    this.snapshot?.dispose();
    this.snapshot = null;
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

  // The painting's solid as it stands at a turn, by default the current one.
  surface(turn = this.painting.turn) {
    return atTurn(this.painting.polyhedron, turn);
  }

  // `group` is the symmetry group that repeats the stroke; `radius` is in
  // world units, `color` a linear THREE.Color, or null to paint transparent.
  // A `tapered` stroke comes to a point at both ends.
  beginStroke(point, { group, color, radius, tapered = false }) {
    const { turn } = this.painting;
    this.stroke = { type: 'stroke', group, color: color?.clone() ?? null, radius, turn, points: [], faces: [], radii: [] };
    this.path = [];
    this.lifted = false;
    this.tapered = tapered;
    // Where a stroke ends is only known once it has, so its end is tapered
    // then, by putting back the texture from before the stroke and drawing
    // the stroke again. Replaying the whole history instead, as undo does,
    // would hold up the end of every stroke on a well-painted solid.
    if (tapered) this.saveSnapshot();
    this.extendStroke(point);
  }

  extendStroke(point) {
    const surface = this.surface(this.stroke.turn);
    const last = this.lifted ? null : this.path.at(-1);
    this.lifted = false;
    if (last) {
      const dabs = strokeDabs(surface, last.point, last.face, point, this.spacing(this.stroke.radius));
      if (dabs) {
        for (const dab of dabs) this.extendPath(surface, dab, true);
        return;
      }
    }
    this.extendPath(surface, { point, face: faceAt(surface, point) }, false);
  }

  // Breaks the stroke without ending it, e.g. when the pointer leaves the
  // solid, so it isn't joined up across the gap.
  liftStroke() {
    this.lifted = true;
  }

  endStroke() {
    if (this.tapered && this.snapshot) this.taperEnd();
    if (this.stroke.points.length > 0) this.record(this.stroke);
    this.stroke = null;
    this.path = [];
  }

  // The stroke's path holds the points where dabs of the brush's full radius
  // would go, each with how far along the stroke it is, `s`, and whether it
  // is `joined` to the point before it. This adds a point to it and paints up
  // to it. While the stroke goes on, only its start is tapered.
  extendPath(surface, { point, face }, joined) {
    const last = this.path.at(-1);
    const s = last ? last.s + (joined ? last.point.distanceTo(point) : 0) : 0;
    const next = { point, face, s, joined };
    this.path.push(next);
    const { radius } = this.stroke;
    const radiusAt = this.tapered ? (s) => radius * taper(s / (TAPER_LENGTH * radius)) : () => radius;
    for (const dab of this.dabsTo(surface, joined ? last : null, next, radiusAt)) this.addDab(dab);
  }

  // Draws the stroke again with both of its ends tapered, now that it is
  // known where it ends, over the texture as it was before the stroke. A
  // stroke too short to reach its full radius from both ends tapers over half
  // its length at each, so a short flick makes a leaf shape, and a click that
  // doesn't go anywhere makes a round dot.
  taperEnd() {
    const { stroke, path } = this;
    const surface = this.surface(stroke.turn);
    const length = path.at(-1).s;
    const reach = Math.min(TAPER_LENGTH * stroke.radius, length / 2);
    const radiusAt = (s) => (reach > 0 ? stroke.radius * taper(Math.min(s, length - s) / reach) : stroke.radius);
    this.restoreSnapshot();
    Object.assign(stroke, { points: [], faces: [], radii: [] });
    path.forEach((next, k) => {
      for (const dab of this.dabsTo(surface, next.joined ? path[k - 1] : null, next, radiusAt)) this.addDab(dab);
    });
  }

  // The dabs from a point of the stroke's path, which has had its dab, up to
  // and including the next. The path is spaced for the full radius, so where
  // the radius is smaller, toward a tapered end, more dabs go in between. A
  // stroke's radius only grows and then shrinks along it, so it is smallest
  // between two points at one of them.
  dabsTo(surface, from, to, radiusAt) {
    const dabs = [];
    if (from) {
      const spacing = this.spacing(Math.min(radiusAt(from.s), radiusAt(to.s)));
      if (from.point.distanceTo(to.point) > 1.5 * spacing) {
        for (const { point, face } of strokeDabs(surface, from.point, from.face, to.point, spacing) ?? []) {
          // `to` gets its own dab, below.
          if (point.distanceTo(to.point) < spacing / 2) continue;
          dabs.push({ point, face, radius: radiusAt(from.s + from.point.distanceTo(point)) });
        }
      }
    }
    dabs.push({ point: to.point, face: to.face, radius: radiusAt(to.s) });
    return dabs;
  }

  // The distance between dabs of a radius, at least a texel.
  spacing(radius) {
    return Math.max(radius * DAB_SPACING, 1 / this.painting.layout.density);
  }

  // Copies the texture to put back by restoreSnapshot(). Strokes, fills and
  // the rest can't happen in between, apart from switching paintings, which
  // throws the copy away.
  saveSnapshot() {
    this.flush();
    if (!this.snapshot) {
      const { width, height } = this.painting.layout;
      this.snapshot = new THREE.WebGLRenderTarget(width, height, { colorSpace: THREE.SRGBColorSpace, depthBuffer: false });
      this.renderer.initRenderTarget(this.snapshot);
    }
    this.renderer.copyTextureToTexture(this.target.texture, this.snapshot.texture);
  }

  // Puts back the texture from saveSnapshot(), dropping the dabs queued
  // since, which all belong to the stroke it was saved for.
  restoreSnapshot() {
    this.queued = 0;
    this.renderer.copyTextureToTexture(this.snapshot.texture, this.target.texture);
  }

  // Fills the area of about the same color around the point, and the areas
  // around its images under `group`. `color` is a linear THREE.Color, or null
  // to fill with transparent paint.
  bucketFill(point, { group, color }) {
    const { polyhedron, layout } = this.painting;
    const surface = this.surface();
    const face = faceAt(surface, point);
    const [x, y] = toFaceCoordinates(surface.faceFrames[face], point);
    const seeds = group.elements.map(({ faceMaps }) => {
      const { face: image, xx, xy, yx, yy } = faceMaps[face];
      const { originX, originY } = layout.cells[image];
      return {
        face: image,
        x: originX + (xx * x + xy * y) * layout.density,
        y: originY + (yx * x + yy * y) * layout.density,
      };
    });
    const { runs, rim } = floodFill(polyhedron, layout, this.readPixels(), seeds, color);
    if (runs.length === 0) return;
    const action = { type: 'bucket', color: color?.clone() ?? null, runs, rim };
    this.record(action);
    this.apply(action);
  }

  // Stamps a shape around the point, and its images under `group`. `shape` is
  // the id of one of SHAPES, `radius` the circle it fits in, in world units,
  // and `angle` how far it is turned counterclockwise from pointing along
  // the up axis of the point's face. `color` is as for strokes.
  stamp(point, { group, color, shape, radius, angle }) {
    const { turn } = this.painting;
    const face = faceAt(this.surface(), point);
    const action = { type: 'stamp', group, color: color?.clone() ?? null, shape, radius, angle, turn, point, face };
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

  // The color painted at a point on the surface, read from the texture rather
  // than the rendered scene, so lighting and shading don't change it. Returns
  // an sRGB hex string such as '#b23a2e', or null where the paint is
  // transparent enough to show as a hole.
  colorAt(point) {
    this.flush();
    const { layout } = this.painting;
    const surface = this.surface();
    const face = faceAt(surface, point);
    const [x, y] = toFaceCoordinates(surface.faceFrames[face], point);
    const { originX, originY } = layout.cells[face];
    const column = THREE.MathUtils.clamp(Math.floor(originX + x * layout.density), 0, layout.width - 1);
    const row = THREE.MathUtils.clamp(Math.floor(originY + y * layout.density), 0, layout.height - 1);
    const pixel = new Uint8Array(4);
    this.renderer.readRenderTargetPixels(this.target, column, row, 1, 1, pixel);
    // The same cutoff as the material's alpha test, which decides what shows
    // as a hole.
    if (pixel[3] < 128) return null;
    // The alpha is premultiplied in linear color, as in toCanvas().
    const color = new THREE.Color().setRGB(pixel[0] / 255, pixel[1] / 255, pixel[2] / 255, THREE.SRGBColorSpace);
    return '#' + color.multiplyScalar(255 / pixel[3]).getHexString();
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
    } else if (action.type === 'stamp') {
      this.drawStamp(action);
    } else {
      action.points.forEach((point, k) => this.drawDab(point, action.faces[k], action.radii[k], action));
    }
  }

  // `runs` lists the filled pixels as [start, end) ranges of pixel indices,
  // and `rim` the pixels around them that the fill blends into, with their
  // new colors (see floodFill()).
  drawBucket({ color, runs, rim }) {
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
    this.drawPixels(rim);
  }

  // Sets the given pixels to the given colors, linear RGBA with the alpha
  // premultiplied.
  drawPixels({ pixels, colors }) {
    if (pixels.length === 0) return;
    const { width } = this.painting.layout;
    const positions = new Float32Array(pixels.length * 3);
    pixels.forEach((i, k) => {
      const u = i % width;
      positions[3 * k] = u + 0.5;
      positions[3 * k + 1] = (i - u) / width + 0.5;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('pixelColor', new THREE.BufferAttribute(colors, 4));
    this.rimPixels.geometry = geometry;
    this.drawOver(this.rimScene);
    geometry.dispose();
  }

  addDab({ point, face, radius }) {
    this.stroke.points.push(point);
    this.stroke.faces.push(face);
    this.stroke.radii.push(radius);
    this.drawDab(point, face, radius, this.stroke);
  }

  fill() {
    const { width, height } = this.painting.layout;
    this.queueDab(width / 2, height / 2, width + height, BASE_COLOR, [0, 0, width, height]);
  }

  drawDab(point, face, radius, { group, color, turn }) {
    const { layout } = this.painting;
    const footprint = dabFootprint(this.surface(turn), point, face, radius, CELL_MARGIN / layout.density);
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

  drawStamp({ point, face, turn, shape, radius, angle, group, color }) {
    const { layout } = this.painting;
    const footprint = stampFootprint(this.surface(turn), point, face, radius, angle, CELL_MARGIN / layout.density);
    const index = shapeIndex(shape);
    for (const { faceMaps } of group.elements) {
      for (const { face, x, y, xAxis, yAxis } of footprint) {
        const map = faceMaps[face];
        const { originX, originY, rect } = layout.cells[map.face];
        const [u, v] = linear(map, [x, y]);
        const axes = [...linear(map, xAxis), ...linear(map, yAxis)];
        this.queueDab(originX + u * layout.density, originY + v * layout.density, radius * layout.density, color, rect, index, axes);
      }
    }
  }

  // `shape` is the index of a stamp's shape, or 0 for a disc, and `axes` are
  // as in dabShader.
  queueDab(x, y, radius, color, rect, shape = 0, axes = UNTURNED) {
    // Transparent dabs blend differently, so they are drawn in batches of
    // their own.
    const transparent = color === null;
    if (this.queued === BATCH_SIZE || (this.queued > 0 && transparent !== this.queuedTransparent)) this.flush();
    this.queuedTransparent = transparent;
    const i = this.queued++;
    const { dabCenter, dabRadius, dabColor, dabRect, dabShape, dabAxes } = this.attributes;
    dabCenter.setXY(i, x, y);
    dabRadius.setX(i, radius);
    if (!transparent) dabColor.setXYZ(i, color.r, color.g, color.b);
    dabRect.setXYZW(i, ...rect);
    dabShape.setX(i, shape);
    dabAxes.setXYZW(i, ...axes);
  }
}
