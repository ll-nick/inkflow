from __future__ import annotations

import asyncio
import contextlib
import sys
from pathlib import Path

import click

from inkflow import git_setup, ns
from inkflow.export import build_pdf, build_static_html
from inkflow.layout import (
    inject_layout_layers,
    is_layout_current,
    resolve_chain,
    resolve_parent_path,
    strip_parent,
    with_namespaces,
)
from inkflow.manifest import Deck, MarkdownSlide
from inkflow.pipeline import clean_inkscape_svg, resolve_slide_src
from inkflow.server import load_deck
from inkflow.server import serve as _serve


@click.group()
def main() -> None:
    """Beautiful slides from SVG. Your editor, your style."""


@main.command()
@click.argument("deck", default="deck.py")
@click.option("--port", default=7777, show_default=True, help="HTTP port")
@click.option("--ws-port", default=7778, show_default=True, help="WebSocket port")
def serve(deck: str, port: int, ws_port: int) -> None:
    """Start the presentation server."""
    deck_path = Path(deck).resolve()
    if not deck_path.exists():
        raise click.ClickException(f"deck not found: {deck_path}")
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(_serve(deck_path, port, ws_port))


@main.command()
@click.argument("files", nargs=-1, required=True, type=click.Path(path_type=Path))
@click.option(
    "--stdout",
    "to_stdout",
    is_flag=True,
    help="Write to stdout instead of modifying files in place",
)
@click.option(
    "--check",
    is_flag=True,
    help="Exit non-zero if any file would be modified, without writing changes",
)
def clean(files: tuple[Path, ...], to_stdout: bool, check: bool) -> None:
    """Strip Inkscape editor metadata from SVG files."""
    if check and to_stdout:
        raise click.UsageError("--check and --stdout are mutually exclusive")
    dirty = False
    errors = False
    for p in files:
        if not p.exists():
            click.echo(f"[inkflow] clean: not found: {p}", err=True)
            errors = True
            continue
        try:
            cleaned = clean_inkscape_svg(p)
            if check:
                if cleaned != p.read_text(encoding="utf-8"):
                    click.echo(f"[inkflow] would clean: {p}", err=True)
                    dirty = True
            elif to_stdout:
                sys.stdout.write(cleaned)
            else:
                p.write_text(cleaned, encoding="utf-8")
                click.echo(f"[inkflow] cleaned {p}")
        except Exception as exc:
            click.echo(f"[inkflow] clean: error processing {p}: {exc}", err=True)
            errors = True
    if dirty or errors:
        sys.exit(1)


@main.command("setup-git")
def setup_git() -> None:
    """Configure git hooks and SVG diff driver for any git repository."""

    try:
        root = git_setup.git_root()
        textconv_cmd = git_setup.resolve_textconv(root)
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc

    hook_created = git_setup.ensure_hook(root / ".githooks")
    if hook_created:
        click.echo("[inkflow] created .githooks/pre-commit")
    else:
        click.echo("[inkflow] .githooks/pre-commit already exists, left unchanged")

    try:
        git_setup.run_git_config("core.hooksPath", ".githooks")
        click.echo("[inkflow] set git config: core.hooksPath = .githooks")
        git_setup.run_git_config("diff.inkscape-svg.textconv", textconv_cmd)
        click.echo(
            f"[inkflow] set git config: diff.inkscape-svg.textconv = {textconv_cmd}"
        )
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc

    attr_result = git_setup.ensure_gitattributes(root)
    if attr_result == "ok":
        click.echo("[inkflow] .gitattributes already up to date")
    else:
        click.echo(f"[inkflow] {attr_result} .gitattributes")

    click.echo("[inkflow] git setup complete")


@main.group()
def parent() -> None:
    """Manage slide layout parents."""


def _deck_context(deck_path: Path) -> tuple[Deck, Path]:
    resolved = deck_path.resolve()
    if not resolved.exists():
        raise click.ClickException(f"deck not found: {resolved}")
    deck_obj = load_deck(resolved)
    return deck_obj, resolved.parent


_deck_option = click.option(
    "--deck",
    "deck_path",
    default="deck.py",
    type=click.Path(path_type=Path),
    help="Path to deck.py (default: deck.py in cwd)",
)


@parent.command("get")
@click.argument("file", type=click.Path(path_type=Path))
def parent_get(file: Path) -> None:
    """Print the inkflow:parent value of a slide SVG."""
    from lxml import etree as _etree

    svg_path = Path(file).resolve()
    if not svg_path.exists():
        raise click.ClickException(f"file not found: {svg_path}")
    root = _etree.parse(svg_path).getroot()
    value = root.get(ns.INKFLOW_PARENT)
    click.echo(value if value is not None else "(no parent)")


