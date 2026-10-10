"""Write-back operations on one source SVG file.

Each operation names its target by the locator path the pipeline stamped on the
rendered element (see ``provenance``). A batch resolves every target before
applying anything, so a delete early in the batch cannot shift the meaning of a
later locator. The file is parsed and re-serialised with the same hardened lxml
parser the pipeline uses; only the touched nodes change.
"""

from __future__ import annotations

import copy
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from lxml import etree

from inkflow import ns
from inkflow.colors import SVG_TOKENS
from inkflow.editor.provenance import (
    PROVENANCE_ATTRS,
    is_element,
    is_link_wrapper,
    locate,
)
from inkflow.svgio import SvgElement, svg_parser


class SvgOpError(Exception):
    """An operation that cannot be applied (bad locator, malformed input)."""


def file_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


# ── File round trip ─────────────────────────────────────────────────────────────


@dataclass
class SvgFile:
    path: Path
    tree: etree._ElementTree  # pyright: ignore[reportPrivateUsage]
    declaration: bool

    @classmethod
    def from_bytes(cls, path: Path, data: bytes) -> SvgFile:
        try:
            root = etree.fromstring(data, parser=svg_parser())
        except etree.XMLSyntaxError as exc:
            raise SvgOpError(f"invalid SVG {path}: {exc}") from exc
        return cls(path, root.getroottree(), data.lstrip().startswith(b"<?xml"))

    @property
    def root(self) -> SvgElement:
        return self.tree.getroot()

    def to_bytes(self) -> bytes:
        root = self.root
        if ns.INKFLOW not in root.nsmap.values() and any(
            str(name).startswith(f"{{{ns.INKFLOW}}}")
            for el in root.iter()
            if is_element(el)
            for name in el.attrib
        ):
            # Declare inkflow: once on the root, not as ns0: on each element.
            etree.cleanup_namespaces(
                self.tree,
                top_nsmap={"inkflow": ns.INKFLOW},
                keep_ns_prefixes=[p for p in root.nsmap if p],
            )
        data = etree.tostring(
            self.tree,
            xml_declaration=self.declaration,
            encoding="UTF-8",
        )
        return data if data.endswith(b"\n") else data + b"\n"


# ── Operations ──────────────────────────────────────────────────────────────────

_SVG = f"{{{ns.SVG}}}"
_XLINK_HREF = f"{{{ns.XLINK}}}href"
_ALLOWED_TAGS = frozenset(
    _SVG + t
    for t in (
        "g",
        "rect",
        "circle",
        "ellipse",
        "line",
        "polyline",
        "polygon",
        "path",
        "text",
        "tspan",
        "image",
        "defs",
        "marker",
        "linearGradient",
        "radialGradient",
        "stop",
        "title",
        "desc",
        "use",
        "clipPath",
        "svg",  # a cropped image's frame
        "a",  # a link around objects
    )
)
_ID_RE = re.compile(r"^[A-Za-z_][\w.-]*$")
_TOKEN_CLASS = re.compile(r"^inkflow-(fill|stroke)-([\w-]+)$")


@dataclass
class OpResult:
    ids: dict[str, str] = field(default_factory=dict)
    """Ids assigned during the batch: request-local key → id."""
    structural: bool = False
    """Whether element positions changed (locators into this file are stale)."""
    renamed_prefixes: dict[str, str] = field(default_factory=dict)
    """Renamed draw.io pictures: the names of their shapes start with the
    picture's id (``<id>-<cell>``, see drawio_inline), so those follow."""


def _resolve(root: SvgElement, loc: object) -> SvgElement:
    if not isinstance(loc, str):
        raise SvgOpError("missing locator")
    path = loc.partition(":")[2] if ":" in loc else loc
    try:
        el = locate(root, path)
    except (LookupError, ValueError) as exc:
        raise SvgOpError(str(exc)) from exc
    if el is root:
        raise SvgOpError("the root element cannot be edited")
    return el


