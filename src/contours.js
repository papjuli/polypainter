// Where the outline crosses the sides of a square of grid points, by which of
// its corners are inside, as bits: top left, top right, bottom right, bottom
// left. Each pair of letters is a piece of outline from one side (top, right,
// bottom or left) to another.
const CROSSINGS = ['', 'TL', 'TR', 'LR', 'RB', 'TL RB', 'TB', 'LB', 'LB', 'TB', 'TR LB', 'RB', 'LR', 'TR', 'TL', ''];

// Traces the outlines of the regions where a grid of values is over a half,
// by marching squares. `values` holds `width` × `height` values row by row,
// those along the edges under a half, so that every outline closes. Returns
// each outline as a polygon in grid coordinates.
export function traceOutlines(values, width, height) {
  // Each crossing of the outline with a side between two grid points is keyed
  // by the first point's index, doubled, plus one for a vertical side, and
  // joined to the crossings before and after it on the outline.
  const joins = new Map();
  const join = (a, b) => {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      const list = joins.get(from);
      if (list) list.push(to);
      else joins.set(from, [to]);
    }
  };
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i = y * width + x;
      const a = values[i];
      const b = values[i + 1];
      const c = values[i + width + 1];
      const d = values[i + width];
      const corners = (a > 0.5) | ((b > 0.5) << 1) | ((c > 0.5) << 2) | ((d > 0.5) << 3);
      if (corners === 0 || corners === 15) continue;
      // With two opposite corners inside, the middle decides whether they connect.
      const connected = (corners === 5 || corners === 10) && (a + b + c + d) / 4 > 0.5;
      const sides = { T: 2 * i, R: 2 * i + 3, B: 2 * (i + width), L: 2 * i + 1 };
      for (const [from, to] of CROSSINGS[connected ? 15 - corners : corners].split(' ')) join(sides[from], sides[to]);
    }
  }

  const crossing = (key) => {
    const i = key >> 1;
    const j = key & 1 ? i + width : i + 1;
    const t = (0.5 - values[i]) / (values[j] - values[i]);
    const [x, y] = [i % width, Math.floor(i / width)];
    return key & 1 ? [x, y + t] : [x + t, y];
  };
  const outlines = [];
  // Follows each outline round, using up its crossings.
  for (const start of joins.keys()) {
    const outline = [];
    let [previous, current] = [-1, start];
    do {
      const [a, b] = joins.get(current);
      joins.delete(current);
      outline.push(crossing(current));
      [previous, current] = [current, a === previous ? b : a];
    } while (current !== start);
    outlines.push(outline);
  }
  return outlines;
}

// Leaves out the points of a polygon within `tolerance` of the lines between
// the points kept, by the Douglas–Peucker algorithm.
export function simplify(polygon, tolerance) {
  const points = [...polygon, polygon[0]];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop();
    const [[ax, ay], [bx, by]] = [points[first], points[last]];
    const length = Math.hypot(bx - ax, by - ay);
    let [farthest, distance] = [-1, tolerance];
    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      const d =
        length > 0 ? Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / length : Math.hypot(px - ax, py - ay);
      if (d > distance) [farthest, distance] = [i, d];
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return polygon.filter((_, i) => keep[i]);
}

// A polygon's area, positive when it runs counter-clockwise.
export function area(polygon) {
  return (
    polygon.reduce((sum, [x, y], i) => {
      const [nx, ny] = polygon[(i + 1) % polygon.length];
      return sum + x * ny - nx * y;
    }, 0) / 2
  );
}
