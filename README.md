# PolyPainter

Paint on the five Platonic solids with symmetry, in the spirit of
*M.C. Escher Kaleidocycles* by Doris Schattschneider and Wallace Walker: every
stroke is repeated over the whole surface by a symmetry group of the solid.
Built with [three.js](https://threejs.org) and [Vite](https://vite.dev).

## Using it

- Pick a solid from the toolbar, then a symmetry group. Each solid offers the
  polyhedral groups it has, for example on the cube: none, T, Td, Th, O and Oh.
  The default is the solid's rotation group, as in Escher's designs.
- Drag on the solid to paint; strokes carry on across edges and corners. Rings
  show where the brush and all of its copies will land.
- With the Fill tool, click to fill the area of the color under the pointer,
  along with its symmetric copies. Fills spread across edges like strokes.
- The checkered swatch paints and fills transparently, cutting holes through
  which the inside of the solid shows. Paint over a hole to close it again.
- Drag around the solid, or right-drag, to rotate it; scroll or pinch to zoom.
  The Rotate tool makes every drag rotate.
- Undo and redo with the buttons or Ctrl+Z / Ctrl+Shift+Z. Each solid keeps its
  own painting.
- Export net downloads the painted solid unfolded as a PNG, with glue tabs, to
  print, cut out along the solid lines and fold along the dashed ones.
  Transparent areas are left blank.

## Development

```sh
npm install
npm run dev      # start the dev server
npm run build    # production build in dist/
```

## How it works

- `src/polyhedra.js` builds the solids from their vertex coordinates and gives
  each face a 2D coordinate frame.
- `src/symmetry.js` finds each solid's full symmetry group (one symmetry per
  flag) and the named subgroups it contains.
- `src/painter.js` keeps the paint in a texture atlas with one cell per face. A
  dab paints where a small ball meets the surface, and is drawn once for every
  element of the chosen group. Strokes are stored, so the texture can be redrawn
  for undo and when switching solids. The texture keeps its alpha premultiplied,
  so the edges of transparent paint blend as cleanly as those of colors.
- `src/net.js` unfolds a solid along a spanning tree of its faces, adds glue
  tabs where they fit, and draws each face from the texture atlas.
- `src/fill.js` flood fills the texture atlas, stepping from a face's cell to
  its neighbor's where the fill reaches an edge. A fill is stored as the runs
  of pixels it covers.

## Deployment

Pushing to `main` builds the site and publishes it to GitHub Pages via
`.github/workflows/deploy.yml`. In the repository's **Settings → Pages**, set
**Source** to **GitHub Actions** once to enable it.
