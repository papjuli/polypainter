"""Unfolds the solids into nets and places them on an A4 page.

tools/build_nets.py runs this ahead of time and saves the nets for the app,
which draws them with the painting and writes the cutter file.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import atan2, cos, fmod, hypot, inf, pi, sin, tan
from typing import Any, Callable, NamedTuple

Point = tuple[float, float]
Polygon = list[Point]

ASSEMBLIES = ('glue', 'interlocking')

# The page, A4 portrait, in mm with the origin at its bottom left corner, as
# in src/net.js.
PAGE_WIDTH = 210
PAGE_HEIGHT = 297
# Silhouette Studio's print and cut wants the edges of the page clear, and
# the top left, top right and bottom left corners for its registration marks.
# These leave the room its default marks take, with some to spare.
PAGE_MARGIN = 16
CORNER_SIZE = 41
# Bisection steps when fitting a net onto the page, and the positions tried
# across the page in each direction at each step.
FIT_STEPS = 20
FIT_POSITIONS = 9
# The longest an edge may come out, in mm. The simplest solids would fill the
# page with much longer edges than the rest; this gives the tetrahedron,
# octahedron and cube the same edges, a little longer than the next largest.
MAX_EDGE = 50

# Nets tried for each solid, the one coming out largest on the page winning,
# and the most attempts at finding them in one piece.
UNFOLDINGS = 12
UNFOLD_ATTEMPTS = 300

# Glue tabs are trapezoids on one side of every cut edge, TAB_HEIGHT times as
# tall as the edge is long. The gap between the faces at the end of an edge
# can be narrow, so their sides rise from the edge at a shallower angle where
# they have to, which makes them lower, leaving their tops TAB_TOP times as
# long as the edge.
TAB_HEIGHT = 0.15
TAB_TOP = 0.2
# The angles tried at the two ends of a tab, steepest first.
TAB_ANGLES = [
    (a * pi / 180, b * pi / 180)
    for a, b in sorted(
        ((a, b) for a in (30, 20, 10, 5) for b in (30, 20, 10, 5)),
        key=lambda angles: (-min(angles), -max(angles)),
    )
]
# The width of the printed lines, in mm, as in src/net.js.
LINE_WIDTH = 0.3
EPSILON = 1e-6

# The net keeps a line width further from the edges and corners, as printed
# lines reach past its outline by half their width, and faces are drawn a
# pixel larger.
FIT_MARGIN = PAGE_MARGIN + LINE_WIDTH
FIT_CORNER_SIZE = CORNER_SIZE + LINE_WIDTH


def square(left: float, bottom: float, size: float) -> Polygon:
    return [(left, bottom), (left + size, bottom), (left + size, bottom + size), (left, bottom + size)]


MARK_CORNERS = [
    square(0, PAGE_HEIGHT - FIT_CORNER_SIZE, FIT_CORNER_SIZE),
    square(PAGE_WIDTH - FIT_CORNER_SIZE, PAGE_HEIGHT - FIT_CORNER_SIZE, FIT_CORNER_SIZE),
    square(0, 0, FIT_CORNER_SIZE),
]

# The positions tried for a net at each scale, as fractions of the room it
# has to move across the page, nearest the middle first.
FIT_GRID = sorted(
    (((i % FIT_POSITIONS) / (FIT_POSITIONS - 1), (i // FIT_POSITIONS) / (FIT_POSITIONS - 1))
     for i in range(FIT_POSITIONS**2)),
    key=lambda uv: hypot(uv[0] - 0.5, uv[1] - 0.5),
)


class Transform(NamedTuple):
    """The map taking (x, y) to (xx x + xy y + x, yx x + yy y + y)."""

    xx: float
    xy: float
    yx: float
    yy: float
    x: float
    y: float


IDENTITY = Transform(1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def apply(t: Transform, p: Point) -> Point:
    px, py = p
    return (t.xx * px + t.xy * py + t.x, t.yx * px + t.yy * py + t.y)


def rigid_map(a: Point, b: Point, c: Point, d: Point) -> Transform:
    """The rotation and translation taking the segment from a to b onto the one
    from c to d, which has the same length."""
    (ax, ay), (bx, by), (cx, cy), (dx, dy) = a, b, c, d
    ux, uy = bx - ax, by - ay
    vx, vy = dx - cx, dy - cy
    length_sq = ux * ux + uy * uy
    cos_ = (ux * vx + uy * vy) / length_sq
    sin_ = (ux * vy - uy * vx) / length_sq
    return Transform(cos_, -sin_, sin_, cos_, cx - cos_ * ax + sin_ * ay, cy - sin_ * ax - cos_ * ay)


def similarity(angle: float, scale: float = 1, x: float = 0, y: float = 0) -> Transform:
    """A rotation by `angle` about the origin and scaling by `scale`, followed by
    a move by (x, y)."""
    cos_, sin_ = scale * cos(angle), scale * sin(angle)
    return Transform(cos_, -sin_, sin_, cos_, x, y)


def compose(outer: Transform, inner: Transform) -> Transform:
    """The map applying `inner`, then `outer`."""
    return Transform(
        outer.xx * inner.xx + outer.xy * inner.yx,
        outer.xx * inner.xy + outer.xy * inner.yy,
        outer.yx * inner.xx + outer.yy * inner.yx,
        outer.yx * inner.xy + outer.yy * inner.yy,
        outer.xx * inner.x + outer.xy * inner.y + outer.x,
        outer.yx * inner.x + outer.yy * inner.y + outer.y,
    )


class Box(NamedTuple):
    min_x: float
    max_x: float
    min_y: float
    max_y: float


def bounds(points: Polygon) -> Box:
    xs = [x for x, _ in points]
    ys = [y for _, y in points]
    return Box(min(xs), max(xs), min(ys), max(ys))


MARK_CORNER_BOUNDS = [bounds(corner) for corner in MARK_CORNERS]


def boxes_overlap(a: Box, b: Box) -> bool:
    return (
        a.max_x > b.min_x + EPSILON
        and b.max_x > a.min_x + EPSILON
        and a.max_y > b.min_y + EPSILON
        and b.max_y > a.min_y + EPSILON
    )


def overlaps(p: Polygon, q: Polygon) -> bool:
    """Tests whether two convex polygons overlap by more than touching."""
    if not boxes_overlap(bounds(p), bounds(q)):
        return False
    for polygon in (p, q):
        for i, (x1, y1) in enumerate(polygon):
            x2, y2 = polygon[(i + 1) % len(polygon)]
            length = hypot(x2 - x1, y2 - y1)
            ps = [((y2 - y1) * x - (x2 - x1) * y) / length for x, y in p]
            qs = [((y2 - y1) * x - (x2 - x1) * y) / length for x, y in q]
            if max(ps) < min(qs) + EPSILON or max(qs) < min(ps) + EPSILON:
                return False
    return True


def clear_of(outline: Polygon, shapes: list[tuple[Polygon, Box]]) -> bool:
    """Tests whether a convex polygon overlaps none of the given ones, each
    given with its bounds."""
    box = bounds(outline)
    return not any(boxes_overlap(box, other_box) and overlaps(outline, other) for other, other_box in shapes)


def alongside(p: Polygon, q: Polygon) -> bool:
    """Tests whether two polygons touch along a stretch of their edges."""
    for i, (ax, ay) in enumerate(p):
        bx, by = p[(i + 1) % len(p)]
        length = hypot(bx - ax, by - ay)

        def across(point: Point) -> float:
            return ((bx - ax) * (point[1] - ay) - (by - ay) * (point[0] - ax)) / length

        def along(point: Point) -> float:
            return ((bx - ax) * (point[0] - ax) + (by - ay) * (point[1] - ay)) / length

        for j, c in enumerate(q):
            d = q[(j + 1) % len(q)]
            if abs(across(c)) > EPSILON or abs(across(d)) > EPSILON:
                continue
            start, end = sorted((along(c), along(d)))
            if min(end, length) - max(start, 0) > EPSILON:
                return True
    return False


def tab_height(angles: tuple[float, float]) -> float:
    """The height of a glue tab whose sides rise at the given angles, relative to
    the length of its edge."""
    start_angle, end_angle = angles
    return min(TAB_HEIGHT, (1 - TAB_TOP) / (1 / tan(start_angle) + 1 / tan(end_angle)))


def tab(p: Point, q: Point, angles: tuple[float, float]) -> Polygon:
    """A glue tab on the outside of the net edge from p to q, which runs
    counter-clockwise around its face, with its sides rising from the edge at
    the given angles."""
    (px, py), (qx, qy) = p, q
    length = hypot(qx - px, qy - py)
    dx, dy = (qx - px) / length, (qy - py) / length
    start_run, end_run = 1 / tan(angles[0]), 1 / tan(angles[1])
    height = tab_height(angles) * length
    return [
        (px, py),
        (px + height * (start_run * dx + dy), py + height * (start_run * dy - dx)),
        (qx + height * (dy - end_run * dx), qy - height * (dx + end_run * dy)),
        (qx, qy),
    ]


@dataclass
class Connector:
    """An interlocking joint: the outlines of its two tabs, the slit to cut, the
    slit with its short ends as printed, the cut edges beside the small tab,
    and the folds."""

    outlines: list[Polygon]
    slits: list[Polygon]
    print_slits: list[Polygon]
    bare: list[Polygon]
    folds: list[Polygon]


def interlock(side: Polygon, other: Polygon, angles: tuple[float, float] = TAB_ANGLES[0]) -> Connector:
    """A glue-shaped receiver tab keeps the slit on the face edge. One small
    rectangular tab tucks through it; only the bridges beside the slit fold."""
    (p, q), (r, s) = side, other

    def point(a: Point, b: Point, u: float, v: float) -> Point:
        return (a[0] + u * (b[0] - a[0]) + v * (b[1] - a[1]), a[1] + u * (b[1] - a[1]) - v * (b[0] - a[0]))

    outline = [point(r, s, u, v) for u, v in ((0.38, 0), (0.38, 0.12), (0.62, 0.12), (0.62, 0))]
    receiver = tab(p, q, angles)
    # The PNG adds short perpendicular ends entirely in the receiver tab.
    # Keep them shorter where the tab is shallow; the cutter slit stays straight.
    end_length = min(0.03, tab_height(angles) / 4)
    slit = [point(p, q, u, v) for u, v in ((0.37, end_length), (0.37, 0), (0.63, 0), (0.63, end_length))]
    return Connector(
        outlines=[receiver, outline],
        slits=[[slit[1], slit[2]]],
        print_slits=[slit],
        bare=[[r, outline[0]], [outline[-1], s]],
        folds=[[p, slit[1]], [slit[2], q], [outline[0], outline[-1]]],
    )


def seeded_random(seed: int) -> Callable[[], float]:
    """A pseudo-random number generator, seeded so that a solid unfolds the same
    way every time."""

    def random() -> float:
        nonlocal seed
        seed = (seed * 16807) % 2147483647
        return seed / 2147483647

    return random


@dataclass
class Solid:
    """A solid's name, its faces, as vertex indices counter-clockwise from
    outside, and their corners in each face's own 2D coordinates."""

    id: str
    name: str
    faces: list[list[int]]
    corners: list[Polygon]

    @classmethod
    def from_json(cls, data: dict) -> Solid:
        corners = [[(float(x), float(y)) for x, y in face] for face in data['corners']]
        return cls(data['id'], data['name'], data['faces'], corners)


