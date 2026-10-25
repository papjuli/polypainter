import { PAGE_HEIGHT, PAGE_WIDTH } from './net.js';

// Folds are perforated, cut in short dashes with long gaps between them, so
// they fold cleanly. Lengths in mm.
const FOLD_CUT = 1;
const FOLD_GAP = 4;
// Ends of cut lines nearer than this, in mm, are joined up.
const JOIN_DISTANCE = 1e-3;
// Each kind of line has a layer and a color, as an AutoCAD color number, so
// the cutter's software can tell them apart.
const LAYER_COLORS = { CUT: 7, FOLD: 5, PAGE: 8 };

// Joins lines that meet end to end into paths, so the outline of the net is
// cut in one go. Returns each path's points, and whether it closes up.
function joinUp(lines) {
  const near = ([ax, ay], [bx, by]) => Math.hypot(ax - bx, ay - by) < JOIN_DISTANCE;
  const remaining = [...lines];
  const paths = [];
  while (remaining.length > 0) {
    const path = [...remaining.pop()];
    for (;;) {
      const end = path.at(-1);
      const i = remaining.findIndex((line) => near(line[0], end) || near(line.at(-1), end));
      if (i === -1) break;
      const [line] = remaining.splice(i, 1);
      path.push(...(near(line[0], end) ? line : line.toReversed()).slice(1));
    }
    const closed = path.length > 2 && near(path[0], path.at(-1));
    paths.push({ points: closed ? path.slice(0, -1) : path, closed });
  }
  return paths;
}

// The dashes perforating a fold, spread evenly along it with a gap at either
// end, so they stay clear of the corners.
function perforate([[ax, ay], [bx, by]]) {
  const length = Math.hypot(bx - ax, by - ay);
  const count = Math.max(Math.round((length - FOLD_GAP) / (FOLD_CUT + FOLD_GAP)), 0);
  const gap = (length - count * FOLD_CUT) / (count + 1);
  const at = (distance) => [ax + ((bx - ax) * distance) / length, ay + ((by - ay) * distance) / length];
  return Array.from({ length: count }, (_, i) => {
    const start = gap + i * (FOLD_CUT + gap);
    return [at(start), at(start + FOLD_CUT)];
  });
}

// Writes the lines to cut out a net placed on the page as a DXF file, in mm:
// the outlines of `holes`, polygons where the paint is transparent, the net's
// outline, perforations along its folds, and a frame around the whole page,
// by which the lines can be lined up with the printed page.
export function cutFile({ folds, cuts }, holes) {
  const groups = [];
  const entity = (type, layer, ...values) => groups.push(0, type, 8, layer, 62, LAYER_COLORS[layer], ...values);
  const polyline = (layer, points, closed) => {
    entity('POLYLINE', layer, 66, 1, 70, closed ? 1 : 0, 10, 0, 20, 0, 30, 0);
    for (const [x, y] of points) groups.push(0, 'VERTEX', 8, layer, 10, x, 20, y, 30, 0);
    groups.push(0, 'SEQEND', 8, layer);
  };

  // Holes come first, so that they are cut while the net is still held in
  // place by the paper around it.
  for (const hole of holes) polyline('CUT', hole, true);
  for (const { points, closed } of joinUp(cuts)) polyline('CUT', points, closed);
  for (const fold of folds) {
    for (const [[ax, ay], [bx, by]] of perforate(fold)) {
      entity('LINE', 'FOLD', 10, ax, 20, ay, 30, 0, 11, bx, 21, by, 31, 0);
    }
  }
  const page = [
    [0, 0],
    [PAGE_WIDTH, 0],
    [PAGE_WIDTH, PAGE_HEIGHT],
    [0, PAGE_HEIGHT],
  ];
  polyline('PAGE', page, true);

  // DXF files are lists of group codes, each followed by its value, one per
  // line. This is the AutoCAD R12 format, which cutters' software reads.
  const file = [
    ...[0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC'],
    ...[0, 'SECTION', 2, 'ENTITIES', ...groups, 0, 'ENDSEC'],
    ...[0, 'EOF'],
  ];
  return file.map((value) => (Number.isInteger(value) || typeof value === 'string' ? value : value.toFixed(4))).join('\n') + '\n';
}
