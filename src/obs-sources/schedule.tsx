import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DEFAULT_SCHEDULE_STATUS,
  type ScheduleDay,
  type ScheduleItem,
  type ScheduleStatusState,
} from "../state/event.slice";
import { useAppState } from "../state/store";
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
  muted: "#9aa2ac",
  mint: "#22c55e",
  gold: "#efc75e",
  coral: "#f0a868",
  currentBg: "#2c4435",
  blue: "#3A7CDE",
  red: "#F54927",
};
// Two independent slots, not one shared FONT_FAMILY -- a bold hand-drawn
// display face reads fine at the title's large size but hurts legibility
// at the smaller sizes everything else on the card uses, so the title
// gets its own font, separate from the rest of the card's body text.
// titleFont/bodyFont are never actually null -- local-fonts.ts always
// resolves each slot to either a locally-supplied title-font.*/
// body-font.* or its own bundled, openly-licensed fallback font. The
// ternary below is just defensive in case that ever changes; it doesn't
// currently fall through to SYSTEM_FONT_STACK in practice.
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
/* The panel's own entrance when the displayed DAY changes -- distinct
   from the plainer scheduleFadeIn used by the header pieces (which
   still just fade in as part of that same sequence). A day switch is a
   deliberate "different board" moment, not just new numbers on the
   existing one, so it gets its own slightly more pronounced settle-in
   (scale + slide) rather than reusing the same bare fade every other
   entrance on this overlay uses. */
