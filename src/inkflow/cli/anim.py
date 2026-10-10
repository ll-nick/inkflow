"""``inkflow anim``: a slide's click timeline, and changes to its animations.

``list`` prints every step of a slide in the order the build resolves it: the
Markdown reveals (``::step::``/``::steps::``, code highlight stages) first,
then deck.py's ``animations=[...]``, numbered on from them
(``pipeline.resolve_steps``). ``add``/``set``/``move``/``remove`` change
``animations=[...]`` through the session's own ``anim`` action, the one the
editor's Animation panel sends: with the editor open each is one undoable
"Agent: …" step there; otherwise deck.py is changed directly. Types are the
real animation classes (the deck's own included) and targets the slide's ids.
"""

from __future__ import annotations

import dataclasses
import difflib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import click

from inkflow import animations as animations_module
from inkflow.animations import Animation, Cue, PlayVideo
from inkflow.cli._common import deck_option, main
from inkflow.cli._edits import DeckSlides as SlideRefs
from inkflow.cli._edits import apply_edit as apply_step
from inkflow.editor.codegen import to_json
from inkflow.editor.session import DECK_MODULE
from inkflow.enums import Trigger
from inkflow.pipeline import process_deck, resolve_steps
from inkflow.svgio import SvgElement, parse_svg

_STEP_ID = "inkflow-step-"
_BASES = {"Cue", "Animation", "Enter", "Exit", "Emphasis"}
_TIMING = ("element", "trigger", "duration", "delay", "easing", "iterations")


@dataclass(frozen=True)
class Step:
    """One entry of a slide's timeline."""

    click: int
    """The step it plays on (0: before the first click)."""
    what: str
    """The animation type (``FadeIn``) or ``code highlight``."""
    target: str
    trigger: str
    """click | with | after | at:N (inferred from the steps for reveals)."""
    source: str
    """``md`` (a Markdown reveal) or ``deck.py``."""
    index: int | None = None
    """1-based position in ``animations=[...]`` (deck.py entries only)."""
    duration: float | None = None
    delay: float = 0.0
    extra: str = ""
    """Its other fields that differ from their defaults (``direction=up``)."""
    text: str = ""

    def line(self) -> str:
        num = str(self.index) if self.index is not None else "-"
        what = f"{self.what} {self.extra}".strip()
        timing = f"{self.duration:g}s" if self.duration is not None else ""
        if self.delay:
            timing += f" +{self.delay:g}s"
        target = self.target + (f' "{self.text}"' if self.text else "")
        return (
            f"  {self.click:>5}  {num:>3}  {what:<24} {target:<40} "
            + f"{self.trigger:<7} {timing}"
        ).rstrip()


# ── reading the timeline ──────────────────────────────────────────────────────


def _trigger_word(trigger: str) -> str:
    return {
        "on-click": "click",
        "with-previous": "with",
        "after-previous": "after",
    }.get(trigger, f"at:{trigger}")


def _flat(text: str, limit: int = 30) -> str:
    flat = re.sub(r"\s+", " ", text).strip()
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def _zone_of(el: SvgElement) -> str:
    for parent in el.iterancestors():
        ident = parent.get("id") or ""
        if ident.startswith("zone-"):
            return ident
    return "?"


def _type_name(slug: str) -> str:
    return "".join(part.capitalize() for part in slug.split("-"))


