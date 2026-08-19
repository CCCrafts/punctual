/**
 * Design tokens and page CSS.
 *
 * Inlined rather than served as a file, deliberately: the §7 budget is a <1 s
 * full load on mobile 4G with the whole page under 80 KB gzip, and a separate
 * stylesheet costs a round trip that a few KB of inline CSS does not. That
 * budget is HTML+CSS+JS only (spec §7); fonts are their own resource class —
 * fetched async, `font-display: swap` never blocks first paint on them, and a
 * returning visitor pays the ~120 KB combined cost once, cached long past any
 * single page's byte budget.
 *
 * Tokens mirror docs/branding/assets/tokens.css. The three brand faces are
 * self-hosted OFL files under assets/fonts/ (see FONT_FACES below) — vendored
 * at build time from Google Fonts' own CDN rather than called at runtime, so
 * a visitor's request never leaves punctual's origin. System stacks stay
 * listed after each brand face as the `font-display: swap` fallback while the
 * real face loads, and as the total fallback if a self-hoster ever strips
 * assets/fonts/ from their deploy.
 */

/**
 * `unicode-range` scoped to Latin (spec: English everywhere) so a browser
 * never fetches a font file to render a codepoint punctual doesn't ship
 * copy in. Weights match what BASE_CSS/LANDING_CSS actually set — no spare
 * weights riding along unused.
 */
export const FONT_FACES = `
@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:400;font-display:swap;
  src:url(/fonts/ibmplexmono-400.woff2) format("woff2");
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:600;font-display:swap;
  src:url(/fonts/ibmplexmono-600.woff2) format("woff2");
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"IBM Plex Mono";font-style:normal;font-weight:700;font-display:swap;
  src:url(/fonts/ibmplexmono-700.woff2) format("woff2");
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Inter";font-style:normal;font-weight:400 700;font-display:swap;
  src:url(/fonts/inter-variable.woff2) format("woff2");
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Schibsted Grotesk";font-style:normal;font-weight:600;font-display:swap;
  src:url(/fonts/schibstedgrotesk-600.woff2) format("woff2");
  unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
`

