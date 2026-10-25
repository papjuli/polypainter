import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { drawNet, unfold } from './net.js';
import { BASE_COLOR, Painter, createAtlasLayout } from './painter.js';
import { POLYHEDRA, faceAt } from './polyhedra.js';
import { symmetryGroups } from './symmetry.js';
import './style.css';

const PALETTE = ['#1d1d1f', '#b23a2e', '#e08a3c', '#e9c46a', '#5a8f4e', '#2a9d8f', '#2f6690', '#7a4e9a'];
// Brush radius per step of the size slider, in world units (the solids have
// a circumradius of 1).
const BRUSH_RADIUS_STEP = 0.004;
// Radius of the rings marking where a bucket fill starts.
const FILL_CURSOR_RADIUS = 0.02;

const viewport = document.getElementById('viewport');
const picker = document.getElementById('solid-picker');
const stats = document.getElementById('solid-stats');
const hint = document.getElementById('hint');
const resetButton = document.getElementById('reset-view');
const symmetrySelect = document.getElementById('symmetry');
const symmetryNote = document.getElementById('symmetry-note');
const toolPicker = document.getElementById('tool-picker');
const swatches = document.getElementById('swatches');
const customColor = document.getElementById('custom-color');
const brushSize = document.getElementById('brush-size');
const undoButton = document.getElementById('undo');
const redoButton = document.getElementById('redo');
const clearButton = document.getElementById('clear');
const showEdges = document.getElementById('show-edges');
const exportButton = document.getElementById('export-net');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161c);

// Field of view across the narrower side of the window, so the solid fits in
// both landscape and portrait.
const FIT_FOV = 45;
const camera = new THREE.PerspectiveCamera(FIT_FOV, 1, 0.1, 100);
camera.position.set(2.2, 1.6, 2.8);

// The key light rides along with the camera, so the side facing the viewer is
// always lit no matter how the solid is turned.
scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2f3d, 1.4));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(1, 2, 3);
camera.add(keyLight);
scene.add(camera);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 1.6;
controls.maxDistance = 12;
controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
controls.saveState();

const faceMaterial = new THREE.MeshStandardMaterial({
  flatShading: true,
  roughness: 0.8,
  metalness: 0,
  // Push faces back slightly so the edge lines drawn on top don't flicker.
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
});
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x1d1d1f, transparent: true, opacity: 0.35 });

function createSolid(polyhedron, layout) {
  const { vertices, faces, edges } = polyhedron;

  // Each polygonal face is split into a triangle fan from its first vertex.
  const facePositions = [];
  const faceUVs = [];
  faces.forEach((face, f) => {
    for (let i = 1; i < face.length - 1; i++) {
      for (const index of [face[0], face[i], face[i + 1]]) {
        facePositions.push(...vertices[index].toArray());
        faceUVs.push(...layout.uv(f, vertices[index]));
      }
    }
  });
  const faceGeometry = new THREE.BufferGeometry();
  faceGeometry.setAttribute('position', new THREE.Float32BufferAttribute(facePositions, 3));
  faceGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(faceUVs, 2));
  faceGeometry.computeVertexNormals();

  const edgePositions = edges.flatMap(([a, b]) => [...vertices[a].toArray(), ...vertices[b].toArray()]);
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));

  const mesh = new THREE.Mesh(faceGeometry, faceMaterial);
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  const object = new THREE.Group();
  object.add(mesh, edgeLines);
  object.visible = false;
  return { object, mesh, edgeLines };
}

const painter = new Painter(renderer);
const solids = new Map();
for (const polyhedron of POLYHEDRA) {
  const layout = createAtlasLayout(polyhedron, renderer.capabilities.maxTextureSize);
  const groups = symmetryGroups(polyhedron);
  const solid = {
    ...createSolid(polyhedron, layout),
    painting: {
      polyhedron,
      layout,
      groups,
      // Like Escher's designs, repeat by all of the solid's rotations unless
      // asked otherwise.
      group: groups.filter((group) => !group.reflections).at(-1),
      history: [],
      redoStack: [],
    },
  };
  solids.set(polyhedron.id, solid);
  scene.add(solid.object);

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = polyhedron.name;
  button.dataset.id = polyhedron.id;
  button.addEventListener('click', () => select(polyhedron.id));
  picker.appendChild(button);
}
let current = null;

