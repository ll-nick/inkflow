"""Videos coming into a deck: copies by path and in chunks, probing, the
conversion plan and its size estimate, conversion jobs, and byte ranges."""

from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path
from typing import cast

import pytest

from inkflow.editor import media
from inkflow.editor.session import EditError, EditorSession
from inkflow.server import byte_range

has_ffmpeg = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@pytest.fixture
def project(tmp_path: Path) -> Path:
    deck = tmp_path / "deck"
    deck.mkdir()
    (deck / "deck.py").write_text("# deck\n", encoding="utf-8")
    return deck


@pytest.fixture
def clip(tmp_path: Path) -> Path:
    if not has_ffmpeg:
        pytest.skip("needs ffmpeg")
    out = tmp_path / "outside" / "Clip One.webm"
    out.parent.mkdir()
    subprocess.run(
        [
            "ffmpeg",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=2:size=640x360:rate=25",
            "-c:v",
            "libvpx",
            "-b:v",
            "300k",
            str(out),
        ],
        check=True,
    )
    return out


def test_import_by_path_copies_once_and_reuses_project_files(
    project: Path, tmp_path: Path
) -> None:
    source = tmp_path / "Holiday Film.mp4"
    source.write_bytes(b"\0" * 1000)
    first = media.import_path(project, source).path
    assert first == project / "assets" / "holiday-film.mp4"
    assert media.import_path(project, source).path == first  # identical: no copy
    source.write_bytes(b"\1" * 1000)
    assert media.import_path(project, source).path.name == "holiday-film-2.mp4"
    # Already in the project: used where it is.
    assert media.import_path(project, first) == media.Arrival(first)
    with pytest.raises(media.MediaError, match="cannot insert"):
        (tmp_path / "notes.txt").write_text("x", encoding="utf-8")
        media.import_path(project, tmp_path / "notes.txt")
    assert not any((project / ".inkflow" / "incoming").iterdir())


def test_chunks_arrive_whole_however_many(project: Path) -> None:
    uploads = media.Uploads(project)
    assert uploads.chunk("abc123", "talk.mp4", b"one-", last=False) is None
    assert uploads.chunk("abc123", "talk.mp4", b"two-", last=False) is None
    done = uploads.chunk("abc123", "talk.mp4", b"three", last=True)
    assert done is not None and not done.convert
    assert done.path.read_bytes() == b"one-two-three"
    with pytest.raises(media.MediaError):
        uploads.chunk("../x", "talk.mp4", b"", last=True)


def test_issues_name_codec_size_length_and_resolution() -> None:
    fine: dict[str, object] = {
        "container": "mp4",
        "vcodec": "h264",
        "size": 10,
        "duration": 30.0,
    }
    assert media.issues(fine) == []
    found = media.issues(
        {
            "container": "mov",
            "vcodec": "hevc",
            "size": 200 * 1024 * 1024,
            "duration": 900.0,
            "height": 2160,
        }
    )
    assert [i["kind"] for i in found] == ["codec", "size", "length", "resolution"]
    assert "only in Safari" in found[0]["text"]


def test_plan_builds_the_command_and_a_rough_size(tmp_path: Path) -> None:
    info: dict[str, object] = {
        "width": 3840,
        "height": 2160,
        "fps": 30.0,
        "duration": 60.0,
        "acodec": "aac",
    }
    source = tmp_path / "clip.mov"
    full = media.plan(
        source, tmp_path, info, fmt="mp4", height=1080, quality=2, audio=True
    )
    assert full.args[:5] == ["ffmpeg", "-hide_banner", "-y", "-i", str(source)]
    assert "scale=-2:1080" in full.args
    same = media.plan(
        source, tmp_path, info, fmt="mp4", height=2160, quality=2, audio=True
    )
    assert "-vf" not in same.args  # never larger than the source
    assert full.args[full.args.index("-crf") : full.args.index("-crf") + 2] == [
        "-crf",
        "23",
    ]
    assert full.args[-1] == str(tmp_path / "clip-1080p.mp4")
    assert full.estimate is not None
    # 1080p30 at "balanced": a few MB per minute, as x264 gives.
    assert 20e6 < full.estimate < 80e6
    smaller = media.plan(
        source, tmp_path, info, fmt="mp4", height=720, quality=0, audio=False
    )
    assert smaller.estimate is not None and smaller.estimate < full.estimate / 4
    assert "-an" in smaller.args
    webm = media.plan(
        source, tmp_path, info, fmt="webm", height=None, quality=4, audio=True
    )
    assert "libvpx-vp9" in webm.args and "libopus" in webm.args
    assert webm.args[-1].endswith("clip-converted.webm")
    unknown = media.plan(
        source, tmp_path, {}, fmt="mp4", height=480, quality=2, audio=True
    )
    assert unknown.estimate is None
    with pytest.raises(media.MediaError):
        media.plan(
            source, tmp_path, info, fmt="avi", height=None, quality=2, audio=True
        )


def test_byte_ranges() -> None:
    assert byte_range(100, None) is None
    assert byte_range(100, (0, None)) == (0, 99)
    assert byte_range(100, (10, 19)) == (10, 19)
    assert byte_range(100, (90, 500)) == (90, 99)
    assert byte_range(100, (None, 10)) == (90, 99)
    with pytest.raises(ValueError):
        byte_range(100, (100, None))