@keyframes scheduleDayIn {
  from { opacity: 0; transform: translateY(-10px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
`;
// Values that change WITHOUT the whole panel re-entering -- the day
// label, the schedule status badge, and every row's displayed time --
// crossfade via useCrossfade below instead of a @keyframes animation. A
// single keyframe can't coordinate with a content swap (it has no way to
// know when it's actually reached fully transparent), so this is plain
// `opacity` + `transition`, driven from a timer in JS: fade the OLD
// value out, swap to the new value only once it's fully invisible, then
// fade that in. VALUE_FADE_MS governs both halves equally -- a slow,
// symmetric fade out/in, not a quick blip, and never asymmetric between
// the two directions.
const VALUE_FADE_MS = 700;

// --- Every other tunable animation duration/delay on this overlay,
// collected here instead of left as scattered "0.4s"-style literals in
// the JSX below, specifically so they're easy to find and adjust by
// hand. All delay/duration values are in SECONDS (matching inline CSS
// string conventions like "0.4s"), except VALUE_FADE_MS above, which is
// in milliseconds (it's also used as a plain JS setTimeout duration,
// not just a CSS string). ---

/** The whole panel's entrance (scheduleDayIn) -- plays when the
 * displayed DAY changes, and once, on this overlay's very first mount. */
const DAY_CHANGE_DURATION_S = 0.4;
/** Each header piece's own fade-in (icon, title, the "Schedule for:"
 * row, the clock) -- scheduleFadeIn. All four play at once as DAY_CHANGE
 * plays, staggered start-to-start by HEADER_STAGGER_S (the icon starts
 * slightly earlier still, by HEADER_ICON_LEAD_S, so it's already
 * settling in by the time the title beside it starts). */
const HEADER_FADE_DURATION_S = 0.4;
const HEADER_STAGGER_S = 0.1;
const HEADER_ICON_LEAD_S = 0.05;

/** A row's own staggered slide-in entrance (scheduleSlideDown/
 * scheduleSlideDownFade) -- only plays right after a day change (see
 * entranceSettled). ROW_ENTRANCE_BASE_DELAY_S before the first row
 * starts (lines up with the header settling in above), then
 * ROW_ENTRANCE_STAGGER_S between each subsequent row. */
const ROW_ENTRANCE_DURATION_S = 0.5;
const ROW_ENTRANCE_BASE_DELAY_S = 0.3;
const ROW_ENTRANCE_STAGGER_S = 0.05;

/** Once a row's entrance has settled, how long its background/border/
 * opacity (and its own event-text color) take to crossfade when
 * current/completed changes -- see the row's own `transition`. */
const ROW_SETTLE_TRANSITION_S = 0.3;

/**
 * Holds onto the OLD `value` (and keeps rendering it) while fading it out,
 * and only swaps to the new one -- fully invisible at that point -- before
 * fading back in. Returns what to actually render (`rendered`, which lags
 * the live `value` during the out-phase) and the `opacity` to apply; pair
 * with `transition: opacity ${fadeMs}ms ease` on the element (a plain CSS
 * transition, not a keyframe animation -- the swap has to be coordinated
 * from here, in JS, since CSS alone has no way to know when the fade has
 * actually reached 0).
 *
 * Deliberately PER ELEMENT, not one shared clock for the whole overlay --
 * a shared-clock version put the day label, status badge, and every row's
 * time on one timer so they'd always move in lockstep, but that meant
 * literally everything faded out and back in on ANY change, even elements
 * whose own displayed value didn't actually change (the day label
 * dimming when only the status changed, say). Each element fading
 * independently -- only when ITS OWN value changes -- is what makes
 * "only updated information fades" true. They still all call this same
 * hook with the same fadeMs, so anything that IS changing together still
 * moves at the identical speed; they just aren't forced to move together
 * when only one of them actually has new information to show.
 *
 * `isEqual` decides what counts as "changed" -- pass reference equality
 * for primitives (day), or a field comparison for an object (schedule
 * status, a row's time+color) since a fresh object literal from a
 * selector/computation is never `===` its predecessor even when nothing
 * meaningful about it actually changed.
 *
 * fadeMs governs BOTH halves equally -- fadeMs to fade out, then exactly
 * fadeMs to fade back in. Never asymmetric between the two directions.
 *
 * A cycle, once started, always runs to completion in fadeMs+fadeMs --
 * a value that changes again mid-cycle does NOT restart the clock, it
 * just gets picked up as the target whenever the CURRENT cycle's swap
 * point arrives. Restarting the timer on every new value (an earlier
 * version) meant switching between a few days/statuses in quick
 * succession kept cancelling it before it ever fired, leaving the
 * element stuck fully invisible for as long as changes kept arriving.
 */
function useCrossfade<T>(
  value: T,
  fadeMs: number,
  isEqual: (a: T, b: T) => boolean,
): { rendered: T; opacity: number } {
  const [rendered, setRendered] = useState(value);
  const [opacity, setOpacity] = useState(1);
  // What `rendered` currently reflects, and the truly-live value -- refs,
  // not state, so the effect below can reason about both synchronously
  // without a stale closure, regardless of how many renders happen
  // while a cycle is in flight.
  const shownRef = useRef(value);
  const latestValueRef = useRef(value);
  const cyclingRef = useRef(false);
  const timer1Ref = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const timer2Ref = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // Bumped when a cycle finishes, purely to force one more render so the
  // effect re-runs and can reconcile -- see the end-of-cycle note below.
  const [, forceReconcile] = useState(0);
  latestValueRef.current = value;

  useEffect(() => {
    // A cycle's already running -- it reads latestValueRef itself when
    // it swaps, so it'll pick up this value on its own; don't touch its
    // timers.
    if (cyclingRef.current) return;
    if (isEqual(value, shownRef.current)) return; // already showing it

    cyclingRef.current = true;
    setOpacity(0);
    timer1Ref.current = setTimeout(() => {
      // latestValueRef.current, not the `value` this closure captured
      // -- if it moved again during the fade-out, show wherever it
      // actually ended up, not whatever triggered this cycle.
      shownRef.current = latestValueRef.current;
      setRendered(latestValueRef.current);
      setOpacity(1);
      timer2Ref.current = setTimeout(() => {
        cyclingRef.current = false;
        // A value that changed during the fade-IN half (after the swap
        // above) left shownRef behind, and clearing cyclingRef in a
        // timer doesn't itself re-render -- so without this the effect
        // would never re-run to notice, and the element would sit on a
        // stale value until some unrelated render (a clock tick, up to
        // a second later) happened to reconcile it. This forces exactly
        // that reconciling render immediately, so a change is at worst
        // one fade-cycle late, never stuck showing the wrong thing.
        forceReconcile((n) => n + 1);
      }, fadeMs);
    }, fadeMs);
  });

  // Cleanup only on unmount -- clearing these on every render (the way a
  // dependency-array effect would) is exactly the "cancel the pending
  // swap" behavior this hook is deliberately avoiding.
  useEffect(() => {
    return () => {
      clearTimeout(timer1Ref.current);
      clearTimeout(timer2Ref.current);
    };
  }, []);

  return { rendered, opacity };
}

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

// Applies the schedule status's minutes value to a row's wall-clock
// time for DISPLAY only -- never touches the row's own stored `time`,
// since which rows this even applies to (not current, not completed)
// changes live as the event progresses, and the operator can flip
// ahead/on time/delayed back and forth. Baking it into the stored data
// would compound on every status change instead of always reflecting
// just the current one. Date's own setHours normalizes an out-of-range
// minutes value (negative or >59) into the right hour/minute pair for
// free, so a shift crossing an hour (or midnight) wraps correctly
// without any extra rollover handling here.
function shiftTimeString(
  time: string | undefined,
  deltaMinutes: number,
): string | undefined {
  if (!time || !deltaMinutes) return time;
  const [hStr, mStr] = time.split(":");
  const hours = Number(hStr);
  const minutes = Number(mStr);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return time;
  const d = new Date();
  d.setHours(hours, minutes + deltaMinutes, 0, 0);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Row colors come in as plain "#rrggbb" from the dashboard's native
// <input type="color"> (see dashboard.tsx's ScheduleDayEditor), which
// can't express alpha itself. Pre-blended into a SOLID color against
// COLORS.panel rather than left as a translucent rgba() tint -- the time
// box sits on top of the row's own background, which differs by row
// state (COLORS.currentBg vs COLORS.panel) -- a translucent tint let
// that show through, so the exact same row.color box read as a
// different effective color on the current row than on every other row.
// Blending against a fixed base up front keeps it looking identical
// regardless of what row it's in.
function blendOverPanel(hex: string, alpha: number): string {
  const fgMatch = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  const bgMatch = /^#([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(COLORS.panel);
  if (!fgMatch || !bgMatch) return hex;
  const mix = (fg: string, bg: string) =>
    Math.round(parseInt(fg, 16) * alpha + parseInt(bg, 16) * (1 - alpha));
  const [, fr, fg, fb] = fgMatch;
  const [, br, bgc, bb] = bgMatch;
  return `rgb(${mix(fr, br)}, ${mix(fg, bgc)}, ${mix(fb, bb)})`;
}

function sortedByTime(items: ScheduleItem[]): ScheduleItem[] {
  return [...items].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
}

// Train-station-board-style status, bottom-right of the header (see the
// badge in Schedule below) -- operator-set (dashboard.tsx's
// ScheduleDayEditor radios + minutes box, staged/submitted alongside
// that day's own rows), not computed from row times vs. the clock.
const SCHEDULE_STATUS_LABELS: Record<ScheduleStatusState, string> = {
  ahead: "Ahead of Schedule by",
  onTime: "On-Time",
  delayed: "Behind Schedule by",
};
const SCHEDULE_STATUS_COLORS: Record<ScheduleStatusState, string> = {
  ahead: COLORS.mint,
  onTime: COLORS.blue,
  delayed: COLORS.red,
};

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

// Centers `children` within its (position:relative) parent using
// measured, integer-pixel offsets instead of the CSS `left: 50%` +
// `transform: translate(-50%, -50%)` trick tried first -- that reliably
// lands the content at a sub-pixel position (confirmed directly: e.g.
// `left: 75.99px`), which browsers render by anti-aliasing across the
// pixel boundary, reading as slightly blurrier text than a crisp
// integer-pixel position does. Runs in useLayoutEffect (before paint,
// so no visible jump) and stays hidden until the first measurement
// lands, since there's nothing meaningful to show before the content's
// own natural size is known.
function CenteredTimeText({
  children,
  style,
}: {
  children: React.ReactNode;
  /** merged in beneath the centering styles below -- e.g. the caller's
   * own opacity + transition for a value that's crossfading (see
   * useCrossfade); omit for a box that never fades on its own. */
  style?: React.CSSProperties;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<{ left: number; top: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const content = contentRef.current;
    const box = content?.parentElement;
    if (!content || !box) return;
    const measure = () => {
      // box.getBoundingClientRect() (not clientWidth/Height) -- this
      // box has a border on the right only (the row divider), and
      // clientWidth excludes that border, which would re-introduce the
      // same half-border offset bug the calc(50% + 1.5px) fix above was
      // working around. Rounded before dividing so the two numbers
      // being subtracted are both whole pixels going in, not just the
      // result coming out.
      const boxRect = box.getBoundingClientRect();
      setOffset({
        left: Math.round((Math.round(boxRect.width) - content.offsetWidth) / 2),
        top: Math.round(
          (Math.round(boxRect.height) - content.offsetHeight) / 2,
        ),
      });
    };
    measure();
    // Re-measure once every @font-face has actually finished loading --
    // the measurement above necessarily runs against whatever font is
    // available at that instant (the system fallback, while a real
    // title-font.otf/body-font.otf is still downloading -- see
    // local-fonts.ts), and a custom font's own glyph widths are rarely
    // identical to the fallback's. Without this, the box was measured
    // and centered against the WRONG font, then visibly reflowed (with
    // nothing re-centering it) the instant the real font finished
    // loading -- the "times move on refresh" symptom, confirmed
    // directly.
    void document.fonts.ready.then(measure);
  }, [children]);

  return (
    <div
      ref={contentRef}
      style={{
        position: "absolute",
        left: offset?.left ?? 0,
        top: offset?.top ?? 0,
        visibility: offset ? "visible" : "hidden",
        display: "inline-flex",
        alignItems: "baseline",
        whiteSpace: "nowrap",
        // Caller-supplied opacity/transition (see useCrossfade) layers
        // on top of the centering styles above -- spread last so it can
        // still override `visibility` if it ever needed to, though in
        // practice it only ever touches opacity/transition.
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Compares two possibly-null DisplayTimes by their rendered text, not
 * object identity -- formatDisplayTime returns a fresh object every
 * call even when its input didn't actually change. */
function displayTimeEqual(a: DisplayTime | null, b: DisplayTime | null) {
  if (a === null || b === null) return a === b;
  return a.numeral === b.numeral && a.period === b.period;
}

// A single schedule row. `scheduleStatus` is the LIVE status, same as
// Schedule reads from Redux -- each row computes its own displayTime/
// timeColor from it and crossfades that pair with its own useCrossfade
// call below, independently of the day label and status badge (see
// useCrossfade's own doc for why per-element rather than one shared
// clock). current/completed changes are separate (a plain CSS
// transition, see below) since those are per-row and not a value this
// row is "informed about" the way a status shift is.
function ScheduleRow({
  row,
  index,
  scheduleStatus,
  entranceSettled,
}: {
  row: ScheduleItem;
  index: number;
  scheduleStatus: { state: ScheduleStatusState; minutes: number };
  entranceSettled: boolean;
}) {
  // completed wins over current if a row somehow has both -- the
  // editor's own radio-column UI never produces that combination, but
  // "already happened" is the more definitive of the two claims if it
  // ever did.
  const isCompleted = !!row.completed;
  const isCurrent = !!row.current && !isCompleted;
  // "All future schedules" -- every row that isn't the one happening
  // right now and hasn't already happened, regardless of where it falls
  // time-wise relative to `current`. Only these get the status's
  // minutes value applied to their displayed time (ahead subtracts,
  // delayed adds) and their time colored to match -- current/completed
  // rows keep their own already-established treatment untouched.
  const isUpcoming = !isCurrent && !isCompleted;
  const statusDelta =
    scheduleStatus.state === "ahead"
      ? -scheduleStatus.minutes
      : scheduleStatus.state === "delayed"
        ? scheduleStatus.minutes
        : 0;
  const timeIsShifted = isUpcoming && statusDelta !== 0;
  const displayTime = formatDisplayTime(
    timeIsShifted ? shiftTimeString(row.time, statusDelta) : row.time,
  );
  const timeColor = timeIsShifted
    ? SCHEDULE_STATUS_COLORS[scheduleStatus.state]
    : isCompleted
      ? COLORS.muted
      : COLORS.text;
  // The outer row border is a flat, uniform signal now, not per-row
  // picked color (row.color still drives the time pill below, just not
  // this) -- green for the current row, a plain muted gray for a
  // completed one (matching its already-dimmed text/opacity rather than
  // standing out), plain white for every other, still-upcoming row.
  const rowBorderColor = isCurrent
    ? COLORS.mint
    : isCompleted
      ? COLORS.border
      : COLORS.text;
  const pillBorderColor = row.color || "rgba(255, 255, 255, 0.8)";

  // Crossfades the numeral/period AND color together (not just the
  // numbers) -- otherwise, mid-fade, the still-old time would briefly
  // render in the ALREADY-new status color, which is exactly the kind
  // of "updated immediately" mismatch this is meant to avoid.
  //
  // Always active, not gated on `timeIsShifted` -- switching the
  // schedule status to On-Time, specifically, is exactly a row going
  // from shifted to unshifted, and gating on timeIsShifted was falling
  // through for that transition and snapping instantly instead of
  // fading. useCrossfade's own isEqual check already no-ops correctly
  // when nothing actually changed (a row whose time never shifts just
  // never triggers a cycle), so there's no need to additionally gate it
  // here.
  const { rendered: renderedTimeDisplay, opacity: timeOpacity } =
    useCrossfade(
      { time: displayTime, color: timeColor },
      VALUE_FADE_MS,
      (a, b) => a.color === b.color && displayTimeEqual(a.time, b.time),
    );
  const timeToShow = renderedTimeDisplay.time;
  const colorToShow = renderedTimeDisplay.color;

  return (
    <div
      style={{
        display: "flex",
        // stretch, not center -- the time box below relies on this to
        // fill the row's full height, rather than sizing itself and
        // leaving a gap of row background visible above/below it.
        alignItems: "stretch",
        // No gap -- the time box's own borderRight now reads as the
        // divider between it and the text content, replacing the old
        // empty space between two separately-bordered pieces.
        // Insets each row a little further than the header panel above
        // it (which stays full width) -- equal margin on both sides
        // keeps it centered while reading as a tad narrower, rather
        // than matching the header's own edge-to-edge width.
        margin: "0 14px",
        // Solid backgrounds only -- a completed row used to fade its
        // entire background/border/text to 45% opacity via the entrance
        // animation's own end state, which read as barely-there rather
        // than legibly "done." It now stays a fully opaque panel and is
        // marked done via the strikethrough + muted marker/text below
        // instead.
        // `current` reads entirely from this background tint now -- no
        // separate colored border needed (or dot, or left accent stripe
        // -- all removed) once the panel fill itself already carries
        // that signal on its own.
        background: isCurrent ? COLORS.currentBg : COLORS.panel,
        border: `3px solid ${rowBorderColor}`,
        borderRadius: 14,
        // Clips the time box's own square right edge/background to the
        // row's rounded corners -- the box's own left corners are
        // rounded to match (see below), this is just a safety net for
        // subpixel rounding between the two.
        overflow: "hidden",
        // No padding here anymore -- it moved onto the two children
        // individually now that they're two visually distinct sections
        // (time box, text) of one divided row, rather than
        // free-floating content inside a single padded shell.
        // completed rows fade to 0.9 (not fully opaque) as a light
        // "stepped back" cue on top of the strikethrough/muted-color
        // treatment -- a plain inline value now rather than only a
        // keyframe end state, since `animation` is no longer always
        // present on this element (see entranceSettled) -- while it IS
        // still playing, the animation's own end state (same 0.9
        // value) wins until it finishes, so there's no visible seam at
        // the handoff either way.
        opacity: isCompleted ? 0.9 : 1,
        // Only active in practice once entranceSettled -- while the
        // entrance animation is still playing, it owns these same
        // properties outright. Once settled, this is what makes a
        // later current/completed toggle crossfade smoothly instead of
        // hard-cutting (the only alternative left now that it no longer
        // replays the whole slide-in entrance for that kind of change
        // -- see Schedule's outer panel comment for why).
        transition:
          "background-color 0.3s ease, border-color 0.3s ease, opacity 0.3s ease",
        ...(entranceSettled
          ? {}
          : {
              animation: isCompleted
                ? "scheduleSlideDownFade 0.5s ease both"
                : "scheduleSlideDown 0.5s ease both",
              animationDelay: `${0.3 + index * 0.05}s`,
            }),
      }}
    >
      {/* A boxed section of the row now, not a separate floating pill
          -- stretches to the row's full height and its borderRight is
          the only border, reading as a divider between it and the text
          next to it rather than a fully-enclosed shape of its own.
          Border/background still key off the row's own color (row.color
          if the operator picked one, otherwise plain neutral
          defaults). */}
      <div
        style={{
          boxSizing: "border-box",
          // position:relative + the child's absolute top/left:50% +
          // translate(-50%,-50%) below, rather than flex's
          // align/justify-items:center -- flexbox centers by LINE-BOX
          // (which pads out for font ascent/descent metrics), not by
          // the text's actual rendered bounding box, so a
          // baseline-aligned two-different-font-sizes group like this
          // one landed visibly off the box's true center.
          // Transform-centering measures the group's own real bounding
          // box against the box's exact midpoint instead.
          position: "relative",
          background: row.color
            ? blendOverPanel(row.color, 0.18)
            : blendOverPanel("#ffffff", 0.06),
          borderRight: `3px solid ${pillBorderColor}`,
          // Matches the row's own 14px corner radius minus its 3px
          // border, so the box's outer edge nests flush against the
          // inside of that rounded corner instead of showing a square
          // peeking out past a round one. Only the left corners -- it's
          // a divider on the right, not its own separately-rounded
          // shape.
          borderRadius: "11px 0 0 11px",
          // Fixed width, not just a minWidth floor -- a minWidth let a
          // two-digit hour ("11:00") grow this box wider than a
          // one-digit hour's ("3:00") row right next to it, so the
          // divider line (this box's own borderRight) landed at a
          // different x position row-to-row instead of lining up in
          // one column. 150px comfortably fits the widest realistic
          // value ("12:00 PM") at this font size with room to spare.
          width: 150,
          flexShrink: 0,
        }}
      >
        {timeToShow && (
          <CenteredTimeText
            style={{
              // This row's own crossfade opacity -- naturally 1 with
              // nothing to fade on a fresh mount (useCrossfade starts
              // `rendered`/`opacity` from the value it's given, so
              // there's no "old" value to fade from yet), so this
              // doesn't need any entranceSettled-style guard the way a
              // shared clock would have: a brand-new row just shows its
              // time normally, and only fades on a later, genuine
              // change to it.
              opacity: timeOpacity,
              transition: `opacity ${VALUE_FADE_MS}ms ease`,
            }}
          >
            {/* White by default -- completed rows keep the old muted
                treatment instead (so a done row's time still reads as
                part of the same grayed-out/struck-through row rather
                than standing out as the one bright element left in
                it), and a row whose displayed time got shifted by the
                schedule status instead takes THAT status's color, so
                the shifted value is visibly flagged as adjusted rather
                than looking like an unchanged, directly-entered time. */}
            <span style={{ color: colorToShow, fontSize: 30 }}>
              {timeToShow.numeral}
            </span>
            <span
              style={{
                color: colorToShow,
                fontSize: 16,
                opacity: 0.75,
                marginLeft: 3,
              }}
            >
              {timeToShow.period}
            </span>
          </CenteredTimeText>
        )}
      </div>
      <div style={{ padding: "18px 24px" }}>
        <div
          style={{
            fontFamily: TITLE_FONT_FAMILY,
            color: isCompleted ? COLORS.muted : COLORS.text,
            fontSize: 24,
            // Matches the row's own background/border transition
            // above, so completing a row reads as one smooth crossfade
            // rather than the panel drifting to its new color while
            // the text snaps to muted a beat later.
            transition: "color 0.3s ease",
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
  const scheduleStatus = useAppState((s) =>
    day
      ? (s.event.scheduleStatus[day] ?? DEFAULT_SCHEDULE_STATUS)
      : DEFAULT_SCHEDULE_STATUS,
  );

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

  // Rows only get their staggered slide-in entrance (scheduleSlideDown/
  // scheduleSlideDownFade below) while this is false -- true for the
  // brief window right after the panel (re)mounts on a day change, then
  // flips permanently true until the next one. Once settled, a row's
  // background/border/opacity are plain inline styles with a CSS
  // `transition` instead (see the row's style below) -- current/
  // completed toggling smoothly crossfades between those two resting
  // looks rather than replaying an entrance meant for "this row is
  // appearing for the first time." Keyed on `day` (not e.g. items.length)
  // since a day change is the only thing that still remounts the panel
  // -- see the outer key's own comment.
  const [entranceSettled, setEntranceSettled] = useState(false);
  useEffect(() => {
    setEntranceSettled(false);
    // matches the row stagger formula below (ROW_ENTRANCE_BASE_DELAY_S
    // + ROW_ENTRANCE_STAGGER_S/row) plus that row's own
    // ROW_ENTRANCE_DURATION_S, with a little slack so the handoff to
    // plain styles/transitions never lands mid-animation
    const maxDelaySec =
      ROW_ENTRANCE_BASE_DELAY_S +
      Math.max(0, items.length - 1) * ROW_ENTRANCE_STAGGER_S;
    const id = setTimeout(
      () => setEntranceSettled(true),
      (maxDelaySec + ROW_ENTRANCE_DURATION_S) * 1000 + 100,
    );
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately day-only, see comment above
  }, [day]);

  // Two independent crossfades, one per header element -- see
  // useCrossfade's own doc for why not one shared clock. Each fades only
  // when ITS OWN relevant value changes:
  //  - the day label: only `day` itself.
  //  - the status badge: `day` too, in addition to state/minutes -- a
  //    day switch shows a DIFFERENT day's status, which is new
  //    information for this badge even on the coincidence that its
  //    state/minutes happen to match the previous day's, so it still
  //    counts as "updated" and gets its own fade.
  // Called unconditionally (before the `!day` return below) since hooks
  // can't be conditional -- day can be null (the Settings tab's "None"),
  // which useCrossfade doesn't care about either way.
  const { rendered: renderedDay, opacity: dayOpacity } = useCrossfade<
    ScheduleDay | null
  >(day, VALUE_FADE_MS, Object.is);
  const { rendered: renderedStatus, opacity: statusOpacity } = useCrossfade(
    { day, state: scheduleStatus.state, minutes: scheduleStatus.minutes },
    VALUE_FADE_MS,
    (a, b) => a.day === b.day && a.state === b.state && a.minutes === b.minutes,
  );

  if (!day) {
    return null;
  }

  const rows = sortedByTime(items).filter((row) => row.time || row.event);
  // Derived from `renderedStatus` (this badge's own lagged value), NOT
  // the live `scheduleStatus` -- it keeps showing the OLD state/minutes
  // until fully invisible, then swaps, so the label/color here must lag
  // in step, not jump ahead of what's on screen.
  // The minutes box only qualifies ahead/delayed -- "On Time 5m" doesn't
  // mean anything the way "Ahead of Schedule 5m"/"Delayed 5m" do, so
  // it's left off that one state specifically rather than shown
  // unconditionally.
  const statusLabel =
    renderedStatus.state === "onTime"
      ? SCHEDULE_STATUS_LABELS.onTime
      : `${SCHEDULE_STATUS_LABELS[renderedStatus.state]} ${renderedStatus.minutes} minutes`;
  const statusColor = SCHEDULE_STATUS_COLORS[renderedStatus.state];

  return (
    <>
      <style>{FONT_FACE_CSS}</style>
      <style>{ANIMATIONS_CSS}</style>
      {/* No key here (deliberately) -- this panel mounts once, when the
          overlay itself first loads, and then stays mounted for the
          whole OBS session. Its own entrance below plays that one time
          only. Nothing about this day's data -- which day is selected,
          its status, which row is current/completed, row text, etc. --
          ever remounts the whole panel to show a change; a full
          re-entrance of everything (title, day badge, clock, every row
          sliding back in) read as far more disruptive than any single
          edit actually warrants, switching days included. Each of those
          instead updates only the piece that actually changed: the day
          label and status badge get their own small scheduleValuePulse
          flash (see their own keys below), same for any status-shifted
          row time, and a row's current/completed look is a plain CSS
          transition once its entrance has settled (see entranceSettled
          above, which still keys the ROW entrance specifically off
          `day` -- a day switch is real new content, just not a reason
          to tear down and rebuild the whole panel around it). */}
      <div
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
          // than an entrance. scheduleDayIn specifically (not the
          // plainer scheduleFadeIn the header pieces use) -- this only
          // ever plays for an actual day switch now, so it's allowed to
          // read as more deliberate than a bare fade.
          animation: "scheduleDayIn 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) both",
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
              // Anchors the on-time/delayed badge below to this panel's
              // own bottom-right corner, not the outer card's -- see
              // that badge's own comment.
              position: "relative",
              background: COLORS.panel,
              border: `3px solid rgb(255, 255, 255)`,
              borderRadius: 14,
              // Noticeably roomier than a row's own "18px 24px" -- the
              // header carries the title, the single biggest thing on
              // the overlay, so the panel itself reads as a clear step
              // up from the rows below it, not the same size box with
              // bigger text inside an identically-sized shell. Extra
              // bottom padding for the status badge below -- its
              // position:absolute (anchored to this panel, not the
              // outer card) would otherwise sit ON TOP of the day/clock
              // column instead of below it, since the panel's own
              // height is normally just tall enough for that column's
              // own content with no badge-sized gap left under it.
              padding: "32px 32px 60px",
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
                <div style={{ color: COLORS.muted, fontSize: 20 }}>
                  Schedule for:
                </div>
                <div
                  style={{
                    color: COLORS.gold,
                    fontSize: 20,
                    opacity: dayOpacity,
                    transition: `opacity ${VALUE_FADE_MS}ms ease`,
                  }}
                >
                  {/* renderedDay, not `day` -- see useCrossfade above:
                      switching days fades this OLD text fully out first,
                      only swapping to the new day's label once invisible,
                      then fades that in. Guards null defensively (day is
                      guaranteed non-null past the early return above,
                      but the crossfade's `rendered` briefly lags behind
                      it, so it hasn't necessarily caught up yet). */}
                  {renderedDay && (
                    <>
                      {DAY_LABELS[renderedDay]}
                      {formatDayDate(renderedDay, nowMs) &&
                        `, ${formatDayDate(renderedDay, nowMs)}`}
                    </>
                  )}
                </div>
              </div>
              {/* Live clock -- a real Date.now()-based time, not to be
                  confused with a schedule row's own user-typed wall-clock
                  time string (formatDisplayTime, above). */}
              <div
                style={{
                  color: COLORS.coral,
                  fontSize: 24,
                  fontVariantNumeric: "tabular-nums",
                  animation: "scheduleFadeIn 0.4s ease both",
                  animationDelay: "0.3s",
                }}
              >
                {formatClock(nowMs)}
              </div>
            </div>
            {/* Train-station-board-style status, bottom-right of the
                header panel -- operator-set (see scheduleStatus/
                SCHEDULE_STATUS_LABELS above), always shown once a day's
                selected. Has to be a CHILD of the header panel (not a
                sibling after it closes) so its position:absolute
                anchors to that panel's own position:relative, not the
                outer card's. */}
            <div
              style={{
                position: "absolute",
                bottom: 16,
                right: 16,
                padding: "6px 16px",
                borderRadius: 999,
                // statusLabel/statusColor are both already derived from
                // renderedStatus above, not the live value -- an
                // operator flipping ahead/on-time/delayed, editing the
                // minutes, or switching days (this badge shows a
                // different day's status even when it coincidentally
                // has the same state/minutes as the last one) fades
                // this fully out, THEN swaps text+color, THEN fades it
                // back in. See this badge's own useCrossfade call above.
                border: `3px solid ${statusColor}`,
                background: blendOverPanel(statusColor, 0.15),
                color: statusColor,
                fontSize: 16,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                opacity: statusOpacity,
                transition: `opacity ${VALUE_FADE_MS}ms ease`,
              }}
            >
              {statusLabel}
            </div>
          </div>
          {rows.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {rows.map((row, i) => (
                <ScheduleRow
                  key={i}
                  row={row}
                  index={i}
                  scheduleStatus={scheduleStatus}
                  entranceSettled={entranceSettled}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
