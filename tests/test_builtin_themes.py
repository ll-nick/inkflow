"""The themes inkflow ships besides the default one: Paper and Stage."""

from __future__ import annotations

import itertools
import math
import re
from dataclasses import asdict, fields, replace
from pathlib import Path
from typing import cast

import pytest
from click.testing import CliRunner

import inkflow
from inkflow import ColorMode, Deck, Palette, Paper, Slide, Stage, init
from inkflow.builtin_themes import THEMES, theme_id
from inkflow.charts import PALETTE
from inkflow.cli import main
from inkflow.editor import projects
from inkflow.editor.session import EditError, EditorSession
from inkflow.loaders import load_deck_styles
from inkflow.server import load_deck
from inkflow.themes import Builtin, Theme

SHIPPED: list[type[Theme]] = [Paper, Stage]
MODES = ("dark", "light")

# ── WCAG contrast and colour distance ─────────────────────────────────────────


def _rgb(hex_colour: str) -> tuple[float, float, float]:
    h = hex_colour.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))
    return r, g, b


def _linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _luminance(colour: str) -> float:
    r, g, b = (_linear(c) for c in _rgb(colour))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    lo, hi = sorted((_luminance(a), _luminance(b)))
    return (hi + 0.05) / (lo + 0.05)


def _lab(colour: str) -> tuple[float, float, float]:
    r, g, b = (_linear(c) for c in _rgb(colour))
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t: float) -> float:
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116

    return 116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))


def _palettes() -> list[tuple[str, Palette]]:
    return [
        (f"{cls.__name__}-{mode}", cast("Palette", getattr(cls, mode)))
        for cls in SHIPPED
        for mode in MODES
    ]


PALETTES = _palettes()
IDS = [name for name, _ in PALETTES]
CHROMATIC = ("red", "orange", "yellow", "green", "teal", "blue", "purple", "pink")


def test_contrast_helper_matches_wcag() -> None:
    assert contrast("#000000", "#ffffff") == pytest.approx(21)
    assert contrast("#777777", "#ffffff") == pytest.approx(4.48, abs=0.01)


# ── Tokens ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(("name", "palette"), PALETTES, ids=IDS)
def test_every_token_is_a_colour(name: str, palette: Palette) -> None:
    for f in fields(palette):
        value = cast("str", getattr(palette, f.name))
        assert re.fullmatch(r"#[0-9a-f]{6}", value), (name, f.name, value)


@pytest.mark.parametrize("cls", SHIPPED)
def test_both_palettes_are_written_out_in_full(cls: type[Theme]) -> None:
    # Set deliberately: neither palette leans on the neutral floor's values
    # for its own mode's background, text or accent.
    for mode, floor in (("dark", Theme.dark), ("light", Theme.light)):
        palette = cast("Palette", getattr(cls, mode))
        assert palette.text != floor.text and palette.accent != floor.accent
    assert asdict(cls.dark) != asdict(cls.light)


@pytest.mark.parametrize(("name", "palette"), PALETTES, ids=IDS)
def test_text_contrast(name: str, palette: Palette) -> None:
    for token in ("text", "text_muted", "link", "heading", "accent"):
        colour = cast("str", getattr(palette, token))
        for ground in ("bg", "surface"):
            ratio = contrast(colour, cast("str", getattr(palette, ground)))
            assert ratio >= 4.5, f"{name}: {token} on {ground} is {ratio:.2f}:1"
    assert contrast(palette.accent_fg, palette.accent) >= 4.5
    assert contrast(palette.code_text, palette.code_bg) >= 7


@pytest.mark.parametrize(("name", "palette"), PALETTES, ids=IDS)
def test_named_colours_read_as_code_and_carry_labels(
    name: str, palette: Palette
) -> None:
    # Syntax highlighting writes them on the code background; a pie slice or
    # a stacked bar writes accent_fg on them.
    for token in (*CHROMATIC, "grey"):
        colour = cast("str", getattr(palette, token))
        assert contrast(colour, palette.code_bg) >= 4.5, (name, token)
        assert contrast(colour, palette.bg) >= 4.5, (name, token)
        if token != "grey":
            assert contrast(palette.accent_fg, colour) >= 4.5, (name, token)


