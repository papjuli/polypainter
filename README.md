# PolyPainter

Paint on the Platonic and Archimedean solids and on stellated ones, with
symmetry, in the spirit of
*M.C. Escher Kaleidocycles* by Doris Schattschneider and Wallace Walker: every
stroke is repeated over the whole surface by a symmetry group of the solid.
Built with [three.js](https://threejs.org) and [Vite](https://vite.dev).

## Using it

- Pick a solid from the toolbar: the five Platonic solids, the 13 Archimedean
  solids, or the stellated octahedron, small stellated dodecahedron, great
  dodecahedron and great stellated dodecahedron. Then pick a symmetry group.
  Each solid offers the polyhedral groups it has, for example on the cube:
  none, T, Td, Th, O and Oh. The default is the solid's rotation group, as in
  Escher's designs.
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
- Export net downloads the painted solid unfolded on an A4 page, with glue
  tabs, as a PNG to print, cut out along the solid lines and fold along the
  dashed ones. Transparent areas are left blank. It also downloads a DXF of
  the lines to cut for a cutting machine: the outline, holes where the paint
  is transparent, and perforated folds, with a frame the size of the page.
  Where a solid can't be unfolded in one piece with room for every glue tab,
  as with the great dodecahedron and great stellated dodecahedron, the net
  comes in a few pieces.
- To print and cut with Silhouette Studio, place the PNG on an A4 page and the
  DXF over it, lined up by its frame. Ungroup the DXF and delete the frame. The
  net keeps clear of the corners where the registration marks go.

## Development

```sh
npm install
npm run dev      # start the dev server
npm run build    # production build in dist/
```

## How it works

- `src/groups.js` builds the octahedral and icosahedral symmetry groups as
  matrices. All solids are placed so that their symmetries are among them.
- `src/polyhedra.js` builds the solids. The convex ones are the images of one
  vertex under their symmetry group, with their faces found as the planes
  that have all the vertices on one side. The stellated ones put a pyramid on
  each face of a Platonic solid, or sink one into it. Each face gets a 2D
  coordinate frame. All the solids are star-shaped around their center, which
  is how a point is put onto the surface.
- `src/symmetry.js` finds each solid's full symmetry group, the matrices that
  take its vertices to its vertices, and the named subgroups it contains.
- `src/painter.js` keeps the paint in a texture atlas with one cell per face. A
  dab paints where a small ball meets the surface, and is drawn once for every
  element of the chosen group. Strokes are stored, so the texture can be redrawn
  for undo and when switching solids. The texture keeps its alpha premultiplied,
  so the edges of transparent paint blend as cleanly as those of colors.
- `src/net.js` unfolds a solid by growing the net across the edges of its
  faces, leaving out faces that would overlap it or leave no room for a tab,
  which start further pieces. It tries a few orders and keeps the net that
  comes out largest on the page, with tabs as tall as fit. It turns and scales
  the net to fill the page, and draws each face from the texture atlas.
- `src/cutfile.js` writes a net's cut and fold lines as a DXF file, and
  `src/png.js` sets the PNG's pixel size so it prints at the size of the page.
  The holes are traced from the net drawn on the page, by marching squares in
  `src/contours.js`.
- `src/fill.js` flood fills the texture atlas, stepping from a face's cell to
  its neighbor's where the fill reaches an edge. A fill is stored as the runs
  of pixels it covers.

## Deployment

Pushing to `main` builds the site and publishes it to GitHub Pages via
`.github/workflows/deploy.yml`. In the repository's **Settings → Pages**, set
**Source** to **GitHub Actions** once to enable it.
