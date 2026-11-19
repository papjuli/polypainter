"""Lays out the nets of the solids ahead of time, for the app to load, and
draws them to look at or print.

Run it again after changing the solids in src/polyhedra.js or the layout in
tools/unfold.py, for all solids or just the ones named:

    .venv/bin/python tools/build_nets.py [solid id ...]

It writes src/nets/<id>.json for each solid, holding the solid's net placed
on an A4 page for each assembly method. It draws each of those nets as
previews/<id>-<assembly>.svg and .pdf, and all of them in previews/nets.pdf.
With --draw-only, it only draws the saved nets again.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from draw_nets import caption, pdf, svg
from unfold import ASSEMBLIES, Solid, net_on_page

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'src' / 'nets'
PREVIEW_DIR = ROOT / 'previews'


def load_solids() -> list[Solid]:
    """Reads the solids from src/polyhedra.js, so the faces match the app's."""
    output = subprocess.run(
        ['node', str(ROOT / 'tools' / 'solids.mjs')], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout
    return [Solid.from_json(solid) for solid in json.loads(output)]


def lay_out(solid: Solid, assembly: str) -> tuple[str, str, dict, int, float]:
    start = time.perf_counter()
    net = net_on_page(solid, assembly)
    return solid.id, assembly, net.to_json(), net.pieces, time.perf_counter() - start


def draw(solids: list[Solid], chosen: list[Solid]) -> None:
    """Draws the saved nets of the chosen solids, and those of all the solids
    in one PDF, in the app's order."""
    PREVIEW_DIR.mkdir(exist_ok=True)
    drawn = {solid.id for solid in chosen}
    pages = []
    for solid in solids:
        nets = json.loads((OUT_DIR / f'{solid.id}.json').read_text())
        for assembly in ASSEMBLIES:
            title = caption(solid.name, assembly)
            pages.append((nets[assembly], title))
            if solid.id in drawn:
                path = PREVIEW_DIR / f'{solid.id}-{assembly}'
                path.with_suffix('.svg').write_text(svg(nets[assembly], title))
                path.with_suffix('.pdf').write_bytes(pdf([(nets[assembly], title)], title))
    (PREVIEW_DIR / 'nets.pdf').write_bytes(pdf(pages, 'PolyPainter nets'))
    print(f'Drew {len(chosen) * len(ASSEMBLIES)} nets in {PREVIEW_DIR.relative_to(ROOT)}/, '
          f'and all {len(pages)} in {PREVIEW_DIR.relative_to(ROOT)}/nets.pdf')


def main() -> None:
    parser = argparse.ArgumentParser(description='Lay out the nets of the solids for the app to load, and draw them.')
    parser.add_argument('ids', nargs='*', metavar='id', help='solids to lay out, all of them by default')
    parser.add_argument('--draw-only', action='store_true', help='only draw the saved nets again')
    args = parser.parse_args()

    solids = load_solids()
    unknown = sorted(set(args.ids) - {solid.id for solid in solids})
    if unknown:
        parser.error(f'unknown solids: {", ".join(unknown)}')
    chosen = [solid for solid in solids if not args.ids or solid.id in args.ids]

    if not args.draw_only:
        nets: dict[str, dict[str, dict]] = {solid.id: {} for solid in chosen}
        with ProcessPoolExecutor() as pool:
            jobs = [pool.submit(lay_out, solid, assembly) for solid in chosen for assembly in ASSEMBLIES]
            for job in as_completed(jobs):
                solid_id, assembly, net, pieces, seconds = job.result()
                nets[solid_id][assembly] = net
                print(f'{solid_id} {assembly}: {pieces} piece{"s" * (pieces != 1)}, '
                      f'scale {net["scale"]:.2f}, {seconds:.1f}s', flush=True)

        OUT_DIR.mkdir(exist_ok=True)
        for solid_id, by_assembly in nets.items():
            data = {assembly: by_assembly[assembly] for assembly in ASSEMBLIES}
            (OUT_DIR / f'{solid_id}.json').write_text(json.dumps(data, separators=(',', ':')) + '\n')
        print(f'Wrote {len(nets)} files to {OUT_DIR.relative_to(ROOT)}/')
    draw(solids, chosen)


if __name__ == '__main__':
    main()
