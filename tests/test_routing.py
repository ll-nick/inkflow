"""The Python port of the editor's connector and move maths, checked against the
editor's own answers (tests/data/connector_routes.json, which vitest checks
against the TypeScript): `inkflow shape` draws arrows where the editor would."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import cast

from inkflow.editor.geometry import Box as GBox
from inkflow.editor.geometry import (
    ElementGeom,
    Mat,
    format_transform,
    parse_transform,
    plan_move,
    plan_resize,
    prepend_translate,
)
from inkflow.editor.routing import (
    Bend,
    End,
    Pt,
    Site,
    endpoints_of,
    format_bend,
    js_round,
    js_str,
    parse_bend,
    parse_connection,
    path_data,
    route,
    site_by_name,
    sites_from_corners,
)

Json = dict[str, object]
FIXTURE = cast(
    "dict[str, object]",
    json.loads(
        (Path(__file__).parent / "data" / "connector_routes.json").read_text(
            encoding="utf-8"
        )
    ),
)


def cases(name: str) -> list[Json]:
    return cast("list[Json]", FIXTURE[name])


def _num(v: object) -> float:
    return float(cast("float", v))


def corners(raw: object) -> list[Pt]:
    return [Pt(_num(p["x"]), _num(p["y"])) for p in cast("list[Json]", raw)]


def site_json(s: object) -> Json | None:
    if s is None:
        return None
    site = cast("Site", s)
    return {"name": site.name, "x": site.x, "y": site.y, "dx": site.dx, "dy": site.dy}


def close(got: Json | None, want: object) -> bool:
    if got is None or want is None:
        return got is None and want is None
    w = cast("Json", want)
    return got["name"] == w["name"] and all(
        math.isclose(_num(got[k]), _num(w[k]), rel_tol=1e-12, abs_tol=1e-9)
        for k in ("x", "y", "dx", "dy")
    )


def test_sites() -> None:
    for case in cases("sites"):
        got = sites_from_corners(
            corners(case["corners"]), _num(case["per"]), bool(case["round"])
        )
        want = cast("list[Json]", case["expected"])
        assert len(got) == len(want)
        for g, w in zip(got, want, strict=True):
            assert close(site_json(g), w), (case, g)
    for case in cases("named"):
        got = site_by_name(
            corners(case["corners"]), str(case["name"]), bool(case["round"])
        )
        assert close(site_json(got), case["expected"]), case


def _end(raw: object) -> End:
    p = cast("Json", raw)
    dx, dy = p.get("dx"), p.get("dy")
    return End(
        _num(p["x"]),
        _num(p["y"]),
        None if dx is None else _num(dx),
        None if dy is None else _num(dy),
    )


def test_routes() -> None:
    for case in cases("routes"):
        raw_bend = cast("Json | None", case["bend"])
        bend = (
            Bend(str(raw_bend["axis"]), _num(raw_bend["at"]))
            if raw_bend is not None
            else None
        )
        r = route(str(case["style"]), _end(case["a"]), _end(case["b"]), bend)
        expected = cast("Json", case["expected"])
        assert path_data(r) == expected["d"], case
        want_bend = cast("Json | None", expected["bend"])
        got_bend = {"axis": r.bend.axis, "at": r.bend.at} if r.bend else None
        assert got_bend == want_bend, case


def test_bends_ends_and_connections() -> None:
    for case in cases("bends"):
        b = parse_bend(str(case["text"]))
        assert ({"axis": b.axis, "at": b.at} if b else None) == case["parsed"]
        assert (format_bend(b) if b else None) == case["formatted"]
    for case in cases("endpoints"):
        ends = endpoints_of(str(case["d"]))
        got = (
            {
                "start": {"x": ends[0].x, "y": ends[0].y},
                "end": {"x": ends[1].x, "y": ends[1].y},
            }
            if ends
            else None
        )
        assert got == case["expected"], case
    for case in cases("connections"):
        c = parse_connection(str(case["value"]) or None)
        assert ({"id": c.id, "site": c.site} if c else None) == case["expected"]


def _geom(raw: object) -> ElementGeom:
    g = cast("Json", raw)
    attrs = cast("dict[str, str | None]", g["attrs"])
    parent = cast("dict[str, float]", g["parentToSlide"])
    return ElementGeom(
        tag=str(g["tag"]),
        source_tag=str(g["tag"]),
        attrs=attrs,
        own=parse_transform(attrs.get("transform")),
        parent_to_slide=Mat(**{k: float(v) for k, v in parent.items()}),
    )


def _box(raw: object) -> GBox:
    b = cast("dict[str, float]", raw)
    return GBox(b["x"], b["y"], b["width"], b["height"])


def test_moves_and_resizes() -> None:
    for case in cases("moves"):
        kids = cast("list[dict[str, str | None]]", case["kids"])
        plan = plan_move(_geom(case["geom"]), _num(case["dx"]), _num(case["dy"]), kids)
        got: Json = {"attrs": plan.attrs}
        if plan.children is not None:
            got["children"] = plan.children
        assert got == case["expected"], case
    for case in cases("resizes"):
        got_plan = plan_resize(
            _geom(case["geom"]), _box(case["from"]), _box(case["to"])
        )
        assert got_plan == case["expected"], case
    for case in cases("prepends"):
        d = cast("dict[str, float]", case["d"])
        transform = case["transform"]
        got_t = prepend_translate(
            None if transform is None else str(transform), Pt(d["x"], d["y"])
        )
        assert got_t == case["expected"], case
    for case in cases("formats"):
        m = cast("dict[str, float]", case["matrix"])
        assert format_transform(Mat(**m)) == case["expected"], case


def test_javascript_numbers() -> None:
    # Math.round rounds halves up; String() drops ".0" and spells exponents
    # its own way.
    assert [js_round(v) for v in (12.5, -2.5, -0.4)] == [13, -2, 0]
    assert [js_str(v) for v in (13.0, 1e21, 1e-7, -0.0, 0.1 + 0.2)] == [
        "13",
        "1e+21",
        "1e-7",
        "0",
        "0.30000000000000004",
    ]
