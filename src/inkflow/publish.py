"""Publishing a deck on GitHub Pages or GitLab Pages: the CI files that build it
with ``inkflow build`` at every push, and optionally a release at every tag
``v*`` carrying the slides as one self-contained HTML file and a PDF.

The files come from ``templates/ci/``, rendered for the project rather than
copied: the deck may be one folder of a larger repository (the workflow lives
at the repository root and builds with ``--deck <folder>/deck.py``), its
``pyproject.toml`` (which pins inkflow) may sit in that folder, and GitHub
triggers on the repository's default branch. What a runner may lack is
handled in the workflow itself: Git LFS files are fetched, and a PDF converter
is installed when the deck has PDF figures. Fonts are the one thing a workflow
cannot fetch, so ``font_warnings`` names the ones only this computer has.

Used by ``inkflow setup-pages``, ``inkflow init --pages`` and the editor's
Git menu ("Publish…", the session's ``publish`` action).
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import tomllib
from dataclasses import dataclass, field
from importlib.resources import files
from pathlib import Path
from typing import Literal, cast
from urllib.parse import urlsplit

from inkflow.manifest import Deck

Host = Literal["github", "gitlab"]
HOSTS: tuple[Host, ...] = ("github", "gitlab")
HOST_NAMES: dict[Host, str] = {"github": "GitHub Pages", "gitlab": "GitLab Pages"}

UV_IMAGE = "ghcr.io/astral-sh/uv:0.12.24-python3.13-trixie"
"""The GitLab jobs' image: uv on Debian (apt for git-lfs, poppler, Chromium)."""
GLAB_IMAGE = "registry.gitlab.com/gitlab-org/cli:v1.119.0"
"""The GitLab release job's image: glab, which the ``release`` keyword runs."""

MARKER = "inkflow setup-pages"
"""Written into every generated file, so a later run knows it made it."""

GITHUB_PAGES = ".github/workflows/pages.yml"
GITHUB_RELEASE = ".github/workflows/release.yml"
GITLAB_CI = ".gitlab-ci.yml"


class PublishError(Exception):
    """Publishing cannot be set up as asked; the message says why."""


# ── Where the deck is published ──


@dataclass(frozen=True)
class Remote:
    """A git remote URL taken apart: its web address and repository path."""

    host: str
    """The host name, lowercased, without a port."""
    web: str
    """The web address of the host (``https://github.com``)."""
    path: tuple[str, ...]
    """Owner (or group and subgroups) and repository, without ``.git``."""

    @property
    def project_url(self) -> str:
        return f"{self.web}/{'/'.join(self.path)}"


_SCP = re.compile(r"^(?:[^@/]+@)?(?P<host>[^:/]+):(?P<path>[^/].*)$")


def parse_remote(url: str) -> Remote | None:
    """``https://github.com/o/r.git``, ``git@github.com:o/r.git`` or
    ``ssh://git@host:2222/group/sub/r.git``; None for anything else (a local
    path, a remote without an owner)."""
    url = url.strip()
    if "://" in url:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https", "ssh", "git", "git+ssh"):
            return None
        host = (parts.hostname or "").lower()
        port = parts.port
        raw = parts.path
        web_port = f":{port}" if port and parts.scheme in ("http", "https") else ""
        scheme = "http" if parts.scheme == "http" else "https"
        web = f"{scheme}://{host}{web_port}"
    else:
        match = _SCP.match(url)
        if match is None:
            return None
        host = match.group("host").lower()
        raw = match.group("path")
        web = f"https://{host}"
    path = tuple(p for p in raw.strip("/").split("/") if p)
    if path and path[-1].endswith(".git"):
        path = (*path[:-1], path[-1][: -len(".git")])
    if not host or len(path) < 2 or not all(path):
        return None
    return Remote(host, web, path)


def host_of(remote: Remote | None) -> Host | None:
    """Which kind of host a remote is on, by its name."""
    if remote is None:
        return None
    if "github" in remote.host:
        return "github"
    if "gitlab" in remote.host:
        return "gitlab"
    return None


