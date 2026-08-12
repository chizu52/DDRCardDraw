### This whole folder is a shared, global asset pool -- every overlay reads from it, not just one tab/setting. YMMV when changing any assets, fonts, or images.

## Fonts
- You must supply your own font files. Folder must be named "fonts" for the styling to import properly.
  - "title-font.otf" for all title text
  - "body-font.otf" for all body text
- Used by every overlay (Schedule, Gauntlet Pools, etc.) -- one shared title/body font pair, not per-overlay.

## Icons
- For custom icons, I strongly suggest just using the custom choice from the "Icons" dropdown list
- If you want to import it to the assets folder: 
  - File names are imported exactly as named, capitalization matters.
- The same bundled list shows up in every overlay's own Icon dropdown in Settings (Schedule, Gauntlet Pools, etc.) -- drop a file in here once and every overlay can pick it.

## Backgrounds
- Must be named "bg.png" for the OBS sources to pick it up.
- Currently shared as-is by every overlay that uses a background banner (Schedule, Gauntlet Pools) -- there's one image, not a per-overlay picker yet.