def _reveals(root: SvgElement) -> list[Step]:
    """The Markdown reveals and code highlight stages, from the built slide."""
    found: list[tuple[int, int, Step]] = []
    order = 0
    for el in root.iter():
        ident = el.get("id") or ""
        cues = el.get("data-cues")
        if ident.startswith(_STEP_ID) and cues:
            for entry in cast("list[dict[str, object]]", json.loads(cues)):
                step = entry.get("step")
                if not isinstance(step, int):
                    continue
                opts = cast("dict[str, object]", entry.get("opts") or {})
                duration, delay = opts.get("duration"), opts.get("delay")
                text = " ".join(cast("list[str]", list(el.itertext())))
                found.append(
                    (
                        step,
                        order,
                        Step(
                            click=step,
                            what=_type_name(str(entry.get("name") or "")),
                            target=_zone_of(el),
                            trigger="",
                            source="md",
                            duration=float(duration)
                            if isinstance(duration, int | float)
                            else None,
                            delay=float(delay)
                            if isinstance(delay, int | float)
                            else 0.0,
                            text=_flat(text),
                        ),
                    )
                )
                order += 1
        spec, base = el.get("data-hl-spec"), el.get("data-base-step")
        if spec and base and base.isdigit():
            stages = cast("list[object]", json.loads(spec))
            for k in range(1, len(stages)):
                step = int(base) + k
                found.append(
                    (
                        step,
                        order,
                        Step(
                            click=step,
                            what="code highlight",
                            target=_zone_of(el),
                            trigger="",
                            source="md",
                            text=f"stage {k + 1} of {len(stages)}",
                        ),
                    )
                )
                order += 1
    found.sort(key=lambda t: (t[0], t[1]))
    steps: list[Step] = []
    last = 0
    for _, _, s in found:
        steps.append(
            dataclasses.replace(s, trigger="click" if s.click > last else "with")
        )
        last = max(last, s.click)
    return steps


def _extra(cue: Cue) -> str:
    parts: list[str] = []
    for f in dataclasses.fields(cue):
        if not f.init or f.name in _TIMING:
            continue
        value = cast("object", getattr(cue, f.name))
        default: object = (
            cast("object", f.default)
            if f.default is not dataclasses.MISSING
            else cast("object", f.default_factory())
            if f.default_factory is not dataclasses.MISSING
            else dataclasses.MISSING
        )
        if value != default:
            parts.append(f"{f.name}={to_json(value)}")
    return " ".join(parts)


def _deck_steps(cues: list[Cue], base: int) -> list[Step]:
    out: list[Step] = []
    for i, (cue, step) in enumerate(resolve_steps(cues, base), start=1):
        timed = isinstance(cue, Animation)
        out.append(
            Step(
                click=step,
                what=type(cue).__name__,
                target=cue.element if isinstance(cue, PlayVideo) else f"#{cue.element}",
                trigger=_trigger_word(str(cue.trigger)),
                source="deck.py",
                index=i,
                duration=cue.duration if timed else None,
                delay=cue.delay if timed else 0.0,
                extra=_extra(cue),
            )
        )
    return out


@dataclass(frozen=True)
class Timeline:
    slides: SlideRefs
    index: int
    steps: list[Step]
    ids: set[str]
    """Every id on the built slide (what an animation may target)."""

    @property
    def clicks(self) -> int:
        return max((s.click for s in self.steps), default=0)

    def text(self) -> str:
        n = self.clicks
        head = f"{self.slides.name(self.index)}: {n} click{'s' if n != 1 else ''}"
        if not self.steps:
            return head + ", nothing animated"
        lines = [
            head,
            f"  {'click':>5}  {'#':>3}  {'animation':<24} {'target':<40} "
            + f"{'trigger':<7} timing",
        ]
        lines += [s.line() for s in self.steps]
        if any(s.source == "md" for s in self.steps):
            lines.append(
                "  (- = a Markdown reveal: change it in the .md;"
                + " # = an animations=[...] entry)"
            )
        return "\n".join(lines)


def timeline(slides: SlideRefs, index: int) -> Timeline:
    """The slide's timeline as the build resolves it (a hidden slide is built
    as if shown)."""
    deck = slides.deck
    slide = deck.slides[index]
    one = dataclasses.replace(deck, slides=[dataclasses.replace(slide, visible=True)])
    try:
        built = process_deck(one, slides.path.parent, slides.path)
    except Exception as exc:
        raise click.ClickException(f"cannot build the slide: {exc}") from exc
    root = parse_svg(built[0]["svg"])
    reveals = _reveals(root)
    base = max((s.click for s in reveals), default=0)
    steps = sorted(
        [*reveals, *_deck_steps(slide.animations, base)],
        key=lambda s: (s.click, s.source != "md"),
    )
    ids = {i for el in root.iter() if (i := el.get("id"))}
    return Timeline(slides, index, steps, ids)


# ── parsing options ───────────────────────────────────────────────────────────


