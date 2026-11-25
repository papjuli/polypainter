import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { cutFile } from './cutfile.js';
import { modelFile } from './model.js';
import { PIXELS_PER_MM, drawNet, findHoles } from './net.js';
import { BASE_COLOR, Painter, createAtlasLayout } from './painter.js';
import { setPixelsPerMeter } from './png.js';
import { POLYHEDRA, atTurn, faceAt, toFaceCoordinates } from './polyhedra.js';
import { symmetryGroups } from './symmetry.js';
import './style.css';

const PALETTE = ['#1d1d1f', '#b23a2e', '#e08a3c', '#e9c46a', '#5a8f4e', '#2a9d8f', '#2f6690', '#7a4e9a'];
// How many custom colors the memo under the swatches keeps: one row of them.
const RECENT_COLOR_COUNT = 10;
// Where the memo is saved, so the colors are still there on the next visit.
const RECENT_COLORS_KEY = 'polypainter.recentColors';
// Brush radius per step of the size slider, in world units (the solids have
// a circumradius of 1).
const BRUSH_RADIUS_STEP = 0.004;
// Radius of the rings marking where a bucket fill starts.
const FILL_CURSOR_RADIUS = 0.02;
// Brightness of the solid's inside, which shows through transparent paint,
// relative to its outside.
const INSIDE_BRIGHTNESS = 0.6;
// Seconds a kaleidocycle takes to turn all the way round when played, showing
// each of its four sides for a quarter of that.
const TURN_PERIOD = 12;

const viewport = document.getElementById('viewport');
const tools = document.querySelector('.tools');
const picker = document.getElementById('solid-picker');
const stats = document.getElementById('solid-stats');
const hint = document.getElementById('hint');
const resetButton = document.getElementById('reset-view');
const symmetrySelect = document.getElementById('symmetry');
const symmetryNote = document.getElementById('symmetry-note');
const turnField = document.getElementById('turn-field');
const turnSlider = document.getElementById('turn');
const playButton = document.getElementById('play-turn');
const toolPicker = document.getElementById('tool-picker');
const swatches = document.getElementById('swatches');
const transparentSwatch = document.getElementById('transparent-color');
const customColor = document.getElementById('custom-color');
const recentSwatches = document.getElementById('recent-colors');
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
const aboutDialog = document.getElementById('about-dialog');
const aboutBody = document.getElementById('about-body');

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

// The solid's mesh and edge lines, and `place`, which moves their corners to
// new vertices, as a kaleidocycle turns. The texture coordinates stay put,
// since a face's coordinates don't change as it moves.
function createSolid(polyhedron, layout) {
  const { vertices, faces, edges } = polyhedron;

  // Each polygonal face is split into a triangle fan from its first vertex.
  const corners = [];
  const faceUVs = [];
  faces.forEach((face, f) => {
    for (let i = 1; i < face.length - 1; i++) {
      for (const index of [face[0], face[i], face[i + 1]]) {
        corners.push(index);
        faceUVs.push(...layout.uv(f, vertices[index]));
      }
    }
  });
  const faceGeometry = new THREE.BufferGeometry();
  faceGeometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.length * 3, 3));
  faceGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(faceUVs, 2));

  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edges.length * 6, 3));

  function place(vertices) {
    const facePositions = faceGeometry.getAttribute('position');
    corners.forEach((index, k) => facePositions.setXYZ(k, ...vertices[index].toArray()));
    facePositions.needsUpdate = true;
    faceGeometry.computeVertexNormals();
    // The raycaster skips meshes whose bounds the pointer misses.
    faceGeometry.computeBoundingSphere();
    const edgePositions = edgeGeometry.getAttribute('position');
    edges.forEach(([a, b], k) => {
      edgePositions.setXYZ(2 * k, ...vertices[a].toArray());
      edgePositions.setXYZ(2 * k + 1, ...vertices[b].toArray());
    });
    edgePositions.needsUpdate = true;
    edgeGeometry.computeBoundingSphere();
  }
  place(vertices);

  const mesh = new THREE.Mesh(faceGeometry, faceMaterial);
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  const object = new THREE.Group();
  object.add(mesh, edgeLines);
  object.visible = false;
  return { object, mesh, edgeLines, place };
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
      group: groups.find((group) => group.preferred),
      history: [],
      redoStack: [],
      // How far a kaleidocycle has turned, from 0 to 1. Other solids stay at 0.
      turn: 0,
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