@pytest.mark.skipif(not has_ffmpeg, reason="needs ffmpeg")
def test_probe_and_convert_through_the_session(project: Path, clip: Path) -> None:
    session = EditorSession(project / "deck.py")
    with pytest.raises(EditError, match="this machine"):
        session.apply({"action": "import-path", "path": str(clip)}, None)
    placed = session.apply(
        {"action": "import-path", "path": str(clip), "_local": True}, None
    )
    assert placed["rel"] == "assets/clip-one.webm"

    info = session.apply({"action": "media-info", "path": placed["rel"]}, None)
    probed = cast("dict[str, object]", info["info"])
    assert probed["vcodec"] == "vp8" and probed["width"] == 640
    assert probed["duration"] == pytest.approx(2.0, abs=0.1)
    assert info["issues"] == []

    request = {"path": placed["rel"], "format": "mp4", "height": 240, "quality": 0}
    plan = session.apply({"action": "convert-plan", **request}, None)
    assert str(plan["command"]).startswith(
        "ffmpeg -hide_banner -y -i assets/clip-one.webm"
    )
    assert plan["out"] == "assets/clip-one-240p.mp4"

    job = session.apply({"action": "convert", "_local": True, **request}, None)["job"]
    status: dict[str, object] = {}
    for _ in range(200):
        status = session.apply({"action": "convert-status", "job": job}, None)
        if status["state"] != "running":
            break
        time.sleep(0.1)
    assert status["state"] == "done", status
    assert status["rel"] == "assets/clip-one-240p.mp4"
    out = media.probe(project / "assets" / "clip-one-240p.mp4")
    assert out["vcodec"] == "h264" and out["height"] == 240


@pytest.fixture
def mkv(tmp_path: Path) -> Path:
    """H.264 with PCM sound in Matroska: browsers cannot play the file, but
    its video can move into an .mp4 untouched."""
    if not has_ffmpeg:
        pytest.skip("needs ffmpeg")
    out = tmp_path / "camera" / "Take 1.mkv"
    out.parent.mkdir()
    subprocess.run(
        [
            "ffmpeg",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=2:size=320x180:rate=25",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=2",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "pcm_s16le",
            "-shortest",
            str(out),
        ],
        check=True,
    )
    return out


def test_remux_keeps_the_video_and_fixes_the_sound(tmp_path: Path) -> None:
    info: dict[str, object] = {"vcodec": "h264", "acodec": "pcm_s16le", "size": 500}
    assert media.remux_target(info) == "mp4"
    plan = media.plan(
        tmp_path / "Take 1.mkv",
        tmp_path,
        info,
        fmt="copy",
        height=720,
        quality=0,
        audio=True,
    )
    assert plan.args[plan.args.index("-c:v") + 1] == "copy"
    assert plan.args[plan.args.index("-c:a") + 1] == "aac"  # PCM does not fit .mp4
    assert "-vf" not in plan.args and plan.out.name == "take-1.mp4"
    assert plan.estimate == 500
    vp9: dict[str, object] = {"vcodec": "vp9", "acodec": "opus"}
    webm = media.plan(
        tmp_path / "a.mkv",
        tmp_path,
        vp9,
        fmt="copy",
        height=None,
        quality=2,
        audio=True,
    )
    assert (
        webm.out.suffix == ".webm" and webm.args[webm.args.index("-c:a") + 1] == "copy"
    )
    with pytest.raises(media.MediaError, match="cannot be kept"):
        media.plan(
            tmp_path / "a.mkv",
            tmp_path,
            {"vcodec": "hevc"},
            fmt="copy",
            height=None,
            quality=2,
            audio=True,
        )


def test_other_formats_come_in_for_converting(project: Path, mkv: Path) -> None:
    # By path: converted from where it is, nothing copied.
    arrival = media.import_path(project, mkv)
    assert arrival == media.Arrival(mkv.resolve(), convert=True)
    assert not (project / "assets").exists()
    # In chunks: kept in the staging area until it is converted.
    uploads = media.Uploads(project)
    staged = uploads.chunk("up1234", mkv.name, mkv.read_bytes(), last=True)
    assert staged is not None and staged.convert
    assert staged.path.parent.parent == project / ".inkflow" / "incoming"
    # Not a video: refused.
    with pytest.raises(media.MediaError, match="not a video"):
        uploads.chunk("up5678", "notes.xyz", b"hello", last=True)

    session = EditorSession(project / "deck.py")
    info = session.apply({"action": "media-info", "path": str(staged.path)}, None)
    assert info["remux"] == "mp4"
    with pytest.raises(EditError, match="no video"):
        session.apply({"action": "media-info", "path": str(mkv)}, None)  # not local
    job = session.apply(
        {
            "action": "convert",
            "_local": True,
            "path": str(staged.path),
            "format": "copy",
            "audio": True,
        },
        None,
    )["job"]
    status: dict[str, object] = {}
    for _ in range(200):
        status = session.apply({"action": "convert-status", "job": job}, None)
        if status["state"] != "running":
            break
        time.sleep(0.1)
    assert status["state"] == "done", status
    assert status["rel"] == "assets/take-1.mp4"
    assert not staged.path.parent.exists()  # the staged source goes once converted
    out = media.probe(project / "assets" / "take-1.mp4")
    assert out["vcodec"] == "h264" and out["acodec"] == "aac"
