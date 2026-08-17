import { BROADCAST_COLORS } from "./broadcast-theme";
import { TITLE_FONT_FAMILY, BODY_FONT_FAMILY } from "./local-fonts";

/**
 * The bordered, icon+title header bar shared by gauntlet-pools.tsx and
 * bracket-tree.tsx (the two views the merged "Bracket Overlay" switches
 * between, see gauntlet-pools.tsx's own GauntletPoolsOverlay) -- one
 * component specifically so the two can never independently drift out
 * of sync again. They used to: bracket-tree.tsx's own copy of this was
 * smaller than gauntlet-pools.tsx's (80px icon/44px title vs this
 * file's 100px/56px), a real, visible inconsistency between "the same
 * overlay, just showing different data" that this fixes for good.
 *
 * Not shared with schedule.tsx's own title bar -- that one has a whole
 * second column (day name, live clock, status badge) this doesn't need
 * to account for, a genuinely different shape rather than the same
 * thing independently drifting.
 */
export function BroadcastTitleBar({
  icon,
  title,
  subtitle,
}: {
  icon: string | null;
  title: string;
  /** The live, dynamic "what is this specifically" info the title
   * itself can't express (e.g. bracket-tree.tsx's phase.name) -- absent
   * renders nothing, same "optional means don't show it" idea used
   * everywhere else in these overlays. */
  subtitle?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 24,
        background: BROADCAST_COLORS.panel,
        border: "3px solid rgb(255, 255, 255)",
        borderRadius: 18,
        padding: "20px 32px",
      }}
    >
      {icon && (
        <img
          src={icon}
          alt=""
          style={{
            height: 100,
            width: "auto",
            maxWidth: 200,
            objectFit: "contain",
            borderRadius: 10,
            flexShrink: 0,
          }}
        />
      )}
      <div>
        <div
          style={{
            fontFamily: TITLE_FONT_FAMILY,
            fontSize: 56,
            color: BROADCAST_COLORS.text,
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div
            style={{
              fontFamily: BODY_FONT_FAMILY,
              fontSize: 20,
              color: BROADCAST_COLORS.muted,
              marginTop: 4,
            }}
          >
            {subtitle}
          </div>
        )}
      </div>
    </div>
  );
}