export const TOKENS = `
:root{
  --pu-ink-950:#0F1512; --pu-ink-900:#17201B; --pu-ink-700:#2E3B34;
  --pu-ink-500:#5C6660; --pu-paper:#FAFAF7; --pu-paper-dim:#F0F1EC;
  --pu-line:#E3E5DE; --pu-green-700:#0E7C4C; --pu-green-800:#0A5C3A;
  --pu-signal:#1FC16B; --pu-green-tint:#E4F5EC; --pu-danger:#D92D20;
  --pu-danger-800:#B8241A; --pu-danger-text:#D92D20; --pu-danger-tint:#FBEAE8;
  /* A solid green fill behind white/paper text (buttons, the chosen-slot dot,
     step numbers) needs to stay this dark in EITHER theme — unlike
     --pu-green-700/800, deliberately NOT redefined under dark mode below.
     --pu-green-700 brightens in dark mode because it also serves as body
     text/links there, where it must read against a dark page background;
     that same brightening drops a filled button's white-on-green contrast
     to ~2.4:1 (fails WCAG AA) if it shares the token. Same shades as
     light mode's green-700/800 — those already pass comfortably (5.2:1). */
  --pu-green-fill:#0E7C4C; --pu-green-fill-hover:#0A5C3A;
  /* Warn — added for the semantic layer below. Fill/border stays one
     value across themes, same discipline as --pu-green-fill above; a
     separate -text variant is redefined per theme below because #F5A623
     itself is ~1.9:1 on light paper (fine as a small border/icon, fails AA
     as text) and ~9:1 on dark paper (fine either way), so light mode needs a
     darkened amber for readable text while dark mode can stay near the
     brand hue. */
  --pu-warn:#F5A623; --pu-warn-text:#92400E; --pu-warn-tint:#FCEFD9;
  --pu-font-display:"Schibsted Grotesk",system-ui,-apple-system,sans-serif;
  --pu-font-ui:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
  --pu-font-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --pu-radius:10px; --pu-radius-lg:16px;
  --pu-shadow-sm:0 1px 2px rgba(15,21,18,.06);
  --pu-ring:0 0 0 3px color-mix(in srgb,var(--pu-green-700) 25%,transparent);
  /* Code blocks (docs pages): deliberately NOT redefined under the dark-mode
     media query or [data-theme=dark] below — a code panel that's always a
     dark "terminal" surface reads clearly against either a light or dark
     page background, which is simpler and more reliable than trying to keep
     a code block's syntax contrast correct across two flipped palettes. */
  --pu-code-bg:#0F1512; --pu-code-fg:#E7F2EA; --pu-code-line:#2E3B34;

  /* ---------------------------------------------------------------------
   * Semantic layer. Product UI states, one level above the raw
   * palette above — components should reach for these, not for
   * --pu-ink-*, --pu-green-*, --pu-danger or --pu-warn directly, so a future
   * repaint of the brand only ever touches this block.
   *
   * Every value here is a var() onto a primitive already defined above
   * (or, where a state needs a light/dark-specific reading and the flipped
   * primitive doesn't fit, a literal redefined per theme below — never a
   * color that exists ONLY inside a dark-mode block).
   * ------------------------------------------------------------------- */

  /* Surface: canvas < raised < sunken, by how far off the base page a thing
     sits. "raised" is the same fill as canvas on light (elevation reads via
     --pu-shadow-sm/border, exactly how .pu-card already works) but goes
     lighter than canvas in dark mode below, because a drop shadow barely
     reads against a near-black page — dark-mode elevation has to come from
     value contrast instead. "overlay" is new: nothing in the product uses a
     modal/backdrop yet, but a scrim still needs to read as "a wash over
     content" on either theme, so it is a plain ink-tinted rgba() in light
     mode and a plain black rgba() in dark mode below — not composed from
     any other token, since nothing else in the palette is meant to be used
     at partial opacity over arbitrary content. */
  --pu-surface-canvas:var(--pu-paper);
  --pu-surface-raised:var(--pu-paper);
  --pu-surface-sunken:var(--pu-paper-dim);
  --pu-surface-overlay:rgba(15,21,18,.45);

  /* Text: primary/secondary track --pu-ink-950/--pu-ink-500 verbatim — they
     already flip for dark mode below the same way. "muted" and "disabled"
     are new, both ink-500 with alpha baked in (not the bare token plus a
     sibling opacity rule) so a single custom property is the full color
     in either theme. "disabled" alpha (.45) matches the treatment
     .pu-day[aria-disabled] already shipped; "muted" (.72) is one step above
     it — dim enough to read as decoration, e.g. table timestamps, not body
     copy — deliberately sub-AA at 3.2:1 (large-text tier only), same trade
     already accepted for e.g. .pu-cal-head. */
  --pu-text-primary:var(--pu-ink-950);
  --pu-text-secondary:var(--pu-ink-500);
  --pu-text-muted:rgba(92,102,96,.72);
  --pu-text-on-accent:#FFFFFF;
  --pu-text-disabled:rgba(92,102,96,.45);

  /* Border: subtle = --pu-line's existing job. strong = a border with more
     presence than a hairline but no status meaning (e.g. a divider that
     needs to read on its own, not next to a card's shadow) — set to
     --pu-ink-500 rather than a new hex, so "strong border" and "secondary
     text" are always the same value by construction. focus reuses
     --pu-green-700, matching :focus-visible's existing outline color below
     — a11y focus indication is expected to borrow the accent; that is a
     different thing from rule 1's "system states don't get the accent",
     which is about background/fill states like held/booked, not the
     global focus ring. */
  --pu-border-subtle:var(--pu-line);
  --pu-border-strong:var(--pu-ink-500);
  --pu-border-focus:var(--pu-green-700);

  /* Status: independent decisions, not aliases of whatever the marketing
     palette (docs/branding/assets/tokens.css) happens to alias.
     - success reuses --pu-green-700, NOT --pu-signal. --pu-signal is a
       fixed, always-vivid accent meant for a small dot (the wordmark colon,
       a status pip) and is never contrast-managed for use as text — using
       it here would mean unreadable status text the day someone sets it as
       a label color. --pu-green-700 already does the light/dark contrast
       flip a status text color needs (5.0:1 light, 7.8:1 dark — see
       styles.ts's own note above on why fills stay pinned but this token
       doesn't).
     - danger/warning follow the same shape: a text-safe color plus a light
       tint for a badge/callout background.
     - info deliberately has NO owned hue. The brand system is one green +
       conventional danger/warn — a blue "info" would be a hue the
       brand doesn't own and no page currently needs one. .pu-docs-callout
       already renders informational asides in neutral ink-on-sunken-surface
       with no color at all; --pu-status-info/-bg codify that as the
       intentional choice rather than leaving it undocumented. */
  --pu-status-success:var(--pu-green-700);
  --pu-status-success-bg:var(--pu-green-tint);
  --pu-status-danger:var(--pu-danger-text);
  --pu-status-danger-bg:var(--pu-danger-tint);
  --pu-status-warning:var(--pu-warn-text);
  --pu-status-warning-bg:var(--pu-warn-tint);
  --pu-status-info:var(--pu-text-secondary);
  --pu-status-info-bg:var(--pu-surface-sunken);

  /* Slot: the booking flow's own state machine (see src/core/slot-state.ts).
     Rule: held/booked are visually distinct from available
     WITHOUT the accent — the accent is the guest's own current pick
     (hover/selected), never a system state. held borrows the warning hue
     (in flux, someone else is mid-booking, may free up); booked borrows the
     neutral surface/border family (settled, permanently gone — distinct
     hue from held on purpose, so the two read as different kinds of
     unavailable, not different intensities of the same one). past and
     outside-notice-window are both neutral too, and stay distinguishable
     from booked and each other structurally (see .pu-slot-past/
     .pu-slot-outside-notice border-style/opacity in BASE_CSS below), not
     just by color, so the distinction survives greyscale. */
  --pu-slot-available-bg:var(--pu-surface-raised);
  --pu-slot-available-border:var(--pu-border-subtle);
  --pu-slot-available-text:var(--pu-text-primary);
  --pu-slot-hover-bg:var(--pu-green-tint);
  --pu-slot-hover-border:var(--pu-green-700);
  --pu-slot-hover-text:var(--pu-text-primary);
  --pu-slot-selected-bg:var(--pu-green-tint);
  --pu-slot-selected-border:var(--pu-green-700);
  --pu-slot-selected-text:var(--pu-text-primary);
  --pu-slot-held-bg:var(--pu-warn-tint);
  --pu-slot-held-border:var(--pu-warn);
  --pu-slot-held-text:var(--pu-warn-text);
  --pu-slot-booked-bg:var(--pu-surface-sunken);
  --pu-slot-booked-border:var(--pu-border-subtle);
  --pu-slot-booked-text:var(--pu-text-disabled);
  --pu-slot-past-bg:var(--pu-surface-canvas);
  --pu-slot-past-border:transparent;
  --pu-slot-past-text:var(--pu-text-muted);
  --pu-slot-outside-notice-bg:var(--pu-surface-raised);
  --pu-slot-outside-notice-border:var(--pu-border-subtle);
  --pu-slot-outside-notice-text:var(--pu-text-muted);
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme=light]){
    --pu-paper:#0F1512; --pu-paper-dim:#17201B; --pu-line:#2E3B34;
    --pu-ink-950:#FAFAF7; --pu-ink-500:#9AA5A0; --pu-green-700:#1FC16B;
    --pu-green-800:#3ED486; --pu-green-tint:#153A28; --pu-danger-text:#FF6B5B;
    --pu-danger-tint:#3A1A16; --pu-warn-text:#FBBF24; --pu-warn-tint:#3A2C12;
    --pu-shadow-sm:0 1px 2px rgba(0,0,0,.4);
    --pu-surface-raised:#17201B;
    --pu-text-muted:rgba(154,165,160,.72); --pu-text-disabled:rgba(154,165,160,.45);
    --pu-surface-overlay:rgba(0,0,0,.6);
  }
}
:root[data-theme=dark]{
  --pu-paper:#0F1512; --pu-paper-dim:#17201B; --pu-line:#2E3B34;
  --pu-ink-950:#FAFAF7; --pu-ink-500:#9AA5A0; --pu-green-700:#1FC16B;
  --pu-green-800:#3ED486; --pu-green-tint:#153A28; --pu-danger-text:#FF6B5B;
  --pu-danger-tint:#3A1A16; --pu-warn-text:#FBBF24; --pu-warn-tint:#3A2C12;
  --pu-shadow-sm:0 1px 2px rgba(0,0,0,.4);
  --pu-surface-raised:#17201B;
  --pu-text-muted:rgba(154,165,160,.72); --pu-text-disabled:rgba(154,165,160,.45);
  --pu-surface-overlay:rgba(0,0,0,.6);
}
`

