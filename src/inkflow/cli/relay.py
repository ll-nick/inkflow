"""``inkflow relay``: the relay that sharing online goes through.

Without a subcommand it runs the relay here (``online/relay.py``), for a
server of your own behind HTTPS. ``deploy cloudflare`` puts the same relay
on your Cloudflare account; ``set`` tells inkflow which relay to share
through (the editor's Share… dialog can set it too).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import urllib.request
from http.client import HTTPResponse
from pathlib import Path
from typing import cast

import click

from inkflow.cli._common import main
from inkflow.logging import report
from inkflow.online import config as relay_config
from inkflow.online.deploy import DEFAULT_NAME, DeployError, deploy_cloudflare
from inkflow.online.host import normalize_relay
from inkflow.online.relay import HEALTH_PATH, MAX_GUESTS, Relay


def check_relay(url: str, timeout: float = 10) -> str | None:
    """Why ``url`` is not an inkflow relay that answers (None: it is)."""
    try:
        response = cast(
            "HTTPResponse", urllib.request.urlopen(url + HEALTH_PATH, timeout=timeout)
        )
        with response:
            body = cast(object, json.loads(response.read()))
    except (OSError, ValueError) as exc:
        return f"no answer from {url}: {exc}"
    if (
        not isinstance(body, dict)
        or cast("dict[str, object]", body).get("ok") is not True
    ):
        return f"{url} does not answer as an inkflow relay"
    return None


@main.group(invoke_without_command=True)
@click.option("--host", default="127.0.0.1", show_default=True, help="Listen here.")
@click.option("--port", default=8787, show_default=True, type=int, help="Listen here.")
@click.option(
    "--access-token",
    envvar="INKFLOW_RELAY_ACCESS_TOKEN",
    default=None,
    metavar="TOKEN",
    help="Hosts must present this to open rooms (env INKFLOW_RELAY_ACCESS_TOKEN). "
    + "Without it, any inkflow may share through this relay.",
)
@click.option(
    "--max-guests",
    default=MAX_GUESTS,
    show_default=True,
    type=int,
    help="Guests per room.",
)
@click.option(
    "--dump",
    type=click.Path(dir_okay=False, path_type=Path),
    default=None,
    hidden=True,
    help="Append every frame forwarded to this file (to check what a relay sees).",
)
@click.pass_context
def relay(
    ctx: click.Context,
    host: str,
    port: int,
    access_token: str | None,
    max_guests: int,
    dump: Path | None,
) -> None:
    """Run the relay for sharing online, or set one up.

    Sharing online (`inkflow edit --share-online`, or Share… → Online)
    connects your inkflow out to a relay, and guests' browsers to the same
    room there; the relay forwards encrypted frames between them and never
    sees the deck. Without a subcommand this runs the relay on this machine:
    put it behind HTTPS (Caddy, nginx) and point inkflow at its address with
    `inkflow relay set https://relay.example.org --token TOKEN`.

    \b
    Subcommands:
      deploy cloudflare   the relay on your free Cloudflare account
      set URL             share through this relay
      show                the relay set, and whether it answers
    """
    if ctx.invoked_subcommand is not None:
        return
    dump_file = dump.open("ab") if dump is not None else None
    server = Relay(access_token=access_token, max_guests=max_guests, dump=dump_file)

    async def run() -> None:
        listening = await server.serve(host, port)
        report("Relay", f"http://{host}:{port} (put HTTPS in front of it)")
        if access_token is None:
            report(
                "Open",
                "no --access-token: any inkflow can open rooms here",
                style="yellow",
            )
        await listening.serve_forever()

    try:
        with contextlib.suppress(KeyboardInterrupt):
            asyncio.run(run())
    finally:
        if dump_file is not None:
            dump_file.close()


@relay.command("set")
@click.argument("url", required=False)
@click.option("--token", default=None, help="The relay's access token, if it has one.")
@click.option("--forget", is_flag=True, help="Set no relay (sharing online is off).")
def set_cmd(url: str | None, token: str | None, forget: bool) -> None:
    """Share online through the relay at URL (and its access token)."""
    if forget or not url:
        if not forget:
            raise click.UsageError("give the relay's address, or --forget")
        relay_config.forget()
        report("Forgot", "the relay")
        return
    try:
        address = normalize_relay(url)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    problem = check_relay(address)
    saved = relay_config.save(address, token)
    report("Set", f"relay {saved.url}" + (" (with its access token)" if token else ""))
    if problem:
        report("Warning", problem, style="yellow")


@relay.command("show")
@click.option(
    "--token",
    "show_token",
    is_flag=True,
    help="Print the access token itself, and the `inkflow relay set` command "
    + "that lets someone else share through this relay.",
)
def show_cmd(show_token: bool) -> None:
    """The relay sharing online goes through, and whether it answers."""
    configured = relay_config.load()
    if configured is None:
        click.echo(
            "No relay set: `inkflow relay deploy cloudflare` "
            + "or `inkflow relay set URL`."
        )
        return
    click.echo(f"relay: {configured.url}")
    if show_token and configured.token:
        click.echo(f"token: {configured.token}")
        click.echo(
            "for someone else: inkflow relay set "
            + f"{configured.url} --token {configured.token}"
        )
    else:
        click.echo(
            f"token: {'set (--token prints it)' if configured.token else 'none'}"
        )
    if os.environ.get("INKFLOW_RELAY_URL"):
        click.echo("(from INKFLOW_RELAY_URL)")
    problem = check_relay(configured.url)
    click.echo(f"health: {problem or 'answers'}")


@relay.group("deploy")
def deploy_group() -> None:
    """Put the relay on a hosting platform."""


@deploy_group.command("cloudflare")
@click.option(
    "--name",
    default=DEFAULT_NAME,
    show_default=True,
    help="The Worker's name: its address is https://NAME.<your subdomain>.workers.dev.",
)
@click.option(
    "--no-token",
    is_flag=True,
    help="Deploy without an access token: any inkflow could then open rooms on it.",
)
def deploy_cloudflare_cmd(name: str, no_token: bool) -> None:
    """Deploy the relay to your Cloudflare account (free plan) and use it.

    Needs Node.js (for `npx wrangler`) and a Cloudflare account you have
    signed in to once with `npx wrangler login`. Deploys a Worker with one
    Durable Object per room and the guest page, sets a new access token
    (kept here, so only your inkflow opens rooms on it) and makes it the
    relay inkflow shares through. Run it again to update the relay.
    """
    configured = relay_config.load()
    token = configured.token if configured else None
    report(
        "Deploying", f"Worker {name} with npx wrangler (Cloudflare may ask questions)"
    )
    try:
        deployed = deploy_cloudflare(name, token=token, open_relay=no_token)
    except DeployError as exc:
        raise click.ClickException(str(exc)) from exc
    if deployed.url is None:
        if deployed.token:
            click.echo(f"token: {deployed.token}")
        raise click.ClickException(
            "deployed, but wrangler did not say at which address: find it on "
            + "dash.cloudflare.com (Workers & Pages), then run "
            + "`inkflow relay set <address> --token <the token above>`"
        )
    saved = relay_config.save(deployed.url, deployed.token)
    report("Deployed", saved.url)
    click.echo(f"relay: {saved.url}")
    problem = check_relay(saved.url, timeout=20)
    if problem:
        report(
            "Note",
            f"{problem} (a new workers.dev address can take a minute to work)",
            style="yellow",
        )
    report(
        "Next",
        "inkflow edit, then Share… → Online → Share online "
        + "(or inkflow edit --share-online)",
    )
