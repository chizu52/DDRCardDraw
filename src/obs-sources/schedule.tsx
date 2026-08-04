import { useEffect, useState } from "react";
import type { ScheduleDay, ScheduleItem } from "../state/event.slice";
import { useAppState } from "../state/store";
import { FitTo1080 } from "./fit-to-1080";
// webpack's asset/resource handling (same as src/assets/ddr-tools-256.png,
// see webpack.config.js) emits this as its own static file rather than
// inlining it into the JS bundle -- important at this file's size (~14MB,
// a high-res 6308x2143 banner), which would otherwise massively bloat
// the bundle if base64-embedded instead.
import Banner from "../other-assets/schedule/bg.png";
import { bodyFont, titleFont } from "./local-fonts";

// Dark broadcast base (panel/border/text/muted) still matches
// bracket-tree.tsx -- legibility over arbitrary video footage is the
// same requirement for both, and a stream typically targets 1080p, not
// 4K, so there's no headroom to spend on a lighter background that'd
// fight the rest of the stream for contrast. The accent trio (mint/
// gold/coral) is sampled directly from the Dairyland Duel event banner
// art, replacing the old generic blue/green -- this overlay is styled
// for that specific event's branding, not a reusable neutral palette
// like bracket-tree.tsx's.
const COLORS = {
  panel: "#1c2127",
  border: "#3a3f49",
  text: "#f6f7f9",
  // Lightened slightly from an earlier #8a919c -- description/date/
  // subtitle-label text at this weight needs a bit more contrast
  // against the dark panel to stay legible at broadcast compression.
  muted: "#9aa2ac",
  mint: "#7ed9b5",
  gold: "#efc75e",
  coral: "#f0a868",
  // A solid mint-into-panel blend for the `current` row's background --
  // NOT a translucent rgba() over the card's own busy scrimmed-banner
  // background (the previous approach), which diluted contrast and made
  // the highlighted row read worse than the plain panel rows around it.
  currentBg: "#2c433c",
};
// Two independent slots, not one shared FONT_FAMILY -- a bold hand-drawn
// display face reads fine at the title's large size but hurts legibility
// at the smaller sizes everything else on the card uses, so the title
// gets its own font, separate from the rest of the card's body text.
// Both fall back to the same plain system stack when their local font
// file is absent (titleFont/bodyFont null -- see local-fonts.ts), which
// is the common case for anyone other than this dev machine, since
// neither font file is committed to the repo.
const SYSTEM_FONT_STACK = "Roboto, Helvetica, Arial, sans-serif";
const TITLE_FONT_FAMILY = titleFont
  ? `TitleFont, ${SYSTEM_FONT_STACK}`
  : SYSTEM_FONT_STACK;
const BODY_FONT_FAMILY = bodyFont
  ? `BodyFont, ${SYSTEM_FONT_STACK}`
  : SYSTEM_FONT_STACK;

// A plain `style` prop can't express @font-face any more than it can
// @keyframes (see ANIMATIONS_CSS below) -- also rendered via a raw
// <style> tag. Each rule only gets emitted if that slot's local file
// actually exists; skipping the rule (rather than pointing `src` at a
// missing file) is what lets TITLE_FONT_FAMILY/BODY_FONT_FAMILY safely
// fall through to the system stack above instead of the browser
// retrying a 404 and rendering invisible text in the meantime.
const FONT_FACE_CSS = `
${
  titleFont
    ? `@font-face {
  font-family: "TitleFont";
  src: url(${titleFont.url}) format("${titleFont.format}");
  font-weight: 400;
  font-style: normal;
}`
    : ""
}
${
  bodyFont
    ? `@font-face {
  font-family: "BodyFont";
  src: url(${bodyFont.url}) format("${bodyFont.format}");
  font-weight: 400;
  font-style: normal;
}`
    : ""
}
`;

