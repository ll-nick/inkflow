# Publishing online

A deck in a GitHub or GitLab repository can put itself online at every push:
a CI job runs [`inkflow build --assets-folder`](export.md#media-in-a-folder-assets-folder)
(media as files beside the page, so videos stream) and
publishes the result with GitHub Pages or GitLab Pages, so the link to the
slides always shows the last version you pushed. Optionally, every tag
`v<version>` also makes a release carrying the slides as one self-contained
HTML file and a PDF, for the version you presented.

```bash
inkflow setup-pages github            # or gitlab; default: the host of `origin`
inkflow setup-pages github --release  # also a release at every tag v*
```

For a new project, `inkflow init my-talk --pages github [--release]` does the
same and writes a short `README.md`. In the [visual editor](../editor/index.md#version-control),
**Git → Publish…** does it with a dialog.

`setup-pages` prints the address the slides will have and what is left to do:

```text
GitHub Pages: https://ada.github.io/my-talk/
Next:
  1. Commit and push: git add .github/workflows/pages.yml && git commit -m "Publish the slides" && git push
  2. Once: Settings → Pages → Source: "GitHub Actions" (https://github.com/ada/my-talk/settings/pages)
```

## GitHub Pages

`setup-pages github` writes `.github/workflows/pages.yml`: at every push to the
repository's default branch (the one `origin` names as its HEAD, else the branch
you are on) and when started by hand (*Actions → Publish slides → Run
workflow*), it checks the repository out, installs
[uv](https://docs.astral.sh/uv/), builds the deck into `_site/` and deploys it.

One setting is needed once per repository: **Settings → Pages → Build and
deployment → Source: GitHub Actions**. If the first run failed before that,
run it again.

The slides appear at `https://<owner>.github.io/<repository>/`; a repository
named `<owner>.github.io` is the owner's own site, at
`https://<owner>.github.io/`. A custom domain or GitHub Enterprise has its own
address, which the Pages settings show.

## GitLab Pages

`setup-pages gitlab` writes `.gitlab-ci.yml` with a job named `pages` that
builds the deck into `public/` at every push to the default branch. A job named
`pages` publishing `public/` is understood by every GitLab version; newer ones
also accept `pages: true` on a job of any name, if you rename it.

A public project needs nothing more. For a private or internal one,
**Settings → General → Visibility → Pages** decides who can see the slides.

On GitLab.com the classic address is `https://<group>.gitlab.io/<project>/`
(with subgroups: `https://<group>.gitlab.io/<subgroup>/<project>/`). New
projects usually get a *unique domain* instead
(`https://<project>-<random>.gitlab.io/`): **Deploy → Pages** shows the real
address, and turning off "Use unique domain" there brings the classic one
back. A self-hosted GitLab has a Pages domain of its own, which `setup-pages`
cannot know: Deploy → Pages shows it after the first run.

The jobs run in the `ghcr.io/astral-sh/uv` image (Debian with uv), so the
runner needs Docker images, as GitLab.com's shared runners have.

## Releases

With `--release`, pushing a tag makes a release:

```bash
git tag v1.0
git push origin v1.0
```

The release carries `<repository>-1.0-slides.html` (`inkflow build`:
the whole deck, pictures, videos and fonts included, in one file that opens
without a server) and `<repository>-1.0-slides.pdf` (`inkflow
export`). For a deck in a folder of a larger repository the folder's name is
added: `<repository>-<folder>-1.0-slides.html`.

- **GitHub**: `.github/workflows/release.yml` attaches both files to a GitHub
  release with generated notes. Chromium for the PDF comes with the runner.
- **GitLab**: a `release-files` job builds both (installing Chromium in the
  job) and keeps them as job artifacts that never expire; a `release` job
  creates the GitLab release linking to them.

## What the workflow takes care of

**The pinned inkflow.** The deck's `pyproject.toml` (which `inkflow init`
writes) pins inkflow, and the workflow runs `uv run inkflow …` with it, so the
online deck is built by the inkflow version your project asks for, from
`uv.lock` when it is committed. Without a `pyproject.toml` that depends on
inkflow, the workflow installs the version you set it up with
(`uv run --with "inkflow~=X.Y.Z"`) and `setup-pages` says so.

**A deck in a folder.** The workflow lives at the repository's root and builds
with `--deck <folder>/deck.py` (and `uv run --project <folder>` when the
`pyproject.toml` is there), so one repository can hold a talk among other
things. A repository has one Pages site: `setup-pages` warns when another
workflow already deploys to it.

**Git LFS.** `inkflow init` keeps videos, images and fonts in
[Git LFS](https://git-lfs.com). The GitHub checkout always fetches LFS files
(harmless without any); the GitLab job installs `git-lfs` and pulls the files
when a `.gitattributes` in the repository uses LFS. Without this the site would
ship the small pointer files in place of your pictures.

**PDF figures.** A [PDF figure](../authoring/pdf-figures.md) needs a converter
on the runner. The workflow installs `poppler-utils` (`pdftocairo`) when the
deck's folder has a PDF in git, and only then.

**Fonts.** `inkflow build` embeds the fonts it finds. The ones inkflow ships
(Inter, JetBrains Mono, STIX Two Math, Twemoji) are there on every runner, but
a CI runner has none of the fonts installed on your computer. `setup-pages`
(and the Publish dialog) names the fonts the deck uses that only your computer
has: copy their files into the project's `fonts/` and commit them, or the
online deck falls back to the runner's fonts. See [Fonts](../design/fonts.md).

## Changing it later

The files are plain CI files: edit them as you like. Running `setup-pages`
again changes nothing when they are as it would write them, and refuses to
replace a file that differs (your edits, or other settings such as
`--release`) unless you pass `--force`. A `.gitlab-ci.yml` that inkflow did not
write is never replaced without `--force`: `inkflow setup-pages gitlab --print`
prints the jobs to add to it by hand.

`--readme` adds an "Open the slides" link to `README.md` under its first
heading (or writes a short README when there is none).
