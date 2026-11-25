# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

PolyPainter is a browser app (three.js + Vite, plain JavaScript ES modules, no framework) for painting on Platonic, Archimedean, Catalan and stellated solids, where every stroke is repeated by a chosen symmetry group of the solid. The painted solid exports as a printable A4 net (PNG) and an optional DXF cut file. README.md describes the user-facing behavior and has a per-module "How it works" summary.

## Commands

```sh
npm install
npm run dev        # Vite dev server
npm run build      # production build into dist/
npm run preview    # serve the production build
npm test           # node src/net.test.js && node src/model.test.js && node src/fill.test.js
```

`npm test` runs three plain Node scripts using `node:assert`. There is no test runner, linter or formatter. `src/net.test.js` checks that the saved nets in `src/nets/` still match the faces built by `src/polyhedra.js`, fit the page without overlaps, and have well-formed tabs and slits, and that DXF slits stay straight. `src/model.test.js` checks the glTF export of every solid: file framing, triangle winding, and texture coordinates. `src/fill.test.js` checks that a bucket fill of every unpainted solid, at the atlas size the app uses, reaches every pixel of every face and cell margin, that a fill stops at a band painted around the solid, and that a fill beside a soft edge blends into it without leaving a halo of the old color; it takes several seconds.

Nets are laid out ahead of time in Python (3.9+, standard library only; it also calls `node`). Use the venv:

```sh
python3 -m venv .venv
.venv/bin/python tools/build_nets.py                # all solids (under a minute, uses all cores)
.venv/bin/python tools/build_nets.py cube octahedron  # only the named solid ids
.venv/bin/python tools/build_nets.py --draw-only    # re-draw previews from saved nets
```

Run it as a script from the repo root: the tools import each other as top-level modules (`from unfold import ...`). It writes `src/nets/<id>.json` (committed) and unpainted previews to `previews/` (gitignored). The unfolding uses a seeded RNG, so unchanged inputs produce identical JSON.

Pushing to `main` deploys to GitHub Pages via `.github/workflows/deploy.yml`. `vite.config.js` sets `base: './'` so the build works from a subpath.

## Architecture

### Face coordinates hold it all together

