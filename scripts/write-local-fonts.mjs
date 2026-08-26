#!/usr/bin/env node
/**
 * Writes title-font.* and body-font.* into src/other-assets/fonts/ from
 * base64-encoded environment variables, before the real build runs --
 * see src/other-assets/fonts/README.md for the full rationale. Short
 * version: font licenses generally permit bundling a purchased/
 * licensed font into an app, but not redistributing the raw file --
 * committing it to this public repo would count as that, so
 * title-font.* and body-font.* are gitignored and only ever exist as
 * files a developer drops in locally by hand. That's fine for local
 * dev, but Vercel's own build environment is a fresh git clone every
 * time, with none of a local dev's own locally-supplied files sitting
 * around -- without this script, a production deploy would silently
 * fall back to the system font stack forever (confirmed live: exactly
 * what happened before this existed), even though the fonts were
 * "right there" on every dev's own machine.
 *
 * Wired up as an npm "prebuild" script (see package.json) -- npm/yarn
 * both run that automatically before "build", so this needs no
 * changes to vercel.json or webpack.config.js to take effect on a
 * real deploy.
 *
 * No-ops silently (not a build failure) whenever a given font's env
 * vars aren't set -- same "fall back to the system font stack, don't
 * break anything" contract local-fonts.ts's own findLocalFont already
 * has for a totally font-less clone. This script doesn't change that
 * contract, it just gives Vercel's build one more way to satisfy it
 * before local-fonts.ts's own require.context glob ever runs.
 *
 * Each font needs TWO env vars, not just the encoded bytes: its real
 * file extension (otf/ttf/woff/woff2) has to land on disk correctly,
 * since local-fonts.ts's own require.context glob matches by
 * extension, and each extension needs a different @font-face
 * format() name (see local-fonts.ts's own FORMATS map).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = join(__dirname, "..", "src", "other-assets", "fonts");

// Matches local-fonts.ts's own FORMATS map exactly -- kept as a
// separate literal here (not imported) since that file is TypeScript
// and this script runs as plain Node before any build step exists to
// compile it.
const VALID_EXTENSIONS = new Set(["otf", "ttf", "woff", "woff2"]);

function writeFontFromEnv(baseName, base64EnvVar, extEnvVar) {
  const base64 = process.env[base64EnvVar];
  const ext = process.env[extEnvVar];
  if (!base64 || !ext) {
    console.log(
      `[write-local-fonts] ${base64EnvVar}/${extEnvVar} not set -- skipping ` +
        `${baseName}-font (falls back to the system font stack, same as a ` +
        `local clone with no font files supplied).`,
    );
    return;
  }
  if (!VALID_EXTENSIONS.has(ext)) {
    console.warn(
      `[write-local-fonts] ${extEnvVar}="${ext}" isn't one of ` +
        `otf/ttf/woff/woff2 -- skipping ${baseName}-font.`,
    );
    return;
  }
  mkdirSync(FONTS_DIR, { recursive: true });
  const outPath = join(FONTS_DIR, `${baseName}-font.${ext}`);
  const bytes = Buffer.from(base64, "base64");
  writeFileSync(outPath, bytes);
  console.log(`[write-local-fonts] Wrote ${outPath} (${bytes.length} bytes).`);
}

writeFontFromEnv("title", "TITLE_FONT_BASE64", "TITLE_FONT_EXT");
writeFontFromEnv("body", "BODY_FONT_BASE64", "BODY_FONT_EXT");