/**
 * Design notes (kept here, not as comments inside the template literal below,
 * because every byte inside BASE_CSS ships in the response):
 *
 * - .pu-event-header has no card box: it leads the page, the calendar/slot
 *   cards below it are the task.
 * - Calendar availability and "today" are both marked by shape + weight, not
 *   colour alone — a dot under the number for bookable days, a bar above it
 *   for today — so the distinction survives greyscale/colour-blind viewing.
 * - .pu-slot-chosen is a static echo of the slot picker on the confirm page:
 *   the picker itself has no persisted "selected" state because each slot is
 *   a navigation, not a client-side selection (no JS on this page).
 * - input/select/textarea get a red border via :has(+ .pu-err) — CSS-only,
 *   no per-field error class needed from the route.
 * - .pu-confirm-icon is the brand mark verbatim (the "dot at twelve" ring
 *   from docs' mark.svg: bold arc open at twelve, the dot landed in the
 *   gap = arrived on time). Same geometry, not a redraw — the ring is
 *   currentColor so it flips with the theme; only the dot is green.
 */
export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--pu-surface-canvas);color:var(--pu-text-primary);
  font-family:var(--pu-font-ui);line-height:1.5;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--pu-font-display);font-weight:600;line-height:1.2;margin:0 0 .5rem}
h1{font-size:1.5rem} h2{font-size:1.125rem} h3{font-size:1rem}
p{margin:0 0 .75rem}
a{color:var(--pu-green-700)}
time,.pu-time{font-family:var(--pu-font-mono);font-variant-numeric:tabular-nums}
::selection{background:var(--pu-green-tint);color:var(--pu-green-800)}

.pu-wrap{max-width:900px;margin:0 auto;padding:1.5rem 1rem 4rem}
.pu-card{background:var(--pu-surface-raised);border:1px solid var(--pu-border-subtle);
  border-radius:var(--pu-radius-lg);padding:1.375rem;box-shadow:var(--pu-shadow-sm)}
