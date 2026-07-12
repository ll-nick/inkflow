"""Feature-test deck: Video playback control, for manual verification.

Serve it with ``uv run inkflow serve -d tests/decks/video.py`` and step through with
the arrow keys. Each slide's caption says which playback behavior it exercises;
watch (and listen) that the clip behaves as described.

The media assets are symlinked from the demo deck
to keep this deck self-contained and small.
"""

from inkflow import (
    Deck,
    Direction,
    MediaAlign,
    MediaFit,
    Muted,
    Slide,
    Video,
    animations,
    transitions,
)

SLOW = 3.0  # long transition so the video's behaviour mid-transition is visible


def _slide(caption: str, video: Video, **kwargs: object) -> Slide:
    return Slide(
        "slides/media.svg",
        zones={"caption": f"## {caption}", "media": video},
        **kwargs,  # pyright: ignore[reportArgumentType]
    )


def main() -> Deck:
    return Deck(
        slides=[
            # AUTO mute + autoplay -> plays muted on load, loops forever.
            _slide(
                "autoplay + loop (AUTO mute -> silent)",
                Video("assets/logo.mp4", autoplay=True, loop=True),
            ),
            # Slow Push INTO another autoplaying clip: watch the outgoing clip
            # (reconstructed in the transition layer) stay frozen/silent while the
            # incoming clip starts playing as it slides in.
            _slide(
                "autoplay + loop, entered via slow Push",
                Video("assets/logo.mp4", autoplay=True, loop=True),
                transition=transitions.Push(direction=Direction.LEFT, duration=SLOW),
            ),
            # Shared placement fields (same as Image): fit=contain (default) here
            # letterboxes the clip inside the zone.
            _slide(
                "fit=contain (default) — letterboxed",
                Video("assets/logo.mp4", autoplay=True, loop=True),
            ),
            # fit=cover fills the zone and crops; align picks which edge is kept.
            _slide(
                "fit=cover + align=top (fills, crops to top)",
                Video(
                    "assets/logo.mp4",
                    autoplay=True,
                    loop=True,
                    fit=MediaFit.COVER,
                    align=MediaAlign.TOP,
                ),
            ),
            # x/y nudge the cover crop window (px offset from the aligned position).
            _slide(
                "fit=cover + x=200, y=-120 offset",
                Video(
                    "assets/logo.mp4",
                    autoplay=True,
                    loop=True,
                    fit=MediaFit.COVER,
                    x=200,
                    y=-120,
                ),
            ),
            # play_on_step: idle on arrival, plays (with sound, AUTO) at step 1,
            # resets to the start when you step back to 0.
            _slide(
                "play_on_step=1 (audible)",
                Video("assets/logo.mp4", play_on_step=1),
            ),
            # Video plays at step 1, then the slide keeps going: steps 2 and 3
            # reveal more content while the clip keeps looping.
            Slide(
                "slides/media-steps.svg",
                zones={
                    "caption": "## play_on_step=1, then more steps",
                    "media": Video("assets/logo.mp4", play_on_step=1, loop=True),
                },
                animations=[
                    animations.FadeIn("#step-note-2", step=2),
                    animations.FadeIn("#step-note-3", step=3),
                ],
            ),
            # Poster: the still shows on arrival; the clip plays only on press
            # (controls, no autoplay), replacing the poster.
            _slide(
                "poster (still until you press play)",
                Video("assets/logo.mp4", poster="assets/poster.webp"),
            ),
            # Temporal trim + loop: playback stays within [0.5s, 1.5s).
            _slide(
                "trim start=0.5 end=1.5 + loop",
                Video("assets/logo.mp4", autoplay=True, loop=True, start=0.5, end=1.5),
            ),
            # Explicit unmuted autoplay: the browser may block it on a cold load.
            _slide(
                "autoplay + muted=OFF (may be blocked)",
                Video("assets/logo.mp4", autoplay=True, loop=True, muted=Muted.OFF),
            ),
            # Controls only: nothing plays until you press play.
            _slide(
                "controls only (manual)",
                Video("assets/logo.mp4"),
            ),
        ]
    )