def _types() -> dict[str, type]:
    """Every animation type a deck can use: inkflow's and the deck's own."""
    found: dict[str, type] = {}
    stack: list[type] = [Cue]
    modules = {animations_module.__name__, DECK_MODULE}
    while stack:
        cls = stack.pop()
        stack.extend(cls.__subclasses__())
        if (
            cls.__module__ in modules
            and cls.__name__ not in _BASES
            and not cls.__name__.startswith("_")
            and dataclasses.is_dataclass(cls)
        ):
            found[cls.__name__] = cls
    return found


def _resolve_type(name: str) -> type:
    types = _types()
    slugs = {
        (c.slug() if issubclass(c, Animation) else "play-video"): n
        for n, c in types.items()
    }
    key = slugs.get(name.lower(), name)
    if key in types:
        return types[key]
    near = difflib.get_close_matches(name, list(types), n=3)
    hint = f"; did you mean {', '.join(near)}?" if near else ""
    raise click.BadParameter(
        f"no animation type {name!r}{hint} (types: {', '.join(sorted(types))})",
        param_hint="TYPE",
    )


def _check_target(cls: type, target: str, tl: Timeline) -> str:
    target = target.removeprefix("#")
    wanted = f"zone-{target}" if issubclass(cls, PlayVideo) else target
    if wanted in tl.ids:
        return target
    candidates = sorted(
        i
        for i in tl.ids
        if not i.startswith(("inkflow-", "zone-slide-"))
        and (not issubclass(cls, PlayVideo) or i.startswith("zone-"))
    )
    near = difflib.get_close_matches(wanted, candidates, n=4)
    what = "no zone" if issubclass(cls, PlayVideo) else "no element"
    hint = f"; did you mean {', '.join(near)}?" if near else ""
    raise click.BadParameter(
        f"{what} {wanted!r} on {tl.slides.name(tl.index)}{hint}"
        + " (`inkflow outline -s N` lists the ids)",
        param_hint="TARGET",
    )


def _trigger(text: str) -> str:
    word = text.strip().lower()
    presets = {
        "click": Trigger.ON_CLICK,
        "on-click": Trigger.ON_CLICK,
        "with": Trigger.WITH_PREVIOUS,
        "with-previous": Trigger.WITH_PREVIOUS,
        "after": Trigger.AFTER_PREVIOUS,
        "after-previous": Trigger.AFTER_PREVIOUS,
    }
    if word in presets:
        return str(presets[word])
    pinned = word.removeprefix("at:").removeprefix("at")
    if pinned.isdigit():
        return pinned
    raise click.BadParameter(
        f"{text!r}: use click, with, after or at:N", param_hint="--trigger"
    )


def _seconds(text: str, option: str) -> float:
    """``400`` / ``400ms`` (milliseconds) or ``0.4s`` (seconds) as seconds."""
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*(ms|s)?\s*", text)
    if not m:
        raise click.BadParameter(
            f"{text!r}: milliseconds (400, 400ms) or seconds (0.4s)",
            param_hint=option,
        )
    value = float(m.group(1))
    return value if m.group(2) == "s" else value / 1000


def _fields(
    cls: type,
    trigger: str | None,
    duration: str | None,
    delay: str | None,
    easing: str | None,
    direction: str | None,
    extra: tuple[str, ...],
) -> dict[str, object]:
    """The fields the options set, checked against ``cls``'s own."""
    names = {f.name for f in dataclasses.fields(cls) if f.init and f.name != "element"}
    values: dict[str, object] = {}
    if trigger is not None:
        values["trigger"] = _trigger(trigger)
    if duration is not None:
        values["duration"] = _seconds(duration, "--duration")
    if delay is not None:
        values["delay"] = _seconds(delay, "--delay")
    if easing is not None:
        values["easing"] = easing
    if direction is not None:
        values["direction"] = direction.lower()
    for item in extra:
        name, sep, value = item.partition("=")
        if not sep:
            raise click.BadParameter(f"{item!r}: write NAME=VALUE", param_hint="--set")
        values[name.strip()] = _value(value.strip())
    unknown = sorted(set(values) - names)
    if unknown:
        raise click.UsageError(
            f"{cls.__name__} has no {', '.join(unknown)}"
            + f" (its fields: {', '.join(sorted(names))})"
        )
    return values


