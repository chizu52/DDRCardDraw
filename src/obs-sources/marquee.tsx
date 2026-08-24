import { useLayoutEffect, useState } from "react";

/** One fixed-shape cycle (pause at start / scroll out / pause at end /
 * fade out / snap back to start / fade in), shared by every marquee
 * instance across every overlay that uses one -- only animation-duration
 * and the --marquee-distance custom property vary per instance, so a
 * longer overflow gets a proportionally longer cycle at a roughly
 * constant scroll speed. Loops via a fade, not a scroll back the way it
 * came -- the "snap" at 82%/83% happens while opacity is already 0, so
 * it's invisible rather than a visible jump. The fade out/in spans
 * (78->82%, 83->87%) are half the width of the pauses either side of
 * them -- twice the speed -- so the reset between loops reads as quick
 * rather than lingering; the time that frees up rolls into the final
 * pause (87->100%) instead of shortening the cycle's own total duration.
 *
 * Originally schedule.tsx's own `scheduleMarqueeScroll`, extracted here
 * once a second overlay (pool-results.tsx) needed the identical shape.
 * schedule.tsx kept its own separate copy for a while after that (a
 * live refactor of an already-tuned, unrelated-to-that-request file
 * wasn't worth the risk just for DRYness at the time) -- since
 * retrofitted onto this shared version too, explicit user request to
 * make every overlay's overflow-text handling genuinely uniform, not
 * just share a keyframe shape three separate copies happened to agree
 * on. Works identically on plain HTML
 * elements (MarqueeText below) and on SVG elements (bracket-tree.tsx's
 * own hand-rolled clip-path version, which can't reuse MarqueeText
 * itself -- SVG has no `overflow: hidden` on an arbitrary box the way
 * HTML does -- but applies this exact same keyframe by name): CSS
 * `transform`/`opacity` animate the same way on both. */
export const MARQUEE_KEYFRAMES_CSS = `
@keyframes broadcastMarqueeScroll {
  0%, 10% { transform: translateX(0); opacity: 1; }
  70%, 78% { transform: translateX(var(--marquee-distance, 0px)); opacity: 1; }
  82% { transform: translateX(var(--marquee-distance, 0px)); opacity: 0; }
  83% { transform: translateX(0); opacity: 0; }
  87%, 100% { transform: translateX(0); opacity: 1; }
}
`;

/** The one canonical scroll speed/base-duration every marquee instance
 * across every overlay uses -- explicit user request to make overflow
 * text uniform everywhere, not just share the keyframe shape above.
 * Previously three different overlays had independently tuned their
 * own "looks about right" numbers (schedule.tsx: 70px/s + 3s;
 * pool-results.tsx: 60px/s + 2.5s; bracket-tree.tsx: 40 SVG-local-
 * units/s + 2s, which worked out to ~67 real screen px/s once scaled
 * up by that file's own SVG_SCALE) -- picked THESE two values as the
 * one target since pool-results.tsx (an HTML consumer, so its numbers
 * are real screen px with no unit-conversion question) already used
 * them. `duration = MARQUEE_BASE_DURATION_S + distance / MARQUEE_SPEED_PX_PER_S`
 * is each caller's own formula (not baked in here, since bracket-
 * tree.tsx's SVG version needs to convert this into its own local
 * units via its own SVG_SCALE first -- see that file's own
 * NAME_MARQUEE_SPEED_UNITS_PER_S). */
export const MARQUEE_SPEED_PX_PER_S = 60;
export const MARQUEE_BASE_DURATION_S = 2.5;

/** Single-line, overflow:hidden text that scrolls only when its content
 * is actually too wide for the row -- left completely static otherwise,
 * so a short value never animates for no reason. Loops via a fade (see
 * MARQUEE_KEYFRAMES_CSS's own comment), not a scroll back the way it
 * came.
 *
 * Measurement (boxRef/contentRef/distance) and the animation's own
 * `duration` are owned by the CALLER, not this component -- a caller
 * with several marquee'd values in one row (schedule.tsx's own
 * event+description pair, originally) may want them all sharing ONE
 * duration (from whichever needs more time) so their cycles restart in
 * sync, rather than each computing its own independently and drifting
 * apart. Pass `useMarqueeDistances`' own output straight through. */
export function MarqueeText({
  boxRef,
  contentRef,
  distance,
  duration,
  children,
  style,
}: {
  boxRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  distance: number;
  duration: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div ref={boxRef} style={{ overflow: "hidden", whiteSpace: "nowrap" }}>
      <div
        ref={contentRef}
        style={{
          display: "inline-block",
          ...(distance > 0
            ? ({
                "--marquee-distance": `-${distance}px`,
                animation: `broadcastMarqueeScroll ${duration}s ease-in-out infinite`,
              } as React.CSSProperties)
            : null),
          ...style,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Measures scrollWidth against clientWidth for however many boxes are
 * given, keyed by whatever key the caller wants back -- shared by every
 * MarqueeText in one logical group (e.g. one row) so their durations can
 * be derived from the SAME max-distance instead of each computing its
 * own independently (see MarqueeText's own doc). Re-measures on resize
 * and once every @font-face has actually finished loading -- a
 * still-loading custom font measures against whatever fallback font is
 * showing in the meantime, which can be a meaningfully different width
 * once the real one swaps in. */
export function useMarqueeDistances(
  boxes: {
    key: string;
    boxRef: React.RefObject<HTMLDivElement | null>;
    contentRef: React.RefObject<HTMLDivElement | null>;
  }[],
  deps: unknown[],
): Map<string, number> {
  const [distances, setDistances] = useState<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    // `.current` read HERE, inside the effect body -- not while building
    // the `boxes` array up in the render body above, where refs haven't
    // attached to their real DOM nodes yet (a real bug, found live in
    // this hook's original schedule.tsx incarnation: every row's own
    // marquee silently never animated, since that render-time read
    // always saw null and this effect's deps never gave it a reason to
    // re-run once text stopped changing).
    const present = boxes
      .map(({ key, boxRef, contentRef }) => ({
        key,
        box: boxRef.current,
        content: contentRef.current,
      }))
      .filter(
        (b): b is { key: string; box: HTMLDivElement; content: HTMLDivElement } =>
          !!b.box && !!b.content,
      );
    if (!present.length) return;
    const measure = () => {
      const next = new Map<string, number>();
      for (const { key, box, content } of present) {
        const overflow = content.scrollWidth - box.clientWidth;
        next.set(key, overflow > 0 ? overflow : 0);
      }
      // eslint-disable-next-line react-hooks-js/set-state-in-effect
      setDistances(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const { box } of present) observer.observe(box);
    void document.fonts.ready.then(measure);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `boxes` is
    // a fresh array/refs every render by construction; `deps` is the
    // caller's own stand-in for "the actual text content changed."
  }, deps);

  return distances;
}
