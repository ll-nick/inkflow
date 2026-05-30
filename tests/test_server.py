# pyright: reportPrivateUsage=false
from __future__ import annotations

import json
from collections.abc import Generator
from pathlib import Path

import pytest

import inkflow.server as _server
from inkflow.manifest import Deck


@pytest.fixture(autouse=True)
def _reset_state() -> Generator[None, None, None]:  # pyright: ignore[reportUnusedFunction]
    """Restore the server's module-level state after each test."""
    slides: list[str] = list(_server._state["slides"])
    transitions: list[dict[str, object]] = list(_server._state["transitions"])
    error: str | None = _server._state["error"]
    yield
    _server._state["slides"] = slides
    _server._state["transitions"] = transitions
    _server._state["error"] = error


# ── _build_html ───────────────────────────────────────────────────────────────

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
    html = _server._build_html(7778, "", True).decode()
    for token in _TOKENS:
        assert token not in html, f"unreplaced token: {token}"


def test_build_html_returns_bytes() -> None:
    result = _server._build_html(7778, "", True)
    assert isinstance(result, bytes)
    assert result  # non-empty


def test_build_html_ws_port_embedded() -> None:
    html = _server._build_html(9001, "", True).decode()
    assert "9001" in html


def test_build_html_styles_css_embedded() -> None:
    html = _server._build_html(7778, "body { color: hotpink; }", True).decode()
    assert "body { color: hotpink; }" in html


def test_build_html_dark_mode() -> None:
    dark = _server._build_html(7778, "", True).decode()
    light = _server._build_html(7778, "", False).decode()
    assert dark != light


def test_build_html_light_mode_data_theme() -> None:
    html = _server._build_html(7778, "", False).decode()
    assert "light" in html


def test_build_html_slides_json_embedded() -> None:
    _server._state["slides"] = ["<svg>a</svg>", "<svg>b</svg>"]
    html = _server._build_html(7778, "", True).decode()
    assert json.dumps(["<svg>a</svg>", "<svg>b</svg>"]) in html


def test_build_html_error_json_embedded() -> None:
    _server._state["error"] = "traceback goes here"
    html = _server._build_html(7778, "", True).decode()
    assert "traceback goes here" in html


def test_build_html_null_error_when_no_error() -> None:
    _server._state["error"] = None
    html = _server._build_html(7778, "", True).decode()
    assert "null" in html


def test_build_html_transitions_json_embedded() -> None:
    _server._state["transitions"] = [{"type": "fade"}]
    html = _server._build_html(7778, "", True).decode()
    assert json.dumps([{"type": "fade"}]) in html


# ── _load_styles ──────────────────────────────────────────────────────────────


def test_load_styles_base_css_always_present(tmp_path: Path) -> None:
    result = _server._load_styles(Deck(), tmp_path)
    assert result  # non-empty — base package CSS is always included


def test_load_styles_no_theme_no_project(tmp_path: Path) -> None:
    result = _server._load_styles(Deck(), tmp_path)
    assert "/* project */" not in result
    assert "/* theme */" not in result


def test_load_styles_appends_project_css(tmp_path: Path) -> None:
    (tmp_path / "styles.css").write_text("/* project */", encoding="utf-8")
    result = _server._load_styles(Deck(), tmp_path)
    assert "/* project */" in result


def test_load_styles_appends_theme_css(tmp_path: Path) -> None:
    theme_dir = tmp_path / "my-theme"
    theme_dir.mkdir()
    (theme_dir / "styles.css").write_text("/* theme */", encoding="utf-8")
    result = _server._load_styles(Deck(theme="./my-theme"), tmp_path)
    assert "/* theme */" in result


def test_load_styles_theme_without_css_no_crash(tmp_path: Path) -> None:
    (tmp_path / "my-theme").mkdir()
    result = _server._load_styles(Deck(theme="./my-theme"), tmp_path)
    assert result  # base CSS still returned


def test_load_styles_named_theme_silently_ignored(tmp_path: Path) -> None:
    # named themes raise ValueError in resolve_theme_dir — must be swallowed
    result = _server._load_styles(Deck(theme="nonexistent-named-theme"), tmp_path)
    assert result  # base CSS still returned, no crash


def test_load_styles_ordering(tmp_path: Path) -> None:
    (tmp_path / "theme").mkdir()
    (tmp_path / "theme" / "styles.css").write_text("/* theme */", encoding="utf-8")
    (tmp_path / "styles.css").write_text("/* project */", encoding="utf-8")
    result = _server._load_styles(Deck(theme="./theme"), tmp_path)
    theme_pos = result.index("/* theme */")
    project_pos = result.index("/* project */")
    assert theme_pos < project_pos