@pytest.mark.parametrize(("name", "palette"), PALETTES, ids=IDS)
def test_neighbouring_chart_series_are_far_apart(name: str, palette: Palette) -> None:
    colours = [cast("str", getattr(palette, t)) for t in PALETTE]
    for a, b in itertools.pairwise(colours):
        assert math.dist(_lab(a), _lab(b)) >= 25, (name, a, b)
    # and no two of the eight are near twins
    for i, a in enumerate(colours):
        for b in colours[i + 1 :]:
            assert math.dist(_lab(a), _lab(b)) >= 20, (name, a, b)


@pytest.mark.parametrize("cls", SHIPPED)
def test_font_families_are_the_default_themes(cls: type[Theme]) -> None:
    for family in ("body_font", "heading_font", "mono_font"):
        assert getattr(cls.typography, family) == getattr(Builtin.typography, family)
    assert cls.typography.heading_weight >= Builtin.typography.heading_weight


# ── Modes, assets, fonts ──────────────────────────────────────────────────────


def _deck(theme: Theme, **kw: object) -> Deck:
    return Deck(slides=[Slide("content")], theme=theme, **kw)  # pyright: ignore[reportArgumentType]


def test_modes() -> None:
    assert _deck(Paper()).effective_mode == ColorMode.LIGHT
    assert _deck(Stage()).effective_mode == ColorMode.DARK
    # Printed, Stage is white paper; asked for, it is black.
    assert _deck(Stage(), size="a0").effective_mode == ColorMode.LIGHT
    assert _deck(Stage(), size="a0", mode=ColorMode.DARK).effective_mode == (
        ColorMode.DARK
    )


@pytest.mark.parametrize("cls", SHIPPED)
def test_assets_and_fonts(cls: type[Theme]) -> None:
    theme = cls()
    assert theme.styles_path.is_file()
    assert theme.styles_path.parent.name == cls.__name__.lower()
    # The default theme's fonts are embedded for these themes too.
    assert theme.fonts_dir == Builtin().fonts_dir

    # A subclass in a deck.py keeps the stylesheet.
    class Mine(cls):  # type: ignore[valid-type, misc]
        light: Palette = replace(cls.light, accent="#ff0000")

    assert Mine().asset_dir() == theme.asset_dir()
    assert theme_id(Mine()) is None


def test_theme_ids() -> None:
    assert list(THEMES) == ["default", "paper", "stage"]
    assert theme_id(Builtin()) == "default"
    assert theme_id(Paper()) == "paper" and theme_id(Stage()) == "stage"
    assert {"Paper", "Stage"} <= set(inkflow.__all__)


def test_resolved_from_a_deck_py(tmp_path: Path) -> None:
    (tmp_path / "deck.py").write_text(
        "from inkflow import Deck, Paper, Slide\n\n\n"
        + "def main() -> Deck:\n"
        + '    return Deck(theme=Paper(), slides=[Slide("content", md=None)])\n',
        encoding="utf-8",
    )
    deck = load_deck(tmp_path / "deck.py")
    assert isinstance(deck.theme, Paper)


# ── Styles stay scoped to their theme ─────────────────────────────────────────


def test_default_theme_css_is_untouched(tmp_path: Path) -> None:
    css = load_deck_styles(_deck(Builtin()), tmp_path)
    for cls in SHIPPED:
        assert cls().styles_css() not in css
    assert load_deck_styles(None, tmp_path) == css


@pytest.mark.parametrize("cls", SHIPPED)
def test_theme_css_comes_after_the_built_in_layouts(
    cls: type[Theme], tmp_path: Path
) -> None:
    theme = cls()
    css = load_deck_styles(_deck(theme), tmp_path)
    builtin = Builtin().styles_css()
    assert builtin in css and theme.styles_css() in css
    assert css.index(builtin) < css.index(theme.styles_css())
    # The default theme's palette is nowhere in it.
    assert Builtin.dark.bg not in theme.render_tokens_css()


# ── init, the new-deck looks and the Theme dialog ─────────────────────────────


def test_with_theme_writes_the_theme_and_its_import() -> None:
    code = init.with_theme(
        "from inkflow import Deck, Slide, animations\n\n\ndef main() -> Deck:\n"
        + '    return Deck(\n        title="T",\n        slides=[],\n    )\n',
        "stage",
    )
    assert code.startswith("from inkflow import Deck, Slide, Stage, animations\n")
    assert '        title="T",\n        theme=Stage(),\n' in code
    assert init.with_theme("x", "default") == "x"
    with pytest.raises(ValueError, match="unknown theme"):
        init.with_theme("x", "nord")