// Each copy goes where its symmetry takes the point's face coordinates. Not
// all of a kaleidocycle's symmetries are motions of it in space.
function showCursor(point) {
  const { group } = current.painting;
  const surface = painter.surface();
  const face = faceAt(surface, point);
  const [x, y] = toFaceCoordinates(surface.faceFrames[face], point);
  cursorScale.setScalar(tool === 'fill' ? FILL_CURSOR_RADIUS : brushRadius());
  group.elements.forEach(({ faceMaps }, i) => {
    const { face: image, xx, xy, yx, yy } = faceMaps[face];
    const { center, right, up, normal } = surface.faceFrames[image];
    const position = center
      .clone()
      .addScaledVector(right, xx * x + xy * y)
      .addScaledVector(up, yx * x + yy * y)
      .addScaledVector(normal, 0.002);
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
  symmetrySelect.replaceChildren(...groups.map((g) => new Option(g.label, g.id, false, g === group)));
  describeSymmetry();
  turnField.hidden = !polyhedron.ring;
  setPlaying(false);
  showTurn();
  updateHistoryButtons();
  hideCursor();
}

// Moves the current solid to its painting's turn.
function showTurn() {
  const { polyhedron, turn } = current.painting;
  current.place(atTurn(polyhedron, turn).vertices);
  turnSlider.value = turn;
}

let playing = false;
let lastFrame = null;

function setPlaying(play) {
  playing = play;
  lastFrame = null;
  playButton.textContent = play ? 'Pause' : 'Play';
  playButton.setAttribute('aria-pressed', String(play));
}

// Turns the kaleidocycle on by the time since the last frame.
function playTurn(time) {
  if (lastFrame !== null) {
    const painting = current.painting;
    painting.turn = (painting.turn + (time - lastFrame) / 1000 / TURN_PERIOD) % 1;
    showTurn();
    // The rings would stay where the brush was before the solid moved.
    hideCursor();
  }
  lastFrame = time;
}

playButton.addEventListener('click', () => setPlaying(!playing));
turnSlider.addEventListener('input', () => {
  setPlaying(false);
  current.painting.turn = Number(turnSlider.value);
  showTurn();
  hideCursor();
});

function describeSymmetry() {
  const { group } = current.painting;
  symmetryNote.textContent =
    group.order === 1
      ? 'Strokes are not repeated.'
      : `${group.order} copies · ${group.reflections ? 'rotations and reflections' : 'rotations only'}`
        //  + ` · orbifold ${group.orbifold}`;
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
let selectedSwatch = null;

function setColor(color, swatch) {
  brushColor = color;
  selectedSwatch = swatch;
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

// The memo of custom colors, most recently used first, as lowercase hex like
// the color input's value. Storage can be missing or blocked, as in some
// private windows, and then the memo lasts only until the page is closed.
let recentColors = [];
try {
  const saved = JSON.parse(localStorage.getItem(RECENT_COLORS_KEY));
  if (Array.isArray(saved)) {
    recentColors = saved.filter((hex) => /^#[0-9a-f]{6}$/.test(hex)).slice(0, RECENT_COLOR_COUNT);
  }
} catch {
  // Start with an empty memo.
}

// A remembered color goes back into the custom color, rather than selecting
// its own swatch, so the memo can reorder without moving the selection, and
// the color picker opens on it, ready to be adjusted.
function showRecentColors() {
  recentSwatches.replaceChildren(
    ...recentColors.map((hex) => {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'swatch';
      swatch.style.background = hex;
      swatch.setAttribute('aria-label', `Recent color ${hex}`);
      swatch.addEventListener('click', () => {
        customColor.value = hex;
        setColor(new THREE.Color(hex), customColor);
      });
      return swatch;
    }),
  );
  recentSwatches.hidden = recentColors.length === 0;
}

// The custom color, if that is what the brush holds, or else null.
const customBrushColor = () => (selectedSwatch === customColor ? customColor.value : null);

// Moves a color to the front of the memo. This happens only once it has been
// painted with, so colors merely tried out in the picker don't crowd out the
// ones in use. It waits for the end of a stroke, because on phones the memo's
// first row makes the view shorter, which would move the solid under the
// finger mid-stroke.
function rememberColor(hex) {
  if (hex === null) return;
  recentColors = [hex, ...recentColors.filter((other) => other !== hex)].slice(0, RECENT_COLOR_COUNT);
  try {
    localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(recentColors));
  } catch {
    // Keep the memo for this visit only.
  }
  showRecentColors();
}

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
// The custom color the current stroke paints with, kept for the memo.
let strokeCustomColor = null;

function runCommand(command) {
  if (strokePointer !== null) return;
  command();
  updateHistoryButtons();
}

undoButton.addEventListener('click', () => runCommand(() => painter.undo()));
redoButton.addEventListener('click', () => runCommand(() => painter.redo()));
clearButton.addEventListener('click', () => runCommand(() => painter.clear()));

window.addEventListener('keydown', (event) => {
  // The painting behind a dialog stays as it is while the dialog is open, so
  // the net exports what the user saw, and nothing changes out of sight.
  if (exportDialog.open || aboutDialog.open || !(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'z' && !event.shiftKey) runCommand(() => painter.undo());
  else if (key === 'y' || (key === 'z' && event.shiftKey)) runCommand(() => painter.redo());
  else return;
  event.preventDefault();
});

// The About dialog opens at the top, or at the explanation of the symmetry
// groups when opened from the link under the Symmetry menu.
function showAbout(section) {
  aboutDialog.showModal();
  if (section) section.scrollIntoView({ block: 'start' });
  else aboutBody.scrollTop = 0;
}
document.getElementById('about').addEventListener('click', () => showAbout());
document
  .getElementById('about-symmetry-link')
  .addEventListener('click', () => showAbout(document.getElementById('about-symmetry')));

// A click on the backdrop closes the About dialog. Its contents fill it, so
// only the backdrop's clicks reach the dialog element itself. A press that
// starts inside, such as selecting text and letting go outside, doesn't count.
let pressedOnBackdrop = false;
aboutDialog.addEventListener('pointerdown', (event) => {
  pressedOnBackdrop = event.target === aboutDialog;
});
aboutDialog.addEventListener('click', (event) => {
  if (pressedOnBackdrop && event.target === aboutDialog) aboutDialog.close();
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
  // Kaleidocycles only have glue nets.
  const glueOnly = Boolean(current.painting.polyhedron.ring);
  document.getElementById('assembly-field').hidden = glueOnly;
  document.getElementById('glue-only').hidden = !glueOnly;
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
  const { polyhedron, layout } = current.painting;
  const assembly = polyhedron.ring ? 'glue' : document.getElementById('assembly-method').value;
  const includeCutter = document.getElementById('export-cutter').checked;
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
    // A kaleidocycle is exported as it stands now.
    const { polyhedron, layout, turn } = current.painting;
    const atlas = painter.toCanvas();
    const hasHoles = painter.hasTransparentPaint;
    const png = await new Promise((resolve) => atlas.toBlob(resolve));
    if (!png) throw new Error('Could not create the texture image.');
    const glb = modelFile(atTurn(polyhedron, turn), layout, new Uint8Array(await png.arrayBuffer()), {
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
    // A stroke is painted on the solid as it stands, so a kaleidocycle stops
    // turning to be painted.
    setPlaying(false);
    if (tool === 'fill') {
      runCommand(() => painter.bucketFill(point, { group: current.painting.group, color: brushColor }));
      rememberColor(customBrushColor());
      showCursor(point);
      return;
    }
    strokePointer = event.pointerId;
    strokeCustomColor = tool === 'erase' ? null : customBrushColor();
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
  rememberColor(strokeCustomColor);
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
showRecentColors();
setTool('paint');
select('cube');

renderer.setAnimationLoop((time) => {
  if (playing) playTurn(time);
  controls.update();
  painter.flush();
  renderer.render(scene, camera);
});
