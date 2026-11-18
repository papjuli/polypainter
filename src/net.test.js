import assert from 'node:assert/strict';
import { netOnPage, PAGE_WIDTH, PAGE_HEIGHT } from './net.js';
import { POLYHEDRA } from './polyhedra.js';
import { cutFile } from './cutfile.js';

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6);
const edgeCoordinates = ([a, b], p) => {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const lengthSq = dx * dx + dy * dy;
  return [
    (dx * (p[0] - a[0]) + dy * (p[1] - a[1])) / lengthSq,
    (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / lengthSq,
  ];
};
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
  const seams = net.tabs.length / 2;
  assert.equal(net.faces.length, solid.faces.length, id);
  assert.ok(Number.isInteger(seams) && seams > 0, id);
  assert.equal(net.slits.length, seams, id);
  assert.equal(net.printSlits.length, seams, id);
  assert.equal(net.cuts.length, seams * 4, id);
  assert.equal(net.folds.length - seams * 3, solid.edges.length - seams, id);
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
  const edges = net.faces.flatMap((face, f) => face.map((p, k) => ({
    f, k, side: [p, face[(k + 1) % face.length]],
  })));
  for (let i = 0; i < seams; i++) {
    const [receiver, outline] = net.tabs.slice(i * 2, i * 2 + 2);
    const slit = net.printSlits[i];
    assert.equal(slit.length, 4, id);
    const [leftEnd, leftBase, rightBase, rightEnd] = slit;
    assert.deepEqual(net.slits[i], [leftBase, rightBase], id);
    assert.equal(outline.length, 4, id);
    const [a, b, c, d] = outline;
    const width = distance(a, d), depth = distance(a, b);
    near(distance(b, c), width);
    near(distance(c, d), depth);
    near((b[0] - a[0]) * (d[0] - a[0]) + (b[1] - a[1]) * (d[1] - a[1]), 0);
    assert.ok(net.folds.some(([p, q]) => distance(a, p) < 1e-6 && distance(d, q) < 1e-6), id);

    // Find the tab's original edge, then follow its vertex IDs to the
    // matching face. This checks that its slit is on the correct seam.
    const source = edges.find(({ side }) => [a, d].every((p) => {
      const [u, v] = edgeCoordinates(side, p);
      return u > 0 && u < 1 && Math.abs(v) < 1e-6;
    }));
    assert.ok(source, id);
    const edge = solid.faces[source.f];
    const start = edge[source.k], end = edge[(source.k + 1) % edge.length];
    const target = edges.find(({ f, k }) => solid.faces[f][k] === end &&
      solid.faces[f][(k + 1) % solid.faces[f].length] === start);
    assert.ok(target, id);
    const length = distance(...source.side);
    assert.ok(width <= length * 0.3 && depth <= length * 0.15, id);
    near(edgeCoordinates(source.side, a)[0] + edgeCoordinates(source.side, d)[0], 1);
    assert.ok(edgeCoordinates(source.side, b)[1] < 0, id);
    const slitWidth = distance(leftBase, rightBase);
    assert.ok(slitWidth > width && slitWidth < width * 1.15, id);
    const [[u, v], [x, y]] = [leftBase, rightBase].map((p) => edgeCoordinates(target.side, p));
    near(u + x, 1);
    near(v, 0);
    near(y, 0);

    // The receiver has the same full-edge trapezoid shape as a glue tab.
    assert.equal(receiver.length, 4, id);
    near(distance(receiver[0], target.side[0]), 0);
    near(distance(receiver.at(-1), target.side[1]), 0);
    const [[left, height], [right, top]] = receiver.slice(1, 3)
      .map((p) => edgeCoordinates(target.side, p));
    near(height, top);
    assert.ok(left > 0 && left < right && right < 1 && height < 0 && height >= -0.15 - 1e-6, id);

    // Each end turns perpendicular into the receiver tab, staying clear of
    // its outline even when the tab is shallow. No cut enters the face.
    const [[endU, endV], [endX, endY]] = [leftEnd, rightEnd]
      .map((p) => edgeCoordinates(target.side, p));
    near(endU, u);
    near(endX, x);
    near(endV, endY);
    assert.ok(endV < 0 && -endV <= Math.min(0.03, -height / 4) + 1e-6, id);
    receiver.forEach((p, k) => {
      assert.ok([leftEnd, rightEnd].every((q) =>
        edgeCoordinates([p, receiver[(k + 1) % receiver.length]], q)[1] > 1e-6), id);
    });

    // Only the bridges beside the slit fold. A full fold across the base
    // would perforate the opening when exporting the cutter file.
    for (const [a, b] of [[receiver[0], leftBase], [rightBase, receiver.at(-1)]]) {
      assert.ok(net.folds.some(([p, q]) => distance(a, p) < 1e-6 && distance(b, q) < 1e-6), id);
    }
    for (const fold of net.folds) {
      const points = fold.map((p) => edgeCoordinates(target.side, p));
      if (points.some(([, v]) => Math.abs(v) > 1e-6)) continue;
      const [start, end] = points.map(([u]) => u).sort((a, b) => a - b);
      assert.ok(Math.min(end, x) - Math.max(start, u) < 1e-6, id);
    }
  }
}
const cube = POLYHEDRA.get('cube');
assert.deepEqual(netOnPage(cube), netOnPage(cube, { assembly: 'glue' }));
assert.equal(netOnPage(cube).slits.length, 0);
assert.equal(netOnPage(cube).printSlits.length, 0);
assert.throws(() => netOnPage(cube, { assembly: 'unknown' }));
const dxf = cutFile({
  folds: [], cuts: [[[10,10],[20,10]]],
  slits: [[[1,2],[3,2]]],
  printSlits: [[[1,2.5],[1,2],[3,2],[3,2.5]]],
}, []);
assert.ok(dxf.indexOf('10\n1\n20\n2\n') < dxf.indexOf('10\n10\n20\n10\n'));
const slitPath = dxf.slice(dxf.indexOf('0\nPOLYLINE\n'), dxf.indexOf('0\nSEQEND\n'));
assert.equal((slitPath.match(/0\nVERTEX\n/g) ?? []).length, 2);
assert.ok(slitPath.includes('10\n1\n20\n2\n') && slitPath.includes('10\n3\n20\n2\n'));
assert.ok(!dxf.includes('20\n2.5000\n'));
console.log('Passed: all 22 paired-tab nets, clearances, page fit, rectangular tabs with glue-shaped receivers, PNG-only slit ends, fold bridges, glue defaults, and straight DXF slits.');