.pu-muted{color:var(--pu-text-secondary)}
/* Host identity block atop a booking page — a person, not a label, so the
   name is set in the display face at text size (never uppercase/tracked:
   this is who the guest is meeting, not a section heading). The company gets
   its own muted line rather than a comma splice, so the two facts read at
   different weights the way they matter differently. */
.pu-host{display:flex;align-items:center;gap:.875rem;margin:0 0 1.25rem}
.pu-host-name{margin:0;font-family:var(--pu-font-display);font-size:1.0625rem;
  font-weight:600;line-height:1.3;color:var(--pu-text-primary)}
.pu-host-org{margin:.1rem 0 0;font-size:.875rem;line-height:1.35;color:var(--pu-text-secondary)}
.pu-mark{font-family:var(--pu-font-mono);font-weight:600;letter-spacing:-.02em;
  text-decoration:none;color:var(--pu-text-primary)}
.pu-mark span{color:var(--pu-signal)}

.pu-grid{display:grid;gap:1.5rem;grid-template-columns:1fr}
@media(min-width:780px){.pu-grid{grid-template-columns:300px 1fr}}

.pu-event-header{padding:0 0 1.5rem;margin:0 0 1.5rem;border-bottom:1px solid var(--pu-line)}
.pu-event-header h1{font-size:1.75rem;margin:0 0 .5rem}
.pu-event-header .pu-meta{margin-top:.85rem}

.pu-cal{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.pu-cal-head{font-size:.75rem;font-weight:600;text-align:center;color:var(--pu-text-secondary);padding:.25rem 0}
.pu-day{position:relative;aspect-ratio:1;display:flex;align-items:center;justify-content:center;
  border:1px solid transparent;border-radius:var(--pu-radius);background:none;
  font:inherit;font-family:var(--pu-font-mono);font-size:.9375rem;cursor:pointer;
  color:var(--pu-text-primary);text-decoration:none;transition:all .12s ease}
.pu-day[data-has-slots="1"]{background:var(--pu-green-tint);color:var(--pu-green-700);font-weight:700}
.pu-day[aria-disabled="true"]{color:var(--pu-text-disabled);cursor:default}
.pu-day[aria-current="date"]{box-shadow:inset 0 0 0 2px var(--pu-border-focus);font-weight:700}
.pu-day:hover[data-has-slots="1"]{background:var(--pu-green-700);color:var(--pu-paper);transform:translateY(-1px)}
.pu-day:focus-visible,.pu-slot:focus-visible,.pu-btn:focus-visible{
  outline:2px solid var(--pu-border-focus);outline-offset:2px}
input:focus-visible,select:focus-visible,textarea:focus-visible{
  outline:2px solid var(--pu-border-focus);outline-offset:1px;box-shadow:var(--pu-ring)}

.pu-slots{display:grid;gap:.625rem;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));
  max-height:60vh;overflow-y:auto;padding:2px}
/* Base .pu-slot is layout/typography only — every color comes from the
   .pu-slot-* state modifier (see src/core/slot-state.ts's
   slotStateClassName, which always pairs "pu-slot" with exactly one of
   these) so a slot's appearance is never a color chosen ad hoc at a call
   site. */
.pu-slot{padding:.75rem .5rem;border:1px solid var(--pu-line);border-radius:var(--pu-radius);
  font-family:var(--pu-font-mono);font-size:.9375rem;font-weight:600;
  text-align:center;text-decoration:none;display:block;transition:all .12s ease}
.pu-slot-available{background:var(--pu-slot-available-bg);border-color:var(--pu-slot-available-border);
  color:var(--pu-slot-available-text);cursor:pointer}
.pu-slot-available:hover{background:var(--pu-slot-hover-bg);border-color:var(--pu-slot-hover-border);
  color:var(--pu-slot-hover-text);box-shadow:var(--pu-shadow-sm);transform:translateY(-1px)}
.pu-slot-available:active{background:var(--pu-green-fill);border-color:var(--pu-green-fill);
  color:var(--pu-text-on-accent);transform:translateY(0)}
.pu-slot-selected{background:var(--pu-slot-selected-bg);border-color:var(--pu-slot-selected-border);
  color:var(--pu-slot-selected-text)}
/* held/booked/past/outside-notice-window are never links (see
   isInteractiveSlotState) — cursor/pointer-events say so even if a caller
   ever renders one as an <a> by mistake. Distinguished from each other by
   more than hue alone: held keeps a solid border (still "there", just not
   yours to take right now), booked adds a strikethrough on the time
   (settled, gone), past drops its border to blend into the canvas and dims
   further (simply elapsed, nothing to look at), outside-notice-window
   keeps a full card but switches to a dashed border (exists, just not
   bookable yet) — so the four read as different reasons, not four
   opacities of the same greyed-out slot. */