def pages_url(host: Host, remote: Remote | None) -> str | None:
    """Where the published deck appears, when it can be told from the remote.

    GitHub: ``https://<owner>.github.io/<repo>/`` (a ``<owner>.github.io``
    repository is the owner's site, at the root). GitLab.com:
    ``https://<group>.gitlab.io/<subgroups>/<project>/`` (``<group>.gitlab.io``
    is the group's site). A GitHub Enterprise or self-hosted GitLab server has
    a Pages domain of its own, and a custom domain replaces any of these: None.
    """
    if remote is None:
        return None
    if host == "github" and remote.host == "github.com" and len(remote.path) == 2:
        owner, repo = remote.path
        site = f"https://{owner.lower()}.github.io/"
        return (
            site if repo.lower() == f"{owner.lower()}.github.io" else f"{site}{repo}/"
        )
    if host == "gitlab" and remote.host == "gitlab.com":
        group, rest = remote.path[0], remote.path[1:]
        site = f"https://{group.lower()}.gitlab.io/"
        if len(rest) == 1 and rest[0].lower() == f"{group.lower()}.gitlab.io":
            return site
        return f"{site}{'/'.join(rest)}/"
    return None


def settings_url(host: Host, remote: Remote | None) -> str | None:
    """The page where Pages is switched on (GitHub) or shown (GitLab)."""
    if remote is None or host_of(remote) not in (host, None):
        return None
    if host == "github":
        return f"{remote.project_url}/settings/pages"
    return f"{remote.project_url}/pages"


# ── The repository ──


def _git(cwd: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(cwd), *args],
            capture_output=True,
            text=True,
            timeout=20,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def repo_root(directory: Path) -> Path | None:
    root = _git(directory, "rev-parse", "--show-toplevel")
    return Path(root).resolve() if root else None


def origin(root: Path) -> Remote | None:
    """The ``origin`` remote (else the first one), taken apart."""
    names = (_git(root, "remote") or "").split()
    if not names:
        return None
    name = "origin" if "origin" in names else names[0]
    url = _git(root, "remote", "get-url", name)
    return parse_remote(url) if url else None