@parent.command("set")
@click.argument("file", type=click.Path(path_type=Path))
@click.argument("parent_str", metavar="PARENT")
@_deck_option
def parent_set(file: Path, parent_str: str, deck_path: Path) -> None:
    """Set the inkflow:parent of a slide SVG and refresh its layout layers.

    PARENT is a layout name or inkflow:parent string:
    bare name (three-level search), 'local:foo', 'theme:foo', 'builtin:foo',
    or a relative path.
    """
    from lxml import etree as _etree

    svg_path = Path(file).resolve()
    if not svg_path.exists():
        raise click.ClickException(f"file not found: {svg_path}")

    deck_obj, project_dir = _deck_context(deck_path)

    try:
        resolve_parent_path(parent_str, svg_path, project_dir, deck_obj.theme)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc

    tree = _etree.parse(svg_path)
    root = tree.getroot()
    old_parent = root.get(ns.INKFLOW_PARENT)

    root = with_namespaces(root, {"inkflow": ns.INKFLOW})
    root.set(ns.INKFLOW_PARENT, parent_str)
    svg_path.write_text(
        _etree.tostring(root, encoding="unicode", xml_declaration=False),
        encoding="utf-8",
    )

    if old_parent is not None:
        click.echo(f"[inkflow] {svg_path.name}: parent {old_parent!r} → {parent_str!r}")
    else:
        click.echo(f"[inkflow] {svg_path.name}: parent set to {parent_str!r}")

    chain = resolve_chain(svg_path, project_dir, deck_obj.theme)
    if chain:
        inject_layout_layers(svg_path, chain)
        click.echo(f"[injected]    {svg_path.name}")


@parent.command("strip")
@click.argument("file", required=False, type=click.Path(path_type=Path))
@click.option(
    "-y", "--yes", "confirmed", is_flag=True, help="Skip confirmation prompt."
)
@_deck_option
def parent_strip(file: Path | None, confirmed: bool, deck_path: Path) -> None:
    """Remove inkflow:parent and injected layout layers from slide SVG(s).

    If FILE is omitted, strips all slides in the deck.
    """

    if file is not None:
        svg_path = Path(file).resolve()
        if not svg_path.exists():
            raise click.ClickException(f"file not found: {svg_path}")
        if not confirmed:
            click.confirm(
                f"Remove inkflow:parent and injected layers from {svg_path.name}?",
                abort=True,
            )
        had_parent = strip_parent(svg_path)
        click.echo(
            f"[stripped]    {svg_path.name}"
            if had_parent
            else f"[no parent]   {svg_path.name}"
        )
    else:
        deck_obj, project_dir = _deck_context(deck_path)
        slides = [s for s in deck_obj.slides if not isinstance(s, MarkdownSlide)]
        if not confirmed:
            n = len(slides)
            click.confirm(
                f"Remove inkflow:parent and injected layers from {n} slide(s)?",
                abort=True,
            )
        for slide in slides:
            svg_path = resolve_slide_src(slide.src, project_dir)
            had_parent = strip_parent(svg_path)
            click.echo(
                f"[stripped]    {slide.src}"
                if had_parent
                else f"[no parent]   {slide.src}"
            )


@parent.command("inject")
@click.argument("file", required=False, type=click.Path(path_type=Path))
@click.option(
    "--check",
    is_flag=True,
    help="Report stale files without rewriting. Exits 1 if any are stale.",
)
@_deck_option
def parent_inject(file: Path | None, check: bool, deck_path: Path) -> None:
    """Refresh ancestor layout layers in slide SVG(s) for editor preview.

    If FILE is omitted, refreshes all slides in the deck.
    """
    deck_obj, project_dir = _deck_context(deck_path)
    stale_found = False

    if file is not None:
        svg_path = Path(file).resolve()
        if not svg_path.exists():
            raise click.ClickException(f"file not found: {svg_path}")
        chain = resolve_chain(svg_path, project_dir, deck_obj.theme)
        if not chain:
            click.echo(f"[no parent]   {svg_path.name}")
            return
        if check:
            if is_layout_current(svg_path, chain):
                click.echo(f"[ok]     {svg_path.name}")
            else:
                click.echo(f"[stale]  {svg_path.name}")
                sys.exit(1)
        else:
            changed = inject_layout_layers(svg_path, chain)
            click.echo(
                f"[injected]    {svg_path.name}"
                if changed
                else f"[up to date]  {svg_path.name}"
            )
        return

    for slide in deck_obj.slides:
        if isinstance(slide, MarkdownSlide):
            continue
        svg_path = resolve_slide_src(slide.src, project_dir)
        chain = resolve_chain(svg_path, project_dir, deck_obj.theme)
        if not chain:
            continue
        if check:
            if is_layout_current(svg_path, chain):
                click.echo(f"[ok]     {slide.src}")
            else:
                click.echo(f"[stale]  {slide.src}")
                stale_found = True
        else:
            changed = inject_layout_layers(svg_path, chain)
            click.echo(
                f"[injected]    {slide.src}"
                if changed
                else f"[up to date]  {slide.src}"
            )

    if check and stale_found:
        sys.exit(1)


