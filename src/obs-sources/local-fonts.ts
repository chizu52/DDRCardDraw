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

// title-font.* / body-font.* are user-supplied and gitignored (see
// .gitignore) -- unlike bg.png, a purchased/licensed font file can't be
// committed to this public repo (its license permits bundling into an
// app, but not redistributing the raw resource "as is"). require.context
// tolerates zero matching files (an empty .keys() array, no build
// error) -- unlike a plain `import` of one specific path, which would
// fail the whole build on any machine/clone that doesn't have these
// files locally. So the app still builds and runs fine with neither
// file present, just falling back to the system font stack (see
// schedule.tsx's TITLE_FONT_FAMILY/BODY_FONT_FAMILY). Lives in its own
// other-assets/fonts/ folder, not nested under schedule/'s -- shared
// pool for any overlay that wants a custom font, not schedule-specific.
const localFontFiles = require.context(
  "../other-assets/fonts",
  false,
  /^\.\/(title|body)-font\.(otf|ttf|woff2?)$/,
);

function findLocalFont(baseName: "title" | "body"): LocalFont | null {
  const key = localFontFiles
    .keys()
    .find((k) => k.startsWith(`./${baseName}-font.`));
  if (!key) return null;
  const extension = key.split(".").pop() ?? "";
  const format = FORMATS[extension];
  if (!format) return null;
  const mod = localFontFiles(key);
  const url =
    typeof mod === "string" ? mod : (mod as { default: string }).default;
  return { url, format };
}

export const titleFont = findLocalFont("title");
export const bodyFont = findLocalFont("body");
