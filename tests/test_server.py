from __future__ import annotations

import json
from pathlib import Path
from typing import cast

from inkflow.manifest import ColorMode
from inkflow.server import (
    State,
    _coerce_nav_position,  # pyright: ignore[reportPrivateUsage]
    _resolve_asset,  # pyright: ignore[reportPrivateUsage]
    build_html,
)

_EMPTY_STATE: State = {
    "slides": [],
    "transitions": [],
    "ws_clients": set(),
    "error": None,
    "styles_css": "",
    "scripts_js": "",
    "mode": ColorMode.DARK,
    "position": {"slideIndex": 0, "step": 0},
}


def _state(**overrides: object) -> State:
    return cast(State, {**_EMPTY_STATE, **overrides})  # pyright: ignore[reportInvalidCast]


# ── build_html ────────────────────────────────────────────────────────────────

_TOKENS = [
    "__CSS__",
    "__JS__",
    "__STYLES__",
    "__DATA_THEME__",
    "__SLIDES_JSON__",
    "__WS_PORT__",
    "__ERROR_JSON__",
    "__TRANSITIONS_JSON__",
]


def test_build_html_no_tokens_remain() -> None:
    html = build_html(_state(), ws_port=7778).decode()
    for token in _TOKENS:
        assert token not in html, f"unreplaced token: {token}"


def test_build_html_returns_bytes() -> None:
    result = build_html(_state(), ws_port=7778)
    assert isinstance(result, bytes)
    assert result  # non-empty


def test_build_html_ws_port_embedded() -> None:
    html = build_html(_state(), ws_port=9001).decode()
    assert "9001" in html


def test_build_html_ws_port_null_when_none() -> None:
    html = build_html(_state(), ws_port=None).decode()
    assert "null" in html


def test_build_html_styles_css_embedded() -> None:
    html = build_html(
        _state(styles_css="body { color: hotpink; }"), ws_port=7778
    ).decode()
    assert "body { color: hotpink; }" in html


def test_build_html_dark_mode() -> None:
    dark = build_html(_state(mode=ColorMode.DARK), ws_port=7778).decode()
    light = build_html(_state(mode=ColorMode.LIGHT), ws_port=7778).decode()
    assert dark != light


def test_build_html_light_mode_data_theme() -> None:
    html = build_html(_state(mode=ColorMode.LIGHT), ws_port=7778).decode()
    assert "light" in html


def test_build_html_slides_json_embedded() -> None:
    html = build_html(
        _state(slides=["<svg>a</svg>", "<svg>b</svg>"]), ws_port=7778
    ).decode()
    assert json.dumps(["<svg>a</svg>", "<svg>b</svg>"]) in html


def test_build_html_error_json_embedded() -> None:
    html = build_html(_state(error="traceback goes here"), ws_port=7778).decode()
    assert "traceback goes here" in html


def test_build_html_null_error_when_no_error() -> None:
    html = build_html(_state(error=None), ws_port=7778).decode()
    assert "null" in html


def test_build_html_transitions_json_embedded() -> None:
    html = build_html(_state(transitions=[{"type": "fade"}]), ws_port=7778).decode()
    assert json.dumps([{"type": "fade"}]) in html


# ── _resolve_asset ────────────────────────────────────────────────────────────


def test_resolve_asset_path_traversal(tmp_path: Path) -> None:
    assert _resolve_asset(tmp_path, "/../etc/passwd.png") is None


def test_resolve_asset_url_encoded_traversal(tmp_path: Path) -> None:
    assert _resolve_asset(tmp_path, "/%2e%2e/etc/passwd.png") is None


def test_resolve_asset_disallowed_suffix(tmp_path: Path) -> None:
    (tmp_path / "secret.txt").write_bytes(b"secret")
    assert _resolve_asset(tmp_path, "/secret.txt") is None


def test_resolve_asset_missing_file(tmp_path: Path) -> None:
    assert _resolve_asset(tmp_path, "/nonexistent.png") is None


def test_resolve_asset_valid(tmp_path: Path) -> None:
    img = tmp_path / "slide.png"
    img.write_bytes(b"\x89PNG")
    result = _resolve_asset(tmp_path, "/slide.png")
    assert result == img


def test_resolve_asset_symlink_outside_project(tmp_path: Path) -> None:
    # A symlink inside project_dir that points outside it should be served.
    outside = tmp_path / "shared"
    outside.mkdir()
    real_img = outside / "photo.png"
    real_img.write_bytes(b"\x89PNG")
    project = tmp_path / "project"
    project.mkdir()
    (project / "photo.png").symlink_to(real_img)
    result = _resolve_asset(project, "/photo.png")
    assert result == real_img.resolve()


# ── _coerce_nav_position ──────────────────────────────────────────────────────


def test_coerce_nav_non_numeric_index_is_dropped() -> None:
    assert _coerce_nav_position({"slideIndex": "x", "step": 0}, 5) is None


def test_coerce_nav_null_index_is_dropped() -> None:
    assert _coerce_nav_position({"slideIndex": None, "step": 0}, 5) is None


def test_coerce_nav_non_numeric_step_is_dropped() -> None:
    assert _coerce_nav_position({"slideIndex": 2, "step": "y"}, 5) is None


def test_coerce_nav_clamps_high_index() -> None:
    assert _coerce_nav_position({"slideIndex": 99, "step": 3}, 5) == {
        "slideIndex": 4,
        "step": 3,
    }


def test_coerce_nav_clamps_negative_index_and_step() -> None:
    assert _coerce_nav_position({"slideIndex": -2, "step": -1}, 5) == {
        "slideIndex": 0,
        "step": 0,
    }


def test_coerce_nav_empty_deck_pins_index_to_zero() -> None:
    assert _coerce_nav_position({"slideIndex": 2, "step": 1}, 0) == {
        "slideIndex": 0,
        "step": 1,
    }


def test_coerce_nav_defaults_when_fields_absent() -> None:
    assert _coerce_nav_position({}, 5) == {"slideIndex": 0, "step": 0}
