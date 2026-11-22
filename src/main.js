import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { cutFile } from './cutfile.js';
import { modelFile } from './model.js';
import { PIXELS_PER_MM, drawNet, findHoles } from './net.js';
import { BASE_COLOR, Painter, createAtlasLayout } from './painter.js';
import { setPixelsPerMeter } from './png.js';
import { POLYHEDRA, faceAt } from './polyhedra.js';
import { symmetryGroups } from './symmetry.js';
import './style.css';

const PALETTE = ['#1d1d1f', '#b23a2e', '#e08a3c', '#e9c46a', '#5a8f4e', '#2a9d8f', '#2f6690', '#7a4e9a'];
// Brush radius per step of the size slider, in world units (the solids have
// a circumradius of 1).
const BRUSH_RADIUS_STEP = 0.004;
// Radius of the rings marking where a bucket fill starts.
const FILL_CURSOR_RADIUS = 0.02;
// Brightness of the solid's inside, which shows through transparent paint,
// relative to its outside.
const INSIDE_BRIGHTNESS = 0.6;

const viewport = document.getElementById('viewport');
const tools = document.querySelector('.tools');
const picker = document.getElementById('solid-picker');
const stats = document.getElementById('solid-stats');
const hint = document.getElementById('hint');
const resetButton = document.getElementById('reset-view');
const symmetrySelect = document.getElementById('symmetry');
const symmetryNote = document.getElementById('symmetry-note');
const toolPicker = document.getElementById('tool-picker');
const swatches = document.getElementById('swatches');
const transparentSwatch = document.getElementById('transparent-color');
const customColor = document.getElementById('custom-color');
const brushSize = document.getElementById('brush-size');
const undoButton = document.getElementById('undo');
const redoButton = document.getElementById('redo');
const clearButton = document.getElementById('clear');
const showEdges = document.getElementById('show-edges');
const exportButton = document.getElementById('export-net');
const exportDialog = document.getElementById('export-dialog');
const exportForm = document.getElementById('export-form');
const exportStatus = document.getElementById('export-status');
const exportModelButton = document.getElementById('export-model');
const modelStatus = document.getElementById('model-status');

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
  // Transparent paint cuts holes, through which the inside of the far faces
  // shows.
  side: THREE.DoubleSide,
  alphaTest: 0.5,
  alphaToCoverage: true,
  // Push faces back slightly so the edge lines drawn on top don't flicker.
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
});
// The painter's texture has its alpha premultiplied, which the material
// doesn't expect, so it is divided out again.
faceMaterial.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <map_fragment>',
    /* glsl */ `
      vec4 paint = texture2D(map, vMapUv);
      diffuseColor *= vec4(paint.rgb / max(paint.a, 1e-3), paint.a);
      if (!gl_FrontFacing) diffuseColor.rgb *= ${INSIDE_BRIGHTNESS.toFixed(2)};
    `,
  );
};
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
const families = new Map();
for (const polyhedron of POLYHEDRA.values()) {
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

  if (!families.has(polyhedron.family)) {
    const family = document.createElement('optgroup');
    family.label = polyhedron.family;
    families.set(polyhedron.family, picker.appendChild(family));
  }
  families.get(polyhedron.family).appendChild(new Option(polyhedron.name, polyhedron.id));
}
picker.addEventListener('change', () => select(picker.value));
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
  picker.value = id;
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

const PAINT_HINT = 'Drag on the solid to paint · Alt+click to pick a color · Drag around it or right-drag to rotate · Scroll to zoom';
const HINTS = {
  paint: PAINT_HINT,
  erase: PAINT_HINT,
  fill: 'Click on the solid to fill an area · Alt+click to pick a color · Drag around it or right-drag to rotate · Scroll to zoom',
  pick: 'Click on the solid to pick up a color · Drag around it or right-drag to rotate · Scroll to zoom',
  rotate: 'Drag to rotate · Scroll or pinch to zoom',
};

let tool = 'paint';
// The tool to go back to once a color has been picked.
let toolBeforePick = 'paint';

