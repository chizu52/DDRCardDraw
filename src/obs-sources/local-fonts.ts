import fallbackFontUrl from "../other-assets/fonts/fallback-font.woff2";

/** A font file, plus the CSS `format()` name it needs in an @font-face
 * `src` (derived from the extension, since a user could drop in any of
 * otf/ttf/woff/woff2 -- see README.md in other-assets/schedule). */
export interface LocalFont {
  url: string;
  format: string;
}

const FORMATS: Record<string, string> = {
  otf: "opentype",
  ttf: "truetype",
  woff: "woff",
  woff2: "woff2",
};

// Bundled fallback -- Inter Regular, SIL Open Font License 1.1 (full
// text: other-assets/fonts/fallback-font-LICENSE-OFL.txt). Unlike
// title-font.*/body-font.* below, this one *is* committed: its license
// permits redistribution, so there's no reason to make every clone
// supply its own. Used whenever a slot has no locally-supplied font --
// see findLocalFont.
const FALLBACK_FONT: LocalFont = { url: fallbackFontUrl, format: "woff2" };

// title-font.* / body-font.* are user-supplied and gitignored (see
// .gitignore) -- unlike bg.png, a purchased/licensed font file can't be
// committed to this public repo (its license permits bundling into an
// app, but not redistributing the raw resource "as is"). require.context
// tolerates zero matching files (an empty .keys() array, no build
// error) -- unlike a plain `import` of one specific path, which would
// fail the whole build on any machine/clone that doesn't have these
// files locally. Lives in its own other-assets/fonts/ folder, not
// nested under schedule/'s -- shared pool for any overlay that wants a
// custom font, not schedule-specific.
//
// NOTE: require.context still needs the *directory itself* to exist,
// even empty -- it only tolerates zero *matching files* inside a
// directory that's actually there. git never commits an empty
// directory, so without FALLBACK_FONT's import keeping a real tracked
// file in other-assets/fonts/, any clone/merge that never had
// title-font/body-font supplied locally would hit a hard "Can't
// resolve" build error here instead of gracefully falling back.
const localFontFiles = require.context(
  "../other-assets/fonts",
  false,
  /^\.\/(title|body)-font\.(otf|ttf|woff2?)$/,
);

function findLocalFont(baseName: "title" | "body"): LocalFont {
  const key = localFontFiles
    .keys()
    .find((k) => k.startsWith(`./${baseName}-font.`));
  if (key) {
    const extension = key.split(".").pop() ?? "";
    const format = FORMATS[extension];
    if (format) {
      const mod = localFontFiles(key);
      const url =
        typeof mod === "string" ? mod : (mod as { default: string }).default;
      return { url, format };
    }
  }
  return FALLBACK_FONT;
}

export const titleFont = findLocalFont("title");
export const bodyFont = findLocalFont("body");
