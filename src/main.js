import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { POLYHEDRA } from './polyhedra.js';
import './style.css';

const viewport = document.getElementById('viewport');
const picker = document.getElementById('solid-picker');
const stats = document.getElementById('solid-stats');
const resetButton = document.getElementById('reset-view');

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
controls.saveState();

const faceMaterial = new THREE.MeshStandardMaterial({
  color: 0x5b8def,
  flatShading: true,
  roughness: 0.55,
  metalness: 0.05,
  // Push faces back slightly so the edge lines drawn on top don't flicker.
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1,
});
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xe8ecf4 });

function createSolid(polyhedron) {
  const { vertices, faces, edges } = polyhedron;

  // Each polygonal face is split into a triangle fan from its first vertex.
  const facePositions = [];
  for (const face of faces) {
    for (let i = 1; i < face.length - 1; i++) {
      for (const index of [face[0], face[i], face[i + 1]]) {
        facePositions.push(...vertices[index].toArray());
      }
    }
  }
  const faceGeometry = new THREE.BufferGeometry();
  faceGeometry.setAttribute('position', new THREE.Float32BufferAttribute(facePositions, 3));
  faceGeometry.computeVertexNormals();

  const edgePositions = edges.flatMap(([a, b]) => [...vertices[a].toArray(), ...vertices[b].toArray()]);
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));

  const group = new THREE.Group();
  group.add(new THREE.Mesh(faceGeometry, faceMaterial));
  group.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
  group.visible = false;
  return group;
}

const solids = new Map();
for (const polyhedron of POLYHEDRA) {
  const solid = createSolid(polyhedron);
  solids.set(polyhedron.id, solid);
  scene.add(solid);

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = polyhedron.name;
  button.dataset.id = polyhedron.id;
  button.addEventListener('click', () => select(polyhedron.id));
  picker.appendChild(button);
}

function select(id) {
  const polyhedron = POLYHEDRA.find((p) => p.id === id);
  for (const [solidId, solid] of solids) solid.visible = solidId === id;
  for (const button of picker.children) {
    button.setAttribute('aria-pressed', String(button.dataset.id === id));
  }
  stats.textContent =
    `${polyhedron.faces.length} faces · ` +
    `${polyhedron.edges.length} edges · ` +
    `${polyhedron.vertices.length} vertices`;
}

resetButton.addEventListener('click', () => controls.reset());

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

select('cube');

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
