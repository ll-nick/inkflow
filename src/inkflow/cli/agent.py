"""Commands that connect an agent (Claude Code) to the visual editor.

``context`` reads what the author has selected in ``inkflow edit``; ``render``
shows the agent what a slide looks like; ``goto``/``select`` point the author's
editor at something; ``setup-claude`` installs the prompt hook and skill that
tie these together in a project.
"""

from __future__ import annotations

import dataclasses
import json
import os
import shutil
import sys
from importlib.resources import files
from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import deck_option, main, resolve_deck_path
from inkflow.editor.context import CONTEXT_DIR, format_context, read_context
from inkflow.logging import report
from inkflow.render import SlideBoxes, render_json, render_slides, summary

# The prompt hook stays quiet once the editor has not reported for this long.
_HOOK_MAX_AGE = 2 * 60 * 60


@main.command()
@deck_option
@click.option("--json", "as_json", is_flag=True, help="Print the raw JSON.")
@click.option(
    "--hook",
    is_flag=True,
    help="Prompt-hook mode: print nothing when stale or absent, never fail.",
)
def context(deck_path: Path, as_json: bool, hook: bool) -> None:
    """Show what is selected in the visual editor right now.

    `inkflow edit` records the current slide, build step and selection in
    `.inkflow/context.json`; this prints it as text an agent can act on (which
    file and element "this" is). `--hook` is for a Claude Code
    `UserPromptSubmit` hook (see `inkflow setup-claude`): it prints the context
    only while it is fresh and exits 0 whatever happens.
    """
    if hook:
        # Hooks receive the event JSON on stdin; nothing in it is needed here.
        if not sys.stdin.isatty():
            sys.stdin.read()
        try:
            data = read_context(deck_path.resolve().parent)
            text = format_context(data, max_age=_HOOK_MAX_AGE) if data else ""
        except Exception:
            text = ""
        if text:
            click.echo(text)
        return
    resolved = resolve_deck_path(deck_path)
    data = read_context(resolved.parent)
    if data is None:
        raise click.ClickException(
            "no editor context yet: open the deck with `inkflow edit` first"
        )
    if as_json:
        click.echo(json.dumps(data, indent=2))
    else:
        click.echo(format_context(data))


def _number(deck_path: Path, ref: str) -> int:
    """SLIDE as the presenter numbers it: a number, or a slide id."""
    ref = ref.strip()
    if ref.isdigit():
        return int(ref)
    from inkflow.cli._edits import DeckSlides

    slides = DeckSlides.load(deck_path)
    number = slides.numbers[slides.index(ref)]
    if number is None:
        raise click.BadParameter(f"slide {ref!r} is hidden", param_hint="SLIDE")
    return number


@main.command()
@deck_option
@click.option(
    "--slide",
    "-s",
    "slide",
    default=None,
    help="Show one slide (number or id) in detail: full zone texts, zone boxes, "
    + "element ids, animations as deck.py writes them.",
)
@click.option("--json", "as_json", is_flag=True, help="Print the full structure.")
@click.option(
    "--boxes",
    is_flag=True,
    help="With --slide: add every element's box as the browser draws it"
    + " (`inkflow render --boxes`; needs Chromium).",
)
def outline(deck_path: Path, slide: str | None, as_json: bool, boxes: bool) -> None:
    """Print what is on every slide, in a few lines each.

    For each slide: its number, id, title and position in deck.py's
    `slides=[...]`, its SVG and layout chain, Markdown, notes and ink files,
    its own transition, then each zone (where its content is written and the
    start of its text, or the media/chart file) and the animations with the
    clicks they take. Start here instead of reading deck.py and every file.
    """
    from inkflow.editor.outline import build_outline, format_outline, outline_json
    from inkflow.pipeline import process_deck
    from inkflow.server import load_deck

    number = None if slide is None else _number(deck_path, slide)
    if boxes and number is None:
        raise click.UsageError("--boxes needs --slide N")
    resolved = resolve_deck_path(deck_path)
    try:
        deck = load_deck(resolved)
        slides = process_deck(deck, resolved.parent, resolved, editor=True)
        result = build_outline(deck, resolved, slides)
    except Exception as exc:
        raise click.ClickException(f"cannot build the deck: {exc}") from exc
    if as_json:
        data = outline_json(result)
        if number is not None:
            picked = [
                s
                for s in cast("list[dict[str, object]]", data["slides"])
                if s["number"] == number
            ]
            if not picked:
                raise click.ClickException(f"no slide {number}")
            data = picked[0]
            if boxes:
                data["boxes"] = dataclasses.asdict(_boxes(resolved, number))
        indent = 1 if sys.stdout.isatty() else None
        click.echo(json.dumps(data, indent=indent, ensure_ascii=False))
        return
    try:
        click.echo(format_outline(result, number))
    except IndexError as exc:
        raise click.ClickException(f"no slide {number}") from exc
    if boxes and number is not None:
        click.echo("  boxes (as rendered, slide units):")
        for line in _boxes(resolved, number).text().splitlines()[1:]:
            click.echo(f"    {line}")


