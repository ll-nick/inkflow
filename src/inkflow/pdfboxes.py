"""Exact page boxes for a PDF Chromium printed.

Chromium lays a page out at the CSS ``@page`` size but writes its PDF page on
a grid of about 1/75 inch, so an A0 page (2383.94 x 3370.39 pt) comes out as
2383.92 x 3370.08 pt, content anchored at the top-left corner. A print shop
checks the page size, so `set_page_boxes` rewrites each page's ``/MediaBox``
to the size asked for, aligned with the content, and adds the ``/TrimBox``
and ``/BleedBox`` a print workflow reads when there is bleed.

Only the page dictionaries change: the file is re-assembled object by object
from its cross-reference table with new offsets. A file of another shape
than Chromium writes (object streams, incremental updates) is left as it is.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from inkflow.logging import logger

__all__ = ["PageBoxes", "set_page_boxes"]


@dataclass(frozen=True)
class PageBoxes:
    """What one page should be, in points: the whole sheet, and the bleed and
    trimmed page inside it (each inset from the sheet's edges)."""

    width: float
    height: float
    trim_inset: float = 0.0
    """From the sheet's edge to the trimmed page (bleed plus any mark space)."""
    bleed: float = 0.0
    """How far past the trimmed page the print runs."""


_XREF = re.compile(rb"startxref\s+(\d+)\s+%%EOF\s*$")
_OBJ = re.compile(rb"\s*(\d+)\s+(\d+)\s+obj\b")
_MEDIABOX = re.compile(rb"/MediaBox\s*\[\s*([-\d.\s]+)\]")
_REF = rb"(\d+)\s+\d+\s+R"


def _num(value: float) -> str:
    text = f"{value:.4f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def _box(x0: float, y0: float, x1: float, y1: float) -> bytes:
    return f"[{_num(x0)} {_num(y0)} {_num(x1)} {_num(y1)}]".encode()


def set_page_boxes(path: Path, pages: list[PageBoxes]) -> bool:
    """Give each page of the PDF at ``path`` its exact boxes. Returns whether
    the file was rewritten (it is left alone when its layout is unexpected or
    its page count is not ``len(pages)``)."""
    try:
        data = path.read_bytes()
        fixed = _rewrite(data, pages)
    except (OSError, ValueError, IndexError) as exc:
        logger.debug(f"PDF page boxes left as printed: {exc}")
        return False
    if fixed is None:
        return False
    path.write_bytes(fixed)
    return True


def _rewrite(data: bytes, pages: list[PageBoxes]) -> bytes | None:
    tail = _XREF.search(data[-64:] if len(data) > 64 else data)
    if tail is None:
        return None
    xref_at = int(tail.group(1))
    section = data[xref_at:]
    head = re.match(rb"xref\s+0\s+(\d+)\s+", section)
    if head is None:
        return None  # an xref stream, or several sections
    count = int(head.group(1))
    entries = section[head.end() : head.end() + 20 * count]
    trailer_at = section.find(b"trailer", head.end())
    if trailer_at < 0 or b"/Prev" in section[trailer_at:]:
        return None
    trailer = section[trailer_at : section.find(b"startxref", trailer_at)]

    offsets: dict[int, int] = {}
    for n in range(count):
        line = entries[20 * n : 20 * n + 20]
        if line[17:18] == b"n":
            offsets[n] = int(line[:10])
    order = sorted(offsets, key=offsets.__getitem__)
    bounds = [offsets[n] for n in order] + [xref_at]
    objects = {n: data[bounds[i] : bounds[i + 1]] for i, n in enumerate(order)}
    for n, body in objects.items():
        m = _OBJ.match(body)
        if m is None or int(m.group(1)) != n:
            return None

    page_ids = _pages(objects, trailer)
    if page_ids is None or len(page_ids) != len(pages):
        return None
    for n, want in zip(page_ids, pages, strict=True):
        objects[n] = _fix_page(objects[n], want)

    out = bytearray(data[: bounds[0]])
    new_offsets: dict[int, int] = {}
    for n in order:
        new_offsets[n] = len(out)
        out += objects[n]
    xref = len(out)
    out += f"xref\n0 {count}\n".encode()
    for n in range(count):
        if n in new_offsets:
            generation = entries[20 * n + 11 : 20 * n + 16]
            out += f"{new_offsets[n]:010d} ".encode() + generation + b" n \n"
        else:
            out += entries[20 * n : 20 * n + 20]
    out += trailer + f"startxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def _pages(objects: dict[int, bytes], trailer: bytes) -> list[int] | None:
    """The page objects in reading order, from the page tree."""
    root = re.search(rb"/Root\s+" + _REF, trailer)
    if root is None:
        return None
    catalog = objects.get(int(root.group(1)), b"")
    top = re.search(rb"/Pages\s+" + _REF, catalog)
    if top is None:
        return None
    found: list[int] = []

    def walk(n: int, depth: int) -> bool:
        body = objects.get(n)
        if body is None or depth > 32:
            return False
        if re.search(rb"/Type\s*/Pages\b", body):
            kids = re.search(rb"/Kids\s*\[([^\]]*)\]", body)
            if kids is None:
                return False
            refs = [int(m.group(1)) for m in re.finditer(_REF, kids.group(1))]
            return all(walk(k, depth + 1) for k in refs)
        if re.search(rb"/Type\s*/Page\b", body):
            found.append(n)
            return True
        return False

    return found if walk(int(top.group(1)), 0) else None


def _fix_page(body: bytes, want: PageBoxes) -> bytes:
    m = _MEDIABOX.search(body)
    if m is None:
        raise ValueError("a page without a MediaBox")
    x0, _, _, y1 = (float(v) for v in m.group(1).split())
    # The content hangs from the top-left corner of the box Chromium wrote.
    top = y1
    bottom = top - want.height
    left = x0
    boxes = b"/MediaBox " + _box(left, bottom, left + want.width, top)
    if want.trim_inset > 0:
        t = want.trim_inset
        b = want.bleed
        right = left + want.width
        boxes += b"\n/BleedBox " + _box(
            left + t - b, bottom + t - b, right - t + b, top - t + b
        )
        boxes += b"\n/TrimBox " + _box(left + t, bottom + t, right - t, top - t)
    return body[: m.start()] + boxes + body[m.end() :]