function setTool(name) {
  if (name !== 'pick') toolBeforePick = name;
  tool = name;
  for (const button of toolPicker.children) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === name));
  }
  viewport.classList.toggle('painting', name !== 'rotate');
  hint.textContent = HINTS[name];
  hideCursor();
}

// Whether a click picks up a color: with the Pick tool, or with Alt held
// down with the other tools. The Rotate tool never gets as far as asking.
const picksColor = (event) => tool === 'pick' || event.altKey;

for (const button of toolPicker.children) {
  button.addEventListener('click', () => setTool(button.dataset.tool));
}

// A THREE.Color, or null to paint transparent.
let brushColor = null;

function setColor(color, swatch) {
  brushColor = color;
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
  swatch.dataset.color = hex;
  swatch.setAttribute('aria-label', `Color ${hex}`);
  swatch.addEventListener('click', () => setColor(new THREE.Color(hex), swatch));
  swatches.insertBefore(swatch, transparentSwatch);
}
transparentSwatch.addEventListener('click', () => setColor(null, transparentSwatch));
customColor.addEventListener('input', () => setColor(new THREE.Color(customColor.value), customColor));

// Takes up the color painted at a point on the solid. A palette color selects
// its own swatch; any other color goes into the custom color.
function pickColor(point) {
  const hex = painter.colorAt(point);
  const swatch =
    hex === null
      ? transparentSwatch
      : ([...swatches.children].find((element) => element.dataset.color === hex) ?? customColor);
  if (swatch === customColor) customColor.value = hex;
  setColor(hex === null ? null : new THREE.Color(hex), swatch);
  // Like an eyedropper, the Pick tool is used once and hands back to the
  // brush. An Alt+click leaves the tool as it was, except that picking a
  // color ends erasing.
  if (tool === 'pick') setTool(toolBeforePick === 'fill' ? 'fill' : 'paint');
}

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
  // The painting behind the export dialog stays as it is while the dialog is
  // open, so the net exports what the user saw.
  if (exportDialog.open || !(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'z' && !event.shiftKey) runCommand(() => painter.undo());
  else if (key === 'y' || (key === 'z' && event.shiftKey)) runCommand(() => painter.redo());
  else return;
  event.preventDefault();
});

showEdges.addEventListener('change', () => {
  for (const solid of solids.values()) solid.edgeLines.visible = showEdges.checked;
});

function download(blob, filename) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  // Some browsers start the download only after the click has returned.
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

// Waits for the next frame to be painted, so that a status message and
// disabled controls show before work that blocks the page.
const afterNextPaint = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

// The nets, laid out ahead of time by tools/build_nets.py, one file per solid,
// each loaded when its solid is first exported.
const netFiles = import.meta.glob('./nets/*.json', { import: 'default' });

async function loadNet(id, assembly) {
  const load = netFiles[`./nets/${id}.json`];
  const net = load && (await load())[assembly];
  if (!net) throw new Error(`There is no ${assembly} net for the ${id}.`);
  return net;
}

let exporting = false;
exportButton.addEventListener('click', () => {
  exportStatus.textContent = '';
  exportDialog.showModal();
});
document.getElementById('export-cancel').addEventListener('click', () => exportDialog.close());
exportDialog.addEventListener('cancel', (event) => {
  if (exporting) event.preventDefault();
});
// Chrome ignores preventDefault on the cancel event when Escape is pressed
// again without the user having clicked in between, so while exporting the
// key itself is stopped. Disabling the focused button moves focus out of the
// dialog, so this listens on the whole document.
document.addEventListener('keydown', (event) => {
  if (exporting && event.key === 'Escape') event.preventDefault();
});
exportForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (exporting) return;
  const assembly = document.getElementById('assembly-method').value;
  const includeCutter = document.getElementById('export-cutter').checked;
  const { polyhedron, layout } = current.painting;
  exporting = true;
  const inputs = [...exportForm.querySelectorAll('button, select, input')];
  inputs.forEach((input) => { input.disabled = true; });
  exportStatus.textContent = 'Preparing your net…';
  let pngSaved = false;
  try {
    const net = await loadNet(polyhedron.id, assembly);
    await afterNextPaint();
    const atlas = painter.toCanvas();
    const name = 'polypainter-' + polyhedron.id + '-net' + (assembly === 'interlocking' ? '-interlocking' : '');
    const blob = await new Promise((resolve) => drawNet(net, layout, atlas).toBlob(resolve));
    if (!blob) throw new Error('Could not create the print image.');
    // The PNG is saved first, so a failure in the cutter file doesn't lose it.
    download(await setPixelsPerMeter(blob, PIXELS_PER_MM * 1000), name + '.png');
    pngSaved = true;
    if (includeCutter) {
      const dxf = cutFile(net, findHoles(net, layout, atlas));
      download(new Blob([dxf], { type: 'application/dxf' }), name + '.dxf');
    }
    exportDialog.close();
  } catch (error) {
    exportStatus.textContent =
      (pngSaved ? 'The PNG was saved, but the cutter file failed: ' : 'Export failed: ') + error.message;
    // A close request that couldn't be stopped, such as the Android back
    // button, may have closed the dialog, so it is shown again with the error.
    if (!exportDialog.open) exportDialog.showModal();
  } finally {
    exporting = false;
    inputs.forEach((input) => { input.disabled = false; });
  }
});

