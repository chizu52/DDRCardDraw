# Custom fonts (optional, local-only)

Shared font slots for OBS overlays. Currently used by the Schedule
overlay (`src/obs-sources/schedule.tsx`); any other overlay wanting a
custom font can read from `src/obs-sources/local-fonts.ts` the same way.

Two independent, **optional** slots:

- **`title-font.{otf,ttf,woff,woff2}`** — used only for a big overlay
  title.
- **`body-font.{otf,ttf,woff,woff2}`** — used for everything else
  (clock, labels, row text, etc.).

Drop a file in under either name and it's picked up automatically —
nothing else needs to change. Leave one or both absent and whatever
uses them just falls back to a plain system font stack
(Roboto/Helvetica/Arial) for that slot; there's no error, nothing looks
broken, it's a legitimate supported state, not a fallback-for-a-bug.

## Why these aren't committed to git

Font files are usually licensed in a way that permits bundling them
into an app but **not** redistributing the raw file itself — and this
repo is public. So `title-font.*` / `body-font.*` are git-ignored (see
`.gitignore`) rather than committed. That means:

- These fonts are **local to your own machine only**. Anyone else
  cloning this repo won't have them, and overlays will render with the
  system fallback for them until they supply their own files.
- Check the license of whatever font you use before dropping it here —
  this convention assumes "bundle into an app" is allowed, which is
  common but not universal.

## Why a missing font file doesn't break the build

`src/obs-sources/local-fonts.ts` uses webpack's `require.context` to
look for `title-font.*` / `body-font.*` in this folder at build time.
Unlike a normal `import` of one specific filename (which fails the
whole build if that exact file doesn't exist), `require.context`
tolerates finding nothing — so the app builds and runs fine whether
these files are present or not.

## Picking a title vs. body split

A bold, hand-drawn, or heavily stylized display font usually reads fine
at a title's large size but hurts legibility at the smaller sizes body
text uses (especially once a stream's video compression is added on
top). If you only have one font you want to use, put it in
`title-font.*` and leave `body-font.*` unset — that keeps the stylized
look on the title while everything else stays in a font built for
reading at a glance.

## This dev machine's own title-font

Currently set up with **Bushcraft** by Rachid Aitouaissi, distributed
via [PixelBuddha](https://pixelbuddha.net) (2014) — royalty-free for
personal/commercial use, bundling into an app is explicitly allowed,
just not redistributing the raw file itself (see "Why these aren't
committed to git" above). Not required by the license, but credited
here since PixelBuddha's own terms say they appreciate it.