@dataclass
class Unfolded:
    """A solid unfolded into pieces, as lists of faces, with each face's
    placement, mapping its face coordinates into the net, its corners there, and
    the edges the net folds along, both ways round."""

    pieces: list[list[int]]
    placements: list[Transform]
    polygons: list[Polygon]
    folds: set[tuple[int, int]]


@dataclass
class Net:
    """A finished net. Folds are the segments to fold along, cuts the lines to
    cut along, slits the slits to cut for interlocking tabs, print_slits the
    slits as printed, and tabs the tabs' outlines, all as lists of points."""

    placements: list[Transform]
    faces: list[Polygon]
    folds: list[Polygon]
    cuts: list[Polygon]
    slits: list[Polygon]
    print_slits: list[Polygon]
    tabs: list[Polygon]
    pieces: int
    scale: float = 0.0

    def to_json(self) -> dict[str, Any]:
        return rounded({
            'scale': self.scale,
            'placements': [placement._asdict() for placement in self.placements],
            'faces': self.faces,
            'folds': self.folds,
            'cuts': self.cuts,
            'slits': self.slits,
            'printSlits': self.print_slits,
            'tabs': self.tabs,
        })


# Saved coordinates are rounded to 1e-9 mm, far finer than the printer or the
# cutter file, which keeps the files small.
SAVED_DECIMALS = 9