def default_branch(root: Path) -> str:
    """The branch the deck is published from: origin's default branch, else
    the branch checked out (also before the first commit), else ``main``."""
    head = _git(root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
    if head and "/" in head:
        return head.split("/", 1)[1]
    current = _git(root, "symbolic-ref", "--quiet", "--short", "HEAD")
    return current or "main"


# ── Rendering ──


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "slides"


def _inkflow_requirement() -> str:
    from inkflow.init import inkflow_requirement

    return inkflow_requirement()


def _declares_inkflow(pyproject: Path) -> bool:
    """Whether a ``pyproject.toml`` gives ``uv run`` an inkflow: it depends on
    it (in any group), or it is inkflow itself."""
    try:
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return False
    project = cast("dict[str, object]", data.get("project") or {})
    if project.get("name") == "inkflow":
        return True
    requirements: list[object] = list(
        cast("list[object]", project.get("dependencies") or [])
    )
    groups = cast("dict[str, list[object]]", data.get("dependency-groups") or {})
    for group in groups.values():
        requirements.extend(group)
    optional = cast(
        "dict[str, list[object]]", project.get("optional-dependencies") or {}
    )
    for extra in optional.values():
        requirements.extend(extra)
    return any(
        isinstance(r, str) and re.match(r"^\s*inkflow\b(?![-_.\w])", r)
        for r in requirements
    )


@dataclass(frozen=True)
class Layout:
    """Where things are, relative to the repository root, as a workflow running
    there sees them."""

    root: Path
    deck_path: Path
    scope: str
    """The deck's folder relative to the root (``""`` at the root)."""
    project: str | None
    """The folder of the ``pyproject.toml`` that pins inkflow (``""`` at the
    root), or None when there is none."""
    pins_inkflow: bool
    in_repo: bool
    branch: str
    remote: Remote | None

    @property
    def name_suffix(self) -> str:
        """What follows the repository's name in the release files' names
        (``<repo><suffix>-<version>-slides.html``): the deck's folder, if any."""
        return f"-{_slug(Path(self.scope).name)}" if self.scope else ""

    @property
    def uv_run(self) -> str:
        parts = ["uv", "run"]
        if self.project is None:
            parts.append("--no-project")
        elif self.project:
            parts += ["--project", self.project]
        if not self.pins_inkflow:
            parts += ["--with", _inkflow_requirement()]
        return shlex.join(parts)

    @property
    def deck_opt(self) -> str:
        if not self.scope and self.deck_path.name == "deck.py":
            return ""
        rel = self.deck_path.relative_to(self.root).as_posix()
        return f" --deck {shlex.quote(rel)}"

    @property
    def pdf_glob(self) -> str:
        return shlex.quote(f"{self.scope}/*.pdf" if self.scope else "*.pdf")

    @property
    def uv_lock(self) -> str:
        return f"{self.project}/uv.lock" if self.project else "uv.lock"


def layout(deck_path: Path) -> Layout:
    """Find the repository, the deck's folder in it and its ``pyproject.toml``.
    A deck outside any repository is treated as the root of the one it will be in."""
    deck_path = deck_path.resolve()
    deck_dir = deck_path.parent
    found = repo_root(deck_dir)
    root = found or deck_dir
    if not deck_dir.is_relative_to(root):
        root = deck_dir
    scope = deck_dir.relative_to(root).as_posix()
    scope = "" if scope == "." else scope
    project: str | None = None
    pins = False
    folder = deck_dir
    while True:
        candidate = folder / "pyproject.toml"
        if candidate.is_file():
            rel = folder.relative_to(root).as_posix()
            project = "" if rel == "." else rel
            pins = _declares_inkflow(candidate)
            break
        if folder == root or folder == folder.parent:
            break
        folder = folder.parent
    return Layout(
        root=root,
        deck_path=deck_path,
        scope=scope,
        project=project,
        pins_inkflow=pins,
        in_repo=found is not None,
        branch=default_branch(root) if found else "main",
        remote=origin(root) if found else None,
    )


def _template(name: str) -> str:
    return (
        files("inkflow").joinpath("templates", "ci", name).read_text(encoding="utf-8")
    )


def _render(text: str, where: Layout) -> str:
    tokens = {
        "__BRANCH_JSON__": json.dumps(where.branch),
        "__BRANCH__": where.branch,
        "__UV_RUN__": where.uv_run,
        "__DECK_OPT__": where.deck_opt,
        "__PDF_GLOB__": where.pdf_glob,
        "__NAME_SUFFIX__": where.name_suffix,
        "__UV_IMAGE__": UV_IMAGE,
        "__GLAB_IMAGE__": GLAB_IMAGE,
        "__UV_LOCK__": where.uv_lock,
    }
    for token, value in tokens.items():
        text = text.replace(token, value)
    return text


def render(host: Host, where: Layout, release: bool) -> dict[str, str]:
    """The CI files for ``host``: repository-relative path -> contents."""
    if host == "github":
        out = {GITHUB_PAGES: _render(_template("pages.yml"), where)}
        if release:
            out[GITHUB_RELEASE] = _render(_template("release.yml"), where)
        return out
    text = _template("gitlab-ci.yml")
    if release:
        text += _template("gitlab-release.yml")
    return {GITLAB_CI: _render(text, where)}


def paths_for(host: Host, release: bool) -> list[str]:
    if host == "gitlab":
        return [GITLAB_CI]
    return [GITHUB_PAGES, GITHUB_RELEASE] if release else [GITHUB_PAGES]


# ── What is there already ──


def made_by_inkflow(text: str) -> bool:
    return MARKER in text


def detect(root: Path) -> dict[str, object] | None:
    """The publishing an earlier setup wrote at ``root``: ``{host, release,
    url, settingsUrl}``, or None."""
    for host in HOSTS:
        path = root / paths_for(host, False)[0]
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if not made_by_inkflow(text):
            continue
        remote = origin(root)
        if host == "github":
            release_file = root / GITHUB_RELEASE
            release = release_file.is_file() and made_by_inkflow(
                release_file.read_text(encoding="utf-8", errors="replace")
            )
        else:
            release = "release-files:" in text
        return {
            "host": host,
            "release": release,
            "url": pages_url(host, remote),
            "settingsUrl": settings_url(host, remote),
        }
    return None


def other_pages_workflows(root: Path) -> list[str]:
    """GitHub workflows inkflow did not write that deploy to Pages too."""
    folder = root / ".github" / "workflows"
    found: list[str] = []
    for path in sorted([*folder.glob("*.yml"), *folder.glob("*.yaml")]):
        rel = path.relative_to(root).as_posix()
        if rel in (GITHUB_PAGES, GITHUB_RELEASE):
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if "deploy-pages" in text or "gh-deploy" in text or "gh-pages" in text:
            found.append(rel)
    return found


# ── Fonts ──


def font_warnings(deck: Deck, project_dir: Path, deck_path: Path) -> list[str]:
    """The deck's fonts a CI runner will not have: found only among this
    computer's fonts (not in the project's ``fonts/`` or the theme's), or
    nowhere. ``inkflow build`` embeds the fonts it finds, so these fall back to
    the runner's system fonts in the published deck."""
    if not deck.embed_fonts:
        return []
    from inkflow.fonts import SHIPPED_FONTS_DIR, font_sources
    from inkflow.loaders import load_deck_styles
    from inkflow.pipeline import process_deck

    slides = process_deck(deck, project_dir, deck_path)
    styles = load_deck_styles(deck, project_dir)
    theme_fonts = deck.theme.fonts_dir
    shipped = [project_dir / "fonts", theme_fonts, SHIPPED_FONTS_DIR]
    local: list[str] = []
    missing: list[str] = []
    for family, path in font_sources(
        slides, project_dir, theme_fonts, styles_css=styles
    ):
        if path is None:
            missing.append(family)
        elif not any(path.resolve().is_relative_to(d.resolve()) for d in shipped):
            local.append(family)
    missing = sorted(set(missing))
    local = sorted(set(local) - set(missing))
    warnings: list[str] = []
    if local:
        warnings.append(
            f"{_families(local)} {'is' if len(local) == 1 else 'are'} installed on "
            + "this computer only: copy the font files into fonts/ and commit them, "
            + "or the published deck falls back to the runner's system fonts"
        )
    if missing:
        warnings.append(
            f"{_families(missing)} {'is' if len(missing) == 1 else 'are'} not "
            + "installed here either: the deck uses fallback fonts here and online"
        )
    return warnings


def _families(names: list[str]) -> str:
    quoted = [f'"{n}"' for n in sorted(set(names))]
    return (
        quoted[0] if len(quoted) == 1 else ", ".join(quoted[:-1]) + f" and {quoted[-1]}"
    )


# ── Setting it up ──


README = """\
# {title}
{link}
Made with [Inkflow](https://github.com/ll-nick/inkflow). To present or edit
the slides on your own computer: `uv run inkflow serve` or `uv run inkflow edit`.
"""


def readme_line(url: str) -> str:
    return f"**[▶ Open the slides]({url})**"


def readme_update(root: Path, title: str, url: str | None) -> str | None:
    """README.md with a link to the published slides: a short new one (the
    link left out while the address is unknown: a repository without a remote
    yet), or the existing one with the link added under its first heading.
    None when there is nothing to change."""
    path = root / "README.md"
    if not path.is_file():
        link = f"\n{readme_line(url)}\n" if url else ""
        return README.format(title=title, link=link)
    if url is None:
        return None
    text = path.read_text(encoding="utf-8")
    if url in text:
        return None
    lines = text.splitlines()
    at = next((i + 1 for i, line in enumerate(lines) if line.startswith("# ")), 0)
    lines[at:at] = ["", readme_line(url)] if at else [readme_line(url), ""]
    return "\n".join(lines).rstrip("\n") + "\n"


@dataclass
class Plan:
    """What setting up publishing writes, before anything is written."""

    host: Host
    release: bool
    where: Layout
    files: dict[str, str]
    """Repository-relative path -> new contents."""
    conflicts: list[str] = field(default_factory=list)
    """Files that exist with other contents (``force`` replaces them)."""
    unchanged: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def url(self) -> str | None:
        return pages_url(self.host, self.where.remote)

    @property
    def settings(self) -> str | None:
        return settings_url(self.host, self.where.remote)

    @property
    def url_note(self) -> str | None:
        """What to know about ``url``, or why there is none."""
        remote = self.where.remote
        if remote is None:
            return "the address follows from the repository's remote: add one"
        if self.url is None:
            return (
                f"the Pages address on {remote.host} cannot be told from the "
                + "remote: the Pages settings show it after the first run"
            )
        if self.host == "gitlab":
            return (
                "unless GitLab gave the project a unique domain (its default for "
                + "new projects): Deploy → Pages shows the address"
            )
        return None

    def steps(self, written: list[str]) -> list[str]:
        """What the author does next, in order."""
        out: list[str] = []
        if not self.where.in_repo:
            out.append(
                "Make this folder a git repository (inkflow setup-git after git init)"
            )
        if self.where.remote is None:
            where = "GitHub" if self.host == "github" else "GitLab"
            out.append(
                f"Create the repository on {where} and add it as the origin "
                + f"remote (inkflow setup-pages {self.host} --readme then says "
                + "where the slides are and links them from README.md)"
            )
        if written:
            at = f" (in {self.where.root})" if self.where.scope else ""
            out.append(
                f"Commit and push{at}: git add "
                + " ".join(shlex.quote(p) for p in written)
                + ' && git commit -m "Publish the slides" && git push'
            )
        if self.host == "github":
            where = f" ({self.settings})" if self.settings else ""
            out.append(
                f'Once: Settings → Pages → Source: "GitHub Actions"{where}; '
                + "if the first run failed before that, re-run it"
            )
        else:
            where = f" ({self.settings})" if self.settings else ""
            out.append(
                "A public project needs nothing more; for a private or internal one, "
                + "Settings → General → Visibility → Pages decides who may see "
                + f"the slides. Deploy → Pages shows the address{where}"
            )
        if self.release:
            out.append("Release: git tag v1.0 && git push origin v1.0")
        return out


def plan(
    deck_path: Path,
    host: Host,
    release: bool = False,
    *,
    readme: bool = False,
    title: str | None = None,
) -> Plan:
    """The files ``setup`` would write for ``deck_path``, and what is in the way."""
    if host not in HOSTS:
        raise PublishError(f"publish to github or gitlab, not {host!r}")
    where = layout(deck_path)
    rendered = render(host, where, release)
    result = Plan(host, release, where, {})
    if readme:
        text = readme_update(where.root, title or where.root.name, result.url)
        if text is not None:
            rendered["README.md"] = text
    for rel, text in rendered.items():
        path = where.root / rel
        if path.is_file():
            current = path.read_text(encoding="utf-8", errors="replace")
            if current == text:
                result.unchanged.append(rel)
                continue
            if rel != "README.md":
                result.conflicts.append(rel)
        result.files[rel] = text
    remote_host = host_of(where.remote)
    if where.remote is not None and remote_host not in (host, None):
        name = "GitHub" if host == "github" else "GitLab"
        result.warnings.append(f"origin is on {where.remote.host}, not {name}")
    if host == "github":
        others = other_pages_workflows(where.root)
        if others:
            result.warnings.append(
                f"{', '.join(others)} deploys to Pages too; a repository has one "
                + "Pages site, so keep only one of them"
            )
    requirement = _inkflow_requirement()
    if where.project is None:
        result.warnings.append(
            f"no pyproject.toml pins inkflow: the workflow installs {requirement} "
            + "(inkflow init writes a pyproject.toml)"
        )
    elif not where.pins_inkflow:
        rel = f"{where.project}/pyproject.toml" if where.project else "pyproject.toml"
        result.warnings.append(
            f"{rel} does not depend on inkflow: the workflow adds {requirement}"
        )
    return result


@dataclass
class Result:
    written: list[str]
    plan: Plan

    @property
    def steps(self) -> list[str]:
        return self.plan.steps(self.written)


def setup_pages(
    deck_path: Path,
    host: Host,
    release: bool = False,
    force: bool = False,
    *,
    readme: bool = False,
    title: str | None = None,
) -> Result:
    """Write the CI files publishing ``deck_path`` on ``host`` (and README.md's
    link with ``readme``). Refuses to replace a file with other contents unless
    ``force``; a file already as it would be written is left alone."""
    p = plan(deck_path, host, release, readme=readme, title=title)
    if p.conflicts and not force:
        names = ", ".join(p.conflicts)
        ours = all(
            made_by_inkflow(
                (p.where.root / rel).read_text(encoding="utf-8", errors="replace")
            )
            for rel in p.conflicts
        )
        if ours:
            raise PublishError(
                f"{names} exists already (from an earlier setup, with other "
                + "settings or edits since): --force writes it again"
            )
        raise PublishError(
            f"{names} exists already and is not inkflow's: add the jobs to it "
            + f"by hand (inkflow setup-pages {host} --print shows them), or "
            + "--force replaces it"
        )
    written: list[str] = []
    for rel, text in p.files.items():
        path = p.where.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        written.append(rel)
    return Result(written, p)