def _value(text: str) -> object:
    """A --set value: a number when it reads as one, else the text."""
    try:
        return cast("object", json.loads(text))
    except ValueError:
        return text


def _fields_of(cue: Cue) -> dict[str, object]:
    return {
        f.name: to_json(cast("object", getattr(cue, f.name)))
        for f in dataclasses.fields(cue)
        if f.init and f.name != "element"
    }


def _position(tl: Timeline, number: int, option: str = "INDEX") -> int:
    count = len(tl.slides.deck.slides[tl.index].animations)
    if not 1 <= number <= count:
        have = f"its animations are 1 to {count}" if count else "it has no animations"
        raise click.BadParameter(
            f"no animation {number} on {tl.slides.name(tl.index)}: {have}"
            + " (the # column of `inkflow anim list`)",
            param_hint=option,
        )
    return number - 1


# ── commands ──────────────────────────────────────────────────────────────────

_slide_option = click.option(
    "--slide",
    "-s",
    "slide_ref",
    required=True,
    metavar="SLIDE",
    help="The slide: its number (as the presenter counts) or id.",
)


def _timing_options(f: click.decorators.FC) -> click.decorators.FC:
    for option in reversed(
        [
            click.option(
                "--trigger",
                default=None,
                help="click (next click), with (with the previous), after"
                + " (once the previous ends), or at:N (pinned to step N).",
            ),
            click.option(
                "--duration", default=None, help="Milliseconds (400) or 0.4s."
            ),
            click.option("--delay", default=None, help="Milliseconds (200) or 0.2s."),
            click.option(
                "--easing",
                default=None,
                help="A CSS easing: ease, ease-in, ease-out, ease-in-out, linear,"
                + " cubic-bezier(...).",
            ),
            click.option(
                "--direction",
                default=None,
                help="SlideIn/SlideOut: left, right, up or down.",
            ),
            click.option(
                "--set",
                "extra",
                multiple=True,
                metavar="NAME=VALUE",
                help="Any other field of the type (scale=0.6, color=var(--red),"
                + " a custom animation's own); repeatable.",
            ),
        ]
    ):
        f = option(f)
    return f


def _load(deck_path: Path, slide_ref: str) -> Timeline:
    slides = SlideRefs.load(deck_path)
    return timeline(slides, slides.index(slide_ref))


def _change(tl: Timeline, request: dict[str, object], summary: str) -> None:
    """Send one ``anim`` request as an agent step, then print the timeline."""
    apply_step(tl.slides, {"action": "anim", "slide": tl.index, **request}, summary)
    after = SlideRefs.load(tl.slides.path)
    click.echo(timeline(after, tl.index).text())


@main.group()
def anim() -> None:
    """List a slide's clicks; add, change, reorder or remove its animations.

    `list` prints the slide's whole click timeline as the build resolves it:
    Markdown reveals first, then deck.py's `animations=[...]` numbered on
    from them. The other commands change `animations=[...]` exactly as the
    editor's Animation panel does: with `inkflow edit` open, each is a step
    in its undo history ("Agent: …"); otherwise deck.py is changed directly.
    After each change the new timeline is printed.

    INDEX is an animation's place in `animations=[...]` (1-based), the #
    column of `anim list`; SLIDE is a slide number or id.
    """


@anim.command("list")
@_slide_option
@deck_option
@click.option("--json", "as_json", is_flag=True, help="Print the timeline as JSON.")
def list_cmd(slide_ref: str, deck_path: Path, as_json: bool) -> None:
    """Print a slide's click timeline: click, #, animation, target, trigger, timing."""
    tl = _load(deck_path, slide_ref)
    if as_json:
        click.echo(
            json.dumps(
                {
                    "slide": tl.slides.numbers[tl.index],
                    "id": tl.slides.ids[tl.index],
                    "clicks": tl.clicks,
                    "steps": [dataclasses.asdict(s) for s in tl.steps],
                },
                ensure_ascii=False,
            )
        )
        return
    click.echo(tl.text())


