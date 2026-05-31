# Video Zones

Drop in any MP4, WebM, or OGG file — the player is placed at
the `zone-media` rectangle's position and size.

The video is embedded as a `<video>` element inside a
`<foreignObject>`, so native browser controls work as-is.

- `assets/demo.mp4` is substituted at build time
- Autoplay, loop, and muted are all valid HTML attributes
- Replace the asset path in `deck.py` to use your own video
