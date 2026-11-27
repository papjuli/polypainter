// The shapes a stamp can have. Each fits in a circle of radius 1 around its
// center and points up, along y, so that it can be turned to any angle. The
// painter draws them, and main.js the cursor's outlines of them, from the
// same signed distance functions, in SHAPE_DISTANCE below: how far a point is
// outside the shape, or inside it if negative, in units of that radius.
//
// Each shape's `distance` is its GLSL expression in a point `p`, and its
// `icon` the inside of an SVG with the view box -1 -1 2 2, y pointing down.
export const SHAPES = [
  { id: 'star', label: 'Star', distance: 'starDistance(p, 5.0, 0.42)', icon: starIcon(5, 0.42) },
  { id: 'sparkle', label: 'Sparkle', distance: 'starDistance(p, 4.0, 0.3)', icon: starIcon(4, 0.3) },
  {
    id: 'heart',
    label: 'Heart',
    distance: 'heartDistance(p)',
    // The heart below, its arcs ending on opposite sides of each lobe.
    icon: '<path d="M0 1 L0.794 0.206 A0.561 0.561 0 0 0 0 -0.587 A0.561 0.561 0 0 0 -0.794 0.206 Z"/>',
  },
  {
    id: 'flower',
    label: 'Flower',
    distance: 'flowerDistance(p)',
    icon:
      '<circle r="0.5"/>' +
      [0, 1, 2, 3, 4]
        .map((i) => (i * 2 * Math.PI) / 5)
        .map((a) => `<circle cx="${(0.62 * Math.sin(a)).toFixed(3)}" cy="${(-0.62 * Math.cos(a)).toFixed(3)}" r="0.38"/>`)
        .join(''),
  },
  {
    id: 'moon',
    label: 'Moon',
    distance: 'moonDistance(p)',
    // The circles below cross at (0.625, ±0.78).
    icon: '<path d="M0.625 -0.78 A1 1 0 1 0 0.625 0.78 A0.8 0.8 0 1 1 0.625 -0.78 Z"/>',
  },
];

// The index of a shape in shapeDistance(). The brush's round dab is 0.
export const shapeIndex = (id) => SHAPES.findIndex((shape) => shape.id === id) + 1;

export const SHAPE_DISTANCE = /* glsl */ `
  float dot2(vec2 v) {
    return dot(v, v);
  }

  // A star with n points at radius 1, one pointing up, and its inner corners
  // at radius k, after Inigo Quilez's. Folded into the half of a point's
  // sector between the point and an inner corner, the edge between them is
  // the one nearest.
  float starDistance(vec2 p, float n, float k) {
    float an = 3.141592653589793 / n;
    vec2 tip = vec2(cos(an), sin(an));
    vec2 edge = normalize(vec2(tip.x - k, tip.y));
    float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
    p = length(p) * vec2(cos(bn), abs(sin(bn)));
    p -= tip;
    p += edge * clamp(-dot(p, edge), 0.0, tip.y / edge.y);
    return length(p) * sign(p.x);
  }

  // Inigo Quilez's heart, which has its point at the origin and reaches up to
  // y = 1.1, moved and scaled into the circle.
  float heartDistance(vec2 p) {
    const float scale = 0.63;
    p = p * scale + vec2(0.0, scale);
    p.x = abs(p.x);
    float d = p.x + p.y > 1.0
      ? sqrt(dot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0
      : sqrt(min(dot2(p - vec2(0.0, 1.0)), dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
    return d / scale;
  }

  // Five round petals around a round middle.
  float flowerDistance(vec2 p) {
    float d = length(p) - 0.5;
    for (int i = 0; i < 5; i++) {
      float a = float(i) * 2.0 * 3.141592653589793 / 5.0;
      d = min(d, length(p - 0.62 * vec2(sin(a), cos(a))) - 0.38);
    }
    return d;
  }

  // The circle with a bite out of its right side.
  float moonDistance(vec2 p) {
    return max(length(p) - 1.0, 0.8 - length(p - vec2(0.45, 0.0)));
  }

  float shapeDistance(int shape, vec2 p) {
    ${SHAPES.map(({ distance }, i) => `if (shape == ${i + 1}) return ${distance};`).join('\n    ')}
    return length(p) - 1.0;
  }
`;

// The outline of a star like starDistance()'s, as an SVG polygon.
function starIcon(n, k) {
  const points = [];
  for (let i = 0; i < 2 * n; i++) {
    const [angle, radius] = [(i * Math.PI) / n, i % 2 === 0 ? 1 : k];
    points.push(`${(radius * Math.sin(angle)).toFixed(3)},${(-radius * Math.cos(angle)).toFixed(3)}`);
  }
  return `<polygon points="${points.join(' ')}"/>`;
}