@pytest.mark.parametrize(("name", "cls"), [("paper", Paper), ("stage", Stage)])
def test_init_theme(
    name: str, cls: type[Theme], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    runner = CliRunner()
    result = runner.invoke(main, ["init", "talk", "--no-git", "--theme", name])
    assert result.exit_code == 0, result.output
    assert isinstance(load_deck(tmp_path / "talk" / "deck.py").theme, cls)
    result = runner.invoke(
        main, ["init", "poster", "--no-git", "--poster", "--theme", name]
    )
    assert result.exit_code == 0, result.output
    deck = load_deck(tmp_path / "poster" / "deck.py")
    assert isinstance(deck.theme, cls) and deck.effective_mode == ColorMode.LIGHT


def test_init_default_theme_is_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(main, ["init", "talk", "--no-git"])
    assert result.exit_code == 0, result.output
    code = (tmp_path / "talk" / "deck.py").read_text(encoding="utf-8")
    assert "theme=" not in code
    assert type(load_deck(tmp_path / "talk" / "deck.py").theme) is Builtin
    result = CliRunner().invoke(main, ["init", "x", "--theme", "nord"])
    assert result.exit_code != 0


@pytest.fixture
def _recent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(projects, "_recent_file", lambda: tmp_path / "recent.json")


@pytest.mark.usefixtures("_recent")
@pytest.mark.parametrize(("look", "cls"), [("paper", Paper), ("stage", Stage)])
def test_new_deck_looks(look: str, cls: type[Theme], tmp_path: Path) -> None:
    deck_py = projects.create_deck(tmp_path / look, title="Mine", theme=look, git=False)
    deck = load_deck(deck_py)
    assert isinstance(deck.theme, cls) and deck.title == "Mine"
    assert (deck_py.parent / "slides" / "title.svg").is_file()


@pytest.mark.usefixtures("_recent")
def test_new_deck_info_previews_each_look() -> None:
    info = projects.new_deck_info(None, None)
    looks = {
        cast("str", t["id"]): t for t in cast("list[dict[str, object]]", info["themes"])
    }
    assert {"starter", "paper", "stage", "poster"} <= set(looks)
    paper = cast("dict[str, str]", looks["paper"]["preview"])
    stage = cast("dict[str, str]", looks["stage"]["preview"])
    assert paper["bg"] == Paper.light.bg and paper["accent"] == Paper.light.accent
    assert stage["bg"] == Stage.dark.bg
    assert cast("dict[str, str]", looks["poster"]["preview"])["bg"] == (
        Builtin.light.bg
    )


def test_theme_dialog_switches_the_deck_theme(tmp_path: Path) -> None:
    init.scaffold(tmp_path)
    deck_py = tmp_path / "deck.py"
    session = EditorSession(deck_py)
    info = cast(
        "dict[str, object]",
        session.apply({"action": "theme-get"}, load_deck(deck_py))["theme"],
    )
    assert info["theme"] == "default"
    assert [t["id"] for t in cast("list[dict[str, str]]", info["themes"])] == list(
        THEMES
    )

    session.apply({"action": "theme-set", "theme": "paper"}, load_deck(deck_py))
    code = deck_py.read_text(encoding="utf-8")
    assert "theme=Paper()" in code and "Paper" in code.splitlines()[0]
    assert isinstance(load_deck(deck_py).theme, Paper)

    session.apply(
        {"action": "theme-set", "theme": "stage", "mode": "light"},
        load_deck(deck_py),
    )
    deck = load_deck(deck_py)
    assert isinstance(deck.theme, Stage) and deck.mode == ColorMode.LIGHT
    info = cast(
        "dict[str, object]", session.apply({"action": "theme-get"}, deck)["theme"]
    )
    assert info["theme"] == "stage" and info["name"] == "Stage"

    session.apply({"action": "theme-set", "theme": "default"}, load_deck(deck_py))
    assert type(load_deck(deck_py).theme) is Builtin
    assert "theme=" not in deck_py.read_text(encoding="utf-8")
    with pytest.raises(EditError, match="unknown theme"):
        session.apply({"action": "theme-set", "theme": "nord"}, load_deck(deck_py))

    # One undoable step each.
    session.apply({"action": "undo"}, load_deck(deck_py))
    assert isinstance(load_deck(deck_py).theme, Stage)
