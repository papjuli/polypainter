# PolyPainter

Paint on the Platonic, Archimedean and Catalan solids and on stellated ones,
with symmetry, in the spirit of
*M.C. Escher Kaleidocycles* by Doris Schattschneider and Wallace Walker: every
stroke is repeated over the whole surface by a symmetry group of the solid.
Built with [three.js](https://threejs.org) and [Vite](https://vite.dev).

## Using it

- Pick a solid from the toolbar: the five Platonic solids, the 13 Archimedean
  solids, their duals the 13 Catalan solids, or the stellated octahedron,
  small stellated dodecahedron, great dodecahedron and great stellated
  dodecahedron. Then pick a symmetry group.
  Each solid offers the polyhedral groups it has, for example on the cube:
  none, T, Td, Th, O and Oh. The default is the solid's rotation group, as in
  Escher's designs.
<!-- - About, beside the title, describes the families of solids and explains the
  symmetry groups: what makes a symmetry, how many copies each group makes,
  rotations against reflections, which solids offer which groups, and what
  the Schoenflies and orbifold names mean. A diagram shows how the groups
  contain one another and which of them each Platonic solid has; pointing at
  a solid lights up its groups. The link under the Symmetry menu opens it at
  the groups. -->
- Drag on the solid to paint; strokes carry on across edges and corners. Rings
  show where the brush and all of its copies will land.
- With the Fill tool, click to fill the area of the color under the pointer,
  along with its symmetric copies. Fills spread across edges like strokes.
- The checkered swatch paints and fills transparently, cutting holes through
  which the inside of the solid shows. Paint over a hole to close it again.
- With the Pick tool, click on the solid to take up the color painted there,
  as it was painted rather than as lighting shows it. Clicking a hole picks
  transparent paint. Then the tool goes back to painting or filling. Alt+click
  (Option+click on a Mac) picks a color with the Paint, Fill and Erase tools
  too.
- Drag around the solid, or right-drag, to rotate it; scroll or pinch to zoom.
  The Rotate tool makes every drag rotate.
- Undo and redo with the buttons or Ctrl+Z / Ctrl+Shift+Z. Each solid keeps its
  own painting.
- Export net opens a menu to choose original glue tabs or rectangular tabs
  that assemble without glue, and whether to include the cutter file. The
  painted solid downloads on an A4 page as a PNG to print at 100% scale. Cut
  along solid lines and fold along dashed ones. For rectangular tabs, each
  matching edge pair has one tab shaped like a glue tab and one small
  rectangular tab. Cut the slit at the base of the wide tab, fold both tabs
  inward, and tuck the rectangular tab through the slit. The PNG also shows
  short cuts into the tab at both slit ends; the cutter file keeps each slit
  straight.
  Paper thickness affects the fit, so try a joint before assembling the solid.
  Transparent areas are left blank. The optional DXF contains
  the lines to cut for a cutting machine: the outline, holes where the paint
  is transparent, and perforated folds, with a frame the size of the page.
  Where a solid can't be unfolded in one piece with room for every connector,
  the net comes in a few pieces. With glue tabs, this happens only for the
  great dodecahedron, great stellated dodecahedron, triakis icosahedron and
  disdyakis triacontahedron. Around some of the triakis icosahedron's
  corners, the faces' angles add up to so nearly a full turn that the last
  two faces leave no room for a tab between them, so its net comes in ten
  pieces. Rectangular tabs need more room, so with them most solids come in
  several pieces.
- To print and cut with Silhouette Studio, place the PNG on an A4 page and the
  DXF over it, lined up by its frame. Ungroup the DXF and delete the frame. The
  net keeps clear of the corners where the registration marks go.
- Export 3D model downloads the painted solid as a glTF file (.glb), with the
  paint as its texture, for Blender and other 3D apps. In Blender, open it
  with File → Import → glTF 2.0 and switch the viewport to Material Preview
  (Z) to see the paint, which the default Solid view leaves out. The solid's
  outermost corners lie 1 m from its center, and holes from transparent
  paint stay see-through. Each face comes in as a separate piece, since it
  has its own part of the texture. To join them, select everything in Edit
  Mode and use Mesh → Clean Up → Merge by Distance, then Limited Dissolve to
  turn the triangles back into the solid's faces.
- To light up an exported solid as a lamp shade, run the script in `tools/`
  with Blender:

  ```sh
  blender --python tools/lamp_shade.py -- polypainter-cube.glb
  ```

  It hangs the solid from the ceiling of a dark room with a bulb inside, so
  light shines out through the holes cut by transparent paint and throws
  them onto the walls. Blender opens looking through the camera at the room
  as it renders; press F12 for a finished image.

## Development

```sh
npm install
npm run dev      # start the dev server
npm run build    # production build in dist/
npm test         # check the nets and 3D models of all solids
```

The nets are laid out ahead of time in Python and saved in `src/nets/`, so
the app only draws them. After changing the solids or the layout, lay them
out again with Python 3.9 or later. It needs only the standard library, and
Node, which it runs to read the solids:

```sh
python3 -m venv .venv
.venv/bin/python tools/build_nets.py        # all solids, in under a minute
.venv/bin/python tools/build_nets.py cube   # or only the ones named
```

It also draws the nets, unpainted, to look at or print: each one as an SVG
image and an A4 PDF in `previews/`, and all of them in `previews/nets.pdf`.
`--draw-only` draws the saved nets again without laying them out.

## How it works

- `src/groups.js` builds the octahedral and icosahedral symmetry groups as
  matrices. All solids are placed so that their symmetries are among them.
- `src/polyhedra.js` builds the solids. The Platonic and Archimedean ones are
  the images of one vertex under their symmetry group, with their faces found
  as the planes that have all the vertices on one side. The Catalan solids are
  the Archimedean ones' duals, with a vertex at the pole of each face's plane
  and a face around each vertex. The stellated ones put a pyramid on
  each face of a Platonic solid, or sink one into it. Each face gets a 2D
  coordinate frame. All the solids are star-shaped around their center, which
  is how a point is put onto the surface.
- `src/symmetry.js` finds each solid's full symmetry group, the matrices that
  take its vertices to its vertices, and the named subgroups it contains.
- `src/painter.js` keeps the paint in a texture atlas with one cell per face. A
  dab paints where a small ball meets the surface, and is drawn once for every
  element of the chosen group. Strokes are stored, so the texture can be redrawn
  for undo and when switching solids. The texture keeps its alpha premultiplied,
  so the edges of transparent paint blend as cleanly as those of colors. The
  Pick tool reads its color from the texture, not from the rendered scene.
- `tools/unfold.py` unfolds a solid by growing the net across the edges of
  its faces, leaving out faces that would overlap it or leave no room for a
  tab, which start further pieces. Every cut edge gets a tab. It tries a few
  orders and keeps the net that comes out largest on the page, with tabs as
  tall as fit, turned and scaled to fill the page, but with edges no longer
  than 50 mm. `tools/build_nets.py` runs it for every solid and
  assembly method, with the faces read from `src/polyhedra.js` by
  `tools/solids.mjs`, saves each solid's nets in `src/nets/`, and draws them
  with `tools/draw_nets.py`.
- `src/net.js` draws a saved net, painting each face from the texture atlas.
  The app loads a solid's nets when it is first exported.
- `src/cutfile.js` writes a net's cut and fold lines as a DXF file, and
  `src/png.js` sets the PNG's pixel size so it prints at the size of the page.
  The holes are traced from the net drawn on the page, by marching squares in
  `src/contours.js`.
- `src/model.js` writes the painted solid as a binary glTF file: the corners
  of each face with their places in the texture atlas, split into
  triangles, and the atlas as a PNG image, clipped where the paint is
  transparent.
- `src/fill.js` flood fills the texture atlas, stepping from a face's cell to
  its neighbor's where the fill reaches an edge. A fill is stored as the runs
  of pixels it covers.

## Deployment

Pushing to `main` builds the site and publishes it to GitHub Pages via
`.github/workflows/deploy.yml`. In the repository's **Settings → Pages**, set
**Source** to **GitHub Actions** once to enable it.