.pu-slot-held,.pu-slot-booked,.pu-slot-past,.pu-slot-outside-notice{cursor:not-allowed;pointer-events:none}
.pu-slot-held{background:var(--pu-slot-held-bg);border-color:var(--pu-slot-held-border);
  color:var(--pu-slot-held-text)}
.pu-slot-booked{background:var(--pu-slot-booked-bg);border-color:var(--pu-slot-booked-border);
  color:var(--pu-slot-booked-text)}
.pu-slot-booked time{text-decoration:line-through}
.pu-slot-past{background:var(--pu-slot-past-bg);border-color:var(--pu-slot-past-border);
  color:var(--pu-slot-past-text);opacity:.7}
.pu-slot-outside-notice{background:var(--pu-slot-outside-notice-bg);
  border-color:var(--pu-slot-outside-notice-border);border-style:dashed;
  color:var(--pu-slot-outside-notice-text)}

.pu-slot-chosen{display:flex;align-items:center;gap:.75rem;margin:0 0 1.25rem;
  padding:.85rem 1rem;border:1px solid var(--pu-slot-selected-border);border-radius:var(--pu-radius);
  background:var(--pu-slot-selected-bg)}
.pu-slot-chosen .pu-dot-lg{flex:0 0 auto;width:.65rem;height:.65rem;border-radius:99px;
  background:var(--pu-green-700)}

.pu-btn{display:inline-block;padding:.7rem 1.1rem;border-radius:var(--pu-radius);
  background:var(--pu-green-fill);color:var(--pu-text-on-accent);border:1px solid var(--pu-green-fill);
  font:inherit;font-weight:600;cursor:pointer;text-decoration:none;text-align:center;
  transition:all .12s ease}
.pu-btn:hover{background:var(--pu-green-fill-hover);border-color:var(--pu-green-fill-hover)}
.pu-btn[disabled]{opacity:.6;cursor:default}
.pu-btn-ghost{background:none;color:var(--pu-text-primary);border-color:var(--pu-border-subtle)}
.pu-btn-ghost:hover{background:var(--pu-surface-sunken);border-color:var(--pu-border-strong);color:var(--pu-text-primary)}
/* --pu-danger, not --pu-status-danger: a solid fill behind white text needs
   the same "pinned across themes" treatment as --pu-green-fill above —
   --pu-status-danger tracks --pu-danger-text, which deliberately brightens
   in dark mode for readability as TEXT and would drop this button's
   white-on-fill contrast the same way sharing --pu-green-700 would have. */
.pu-btn-danger{background:var(--pu-danger);border-color:var(--pu-danger);color:var(--pu-text-on-accent)}
.pu-btn-danger:hover{background:var(--pu-danger-800);border-color:var(--pu-danger-800)}

label{display:block;font-size:.875rem;font-weight:600;margin:1rem 0 .35rem}
input,select,textarea{width:100%;padding:.65rem .75rem;border:1px solid var(--pu-line);
  border-radius:var(--pu-radius);background:var(--pu-paper);color:var(--pu-ink-950);
  font:inherit;transition:border-color .12s ease}
textarea{min-height:5rem;resize:vertical}
input:has(+ .pu-err),select:has(+ .pu-err),textarea:has(+ .pu-err){border-color:var(--pu-status-danger)}
.pu-err{display:flex;align-items:flex-start;gap:.4rem;color:var(--pu-status-danger);
  font-size:.8125rem;margin:.4rem 0 0}
.pu-err::before{content:"!";flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
  width:1rem;height:1rem;margin-top:.0625rem;border-radius:99px;background:var(--pu-danger);
  color:var(--pu-text-on-accent);font-size:.6875rem;font-weight:700;line-height:1}
/* A standing caution, not a one-line field error — normal block text flow
   (not .pu-err's flex layout, which mangles a multi-sentence paragraph with
   inline <code> into separate flex items) with its own visual weight. */
.pu-callout{background:var(--pu-status-danger-bg);border:1px solid var(--pu-danger);
  border-radius:var(--pu-radius);padding:.75rem 1rem;font-size:.875rem;color:var(--pu-text-primary)}
.pu-badge{display:inline-block;padding:.15rem .5rem;border-radius:99px;font-size:.75rem;
  background:var(--pu-status-success-bg);color:var(--pu-status-success);font-weight:600}
.pu-dot{display:inline-block;width:.5rem;height:.5rem;border-radius:99px;
  background:var(--pu-signal);vertical-align:middle}
/* align-items:center, not the default stretch: the timezone control is a
   bordered box taller than the text items, and without centering every
   plain-text item top-aligns against it — the whole line reads crooked. */
.pu-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1rem;font-size:.875rem;color:var(--pu-text-secondary);
  list-style:none;padding:0;margin:.5rem 0 0}
