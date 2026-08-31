# pyright: reportPrivateUsage=none
from __future__ import annotations

import logging
from pathlib import Path

import pytest

from inkflow.logging import (
    OFF,
    Levels,
    _status_text,
    collect_logs,
    configure,
    logger,
    parse_level,
    resolve_levels,
)

_ENV_VARS = (
    "INKFLOW_LOG_LEVEL",
    "INKFLOW_LOG_LEVEL_CONSOLE",
    "INKFLOW_LOG_LEVEL_FILE",
    "INKFLOW_LOG_LEVEL_BROWSER",
    "INKFLOW_LOG_FILE",
)


@pytest.fixture(autouse=True)
def _isolated_logging(  # pyright: ignore[reportUnusedFunction]
    monkeypatch: pytest.MonkeyPatch,
):
    """Clear the INKFLOW_LOG* env so resolution is deterministic, and detach any
    managed handlers afterwards so file handles are released for later tests."""
    for name in _ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    yield
    configure(Levels(OFF, OFF, OFF, None), attach_console=False)


# ── collect_logs ──────────────────────────────────────────────────────────────


def test_collect_logs_captures_at_and_above_floor() -> None:
    with collect_logs(logging.WARNING) as entries:
        logger.debug("noise")
        logger.info("status")
        logger.warning("a warning")
        logger.error("an error")
    assert [(e.level, e.message) for e in entries] == [
        ("warning", "a warning"),
        ("error", "an error"),
    ]


def test_collect_logs_floor_can_include_info() -> None:
    with collect_logs(logging.INFO) as entries:
        logger.debug("noise")
        logger.info("kept")
        logger.warning("also kept")
    assert [e.level for e in entries] == ["info", "warning"]


def test_collect_logs_entry_carries_numeric_level() -> None:
    with collect_logs(logging.DEBUG) as entries:
        logger.error("boom")
    assert entries[0].levelno == logging.ERROR


def test_collect_logs_removes_handler_on_exit() -> None:
    before = len(logger.handlers)
    with collect_logs(logging.WARNING):
        assert len(logger.handlers) == before + 1
    assert len(logger.handlers) == before


# ── resolve_levels — defaults & cascade ───────────────────────────────────────


def test_resolve_levels_defaults() -> None:
    levels = resolve_levels()
    assert levels.console == logging.WARNING
    assert levels.file == OFF
    assert levels.browser == logging.WARNING
    assert levels.file_path is None


def test_resolve_levels_baseline_applies_to_all_sinks() -> None:
    levels = resolve_levels(log_level="debug")
    assert levels.console == logging.DEBUG
    assert levels.file == logging.DEBUG
    assert levels.browser == logging.DEBUG


def test_resolve_levels_per_sink_flag_overrides_baseline() -> None:
    levels = resolve_levels(log_level="debug", file="off")
    assert levels.console == logging.DEBUG
    assert levels.file == OFF


def test_resolve_levels_per_sink_env_beats_baseline_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("INKFLOW_LOG_LEVEL_FILE", "info")
    levels = resolve_levels(log_level="warning")
    assert levels.file == logging.INFO
    assert levels.console == logging.WARNING  # baseline still governs other sinks


def test_resolve_levels_sink_flag_beats_sink_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("INKFLOW_LOG_LEVEL_CONSOLE", "error")
    assert resolve_levels(console="debug").console == logging.DEBUG


def test_resolve_levels_env_baseline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INKFLOW_LOG_LEVEL", "error")
    assert resolve_levels().browser == logging.ERROR


def test_resolve_levels_file_path_from_flag() -> None:
    assert resolve_levels(log_file="/tmp/x.log").file_path == Path("/tmp/x.log")


def test_resolve_levels_file_path_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INKFLOW_LOG_FILE", "/tmp/env.log")
    assert resolve_levels().file_path == Path("/tmp/env.log")


# ── parse_level ───────────────────────────────────────────────────────────────


def test_parse_level_known() -> None:
    assert parse_level("off") == OFF
    assert parse_level("warning") == logging.WARNING
    assert parse_level("ERROR") == logging.ERROR  # case-insensitive


def test_parse_level_unknown_raises() -> None:
    with pytest.raises(ValueError):
        parse_level("verbose")


# ── configure — file sink ─────────────────────────────────────────────────────


