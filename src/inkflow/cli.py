from __future__ import annotations

import argparse
import asyncio
import importlib.resources
import importlib.util
import json
import sys
from pathlib import Path

from watchfiles import awatch
from websockets.asyncio.server import serve as ws_serve

from inkflow.pipeline import process_deck

# ── Shared mutable state ──────────────────────────────────────────────────────

_state: dict = {
    "slides": [],
    "ws_clients": set(),
}


# ── Deck loader ───────────────────────────────────────────────────────────────

def load_deck(deck_path: Path):
    spec = importlib.util.spec_from_file_location("_inkflow_deck", deck_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    if not hasattr(mod, "deck"):
        raise AttributeError(
            f"{deck_path} must define a module-level variable named 'deck'"
        )
    return mod.deck


# ── Build pipeline ────────────────────────────────────────────────────────────

async def rebuild(deck_path: Path, out_dir: Path) -> None:
    try:
        deck = await asyncio.to_thread(load_deck, deck_path)
        project_dir = deck_path.parent
        slides = await asyncio.to_thread(process_deck, deck, project_dir, out_dir)
        _state["slides"] = slides
        print(f"[inkflow] built {len(slides)} slide(s)")
        await broadcast("reload")
    except Exception as exc:
        print(f"[inkflow] build error: {exc}", file=sys.stderr)


# ── WebSocket broadcast ───────────────────────────────────────────────────────

async def broadcast(msg: str) -> None:
    dead: set = set()
    for ws in list(_state["ws_clients"]):
        try:
            await ws.send(msg)
        except Exception:
            dead.add(ws)
    _state["ws_clients"] -= dead


# ── WebSocket handler ─────────────────────────────────────────────────────────

async def ws_handler(websocket) -> None:
    _state["ws_clients"].add(websocket)
    try:
        await websocket.wait_closed()
    finally:
        _state["ws_clients"].discard(websocket)


# ── HTTP handler ──────────────────────────────────────────────────────────────

def _build_html(ws_port: int) -> bytes:
    template = (
        importlib.resources.files("inkflow")
        .joinpath("presenter.html")
        .read_text(encoding="utf-8")
    )
    html = template.replace(
        "__SLIDES_JSON__", json.dumps(_state["slides"])
    ).replace(
        "__WS_PORT__", str(ws_port)
    )
    return html.encode("utf-8")


async def make_http_handler(ws_port: int):
    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            raw = await asyncio.wait_for(reader.read(4096), timeout=10)
            first_line = raw.decode(errors="replace").split("\r\n")[0]
            parts = first_line.split()
            path = parts[1] if len(parts) >= 2 else "/"

            if path == "/":
                body = _build_html(ws_port)
                header = (
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Type: text/html; charset=utf-8\r\n"
                    b"Cache-Control: no-store\r\n"
                    b"Connection: close\r\n"
                    + b"Content-Length: " + str(len(body)).encode() + b"\r\n"
                    + b"\r\n"
                )
                writer.write(header + body)
            else:
                writer.write(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")

            await writer.drain()
        except Exception:
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    return handler


# ── File watcher ──────────────────────────────────────────────────────────────

async def _watch(deck_path: Path, out_dir: Path) -> None:
    watch_dir = deck_path.parent
    out_str = str(out_dir)
    async for changes in awatch(str(watch_dir)):
        relevant = any(
            not str(path).startswith(out_str)
            for _, path in changes
        )
        if relevant:
            print(f"[inkflow] change detected, rebuilding…")
            await rebuild(deck_path, out_dir)


# ── Serve ─────────────────────────────────────────────────────────────────────

async def _serve(deck_path: Path, out_dir: Path, http_port: int, ws_port: int) -> None:
    print(f"[inkflow] loading {deck_path}")
    await rebuild(deck_path, out_dir)

    http_handler = await make_http_handler(ws_port)
    http_server = await asyncio.start_server(http_handler, "127.0.0.1", http_port)

    print(f"[inkflow] http://localhost:{http_port}")
    print(f"[inkflow] ws://localhost:{ws_port}")
    print(f"[inkflow] watching {deck_path.parent}  (Ctrl-C to stop)")

    async with http_server, ws_serve(ws_handler, "127.0.0.1", ws_port):
        async with asyncio.TaskGroup() as tg:
            tg.create_task(http_server.serve_forever())
            tg.create_task(_watch(deck_path, out_dir))


# ── CLI entry point ───────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        prog="inkflow",
        description="Terminal-native SVG presentation tool",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    serve_p = sub.add_parser("serve", help="Start the presentation server")
    serve_p.add_argument(
        "deck",
        nargs="?",
        default="deck.py",
        help="Path to deck.py (default: ./deck.py)",
    )
    serve_p.add_argument("--port", type=int, default=7777, help="HTTP port")
    serve_p.add_argument("--ws-port", type=int, default=7778, help="WebSocket port")

    clean_p = sub.add_parser(
        "clean",
        help="Strip Inkscape editor metadata from SVG files",
    )
    clean_p.add_argument("files", nargs="+", metavar="file.svg")
    clean_p.add_argument(
        "--stdout",
        action="store_true",
        help="Write to stdout instead of modifying files in place",
    )

    sub.add_parser(
        "setup-git",
        help="Configure git hooks and SVG diff driver for this repository (run once after cloning)",
    )

    args = parser.parse_args()

    if args.command == "serve":
        deck_path = Path(args.deck).resolve()
        if not deck_path.exists():
            sys.exit(f"[inkflow] deck not found: {deck_path}")
        out_dir = deck_path.parent / ".inkflow_cache"
        try:
            asyncio.run(_serve(deck_path, out_dir, args.port, args.ws_port))
        except KeyboardInterrupt:
            print("\n[inkflow] stopped")

    elif args.command == "clean":
        from inkflow.pipeline import clean_inkscape_svg
        errors = False
        for file_arg in args.files:
            p = Path(file_arg)
            if not p.exists():
                print(f"[inkflow] clean: not found: {p}", file=sys.stderr)
                errors = True
                continue
            try:
                cleaned = clean_inkscape_svg(p)
                if args.stdout:
                    sys.stdout.write(cleaned)
                else:
                    p.write_text(cleaned, encoding="utf-8")
                    print(f"[inkflow] cleaned {p}")
            except Exception as exc:
                print(f"[inkflow] clean: error processing {p}: {exc}", file=sys.stderr)
                errors = True
        if errors:
            sys.exit(1)

    elif args.command == "setup-git":
        import subprocess
        steps = [
            (["git", "config", "core.hooksPath", ".githooks"],
             "pre-commit hook → .githooks/pre-commit"),
            (["git", "config", "diff.inkscape-svg.textconv", "uv run inkflow clean --stdout"],
             "SVG diff driver → strips Inkscape metadata before diffs"),
        ]
        for cmd, label in steps:
            try:
                subprocess.run(cmd, check=True, capture_output=True)
                print(f"[inkflow] {label}")
            except subprocess.CalledProcessError as exc:
                sys.exit(f"[inkflow] setup-git failed: {exc.stderr.decode().strip()}")
        # Ensure hook is executable
        hook = Path(".githooks/pre-commit")
        if hook.exists():
            hook.chmod(hook.stat().st_mode | 0o111)
        print("[inkflow] done — git is configured for this repository")
