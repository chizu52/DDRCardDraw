import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  DEFAULT_SCHEDULE_STATUS,
  type ScheduleDay,
  type ScheduleItem,
  type ScheduleStatusState,
} from "../state/event.slice";
import { useAppState } from "../state/store";
import {
  bodyFont,
  titleFont,
  TITLE_FONT_FAMILY,
  BODY_FONT_FAMILY,
} from "./local-fonts";
import { BROADCAST_COLORS, blendOverBase } from "./broadcast-theme";
import {
  MARQUEE_KEYFRAMES_CSS,
  MarqueeText,
  useMarqueeDistances,
  MARQUEE_SPEED_PX_PER_S,
  MARQUEE_BASE_DURATION_S,
} from "./marquee";

// The accent trio (mint/gold/coral) is shared with gauntlet-pools.tsx/
// pool-results.tsx; currentBg/blue/red are this overlay's own additions
// (red in particular is a different shade than the other two overlays'
// -- not a duplicate to consolidate).
const COLORS = {
  ...BROADCAST_COLORS,
  currentBg: "#2c4435",
  blue: "#3A7CDE",
  red: "#F54927",
};

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

/** A row's own staggered slide-in entrance (scheduleSlideDown/
 * scheduleSlideDownFade) -- only plays right after a day change (see
 * entranceSettled). ROW_ENTRANCE_BASE_DELAY_S before the first row
 * starts (lines up with the header settling in above), then
 * ROW_ENTRANCE_STAGGER_S between each subsequent row. */
const ROW_ENTRANCE_DURATION_S = 0.5;
const ROW_ENTRANCE_BASE_DELAY_S = 0.3;
const ROW_ENTRANCE_STAGGER_S = 0.05;

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
// in the selector below would be a new array on every selector call,
// which react-redux's default reference-equality check reads as
// "changed" on every dispatch.
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

function sortedByTime(items: ScheduleItem[]): ScheduleItem[] {
  return [...items].sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
}

