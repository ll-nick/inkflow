from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from rich.console import Group, RenderableType
from rich.live import Live
from rich.panel import Panel
from rich.spinner import Spinner
from rich.text import Text

from inkflow.logging import LogEntry

# Icon + Rich style per log level for the build summary (colours match the console
# handler). Only warnings get the triangle; lower levels are quieter marks.
_LOG_MARK: dict[str, tuple[str, str]] = {
    "debug": ("◦", "dim"),
    "info": ("ℹ", "blue"),  # noqa: RUF001  intentional info glyph, not the letter i
    "warning": ("⚠", "yellow"),
    "error": ("✖", "bold red"),
}


class LiveUI:
    """Owns the entire terminal UI: header panel + status line."""

    def __init__(
        self,
        live: Live,
        host: str,
        http_port: int,
        watch_path: Path,
        get_clients: Callable[[], int],
        scheme: str = "http",
    ) -> None:
        self._live: Live = live
        self._scheme: str = scheme
        self._share: list[str] = []
        self._owner: list[str] = []
        self._http_port: int = http_port
        self._host: str = host
        self._watch_path: Path = watch_path
        self._get_clients: Callable[[], int] = get_clients
        self._phase: str = "idle"
        self._slides: int = 0
        self._processed: int | None = None
        self._elapsed: float = 0.0
        self._built_at: str = ""
        self._logs: list[LogEntry] = []
        self._error_trace: str | None = None
        self._show_trace: bool = False

    def _header(self) -> RenderableType:
        clients = self._get_clients()
        client_str = f"{clients} client{'s' if clients != 1 else ''}"

        title = Text()
        title.append("ink", style="bold white")
        title.append("flow", style="bold blue")

        content = Group(
            Text.assemble(
                (f"{self._scheme}://{self._host}:{self._http_port}", "bold"),
                ("  ·  ", "dim"),
                (client_str, "dim"),
            ),
            Text.assemble(
                (str(self._watch_path), "dim"),
                overflow="ellipsis",
                no_wrap=True,
            ),
            *(
                Text.assemble(("owner  ", "bold"), (link, "bold cyan"), overflow="fold")
                for link in self._owner[:1]
            ),
            *(Text(line, style="dim", overflow="fold") for line in self._owner[1:]),
            *(Text(line, style="dim", overflow="fold") for line in self._share),
            Text(""),
            Text.assemble(
                ("o", "bold"),
                ("  open", "dim"),
                ("  ·  ", "dim"),
                ("e", "bold"),
                ("  edit", "dim"),
                ("  ·  ", "dim"),
                ("r", "bold"),
                ("  rebuild", "dim"),
                ("  ·  ", "dim"),
                ("q", "bold"),
                ("  quit", "dim"),
            ),
        )
        return Panel(
            content, title=title, title_align="left", expand=False, padding=(0, 2)
        )

    def _renderable(self) -> RenderableType:
        parts: list[RenderableType] = [Text(""), self._header(), Text("")]

        if self._phase == "building":
            parts.append(Spinner("dots", text=" Building…"))
        elif self._phase == "ok":
            for entry in self._logs:
                icon, style = _LOG_MARK.get(entry.level, ("⚠", "yellow"))
                parts.append(Text(f" {icon}  {entry.message}", style=style))
            if self._logs:
                parts.append(Text(""))

            slide_word = "slide" if self._slides == 1 else "slides"
            summary = f" ✓  built {self._slides} {slide_word} in {self._elapsed:.2f}s"
            # A rebuild processes the slides a change touched and keeps the rest.
            if self._processed is not None and self._processed < self._slides:
                summary += f" ({self._processed} changed)"
            parts.append(
                Text.assemble(
                    (summary, "bold green"),
                    (" · ", "white"),
                    (self._built_at, "white"),
                )
            )
        elif self._phase == "error":
            tb = self._error_trace or ""
            last_line = next(
                (line for line in reversed(tb.splitlines()) if line.strip()),
                "unknown error",
            )
            parts.append(Text(f" ✗  {last_line}", style="bold red", no_wrap=True))
            if self._show_trace:
                for line in tb.rstrip().splitlines():
                    parts.append(Text(line, style="dim red"))
                parts.append(Text("[t] hide trace", style="dim"))
            else:
                parts.append(Text("[t] show trace", style="dim"))

        return Group(*parts)

    def refresh(self) -> None:
        self._live.update(self._renderable())
        self._live.refresh()

    def set_share(self, lines: list[str]) -> None:
        """The share links (and SSH recipe) under the address; none when the
        server is not shared."""
        self._share = lines
        self.refresh()

    def set_owner(self, lines: list[str]) -> None:
        """In SSH mode, the owner link (shown bold) and the tunnel to open
        it through; none otherwise."""
        self._owner = lines
        self.refresh()

    def set_building(self) -> None:
        self._phase = "building"
        self._logs = []
        self.refresh()

    def set_ok(
        self,
        slides: int,
        elapsed: float,
        logs: list[LogEntry] | None = None,
        processed: int | None = None,
    ) -> None:
        self._phase = "ok"
        self._slides = slides
        self._processed = processed
        self._elapsed = elapsed
        self._built_at = datetime.now().strftime("%H:%M:%S")
        self._logs = logs or []
        self._error_trace = None
        self._show_trace = False
        self.refresh()

    def set_error(self, error_trace: str) -> None:
        self._phase = "error"
        self._error_trace = error_trace
        self._show_trace = False
        self.refresh()

    def toggle_trace(self) -> None:
        if self._phase != "error":
            return
        self._show_trace = not self._show_trace
        self.refresh()
