"""Publishing on GitHub Pages and GitLab Pages (publish.py): the CI files for
each kind of project, the address the slides get, refusing to overwrite, and
the CLI and editor entry points."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path
from typing import cast

import pytest
import yaml
from click.testing import CliRunner

from inkflow import init, publish
from inkflow.cli import main
from inkflow.editor import gitops
from inkflow.editor.session import EditError, EditorSession
from inkflow.fonts import (
    _FontIndexKey,  # pyright: ignore[reportPrivateUsage]
    _FontRecord,  # pyright: ignore[reportPrivateUsage]
    _index_cache,  # pyright: ignore[reportPrivateUsage]
    font_sources,
)
from inkflow.pipeline import SlideData
from inkflow.server import load_deck

needs_git = pytest.mark.skipif(not gitops.available(), reason="needs git")

YamlMap = dict[object, object]


@pytest.fixture(autouse=True)
def _isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for who in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{who}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{who}_EMAIL", "test@example.com")


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True
    ).stdout


def _repo(
    root: Path,
    *,
    branch: str = "main",
    remote: str | None = "https://github.com/ada/talk.git",
) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    _git(root, "init", "-q", "-b", branch)
    if remote:
        _git(root, "remote", "add", "origin", remote)
    return root


def _deck(folder: Path, *, pyproject: bool = True) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    init.scaffold(folder)
    if not pyproject:
        (folder / "pyproject.toml").unlink()
    return folder / "deck.py"


def _load(text: str) -> YamlMap:
    return cast("YamlMap", yaml.safe_load(text))


def _steps(job: YamlMap) -> list[YamlMap]:
    return cast("list[YamlMap]", job["steps"])


def _run_of(job: YamlMap, name: str) -> str:
    step = next(s for s in _steps(job) if s.get("name") == name)
    return str(step["run"]).strip()


def _jobs(doc: YamlMap) -> dict[str, YamlMap]:
    return cast("dict[str, YamlMap]", doc["jobs"])


# ── Remotes and addresses ──


@pytest.mark.parametrize(
    ("url", "host", "path"),
    [
        ("https://github.com/Ada/talk.git", "github.com", ("Ada", "talk")),
        ("https://github.com/Ada/talk", "github.com", ("Ada", "talk")),
        ("git@github.com:Ada/talk.git", "github.com", ("Ada", "talk")),
        ("ssh://git@github.com/Ada/talk.git", "github.com", ("Ada", "talk")),
        (
            "https://user:token@gitlab.com/group/sub/talk.git",
            "gitlab.com",
            ("group", "sub", "talk"),
        ),
        (
            "ssh://git@gitlab.example.org:2222/team/talk.git",
            "gitlab.example.org",
            ("team", "talk"),
        ),
    ],
)
def test_parse_remote(url: str, host: str, path: tuple[str, ...]) -> None:
    remote = publish.parse_remote(url)
    assert remote is not None
    assert (remote.host, remote.path) == (host, path)


def test_parse_remote_rejects_what_is_no_hosted_repository() -> None:
    assert publish.parse_remote("/srv/git/talk.git") is None
    assert publish.parse_remote("https://github.com/talk") is None
    assert publish.parse_remote("file:///srv/git/a/b.git") is None


def test_web_address_keeps_an_https_port_only() -> None:
    https = publish.parse_remote("https://git.example.org:8443/team/talk.git")
    ssh = publish.parse_remote("ssh://git@git.example.org:2222/team/talk.git")
    assert https is not None and ssh is not None
    assert https.project_url == "https://git.example.org:8443/team/talk"
    assert ssh.project_url == "https://git.example.org/team/talk"


@pytest.mark.parametrize(
    ("host", "url", "pages", "settings"),
    [
        (
            "github",
            "git@github.com:Ada-L/talk.git",
            "https://ada-l.github.io/talk/",
            "https://github.com/Ada-L/talk/settings/pages",
        ),
        (
            "github",
            "https://github.com/Ada-L/ada-l.github.io.git",
            "https://ada-l.github.io/",
            "https://github.com/Ada-L/ada-l.github.io/settings/pages",
        ),
        (
            "gitlab",
            "git@gitlab.com:team/talk.git",
            "https://team.gitlab.io/talk/",
            "https://gitlab.com/team/talk/pages",
        ),
        (
            "gitlab",
            "https://gitlab.com/team/courses/2026/talk.git",
            "https://team.gitlab.io/courses/2026/talk/",
            "https://gitlab.com/team/courses/2026/talk/pages",
        ),
        (
            "gitlab",
            "https://gitlab.com/team/team.gitlab.io.git",
            "https://team.gitlab.io/",
            "https://gitlab.com/team/team.gitlab.io/pages",
        ),
        (
            "gitlab",
            "https://gitlab.example.org/team/talk.git",
            None,
            "https://gitlab.example.org/team/talk/pages",
        ),
        (
            "github",
            "https://github.example.com/team/talk.git",
            None,
            "https://github.example.com/team/talk/settings/pages",
        ),
    ],
)
def test_pages_address(
    host: publish.Host, url: str, pages: str | None, settings: str
) -> None:
    remote = publish.parse_remote(url)
    assert publish.pages_url(host, remote) == pages
    assert publish.settings_url(host, remote) == settings
    assert publish.host_of(remote) == host


# ── The files, for each kind of project ──


@needs_git
@pytest.mark.parametrize("branch", ["main", "master"])
def test_github_pages_for_a_deck_at_the_root(tmp_path: Path, branch: str) -> None:
    root = _repo(tmp_path / "talk", branch=branch)
    deck = _deck(root)
    files = publish.render("github", publish.layout(deck), release=False)
    assert list(files) == [publish.GITHUB_PAGES]
    text = files[publish.GITHUB_PAGES]
    assert publish.made_by_inkflow(text)
    doc = _load(text)
    # (YAML 1.1 reads the key `on` as True.)
    trigger = cast("YamlMap", doc[True])
    assert cast("YamlMap", trigger["push"])["branches"] == [branch]
    assert "workflow_dispatch" in trigger
    assert doc["permissions"] == {
        "contents": "read",
        "pages": "write",
        "id-token": "write",
    }
    assert doc["concurrency"] == {"group": "pages", "cancel-in-progress": False}
    build, deploy = _jobs(doc)["build"], _jobs(doc)["deploy"]
    checkout = _steps(build)[0]
    assert checkout["uses"] == "actions/checkout@v4"
    assert checkout["with"] == {"lfs": True}
    uses = [s.get("uses") for s in _steps(build)]
    assert "astral-sh/setup-uv@v5" in uses
    assert "actions/upload-pages-artifact@v3" in uses
    assert (
        _run_of(build, "Build the slides")
        == "uv run inkflow build --assets-folder --output _site"
    )
    assert "'*.pdf'" in _run_of(
        build, "Install a PDF converter if the deck has PDF figures"
    )
    assert deploy["needs"] == "build"
    assert _steps(deploy)[0]["uses"] == "actions/deploy-pages@v4"


@needs_git
def test_github_for_a_deck_in_a_folder_with_its_own_pyproject(tmp_path: Path) -> None:
    root = _repo(tmp_path / "repo")
    deck = _deck(root / "talks" / "intro")
    where = publish.layout(deck)
    assert (where.scope, where.project, where.pins_inkflow) == (
        "talks/intro",
        "talks/intro",
        True,
    )
    files = publish.render("github", where, release=True)
    pages = _jobs(_load(files[publish.GITHUB_PAGES]))["build"]
    assert _run_of(pages, "Build the slides") == (
        "uv run --project talks/intro inkflow build "
        + "--deck talks/intro/deck.py --assets-folder --output _site"
    )
    assert "'talks/intro/*.pdf'" in _run_of(
        pages, "Install a PDF converter if the deck has PDF figures"
    )
    release = _jobs(_load(files[publish.GITHUB_RELEASE]))["release"]
    assert release["permissions"] == {"contents": "write"}
    assert cast("YamlMap", release["env"])["NAME"] == (
        "${{ github.event.repository.name }}-intro"
    )
    assert _run_of(release, "Build the slides as a single self-contained file") == (
        "uv run --project talks/intro inkflow build --deck talks/intro/deck.py "
        + "--output dist"
    )
    assert _run_of(release, "Print the slides to PDF") == (
        "uv run --project talks/intro inkflow export --deck talks/intro/deck.py "
        + "--no-sandbox --output dist/slides.pdf"
    )
    assert "gh release create" in _run_of(release, "Create GitHub release")


@needs_git
def test_a_deck_without_pyproject_uses_one_further_up_or_installs_inkflow(
    tmp_path: Path,
) -> None:
    root = _repo(tmp_path / "repo")
    deck = _deck(root / "talk", pyproject=False)
    assert publish.layout(deck).uv_run.startswith("uv run --no-project --with ")
    (root / "pyproject.toml").write_text(
        '[project]\nname = "talks"\nversion = "0"\ndependencies = ["inkflow>=0.7"]\n',
        encoding="utf-8",
    )
    assert publish.layout(deck).uv_run == "uv run"
    (root / "pyproject.toml").write_text(
        '[project]\nname = "talks"\nversion = "0"\ndependencies = ["inkflow-extras"]\n',
        encoding="utf-8",
    )
    where = publish.layout(deck)
    assert where.uv_run.startswith("uv run --with 'inkflow")
    warnings = publish.plan(deck, "github").warnings
    assert any("does not depend on inkflow" in w for w in warnings)


@needs_git
@pytest.mark.parametrize("subdir", [False, True])
@pytest.mark.parametrize("release", [False, True])
def test_gitlab_ci(tmp_path: Path, subdir: bool, release: bool) -> None:
    root = _repo(tmp_path / "repo", remote="git@gitlab.com:team/talk.git")
    deck = _deck(root / "talk" if subdir else root)
    files = publish.render("gitlab", publish.layout(deck), release=release)
    assert list(files) == [publish.GITLAB_CI]
    doc = _load(files[publish.GITLAB_CI])
    shared = cast("YamlMap", doc[".inkflow"])
    assert shared["image"] == publish.UV_IMAGE
    assert publish.UV_IMAGE.startswith("ghcr.io/astral-sh/uv:0.")
    assert cast("YamlMap", cast("YamlMap", shared["cache"])["key"])["files"] == [
        "talk/uv.lock" if subdir else "uv.lock"
    ]
    prepare = str(cast("list[str]", shared["before_script"])[0])
    assert "git lfs pull" in prepare and "poppler-utils" in prepare
    pages = cast("YamlMap", doc["pages"])
    assert pages["extends"] == ".inkflow"
    assert pages["rules"] == [{"if": "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH"}]
    assert pages["artifacts"] == {"paths": ["public"]}
    build = str(cast("list[str]", pages["script"])[0]).strip()
    if subdir:
        assert build == (
            "uv run --project talk inkflow build --deck talk/deck.py "
            + "--assets-folder --output public"
        )
    else:
        assert build == "uv run inkflow build --assets-folder --output public"
    assert ("release" in doc) is release
    assert ("release-files" in doc) is release
    if release:
        files_job = cast("YamlMap", doc["release-files"])
        assert cast("YamlMap", files_job["variables"])["EXTRA_PACKAGES"] == "chromium"
        assert cast("YamlMap", files_job["artifacts"])["expire_in"] == "never"
        job = cast("YamlMap", doc["release"])
        assert job["image"] == publish.GLAB_IMAGE
        links = cast(
            "list[YamlMap]",
            cast("YamlMap", cast("YamlMap", job["release"])["assets"])["links"],
        )
        suffix = "-talk" if subdir else ""
        assert [str(link["url"]).rsplit("/", 1)[1] for link in links] == [
            f"${{CI_PROJECT_NAME}}{suffix}-$VERSION-slides.html",
            f"${{CI_PROJECT_NAME}}{suffix}-$VERSION-slides.pdf",
        ]


@needs_git
@pytest.mark.parametrize("lfs_on", [True, False])
def test_files_do_not_depend_on_lfs_which_the_runner_detects(
    tmp_path: Path, lfs_on: bool
) -> None:
    """GitHub always checks out with LFS (harmless without it); GitLab looks
    for LFS rules when the job runs, so turning LFS on later needs no new file."""
    from inkflow import lfs

    root = _repo(tmp_path / "repo")
    deck = _deck(root)
    lfs.ensure_attributes(root / ".gitattributes", lfs_on)
    with_lfs = {h: publish.render(h, publish.layout(deck), True) for h in publish.HOSTS}
    (root / ".gitattributes").unlink()
    without = {h: publish.render(h, publish.layout(deck), True) for h in publish.HOSTS}
    assert with_lfs == without


def _stub(bin_dir: Path, name: str, log: Path) -> None:
    script = bin_dir / name
    script.write_text(f'#!/bin/sh\necho "{name} $*" >> "{log}"\n', encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IEXEC)


@needs_git
@pytest.mark.skipif(os.name == "nt", reason="runs the workflow's shell")
@pytest.mark.parametrize("has_pdf", [False, True])
def test_pdf_converter_installed_only_for_a_deck_with_pdfs(
    tmp_path: Path, has_pdf: bool
) -> None:
    """Runs the workflow's own step, sudo stubbed, in a repository like the runner's."""
    root = _repo(tmp_path / "repo")
    deck = _deck(root / "talk")
    (root / "other.pdf").write_bytes(b"%PDF-1.4\n")  # not the deck's
    if has_pdf:
        (root / "talk" / "figures").mkdir()
        (root / "talk" / "figures" / "plot.pdf").write_bytes(b"%PDF-1.4\n")
    _git(root, "add", "-A")
    files = publish.render("github", publish.layout(deck), False)
    build = _jobs(_load(files[publish.GITHUB_PAGES]))["build"]
    script = _run_of(build, "Install a PDF converter if the deck has PDF figures")
    bin_dir, log = tmp_path / "bin", tmp_path / "calls.log"
    bin_dir.mkdir()
    _stub(bin_dir, "sudo", log)
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
    subprocess.run(["sh", "-c", script], cwd=root, env=env, check=True)
    calls = log.read_text(encoding="utf-8") if log.exists() else ""
    assert ("apt-get install -y -q poppler-utils" in calls) is has_pdf


@needs_git
@pytest.mark.skipif(os.name == "nt", reason="runs the job's shell")
@pytest.mark.parametrize("lfs_on", [False, True])
def test_gitlab_job_installs_git_lfs_when_the_repository_uses_it(
    tmp_path: Path, lfs_on: bool
) -> None:
    from inkflow import lfs

    root = _repo(tmp_path / "repo", remote="https://gitlab.com/team/talk.git")
    deck = _deck(root)
    lfs.ensure_attributes(root / ".gitattributes", lfs_on)
    _git(root, "add", "-A")
    doc = _load(
        publish.render("gitlab", publish.layout(deck), False)[publish.GITLAB_CI]
    )
    script = str(
        cast("list[str]", cast("YamlMap", doc[".inkflow"])["before_script"])[0]
    )
    # Only the detection: no global git config, no real apt-get or git lfs.
    script = script.replace(
        'git config --global --add safe.directory "$CI_PROJECT_DIR"', ""
    )
    script = script.replace("command -v git-lfs", "false")
    bin_dir, log = tmp_path / "bin", tmp_path / "calls.log"
    bin_dir.mkdir()
    _stub(bin_dir, "apt-get", log)
    env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}"}
    subprocess.run(["sh", "-c", script], cwd=root, env=env, check=True)
    calls = log.read_text(encoding="utf-8") if log.exists() else ""
    assert ("install -y -qq git-lfs" in calls) is lfs_on


# ── Setting up ──


@needs_git
def test_setup_writes_once_and_refuses_to_overwrite(tmp_path: Path) -> None:
    root = _repo(tmp_path / "repo")
    deck = _deck(root)
    result = publish.setup_pages(deck, "github", release=True)
    assert result.written == [publish.GITHUB_PAGES, publish.GITHUB_RELEASE]
    assert result.plan.url == "https://ada.github.io/talk/"
    assert any("GitHub Actions" in s and "/settings/pages" in s for s in result.steps)
    # Again, the same: nothing to write, nothing refused.
    again = publish.setup_pages(deck, "github", release=True)
    assert again.written == [] and set(again.plan.unchanged) == set(result.written)
    assert publish.detect(root) == {
        "host": "github",
        "release": True,
        "url": "https://ada.github.io/talk/",
        "settingsUrl": "https://github.com/ada/talk/settings/pages",
    }
    # An edited workflow is only replaced with force.
    pages = root / publish.GITHUB_PAGES
    pages.write_text(pages.read_text(encoding="utf-8") + "# mine\n", encoding="utf-8")
    with pytest.raises(publish.PublishError, match="earlier setup"):
        publish.setup_pages(deck, "github", release=True)
    publish.setup_pages(deck, "github", release=True, force=True)
    assert "# mine" not in pages.read_text(encoding="utf-8")


@needs_git
def test_setup_refuses_someone_elses_ci_file(tmp_path: Path) -> None:
    root = _repo(tmp_path / "repo", remote="https://gitlab.com/team/talk.git")
    deck = _deck(root)
    ci = root / ".gitlab-ci.yml"
    ci.write_text("test:\n  script: [make test]\n", encoding="utf-8")
    with pytest.raises(publish.PublishError, match=r"not inkflow's.*--print"):
        publish.setup_pages(deck, "gitlab")
    assert ci.read_text(encoding="utf-8").startswith("test:")
    assert publish.detect(root) is None


@needs_git
def test_other_pages_workflows_are_named(tmp_path: Path) -> None:
    root = _repo(tmp_path / "repo")
    deck = _deck(root)
    workflows = root / ".github" / "workflows"
    workflows.mkdir(parents=True)
    (workflows / "docs.yml").write_text(
        "jobs:\n  d:\n    steps:\n      - uses: actions/deploy-pages@v4\n",
        encoding="utf-8",
    )
    warnings = publish.plan(deck, "github").warnings
    assert any(".github/workflows/docs.yml deploys to Pages too" in w for w in warnings)


@needs_git
def test_readme_links_the_slides(tmp_path: Path) -> None:
    root = _repo(tmp_path / "repo")
    deck = _deck(root)
    publish.setup_pages(deck, "github", readme=True, title="My Talk")
    readme = (root / "README.md").read_text(encoding="utf-8")
    assert readme.startswith(
        "# My Talk\n\n**[▶ Open the slides](https://ada.github.io/talk/)**"
    )
    # An existing README gets the link under its heading, once.
    (root / "README.md").write_text("# Talk\n\nAbout it.\n", encoding="utf-8")
    publish.setup_pages(deck, "github", readme=True)
    publish.setup_pages(deck, "github", readme=True)
    assert (root / "README.md").read_text(encoding="utf-8") == (
        "# Talk\n\n**[▶ Open the slides](https://ada.github.io/talk/)**\n\nAbout it.\n"
    )


@needs_git
def test_no_remote_yet(tmp_path: Path) -> None:
    root = _repo(tmp_path / "repo", remote=None)
    deck = _deck(root)
    result = publish.setup_pages(deck, "github", readme=True, title="Talk")
    assert result.plan.url is None
    assert "remote" in str(result.plan.url_note)
    assert any("origin remote" in s for s in result.steps)
    # A README without the link, which a later run adds.
    readme = (root / "README.md").read_text(encoding="utf-8")
    assert "Open the slides" not in readme
    _git(root, "remote", "add", "origin", "https://github.com/ada/talk.git")
    again = publish.setup_pages(deck, "github", readme=True)
    assert again.written == ["README.md"]
    assert "https://ada.github.io/talk/" in (root / "README.md").read_text(
        encoding="utf-8"
    )


# ── Fonts ──


def test_font_sources_name_the_file_or_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    font = tmp_path / "system" / "Inter.ttf"
    font.parent.mkdir()
    font.write_bytes(b"x")
    record = _FontRecord(path=font, family="Inter", weight_class=400, is_italic=False)
    monkeypatch.setitem(
        _index_cache, _FontIndexKey(tmp_path, None), {"inter": [record]}
    )
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg"><text font-family="Inter">a</text>'
        + '<text font-family="Nope, sans-serif">b</text></svg>'
    )
    slide: SlideData = {
        "svg": svg,
        "title": "",
        "id": "",
        "notes": "",
        "editableFiles": [],
    }
    assert font_sources([slide], tmp_path) == [("Inter", font), ("Nope", None)]


def test_font_warnings_name_fonts_only_this_computer_has(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    deck_path = _deck(tmp_path / "talk")
    project = deck_path.parent
    shipped = project / "fonts" / "Shipped.ttf"
    shipped.parent.mkdir()
    shipped.write_bytes(b"x")
    found: list[tuple[str, Path | None]] = [
        ("Shipped", shipped),
        ("Local Sans", tmp_path / "home" / ".fonts" / "Local.ttf"),
        ("Local Sans", shipped),
        ("Gone", None),
    ]

    def sources(*_args: object, **_kwargs: object) -> list[tuple[str, Path | None]]:
        return found

    monkeypatch.setattr("inkflow.fonts.font_sources", sources)
    warnings = publish.font_warnings(load_deck(deck_path), project, deck_path)
    assert len(warnings) == 2
    assert warnings[0].startswith('"Local Sans" is installed on this computer only')
    assert "fonts/" in warnings[0]
    assert warnings[1].startswith('"Gone" is not installed here either')


# ── CLI ──


@needs_git
def test_cli_setup_pages(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _repo(tmp_path / "repo", remote="git@gitlab.com:team/sub/talk.git")
    _deck(root / "talk")
    monkeypatch.chdir(root / "talk")
    runner = CliRunner()
    result = runner.invoke(main, ["setup-pages", "--release"])
    assert result.exit_code == 0, result.output
    assert (root / ".gitlab-ci.yml").is_file()
    assert "https://team.gitlab.io/sub/talk/" in result.output
    assert "unique domain" in result.output
    again = runner.invoke(main, ["setup-pages", "gitlab"])  # without the release
    assert again.exit_code == 1 and "--force" in again.output
    printed = runner.invoke(main, ["setup-pages", "gitlab", "--print"])
    assert printed.exit_code == 0 and "pages:" in printed.output


@needs_git
def test_cli_setup_pages_needs_a_host_it_can_tell(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _repo(tmp_path / "repo", remote="https://example.org/team/talk.git")
    _deck(root)
    monkeypatch.chdir(root)
    result = CliRunner().invoke(main, ["setup-pages"])
    assert result.exit_code == 2 and "name the host" in result.output


@needs_git
def test_init_with_pages(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.chdir(tmp_path)
    result = CliRunner().invoke(
        main, ["init", "my-talk", "--pages", "github", "--release"]
    )
    assert result.exit_code == 0, result.output
    root = tmp_path / "my-talk"
    assert (root / publish.GITHUB_PAGES).is_file()
    assert (root / publish.GITHUB_RELEASE).is_file()
    assert (root / "README.md").read_text(encoding="utf-8").startswith("# My Talk\n")
    assert "GitHub Actions" in result.output
    bad = CliRunner().invoke(main, ["init", "other", "--release"])
    assert bad.exit_code == 2


# ── The editor's publish action ──


@needs_git
def test_session_publish(tmp_path: Path) -> None:
    root = _repo(tmp_path / "repo")
    deck = _deck(root / "talk")
    session = EditorSession(deck)
    status = cast(
        "dict[str, object]", session.apply({"action": "publish"}, None)["publish"]
    )
    assert status["suggested"] == "github" and status["scope"] == "talk"
    assert status["configured"] is None and status["readme"] == "missing"
    hosts = cast("dict[str, dict[str, object]]", status["hosts"])
    assert hosts["github"]["url"] == "https://ada.github.io/talk/"
    assert [
        f["path"] for f in cast("list[dict[str, object]]", hosts["github"]["files"])
    ] == [
        publish.GITHUB_PAGES,
        publish.GITHUB_RELEASE,
    ]
    setup: dict[str, object] = {
        "action": "publish",
        "op": "setup",
        "host": "github",
        "release": True,
    }
    with pytest.raises(EditError, match="only an editor on this machine"):
        session.apply(setup, None)
    out = session.apply({**setup, "_local": True}, None)
    assert out["written"] == [publish.GITHUB_PAGES, publish.GITHUB_RELEASE]
    assert out["label"] == "Publish on GitHub Pages"
    assert (root / publish.GITHUB_PAGES).is_file()
    git = cast("dict[str, object]", out["git"])
    assert git["pages"] == publish.detect(root)
    # One undoable step, though the files are outside the deck's folder.
    session.apply({"action": "undo"}, None)
    assert not (root / publish.GITHUB_PAGES).exists()
    session.apply({"action": "redo"}, None)
    assert (root / publish.GITHUB_PAGES).exists()
    # Someone else's workflow is replaced only when asked to.
    (root / publish.GITHUB_PAGES).write_text("name: mine\n", encoding="utf-8")
    with pytest.raises(EditError, match="replace it"):
        session.apply({**setup, "_local": True}, None)
    session.apply({**setup, "_local": True, "force": True}, None)
    assert publish.made_by_inkflow((root / publish.GITHUB_PAGES).read_text("utf-8"))