Everything is built on the faces produced by `src/polyhedra.js`:
- Every solid is scaled so its farthest vertex is at distance 1, and placed in one shared orientation, so all of its symmetries lie in the `OCTAHEDRAL` or `ICOSAHEDRAL` matrix groups from `src/groups.js`. Every solid is also star-shaped around the origin, which is how `faceAt` and `projectToSurface` find the face under a point.
- Face vertex indices run counter-clockwise when seen from outside. Each face has a `faceFrame` (`center`, `normal`, `right`, `up`, with `up` pointing toward the midpoint of the face's first edge). `toFaceCoordinates` gives the 2D coordinates of a point in that frame.
- Face index `f` means the same face everywhere: `polyhedron.faces[f]`, atlas cell `layout.cells[f]`, a symmetry element's `faceMaps[f]`, and a saved net's `placements[f]` and `faces[f]`.
- Face coordinates are what the rest of the code maps between. The atlas maps them to texels (`originX/originY + density × (x, y)`). A symmetry element's `faceMaps[f]` gives the image face plus a 2×2 matrix in face coordinates (`src/symmetry.js`). A net placement maps them onto the page in mm.

**Changing `src/polyhedra.js` in any way that alters faces, vertex order or face frames invalidates the saved nets.** Re-run `tools/build_nets.py` and commit the new JSON. `npm test` fails until you do. The same applies after changing `tools/unfold.py`.

To add a solid, add an entry to `DEFINITIONS` in `src/polyhedra.js` (a convex `seed` + `group`, the `dual` of a solid defined before it, or a stellation `base` + `spike`). Duals start each face's vertex list at a corner chosen by `startAtCorner`, so faces related by a rotation get identical face coordinates and share one atlas cell shape; keep that if you add other solids with irregular faces. Then run `build_nets.py <id>` and commit the new `src/nets/<id>.json`. The app picker, symmetry options and tests all pick it up from `POLYHEDRA`.

### Painting (`src/painter.js`, `src/main.js`)

- Each solid has its own `painting` (`polyhedron`, `layout`, `groups`, `group`, `history`, `redoStack`), created in `main.js`. A single `Painter` renders whichever painting is loaded into a `WebGLRenderTarget` atlas with one cell per face.
- **The history is the source of truth. The texture is only a rendering of it.** Undo, switching solids and `load()` all redraw by replaying actions after the last `clear`. The action types are `stroke` (sampled surface points + group/color/radius), `bucket` (pixel runs from `src/fill.js`, plus the new colors of the soft-edge pixels it blends into, which the painter writes as single-pixel points) and `clear`.
- A dab paints a ball meeting the surface. It is projected onto every face plane it touches and then repeated through `group.elements[*].faceMaps`. Dabs are queued as instanced quads and drawn in `flush()`, which the render loop calls every frame and which `readPixels`/`drawBucket` call first.
- The texture stores **premultiplied alpha**. A color of `null` means transparent paint, which uses different blending, so it is batched separately. `main.js` patches the material's `map_fragment` to un-premultiply, and `toCanvas()` un-premultiplies for 2D canvas use.
- The atlas is bottom-row-first (GL convention). Cells have a `CELL_MARGIN` so texture filtering at edges doesn't pick up unpainted texels.

### Net export pipeline

```
src/polyhedra.js ──(tools/solids.mjs via node)──▶ tools/build_nets.py
    ├─ tools/unfold.py     unfold, add tabs, fit to A4  ─▶ src/nets/<id>.json  { glue, interlocking }
    └─ tools/draw_nets.py  SVG/PDF previews             ─▶ previews/
src/main.js  lazily imports src/nets/<id>.json (import.meta.glob) on first export
    ├─ src/net.js drawNet()   paints faces from painter.toCanvas() ─▶ PNG (src/png.js adds pHYs for 100% print)
    └─ src/net.js findHoles() + src/contours.js marching squares ─▶ src/cutfile.js ─▶ DXF
```

- Net JSON fields: `scale`, `placements` (`{xx,xy,yx,yy,x,y}` per face), `faces`, `folds`, `cuts`, `slits`, `printSlits`, `tabs`, all in mm with the origin at the page's bottom-left. `net.js` flips y for the canvas.
- Interlocking nets: `slits` are the straight cuts used in the DXF. `printSlits` add short end marks that appear only on the PNG. Each seam has a pair of `tabs`: a glue-tab-shaped receiver followed by a small rectangular tab.
- Layout constraints from `unfold.py`: 16 mm page margin, three 41 mm corner squares kept clear for Silhouette registration marks, and edges at most 50 mm (`MAX_EDGE`). Faces that would overlap the net, or leave no room for a tab, start further pieces. For glue nets that includes a face closing a seam in a slot too narrow for a tab (`seams_have_room`), which happens around corners whose face angles add up to nearly 360°. A net with a seam left tabless is rejected. As a last resort, every face becomes its own piece.
- The PNG downloads before the DXF, so a cut-file failure doesn't lose the PNG.

### 3D model export (`src/model.js`)

The "Export 3D model" button (outside the net dialog) downloads a binary glTF (`.glb`) for Blender. `modelFile()` writes each face's corners with `layout.uv` and embeds `painter.toCanvas()` as the PNG texture. That canvas has atlas row 0 on top, which is where glTF's UV origin is, so UVs are not flipped. The file deliberately has no normals, so readers shade every face flat; with normals, Blender's importer marks some faces smooth through float rounding. Alpha `MASK` is used only when `painter.hasTransparentPaint`, and the roughness, metalness and cutoff come from the app's `faceMaterial`.

`tools/lamp_shade.py` is a Blender script, not part of the venv tooling: `blender --python tools/lamp_shade.py -- <file.glb>`. It hangs an exported solid in a closed room with a small point light at its center (every solid is star-shaped around it), so Cycles throws the alpha-clipped holes onto the walls. To check it without opening a window, add `--background` and a `--python-expr` that calls `bpy.ops.render.render(write_still=True)`.

### Constants duplicated across JS and Python

There is no shared config. Keep these in sync by hand:
- Page size and `LINE_WIDTH` (`src/net.js` ↔ `tools/unfold.py`, `tools/draw_nets.py`).
- Line/tab colors and fold dashes (`src/net.js` ↔ `tools/draw_nets.py`). `FACE_COLOR` in `draw_nets.py` mirrors `BASE_COLOR` in `src/painter.js`.
- The margin (16), corner size (41) and max edge (50) are hard-coded again in `src/net.test.js`.

## Conventions

- Comments are full plain-English sentences that explain why, and so is the README. Match that tone and keep the README's "How it works" section current when module responsibilities change.
- Commit subjects are short and imperative ("Lay out the nets ahead of time in Python").