exportModelButton.addEventListener('click', async () => {
  exportModelButton.disabled = true;
  modelStatus.textContent = '';
  try {
    await afterNextPaint();
    // Read together, before anything else can run, so the texture matches
    // the solid even if the user switches solids during the export.
    const { polyhedron, layout } = current.painting;
    const atlas = painter.toCanvas();
    const hasHoles = painter.hasTransparentPaint;
    const png = await new Promise((resolve) => atlas.toBlob(resolve));
    if (!png) throw new Error('Could not create the texture image.');
    const glb = modelFile(polyhedron, layout, new Uint8Array(await png.arrayBuffer()), {
      roughness: faceMaterial.roughness,
      metalness: faceMaterial.metalness,
      alphaCutoff: hasHoles ? faceMaterial.alphaTest : null,
    });
    download(new Blob([glb], { type: 'model/gltf-binary' }), `polypainter-${polyhedron.id}.glb`);
  } catch (error) {
    modelStatus.textContent = 'Export failed: ' + error.message;
  } finally {
    exportModelButton.disabled = false;
  }
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
    if (picksColor(event)) {
      pickColor(point);
      return;
    }
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
  // Picking reads a single point, so the brush rings would mislead. Holding
  // Alt in the middle of a stroke doesn't pick, so the rings stay.
  if (point && (event.pointerId === strokePointer || !picksColor(event))) showCursor(point);
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

// How much of the view's left side the tools panel covers. On phones the
// panel sits below the view instead, and covers none of it.
function coveredOnLeft() {
  // This asks whether the panel floats over the view instead of comparing
  // their edges. At fractional pixel ratios, such as 2.625 on Pixel phones,
  // the view's bottom can come out a rounding error below the top of the
  // panel under it, which looked like the panel covering the whole width.
  if (getComputedStyle(tools).position !== 'fixed') return 0;
  return Math.max(0, tools.getBoundingClientRect().right - viewport.getBoundingClientRect().left);
}

function resize() {
  const { clientWidth: width, clientHeight: height } = viewport;
  renderer.setSize(width, height);
  const halfFit = Math.tan(THREE.MathUtils.degToRad(FIT_FOV / 2));
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfFit / Math.min(width / height, 1)));
  // The solid is fitted to a square across the view's narrower side. The
  // square moves right, toward the middle of the space beside the panel, but
  // only as far as it stays in the view. Fitting the solid into that space
  // instead would shrink it on portrait tablets, where the space is narrow.
  const shift = Math.min(coveredOnLeft(), width - Math.min(width, height)) / 2;
  // The canvas still fills the window, so strokes can reach the panel's
  // edge, but it shows only the right of a wider view centered on the
  // camera's axis.
  camera.setViewOffset(width + 2 * shift, height, 0, 0, width, height);
}
new ResizeObserver(resize).observe(viewport);
resize();

setColor(new THREE.Color(PALETTE[0]), swatches.children[0]);
setTool('paint');
select('cube');

renderer.setAnimationLoop(() => {
  controls.update();
  painter.flush();
  renderer.render(scene, camera);
});
