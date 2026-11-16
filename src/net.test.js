import assert from 'node:assert/strict';
import { netOnPage, PAGE_WIDTH, PAGE_HEIGHT } from './net.js';
import { POLYHEDRA } from './polyhedra.js';
import { cutFile } from './cutfile.js';

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6);
// Separating-axis check, independent of the net generator's clearance test.
function overlaps(a, b) {
  return [a, b].every((polygon) => polygon.every((p, i) => {
    const q = polygon[(i + 1) % polygon.length];
    const project = (r) => (q[1] - p[1]) * r[0] - (q[0] - p[0]) * r[1];
    const x = a.map(project), y = b.map(project);
    return Math.min(Math.max(...x), Math.max(...y)) - Math.max(Math.min(...x), Math.min(...y)) > 1e-7;
  }));
}

for (const [id, solid] of POLYHEDRA) {
  const net = netOnPage(solid, { assembly: 'interlocking' });
  const seams = net.tabs.length / 3;
  assert.equal(net.faces.length, solid.faces.length, id);
  assert.equal(net.slits.length, seams * 2, id);
  assert.equal(net.cuts.length, seams * 6, id);
  assert.equal(net.folds.length - seams * 5, solid.edges.length - seams, id);
  assert.ok(net.scale > 0, id);
  const shapes = [...net.faces, ...net.tabs];
  for (const shape of shapes) for (const [x, y] of shape) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), id);
    assert.ok(x >= 16 && x <= PAGE_WIDTH - 16 && y >= 16 && y <= PAGE_HEIGHT - 16, id);
  }
  const corners = [[0, 0], [0, PAGE_HEIGHT - 41], [PAGE_WIDTH - 41, PAGE_HEIGHT - 41]]
    .map(([x,y]) => [[x,y],[x+41,y],[x+41,y+41],[x,y+41]]);
  shapes.forEach((shape, i) => {
    for (const other of [...shapes.slice(i + 1), ...corners]) assert.ok(!overlaps(shape, other), id);
  });
  for (let i = 0; i < seams; i++) {
    const [receiver, ...tongues] = net.tabs.slice(i * 3, i * 3 + 3);
    const length = distance(receiver[0], receiver.at(-1));
    const slits = net.slits.slice(i * 2, i * 2 + 2);
    const bridges = [[receiver[0], slits[0][0]], [slits[0][1], slits[1][0]], [slits[1][1], receiver.at(-1)]];
    for (const [a, b] of bridges) {
      assert.ok(net.folds.some(([c, d]) => distance(a, c) < 1e-6 && distance(b, d) < 1e-6), id);
    }
    tongues.forEach((tongue, j) => {
      const slit = net.slits[2 * i + j];
      near(distance(...slit), length * 0.15);
      near(distance(tongue[0], tongue.at(-1)), length * 0.12);
      near(distance(tongue[1], tongue[4]), length * 0.18);
      // Slits lie exactly on the receiver's base, aligned with the tongues.
      const [a, b] = [receiver[0], receiver.at(-1)];
      const along = (p) => ((b[0] - a[0]) * (p[0] - a[0]) + (b[1] - a[1]) * (p[1] - a[1])) / length;
      const across = (p) => ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / length;
      slit.forEach((p) => near(across(p), 0));
      near(along(slit[0]) / length, [0.35, 0.65][j] - 0.075);
      near(along(slit[1]) / length, [0.35, 0.65][j] + 0.075);
      // No printed fold or cutter perforation may run through an opening.
      for (const fold of net.folds) {
        if (fold.some((p) => Math.abs(across(p)) > 1e-6)) continue;
        const ends = fold.map(along).sort((x, y) => x - y);
        assert.ok(Math.min(ends[1], along(slit[1])) - Math.max(ends[0], along(slit[0])) < 1e-6, id);
      }
    });
  }
}
const cube = POLYHEDRA.get('cube');
assert.deepEqual(netOnPage(cube), netOnPage(cube, { assembly: 'glue' }));
assert.equal(netOnPage(cube).slits.length, 0);
assert.throws(() => netOnPage(cube, { assembly: 'unknown' }));
const dxf = cutFile({folds: [], cuts: [[[10,10],[20,10]]], slits: [[[1,2],[3,2]]]}, []);
assert.ok(dxf.indexOf('10\n1\n20\n2\n') < dxf.indexOf('10\n10\n20\n10\n'));
console.log('Passed: all 22 interlocking nets, clearances, page fit, paired dimensions, edge slits and fold bridges, glue defaults, and DXF slit order.');
