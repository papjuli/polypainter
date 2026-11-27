# PolyPainter

Paint on the Platonic, Archimedean and Catalan solids, on stellated ones and
on kaleidocycles, with symmetry, in the spirit of
*M.C. Escher Kaleidocycles* by Doris Schattschneider and Wallace Walker: every
stroke is repeated over the whole surface by a symmetry group of the solid.
Built with [three.js](https://threejs.org) and [Vite](https://vite.dev).

Try it here: **https://papjuli.github.io/polypainter/**.

## Using it

- Pick a solid from the toolbar: the five Platonic solids, the 13 Archimedean
  solids, their duals the 13 Catalan solids, an available stellated polyhedron,
  or a kaleidocycle of six, eight or ten tetrahedra.
  Then pick a symmetry group.
  Each solid offers the polyhedral groups it has, for example on the cube:
  none, T, Td, Th, O and Oh. The default is the solid's rotation group, as in
  Escher's designs.
- A kaleidocycle turns through its own middle, showing four sides in turn.
  Drag the Turn slider or press Play to turn it, and paint the faces as they
  come into view. Its symmetry groups follow the motion: Around the ring, the
  default, repeats strokes on every other tetrahedron and leaves the four
  sides free for four different pictures; Every half turn and Every quarter
  turn make two or all four of them alike; Every face puts a copy on every
  face, without or with mirror images.
<!-- - About, beside the title, describes the families of solids and explains the
  symmetry groups: what makes a symmetry, how many copies each group makes,
  rotations against reflections, which solids offer which groups, and what
  the Schoenflies and orbifold names mean. A diagram shows how the groups
  contain one another and which of them each Platonic solid has; pointing at
  a solid lights up its groups. The link under the Symmetry menu opens it at
  the groups. -->
- Drag on the solid to paint; strokes carry on across edges and corners. Rings
  show where the brush and all of its copies will land.
- Check Pointy ends to paint strokes that come to a point at both ends. The end
  of a stroke comes to its point when you let go. A short flick makes a leaf
  shape, and a click still makes a round dot. Erasing always has round ends.
- With the Line tool, drag to paint a straight line from where you press to
  the pointer. It is straight along the surface, so it bends where it crosses an edge, and it tries to follow the
  pointer around a corner on the side you went. Repeated by the symmetry,
  lines weave into bands and stars around the solid.
- With the Stamp tool, click to stamp a star, sparkle, heart, flower or moon,
  repeated by the symmetry like a stroke. A stamp stands upright on the screen,
  turned by the Angle slider, and its copies are turned and mirrored the way
  the symmetry moves them; the cursor outlines all of them. A stamp folds over
  edges like a sticker, so over a corner, where the faces don't lie flat, a
  wedge of it goes missing. With the transparent color, it cuts a hole in the
  shape.
- With the Fill tool, click to fill the area of the color under the pointer,
  along with its symmetric copies. Fills spread across edges like strokes.
- The checkered swatch paints and fills transparently, cutting holes through
  which the inside of the solid shows. Paint over a hole to close it again.
- With the Pick tool, click on the solid to take up the color painted there,
  as it was painted. Clicking a hole picks transparent paint. Then the tool
  goes back to painting, drawing lines, stamping or filling. Alt+click
  (Option+click on a Mac) picks a color with the Paint, Line, Stamp, Fill and
  Erase tools too.
- Custom colors you paint or fill with are remembered in a row under the
  swatches, the most recent first, up to ten of them, and kept for your next
  visit. Click one to make it the custom color again.
- Drag around the solid, or right-drag, to rotate it; scroll or pinch to zoom.
  The Rotate tool makes every drag rotate.
- Undo and redo with the buttons or Ctrl+Z / Ctrl+Shift+Z. Each solid keeps its
  own painting.
- Ctrl+S (Cmd+S on a Mac) saves a screenshot: a 2048 × 2048 PNG of the solid
  as you see it, centered, on a transparent background. The brush rings are
  left out.
- Export net opens a menu to choose glue tabs or rectangular tabs
  that assemble without glue. The
  painted solid downloads on an A4 page as a PNG to print at 100% scale. Cut
  along solid lines and fold along dashed ones. For rectangular tabs, cut the
  slit at the base of the wide tab, fold both tabs
  inward, and tuck the rectangular tab through the slit.
  Paper thickness affects the fit, so try a joint before assembling the solid.
  Transparent areas are left blank. The optional DXF cutter file contains
  the lines to cut for a cutting machine: the outline, holes where the paint
  is transparent, and perforated folds, with a frame the size of the page.
  Where a solid can't be unfolded in one piece with room for every connector,
  the net comes in a few pieces. Rectangular tabs need more room, so with them
  most solids come in several pieces. A kaleidocycle comes as the usual strip
  of triangles, a row for each tetrahedron, with glue tabs only, as turning it
  pulls on its seams. Roll the strip into a tube, glued down its side, and
  then glue the ends of the tube together into a ring.
- To print and cut with Silhouette Studio, place the PNG on an A4 page and the
  DXF over it, lined up by its frame. Ungroup the DXF and delete the frame. The
  net keeps clear of the corners where the registration marks go.
- Export 3D model downloads the painted solid as a glTF file (.glb), with the
  paint as its texture, for Blender and other 3D apps. In Blender, open it
  with File → Import → glTF 2.0 and switch the viewport to Material Preview
  (Z) to see the paint, which the default Solid view leaves out. The solid's
  outermost corners lie 1 m from its center, and holes from transparent
  paint stay see-through. A kaleidocycle comes out as it stands, turned as
  far as it is in the app. Each face comes in as a separate piece, since it
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
npm test         # check the nets, 3D models, kaleidocycles, stamps, lines and fills of all solids
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
  each face of a Platonic solid or the rhombic dodecahedron, or sink one into
  it. Each face gets a 2D
  coordinate frame, and a list of the faces across its edges. All the solids
  but the kaleidocycles are star-shaped around their center, which is how a
  point is put onto the surface; on a kaleidocycle it goes to the nearest
  point.
- `src/kaleidocycles.js` builds the kaleidocycles: rings of tetrahedra whose
  hinges, opposite edges at right angles, are a quarter turn apart around the
  ring, alternately one way and the other. As a ring turns, the angles at its
  hinges take turns between two values, θ and φ, with
  cos(θ/2) cos(φ/2) = cos(2π/N) for N tetrahedra, which puts it in place at
  any turn. Each hinge has four faces, two from each tetrahedron, and each
  face is joined to the face of the other tetrahedron across the gap from it.
  Around every corner the faces add up to a full turn, so laid flat the
  surface is a parallelogram of triangles whose opposite sides join up.
- `src/symmetry.js` finds each solid's full symmetry group, the matrices that
  take its vertices to its vertices, and the named subgroups it contains. A
  kaleidocycle's groups come from its turns about its axis, the quarter of
  its motion after which it has the same shape again, moved along by one
  tetrahedron, and the symmetries of its surface laid flat, which are found
  face by face across the edges.
- `src/painter.js` keeps the paint in a texture atlas with one cell per face. A
  dab paints where a small ball meets the surface, and is drawn once for every
  element of the chosen group. On a kaleidocycle, whose surface lies flat
  around every corner, dabs and strokes go on the surface laid flat instead,
  as on its paper: there a hinge's faces are glued in pairs, so paint on one
  side of a hinge stays off the two faces behind it. Strokes are stored, so the
  texture can be redrawn for undo and when switching solids, each at the turn a
  kaleidocycle stood at when it was painted. Each dab of a stroke keeps its own
  radius, which shrinks toward a pointy stroke's ends, with the dabs closer
  together there. The end of a stroke is only known once you let go, so then
  the painter puts back a copy of the texture from before the stroke and draws
  the stroke again, tapered at both ends. A straight line is followed across
  the edges it crosses, each face laid flat beside the one before. There may
  be more than one straight line to the pointer, around a corner either way,
  so of those found beside the line drawn a moment before, the one that turns
  least from it is kept. The line is drawn again from the copy of the texture
  whenever the pointer moves, and kept as a stroke. A stamp is laid flat across the edges
  it comes near on every solid, as kaleidocycles are painted, because a ball is
  the only shape every edge cuts the same way; it is drawn into each face's
  cell turned, and mirrored, as the face's map takes it. The texture keeps its alpha premultiplied,
  so the edges of transparent paint blend as cleanly as those of colors. The
  Pick tool reads its color from the texture, not from the rendered scene.
- `src/shapes.js` defines the stamps' shapes as signed distance functions in
  GLSL, the distance from a point to the shape's edge, which the painter draws
  the stamps with and the cursor their outlines, and an SVG icon of each for
  its button.
- `src/fill.js` flood fills the texture atlas, stepping from a face's cell to
  its neighbor's where the fill reaches an edge. The pixels at the soft edge of
  a stroke beside the fill hold some of the color filled over, so the fill
  replaces just that share of them with its own color, leaving no halo. A fill
  is stored as the runs of pixels it covers and the new colors of those at its
  edge.
- `tools/unfold.py` unfolds a solid by growing the net across the edges of
  its faces, leaving out faces that would overlap it or leave no room for a
  tab, which start further pieces. Every cut edge gets a tab. A kaleidocycle
  is laid out as a strip instead: its surface lies flat around every corner,
  so its faces make a patch of a grid of triangles. It tries a few
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


## Deployment

Pushing to `main` builds the site and publishes it to GitHub Pages via
`.github/workflows/deploy.yml`. In the repository's **Settings → Pages**, set
**Source** to **GitHub Actions** once to enable it.
