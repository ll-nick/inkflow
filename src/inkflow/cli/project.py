from __future__ import annotations

import os
import subprocess
import sys
from importlib.resources import files
from pathlib import Path
from typing import cast

import click

from inkflow import git_setup, init, publish, sync
from inkflow.builtin_themes import THEMES
from inkflow.cli._common import (
    Project,
    deck_option,
    main,
    resolve_dark_mode,
    resolve_deck_path,
)
from inkflow.logging import console, logger, report
from inkflow.server import DeckError, load_deck
from inkflow.titles import resolve_deck_title


def _sync_layout_previews(target: Path) -> None:
    """Inject layout layers + theme preview colors into the scaffolded SVGs.

    Done live, against the resolved deck (so a custom ``--theme`` picks the right
    ``base`` and colors), which keeps the packaged templates lean. Best-effort: the
    injected layers are only an editor aid, so a failure warns and moves on.
    """
    try:
        project = Project.load(target / "deck.py")
        dark_mode = resolve_dark_mode(None, project.deck, False)
        sync.sync_slides(
            [t.path for t in project.slide_targets()],
            project.preview_context(dark_mode),
        )
    except Exception as exc:
        logger.warning(f"could not inject layout previews: {exc}")
        return
    report("Synced", "layout previews for editing")


@main.command("init")
@click.argument("directory", default=".", type=click.Path(path_type=Path))
@click.option(
    "--no-git",
    "no_git",
    is_flag=True,
    help="Skip git hook setup even when inside a git repository.",
)
@click.option(
    "--no-lfs",
    "no_lfs",
    is_flag=True,
    help="Git only: keep videos and images in git itself, without Git LFS rules.",
)
@click.option(
    "--force",
    "force",
    is_flag=True,
    help="Scaffold even into a non-empty directory.",
)
@click.option(
    "--poster",
    "poster",
    is_flag=True,
    help="A conference poster instead of a talk: one page at a paper size.",
)
@click.option(
    "--size",
    "size",
    default=None,
    metavar="SIZE",
    help="The poster's paper size: a0 (default), a1, a0-landscape, letter, "
    + "841x1189mm. Implies --poster.",
)
@click.option(
    "--theme",
    "theme",
    type=click.Choice(list(THEMES)),
    default="default",
    show_default=True,
    help="The deck's theme: the built-in default, paper (quiet, white) or "
    + "stage (big bold type, black).",
)
@click.option(
    "--pages",
    "pages",
    type=click.Choice(list(publish.HOSTS)),
    default=None,
    help="Publish the deck on GitHub Pages or GitLab Pages at every push "
    + "(see setup-pages).",
)
@click.option(
    "--release",
    "release",
    is_flag=True,
    help="With --pages: also release the slides (HTML and PDF) at every tag v*.",
)
def init_cmd(
    directory: Path,
    no_git: bool,
    no_lfs: bool,
    force: bool,
    poster: bool,
    size: str | None,
    theme: str,
    pages: str | None,
    release: bool,
) -> None:
    """Scaffold a new presentation project in DIRECTORY (default: current).

    Writes a starter `deck.py`, slides, and a `pyproject.toml` declaring inkflow.
    For a new project (not already inside a git repository) it also runs `git init`,
    writes a `.gitignore`, and configures the SVG git hooks. Inside an existing
    repository it leaves git alone and points you at `setup-git`. Skip all git steps
    with `--no-git`.

    The deck's `.gitattributes` sends videos, audio, images, fonts and documents
    through Git LFS (and a new repository gets `git lfs install --local`); with
    `--no-lfs` it records a "git only" choice instead, for a minimal repository.

    Refuses to scaffold into a non-empty directory (dotfiles like `.git` are ignored)
    unless `--force` is given.

    `--poster` scaffolds a conference poster instead: `Deck(size="a0")` (or
    `--size`), one slide on a built-in poster layout with its sections in
    `slides/poster.md`, a chart from `data/results.csv` and a figure and a logo
    placeholder in `figures/`. `inkflow export` prints it as a PDF at its size.

    `--theme paper` (a quiet white document look) or `--theme stage` (big bold
    type on black, keynote-style) starts the deck on one of the themes inkflow
    ships instead of the default; it is `Deck(theme=...)` in `deck.py`, so it
    can change any time.

    `--pages github` (or `gitlab`) also writes the CI file publishing the deck
    at every push, and a README.md linking to it (see `setup-pages`);
    `--release` adds a release at every tag `v*`.
    """
    if release and pages is None:
        raise click.UsageError("--release goes with --pages github or --pages gitlab")
    target = directory.resolve()
    if (target / "deck.py").exists():
        raise click.ClickException(f"deck.py already exists: {target / 'deck.py'}")
    if target.exists() and not force:
        clutter = [p for p in target.iterdir() if not p.name.startswith(".")]
        if clutter:
            raise click.ClickException(
                f"directory {target} is not empty — run in a new directory "
                + "(inkflow init my-talk) or pass --force"
            )
    if poster or size is not None:
        try:
            sheet = init.scaffold_poster(target, size or "a0", theme)
        except ValueError as exc:
            raise click.ClickException(str(exc)) from exc
        report("Created", "slides/poster.md, figures/, data/results.csv")
        report("Created", f"deck.py (a poster, {sheet.label})")
    else:
        init.scaffold(target, theme)
        report("Created", "slides/ (title.svg, diagram.svg, guide.md, diagram.md)")
        report("Created", "notes/ (title.md, guide.md, diagram.md)")
        report("Created", "deck.py" if theme == "default" else f"deck.py ({theme})")
    report("Created", "pyproject.toml")
    _sync_layout_previews(target)
    if not no_git:
        git_setup.init_project_git(target, verbose=False, lfs=not no_lfs)
    result = None
    if pages is not None:
        result = _setup_pages(
            target / "deck.py",
            cast("publish.Host", pages),
            release,
            force=False,
            readme=True,
            fonts=False,
        )
    rel = str(directory) if str(directory) not in (".", "./") else None
    suffix = f"cd {rel} && inkflow serve" if rel else "inkflow serve"
    console.print(f"\nrun:  {suffix}", markup=False)
    if result is not None:
        _print_steps(result)