.pu-tz-form{display:inline-flex;align-items:center;max-width:100%}
/* A real control, not dotted-underline text a guest never notices is
   interactive: one bordered block — globe, zone, offset, chevron — on the
   system radius, not a pill (nothing else on the page is a pill). The
   border and focus state live on the WRAP so all four pieces read as a
   single control; the select inside is borderless and sized to the selected
   zone's name server-side (a bare <select> is otherwise as wide as its
   widest option, leaving dead space before the chevron). The chevron is a
   CSS-drawn corner, not a data-URI image, so it takes its color from a
   token and stays correct in both themes. Focus is shown by border color
   plus the shared input ring — an outline on top of a border reads as a
   clumsy double ring (and Chrome applies :focus-visible to selects even on
   mouse click).*/
.pu-tz-wrap{position:relative;display:inline-flex;align-items:center;max-width:100%;
  border:1px solid var(--pu-border-subtle);border-radius:var(--pu-radius);
  background:var(--pu-surface-raised);transition:border-color .12s ease}
.pu-tz-wrap:hover{border-color:var(--pu-border-strong)}
.pu-tz-wrap:focus-within{border-color:var(--pu-border-focus);box-shadow:var(--pu-ring)}
.pu-tz-globe{position:absolute;left:.6rem;color:var(--pu-text-secondary);pointer-events:none}
.pu-tz-wrap::after{content:"";position:absolute;right:.7rem;top:50%;width:.4rem;height:.4rem;
  border-right:1.5px solid var(--pu-text-secondary);border-bottom:1.5px solid var(--pu-text-secondary);
  transform:translateY(-70%) rotate(45deg);pointer-events:none}
.pu-tz-select{appearance:none;-webkit-appearance:none;max-width:100%;min-width:0;
  padding:.3rem 0 .3rem 2rem;border:0;border-radius:var(--pu-radius);outline:none;
  background:transparent;color:var(--pu-text-primary);font:inherit;font-size:.875rem;
  cursor:pointer;text-overflow:ellipsis}
/* Outranks the global select:focus-visible ring — focus indication for this
   control is the wrap's :focus-within border+ring above, and both firing at
   once is the double-ring this replaced. */
.pu-tz-select:focus-visible{outline:none;box-shadow:none}
.pu-tz-offset{padding:0 1.7rem 0 .5rem;font-size:.8125rem;color:var(--pu-text-secondary);
  white-space:nowrap;pointer-events:none}

.pu-confirm{text-align:center;padding:2rem 1.5rem}
.pu-confirm-icon{display:block;margin:0 auto .75rem;color:var(--pu-text-primary)}
.pu-ring-arc{stroke:currentColor}
.pu-ring-dot{fill:var(--pu-signal)}
.pu-confirm h1{margin:.15rem 0 .35rem}
.pu-confirm-details{text-align:left;list-style:none;margin:1.25rem 0;padding:1rem 1.25rem;
  background:var(--pu-surface-sunken);border-radius:var(--pu-radius);display:grid;gap:.6rem}
.pu-confirm-details div{display:flex;justify-content:space-between;align-items:baseline;
  gap:1rem;flex-wrap:wrap}
.pu-confirm-details dt{color:var(--pu-text-secondary);font-size:.8125rem;font-weight:600;margin:0}
.pu-confirm-details dd{margin:0;text-align:right}

.pu-nav-link{text-decoration:none;color:var(--pu-text-secondary);font-weight:500;
  padding:.35rem 0;border-bottom:2px solid transparent}
.pu-nav-link:hover{color:var(--pu-text-primary)}
.pu-nav-link[aria-current="page"]{color:var(--pu-text-primary);font-weight:600;
  border-bottom-color:var(--pu-green-700)}
.pu-dash-header{border-bottom:1px solid var(--pu-line);padding-bottom:1rem}
/* Narrow enough that the nav's own wrapping (5 links) collides with the
   header's justify-content:space-between — one link stranded on its own row
   with the sign-out button, uneven gaps either side. Stacking the three
   header children instead of trying to keep them in one wrapping row reads
   as intentional rather than as an overflow accident. */
@media(max-width:480px){
  .pu-dash-header{flex-direction:column;align-items:flex-start}
}

.pu-url{display:flex;align-items:center;gap:.5rem;background:var(--pu-surface-sunken);
  border:1px solid var(--pu-line);border-radius:var(--pu-radius);padding:.15rem .15rem .15rem .8rem}
.pu-url-input{flex:1;min-width:0;border:0;background:none;padding:.5rem 0;
  font-family:var(--pu-font-mono);font-size:.8125rem;color:var(--pu-text-primary);cursor:pointer}
/* Fixed width, so "Copy" -> "Copied" feedback doesn't shift the layout. */
.pu-copy{flex:none;min-width:4.5rem;padding:.4rem .6rem;font-size:.8125rem}

.pu-skeleton{height:2.4rem;border-radius:var(--pu-radius);background:var(--pu-surface-sunken);
  animation:pu-pulse 1.2s ease-in-out infinite}
@keyframes pu-pulse{50%{opacity:.55}}
.pu-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.pu-foot{margin-top:2.5rem;font-size:.8125rem;color:var(--pu-text-secondary);text-align:center}

