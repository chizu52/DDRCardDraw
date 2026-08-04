# Schedule overlay icon choices

Logo/icon images the operator can pick from a dropdown (dashboard.tsx's
ScheduleSettingsSection) to show on the left side of the Schedule
overlay's title. Picked via `src/obs-sources/local-icons.ts`, which uses
webpack's `require.context` to list whatever's in this folder
automatically -- drop a new image in, it shows up in the dropdown,
nothing else needs to change.

## Adding an icon

1. Drop an image file in here (PNG, JPG, GIF, WEBP, or SVG).
2. The dropdown label is the filename without its extension, capitalized
   (e.g. `ddr.webp` → "Ddr" in the list).
3. Restart/let the dev server recompile, then it's selectable from the
   Schedule Overlay settings.

## A licensing note

Several of the icons here (`ddr.webp`, `maimai.png`, `piu.png`,
`popn.webp`, `sdvx.png`) are official rhythm-game franchise logos, not
original art. Unlike `bg.png` or a custom font, these are trademarked
assets — this repo is public, so committing them here means
redistributing those logos from a public GitHub repo, not just using
them privately. Worth a deliberate call on whether that's fine (fair
use for a fan/community tool is a common assumption, but not a
guarantee) versus git-ignoring this folder the same way
`other-assets/fonts/` is git-ignored.