def _setup_pages(
    deck_path: Path,
    host: publish.Host,
    release: bool,
    *,
    force: bool,
    readme: bool,
    fonts: bool,
) -> publish.Result:
    """Write the publishing files and report them (shared by init and setup-pages)."""
    title: str | None = None
    deck = None
    try:
        deck = load_deck(deck_path)
        title = resolve_deck_title(deck, deck_path.parent)
    except DeckError as exc:
        logger.warning(f"could not load the deck: {exc}")
    try:
        result = publish.setup_pages(
            deck_path, host, release, force, readme=readme, title=title
        )
    except publish.PublishError as exc:
        raise click.ClickException(str(exc)) from exc
    for rel in result.written:
        report("Wrote", rel)
    for rel in result.plan.unchanged:
        report("Unchanged", rel, style="dim")
    for warning in result.plan.warnings:
        report("Warning", warning, style="yellow")
    if fonts and deck is not None:
        try:
            font_notes = publish.font_warnings(deck, deck_path.parent, deck_path)
        except Exception as exc:
            logger.warning(f"could not check the deck's fonts: {exc}")
            font_notes = []
        for note in font_notes:
            report("Fonts", note, style="yellow")
    return result


def _print_steps(result: publish.Result) -> None:
    url = result.plan.url
    name = publish.HOST_NAMES[result.plan.host]
    console.print(f"\n{name}: {url or 'address not known yet'}", markup=False)
    note = result.plan.url_note
    if note:
        console.print(f"  ({note})", markup=False)
    if url and not _readme_links(result.plan.where.root, url):
        console.print(
            f"  For README.md (or run again with --readme): {publish.readme_line(url)}",
            markup=False,
        )
    console.print("Next:", markup=False)
    for i, step in enumerate(result.steps, 1):
        console.print(f"  {i}. {step}", markup=False)


def _readme_links(root: Path, url: str) -> bool:
    try:
        return url in (root / "README.md").read_text(encoding="utf-8")
    except OSError:
        return False