@parent.command("list")
@_deck_option
def parent_list(deck_path: Path) -> None:
    """List all slides and their inkflow:parent values."""
    from lxml import etree as _etree

    deck_obj, project_dir = _deck_context(deck_path)

    for slide in deck_obj.slides:
        if isinstance(slide, MarkdownSlide):
            click.echo(f"{'[markdown: ' + slide.template + ']':<45} (markdown slide)")
            continue
        svg_path = resolve_slide_src(slide.src, project_dir)
        root = _etree.parse(svg_path).getroot()
        value = root.get(ns.INKFLOW_PARENT) or "(no parent)"
        click.echo(f"{slide.src!s:<45} {value}")


@main.command("add")
@click.argument("parent")
@click.argument("output", type=click.Path(path_type=Path))
@click.option(
    "--deck",
    "deck_path",
    default="deck.py",
    type=click.Path(path_type=Path),
    help="Path to deck.py (default: deck.py in cwd)",
)
def add_slide(parent: str, output: Path, deck_path: Path) -> None:
    """Create a new slide SVG wired to a layout parent.

    PARENT is a layout name or inkflow:parent string:
    bare name (three-level search), 'local:foo', 'theme:foo', 'builtin:foo',
    or a relative path. OUTPUT is the path for the new SVG file.
    """
    from lxml import etree as _etree

    resolved_deck = Path(deck_path).resolve()
    if not resolved_deck.exists():
        raise click.ClickException(f"deck not found: {resolved_deck}")

    deck_obj = load_deck(resolved_deck)
    project_dir = resolved_deck.parent
    output_path = Path(output).resolve()

    if output_path.exists():
        raise click.ClickException(f"file already exists: {output_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Resolve parent to get viewBox from the parent SVG if available.
    try:
        parent_abs = resolve_parent_path(
            parent, output_path, project_dir, deck_obj.theme
        )
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc

    view_box = "0 0 1920 1080"
    width = "1920"
    height = "1080"
    if parent_abs.exists():
        anc_root = _etree.parse(parent_abs).getroot()
        if anc_root.get("viewBox"):
            view_box = anc_root.get("viewBox", view_box)
            width = anc_root.get("width", width)
            height = anc_root.get("height", height)

    svg_content = (
        f'<svg xmlns="{ns.SVG}"\n'
        f'     xmlns:inkflow="{ns.INKFLOW}"\n'
        f'     inkflow:parent="{parent}"\n'
        f'     viewBox="{view_box}" width="{width}" height="{height}">\n'
        f"</svg>\n"
    )
    output_path.write_text(svg_content, encoding="utf-8")

    chain = resolve_chain(output_path, project_dir, deck_obj.theme)
    if chain:
        inject_layout_layers(output_path, chain)

    output_rel = output_path.relative_to(project_dir)
    click.echo(f"[inkflow] created {output_rel}")
    click.echo("[inkflow] add to deck.py:")
    click.echo(f'    Slide("{output_rel}"),')


@main.command("build")
@click.argument("deck", default="deck.py")
@click.option(
    "--output",
    "-o",
    default=None,
    help="Output directory (default: build/ next to deck.py)",
)
def build_cmd(deck: str, output: str | None) -> None:
    """Export a self-contained presentation directory for offline use."""
    deck_path = Path(deck).resolve()
    if not deck_path.exists():
        raise click.ClickException(f"deck not found: {deck_path}")
    out_dir = Path(output).resolve() if output else deck_path.parent / "build"
    build_static_html(deck_path, out_dir)
    click.echo(f"[inkflow] built {out_dir / 'index.html'}")


@main.command("export")
@click.argument("deck", default="deck.py")
@click.option(
    "--output",
    "-o",
    default=None,
    help="Output PDF path (default: <deck-stem>.pdf next to deck.py)",
)
@click.option(
    "--chromium",
    default=None,
    help="Path to chromium/chrome binary (auto-detected if not set)",
)
@click.option(
    "--no-sandbox",
    "no_sandbox",
    is_flag=True,
    help="Pass --no-sandbox to Chromium (needed when running as root or in Docker).",
)
def export_cmd(
    deck: str, output: str | None, chromium: str | None, no_sandbox: bool
) -> None:
    """Export a PDF via headless Chromium (one page per slide)."""
    deck_path = Path(deck).resolve()
    if not deck_path.exists():
        raise click.ClickException(f"deck not found: {deck_path}")
    out = Path(output).resolve() if output else deck_path.with_suffix(".pdf")
    try:
        build_pdf(deck_path, out, chromium, no_sandbox)
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc
    click.echo(f"[inkflow] exported {out}")
