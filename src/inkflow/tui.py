from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from pathlib import Path

from rich.console import Group, RenderableType
from rich.live import Live
from rich.panel import Panel
from rich.spinner import Spinner
from rich.text import Text


class LiveUI:
    """Owns the entire terminal UI: header panel + status line."""

    def __init__(
        self,
        live: Live,
        host: str,
        http_port: int,
        watch_path: Path,
        get_clients: Callable[[], int],
    ) -> None:
        self._live: Live = live
        self._http_port: int = http_port
        self._host: str = host
        self._watch_path: Path = watch_path
        self._get_clients: Callable[[], int] = get_clients
        self._phase: str = "idle"
        self._slides: int = 0
        self._elapsed: float = 0.0
        self._built_at: str = ""
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
                (f"http://{self._host}:{self._http_port}", "bold"),
                ("  ·  ", "dim"),
                (client_str, "dim"),
            ),
            Text.assemble(
                (str(self._watch_path), "dim"),
                overflow="ellipsis",
                no_wrap=True,
            ),
            Text(""),
            Text.assemble(
                ("o", "bold"),
                ("  open", "dim"),
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
            slide_word = "slide" if self._slides == 1 else "slides"
            summary = f" ✓  built {self._slides} {slide_word} in {self._elapsed:.2f}s"
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

    def set_building(self) -> None:
        self._phase = "building"
        self.refresh()

    def set_ok(self, slides: int, elapsed: float) -> None:
        self._phase = "ok"
        self._slides = slides
        self._elapsed = elapsed
        self._built_at = datetime.now().strftime("%H:%M:%S")
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