// Rings showing where the brush and all of its symmetric copies will paint.
const maxGroupOrder = Math.max(
  ...[...solids.values()].flatMap(({ painting }) => painting.groups.map((group) => group.order)),
);
const cursor = new THREE.InstancedMesh(
  new THREE.RingGeometry(0.85, 1, 48),
  // Inverts what's behind it, so it shows on any paint color.
  new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneMinusDstColorFactor,
    blendDst: THREE.ZeroFactor,
  }),
  maxGroupOrder,
);
cursor.frustumCulled = false;
cursor.visible = false;
scene.add(cursor);

const Z_AXIS = new THREE.Vector3(0, 0, 1);
const cursorTransform = new THREE.Matrix4();
const cursorRotation = new THREE.Quaternion();
const cursorScale = new THREE.Vector3();

function showCursor(point) {
  const { polyhedron, group } = current.painting;
  const face = faceAt(polyhedron, point);
  cursorScale.setScalar(tool === 'fill' ? FILL_CURSOR_RADIUS : brushRadius());
  group.elements.forEach(({ matrix, faceMaps }, i) => {
    const normal = polyhedron.faceFrames[faceMaps[face].face].normal;
    const position = point.clone().applyMatrix3(matrix).addScaledVector(normal, 0.002);
    cursorRotation.setFromUnitVectors(Z_AXIS, normal);
    cursorTransform.compose(position, cursorRotation, cursorScale);
    cursor.setMatrixAt(i, cursorTransform);
  });
  cursor.count = group.elements.length;
  cursor.instanceMatrix.needsUpdate = true;
  cursor.visible = true;
}

function hideCursor() {
  cursor.visible = false;
}

function select(id) {
  current = solids.get(id);
  for (const [solidId, solid] of solids) solid.object.visible = solidId === id;
  for (const button of picker.children) {
    button.setAttribute('aria-pressed', String(button.dataset.id === id));
  }
  const { polyhedron } = current.painting;
  stats.textContent =
    `${polyhedron.faces.length} faces · ` +
    `${polyhedron.edges.length} edges · ` +
    `${polyhedron.vertices.length} vertices`;

  painter.load(current.painting);
  faceMaterial.map = painter.texture;
  faceMaterial.needsUpdate = true;

  const { groups, group } = current.painting;
  symmetrySelect.replaceChildren(
    ...groups.map((g) => new Option(g.order === 1 ? g.name : `${g.name} (${g.id})`, g.id, false, g === group)),
  );
  describeSymmetry();
  updateHistoryButtons();
  hideCursor();
}

function describeSymmetry() {
  const { group } = current.painting;
  symmetryNote.textContent =
    group.order === 1
      ? 'Strokes are not repeated.'
      : `${group.order} copies · ${group.reflections ? 'rotations and reflections' : 'rotations only'} · ` +
        `orbifold ${group.orbifold}`;
}

symmetrySelect.addEventListener('change', () => {
  current.painting.group = current.painting.groups.find((group) => group.id === symmetrySelect.value);
  describeSymmetry();
});

let tool = 'paint';

function setTool(name) {
  tool = name;
  for (const button of toolPicker.children) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === name));
  }
  viewport.classList.toggle('painting', name !== 'rotate');
  hint.textContent =
    name === 'rotate'
      ? 'Drag to rotate · Scroll or pinch to zoom'
      : name === 'fill'
        ? 'Click on the solid to fill an area · Drag around it or right-drag to rotate · Scroll to zoom'
        : 'Drag on the solid to paint · Drag around it or right-drag to rotate · Scroll to zoom';
  hideCursor();
}

for (const button of toolPicker.children) {
  button.addEventListener('click', () => setTool(button.dataset.tool));
}

const brushColor = new THREE.Color();

function setColor(hex, swatch) {
  brushColor.set(hex);
  for (const element of swatches.children) {
    element.classList.toggle('selected', element === swatch);
    if (element instanceof HTMLButtonElement) element.setAttribute('aria-pressed', String(element === swatch));
  }
  if (tool === 'erase') setTool('paint');
}