def element_at(root: SvgElement, loc: object) -> SvgElement:
    """The element a ``data-ink`` locator names (``SvgOpError`` if none)."""
    return _resolve(root, loc)


def all_ids(root: SvgElement) -> set[str]:
    return {i for el in root.iter() if is_element(el) and (i := el.get("id"))}


def unique_id(root: SvgElement, base: str, taken: set[str] | None = None) -> str:
    ids = taken if taken is not None else all_ids(root)
    base = re.sub(r"[^\w.-]", "-", base).strip("-") or "el"
    if not base[0].isalpha() and base[0] != "_":
        base = f"el-{base}"
    if base not in ids:
        ids.add(base)
        return base
    n = 2
    while f"{base}-{n}" in ids:
        n += 1
    ids.add(f"{base}-{n}")
    return f"{base}-{n}"


def _local(tag: object) -> str:
    return tag.split("}")[-1] if isinstance(tag, str) else ""


def _drop(el: SvgElement, name: str) -> None:
    if name in el.attrib:
        del el.attrib[name]


def _parse_style(style: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for part in style.split(";"):
        name, sep, value = part.partition(":")
        if sep and name.strip():
            out[name.strip()] = value.strip()
    return out


def _format_style(props: dict[str, str]) -> str:
    return ";".join(f"{k}:{v}" for k, v in props.items())


def set_style(el: SvgElement, props: dict[str, str | None]) -> None:
    """Set CSS properties in ``style`` (``None`` removes), dropping any
    presentation attribute of the same name so there is a single source."""
    style = _parse_style(el.get("style", ""))
    for name, value in props.items():
        if value is None:
            style.pop(name, None)
        else:
            style[name] = value
        if name in el.attrib:
            del el.attrib[name]
    if style:
        el.set("style", _format_style(style))
    elif "style" in el.attrib:
        del el.attrib["style"]


def _paint(el: SvgElement, prop: str, token: object, color: object) -> None:
    if prop not in ("fill", "stroke"):
        raise SvgOpError(f"cannot paint {prop!r}")
    classes = [
        c
        for c in el.get("class", "").split()
        if not ((m := _TOKEN_CLASS.match(c)) and m.group(1) == prop)
    ]
    if isinstance(token, str):
        if token not in SVG_TOKENS:
            raise SvgOpError(f"unknown colour token {token!r}")
        classes.append(f"inkflow-{prop}-{token}")
        set_style(el, {prop: None})
    elif isinstance(color, str):
        if not re.fullmatch(r"#[0-9a-fA-F]{3,8}|none|transparent|currentColor", color):
            raise SvgOpError(f"invalid colour {color!r}")
        set_style(el, {prop: color})
    else:
        set_style(el, {prop: None})
    if classes:
        el.set("class", " ".join(classes))
    elif "class" in el.attrib:
        del el.attrib["class"]


def _set_text(el: SvgElement, lines: list[str], line_height: float | None) -> None:
    if _local(el.tag) != "text":
        raise SvgOpError("only <text> elements hold editable text")
    tspans = [c for c in el if _local(c.tag) == "tspan"]
    mixed = bool((el.text or "").strip()) or any(
        (span.tail or "").strip() for span in tspans
    )
    if mixed:
        # Text and inline spans on one line (a bold word in a sentence): the
        # spans are not lines, so the edit replaces the run with plain text.
        x = el.get("x")
        first_x = tspans[0].get("x") if tspans else None
        for child in list(el):
            el.remove(child)
        if first_x is not None and x is None:
            el.set("x", first_x)
        tspans = []
    if not tspans:
        for child in list(el):
            el.remove(child)
        if len(lines) == 1:
            el.text = lines[0]
            return
        el.text = None
        x = el.get("x", "0")
        for i, line in enumerate(lines):
            span = etree.SubElement(el, _SVG + "tspan")
            span.set("x", x)
            if i == 0:
                span.set("y", el.get("y", "0"))
            else:
                span.set("dy", "1.2em")
            span.text = line
        return
    # Keep the first span's attributes as the template for every line, which is
    # how Inkscape writes multi-line text (one tspan per line, absolute x/y).
    first = tspans[0]
    el.text = None
    for span in tspans:
        el.remove(span)
    x = first.get("x") or el.get("x", "0")
    y = first.get("y")
    step = line_height
    if step is None and len(tspans) > 1:
        try:
            step = float(tspans[1].get("y", "")) - float(y or "")
        except ValueError:
            step = None
    for i, line in enumerate(lines):
        span = copy.deepcopy(first)
        for child in list(span):
            span.remove(child)
        span.text = line
        span.tail = None
        if i > 0:
            span.set("x", x)
            if y is not None and step is not None:
                span.set("y", f"{float(y) + i * step:g}")
                _drop(span, "dy")
            else:
                _drop(span, "y")
                span.set("dy", "1.2em")
            if "id" in span.attrib:
                del span.attrib["id"]
        el.append(span)


def _sanitize(el: SvgElement) -> None:
    for node in list(el.iter()):
        if not is_element(node):
            continue
        if node.tag not in _ALLOWED_TAGS:
            raise SvgOpError(f"element <{_local(node.tag)}> cannot be inserted")
        for name in list(node.attrib):
            local = str(name).split("}")[-1].lower()
            value = node.get(name) or ""
            if (
                local.startswith("on")
                or local in PROVENANCE_ATTRS
                or (local == "href" and value.strip().lower().startswith("javascript:"))
            ):
                del node.attrib[name]


def _parse_fragment(xml: str) -> SvgElement:
    wrapped = (
        f'<svg xmlns="{ns.SVG}" xmlns:xlink="{ns.XLINK}" '
        f'xmlns:inkflow="{ns.INKFLOW}">{xml}</svg>'
    )
    try:
        holder = etree.fromstring(wrapped.encode(), parser=svg_parser())
    except etree.XMLSyntaxError as exc:
        raise SvgOpError(f"malformed element: {exc}") from exc
    if len(holder) != 1:
        raise SvgOpError("insert exactly one element")
    el = holder[0]
    _sanitize(el)
    return el


def _renumber_ids(el: SvgElement, root: SvgElement) -> dict[str, str]:
    """Give every id in ``el`` (a copy) a free one; returns old -> new."""
    taken = all_ids(root)
    renamed: dict[str, str] = {}
    for node in el.iter():
        if is_element(node) and node.get("id"):
            old = node.get("id", "")
            renamed[old] = unique_id(root, old, taken)
            node.set("id", renamed[old])
    return renamed


def _counterpart(
    original: SvgElement, node: SvgElement, copy: SvgElement
) -> SvgElement:
    """The element in ``copy`` (a deep copy of ``original``) that is ``node``."""
    path: list[int] = []
    while node is not original:
        parent = node.getparent()
        if parent is None:
            raise SvgOpError("not inside the copied object")
        path.append(parent.index(node))
        node = parent
    for i in reversed(path):
        copy = copy[i]
    return copy


def _set_attrs(el: SvgElement, values: object) -> None:
    for name, value in cast("dict[str, object]", values or {}).items():
        if name in ("id",) or name.lower().startswith("on"):
            raise SvgOpError(f"attribute {name!r} cannot be set here")
        if name in ("href", "xlink:href") and str(
            value or ""
        ).strip().lower().startswith("javascript:"):
            raise SvgOpError("javascript: links are not allowed")
        if name == "xlink:href":
            name = _XLINK_HREF
        elif name.startswith("inkflow:"):
            # Connector ends (inkflow:connect-start …) and the like.
            name = f"{{{ns.INKFLOW}}}{name.removeprefix('inkflow:')}"
        if value is None:
            _drop(el, name)
        else:
            el.set(name, str(value))


def _translate(el: SvgElement, dx: float, dy: float) -> None:
    if dx == 0 and dy == 0:
        return
    existing = el.get("transform")
    move = f"translate({dx:g},{dy:g})"
    el.set("transform", f"{move} {existing}" if existing else move)


def apply_ops(svg: SvgFile, ops: list[dict[str, object]]) -> OpResult:
    """Apply one batch of operations to ``svg`` in place."""
    root = svg.root
    result = OpResult()
    # Resolve every target first, so structural changes cannot shift them.
    targets: list[SvgElement | None] = []
    # A duplicate's own element (inside a link wrapper) and its positioned
    # children, also resolved before anything moves.
    placed: dict[int, list[tuple[SvgElement, object]]] = {}
    for n, op in enumerate(ops):
        kind = op.get("kind")
        if kind == "duplicate":
            placed[n] = [(_resolve(root, op.get("loc")), op.get("set"))] + [
                (_resolve(root, kid.get("loc")), kid.get("set"))
                for kid in cast("list[dict[str, object]]", op.get("kids") or [])
            ]
        if kind == "insert":
            parent_loc = op.get("parent")
            path = str(parent_loc).partition(":")[2] if parent_loc else ""
            targets.append(root if not path else _resolve(root, parent_loc))
        elif kind == "ensure-marker":
            targets.append(root)
        elif kind in ("delete", "duplicate", "order"):
            # A linked object takes its link along.
            targets.append(_outer(_resolve(root, op.get("loc"))))
        else:
            targets.append(_resolve(root, op.get("loc")))

    copies: list[SvgElement] = []
    copied: dict[str, str] = {}
    for n, (op, el) in enumerate(zip(ops, targets, strict=True)):
        assert el is not None
        kind = op.get("kind")
        if kind == "attrs":
            _set_attrs(el, op.get("set"))
        elif kind == "style":
            values = cast("dict[str, object]", op.get("set") or {})
            set_style(el, {k: None if v is None else str(v) for k, v in values.items()})
        elif kind == "paint":
            _paint(el, str(op.get("prop")), op.get("token"), op.get("color"))
        elif kind == "text":
            lines = op.get("lines")
            if not isinstance(lines, list) or not all(
                isinstance(s, str) for s in cast("list[object]", lines)
            ):
                raise SvgOpError("text needs a list of lines")
            lh = op.get("lineHeight")
            _set_text(
                el,
                cast("list[str]", lines) or [""],
                float(cast("float", lh)) if isinstance(lh, int | float) else None,
            )
        elif kind == "id":
            new_id = op.get("id")
            if not isinstance(new_id, str) or not _ID_RE.match(new_id):
                raise SvgOpError(f"invalid id {new_id!r}")
            if new_id != el.get("id") and new_id in all_ids(root):
                raise SvgOpError(f"id {new_id!r} is already used in this file")
            old_id = el.get("id")
            el.set("id", new_id)
            if old_id:
                _rename_connections(root, old_id, new_id)
                if _is_diagram_picture(el):
                    _rename_connections(root, old_id, new_id, prefix=True)
                    result.renamed_prefixes[old_id] = new_id
        elif kind == "ensure-id":
            if not el.get("id"):
                el.set("id", unique_id(root, str(op.get("base") or _local(el.tag))))
            result.ids[str(op.get("key", op.get("loc")))] = el.get("id", "")
        elif kind == "delete":
            parent = el.getparent()
            if parent is not None:
                parent.remove(el)
            result.structural = True
        elif kind == "duplicate":
            clone = copy.deepcopy(el)
            copied.update(_renumber_ids(clone, root))
            copies.append(clone)
            offset = cast("list[float]", op.get("offset") or [0, 0])
            _translate(clone, float(offset[0]), float(offset[1]))
            # Or placed exactly: the attributes a move of the original would
            # set (a copy dragged off with Ctrl), on the copy instead.
            for node, values in placed[n]:
                if values:
                    _set_attrs(_counterpart(el, node, clone), values)
            el.addnext(clone)
            clone.tail = el.tail
            if clone.get("id"):
                result.ids[str(op.get("key", "duplicate"))] = clone.get("id", "")
            result.structural = True
        elif kind == "insert":
            new = _parse_fragment(str(op.get("xml", "")))
            if not new.get("id"):
                new.set("id", str(op.get("base") or _local(new.tag)))
            offset = op.get("offset")
            if isinstance(offset, list) and len(cast("list[object]", offset)) == 2:
                dx, dy = cast("list[float]", offset)
                _translate(new, float(dx), float(dy))
            # Every id inside a pasted copy, not just its own, must stay unique.
            _renumber_ids(new, root)
            index = op.get("index")
            if isinstance(index, int) and 0 <= index <= len(el):
                el.insert(index, new)
            else:
                el.append(new)
            _fix_tail(el, new)
            result.ids[str(op.get("key", "insert"))] = new.get("id", "")
            result.structural = True
        elif kind == "order":
            _reorder(el, str(op.get("to")))
            result.structural = True
        elif kind == "crop-frame":
            if _crop_frame(el):
                result.structural = True
        elif kind == "uncrop":
            _uncrop(el)
            result.structural = True
        elif kind == "title":
            _set_title(el, str(op.get("text") or ""))
        elif kind == "link":
            _set_link(el, op.get("href"))
            result.structural = True
        elif kind == "lock":
            if op.get("locked"):
                el.set(ns.INKFLOW_LOCKED, "true")
            else:
                _drop(el, ns.INKFLOW_LOCKED)
                _drop(el, f"{{{ns.SODIPODI}}}insensitive")
        elif kind == "ensure-marker":
            if ensure_arrow_marker(root):
                result.structural = True
        else:
            raise SvgOpError(f"unknown operation {kind!r}")
    # Arrows copied with the shapes they connect attach to those copies.
    for clone in copies:
        for node in clone.iter():
            if not is_element(node):
                continue
            for attr in CONNECT_ENDS:
                value = node.get(attr)
                target = value.rpartition(":")[0] if value else ""
                if value and target in copied:
                    node.set(attr, f"{copied[target]}:{value.rpartition(':')[2]}")
    return result


def _num(el: SvgElement, name: str) -> float:
    try:
        return float(el.get(name, "0") or 0)
    except ValueError as exc:
        raise SvgOpError(f"{name} is not a number") from exc


_TRANSLATE_ONLY = re.compile(
    r"^\s*translate\(\s*([-+.\deE]+)(?:[\s,]+([-+.\deE]+))?\s*\)\s*$"
)


def _crop_frame(el: SvgElement) -> bool:
    """Put an ``<image>`` into a nested ``<svg>`` frame, ready to be cropped.

    The frame starts as the image's own box with a matching ``viewBox``, so
    nothing moves; cropping then changes the frame (x/y/width/height) and its
    ``viewBox`` together, which keeps the picture where it is. Returns False
    when ``el`` already is such a frame.
    """
    tag = _local(el.tag)
    if tag == "svg":
        return False
    if tag != "image":
        raise SvgOpError("only images can be cropped")
    if el.get("width") is None or el.get("height") is None:
        raise SvgOpError("the image has no size to crop")
    x, y = _num(el, "x"), _num(el, "y")
    transform = el.get("transform")
    if transform:
        m = _TRANSLATE_ONLY.match(transform)
        if not m:
            raise SvgOpError("rotated or scaled images cannot be cropped")
        x += float(m.group(1))
        y += float(m.group(2) or 0)
    w, h = _num(el, "width"), _num(el, "height")
    frame = etree.Element(_SVG + "svg")
    if el.get("id"):
        frame.set("id", el.get("id", ""))
        del el.attrib["id"]
    for name, value in (("x", x), ("y", y), ("width", w), ("height", h)):
        frame.set(name, f"{value:g}")
    frame.set("viewBox", f"{x:g} {y:g} {w:g} {h:g}")
    frame.set("preserveAspectRatio", "none")
    for attr in ("class", "style", "opacity", "clip-path", "mask", "filter"):
        if el.get(attr) is not None:
            frame.set(attr, el.get(attr, ""))
            del el.attrib[attr]
    if transform:
        del el.attrib["transform"]
        el.set("x", f"{x:g}")
        el.set("y", f"{y:g}")
    parent = el.getparent()
    if parent is None:
        raise SvgOpError("the root element cannot be cropped")
    frame.tail = el.tail
    el.tail = None
    parent.replace(el, frame)
    frame.append(el)
    return True


def _cropped_image(frame: SvgElement) -> SvgElement:
    images = [c for c in frame if is_element(c) and _local(c.tag) == "image"]
    if _local(frame.tag) != "svg" or len(images) != 1 or not frame.get("viewBox"):
        raise SvgOpError("not a cropped image")
    return images[0]


def _uncrop(frame: SvgElement) -> None:
    """Undo a crop: the image again, at the size and place it is shown."""
    image = _cropped_image(frame)
    vb = [float(v) for v in re.split(r"[\s,]+", frame.get("viewBox", "").strip())]
    if len(vb) != 4 or vb[2] <= 0 or vb[3] <= 0:
        raise SvgOpError("invalid viewBox")
    sx = _num(frame, "width") / vb[2]
    sy = _num(frame, "height") / vb[3]
    fx, fy = _num(frame, "x"), _num(frame, "y")
    ix, iy = _num(image, "x"), _num(image, "y")
    image.set("x", f"{fx + (ix - vb[0]) * sx:g}")
    image.set("y", f"{fy + (iy - vb[1]) * sy:g}")
    image.set("width", f"{_num(image, 'width') * sx:g}")
    image.set("height", f"{_num(image, 'height') * sy:g}")
    for attr in ("id", "class", "style", "opacity", "clip-path", "mask", "filter"):
        if frame.get(attr) is not None and image.get(attr) is None:
            image.set(attr, frame.get(attr, ""))
    # Alt text set on the frame stays with the picture.
    for child in [
        c for c in frame if is_element(c) and _local(c.tag) in ("title", "desc")
    ]:
        if not any(_local(c.tag) == _local(child.tag) for c in image if is_element(c)):
            image.insert(0, child)
    parent = frame.getparent()
    if parent is None:
        raise SvgOpError("the root element cannot be uncropped")
    image.tail = frame.tail
    parent.replace(frame, image)


CONNECT_ENDS = (f"{{{ns.INKFLOW}}}connect-start", f"{{{ns.INKFLOW}}}connect-end")


def _rename_connections(
    root: SvgElement, old: str, new: str, *, prefix: bool = False
) -> None:
    """Keep connectors attached to an object whose id changed ("<id>:<site>"),
    or, with ``prefix``, to the shapes of a renamed diagram ("<id>-<cell>")."""
    for el in root.iter():
        if not is_element(el):
            continue
        for attr in CONNECT_ENDS:
            value = el.get(attr)
            if not value:
                continue
            target, _, site = value.rpartition(":")
            if target == old and not prefix:
                el.set(attr, f"{new}:{site}")
            elif prefix and target.startswith(f"{old}-"):
                el.set(attr, f"{new}-{target.removeprefix(f'{old}-')}:{site}")


def _is_diagram_picture(el: SvgElement) -> bool:
    href = el.get("href") or el.get(f"{{{ns.XLINK}}}href") or ""
    return _local(el.tag) == "image" and href.split("?")[0].lower().endswith(
        ".drawio.svg"
    )


def _outer(el: SvgElement) -> SvgElement:
    """The link wrapper around ``el`` if it is the only object in one, else ``el``."""
    parent = el.getparent()
    return parent if parent is not None and is_link_wrapper(parent) else el


_LINK_SCHEMES = re.compile(r"^(https?:|mailto:|tel:|slide:|#|[\w./-])", re.I)


def _set_link(el: SvgElement, href: object) -> None:
    """Link an object (wrap it in ``<a href>``), change its link, or remove it.

    ``slide:<id>`` jumps to that slide in the presentation, like the Markdown
    link scheme; anything else opens in a new tab there.
    """
    parent = el.getparent()
    if parent is None:
        raise SvgOpError("the root element cannot be linked")
    wrapper = parent if is_link_wrapper(parent) else None
    text = str(href).strip() if isinstance(href, str) else ""
    if text and (
        text.lower().startswith("javascript:") or not _LINK_SCHEMES.match(text)
    ):
        raise SvgOpError(f"{text!r} is not a link address")
    if not text:
        if wrapper is not None:
            outer = wrapper.getparent()
            assert outer is not None
            el.tail = wrapper.tail
            outer.replace(wrapper, el)
        return
    if wrapper is not None:
        wrapper.set("href", text)
        _drop(wrapper, _XLINK_HREF)
        return
    if _local(el.tag) == "a":
        el.set("href", text)
        return
    a = etree.Element(_SVG + "a")
    a.set("href", text)
    a.tail = el.tail
    el.tail = None
    parent.replace(el, a)
    a.append(el)


def _set_title(el: SvgElement, text: str) -> None:
    """The element's ``<title>``: its accessible name (alt text) and tooltip."""
    titles = [c for c in el if is_element(c) and _local(c.tag) == "title"]
    text = text.strip()
    if not text:
        for t in titles:
            el.remove(t)
        return
    title = titles[0] if titles else etree.Element(_SVG + "title")
    title.text = text
    if not titles:
        el.insert(0, title)
        title.tail = el.text
        el.text = None


ARROW_MARKER = "inkflow-arrow"


def ensure_arrow_marker(root: SvgElement) -> bool:
    """Add the arrowhead ``<marker>`` new arrows reference, once per file.

    ``context-stroke`` paints the head in the line's own stroke colour, so one
    marker serves every arrow whatever its colour or theme token.
    """
    if any(el.get("id") == ARROW_MARKER for el in root.iter(_SVG + "marker")):
        return False
    defs = root.find(_SVG + "defs")
    if defs is None:
        defs = etree.Element(_SVG + "defs")
        root.insert(0, defs)
        defs.tail = "\n"
    marker = _parse_fragment(
        f'<marker id="{ARROW_MARKER}" viewBox="0 0 10 10" refX="8" refY="5" '
        + 'markerWidth="4" markerHeight="4" orient="auto-start-reverse" '
        + 'markerUnits="strokeWidth">'
        + '<path d="M 0 0 L 10 5 L 0 10 z" style="fill:context-stroke;stroke:none"/>'
        + "</marker>"
    )
    defs.append(marker)
    return True


def _fix_tail(parent: SvgElement, new: SvgElement) -> None:
    """Give an inserted element the same indentation as its siblings.

    An element appended last takes over the whitespace before the closing tag,
    and the element before it gets the usual between-siblings indentation.
    """
    # The whitespace before the first child is the children's indentation.
    lead = parent.text if parent.text and "\n" in parent.text else None
    indent = "\n" + lead.rsplit("\n", 1)[1] if lead else "\n"
    prev = new.getprevious()
    if new.getnext() is None and prev is not None:
        new.tail = prev.tail or "\n"
        prev.tail = indent
    else:
        new.tail = indent
        if prev is not None and not (prev.tail or "").strip("\n "):
            prev.tail = prev.tail if prev.tail and "\n" in prev.tail else indent


def _reorder(el: SvgElement, to: str) -> None:
    parent = el.getparent()
    if parent is None:
        return
    painted = [c for c in parent if is_element(c) and c.tag in _ALLOWED_TAGS]
    painted = [c for c in painted if _local(c.tag) not in ("defs", "title", "desc")]
    pos = painted.index(el) if el in painted else -1
    if pos < 0:
        return
    tail = el.tail
    if to == "front":
        target = painted[-1]
        if target is not el:
            target.addnext(el)
    elif to == "back":
        target = painted[0]
        if target is not el:
            target.addprevious(el)
    elif to == "forward" and pos < len(painted) - 1:
        painted[pos + 1].addnext(el)
    elif to == "backward" and pos > 0:
        painted[pos - 1].addprevious(el)
    else:
        return
    el.tail = tail


def group(svg: SvgFile, locs: list[str]) -> str:
    """Wrap the elements at ``locs`` (same parent) in a new ``<g>``; returns its id."""
    root = svg.root
    els = [_outer(_resolve(root, loc)) for loc in locs]
    if not els:
        raise SvgOpError("nothing to group")
    parent = els[0].getparent()
    if parent is None or any(e.getparent() is not parent for e in els):
        raise SvgOpError("only siblings can be grouped")
    els.sort(key=parent.index)
    g = etree.Element(_SVG + "g")
    g.set("id", unique_id(root, "group"))
    els[-1].addnext(g)
    g.tail = els[-1].tail
    for e in els:
        g.append(e)
    return g.get("id", "")


def ungroup(svg: SvgFile, loc: str) -> None:
    """Replace a ``<g>`` by its children, folding its transform into theirs."""
    g = _resolve(svg.root, loc)
    if _local(g.tag) != "g":
        raise SvgOpError("not a group")
    parent = g.getparent()
    if parent is None:
        raise SvgOpError("not a group")
    for attr in _UNSPLITTABLE:
        if g.get(attr) or attr in _parse_style(g.get("style", "")):
            raise SvgOpError(
                f"this group has a {attr}, which applies to it as a whole; "
                + "ungroup it in a vector editor"
            )
    transform = g.get("transform")
    group_style = _parse_style(g.get("style", ""))
    group_opacity = group_style.pop("opacity", None) or g.get("opacity")
    group_classes = g.get("class", "").split()
    inherited = {
        name: value for name in _INHERITED if (value := g.get(name)) is not None
    }
    for child in list(g):
        if is_element(child):
            if transform:
                own = child.get("transform")
                child.set("transform", f"{transform} {own}" if own else transform)
            _inherit(child, group_style, inherited, group_classes, group_opacity)
        g.addprevious(child)
    parent.remove(g)


# Properties a child would otherwise inherit from the group it leaves. The
# child's own value, where it has one, still wins.
_INHERITED = (
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-dasharray",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-anchor",
    "color",
    "visibility",
)
# Effects that apply to a group's composite, which no split across its
# children reproduces.
_UNSPLITTABLE = ("clip-path", "mask", "filter")


def _inherit(
    child: SvgElement,
    group_style: dict[str, str],
    inherited: dict[str, str],
    group_classes: list[str],
    group_opacity: str | None,
) -> None:
    own_style = _parse_style(child.get("style", ""))
    additions: dict[str, str] = {}
    for name, value in {**inherited, **group_style}.items():
        if name not in own_style and child.get(name) is None:
            additions[name] = value
    if group_opacity is not None:
        try:
            own = float(own_style.get("opacity") or child.get("opacity") or 1)
            additions["opacity"] = f"{own * float(group_opacity):g}"
        except ValueError:
            pass
    if additions:
        set_style(child, {k: v for k, v in additions.items()})
    if group_classes:
        own_classes = child.get("class", "").split()
        own_props = {m.group(1) for c in own_classes if (m := _TOKEN_CLASS.match(c))}
        # A group's theme colour reaches the child only where the child has
        # no colour of its own.
        extra = [
            c
            for c in group_classes
            if c not in own_classes
            and not (
                (m := _TOKEN_CLASS.match(c))
                and (
                    m.group(1) in own_props
                    or m.group(1) in own_style
                    or child.get(m.group(1)) is not None
                )
            )
        ]
        if extra:
            child.set("class", " ".join([*own_classes, *extra]))


# ── Whole new files ────────────────────────────────────────────────────────────


def new_slide_svg(parent: str | None, width: float, height: float) -> bytes:
    """A blank slide SVG built on ``parent`` (an ``inkflow:parent`` value)."""
    attrs = f' inkflow:parent="{parent}"' if parent else ""
    return (
        f'<svg xmlns="{ns.SVG}" xmlns:inkflow="{ns.INKFLOW}"{attrs} '
        f'viewBox="0 0 {width:g} {height:g}" width="{width:g}" height="{height:g}">\n'
        "</svg>\n"
    ).encode()
