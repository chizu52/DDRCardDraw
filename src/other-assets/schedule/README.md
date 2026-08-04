# Schedule overlay background image

This folder holds the background art for the Schedule OBS overlay
(`src/obs-sources/schedule.tsx`). Whatever image sits here as `bg.png`
gets used as a soft, out-of-focus backdrop behind the card — blurred,
not shown sharp, so it never competes with the schedule text on top of
it.

For custom fonts (title vs. body), see `src/other-assets/fonts/README.md`
instead — that's a shared folder for any overlay, not specific to this
one.

## How to swap it for a new event

1. **Replace `bg.png`** in this folder with your new image (same
   filename — that's what `schedule.tsx` imports). PNG or JPG both
   work.
2. **Restart/let the dev server recompile**, then check the overlay at
   its OBS source URL (`.../schedule`) with a day selected so there's
   actual content to look at over the new art.

## Sizing the image

- **Recommended: roughly 1600×540px**, similar to the current `bg.png`
  (1589×540, ~950KB). That's proportioned for how the card actually
  renders — wide and comparatively short, not a square or tall poster
  crop.
- Keep the file size reasonable (a few MB at most). It's fine either
  way for bundle size (see below), but a much larger file is slower to
  load when OBS first opens the browser source.

## How the image is actually displayed

The image sits on its own absolutely-positioned layer behind the card's
content, blurred and darkened:

```ts
background: `url(${Banner}) center/cover no-repeat`,
filter: "blur(3px) brightness(0.55)",
```

- **`cover` crops to fill the card, it doesn't letterbox** — the image
  scales to fill completely, cropping evenly from whichever edges don't
  fit. It does **not** need to match the card's aspect ratio.
- **`center` favors the middle of the image** for that crop.
- **The blur is deliberate**, not a loading artifact — it turns the art
  into a soft color wash so it never has to compete with row text for
  legibility, however busy or light the source image is.

## Why large images here are safe to commit

Webpack's `asset/resource` handling (see `webpack.config.js`) emits
imported images as their own static file rather than base64-inlining
them into the JS bundle — so a multi-MB banner here doesn't bloat the
app's actual bundle size.
