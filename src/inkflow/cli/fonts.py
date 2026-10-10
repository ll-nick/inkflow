"""``inkflow fonts`` and ``inkflow pack``: a deck that looks the same on every
machine.

``fonts`` reports where each font the deck uses comes from (``fontreport``);
``fonts bundle`` and ``fonts set`` change the deck through the editor session
(``editor/remote.py``), so with an editor open they are one undoable
"Agent: …" step there. ``pack`` does every fix at once (``pack.py``) the same
way, then optionally zips the deck's source tree.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import Project, deck_option, main
from inkflow.cli._edits import DeckSlides, apply_edit
from inkflow.editor.remote import RemoteEditError, apply_request
from inkflow.fontreport import FamilyReport, Where, font_report
from inkflow.logging import console, report
from inkflow.pack import make_zip, tools_needed

_STYLE = {
    Where.PROJECT: "green",
    Where.THEME: "green",
    Where.MACHINE: "yellow",
    Where.MISSING: "red",
    Where.GENERIC: "yellow",
}


def _print_family(family: FamilyReport, project_dir: Path) -> None:
    faces = ", ".join(f.label for f in family.faces)
    report(
        family.where.value,
        f"{family.family}  [{faces}]  ({', '.join(family.used_by[:3])}"
        + (" …" if len(family.used_by) > 3 else "")
        + ")",
        style=_STYLE[family.where],
    )
    for file in family.files:
        try:
            shown = file.path.relative_to(project_dir).as_posix()
        except ValueError:
            shown = str(file.path)
        report("", f"{shown}", style="dim")
    if family.licence is not None and family.where is Where.MACHINE:
        licence = family.licence
        name = licence.name or "no licence found"
        report("", f"licence: {name} ({licence.status})", style="dim")
    if not family.portable:
        report("", family.message(), style=_STYLE[family.where])


@main.group("fonts", invoke_without_command=True)
@deck_option
@click.option("--json", "as_json", is_flag=True, help="Print the report as JSON.")
@click.pass_context
def fonts_group(ctx: click.Context, deck_path: Path, as_json: bool) -> None:
    """Where each font the deck uses comes from.

    Every family the deck names (theme font tokens, styles.css, SVG text,
    Markdown and chart text), with the weights and styles it uses, resolves
    to one of: `project` (the deck's fonts/, committed), `theme` (shipped
    with inkflow or the deck's theme), `machine` (this computer's font
    folders only: other machines show another font), `missing` (nowhere), or
    `generic` (a stack starting with sans-serif/serif/monospace: each OS
    picks its own). `inkflow fonts bundle` copies the `machine` ones into
    fonts/.
    """
    if ctx.invoked_subcommand is not None:
        ctx.obj = {"deck": deck_path}
        return
    project = Project.load(deck_path)
    result = font_report(project.deck, project.dir)
    if as_json:
        click.echo(json.dumps(result.json(project.dir), indent=2))
        return
    if not result.families:
        report("Fonts", "the deck names no font", style="dim")
        return
    for family in result.families:
        _print_family(family, project.dir)
    problems = result.problems
    if problems:
        report(
            "Portable",
            f"no: {len(problems)} of {len(result.families)} famil"
            + ("y" if len(result.families) == 1 else "ies")
            + " depend on this machine",
            style="yellow",
        )
    else:
        report("Portable", "every font travels with the deck")


def _deck(ctx: click.Context, deck_path: Path | None) -> Path:
    if deck_path is not None and deck_path != Path("deck.py"):
        return deck_path
    parent = cast("dict[str, object] | None", ctx.obj)
    if isinstance(parent, dict) and isinstance(parent.get("deck"), Path):
        return cast("Path", parent["deck"])
    return deck_path or Path("deck.py")


@fonts_group.command("bundle")
@deck_option
@click.option(
    "--all-weights",
    is_flag=True,
    help="Copy every file of each family, not only the weights the deck uses.",
)
@click.option("-n", "--dry-run", is_flag=True, help="Only say what would be copied.")
@click.argument("families", nargs=-1)
@click.pass_context
def fonts_bundle(
    ctx: click.Context,
    deck_path: Path,
    all_weights: bool,
    dry_run: bool,
    families: tuple[str, ...],
) -> None:
    """Copy the fonts only this computer has into the deck's fonts/.

    Each family goes to fonts/<family>/ with the files for the weights and
    styles the deck uses (a variable font is one file), the licence files
    found beside it (OFL.txt, LICENSE*, README*), and a line in
    fonts/README.md (family, where it came from, licence). A font whose
    licence forbids sharing, or that has none, is copied with a warning: a
    well-known system font (Arial, Segoe UI, SF Pro, Calibri…) cannot be
    shared, use an open alternative. FAMILIES limits it to those.
    """
    slides = DeckSlides.load(_deck(ctx, deck_path))
    request: dict[str, object] = {
        "action": "fonts",
        "op": "bundle",
        "allWeights": all_weights,
        **({"families": list(families)} if families else {}),
    }
    if dry_run:
        try:
            applied = apply_request(
                slides.path, slides.deck, slides.hash, {**request, "dryRun": True}
            )
        except RemoteEditError as exc:
            raise click.ClickException(str(exc)) from exc
    else:
        applied = apply_edit(slides, request, "Bundle fonts into the deck")
    plan = cast("dict[str, object]", applied.result.get("bundle") or {})
    _print_bundle(plan, dry_run)


def _print_bundle(plan: dict[str, object], dry_run: bool) -> None:
    copies = cast("list[dict[str, str]]", plan.get("copies") or [])
    if dry_run:
        for copy in copies:
            report("Would copy", f"{copy['from']} -> {copy['to']}", style="yellow")
    if not copies and not dry_run:
        report("Fonts", "nothing to bundle: no font comes from this machine only")
    for warning in cast("list[str]", plan.get("warnings") or []):
        report("Licence", warning, style="yellow")
    for missing in cast("list[str]", plan.get("missing") or []):
        report("Missing", missing, style="red")


@fonts_group.command("set")
@deck_option
@click.argument("role", type=click.Choice(["body", "heading", "mono"]))
@click.argument("family")
@click.option(
    "--no-bundle", is_flag=True, help="Only set the font; do not copy its files in."
)
@click.pass_context
def fonts_set(
    ctx: click.Context, deck_path: Path, role: str, family: str, no_bundle: bool
) -> None:
    """Use FAMILY for the deck's body, heading or mono (code) text.

    Writes the theme token (--inkflow-ROLE-font) in the project's styles.css,
    as the editor's Theme dialog does, with a generic fallback after it
    (`Inter` becomes `Inter, sans-serif`; a whole stack is kept as given),
    and bundles the family into fonts/ when it is installed on this machine
    only. A generic family first (sans-serif, monospace…) is refused: each
    machine would show its own font.
    """
    slides = DeckSlides.load(_deck(ctx, deck_path))
    applied = apply_edit(
        slides,
        {
            "action": "fonts",
            "op": "set",
            "role": role,
            "family": family,
            "bundle": not no_bundle,
        },
        f"Font: {role} = {family}",
    )
    result = applied.result
    info = cast("dict[str, object] | None", result.get("family"))
    if info is not None:
        where = str(info.get("where"))
        message = str(info.get("message") or "")
        if where in ("project", "theme"):
            report("Font", f"{info.get('family')} comes with the deck ({where})")
        elif message:
            bundled = cast("dict[str, object]", result.get("bundle") or {})
            if bundled.get("copies"):
                report("Bundled", f"{info.get('family')} into fonts/")
                _print_bundle(bundled, False)
            else:
                report("Font", message, style="yellow")
    note = result.get("note")
    if isinstance(note, str):
        report("Note", note, style="yellow")


# ── pack ──


@main.command("pack")
@deck_option
@click.option(
    "--zip",
    "zip_path",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    metavar="FILE",
    help="Also zip the packed deck's source tree (for someone without git).",
)
@click.option("-n", "--dry-run", is_flag=True, help="Only say what packing would do.")
@click.option(
    "--with-pdf-pages",
    is_flag=True,
    help="Convert PDF figures now and commit the SVG pages beside each PDF.",
)
@click.option(
    "--all-weights", is_flag=True, help="Bundle every weight of each font family."
)
def pack_cmd(
    deck_path: Path,
    zip_path: Path | None,
    dry_run: bool,
    with_pdf_pages: bool,
    all_weights: bool,
) -> None:
    """Make the deck self-contained: a clone builds and looks the same anywhere.

    Copies the fonts only this computer has into fonts/ (with licences),
    copies in every file the deck names outside its folder or through a
    symlink (references rewritten where they are written), pins inkflow (and
    a pip-installed theme) in pyproject.toml and runs `uv lock` when there is
    no uv.lock, and adds LF line-ending rules, the SVG diff driver and Git
    LFS rules (unless opted out) to the deck's .gitattributes. With an editor
    open it is one undoable step there. Then it lists what still depends on
    the machine: generic or missing fonts, pictures from the web, emoji and
    formulas without a font in the deck, PDF figures without committed pages
    (`--with-pdf-pages`), and the tools a build needs.
    """
    slides = DeckSlides.load(deck_path)
    request: dict[str, object] = {
        "action": "pack",
        "op": "plan" if dry_run else "apply",
        "withPdfPages": with_pdf_pages,
        "allWeights": all_weights,
    }
    if dry_run:
        try:
            applied = apply_request(slides.path, slides.deck, slides.hash, request)
        except RemoteEditError as exc:
            raise click.ClickException(str(exc)) from exc
    else:
        applied = apply_edit(slides, request, "Pack the deck")
    result = applied.result
    plan = cast("dict[str, object]", result.get("pack") or {})
    steps = cast("list[str]", plan.get("steps") or [])
    if dry_run:
        for step in steps:
            report("Would", step, style="yellow")
        assets = cast("dict[str, object]", plan.get("assets") or {})
        for copy in cast("list[dict[str, str]]", assets.get("copies") or []):
            report("Would copy", f"{copy['from']} -> {copy['to']}", style="yellow")
        for edit in cast("list[dict[str, str]]", assets.get("edits") or []):
            report(
                "Would edit",
                f"{edit['file']}: {edit['kind']} {edit['old']!r} -> {edit['new']!r}",
                style="yellow",
            )
        fonts = cast("dict[str, object]", plan.get("fonts") or {})
        for copy in cast("list[dict[str, str]]", fonts.get("copies") or []):
            report("Would copy", f"{copy['from']} -> {copy['to']}", style="yellow")
        if not steps:
            report("Packed", "nothing to do: the deck is self-contained")
    else:
        lock = result.get("lock")
        if isinstance(lock, str):
            ok = lock.startswith("uv.lock written")
            report("Lock", lock, style="green" if ok else "yellow")
    fonts = cast("dict[str, object]", plan.get("fonts") or {})
    for warning in cast("list[str]", fonts.get("warnings") or []):
        report("Licence", warning, style="yellow")
    assets = cast("dict[str, object]", plan.get("assets") or {})
    for warning in cast("list[str]", assets.get("warnings") or []):
        report("Warning", warning, style="yellow")
    items = cast("list[dict[str, object]]", plan.get("items") or [])
    remaining = [i for i in items if not i.get("fixable")]
    if remaining:
        console.print("\nStill machine-dependent:", markup=False)
        for item in remaining:
            report("-", f"{item['message']}", style="yellow")
    console.print("\nTo build elsewhere:", markup=False)
    for line in tools_needed():
        report("-", line, style="dim")
    if zip_path is not None:
        if dry_run:
            report("Would zip", str(zip_path), style="yellow")
        else:
            names = make_zip(slides.project_dir, zip_path)
            report("Zipped", f"{len(names)} files into {zip_path}")