def _boxes(deck_path: Path, number: int) -> SlideBoxes:
    """One slide's rendered boxes (`inkflow render --boxes`)."""
    try:
        result = render_slides(
            deck_path,
            [number],
            None,
            boxes=True,
            contrast=False,
            no_sandbox=_running_as_root(),
        )
    except (RuntimeError, ValueError) as exc:
        raise click.ClickException(str(exc)) from exc
    return result.boxes[0]


def _current_slide(project_dir: Path) -> int:
    data = read_context(project_dir) or {}
    slide = cast("dict[str, object]", data.get("slide") or {})
    number = slide.get("number")
    return number if isinstance(number, int) and number > 0 else 1


@main.command()
@deck_option
@click.option(
    "--slide",
    "-s",
    "slides",
    multiple=True,
    help="Slide number (1-based) or id; repeatable. Default: the editor's current slide"
    + " (every slide with --sheet or --check).",
)
@click.option("--all", "all_slides", is_flag=True, help="Render every slide.")
@click.option(
    "--step",
    type=int,
    default=None,
    help="Build step to show (default: the final state, everything revealed).",
)
@click.option(
    "--sheet",
    is_flag=True,
    help="One contact-sheet PNG with the slides in a grid, labelled with their"
    + " numbers and ids, instead of one image per slide.",
)
@click.option(
    "--check",
    is_flag=True,
    help="Only measure the layout: write no images, exit 1 on a problem.",
)
@click.option(
    "--output",
    "-o",
    default=None,
    help="PNG file for one slide or a sheet, or a directory"
    + " (default: .inkflow/render/).",
)
@click.option(
    "--scale",
    type=float,
    default=0.5,
    show_default=True,
    help="Image scale relative to the slide's own size.",
)
@click.option(
    "--boxes",
    is_flag=True,
    help="Print every element's rendered box in slide units (ids, zones with"
    + " their content's extent and free space, each block of a zone's text);"
    + " writes no images unless --output is given.",
)
@click.option(
    "--no-contrast",
    "no_contrast",
    is_flag=True,
    help="Skip the text contrast check (two more screenshots per slide).",
)
@click.option("--json", "as_json", is_flag=True, help="Print the result as JSON.")
@click.option("--chromium", default=None, help="Path to a Chromium/Chrome binary.")
@click.option(
    "--no-sandbox", "no_sandbox", is_flag=True, help="Pass --no-sandbox to Chromium."
)
def render(
    deck_path: Path,
    slides: tuple[str, ...],
    all_slides: bool,
    step: int | None,
    sheet: bool,
    check: bool,
    output: str | None,
    scale: float,
    boxes: bool,
    no_contrast: bool,
    as_json: bool,
    chromium: str | None,
    no_sandbox: bool,
) -> None:
    """Render slides to PNG images and report layout problems.

    Uses headless Chromium, like `export`. Without `--slide`, renders the slide
    open in the visual editor (or the first). Prints the path of every image
    written, which is what an agent reads back to check its own edits, then
    one line per layout problem: text that overflows its zone, a code block cut
    off, an object outside the slide, text too small to read (a hint), text
    whose contrast with what is behind it is below 3:1 (between 3:1 and 4.5:1
    for text under 24px on a 1080px slide: a hint).

    `--sheet` puts the slides on one contact sheet (16 per image at most).
    `--check` measures without writing images and exits 1 if anything other
    than a hint was found.

    `--boxes` prints where the browser drew everything, in slide units, one
    line per element (`id  x,y wxh  kind  "text"`): each element with an id,
    each zone with the extent of its content and the space left in it, and
    each block of a zone's text (paragraph, list, heading, code, table,
    picture) with the extent of its text, so things can be placed against
    real text instead of guessed sizes.
    """
    if check and sheet:
        raise click.UsageError("--check writes no images; drop --sheet or --check")
    if boxes and sheet:
        raise click.UsageError("--boxes measures slides one by one; drop --sheet")
    resolved = resolve_deck_path(deck_path)
    project_dir = resolved.parent
    numbers: list[int] | None
    if all_slides or (not slides and (sheet or check)):
        numbers = None
    else:
        numbers = [_number(resolved, s) for s in slides] or [
            _current_slide(project_dir)
        ]
    out: Path | None = None
    # --boxes alone writes no images; with --output it does both.
    if not check and not (boxes and output is None):
        out = Path(output) if output else project_dir / CONTEXT_DIR / "render"
        if output is None:
            (project_dir / CONTEXT_DIR).mkdir(exist_ok=True)
            ignore = project_dir / CONTEXT_DIR / ".gitignore"
            if not ignore.exists():
                ignore.write_text("*\n", encoding="utf-8")
    try:
        result = render_slides(
            resolved,
            numbers,
            out,
            sheet=sheet,
            step=step,
            scale=scale,
            chromium=chromium,
            no_sandbox=no_sandbox or _running_as_root(),
            boxes=boxes,
            contrast=not no_contrast,
        )
    except (RuntimeError, ValueError) as exc:
        raise click.ClickException(str(exc)) from exc
    if as_json:
        click.echo(json.dumps(render_json(result), ensure_ascii=False))
        if check and any(f.is_problem for f in result.findings):
            sys.exit(1)
        return
    for slide_boxes in result.boxes:
        click.echo(slide_boxes.text())
    for path in result.images:
        click.echo(str(path))
    for finding in result.findings:
        click.echo(finding.message())
    if check:
        click.echo(summary(result.findings, len(result.slides)))
        if any(f.is_problem for f in result.findings):
            sys.exit(1)