for (const hex of PALETTE) {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'swatch';
  swatch.style.background = hex;
  swatch.setAttribute('aria-label', `Color ${hex}`);
  swatch.addEventListener('click', () => setColor(hex, swatch));
  swatches.insertBefore(swatch, customColor);
}
customColor.addEventListener('input', () => setColor(customColor.value, customColor));

const brushRadius = () => Number(brushSize.value) * BRUSH_RADIUS_STEP;

function updateHistoryButtons() {
  undoButton.disabled = !painter.canUndo;
  redoButton.disabled = !painter.canRedo;
  clearButton.disabled = !painter.canClear;
}

let strokePointer = null;

function runCommand(command) {
  if (strokePointer !== null) return;
  command();
  updateHistoryButtons();
}

undoButton.addEventListener('click', () => runCommand(() => painter.undo()));
redoButton.addEventListener('click', () => runCommand(() => painter.redo()));
clearButton.addEventListener('click', () => runCommand(() => painter.clear()));

window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'z' && !event.shiftKey) runCommand(() => painter.undo());
  else if (key === 'y' || (key === 'z' && event.shiftKey)) runCommand(() => painter.redo());
  else return;
  event.preventDefault();
});

showEdges.addEventListener('change', () => {
  for (const solid of solids.values()) solid.edgeLines.visible = showEdges.checked;
});

exportButton.addEventListener('click', () => {
  const { polyhedron, layout } = current.painting;
  drawNet(unfold(polyhedron), layout, painter.toCanvas()).toBlob((blob) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `polypainter-${polyhedron.id}-net.png`;
    link.click();
    // Some browsers start the download only after the click has returned.
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  });
});

resetButton.addEventListener('click', () => controls.reset());

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function surfacePointAt(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    ((rect.top - event.clientY) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(current.mesh)[0]?.point ?? null;
}

let orbiting = false;
controls.addEventListener('start', () => {
  orbiting = true;
  hideCursor();
});
controls.addEventListener('end', () => {
  orbiting = false;
});

// Listens on the container in the capture phase, so that a drag starting on
// the solid paints instead of reaching the orbit controls on the canvas.
viewport.addEventListener(
  'pointerdown',
  (event) => {
    if (strokePointer !== null) {
      // Ignore further fingers while painting.
      event.stopPropagation();
      return;
    }
    if (tool === 'rotate' || event.button !== 0) return;
    const point = surfacePointAt(event);
    if (!point) return;

    event.stopPropagation();
    if (tool === 'fill') {
      runCommand(() => painter.bucketFill(point, { group: current.painting.group, color: brushColor }));
      showCursor(point);
      return;
    }
    strokePointer = event.pointerId;
    viewport.setPointerCapture(event.pointerId);
    painter.beginStroke(point, {
      group: current.painting.group,
      color: tool === 'erase' ? BASE_COLOR : brushColor,
      radius: brushRadius(),
    });
    showCursor(point);
  },
  { capture: true },
);

viewport.addEventListener('pointermove', (event) => {
  if (tool === 'rotate' || orbiting) return;
  if (strokePointer !== null && event.pointerId !== strokePointer) return;
  const point = surfacePointAt(event);
  if (event.pointerId === strokePointer) {
    if (point) painter.extendStroke(point);
    else painter.liftStroke();
  }
  if (point) showCursor(point);
  else hideCursor();
});

function endStroke(event) {
  if (event.pointerId !== strokePointer) return;
  painter.endStroke();
  strokePointer = null;
  if (event.pointerType === 'touch') hideCursor();
  updateHistoryButtons();
}
viewport.addEventListener('pointerup', endStroke);
viewport.addEventListener('pointercancel', endStroke);
viewport.addEventListener('pointerleave', () => {
  if (strokePointer === null) hideCursor();
});

function resize() {
  const { clientWidth: width, clientHeight: height } = viewport;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  const halfFit = Math.tan(THREE.MathUtils.degToRad(FIT_FOV / 2));
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfFit / Math.min(camera.aspect, 1)));
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

setColor(PALETTE[0], swatches.children[0]);
setTool('paint');
select('cube');

renderer.setAnimationLoop(() => {
  controls.update();
  painter.flush();
  renderer.render(scene, camera);
});