@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;
    transition-duration:.01ms!important;scroll-behavior:auto!important}
  .pu-day:hover[data-has-slots="1"],.pu-slot-available:hover,.pu-slot-available:active{transform:none}
}
`

export function pageCss(): string {
  return FONT_FACES + TOKENS + BASE_CSS
}

/**
 * Landing and docs-index page only. Kept separate from BASE_CSS so the
 * booking page — the one that actually needs to hit the <80 KB budget on
 * every request — never pays for marketing-page rules it doesn't use.
 */
export const LANDING_CSS = `
.pu-landing{max-width:1120px;margin:0 auto;padding:0 1.25rem 4rem}
.pu-hero{padding:3.5rem 0 3rem;text-align:center}
.pu-hero .pu-mark{font-size:1.125rem}
.pu-hero .pu-mark span{display:inline-block;animation:pu-colon-land .5s cubic-bezier(.34,1.56,.64,1) both}
.pu-hero-clock{color:var(--pu-ink-500);opacity:0}
.pu-hero-clock.pu-in{animation:pu-clock-in .4s ease-out .5s forwards}
@keyframes pu-colon-land{
  0%{transform:translateY(-10px) scale(.6);opacity:0}
  55%{transform:translateY(2px) scale(1.15);opacity:1}
  100%{transform:translateY(0) scale(1);opacity:1}
}
@keyframes pu-clock-in{
  0%{opacity:0;transform:translateY(-4px)}
  100%{opacity:1;transform:translateY(0)}
}
@media(prefers-reduced-motion:reduce){
  .pu-hero .pu-mark span{animation:none}
  .pu-hero-clock.pu-in{animation:none;opacity:1}
}
.pu-hero h1{font-family:var(--pu-font-display);font-size:clamp(1.75rem,4vw + 1rem,2.75rem);
  margin:1.25rem 0 1rem}
.pu-hero-lede{font-size:1.125rem;color:var(--pu-ink-500);max-width:34rem;margin:0 auto 2rem}
.pu-hero-cta{display:flex;gap:.75rem;justify-content:center;flex-wrap:wrap}

.pu-landing section{margin:3.5rem 0}
.pu-section-head{text-align:center;max-width:38rem;margin:0 auto 1.75rem}
.pu-section-head h2{font-size:1.375rem}

.pu-pledge{background:var(--pu-green-tint);border-color:var(--pu-green-700);
  text-align:center;padding:2.25rem 1.5rem}
.pu-pledge h2{color:var(--pu-green-800)}
.pu-pledge p{font-size:1.125rem;max-width:40rem;margin:0 auto;color:var(--pu-ink-950)}

.pu-live-demo{margin-top:2.5rem}
.pu-embed-frame{max-width:560px;margin:0 auto;padding:.75rem}
.pu-embed-frame iframe{border-radius:calc(var(--pu-radius-lg) - .5rem)}

.pu-feature-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.pu-feature-grid .pu-stat{display:block;font-family:var(--pu-font-mono);font-weight:700;
  color:var(--pu-green-700);font-size:1.125rem;margin-bottom:.35rem}

.pu-steps{display:grid;gap:1.5rem 1.25rem;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));
  list-style:none;padding:0;margin:0;counter-reset:pu-step}
.pu-steps li{counter-increment:pu-step;padding-top:2.75rem;position:relative}
.pu-steps li::before{content:counter(pu-step);position:absolute;top:0;left:0;
  width:2rem;height:2rem;border-radius:99px;background:var(--pu-green-fill);color:#fff;
  display:flex;align-items:center;justify-content:center;font-family:var(--pu-font-mono);
  font-weight:700;font-size:.875rem}

