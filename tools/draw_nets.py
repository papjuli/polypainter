"""Draws the nets that tools/build_nets.py lays out, to look at or print, as
SVG images and as PDFs of A4 pages, with only the standard library.

They are drawn as src/net.js draws them for the PNG, at the same size and with
the same lines, but with the faces unpainted, and with a caption at the top of
the page naming the solid and its tabs.
"""

from __future__ import annotations

import zlib
from collections.abc import Iterable, Sequence
from xml.sax.saxutils import escape

from unfold import PAGE_HEIGHT, PAGE_WIDTH, Polygon

# As in src/net.js, in mm.
LINE_WIDTH = 0.3
FOLD_DASHES = (2.4, 1.8)
FOLD_OPACITY = 0.5
LINE_COLOR = '#1d1d1f'
TAB_COLOR = '#dedad2'
# Unpainted faces, BASE_COLOR in src/painter.js.
FACE_COLOR = '#f3efe6'
# The caption's size and baseline, in mm from the bottom of the page. It fits
# in the top margin, between the corners kept clear for registration marks.
CAPTION_SIZE = 3.5
CAPTION_BASELINE = PAGE_HEIGHT - 10
TABS = {'glue': 'glue tabs', 'interlocking': 'rectangular tabs'}

# Points per mm, for PDF.
POINTS_PER_MM = 72 / 25.4
# Helvetica's widths of the characters from space to ~, in thousandths of the
# font size, to center the caption in a PDF.
HELVETICA = (
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    *(556,) * 10, 278, 278, 584, 584, 584, 556, 1015,
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833,
    722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
    278, 278, 278, 469, 556, 333,
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
    556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
    334, 260, 334, 584,
)
MIDDLE_DOT_WIDTH = 278


def caption(name: str, assembly: str) -> str:
    return f'{name} · {TABS[assembly]}'


def number(value: float) -> str:
    """A length in mm, to the micrometer, without trailing zeros."""
    text = f'{value:.3f}'.rstrip('0').rstrip('.')
    return '0' if text == '-0' else text


def svg(net: dict, title: str) -> str:
    """An SVG image of a net on its page, the size of the page."""

    def path(lines: Iterable[Polygon], close: bool = False) -> str:
        # The image's y axis points down.
        return ' '.join(
            'M' + ' L'.join(f'{number(x)} {number(PAGE_HEIGHT - y)}' for x, y in line) + ' Z' * close
            for line in lines
        )

    # Each fold is a path of its own, so the dashes start at its end, and
    # where folds overlap they darken as in the PNG.
    folds = ''.join(f'<path d="{path([fold])}"/>' for fold in net['folds'])
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_WIDTH}mm" height="{PAGE_HEIGHT}mm" '
        f'viewBox="0 0 {PAGE_WIDTH} {PAGE_HEIGHT}">\n'
        f'<title>{escape(title)}</title>\n'
        f'<rect width="{PAGE_WIDTH}" height="{PAGE_HEIGHT}" fill="#fff"/>\n'
        f'<path fill="{TAB_COLOR}" d="{path(net["tabs"], True)}"/>\n'
        # The faces are filled as one, so no seams show between them.
        f'<path fill="{FACE_COLOR}" d="{path(net["faces"], True)}"/>\n'
        f'<g fill="none" stroke="{LINE_COLOR}" stroke-width="{LINE_WIDTH}" '
        f'stroke-linecap="round" stroke-linejoin="round">\n'
        f'<path d="{path(net["cuts"] + net["printSlits"])}"/>\n'
        f'<g stroke-dasharray="{" ".join(map(str, FOLD_DASHES))}" stroke-opacity="{FOLD_OPACITY}">{folds}</g>\n'
        f'</g>\n'
        f'<text x="{number(PAGE_WIDTH / 2)}" y="{number(PAGE_HEIGHT - CAPTION_BASELINE)}" text-anchor="middle" '
        f'font-family="Helvetica, Arial, sans-serif" font-size="{CAPTION_SIZE}" fill="{LINE_COLOR}">'
        f'{escape(title)}</text>\n'
        f'</svg>\n'
    )


def pdf_string(text: str) -> str:
    return '(' + text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)') + ')'


def rgb(color: str) -> str:
    return ' '.join(number(int(color[i:i + 2], 16) / 255) for i in (1, 3, 5))