def rounded(value: Any) -> Any:
    """Numbers, or lists or dicts of them, rounded, with tuples as lists."""
    if isinstance(value, float):
        return round(value, SAVED_DECIMALS)
    if isinstance(value, dict):
        return {key: rounded(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [rounded(item) for item in value]
    return value


def grow_pieces(solid: Solid, random: Callable[[], float] | None, assembly: str) -> Unfolded:
    """Unfolds a solid into pieces of net, growing each breadth first across the
    edges of its faces and leaving out faces that would overlap it. Faces left
    out start more pieces. Takes the faces in their own order, or in an order
    shuffled by `random` when given."""
    faces, corners = solid.faces, solid.corners

    def shuffle(items: list) -> list:
        if random is None:
            return items
        keyed = [(random(), item) for item in items]
        keyed.sort(key=lambda pair: pair[0])
        return [item for _, item in keyed]

    def edges_of(f: int) -> list[tuple[int, int, int]]:
        face = faces[f]
        return [(i, a, face[(i + 1) % len(face)]) for i, a in enumerate(face)]

    # Faces list their vertices counter-clockwise from outside, so the face
    # across an edge runs along it the other way.
    face_along = {(a, b): f for f in range(len(faces)) for _, a, b in edges_of(f)}

    pieces: list[list[int]] = []
    # Of the faces placed so far.
    placements: dict[int, Transform] = {}
    polygons: dict[int, Polygon] = {}
    boxes: dict[int, Box] = {}
    folds: set[tuple[int, int]] = set()

    def seams_have_room(piece: list[int], g: int, shape: Polygon, joining: int) -> bool:
        # Placing a face may close seams with faces already in the piece,
        # leaving each seam's two edges side by side in a slot. Around a corner
        # whose faces' angles add up to nearly a full turn, the slot is too
        # narrow for a glue tab on either side.
        for k, a, b in edges_of(g):
            h = face_along[(b, a)]
            if k == joining or h not in piece:
                continue
            m = faces[h].index(b)
            sides = [
                (shape[k], shape[(k + 1) % len(shape)]),
                (polygons[h][m], polygons[h][(m + 1) % len(faces[h])]),
            ]
            # The two faces beside the slot are the likeliest to block it.
            others = [(shape, bounds(shape)), (polygons[h], boxes[h])]
            others += [(polygons[e], boxes[e]) for e in piece if e != h]
            if not any(clear_of(tab(p, q, angles), others) for angles in TAB_ANGLES for p, q in sides):
                return False
        return True

    def envelopes(h: int, shape: Polygon, joining: int) -> list[Polygon]:
        # The largest receiver also covers the rectangular tab, so it stands for
        # either tab on every edge of the face not folded or being joined.
        found = [shape]
        for k, p in enumerate(shape):
            a, b = faces[h][k], faces[h][(k + 1) % len(faces[h])]
            if k == joining or (a, b) in folds:
                continue
            found.append(tab(p, shape[(k + 1) % len(shape)], TAB_ANGLES[0]))
        return found

    for root in shuffle(list(range(len(faces)))):
        if root in placements:
            continue
        piece = [root]
        placements[root], polygons[root], boxes[root] = IDENTITY, corners[root], bounds(corners[root])
        # Visits the faces appended to the piece on the way too.
        k = 0
        while k < len(piece):
            f = piece[k]
            k += 1
            for i, a, b in shuffle(edges_of(f)):
                g = face_along[(b, a)]
                if g in placements:
                    continue
                j = faces[g].index(b)
                placement = rigid_map(
                    corners[g][(j + 1) % len(faces[g])],
                    corners[g][j],
                    polygons[f][i],
                    polygons[f][(i + 1) % len(faces[f])],
                )
                polygon = [apply(placement, p) for p in corners[g]]
                # A face lying along an edge of another face, other than the one
                # it hangs from, would leave no room for a tab between the two.
                if any(overlaps(polygon, polygons[h]) or (h != f and alongside(polygon, polygons[h])) for h in piece):
                    continue
                if assembly == 'glue' and not seams_have_room(piece, g, polygon, j):
                    continue
                if assembly == 'interlocking':
                    # Reserves room for a tab on every edge that may still be cut.
                    proposed = envelopes(g, polygon, j)
                    if any(
                        overlaps(existing, shape)
                        for h in piece
                        for existing in envelopes(h, polygons[h], i if h == f else -1)
                        for shape in proposed
                    ):
                        continue
                placements[g], polygons[g], boxes[g] = placement, polygon, bounds(polygon)
                folds.update(((a, b), (b, a)))
                piece.append(g)
        pieces.append(piece)
    every = range(len(faces))
    return Unfolded(pieces, [placements[f] for f in every], [polygons[f] for f in every], folds)


def pack_pieces(unfolded: Unfolded) -> Unfolded:
    """Lays the pieces of a net out in rows, apart enough for their tabs, each
    turned to its smallest bounding box, at the row width that lets them come
    out largest on the page."""
    pieces, placements, polygons = unfolded.pieces, unfolded.placements, unfolded.polygons

    def move(piece: list[int], t: Transform) -> None:
        for f in piece:
            placements[f] = compose(t, placements[f])
            polygons[f] = [apply(t, p) for p in polygons[f]]

    def edges(polygon: Polygon) -> list[Point]:
        return [(polygon[(i + 1) % len(polygon)][0] - x, polygon[(i + 1) % len(polygon)][1] - y)
                for i, (x, y) in enumerate(polygon)]

    gap = 3 * TAB_HEIGHT * max(hypot(dx, dy) for polygon in polygons for dx, dy in edges(polygon))
    boxes = []
    for piece in pieces:
        points = [p for f in piece for p in polygons[f]]
        turns = [-atan2(dy, dx) for f in piece for dx, dy in edges(polygons[f])]

        def area(angle: float) -> float:
            box = bounds([apply(similarity(angle), p) for p in points])
            return (box.max_x - box.min_x) * (box.max_y - box.min_y)

        # Symmetric pieces often have several turns with exactly the same box,
        # and rounding picks between them, so another machine's math library
        # can turn them differently, which changes how pieces pack and how
        # large interlocking nets in several pieces come out.
        best, best_area = turns[0], area(turns[0])
        for angle in turns[1:]:
            angle_area = area(angle)
            if angle_area < best_area:
                best, best_area = angle, angle_area
        move(piece, similarity(best))
        boxes.append(bounds([p for f in piece for p in polygons[f]]))

    # Fills rows left to right, tallest pieces first.
    order = sorted(range(len(pieces)), key=lambda k: -(boxes[k].max_y - boxes[k].min_y))

    def lay_out(width: float) -> tuple[list[Point], float]:
        spots: list[Point] = [(0.0, 0.0)] * len(pieces)
        x = y = row_height = right = 0.0
        for k in order:
            min_x, max_x, min_y, max_y = boxes[k]
            if x > 0 and x + max_x - min_x > width:
                x, y, row_height = 0.0, y + row_height + gap, 0.0
            spots[k] = (x - min_x, y - min_y)
            right = max(right, x + max_x - min_x)
            row_height = max(row_height, max_y - min_y)
            x += max_x - min_x + gap
        room_x, room_y = PAGE_WIDTH - 2 * PAGE_MARGIN, PAGE_HEIGHT - 2 * PAGE_MARGIN
        w, h = right, y + row_height
        return spots, max(min(room_x / w, room_y / h), min(room_x / h, room_y / w))

    # Tries breaking the first row after each piece.
    widths = []
    for n in range(len(order)):
        width = 0.0
        for k in order[: n + 1]:
            width = width + boxes[k].max_x - boxes[k].min_x + gap
        widths.append(width)
    spots, best_fit = lay_out(widths[0])
    for width in widths[1:]:
        candidate, fit = lay_out(width)
        if fit > best_fit:
            spots, best_fit = candidate, fit
    for k, piece in enumerate(pieces):
        move(piece, Transform(1.0, 0.0, 0.0, 1.0, *spots[k]))
    return unfolded


def finish_net(solid: Solid, unfolded: Unfolded, assembly: str) -> Net | None:
    """Adds the tabs, and sorts the edges of an unfolded solid into those to fold
    along and those to cut along. Returns None when a cut edge has no room for
    a glue tab or an interlocking joint."""
    faces, polygons = solid.faces, unfolded.polygons

    def segment(f: int, i: int) -> Polygon:
        return [polygons[f][i], polygons[f][(i + 1) % len(faces[f])]]

    face_along = {(a, face[(i + 1) % len(face)]): f for f, face in enumerate(faces) for i, a in enumerate(face)}
    folds: list[Polygon] = []
    cuts: list[Polygon] = []
    slits: list[Polygon] = []
    print_slits: list[Polygon] = []
    tabs: list[Polygon] = []
    taken = [(polygon, bounds(polygon)) for polygon in polygons]

    def clear(outline: Polygon) -> bool:
        return clear_of(outline, taken)

    for f, face in enumerate(faces):
        for i, a in enumerate(face):
            b = face[(i + 1) % len(face)]
            # Takes each edge once, from the face that has it going up.
            if a > b:
                continue
            if (a, b) in unfolded.folds:
                folds.append(segment(f, i))
                continue
            # A cut edge is on the outline twice; it gets the largest tab that is
            # clear of the rest of the net on either side.
            g = face_along[(b, a)]
            sides = [segment(f, i), segment(g, faces[g].index(b))]
            if assembly == 'interlocking':
                connector = None
                for angles in TAB_ANGLES:
                    for candidate in (interlock(sides[0], sides[1], angles), interlock(sides[1], sides[0], angles)):
                        outlines = candidate.outlines
                        if all(clear(outline) for outline in outlines) and all(
                            not overlaps(outline, other)
                            for n, outline in enumerate(outlines)
                            for other in outlines[n + 1 :]
                        ):
                            connector = candidate
                            break
                    if connector:
                        break
                if not connector:
                    return None
                tabs.extend(connector.outlines)
                cuts.extend(connector.bare)
                slits.extend(connector.slits)
                print_slits.extend(connector.print_slits)
                folds.extend(connector.folds)
                taken.extend((outline, bounds(outline)) for outline in connector.outlines)
                continue
            tabbed = None
            for angles in TAB_ANGLES:
                tabbed = next(
                    ((n, outline) for n, outline in ((n, tab(side[0], side[1], angles)) for n, side in enumerate(sides))
                     if clear(outline)),
                    None,
                )
                if tabbed:
                    break
            if not tabbed:
                return None
            for n, side in enumerate(sides):
                if tabbed[0] == n:
                    tabs.append(tabbed[1])
                    taken.append((tabbed[1], bounds(tabbed[1])))
                    folds.append(side)
                else:
                    cuts.append(side)
    cuts.extend(tabs)
    return Net(unfolded.placements, polygons, folds, cuts, slits, print_slits, tabs, len(unfolded.pieces))


def unfold(solid: Solid, assembly: str) -> list[Net]:
    """Unfolds a solid into nets in a few ways, in as few pieces as it can."""
    random = seeded_random(1)
    nets: list[Unfolded] = []
    for attempt in range(UNFOLD_ATTEMPTS):
        # The first attempt takes the faces in their own order.
        unfolded = grow_pieces(solid, None if attempt == 0 else random, assembly)
        fewest = len(nets[0].pieces) if nets else inf
        if len(unfolded.pieces) < fewest:
            nets = [unfolded]
        elif len(unfolded.pieces) == fewest and len(nets) < UNFOLDINGS:
            nets.append(unfolded)
        if len(nets) == UNFOLDINGS and fewest == 1:
            break
    finished = [net for net in (finish_net(solid, pack_pieces(unfolded), assembly) for unfolded in nets) if net]
    if finished:
        return finished
    # Tight nets may leave no room for a tab or a complete pair. Separate the
    # faces rather than silently leaving a seam without one.
    separate = Unfolded(
        [[f] for f in range(len(solid.faces))], [IDENTITY] * len(solid.faces), list(solid.corners), set()
    )
    fallback = finish_net(solid, pack_pieces(separate), assembly)
    if not fallback:
        raise RuntimeError(f'Could not make room for every tab on the {solid.id}.')
    return [fallback]


def find_place(polygons: list[Polygon], scale: float) -> Point | None:
    """Where polygons scaled by `scale` fit on the page, inside its margins and
    clear of the registration marks' corners, as the move to put them there."""
    boxes = [bounds(polygon) for polygon in polygons]
    min_x, max_x, min_y, max_y = bounds([p for polygon in polygons for p in polygon])
    left, right = FIT_MARGIN - scale * min_x, PAGE_WIDTH - FIT_MARGIN - scale * max_x
    bottom, top = FIT_MARGIN - scale * min_y, PAGE_HEIGHT - FIT_MARGIN - scale * max_y
    if left > right or bottom > top:
        return None

    def clear_at(x: float, y: float) -> bool:
        for polygon, box in zip(polygons, boxes):
            for corner, corner_box in zip(MARK_CORNERS, MARK_CORNER_BOUNDS):
                if (
                    x + scale * box.min_x >= corner_box.max_x
                    or x + scale * box.max_x <= corner_box.min_x
                    or y + scale * box.min_y >= corner_box.max_y
                    or y + scale * box.max_y <= corner_box.min_y
                ):
                    continue
                if overlaps([(x + scale * px, y + scale * py) for px, py in polygon], corner):
                    return False
        return True

    for u, v in FIT_GRID:
        x, y = left + u * (right - left), bottom + v * (top - bottom)
        if clear_at(x, y):
            return (x, y)
    return None


def place_on_page(net: Net, max_scale: float = inf) -> Net:
    """Places a net on the page, in mm, turned and scaled to be as large as
    fits, but no larger than `max_scale`."""
    polygons = net.faces + net.tabs
    # Tries the net with each edge of its faces along each side of the page.
    angles: dict[str, float] = {}
    for polygon in net.faces:
        for i, (px, py) in enumerate(polygon):
            qx, qy = polygon[(i + 1) % len(polygon)]
            for k in range(4):
                angle = fmod(k * pi / 2 - atan2(qy - py, qx - px) + 4 * pi, 2 * pi)
                angles[f'{angle:.6f}'] = angle

    best_scale, best_angle, best_place = 0.0, 0.0, (0.0, 0.0)
    for angle in angles.values():
        turned = [[apply(similarity(angle), p) for p in polygon] for polygon in polygons]
        min_x, max_x, min_y, max_y = bounds([p for polygon in turned for p in polygon])
        # Bisects up to the scale at which the net fills the space within the
        # margins, from the best scale so far, as the angle has to beat it.
        low = best_scale
        high = min((PAGE_WIDTH - 2 * FIT_MARGIN) / (max_x - min_x), (PAGE_HEIGHT - 2 * FIT_MARGIN) / (max_y - min_y))
        step = 0
        while step < FIT_STEPS and low < high:
            scale = (low + high) / 2
            place = find_place(turned, scale)
            if place:
                best_scale, best_angle, best_place = scale, angle, place
                low = scale
            else:
                high = scale
            step += 1

    if best_scale > max_scale:
        # Shrinks it, keeping the turn it fits best at, nearest the middle.
        best_scale = max_scale
        turned = [[apply(similarity(best_angle), p) for p in polygon] for polygon in polygons]
        best_place = find_place(turned, best_scale)
        if best_place is None:
            raise RuntimeError('A net that fits on the page fits no longer when shrunk.')

    t = similarity(best_angle, best_scale, *best_place)

    def move(lines: list[Polygon]) -> list[Polygon]:
        return [[apply(t, p) for p in line] for line in lines]

    return Net(
        placements=[compose(t, placement) for placement in net.placements],
        faces=move(net.faces),
        folds=move(net.folds),
        cuts=move(net.cuts),
        slits=move(net.slits),
        print_slits=move(net.print_slits),
        tabs=move(net.tabs),
        pieces=net.pieces,
        scale=best_scale,
    )


def net_on_page(solid: Solid, assembly: str = 'glue') -> Net:
    """Unfolds a solid and places it on the page, picking the net that comes out
    largest there, and shrinking it if its edges come out longer than
    MAX_EDGE."""
    if assembly not in ASSEMBLIES:
        raise ValueError(f'Unknown assembly method: {assembly}')
    # The first of the largest. Of nets that would all come out too large, this
    # keeps the one with the most room to spare.
    best_placed, best = max(
        ((place_on_page(net), net) for net in unfold(solid, assembly)), key=lambda pair: pair[0].scale
    )
    longest = max(
        hypot(qx - px, qy - py) for face in solid.corners for (px, py), (qx, qy) in zip(face, face[1:] + face[:1])
    )
    max_scale = MAX_EDGE / longest
    return place_on_page(best, max_scale) if best_placed.scale > max_scale else best_placed
