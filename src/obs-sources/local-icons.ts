export interface LocalIcon {
  /** Filename without extension, e.g. "DDR" -- used both as the dropdown
   * option's value-matching key and, verbatim, its label (see
   * iconLabel below). */
  name: string;
  url: string;
}

// Bundled repo assets (unlike the fonts in local-fonts.ts, these aren't
// gitignored -- check the license of whatever image you use before
// dropping it here). require.context still tolerates the folder being
// empty (no build error), so the dropdown just has nothing but "None"
// in it until someone drops files in, same as any other optional-
// content pattern in this app.
const iconFiles = require.context(
  "../other-assets/Icons",
  false,
  /\.(png|jpe?g|gif|webp|svg)$/i,
);

export const localIcons: LocalIcon[] = iconFiles
  .keys()
  .map((key) => {
    const fileName = key.replace(/^\.\//, "");
    const name = fileName.replace(/\.[^.]+$/, "");
    const mod = iconFiles(key);
    const url =
      typeof mod === "string" ? mod : (mod as { default: string }).default;
    return { name, url };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

// The filename's own name, exactly as-is -- no capitalizing/prettifying,
// so the dropdown label matches the actual file (e.g. "ddr", not "Ddr")
// rather than a guess at how it should be displayed.
export function iconLabel(icon: LocalIcon): string {
  return icon.name;
}
