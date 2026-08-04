import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

// OBS browser sources are commonly set to a fixed 1920x1080 canvas -- a
// tall/wide overlay (a bracket with many rounds, a long schedule list)
// can easily exceed that at natural size, so this scales the whole thing
// down to fit (never up -- a small overlay just sits at its natural
// size) rather than letting OBS clip it. Measures via offsetWidth/Height,
// not getBoundingClientRect, because the latter reports the
// POST-transform (already-scaled) size once a scale is applied, which
// would make the scale calculation reference its own prior output
// instead of the content's real natural size. Shared by every overlay
// that needs this (bracket-tree.tsx, schedule.tsx) rather than each
// reimplementing its own copy.
const OBS_CANVAS_WIDTH = 1920;
const OBS_CANVAS_HEIGHT = 1080;
export function FitTo1080({ children }: { children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w === 0 || h === 0) return;
      setScale(Math.min(1, OBS_CANVAS_WIDTH / w, OBS_CANVAS_HEIGHT / h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      style={{
        width: OBS_CANVAS_WIDTH,
        height: OBS_CANVAS_HEIGHT,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        ref={contentRef}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
    </div>
  );
}