def text_width(text: str) -> float:
    return CAPTION_SIZE * sum(
        MIDDLE_DOT_WIDTH if c == '·' else HELVETICA[ord(c) - 32] for c in text
    ) / 1000


def page_content(net: dict, title: str) -> bytes:
    """The drawing operators for a net's page, in mm from its bottom left."""

    def path(lines: Iterable[Polygon], close: bool = False) -> list[str]:
        return [
            ' '.join(f'{number(x)} {number(y)} {"l" if i else "m"}' for i, (x, y) in enumerate(line))
            + ' h' * close
            for line in lines
        ]

    ops = [f'{POINTS_PER_MM:.9f} 0 0 {POINTS_PER_MM:.9f} 0 0 cm']
    if net['tabs']:
        ops += [f'{rgb(TAB_COLOR)} rg', *path(net['tabs'], True), 'f']
    ops += [f'{rgb(FACE_COLOR)} rg', *path(net['faces'], True), 'f']
    ops += [f'{rgb(LINE_COLOR)} RG {LINE_WIDTH} w 1 J 1 j']
    if lines := net['cuts'] + net['printSlits']:
        ops += [*path(lines), 'S']
    ops += [f'q /Fold gs [{" ".join(map(str, FOLD_DASHES))}] 0 d', *(fold + ' S' for fold in path(net['folds'])), 'Q']
    x = PAGE_WIDTH / 2 - text_width(title) / 2
    ops += [f'{rgb(LINE_COLOR)} rg BT /F1 {CAPTION_SIZE} Tf {number(x)} {number(CAPTION_BASELINE)} Td '
            f'{pdf_string(title)} Tj ET']
    return '\n'.join(ops).encode('cp1252')


def pdf(pages: Sequence[tuple[dict, str]], title: str) -> bytes:
    """A PDF of A4 pages, one for each net and its caption, with a bookmark
    for each page."""
    objects: list[bytes] = []

    def add(body: str | bytes = b'') -> int:
        objects.append(body.encode('cp1252') if isinstance(body, str) else body)
        return len(objects)

    catalog, tree, outlines = add(), add(), add()
    font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    fold = add(f'<< /Type /ExtGState /CA {FOLD_OPACITY} >>')
    info = add(f'<< /Title {pdf_string(title)} /Producer (tools/draw_nets.py) >>')
    size = f'{number(PAGE_WIDTH * POINTS_PER_MM)} {number(PAGE_HEIGHT * POINTS_PER_MM)}'
    kids = []
    for net, caption_text in pages:
        stream = zlib.compress(page_content(net, caption_text), 9)
        contents = add(b'<< /Length %d /Filter /FlateDecode >>\nstream\n' % len(stream) + stream + b'\nendstream')
        kids.append(add(
            f'<< /Type /Page /Parent {tree} 0 R /MediaBox [0 0 {size}] /Contents {contents} 0 R '
            f'/Resources << /Font << /F1 {font} 0 R >> /ExtGState << /Fold {fold} 0 R >> >> >>'
        ))
    marks = list(range(len(objects) + 1, len(objects) + 1 + len(kids)))
    for i, (page, (_, caption_text)) in enumerate(zip(kids, pages)):
        links = (f' /Prev {marks[i - 1]} 0 R' if i else '') + (f' /Next {marks[i + 1]} 0 R' if i + 1 < len(marks) else '')
        add(f'<< /Title {pdf_string(caption_text)} /Parent {outlines} 0 R{links} /Dest [{page} 0 R /Fit] >>')
    objects[catalog - 1] = f'<< /Type /Catalog /Pages {tree} 0 R /Outlines {outlines} 0 R /PageMode /UseOutlines >>'.encode()
    objects[tree - 1] = f'<< /Type /Pages /Kids [{" ".join(f"{k} 0 R" for k in kids)}] /Count {len(kids)} >>'.encode()
    objects[outlines - 1] = (
        f'<< /Type /Outlines /First {marks[0]} 0 R /Last {marks[-1]} 0 R /Count {len(marks)} >>'.encode()
        if marks else b'<< /Type /Outlines /Count 0 >>'
    )

    out = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % i + body + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objects) + 1)
    out += b''.join(b'%010d 00000 n \n' % offset for offset in offsets)
    out += b'trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (
        len(objects) + 1, catalog, info, xref)
    return bytes(out)