@main.command("setup-pages")
@deck_option
@click.argument("host", required=False, type=click.Choice(list(publish.HOSTS)))
@click.option(
    "--release",
    "release",
    is_flag=True,
    help="Also release the slides (one HTML file and a PDF) at every tag v*.",
)
@click.option(
    "--force",
    "force",
    is_flag=True,
    help="Replace workflow files that exist with other contents.",
)
@click.option(
    "--readme",
    "readme",
    is_flag=True,
    help="Add an 'Open the slides' link to README.md (writes one if there is none).",
)
@click.option(
    "--print",
    "print_only",
    is_flag=True,
    help="Print the files instead of writing them.",
)
def setup_pages_cmd(
    deck_path: Path,
    host: str | None,
    release: bool,
    force: bool,
    readme: bool,
    print_only: bool,
) -> None:
    """Publish the deck on GitHub Pages or GitLab Pages at every push.

    Writes the CI file that builds the deck with `inkflow build` and publishes
    it: `.github/workflows/pages.yml` for GITHUB, `.gitlab-ci.yml` for GITLAB
    (default: the host of the `origin` remote), at the repository's root, so a
    deck in a folder of a larger repository works too. `--release` adds a
    release at every tag `v*` carrying the slides as one self-contained HTML
    file and a PDF.

    The workflow fetches Git LFS files and installs a PDF converter when the
    deck has PDF figures. Fonts installed only on this computer are named: copy
    them into `fonts/` and commit them, or the published deck falls back to
    the runner's fonts. Prints the address the slides will have and the one
    manual step (GitHub: Settings → Pages → Source "GitHub Actions").
    """
    resolved = resolve_deck_path(deck_path)
    chosen = host or publish.host_of(publish.layout(resolved).remote)
    if chosen is None:
        raise click.UsageError(
            "name the host: inkflow setup-pages github (or gitlab); "
            + "the origin remote does not say"
        )
    kind = cast("publish.Host", chosen)
    if print_only:
        try:
            plan = publish.plan(resolved, kind, release)
        except publish.PublishError as exc:
            raise click.ClickException(str(exc)) from exc
        for rel, text in publish.render(kind, plan.where, release).items():
            click.echo(f"# ── {rel} ──\n{text}")
        return
    result = _setup_pages(
        resolved, kind, release, force=force, readme=readme, fonts=True
    )
    _print_steps(result)


@main.command("completion")
@click.argument("shell", type=click.Choice(["bash", "zsh", "fish", "carapace"]))
def completion_cmd(shell: str) -> None:
    """Print shell completion script for SHELL.

    Add to your shell config:

    - bash: `eval "$(inkflow completion bash)"`
    - zsh: `eval "$(inkflow completion zsh)"`
    - fish: `inkflow completion fish | source`
    - carapace: `inkflow completion carapace > ~/.config/carapace/specs/inkflow.yaml`
    """
    if shell == "carapace":
        spec = files("inkflow").joinpath("completions/inkflow.yaml")
        click.echo(spec.read_text(encoding="utf-8"), nl=False)
        return

    env = {**os.environ, "_INKFLOW_COMPLETE": f"{shell}_source"}
    result = subprocess.run([sys.argv[0]], env=env, capture_output=True, text=True)
    click.echo(result.stdout, nl=False)


@main.command("setup-desktop")
@click.option(
    "--remove",
    "remove",
    is_flag=True,
    help="Remove the launcher instead.",
)
@click.option(
    "--terminal",
    "terminal",
    is_flag=True,
    help="Run the server in a terminal window (its status; closing it stops it).",
)
def setup_desktop(remove: bool, terminal: bool) -> None:
    """Add Inkflow to the desktop's application menu.

    The launcher runs `inkflow edit --start`: the editor comes up in the
    browser on its start page (a new deck, open a deck, recent decks). The
    server runs hidden and stops a minute after its last tab closes, or at
    "Quit Inkflow" in the deck menu; with `--terminal` it runs in a terminal
    window instead. Each launch is its own server, but a deck already open in
    one is never opened in a second: you are taken to the first. It starts
    this installation of inkflow (for example the one `uv tool install
    inkflow` made).

    Linux: a `.desktop` entry and icon under `~/.local/share`. macOS:
    `~/Applications/Inkflow.app`. Windows: a Start menu shortcut.
    """
    from inkflow import launcher

    if remove:
        removed = launcher.uninstall()
        for path in removed:
            report("Removed", str(path))
        if not removed:
            report("Nothing", "no launcher was installed", style="yellow")
        return
    try:
        written = launcher.install(terminal)
    except launcher.LauncherError as exc:
        raise click.ClickException(str(exc)) from exc
    for path in written:
        report("Wrote", str(path))
    report("Runs", " ".join(launcher.command(terminal)))


@main.command("setup-git")
def setup_git() -> None:
    """Configure git hooks and the SVG diff driver for the current repository.

    Run once per clone. Installs a pre-commit hook that strips Inkscape editor
    metadata from staged SVGs, and registers a diff driver so `git diff` and
    GitHub show only visual changes for SVGs. Both git-config entries are local to
    the clone (never committed).
    """
    try:
        root = git_setup.git_root()
        git_setup.run_git_setup(root, verbose=True)
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc
