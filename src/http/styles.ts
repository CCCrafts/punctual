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
  --pu-font-display:"Schibsted Grotesk",system-ui,-apple-system,sans-serif;
  --pu-font-ui:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
  --pu-font-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --pu-radius:10px; --pu-radius-lg:16px;
  --pu-shadow-sm:0 1px 2px rgba(15,21,18,.06);
  --pu-ring:0 0 0 3px color-mix(in srgb,var(--pu-green-700) 25%,transparent);
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme=light]){
    --pu-paper:#0F1512; --pu-paper-dim:#17201B; --pu-line:#2E3B34;
    --pu-ink-950:#FAFAF7; --pu-ink-500:#9AA5A0; --pu-green-700:#1FC16B;
    --pu-green-800:#3ED486; --pu-green-tint:#153A28; --pu-danger-text:#FF6B5B;
    --pu-danger-tint:#3A1A16;
    --pu-shadow-sm:0 1px 2px rgba(0,0,0,.4);
  }
}
:root[data-theme=dark]{
  --pu-paper:#0F1512; --pu-paper-dim:#17201B; --pu-line:#2E3B34;
  --pu-ink-950:#FAFAF7; --pu-ink-500:#9AA5A0; --pu-green-700:#1FC16B;
  --pu-green-800:#3ED486; --pu-green-tint:#153A28; --pu-danger-text:#FF6B5B;
  --pu-danger-tint:#3A1A16;
  --pu-shadow-sm:0 1px 2px rgba(0,0,0,.4);
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
 * - .pu-confirm-icon is the brand's "dot at twelve" ring, landed: the ring
 *   has finished drawing and the dot sits at 12, i.e. arrived on time.
 */
export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--pu-paper);color:var(--pu-ink-950);
  font-family:var(--pu-font-ui);line-height:1.5;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--pu-font-display);font-weight:600;line-height:1.2;margin:0 0 .5rem}
h1{font-size:1.5rem} h2{font-size:1.125rem} h3{font-size:1rem}
p{margin:0 0 .75rem}
a{color:var(--pu-green-700)}
time,.pu-time{font-family:var(--pu-font-mono);font-variant-numeric:tabular-nums}
::selection{background:var(--pu-green-tint);color:var(--pu-green-800)}

.pu-wrap{max-width:900px;margin:0 auto;padding:1.5rem 1rem 4rem}
.pu-card{background:var(--pu-paper);border:1px solid var(--pu-line);
  border-radius:var(--pu-radius-lg);padding:1.375rem;box-shadow:var(--pu-shadow-sm)}
.pu-muted{color:var(--pu-ink-500)}
.pu-kicker{color:var(--pu-ink-500);font-size:.8125rem;font-weight:600;
  letter-spacing:.03em;text-transform:uppercase;margin:0 0 .35rem}
.pu-mark{font-family:var(--pu-font-mono);font-weight:600;letter-spacing:-.02em;
  text-decoration:none;color:var(--pu-ink-950)}
.pu-mark span{color:var(--pu-signal)}

.pu-grid{display:grid;gap:1.5rem;grid-template-columns:1fr}
@media(min-width:780px){.pu-grid{grid-template-columns:300px 1fr}}

.pu-event-header{padding:0 0 1.5rem;margin:0 0 1.5rem;border-bottom:1px solid var(--pu-line)}
.pu-event-header h1{font-size:1.75rem;margin:0 0 .5rem}
.pu-event-header .pu-meta{margin-top:.85rem}

.pu-cal{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.pu-cal-head{font-size:.75rem;font-weight:600;text-align:center;color:var(--pu-ink-500);padding:.25rem 0}
.pu-day{position:relative;aspect-ratio:1;display:flex;align-items:center;justify-content:center;
  border:1px solid transparent;border-radius:var(--pu-radius);background:none;
  font:inherit;font-family:var(--pu-font-mono);font-size:.9375rem;cursor:pointer;
  color:var(--pu-ink-950);text-decoration:none;transition:all .12s ease}
.pu-day[data-has-slots="1"]{background:var(--pu-green-tint);color:var(--pu-green-700);font-weight:700}
.pu-day[aria-disabled="true"]{color:var(--pu-ink-500);opacity:.45;cursor:default}
.pu-day[aria-current="date"]{box-shadow:inset 0 0 0 2px var(--pu-green-700);font-weight:700}
.pu-day:hover[data-has-slots="1"]{background:var(--pu-green-700);color:var(--pu-paper);transform:translateY(-1px)}
.pu-day:focus-visible,.pu-slot:focus-visible,.pu-btn:focus-visible{
  outline:2px solid var(--pu-green-700);outline-offset:2px}
input:focus-visible,select:focus-visible,textarea:focus-visible{
  outline:2px solid var(--pu-green-700);outline-offset:1px;box-shadow:var(--pu-ring)}

.pu-slots{display:grid;gap:.625rem;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));
  max-height:60vh;overflow-y:auto;padding:2px}
.pu-slot{padding:.75rem .5rem;border:1px solid var(--pu-line);border-radius:var(--pu-radius);
  background:var(--pu-paper);font-family:var(--pu-font-mono);font-size:.9375rem;font-weight:600;
  color:var(--pu-ink-950);text-align:center;text-decoration:none;cursor:pointer;display:block;
  transition:all .12s ease}
.pu-slot:hover{border-color:var(--pu-green-700);background:var(--pu-green-tint);
  box-shadow:var(--pu-shadow-sm);transform:translateY(-1px)}
.pu-slot:active{background:var(--pu-green-700);border-color:var(--pu-green-700);color:#fff;transform:translateY(0)}

.pu-slot-chosen{display:flex;align-items:center;gap:.75rem;margin:0 0 1.25rem;
  padding:.85rem 1rem;border:1px solid var(--pu-green-700);border-radius:var(--pu-radius);
  background:var(--pu-green-tint)}
.pu-slot-chosen .pu-dot-lg{flex:0 0 auto;width:.65rem;height:.65rem;border-radius:99px;
  background:var(--pu-green-700)}

.pu-btn{display:inline-block;padding:.7rem 1.1rem;border-radius:var(--pu-radius);
  background:var(--pu-green-700);color:#fff;border:1px solid var(--pu-green-700);
  font:inherit;font-weight:600;cursor:pointer;text-decoration:none;text-align:center;
  transition:all .12s ease}
.pu-btn:hover{background:var(--pu-green-800);border-color:var(--pu-green-800)}
.pu-btn[disabled]{opacity:.6;cursor:default}
.pu-btn-ghost{background:none;color:var(--pu-ink-950);border-color:var(--pu-line)}
.pu-btn-ghost:hover{background:var(--pu-paper-dim);border-color:var(--pu-ink-500);color:var(--pu-ink-950)}
.pu-btn-danger{background:var(--pu-danger);border-color:var(--pu-danger);color:#fff}
.pu-btn-danger:hover{background:var(--pu-danger-800);border-color:var(--pu-danger-800)}

label{display:block;font-size:.875rem;font-weight:600;margin:1rem 0 .35rem}
input,select,textarea{width:100%;padding:.65rem .75rem;border:1px solid var(--pu-line);
  border-radius:var(--pu-radius);background:var(--pu-paper);color:var(--pu-ink-950);
  font:inherit;transition:border-color .12s ease}
textarea{min-height:5rem;resize:vertical}
input:has(+ .pu-err),select:has(+ .pu-err),textarea:has(+ .pu-err){border-color:var(--pu-danger)}
.pu-err{display:flex;align-items:flex-start;gap:.4rem;color:var(--pu-danger-text);
  font-size:.8125rem;margin:.4rem 0 0}
.pu-err::before{content:"!";flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
  width:1rem;height:1rem;margin-top:.0625rem;border-radius:99px;background:var(--pu-danger);
  color:#fff;font-size:.6875rem;font-weight:700;line-height:1}
.pu-badge{display:inline-block;padding:.15rem .5rem;border-radius:99px;font-size:.75rem;
  background:var(--pu-green-tint);color:var(--pu-green-700);font-weight:600}
.pu-dot{display:inline-block;width:.5rem;height:.5rem;border-radius:99px;
  background:var(--pu-signal);vertical-align:middle}
.pu-meta{display:flex;flex-wrap:wrap;gap:.5rem 1rem;font-size:.875rem;color:var(--pu-ink-500);
  list-style:none;padding:0;margin:.5rem 0 0}
.pu-tz-form{display:inline-flex;align-items:center;gap:.35rem}
.pu-tz-select{width:auto;padding:.15rem 1.5rem .15rem .1rem;border:none;border-radius:0;
  background:transparent;color:inherit;font:inherit;font-size:.875rem;
  text-decoration:underline;text-decoration-style:dotted;text-underline-offset:.2rem;cursor:pointer}
.pu-tz-select:focus-visible{outline:2px solid var(--pu-green-700);outline-offset:2px;border-radius:4px}

.pu-confirm{text-align:center;padding:2rem 1.5rem}
.pu-confirm-icon{display:block;margin:0 auto .75rem}
.pu-ring-track{fill:none;stroke:var(--pu-line)}
.pu-ring-fill{fill:none;stroke:var(--pu-green-700);stroke-dasharray:151;stroke-dashoffset:0}
.pu-ring-dot{fill:var(--pu-signal)}
.pu-confirm h1{margin:.15rem 0 .35rem}
.pu-confirm-details{text-align:left;list-style:none;margin:1.25rem 0;padding:1rem 1.25rem;
  background:var(--pu-paper-dim);border-radius:var(--pu-radius);display:grid;gap:.6rem}
.pu-confirm-details div{display:flex;justify-content:space-between;align-items:baseline;
  gap:1rem;flex-wrap:wrap}
.pu-confirm-details dt{color:var(--pu-ink-500);font-size:.8125rem;font-weight:600;margin:0}
.pu-confirm-details dd{margin:0;text-align:right}

.pu-nav-link{text-decoration:none;color:var(--pu-ink-500);font-weight:500;
  padding:.35rem 0;border-bottom:2px solid transparent}
.pu-nav-link:hover{color:var(--pu-ink-950)}
.pu-nav-link[aria-current="page"]{color:var(--pu-ink-950);font-weight:600;
  border-bottom-color:var(--pu-green-700)}
.pu-dash-header{border-bottom:1px solid var(--pu-line);padding-bottom:1rem}

.pu-url{display:flex;align-items:center;gap:.5rem;background:var(--pu-paper-dim);
  border:1px solid var(--pu-line);border-radius:var(--pu-radius);padding:.15rem .15rem .15rem .8rem}
.pu-url-input{flex:1;min-width:0;border:0;background:none;padding:.5rem 0;
  font-family:var(--pu-font-mono);font-size:.8125rem;color:var(--pu-ink-950)}

.pu-skeleton{height:2.4rem;border-radius:var(--pu-radius);background:var(--pu-paper-dim);
  animation:pu-pulse 1.2s ease-in-out infinite}
@keyframes pu-pulse{50%{opacity:.55}}
.pu-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.pu-foot{margin-top:2.5rem;font-size:.8125rem;color:var(--pu-ink-500);text-align:center}

@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;
    transition-duration:.01ms!important;scroll-behavior:auto!important}
  .pu-day:hover[data-has-slots="1"],.pu-slot:hover,.pu-slot:active{transform:none}
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
  width:2rem;height:2rem;border-radius:99px;background:var(--pu-green-700);color:#fff;
  display:flex;align-items:center;justify-content:center;font-family:var(--pu-font-mono);
  font-weight:700;font-size:.875rem}

.pu-compare{display:grid;gap:1.25rem;grid-template-columns:1fr}
@media(min-width:700px){.pu-compare{grid-template-columns:1fr 1fr}}
.pu-compare .pu-card{display:flex;flex-direction:column;gap:.25rem}
.pu-compare h3{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.pu-compare ul{padding-left:1.1rem;margin:.5rem 0}
.pu-compare li{margin-bottom:.4rem}

.pu-compare-table-wrap{overflow-x:auto}
.pu-compare-table{width:100%;border-collapse:collapse;min-width:32rem}
.pu-compare-table th,.pu-compare-table td{text-align:left;padding:.65rem .9rem;
  border-bottom:1px solid var(--pu-line);vertical-align:top}
.pu-compare-table th{font-family:var(--pu-font-display);font-weight:600;font-size:.9375rem}
.pu-compare-table td:not(:first-child),.pu-compare-table th:not(:first-child){text-align:center}
.pu-compare-table td:first-child{color:var(--pu-ink-500);font-size:.9375rem}

.pu-landing-footer{border-top:1px solid var(--pu-line);margin-top:3rem;padding-top:1.5rem}
.pu-landing-footer nav{display:flex;gap:1.25rem;justify-content:center;flex-wrap:wrap;
  font-size:.875rem;margin-bottom:.75rem}

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