// Automatic mode's own "now," as "HH:mm" (24-hour, zero-padded) -- the
// exact same format ScheduleItem.time is already stored/typed in, so
// the two compare correctly as plain strings. Derived from the
// machine's own local wall clock (Date's plain getHours/getMinutes, no
// explicit timeZone), same convention this file's own corner clock
// (formatClock) uses -- not a hardcoded timezone, so it lines up with
// whatever local time an operator typed into a row.
function currentLocalTimeString(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Automatic mode's own current/completed derivation, adapted from a
 * sibling fork's own automatic-scheduling PR (github.com/vlnguyen/
 * DDRCardDraw-Storm-2026#45) -- ported the logic, not the code verbatim
 * (that version hardcoded America/New_York; see currentLocalTimeString
 * above for why this uses local time instead), and wired into THIS
 * file's own existing current/completed rendering (ScheduleRow) rather
 * than a separate visual treatment, so automatic mode still looks like
 * the rest of this overlay's established design language.
 *
 * `rows` must already be sorted by time ascending, and the full list is
 * always shown -- no fixed row-count cap, and a row whose time has
 * already passed stays in the list marked `completed` (dimmed, same
 * treatment manual mode's own `completed` rows get) rather than being
 * removed. Walks the list and remembers the index of the LAST row whose
 * time has already arrived (<= `now`) -- that's the currently-active
 * row; every row before it is completed. `started` is false only when
 * NOTHING has started yet (the whole day is still ahead), in which case
 * no row is current or completed. */
function autoRowStatus(
  rows: ScheduleItem[],
  now: string,
): { currentIndex: number; started: boolean } {
  let currentIndex = 0;
  let started = false;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].time && rows[i].time! <= now) {
      currentIndex = i;
      started = true;
    }
  }
  return { currentIndex, started };
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
// `transform: translate(-50%, -50%)` trick -- that reliably lands the
// content at a sub-pixel position (e.g. `left: 75.99px`), which browsers
// anti-alias across the pixel boundary, reading as slightly blurrier
// text. Runs in useLayoutEffect (before paint) and stays hidden until
// the first measurement lands.
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
    // the measurement above runs against whatever font is available at
    // that instant (the system fallback, while a real title-font.otf/
    // body-font.otf is still downloading), and a custom font's glyph
    // widths are rarely identical to the fallback's. Without this, the
    // box stays measured against the wrong font, then visibly reflows
    // uncentered once the real font finishes loading.
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
//
// `current`/`completed` are passed in explicitly now, not read off
// `row` directly -- manual mode passes exactly `row.current`/
// `row.completed` (unchanged behavior), automatic mode instead derives
// them from comparing `row.time` against the real clock (see Schedule's
// own autoRowStatus call). This component doesn't need to know which
// mode produced them, so both modes share the identical rendering below
// rather than automatic mode needing its own separate row treatment.
function ScheduleRow({
  row,
  index,
  scheduleStatus,
  entranceSettled,
  current,
  completed,
}: {
  row: ScheduleItem;
  index: number;
  scheduleStatus: { state: ScheduleStatusState; minutes: number };
  entranceSettled: boolean;
  current: boolean;
  completed: boolean;
}) {
  // Event and description each get their own box/content refs, but
  // share ONE measurement pass (useMarqueeDistances) and ONE derived
  // duration below, so their marquees -- if either needs one -- restart
  // together instead of drifting out of sync.
  const eventBoxRef = useRef<HTMLDivElement>(null);
  const eventContentRef = useRef<HTMLDivElement>(null);
  const descBoxRef = useRef<HTMLDivElement>(null);
  const descContentRef = useRef<HTMLDivElement>(null);
  const marqueeDistances = useMarqueeDistances(
    [
      { key: "event", boxRef: eventBoxRef, contentRef: eventContentRef },
      { key: "description", boxRef: descBoxRef, contentRef: descContentRef },
    ],
    [row.event, row.description],
  );
  const eventDistance = marqueeDistances.get("event") ?? 0;
  const descDistance = marqueeDistances.get("description") ?? 0;
  const marqueeDuration =
    MARQUEE_BASE_DURATION_S +
    Math.max(eventDistance, descDistance) / MARQUEE_SPEED_PX_PER_S;

  // Captured once, from this row's own first render, and frozen from
  // then on -- picking the entrance keyframe (below) from the live
  // `completed` value instead would mean any later flip WHILE the
  // entrance is still playing -- an automatic-mode clock tick crossing
  // this row's time, or an operator toggling scheduleMode -- changes
  // the `animation` value mid-flight. CSS treats a changed animation-
  // name as a brand new instance, restarting it from its own
  // animationDelay all over again, which is exactly the kind of
  // refresh-from-an-unrelated-value this entrance isn't supposed to
  // have (and can leave it torn off mid-flight, never reaching full
  // opacity, once entranceSettled's own fixed timer fires and removes
  // `animation` before the restarted instance finished). Once settled,
  // this is unused -- the animation property is dropped entirely and
  // the LIVE `completed` value takes over via the plain opacity/
  // transition below instead, same as any other post-settle change.
  const [entranceIsCompleted] = useState(completed);

  // completed wins over current if both are somehow true -- manual
  // mode's editor never produces that combination itself, but
  // "already happened" is the more definitive of the two claims if it
  // ever did, and this normalization has to hold regardless of which
  // mode computed the inputs.
  const isCompleted = completed;
  const isCurrent = current && !isCompleted;
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
        // Permanently present, not removed once entranceSettled -- it's
        // the exact value the entrance keyframes' own `to` state already
        // ends on, so this changes nothing about where the row actually
        // sits. What it avoids is the handoff itself: an element under
        // an active CSS animation typically gets its own compositor
        // layer with independently-rounded subpixel positioning, and
        // dropping the `transform` property entirely (rather than
        // leaving this SAME value in place) hands it back to plain,
        // non-composited layout rasterization -- a different rounding
        // path that can land a hair off the animated one. That's the
        // "very subtle shift" some rows still had even after the
        // font-metrics fix above: not a layout bug, a rendering-path
        // handoff. Keeping this set at all times means there's no
        // handoff left to cause it.
        transform: "translateY(0)",
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
              animation: entranceIsCompleted
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
            ? blendOverBase(row.color, 0.18)
            : blendOverBase("#ffffff", 0.06),
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
            <span style={{ color: colorToShow, fontSize: 40 }}>
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
      {/* flex: 1 + minWidth: 0 -- without minWidth:0, a flex item's
          default min-width:auto floors it at its own content's natural
          width, so it would never actually shrink small enough for
          MarqueeText's own overflow:hidden below to have anything to
          clip/measure against. */}
      <div style={{ flex: 1, minWidth: 0, padding: "18px 24px" }}>
        <MarqueeText
          boxRef={eventBoxRef}
          contentRef={eventContentRef}
          distance={eventDistance}
          duration={marqueeDuration}
          style={{
            fontFamily: TITLE_FONT_FAMILY,
            color: isCompleted ? COLORS.muted : COLORS.text,
            fontSize: 36,
            // Matches the row's own background/border transition
            // above, so completing a row reads as one smooth crossfade
            // rather than the panel drifting to its new color while
            // the text snaps to muted a beat later.
            transition: "color 0.3s ease",
          }}
        >
          {row.event}
        </MarqueeText>
        {row.description && (
          <MarqueeText
            boxRef={descBoxRef}
            contentRef={descContentRef}
            distance={descDistance}
            duration={marqueeDuration}
            style={{
              fontFamily: BODY_FONT_FAMILY,
              color: COLORS.muted,
              fontSize: 20,
            }}
          >
            {row.description}
          </MarqueeText>
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
  // "manual" (default) leaves current/completed exactly as the operator
  // set them; "automatic" derives them live from the clock instead --
  // see event.slice.ts's own doc on scheduleMode.
  const scheduleMode = useAppState((s) => s.event.scheduleMode);

  // A lazy initializer (not useState(0) + an effect setting the real
  // value on mount) -- this used to start at 0 and get corrected a
  // render or two later, on the theory that Date.now() can't be called
  // directly in the render body. That's true for a value that has to
  // stay in sync with re-renders, but an initial STATE value is exactly
  // what lazy initializers are for (React calls this once, at mount,
  // same as any other one-time impure read). Starting at the real time
  // immediately -- rather than a bogus 0 that self-corrects moments
  // later -- matters here beyond just the clock text: automatic mode's
  // current/completed (autoRowStatus below) are derived from nowMs, so
  // the old 0-then-corrected sequence meant every row briefly computed
  // as "not started yet" on mount, then flipped for real an instant
  // later -- exactly the kind of unrelated-value-triggered animation
  // restart entranceIsCompleted (ScheduleRow, below) now also guards
  // against directly.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // The row entrance (below) slides/fades using a CSS transform, which
  // doesn't itself affect layout -- but the TEXT it's animating in
  // (TITLE_FONT_FAMILY/BODY_FONT_FAMILY, see FONT_FACE_CSS) does, once
  // its real @font-face file finishes loading and swaps in for whatever
  // fallback system font it rendered with initially. That swap changes
  // glyph metrics -- a row's real height/width -- out from under an
  // entrance that's already mid-flight (or worse, already finished and
  // handed off to plain layout), which is what read as "final position/
  // sizing off compared to the animation": the row wasn't actually
  // animating to the wrong place, the place itself moved right after.
  // Gating the entrance on document.fonts.ready (same signal
  // useMarqueeDistances below already waits on for its own measurements)
  // means every row's very first entrance paint already has its real,
  // final text metrics, so there's nothing left to reflow out from
  // under it.
  //
  // Always starts false and is only ever confirmed from the effect, NOT
  // a synchronous document.fonts.status check up front (a version that
  // did try that) -- FONT_FACE_CSS's own <style> tag registering the
  // @font-face rules is written by THIS SAME component, in THIS SAME
  // render, so on the very first render ever there's a real chance the
  // browser hasn't even registered/started loading them yet, and
  // document.fonts.status reads "loaded" vacuously (nothing pending to
  // wait on) rather than truthfully. That false positive let the
  // entrance start immediately on a fresh load, before the swap, which
  // is exactly the residual "very subtle shift" still being seen -- a
  // smaller version of the same bug, now down to just the initial load
  // instead of every day switch too. The effect below only ever runs
  // after commit, by which point that <style> tag is definitely in the
  // DOM, so document.fonts.ready reflects the real state. The one-frame
  // delay this costs on a fully-cached font is well within
  // ROW_ENTRANCE_BASE_DELAY_S's own 0.3s head start and isn't visible.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Rows only get their staggered slide-in entrance (scheduleSlideDown/
  // scheduleSlideDownFade below) while this is false -- true for the
  // brief window right after a day is first selected/switched to (and
  // fonts are ready, see above), then flips permanently true until the
  // next switch. Once settled, a row's background/border/opacity are
  // plain inline styles with a CSS `transition` instead (see the row's
  // style below) -- current/completed toggling smoothly crossfades
  // between those two resting looks rather than replaying an entrance
  // meant for "this row is appearing for the first time."
  //
  // Started SYNCHRONOUSLY, during render (the `if` below), not from an
  // effect -- an effect-based version lands one whole commit behind: the
  // FIRST paint of the new day's rows (or of fonts finishing load) would
  // still see the OLD entranceSettled (true, left over from already
  // having settled), so every row would render instantly at its resting
  // opacity/position with no entrance at all. Only a moment later would
  // the effect fire and flip it false, attaching the animation -- which,
  // because fill:both applies its `from` state the instant it attaches,
  // snaps every row backward (invisible, offset) before playing forward
  // again. That flash-then-correct is exactly the reported bug: rows
  // briefly showing their final content/position, then visibly re-
  // hiding and sliding back in. Comparing against a tracked
  // `entrancedDay` during render -- a React-supported pattern for
  // resetting state when a prop changes -- means the very first commit
  // for the new day already has entranceSettled=false, so the entrance
  // plays cleanly from the start instead of flashing first.
  const [entranceSettled, setEntranceSettled] = useState(true);
  const [entrancedDay, setEntrancedDay] = useState<ScheduleDay | null>(null);
  if (fontsReady && day !== entrancedDay) {
    setEntrancedDay(day);
    setEntranceSettled(false);
  }
  useEffect(() => {
    if (entrancedDay === null) return; // fonts not ready yet -- hasn't started
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately entrancedDay-only: the settle timer should only ever (re)schedule for an entrance that actually just started
  }, [entrancedDay]);

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

  const sorted = sortedByTime(items).filter((row) => row.time || row.event);
  const isAutomatic = scheduleMode === "automatic";
  // Same ahead/delayed -> minutes convention ScheduleRow's own
  // statusDelta already uses (ahead subtracts, delayed adds) -- real
  // bug, fixed: automatic mode was comparing the clock against each
  // row's raw, AS-TYPED time, completely ignoring this. Setting a delay
  // shifts what viewers see displayed on upcoming rows (ScheduleRow's
  // own timeIsShifted logic, untouched), but automatic mode's own
  // "has this started yet" check needs to agree with that same shifted
  // schedule, not the original one, or a Delayed event would still
  // mark items current/drop them at their ORIGINAL time -- effectively
  // ignoring the delay entirely, exactly the reported bug.
  const statusDelta =
    scheduleStatus.state === "ahead"
      ? -scheduleStatus.minutes
      : scheduleStatus.state === "delayed"
        ? scheduleStatus.minutes
        : 0;
  // A row's own EFFECTIVE time is `row.time + statusDelta` (shiftTimeString's
  // own convention -- see ScheduleRow). "Has it started" means
  // `row.time + statusDelta <= now`, i.e. `row.time <= now - statusDelta` --
  // rather than shifting every row's own time forward (and then needing
  // to make sure ScheduleRow doesn't shift it AGAIN for display), it's
  // equivalent and simpler to shift `now` backward by the same amount
  // once here, then compare against rows' unmodified, as-typed times.
  const nowForComparison =
    (statusDelta
      ? shiftTimeString(currentLocalTimeString(nowMs), -statusDelta)
      : currentLocalTimeString(nowMs)) ?? currentLocalTimeString(nowMs);
  // Both modes always show the full day's rows -- automatic mode just
  // derives current/completed per row (autoRowStatus) by comparing each
  // row's own time against the real clock (nowMs, this component's own
  // existing ticking clock -- no separate poll timer needed, this
  // already updates once a second), adjusted for any live Ahead/Delayed
  // status above, instead of reading the operator-set flags.
  const rows = sorted;
  const autoStatus = isAutomatic
    ? autoRowStatus(sorted, nowForComparison)
    : { currentIndex: -1, started: false };
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
      {/* Shared with pool-results.tsx/bracket-tree.tsx (MARQUEE_KEYFRAMES_CSS)
          -- this overlay used to keep its own separate, byte-identical
          copy (scheduleMarqueeScroll) rather than importing this one,
          specifically to avoid touching an already-tuned file for an
          unrelated request; now retrofitted onto the shared version,
          same canonical speed/duration every other overlay's marquee
          uses -- explicit user request to make overflow text uniform
          across every overlay, not just share the keyframe shape. */}
      <style>{MARQUEE_KEYFRAMES_CSS}</style>
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
          // The @font-face for both custom fonts (see local-fonts.ts's
          // LOCAL_FONT_FACE_CSS) only ever registers ONE weight (400,
          // hardcoded) per font, regardless of what the actual supplied
          // file's own native weight is. Any element asking for a
          // DIFFERENT weight than that (bold text, etc.) has no real
          // heavier face to fall back to, so the browser synthesizes a
          // fake bold by algorithmically thickening the 400-weight
          // glyphs -- this is what actually causes a custom display font
          // to look blurry/smeared rather than crisp. `font-synthesis` is
          // inherited, so setting `none` once here (this overlay's own
          // font-weight usage is already all 400/normal, so nothing
          // visually changes today) blocks that synthesis for every
          // descendant, present or future, instead of needing to audit
          // every individual fontWeight value by hand.
          fontSynthesis: "none",
          // Transparent, not a solid fill -- explicit user request so
          // this overlay composites as a proper OBS browser source
          // (whatever's behind it in the OBS scene shows through the
          // padding/gaps between the header and rows, not a big opaque
          // rectangle). Used to be a translucent rgba() over a blurred
          // banner-image backdrop, then briefly a flat opaque
          // COLORS.panel once that backdrop was dropped -- safe to go
          // fully transparent at THIS level specifically because the
          // header panel and every row below already paint their own
          // opaque background for legibility (see this file's own
          // COLORS.panel/COLORS.currentBg usage further down), so this
          // only affects the empty space around/between them.
          background: "transparent",
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
              // bigger text inside an identically-sized shell. Uniform
              // now that the status badge is a normal flex child in the
              // day/clock column (see its own comment) instead of
              // position:absolute -- no extra bottom padding needed to
              // reserve room for it anymore.
              padding: 32,
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
                  fontSize: 50,
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
              {/* Train-station-board-style status -- operator-set (see
                  scheduleStatus/SCHEDULE_STATUS_LABELS above), always
                  shown once a day's selected. A normal flex child now,
                  directly below the clock in the same right-aligned
                  column, not position:absolute pinned to the header
                  panel's own bottom-right corner. */}
              <div
                style={{
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
                  background: blendOverBase(statusColor, 0.15),
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
          </div>
          {rows.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {rows.map((row, i) => (
                <ScheduleRow
                  // Prefixed with `day`, not just the index -- otherwise
                  // switching days doesn't remount a row at an index
                  // that existed under the OLD day too, it just updates
                  // it in place with the new day's data. That split rows
                  // into two groups with different, inconsistent
                  // behavior: an index reused across the switch treated
                  // it as a live update (its own time crossfade firing
                  // independently of, and out of sync with, the row's
                  // outer entrance animation), while only a genuinely
                  // new index (the new day having more rows than the
                  // old one had) got a clean fresh mount. Keying on the
                  // day makes every row a fresh mount on every switch,
                  // uniformly, so all of them play the exact same
                  // entrance with nothing left over from the previous
                  // day's instance.
                  key={`${day}-${i}`}
                  row={row}
                  index={i}
                  scheduleStatus={scheduleStatus}
                  entranceSettled={entranceSettled}
                  // Manual: exactly row.current/row.completed, same as
                  // always. Automatic: the row at autoStatus.currentIndex
                  // reads as current (only once something has actually
                  // started); every row before it reads as completed
                  // instead of being removed from the list.
                  current={isAutomatic ? i === autoStatus.currentIndex && autoStatus.started : !!row.current}
                  completed={isAutomatic ? autoStatus.started && i < autoStatus.currentIndex : !!row.completed}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