def _running_as_root() -> bool:
    # Chromium refuses to start sandboxed as root (containers, CI).
    return hasattr(os, "geteuid") and os.geteuid() == 0


def _send(ws_port: int, host: str, payload: dict[str, object]) -> None:
    from websockets.sync.client import connect

    try:
        with connect(f"ws://{host}:{ws_port}", open_timeout=3) as ws:
            ws.send(json.dumps(payload))
    except OSError as exc:
        raise click.ClickException(
            f"no inkflow server on ws://{host}:{ws_port} ({exc}); "
            + "start one with `inkflow edit`"
        ) from exc


_ws_port_option = click.option(
    "--ws-port",
    type=int,
    default=None,
    help="The server's WebSocket port [default: the one editing this deck, else 7778]",
)


def _editor_ws_port(deck_path: Path, ws_port: int | None) -> int:
    """The WebSocket port of the editor open on this deck, from its context."""
    if ws_port is not None:
        return ws_port
    data = read_context(deck_path.resolve().parent) or {}
    server = data.get("server")
    if isinstance(server, dict):
        port = cast("dict[str, object]", server).get("wsPort")
        if isinstance(port, int):
            return port
    return 7778


_host_option = click.option("--host", default="localhost", show_default=True)


@main.command()
@click.argument("slide")
@deck_option
@_ws_port_option
@_host_option
def goto(slide: str, deck_path: Path, ws_port: int | None, host: str) -> None:
    """Show SLIDE (a number, 1-based, or an id) in every editor open on the deck."""
    port = _editor_ws_port(deck_path, ws_port)
    number = _number(deck_path, slide)
    _send(port, host, {"type": "editor-command", "command": "goto", "slide": number})


