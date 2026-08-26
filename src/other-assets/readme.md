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
- No longer used -- every overlay used to render bg.png as a blurred backdrop behind its card, dropped in favor of a plain solid panel background (same look pool-results.tsx always had). bg.png itself is still in this folder/committed to the repo, just unreferenced by any overlay now.