def test_configure_file_sink_writes_at_its_level(tmp_path: Path) -> None:
    log_file = tmp_path / "debug.log"
    configure(
        Levels(console=OFF, file=logging.DEBUG, browser=OFF, file_path=log_file),
        attach_console=False,
    )
    logger.debug("a debug line")
    logger.warning("a warning line")
    contents = log_file.read_text(encoding="utf-8")
    assert "a debug line" in contents
    assert "a warning line" in contents


def test_configure_file_level_filters_below_threshold(tmp_path: Path) -> None:
    log_file = tmp_path / "warn.log"
    configure(
        Levels(console=OFF, file=logging.WARNING, browser=OFF, file_path=log_file),
        attach_console=False,
    )
    logger.info("filtered out")
    logger.warning("kept")
    contents = log_file.read_text(encoding="utf-8")
    assert "filtered out" not in contents
    assert "kept" in contents


def test_configure_file_off_creates_no_file(tmp_path: Path) -> None:
    log_file = tmp_path / "never.log"
    configure(
        Levels(console=OFF, file=OFF, browser=OFF, file_path=log_file),
        attach_console=False,
    )
    logger.warning("nothing")
    assert not log_file.exists()


def test_configure_file_default_path_used_when_unset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "sub" / "inkflow-debug.log"
    monkeypatch.setattr("inkflow.logging._default_log_file", lambda: target)
    configure(Levels(OFF, logging.DEBUG, OFF, None), attach_console=False)
    logger.warning("hi")
    assert target.exists()  # parent dir created, sink active
    assert "hi" in target.read_text(encoding="utf-8")


# ── configure — console sink ──────────────────────────────────────────────────


def _has_console() -> bool:
    return any(h.__class__.__name__ == "_ConsoleHandler" for h in logger.handlers)


def test_configure_attaches_console_when_requested() -> None:
    configure(Levels(logging.WARNING, OFF, OFF, None), attach_console=True)
    assert _has_console()


def test_configure_no_console_when_disabled() -> None:
    configure(Levels(logging.WARNING, OFF, OFF, None), attach_console=False)
    assert not _has_console()


def test_configure_no_console_when_console_off() -> None:
    configure(Levels(OFF, OFF, OFF, None), attach_console=True)
    assert not _has_console()


# ── foreign records ───────────────────────────────────────────────────────────


def _foreign_handlers() -> list[logging.Handler]:
    return [
        h
        for h in logging.getLogger().handlers
        if h.__class__.__name__ == "_ForeignHandler"
    ]


def test_foreign_record_reaches_inkflow_sinks_at_its_own_level() -> None:
    configure(Levels(OFF, OFF, OFF, None), attach_console=False)

    with collect_logs(logging.DEBUG) as entries:
        logging.getLogger("fontTools.subset").warning("a font problem")

    assert [(e.level, e.message) for e in entries] == [
        ("warning", "fontTools.subset: a font problem")
    ]


def test_foreign_record_keeps_its_traceback() -> None:
    configure(Levels(OFF, OFF, OFF, None), attach_console=False)

    with collect_logs(logging.DEBUG) as entries:
        try:
            raise RuntimeError("boom")
        except RuntimeError:
            logging.getLogger("websockets.server").exception("handler failed")

    assert "RuntimeError: boom" in entries[0].message


def test_foreign_records_below_root_level_are_ignored() -> None:
    """Root keeps its default WARNING level: a library's info chatter (fontTools logs
    one line per subsetted table) never reaches our sinks."""
    configure(Levels(OFF, OFF, OFF, None), attach_console=False)

    with collect_logs(logging.DEBUG) as entries:
        logging.getLogger("fontTools.subset").info("cmap subsetted")

    assert entries == []


def test_configure_adopts_root_once() -> None:
    configure(Levels(OFF, OFF, OFF, None), attach_console=False)
    configure(Levels(logging.WARNING, OFF, OFF, None), attach_console=False)
    assert len(_foreign_handlers()) == 1


# ── status column ─────────────────────────────────────────────────────────────


def test_status_text_right_justifies_verb() -> None:
    text = _status_text("Built", "index.html", "green")
    plain = text.plain
    assert plain.startswith(" ")  # verb is right-justified in its column
    assert plain.lstrip().startswith("Built")
    assert plain.endswith("index.html")


def test_status_text_omits_empty_detail() -> None:
    assert _status_text("Ok", "", "green").plain.strip() == "Ok"