// Ported from the fork's original schedule overlay (which used a real
// .css file) -- a plain `style` prop can't express @keyframes at all, so
// this renders as an actual <style> tag instead, with the rules
// referenced by name from inline `animation` values below. Namespaced
// (schedule-prefixed) even though only one overlay renders on a given
// OBS source page at a time, since @keyframes registered via a raw
// <style> tag are document-global, not scoped to this component.
const ANIMATIONS_CSS = `
@keyframes scheduleFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes scheduleSlideDown {
  from { opacity: 0; transform: translateY(-16px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes scheduleSlideDownFade {
  from { opacity: 0; transform: translateY(-16px); }
  to { opacity: 0.9; transform: translateY(0); }
}
`;

const DAY_LABELS: Record<ScheduleDay, string> = {
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

// A stable reference for "no items yet" -- a fresh `[]` literal inline
// in the selector below would be a NEW array on every single selector
// call, which react-redux's default reference-equality check reads as
// "changed" on every dispatch (confirmed as a real infinite-render bug
// in dashboard.tsx's ScheduleDayEditor, which also depends on this same
// selector shape plus an effect keyed on the result -- this file has no
// such effect, so it wouldn't loop, but it's the same wasteful
// re-render pattern either way).
const EMPTY_SCHEDULE: ScheduleItem[] = [];

interface DisplayTime {
  numeral: string;
  period: string;
}

// Times are stored wall-clock, as-typed (e.g. "20:30") -- format for
// display only, no timezone conversion (see ScheduleItem's own doc).
// Returns the numeral and AM/PM period separately (rather than one
// formatted string) so the two can be styled at different sizes/weights
// in a row -- see the time pill in the row-rendering loop below.
function formatDisplayTime(time: string | undefined): DisplayTime | null {
  if (!time) return null;
  const [hStr, mStr] = time.split(":");
  const hours = Number(hStr);
  const minutes = Number(mStr);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  const period = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return {
    numeral: `${displayHour}:${String(minutes).padStart(2, "0")}`,
    period,
  };
}

// Row colors come in as plain "#rrggbb" from the dashboard's native
// <input type="color"> (see dashboard.tsx's ScheduleDayEditor), which
// can't express alpha itself -- converts to rgba() so the pill's
// background can be a soft, translucent tint of that color rather than
// the fully-saturated swatch value, which would be too loud/heavy for a
// background sitting behind text.
function hexToRgba(hex: string, alpha: number): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return hex;
  const [, r, g, b] = match;
  return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`;
}

function sortedByTime(items: ScheduleItem[]): ScheduleItem[] {
  return [...items].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
}

// A real live clock (unlike formatDisplayTime above, which formats a
// user-typed wall-clock string with no actual Date behind it at all).
// Seconds included specifically so the corner clock visibly ticks --
// without them it's still live, just doesn't read as "live" at a
// glance the way a broadcast clock graphic conventionally does. The
// timezone abbreviation at the end is whatever the machine actually
// running this browser source reports (Intl, not a hardcoded guess) --
// matters for a stream with remote viewers who can't assume the
// broadcaster's own local time.
function formatClock(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  const period = d.getHours() >= 12 ? "PM" : "AM";
  const hours = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  return `${hours}:${minutes}:${seconds} ${period} ${timezoneAbbr(d)}`;
}

function timezoneAbbr(d: Date): string {
  const part = new Intl.DateTimeFormat(undefined, {
    timeZoneName: "short",
  })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? "";
}

// The schedule day picker (fri/sat/sun) has no literal date attached to
// it in the data model -- just resolves to whichever Friday/Saturday/
// Sunday falls in the SAME Monday-anchored week as "now," which is
// right for the common case this exists for: labeling the days of a
// single Fri-Sat-Sun event weekend. Anchoring on Monday (not Sunday)
// avoids ambiguity about which week a Sunday belongs to -- Fri/Sat/Sun
// are always the tail end of a Mon-Sun week, never split across one.
const DAYS_AFTER_MONDAY: Record<ScheduleDay, number> = {
  fri: 4,
  sat: 5,
  sun: 6,
};
function formatDayDate(day: ScheduleDay, nowMs: number): string {
  if (!nowMs) return "";
  const now = new Date(nowMs);
  const daysSinceMonday = (now.getDay() + 6) % 7; // getDay(): 0=Sun..6=Sat
  const target = new Date(now);
  target.setDate(now.getDate() - daysSinceMonday + DAYS_AFTER_MONDAY[day]);
  return target.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// One stable overlay source -- which day it shows is room-synced state
// (event.selectedScheduleDay), switched live from the Settings tab's
// radio buttons, same pattern as selectedBracketPhase/selectedPool.
// See copy-obs-source.ts's routableSchedulePath.
export function Schedule() {
  const day = useAppState((s) => s.event.selectedScheduleDay);
  const items = useAppState((s) =>
    day ? (s.event.schedules[day] ?? EMPTY_SCHEDULE) : EMPTY_SCHEDULE,
  );
  const subtitle = useAppState((s) => s.event.scheduleSubtitle);
  const icon = useAppState((s) => s.event.scheduleIcon);
  const scheduleUpdatedAt = useAppState((s) => s.event.scheduleUpdatedAt);

  // Same ticking pattern as bracket-tree.tsx's ElapsedTimerPill --
  // Date.now() has to live inside the effect, not called directly in
  // the render body (React's purity rule), and starts at 0 for the same
  // reason: the effect sets the real value on mount, a render or two
  // before that would otherwise show a bogus 1970 clock briefly. The
  // synchronous setState here is deliberate, not the "derive state from
  // props in an effect" antipattern set-state-in-effect normally warns
  // about -- there's no prop/state this is derived from, it's a genuine
  // external clock this component has to poll.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks-js/set-state-in-effect
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!day) {
    return null;
  }

  const rows = sortedByTime(items).filter((row) => row.time || row.event);

  return (
    <FitTo1080>
      <style>{FONT_FACE_CSS}</style>
      <style>{ANIMATIONS_CSS}</style>
      {/* key -- day and scheduleUpdatedAt are both room-synced, changed
          live from the dashboard (switching days via radio buttons, or
          submitting an edit to the currently-shown day), never by
          reloading this page. Without a key forcing this whole panel to
          remount on either change, React just patches the existing DOM
          nodes' text in place and every entrance animation below (each
          of which only plays once per mount) would never replay --
          only on the overlay's very first page load. Keying the OUTER
          panel (not just the row list) means both triggers replay the
          entire sequence -- panel, title, day badge, subtitle, clock,
          then rows -- not just whichever piece actually changed. */}
      <div
        key={`${day}-${scheduleUpdatedAt}`}
        style={{
          // The card's base is the BODY font -- most of its text (rows,
          // clock, schedule-day line) is body content. The title
          // overrides to TITLE_FONT_FAMILY individually, below.
          fontFamily: BODY_FONT_FAMILY,
          // No border/gradient frame anymore -- just the solid
          // fallback fill (still needed as a base under the blurred
          // banner layer below).
          background: "rgba(17, 20, 24, 0.92)",
          borderRadius: 20,
          overflow: "hidden",
          display: "inline-block",
          minWidth: 760,
          position: "relative",
          // The panel/chrome itself, distinct from and ahead of the
          // header text below (which each animate on their own,
          // further staggered) -- otherwise the whole card seems to
          // just appear out of nowhere the instant before its own
          // contents start animating in, which reads as a glitch more
          // than an entrance.
          animation: "scheduleFadeIn 0.3s ease both",
        }}
      >
        {/* The banner art as a soft out-of-focus backdrop rather than a
            legible image under a scrim -- fully removes the "art vs. row
            text" contrast fight instead of just tuning it. Isolated on
            its own absolutely-positioned layer (inline styles can't
            express ::before) so `filter: blur()` never touches the sharp
            text/panels stacked on top of it via z-index. `inset: -20px`
            gives the blur room to bleed past the card's own edges --
            sized exactly to the card, the blur would visibly soften
            right at the border instead of staying inside it. */}
        <div
          style={{
            position: "absolute",
            inset: -20,
            background: `url(${Banner}) center/cover no-repeat`,
            filter: "blur(3px) brightness(0.55)",
          }}
        />
        <div
          style={{
            position: "relative",
            padding: 24,
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {/* A solid panel, matching the rows below -- previously this
              header sat directly on the raw scrimmed banner image with
              nothing underneath it, while every row had its own flat
              COLORS.panel background. That made the top of the card
              read as visibly rougher/busier than the bottom (the image's
              texture showing straight through behind the title/clock)
              even though both were using the same scrim. Giving the
              header the same solid-panel treatment as a row makes the
              whole card read as one consistent stack of panels instead
              of two different treatments stitched together. */}
          <div
            style={{
              background: COLORS.panel,
              border: `3px solid rgb(255, 255, 255)`,
              borderRadius: 14,
              // Noticeably roomier than a row's own "18px 24px" -- the
              // header carries the title, the single biggest thing on
              // the overlay, so the panel itself reads as a clear step
              // up from the rows below it, not the same size box with
              // bigger text inside an identically-sized shell.
              padding: "32px 32px",
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 24,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              {/* Optional, user-picked from their own computer (see
                  dashboard.tsx's ScheduleSettingsSection) -- absent
                  renders nothing, same "no icon means don't show one"
                  idea as an empty subtitle. Sized by HEIGHT only (width
                  auto, capped by maxWidth as a safety limit) rather than
                  a fixed square -- a fixed width+height box forces
                  non-square source logos (most real logos aren't
                  square) to either letterbox or get visually cropped
                  inside it; letting width follow the image's own aspect
                  ratio avoids that regardless of what shape icon gets
                  uploaded. Gap bumped up from the icon's original 44px
                  size's own 14px -- proportionally too tight now that
                  the icon itself is much bigger. */}
              {icon && (
                <img
                  src={icon}
                  alt=""
                  style={{
                    height: 104,
                    width: "auto",
                    maxWidth: 160,
                    objectFit: "contain",
                    borderRadius: 8,
                    flexShrink: 0,
                    animation: "scheduleFadeIn 0.4s ease both",
                    animationDelay: "0.05s",
                  }}
                />
              )}
              {/* The custom overlay title (global, not per-day -- see
                  its own doc above), or the generic "Schedule" fallback
                  with nothing else attached to it -- this is the single
                  biggest thing on the whole overlay, so nothing else
                  (the clock, which day this is) shares its line or its
                  size anymore. */}
              <div
                style={{
                  fontFamily: TITLE_FONT_FAMILY,
                  color: COLORS.text,
                  fontWeight: 800,
                  fontSize: 44,
                  animation: "scheduleFadeIn 0.4s ease both",
                  animationDelay: "0.1s",
                }}
              >
                {subtitle || "Schedule"}
              </div>
            </div>
            {/* Which day's schedule this is, with the live clock
                underneath it -- both in the top-right column, opposite
                the title. Clock deliberately small/secondary (down from
                matching the title's own 44px) so the title stays the
                clear largest element on the pane. */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                gap: 6,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  animation: "scheduleFadeIn 0.4s ease both",
                  animationDelay: "0.2s",
                }}
              >
                <div
                  style={{ color: COLORS.muted, fontWeight: 700, fontSize: 16 }}
                >
                  Schedule for:
                </div>
                <div
                  style={{ color: COLORS.gold, fontWeight: 700, fontSize: 16 }}
                >
                  {DAY_LABELS[day]}
                  {formatDayDate(day, nowMs) &&
                    `, ${formatDayDate(day, nowMs)}`}
                </div>
              </div>
              {/* Live clock -- a real Date.now()-based time, not to be
                  confused with a schedule row's own user-typed wall-clock
                  time string (formatDisplayTime, above). */}
              <div
                style={{
                  color: COLORS.coral,
                  fontWeight: 800,
                  fontSize: 24,
                  fontVariantNumeric: "tabular-nums",
                  animation: "scheduleFadeIn 0.4s ease both",
                  animationDelay: "0.3s",
                }}
              >
                {formatClock(nowMs)}
              </div>
            </div>
          </div>
          {rows.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {rows.map((row, i) => {
                // completed wins over current if a row somehow has both
                // -- the editor's own radio-column UI never produces
                // that combination, but "already happened" is the more
                // definitive of the two claims if it ever did.
                const isCompleted = !!row.completed;
                const isCurrent = !!row.current && !isCompleted;
                const displayTime = formatDisplayTime(row.time);
                // Operator-picked per row (dashboard.tsx's
                // ScheduleDayEditor) -- falls back to the plain neutral
                // defaults when unset, same as every other optional
                // per-row visual.
                const rowBorderColor = row.color || COLORS.border;
                const pillBorderColor = row.color || "rgba(255, 255, 255, 0.8)";
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 20,
                      // Insets each row a little further than the
                      // header panel above it (which stays full width)
                      // -- equal margin on both sides keeps it centered
                      // while reading as a tad narrower, rather than
                      // matching the header's own edge-to-edge width.
                      margin: "0 14px",
                      // Solid backgrounds only -- a completed row used to
                      // fade its entire background/border/text to 45%
                      // opacity via the entrance animation's own end
                      // state, which read as barely-there rather than
                      // legibly "done." It now stays a fully opaque
                      // panel and is marked done via the strikethrough +
                      // muted marker/text below instead.
                      // `current` reads entirely from this background
                      // tint now -- no separate colored border needed
                      // (or dot, or left accent stripe -- all removed)
                      // once the panel fill itself already carries that
                      // signal on its own.
                      background: isCurrent ? COLORS.currentBg : COLORS.panel,
                      border: `3px solid ${rowBorderColor}`,
                      borderRadius: 14,
                      // A tiny bit tighter than the header's own "32px
                      // 32px" -- the header is the main header, these
                      // are secondary content, and shrinking the rows
                      // slightly (instead of only growing the header)
                      // widens the visible size gap between the two
                      // without making the header disproportionately
                      // huge on its own.
                      padding: "18px 24px",
                      // completed rows fade to 0.9 (not fully opaque) as
                      // a light "stepped back" cue on top of the
                      // strikethrough/muted-color treatment -- has to be
                      // its own keyframe's end state, not a separate
                      // inline `opacity` alongside `animation`, since
                      // `animation-fill-mode: both` makes the entrance
                      // animation's own end state permanently win over a
                      // same-property inline style once it finishes.
                      animation: isCompleted
                        ? "scheduleSlideDownFade 0.5s ease both"
                        : "scheduleSlideDown 0.5s ease both",
                      animationDelay: `${0.3 + i * 0.05}s`,
                    }}
                  >
                    {/* Pill border AND background both key off the
                        row's own color (row.color if the operator
                        picked one, otherwise plain neutral defaults) --
                        the background is a soft, low-alpha TINT of it
                        rather than the same full-strength swatch value
                        the border uses, since a solid saturated fill
                        behind the numeral/period text would be too loud
                        and would fight the text for contrast. */}
                    <div
                      style={{
                        boxSizing: "border-box",
                        display: "inline-flex",
                        // baseline, not center -- the numeral (18px) and
                        // period (11px) are different font sizes, so
                        // centering by box height (the default "center"
                        // behavior) lines up their MIDDLES instead of
                        // their text baselines, which reads as the
                        // period floating above where it should sit.
                        alignItems: "baseline",
                        justifyContent: "center",
                        background: row.color
                          ? hexToRgba(row.color, 0.18)
                          : "rgba(255, 255, 255, 0.06)",
                        border: `3px solid ${pillBorderColor}`,
                        borderRadius: 500,
                        padding: "8px 14px",
                        minWidth: 100,
                        flexShrink: 0,
                      }}
                    >
                      {displayTime && (
                        <>
                          <span
                            style={{
                              color: COLORS.muted,
                              fontWeight: 800,
                              fontSize: 18,
                            }}
                          >
                            {displayTime.numeral}
                          </span>
                          <span
                            style={{
                              color: COLORS.muted,
                              fontWeight: 600,
                              fontSize: 11,
                              opacity: 0.75,
                              marginLeft: 3,
                            }}
                          >
                            {displayTime.period}
                          </span>
                        </>
                      )}
                    </div>
                    <div>
                      <div
                        style={{
                          fontFamily: TITLE_FONT_FAMILY,
                          color: isCompleted ? COLORS.muted : COLORS.text,
                          fontWeight: 800,
                          fontSize: 24,
                          textDecoration: isCompleted ? "line-through" : "none",
                        }}
                      >
                        {row.event}
                      </div>
                      {row.description && (
                        <div
                          style={{
                            fontFamily: BODY_FONT_FAMILY,
                            color: COLORS.muted,
                            fontSize: 16,
                          }}
                        >
                          {row.description}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </FitTo1080>
  );
}