@main.command("select")
@click.argument("ids", nargs=-1, required=True)
@click.option("--slide", default=None, help="Go to this slide (number or id) first.")
@deck_option
@_ws_port_option
@_host_option
def select_cmd(
    ids: tuple[str, ...],
    slide: str | None,
    deck_path: Path,
    ws_port: int | None,
    host: str,
) -> None:
    """Select elements by id in every editor open on the deck."""
    port = _editor_ws_port(deck_path, ws_port)
    if slide is not None:
        number = _number(deck_path, slide)
        _send(
            port, host, {"type": "editor-command", "command": "goto", "slide": number}
        )
    _send(
        port,
        host,
        {"type": "editor-command", "command": "select", "ids": list(ids)},
    )


def _hook_command(project_dir: Path) -> str:
    """How the hook should call inkflow from the project directory."""
    if (project_dir / "pyproject.toml").exists() and shutil.which("uv"):
        return "uv run --quiet inkflow context --hook"
    return "inkflow context --hook"


def _merge_hook(settings: dict[str, object], command: str) -> bool:
    hooks = cast("dict[str, object]", settings.setdefault("hooks", {}))
    entries = cast("list[object]", hooks.setdefault("UserPromptSubmit", []))
    for entry in entries:
        inner = (
            cast("dict[str, object]", entry).get("hooks")
            if isinstance(entry, dict)
            else None
        )
        for hook in cast("list[object]", inner or []):
            if isinstance(hook, dict) and "inkflow context" in str(
                cast("dict[str, object]", hook).get("command", "")
            ):
                return False
    entries.append({"hooks": [{"type": "command", "command": command}]})
    return True


@main.command("setup-claude")
@deck_option
@click.option(
    "--command",
    "hook_command",
    default=None,
    help="Command the prompt hook runs (default: detected).",
)
def setup_claude(deck_path: Path, hook_command: str | None) -> None:
    """Set the project up for editing alongside Claude Code.

    Adds a `UserPromptSubmit` hook to `.claude/settings.json` that hands Claude
    the visual editor's current selection with every prompt (`inkflow context
    --hook`), and an `inkflow` skill in `.claude/skills/` describing the deck's
    files, the DSL and the render/verify loop. Existing settings are kept;
    running it again changes nothing.
    """
    resolved = resolve_deck_path(deck_path)
    project_dir = resolved.parent
    claude_dir = project_dir / ".claude"
    settings_path = claude_dir / "settings.json"
    settings: dict[str, object] = {}
    if settings_path.exists():
        try:
            loaded = cast("object", json.loads(settings_path.read_text("utf-8")))
        except ValueError as exc:
            raise click.ClickException(f"{settings_path} is not valid JSON") from exc
        if not isinstance(loaded, dict):
            raise click.ClickException(f"{settings_path} is not a JSON object")
        settings = cast("dict[str, object]", loaded)
    command = hook_command or _hook_command(project_dir)
    if _merge_hook(settings, command):
        claude_dir.mkdir(exist_ok=True)
        settings_path.write_text(json.dumps(settings, indent=2) + "\n", "utf-8")
        report("Added", f"prompt hook to {settings_path.relative_to(project_dir)}")
    else:
        report("Kept", "existing inkflow prompt hook", style="yellow")
    skill = claude_dir / "skills" / "inkflow" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    text = files("inkflow").joinpath("claude", "SKILL.md").read_text("utf-8")
    skill.write_text(text, encoding="utf-8")
    report("Wrote", str(skill.relative_to(project_dir)))
    report(
        "Next",
        "run `inkflow edit`, select something, and ask Claude about it",
        style="dim",
    )