@anim.command("add")
@click.argument("type_name", metavar="TYPE")
@click.argument("target", metavar="TARGET")
@_slide_option
@deck_option
@_timing_options
@click.option(
    "--at",
    "at",
    type=click.IntRange(min=1),
    default=None,
    help="Its place in animations=[...] (1 = first) [default: last].",
)
def add(
    type_name: str,
    target: str,
    slide_ref: str,
    deck_path: Path,
    trigger: str | None,
    duration: str | None,
    delay: str | None,
    easing: str | None,
    direction: str | None,
    extra: tuple[str, ...],
    at: int | None,
) -> None:
    """Animate TARGET (an element id; for PlayVideo, a video's zone) with TYPE.

    TYPE is an animation class (FadeIn, SlideIn, ScaleOut, Highlight,
    PlayVideo…, or one the deck defines), or its kebab-case name (fade-in).
    """
    tl = _load(deck_path, slide_ref)
    cls = _resolve_type(type_name)
    element = _check_target(cls, target, tl)
    fields = _fields(cls, trigger, duration, delay, easing, direction, extra)
    count = len(tl.slides.deck.slides[tl.index].animations)
    position = count if at is None else min(at - 1, count)
    _change(
        tl,
        {
            "op": "insert",
            "index": position,
            "spec": {"type": cls.__name__, "element": element, "fields": fields},
        },
        f"Add {cls.__name__} on {element} to {tl.slides.name(tl.index)}",
    )


@anim.command("set")
@click.argument("number", metavar="INDEX", type=int)
@_slide_option
@deck_option
@click.option("--type", "type_name", default=None, help="Another animation type.")
@click.option("--target", default=None, help="Another element (or video zone).")
@_timing_options
def set_cmd(
    number: int,
    slide_ref: str,
    deck_path: Path,
    type_name: str | None,
    target: str | None,
    trigger: str | None,
    duration: str | None,
    delay: str | None,
    easing: str | None,
    direction: str | None,
    extra: tuple[str, ...],
) -> None:
    """Change animation INDEX: its type, target, trigger, timing or fields.

    Fields not given keep their values (those the new --type has).
    """
    tl = _load(deck_path, slide_ref)
    position = _position(tl, number)
    cue = tl.slides.deck.slides[tl.index].animations[position]
    cls = _resolve_type(type_name) if type_name else type(cue)
    element = _check_target(cls, target, tl) if target else cue.element
    changes = _fields(cls, trigger, duration, delay, easing, direction, extra)
    if not changes and cls is type(cue) and element == cue.element:
        raise click.UsageError("nothing to change: give --type, --target, --trigger…")
    names = {f.name for f in dataclasses.fields(cls) if f.init}
    fields = {k: v for k, v in _fields_of(cue).items() if k in names} | changes
    _change(
        tl,
        {
            "op": "replace",
            "index": position,
            "spec": {"type": cls.__name__, "element": element, "fields": fields},
        },
        f"Change animation {number} on {tl.slides.name(tl.index)}",
    )


@anim.command("move")
@click.argument("number", metavar="INDEX", type=int)
@click.option("--to", "to", type=int, required=True, help="Its new place (1 = first).")
@_slide_option
@deck_option
def move(number: int, to: int, slide_ref: str, deck_path: Path) -> None:
    """Move animation INDEX to place --to in animations=[...]."""
    tl = _load(deck_path, slide_ref)
    src = _position(tl, number)
    dst = _position(tl, to, "--to")
    if src == dst:
        click.echo(tl.text())
        return
    _change(
        tl,
        {"op": "move", "index": src, "to": dst},
        f"Move animation {number} to {to} on {tl.slides.name(tl.index)}",
    )


@anim.command("remove")
@click.argument("numbers", metavar="INDEX...", type=int, nargs=-1, required=True)
@_slide_option
@deck_option
def remove(numbers: tuple[int, ...], slide_ref: str, deck_path: Path) -> None:
    """Remove animations (by INDEX) from the slide, in one step."""
    tl = _load(deck_path, slide_ref)
    positions = sorted({_position(tl, n) for n in numbers})
    listed = ", ".join(str(p + 1) for p in positions)
    plural = "s" if len(positions) > 1 else ""
    _change(
        tl,
        {"op": "remove", "index": positions[0], "indices": positions},
        f"Remove animation{plural} {listed} from {tl.slides.name(tl.index)}",
    )
