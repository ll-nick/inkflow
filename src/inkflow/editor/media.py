"""Videos (and pictures) coming into a deck from the editor, of any size.

Files arrive one of two ways, neither of them limited in size:

- by path, from this computer (a drop that carries a ``file://`` link, or the
  editor's folder browser): the server copies the file into ``assets/`` (or
  uses it where it is, when it is in the project already);
- in chunks over the WebSocket (a browser never reveals a file's path), staged
  in ``.inkflow/`` and moved into ``assets/`` when complete.

Either way the file lands in ``assets/`` in one rename, so the watcher sees it
once, finished. Conversions (ffmpeg) also write into ``.inkflow/`` first.

``probe`` reads a video with ffprobe (when installed); ``issues`` turns that
into the editor's warnings (a codec only some browsers play, a file over
100 MB, longer than 10 minutes); ``plan`` builds the ffmpeg command that
converts a video to MP4 (H.264) or WebM (VP9) at a resolution and quality,
with a rough size estimate; ``Conversions`` runs one in the background.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import threading
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from inkflow.editor.context import CONTEXT_DIR

VIDEO_SUFFIXES = frozenset({".mp4", ".webm", ".ogg", ".mov"})
# A PDF is a picture too: the build shows a page of it (inkflow/pdf.py).
IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf"})
MEDIA_SUFFIXES = VIDEO_SUFFIXES | IMAGE_SUFFIXES
OTHER_VIDEO_SUFFIXES = frozenset(
    {
        ".mkv",
        ".avi",
        ".m4v",
        ".wmv",
        ".flv",
        ".mpg",
        ".mpeg",
        ".ogv",
        ".ts",
        ".mts",
        ".m2ts",
        ".3gp",
        ".3g2",
        ".mxf",
        ".vob",
        ".f4v",
        ".asf",
        ".dv",
    }
)
"""Common video files browsers do not play but ffmpeg converts (any file with
a video stream is accepted; these are the ones the folder browser lists)."""


def video_suffixes() -> frozenset[str]:
    """What the folder browser lists as videos: with ffmpeg, the convertible too."""
    return (
        VIDEO_SUFFIXES | OTHER_VIDEO_SUFFIXES if tools()["ffmpeg"] else VIDEO_SUFFIXES
    )


LARGE_BYTES = 100 * 1024 * 1024
LONG_SECONDS = 10 * 60

# Codecs every current browser plays, per container.
_WIDE = {"mp4": {"h264"}, "mov": {"h264"}, "webm": {"vp8", "vp9", "av1"}}


class MediaError(ValueError):
    pass


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "media"


def _staging(project_dir: Path) -> Path:
    folder = project_dir / CONTEXT_DIR / "incoming"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def settle(project_dir: Path, staged: Path, name: str) -> Path:
    """Move a finished file from the staging area into ``assets/`` under a
    free name, or drop it for an identical file already there."""
    suffix = Path(name).suffix.lower()
    if suffix not in MEDIA_SUFFIXES:
        staged.unlink(missing_ok=True)
        raise MediaError(f"cannot insert {suffix or 'this kind of'} files")
    assets = project_dir / "assets"
    assets.mkdir(exist_ok=True)
    stem = _slug(Path(name).stem)
    size = staged.stat().st_size
    same_size = [p for p in assets.glob(f"{stem}*{suffix}") if p.stat().st_size == size]
    if same_size:
        digest = _digest(staged)
        for existing in same_size:
            if _digest(existing) == digest:
                staged.unlink()
                return existing
    target = assets / f"{stem}{suffix}"
    n = 2
    while target.exists():
        target = assets / f"{stem}-{n}{suffix}"
        n += 1
    os.replace(staged, target)
    return target


@dataclass(frozen=True)
class Arrival:
    """A file brought in: ready on a slide, or a video ffmpeg must convert
    first (``convert``: then ``path`` is the source to convert from, outside
    ``assets/``)."""

    path: Path
    convert: bool = False


def is_convertible(path: Path) -> bool:
    """A video ffmpeg can read but browsers cannot play as it is: anything with
    a video stream that lasts (a still image has no duration)."""
    if not tools()["ffmpeg"]:
        return False
    info = probe(path)
    duration = info.get("duration")
    return bool(info.get("vcodec")) and isinstance(duration, float) and duration > 0


def _unplayable(suffix: str) -> MediaError:
    hint = (
        " (with ffmpeg installed, any video it can read can be inserted and converted)"
        if not tools()["ffmpeg"]
        else ""
    )
    return MediaError(f"cannot insert {suffix or 'this kind of'} files{hint}")


def import_path(project_dir: Path, source: Path) -> Arrival:
    """A file from this computer, by path: used where it is when it is in the
    project already, else copied into ``assets/``. A video in another format is
    converted straight from where it is (no copy)."""
    source = source.expanduser()
    if not source.is_absolute() or not source.is_file():
        raise MediaError(f"no file at {source}")
    if source.suffix.lower() not in MEDIA_SUFFIXES:
        if is_convertible(source):
            return Arrival(source.resolve(), convert=True)
        raise _unplayable(source.suffix)
    resolved = source.resolve()
    project = project_dir.resolve()
    # (Its own .inkflow/ only: a deck in a worktree lives under another's.)
    if (
        resolved.is_relative_to(project)
        and resolved.relative_to(project).parts[0] != CONTEXT_DIR
    ):
        return Arrival(resolved)
    staged = _staging(project_dir) / f"{secrets.token_hex(8)}.part"
    shutil.copyfile(resolved, staged)
    return Arrival(settle(project_dir, staged, source.name))


@dataclass
class Uploads:
    """Files arriving in chunks, by the id the browser gave them."""

    project_dir: Path
    open: dict[str, Path] = field(default_factory=dict)

    def chunk(self, upload: str, name: str, data: bytes, last: bool) -> Arrival | None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{6,64}", upload):
            raise MediaError("bad upload id")
        suffix = Path(name).suffix.lower()
        # Another format is fine when ffmpeg can convert it: checked once here.
        if suffix not in MEDIA_SUFFIXES and not tools()["ffmpeg"]:
            raise _unplayable(suffix)
        staged = self.open.get(upload)
        if staged is None:
            staged = _staging(self.project_dir) / f"{upload}.part"
            staged.write_bytes(b"")
            self.open[upload] = staged
        with staged.open("ab") as f:
            _ = f.write(data)
        if not last:
            return None
        del self.open[upload]
        if suffix in MEDIA_SUFFIXES:
            return Arrival(settle(self.project_dir, staged, Path(name).name))
        # Kept in the staging area, under its own name, until converted.
        # (a folder per upload keeps the file's own name for the output)
        folder = _staging(self.project_dir) / upload
        folder.mkdir(exist_ok=True)
        source = folder / f"{_slug(Path(name).stem)}{suffix}"
        os.replace(staged, source)
        if not is_convertible(source):
            source.unlink()
            raise MediaError(f"{Path(name).name} is not a video ffmpeg can read")
        return Arrival(source, convert=True)


def discard_source(project_dir: Path, source: Path) -> None:
    """Drop a staged source nobody converted (only ever in the staging area)."""
    staging = (project_dir / CONTEXT_DIR / "incoming").resolve()
    folder = source.resolve().parent
    if folder.parent == staging:
        source.unlink(missing_ok=True)
        with contextlib.suppress(OSError):
            folder.rmdir()


# ── Probing ──


def tools() -> dict[str, bool]:
    return {
        "ffprobe": shutil.which("ffprobe") is not None,
        "ffmpeg": shutil.which("ffmpeg") is not None,
    }


def _rate(text: str) -> float | None:
    try:
        num, _, den = text.partition("/")
        value = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        return None
    return value if value > 0 else None


def probe(path: Path) -> dict[str, object]:
    """What a video is: size always, the rest when ffprobe is installed."""
    info: dict[str, object] = {
        "size": path.stat().st_size,
        "container": path.suffix.lower().lstrip("."),
    }
    if not tools()["ffprobe"]:
        return info
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-of",
                "json",
                "-show_entries",
                "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        raw = cast("dict[str, object]", json.loads(result.stdout or "{}"))
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return info
    streams = cast("list[dict[str, object]]", raw.get("streams") or [])
    fmt = cast("dict[str, object]", raw.get("format") or {})
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    with contextlib.suppress(ValueError):
        info["duration"] = float(str(fmt.get("duration")))
    if video:
        info["vcodec"] = video.get("codec_name")
        info["width"] = video.get("width")
        info["height"] = video.get("height")
        info["fps"] = _rate(str(video.get("avg_frame_rate") or ""))
    info["acodec"] = audio.get("codec_name") if audio else None
    return info


def issues(info: dict[str, object]) -> list[dict[str, str]]:
    """What is worth telling about a video, most serious first."""
    found: list[dict[str, str]] = []
    container = str(info.get("container"))
    vcodec = info.get("vcodec")
    if isinstance(vcodec, str) and vcodec not in _WIDE.get(container, set()):
        where = "only in Safari" if vcodec == "hevc" else "not in every browser"
        found.append(
            {
                "kind": "codec",
                "level": "warning",
                "text": f"Its video is {vcodec.upper()} in .{container}, which plays "
                + f"{where}. MP4 with H.264 plays everywhere; WebM (VP9) almost.",
            }
        )
    size = cast("int", info.get("size") or 0)
    if size > LARGE_BYTES:
        found.append(
            {
                "kind": "size",
                "level": "info",
                "text": f"It is {size / 1024 / 1024:.0f} MB: every viewer of a "
                + "hosted deck downloads it, and git keeps a copy per version "
                + "(Git LFS helps).",
            }
        )
    duration = info.get("duration")
    if isinstance(duration, float) and duration > LONG_SECONDS:
        found.append(
            {
                "kind": "length",
                "level": "info",
                "text": f"It runs {duration / 60:.0f} minutes. Trim start and end "
                + "in its settings, or cut it in a video editor.",
            }
        )
    height = info.get("height")
    if isinstance(height, int) and height > 1440:
        found.append(
            {
                "kind": "resolution",
                "level": "info",
                "text": f"It is {height}p: more than a projector shows, and heavy to "
                + "decode on a laptop. 1080p is plenty for slides.",
            }
        )
    return found


# ── Converting ──

QUALITIES = ("Smallest", "Small", "Balanced", "High", "Best")
_CRF = {"mp4": (30, 26, 23, 20, 18), "webm": (40, 36, 32, 28, 24)}
_BASE_BPP = {"mp4": 0.08, "webm": 0.06}  # bits per pixel per frame, "Balanced"


@dataclass(frozen=True)
class Plan:
    args: list[str]
    out: Path
    estimate: int | None


def _target_size(info: dict[str, object], height: int | None) -> tuple[int, int] | None:
    w, h = info.get("width"), info.get("height")
    if not isinstance(w, int) or not isinstance(h, int) or not h:
        return None
    if height is None or height >= h:
        return w, h
    return round(w * height / h / 2) * 2, height


def remux_target(info: dict[str, object]) -> str | None:
    """The container a video's own streams fit as they are (no re-encoding):
    H.264 in .mp4, VP8/VP9/AV1 in .webm; None when its video needs encoding."""
    vcodec = info.get("vcodec")
    if vcodec == "h264":
        return "mp4"
    if vcodec in ("vp8", "vp9", "av1"):
        return "webm"
    return None


# Audio a container takes as it is; anything else is encoded on the way.
_AUDIO_FITS = {"mp4": {"aac", "mp3"}, "webm": {"opus", "vorbis"}}


def plan(
    source: Path,
    out_dir: Path,
    info: dict[str, object],
    *,
    fmt: str,
    height: int | None,
    quality: int,
    audio: bool,
) -> Plan:
    """The ffmpeg command converting ``source``, and a rough output size.
    ``fmt`` "copy" repackages the streams into the container they fit
    (``remux_target``), without re-encoding the video."""
    if fmt == "copy":
        return _remux(source, out_dir, info, audio)
    if fmt not in _CRF:
        raise MediaError("convert to mp4 or webm")
    quality = max(0, min(len(QUALITIES) - 1, quality))
    crf = _CRF[fmt][quality]
    label = f"{height}p" if height else "converted"
    out = out_dir / f"{_slug(source.stem)}-{label}.{fmt}"
    args = ["ffmpeg", "-hide_banner", "-y", "-i", str(source)]
    source_height = info.get("height")
    # Only ever smaller (the source height is known from ffprobe; without it,
    # scale as asked).
    if height and not (isinstance(source_height, int) and source_height <= height):
        args += ["-vf", f"scale=-2:{height}"]
    if fmt == "mp4":
        args += ["-c:v", "libx264", "-preset", "medium", "-crf", str(crf)]
        args += ["-pix_fmt", "yuv420p"]
        args += ["-c:a", "aac", "-b:a", "128k"] if audio else ["-an"]
        args += ["-movflags", "+faststart"]
    else:
        args += ["-c:v", "libvpx-vp9", "-crf", str(crf), "-b:v", "0", "-row-mt", "1"]
        args += ["-c:a", "libopus", "-b:a", "128k"] if audio else ["-an"]
    args.append(str(out))

    estimate: int | None = None
    size = _target_size(info, height)
    duration = info.get("duration")
    if size and isinstance(duration, float):
        fps = info.get("fps")
        fps = min(fps if isinstance(fps, float) else 30.0, 60.0)
        bpp = _BASE_BPP[fmt] * 2 ** ((_CRF[fmt][2] - crf) / 6)
        video_bps = size[0] * size[1] * fps * bpp
        audio_bps = 128_000 if audio and info.get("acodec") else 0
        estimate = int((video_bps + audio_bps) * duration / 8)
    return Plan(args, out, estimate)


def _remux(source: Path, out_dir: Path, info: dict[str, object], audio: bool) -> Plan:
    target = remux_target(info)
    if target is None:
        raise MediaError("its video cannot be kept as it is: convert it to mp4 or webm")
    out = out_dir / f"{_slug(source.stem)}.{target}"
    args = ["ffmpeg", "-hide_banner", "-y", "-i", str(source), "-map", "0:v:0"]
    args += ["-c:v", "copy"]
    acodec = info.get("acodec")
    if audio and acodec:
        args += ["-map", "0:a:0"]
        if acodec in _AUDIO_FITS[target]:
            args += ["-c:a", "copy"]
        elif target == "mp4":
            args += ["-c:a", "aac", "-b:a", "128k"]
        else:
            args += ["-c:a", "libopus", "-b:a", "128k"]
    else:
        args.append("-an")
    if target == "mp4":
        args += ["-movflags", "+faststart"]
    args.append(str(out))
    size = info.get("size")
    return Plan(args, out, size if isinstance(size, int) else None)


def command_line(p: Plan, display: dict[Path, str]) -> str:
    """The command as one line to copy, with paths shown as given."""
    return shlex.join([display.get(Path(a), a) for a in p.args])


@dataclass
class Job:
    out: Path
    final_name: str
    duration: float | None
    state: str = "running"
    progress: float = 0.0
    error: str = ""
    result: Path | None = None
    process: subprocess.Popen[str] | None = None
    source: Path | None = None


class Conversions:
    """Conversions running in the background, by job id."""

    def __init__(self, project_dir: Path) -> None:
        self.project_dir: Path = project_dir
        self.jobs: dict[str, Job] = {}

    def start(self, p: Plan, duration: float | None, source: Path | None = None) -> str:
        """Run ``p``; a ``source`` staged for converting goes once it is done."""
        if not tools()["ffmpeg"]:
            raise MediaError("ffmpeg is not installed")
        staged = _staging(self.project_dir) / f"{secrets.token_hex(8)}{p.out.suffix}"
        args = [*p.args[:-1], "-progress", "pipe:1", "-nostats", str(staged)]
        job = Job(staged, p.out.name, duration, source=source)
        job_id = secrets.token_hex(6)
        self.jobs[job_id] = job
        job.process = subprocess.Popen(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            text=True,
        )
        threading.Thread(target=self._follow, args=(job,), daemon=True).start()
        return job_id

    def _follow(self, job: Job) -> None:
        process = job.process
        assert process is not None and process.stdout is not None
        for line in cast("Iterable[str]", process.stdout):
            key, _, value = line.strip().partition("=")
            if key == "out_time_us" and job.duration:
                with contextlib.suppress(ValueError):
                    job.progress = min(0.99, int(value) / 1e6 / job.duration)
        stderr = process.stderr.read() if process.stderr else ""
        if process.wait() != 0:
            job.state = "error"
            job.error = (stderr.strip().splitlines() or ["ffmpeg failed"])[-1]
            job.out.unlink(missing_ok=True)
            return
        try:
            job.result = settle(self.project_dir, job.out, job.final_name)
        except (MediaError, OSError) as exc:
            job.state = "error"
            job.error = str(exc)
            return
        if job.source is not None:
            discard_source(self.project_dir, job.source)
        job.progress = 1.0
        job.state = "done"

    def status(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if job is None:
            raise MediaError("no such conversion")
        return job

    def cancel(self, job_id: str) -> None:
        job = self.status(job_id)
        if job.process and job.process.poll() is None:
            job.process.terminate()