.pu-compare{display:grid;gap:1.25rem;grid-template-columns:1fr}
@media(min-width:700px){.pu-compare{grid-template-columns:1fr 1fr}}
.pu-compare .pu-card{display:flex;flex-direction:column;gap:.25rem}
.pu-compare h3{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.pu-compare ul{padding-left:1.1rem;margin:.5rem 0}
.pu-compare li{margin-bottom:.4rem}

.pu-compare-table-wrap{overflow-x:auto}
/* The wrapper scrolling is invisible unless the reader already knows to try
   it — on a narrow phone the Calendly column sits entirely off-screen with
   no visual cue more content exists. Hidden by default; only a viewport
   narrow enough to actually clip the table (min-width:32rem) shows it. */
.pu-scroll-hint{display:none}
@media(max-width:640px){.pu-scroll-hint{display:block}}
.pu-compare-table{width:100%;border-collapse:collapse;min-width:32rem}
.pu-compare-table th,.pu-compare-table td{text-align:left;padding:.65rem .9rem;
  border-bottom:1px solid var(--pu-line);vertical-align:top}
.pu-compare-table th{font-family:var(--pu-font-display);font-weight:600;font-size:.9375rem}
.pu-compare-table td:not(:first-child),.pu-compare-table th:not(:first-child){text-align:center}
.pu-compare-table td:first-child{color:var(--pu-ink-500);font-size:.9375rem}

.pu-landing-footer{border-top:1px solid var(--pu-line);margin-top:3rem;padding-top:1.5rem}
.pu-landing-footer nav{display:flex;gap:1.25rem;justify-content:center;flex-wrap:wrap;
  font-size:.875rem;margin-bottom:.75rem}

/*
 * Docs section (pages/docs.ts): a nav rail + reading column, built on the
 * existing .pu-grid two-column layout (300px sidebar / 1fr content — see
 * BASE_CSS) rather than a new grid, so the docs section costs nothing extra
 * for a self-hoster who never visits /docs. Sidebar-first in source order so
 * it stays usable with CSS disabled and reads sensibly to a screen reader.
 */
.pu-docs-hero{padding:2.5rem 0 1.5rem}
.pu-docs-nav{position:sticky;top:1.25rem}
.pu-docs-nav h2{font-size:.75rem;font-weight:600;letter-spacing:.03em;text-transform:uppercase;
  color:var(--pu-ink-500);margin:0 0 .6rem}
.pu-docs-nav ul{list-style:none;margin:0;padding:0;display:grid;gap:.15rem}
.pu-docs-nav .pu-nav-link{display:block;border-bottom:2px solid transparent;border-left:2px solid transparent;
  padding:.4rem .1rem .4rem .75rem}
.pu-docs-nav .pu-nav-link[aria-current="page"]{border-left-color:var(--pu-green-700);border-bottom-color:transparent;
  background:var(--pu-green-tint);border-radius:0 var(--pu-radius) var(--pu-radius) 0}
.pu-docs-content{min-width:0}
.pu-docs-content h2{font-size:1.25rem;margin:2.25rem 0 .75rem}
.pu-docs-content section:first-child h2,.pu-docs-content>h2:first-child{margin-top:0}
.pu-docs-content h3{font-size:1rem;margin:1.5rem 0 .5rem}
/* Same overflow-x:auto wrapper pattern as .pu-compare-table-wrap (the
   calendly-alternative page) — a real <table> keeps normal browser column
   alignment between thead/tbody, which a display:block-on-<table> trick
   would break. Without a scrolling wrapper, a narrow viewport squeezed
   columns instead of scrolling: paths like /api/v1/event-types and tool
   names like list_event_types wrapped one syllable per line. */
.pu-docs-table-wrap{overflow-x:auto;margin:0 0 1.25rem}
.pu-docs-content table{width:100%;min-width:32rem;border-collapse:collapse;font-size:.875rem}
.pu-docs-content th,.pu-docs-content td{text-align:left;padding:.55rem .75rem;
  border-bottom:1px solid var(--pu-line);vertical-align:top}
.pu-docs-content th{font-family:var(--pu-font-display);font-weight:600;font-size:.8125rem}
.pu-docs-content table .pu-time{font-size:.8125rem;white-space:nowrap}
.pu-docs-content ul,.pu-docs-content ol{padding-left:1.25rem;margin:0 0 1rem}
.pu-docs-content li{margin-bottom:.4rem}
.pu-docs-content code{font-family:var(--pu-font-mono);font-size:.875em;background:var(--pu-paper-dim);
  border:1px solid var(--pu-line);border-radius:4px;padding:.05rem .35rem}

/* Code blocks: an always-dark terminal surface (see --pu-code-* in TOKENS'
   :root, deliberately not redefined for dark mode) so a multi-line snippet
   reads with the same contrast whichever theme the page is in. */
.pu-pre{background:var(--pu-code-bg);color:var(--pu-code-fg);border:1px solid var(--pu-code-line);
  border-radius:var(--pu-radius);padding:1rem 1.1rem;overflow-x:auto;margin:0 0 1.25rem}
.pu-pre code{display:block;font-family:var(--pu-font-mono);font-size:.8125rem;line-height:1.7;
  color:inherit;background:none;border:0;padding:0;white-space:pre}

.pu-docs-callout{background:var(--pu-status-info-bg);border:1px solid var(--pu-line);border-radius:var(--pu-radius);
  padding:.85rem 1rem;margin:0 0 1.25rem;font-size:.9375rem}
.pu-docs-callout p:last-child{margin-bottom:0}

@media(max-width:779px){.pu-docs-nav{position:static}}

/* Long unbroken tokens (URLs, API paths) must not force horizontal scroll
   on narrow viewports — see design requirement: no horizontal scroll at 360px. */
.pu-landing .pu-time{overflow-wrap:anywhere}

@media(hover:hover){
  .pu-feature-grid .pu-card,.pu-compare .pu-card{transition:border-color .15s ease}
  .pu-feature-grid .pu-card:hover,.pu-compare .pu-card:hover{border-color:var(--pu-green-700)}
}
@media(prefers-reduced-motion:reduce){
  .pu-feature-grid .pu-card,.pu-compare .pu-card{transition:none}
}
`
