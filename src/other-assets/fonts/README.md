# Custom fonts for the OBS overlays

The broadcast OBS overlays (`schedule.tsx`, `gauntlet-pools.tsx`,
`pool-results.tsx`, `bracket-tree.tsx`) can use two custom fonts — a
title font and a body font — resolved by `src/obs-sources/local-fonts.ts`.
Neither font file lives in this repo. Whenever one is missing, that slot
falls back to a plain system font stack (`Roboto, Helvetica, Arial,
sans-serif`) automatically — nothing breaks, the overlays just look
plainer than intended.

## Why these files aren't committed

`title-font.*`/`body-font.*` are gitignored on purpose (see the root
`.gitignore`). A purchased/licensed font's terms usually permit
*bundling it into your own app*, but not *redistributing the raw file*
— and this is a public repo, so committing the actual font file would
count as that. `fallback-font.woff2` in this same folder is different:
it's Inter Regular under the SIL Open Font License, which explicitly
permits redistribution, so it's committed and used whenever a slot has
no locally-supplied font.

## Local development

Just drop your own font file directly into this folder, named:

```
src/other-assets/fonts/title-font.<ext>
src/other-assets/fonts/body-font.<ext>
```

where `<ext>` is one of `otf`, `ttf`, `woff`, or `woff2`. Either or both
can be present — `local-fonts.ts`'s own `require.context` glob picks up
whichever exist and falls back to the system stack for whichever don't.
No build config changes needed; this is picked up automatically the
next time you run `yarn start:frontend` or `yarn build`.

## Production (Vercel) deploys

Vercel builds from a fresh git clone every time, which never has these
locally-dropped files — without something to supply them, a production
deploy always falls back to the system font stack, even if every
developer's own machine has the real fonts sitting right there.

`scripts/write-local-fonts.mjs` solves this: it's wired up as this
project's own `prebuild` npm script (see `package.json`), so it runs
automatically before every `build`, decoding base64-encoded fonts from
environment variables and writing them into this folder before webpack
ever looks for them.

To set this up in Vercel's own dashboard (Project Settings →
Environment Variables), for each font you want live on the deployed
site:

1. Base64-encode the font file, e.g. from a terminal:
   ```bash
   base64 -w0 title-font.otf   # macOS: base64 title-font.otf | tr -d '\n'
   ```
2. Add an env var with that entire output as its value:
   - `TITLE_FONT_BASE64` for the title font, `BODY_FONT_BASE64` for the
     body font.
3. Add a second env var naming the file's real extension (`otf`, `ttf`,
   `woff`, or `woff2`):
   - `TITLE_FONT_EXT`, `BODY_FONT_EXT`.

Either font can be configured independently of the other. If a given
font's pair of env vars isn't set, `write-local-fonts.mjs` just logs
that it's skipping it and leaves that slot to fall back to the system
stack -- same as an ordinary clone with no fonts supplied locally. It
never fails the build over a missing/misconfigured font.
