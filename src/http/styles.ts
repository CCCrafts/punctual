/**
 * Design tokens and page CSS.
 *
 * Inlined rather than served as a file, deliberately: the §7 budget is a <1 s
 * full load on mobile 4G with the whole page under 80 KB gzip, and a separate
 * stylesheet costs a round trip that a few KB of inline CSS does not.
 *
 * Tokens mirror docs/branding/assets/tokens.css. Fonts are system stacks with
 * the brand faces named first — a self-hoster gets a correct-looking page with
 * zero font downloads, which is also what keeps the byte budget.
 */

export const TOKENS = `
:root{
  --pu-ink-950:#0F1512; --pu-ink-900:#17201B; --pu-ink-700:#2E3B34;
  --pu-ink-500:#5C6660; --pu-paper:#FAFAF7; --pu-paper-dim:#F0F1EC;
  --pu-line:#E3E5DE; --pu-green-700:#0E7C4C; --pu-green-800:#0A5C3A;
  --pu-signal:#1FC16B; --pu-green-tint:#E4F5EC; --pu-danger:#D92D20;
  --pu-font-display:"Schibsted Grotesk",system-ui,-apple-system,sans-serif;
  --pu-font-ui:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
  --pu-font-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --pu-radius:10px; --pu-radius-lg:16px;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme=light]){
    --pu-paper:#0F1512; --pu-paper-dim:#17201B; --pu-line:#2E3B34;
    --pu-ink-950:#FAFAF7; --pu-ink-500:#9AA5A0; --pu-green-700:#1FC16B;
    --pu-green-800:#3ED486; --pu-green-tint:#153A28;
  }
}
:root[data-theme=dark]{
  --pu-paper:#0F1512; --pu-paper-dim:#17201B; --pu-line:#2E3B34;
  --pu-ink-950:#FAFAF7; --pu-ink-500:#9AA5A0; --pu-green-700:#1FC16B;
  --pu-green-800:#3ED486; --pu-green-tint:#153A28;
}
`

export const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--pu-paper);color:var(--pu-ink-950);
  font-family:var(--pu-font-ui);line-height:1.5;-webkit-font-smoothing:antialiased}
h1,h2,h3{font-family:var(--pu-font-display);font-weight:600;line-height:1.2;margin:0 0 .5rem}
h1{font-size:1.5rem} h2{font-size:1.125rem} h3{font-size:1rem}
p{margin:0 0 .75rem}
a{color:var(--pu-green-700)}
time,.pu-time{font-family:var(--pu-font-mono);font-variant-numeric:tabular-nums}

.pu-wrap{max-width:900px;margin:0 auto;padding:1.5rem 1rem 4rem}
.pu-card{background:var(--pu-paper);border:1px solid var(--pu-line);
  border-radius:var(--pu-radius-lg);padding:1.25rem}
.pu-muted{color:var(--pu-ink-500)}
.pu-mark{font-family:var(--pu-font-mono);font-weight:600;letter-spacing:-.02em;
  text-decoration:none;color:var(--pu-ink-950)}
.pu-mark span{color:var(--pu-signal)}

.pu-grid{display:grid;gap:1.5rem;grid-template-columns:1fr}
@media(min-width:780px){.pu-grid{grid-template-columns:300px 1fr}}

.pu-cal{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.pu-cal-head{font-size:.75rem;text-align:center;color:var(--pu-ink-500);padding:.25rem 0}
.pu-day{aspect-ratio:1;display:flex;align-items:center;justify-content:center;
  border:1px solid transparent;border-radius:var(--pu-radius);background:none;
  font:inherit;font-family:var(--pu-font-mono);font-size:.875rem;cursor:pointer;
  color:var(--pu-ink-950);text-decoration:none}
.pu-day[data-has-slots="1"]{background:var(--pu-green-tint);color:var(--pu-green-700);font-weight:600}
.pu-day[aria-disabled="true"]{color:var(--pu-ink-500);opacity:.45;cursor:default}
.pu-day[aria-current="date"]{border-color:var(--pu-green-700)}
.pu-day:hover[data-has-slots="1"]{background:var(--pu-green-700);color:var(--pu-paper)}
.pu-day:focus-visible,.pu-slot:focus-visible,.pu-btn:focus-visible,
input:focus-visible,select:focus-visible,textarea:focus-visible{
  outline:2px solid var(--pu-green-700);outline-offset:2px}

.pu-slots{display:grid;gap:.5rem;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));
  max-height:60vh;overflow-y:auto}
.pu-slot{padding:.6rem .5rem;border:1px solid var(--pu-line);border-radius:var(--pu-radius);
  background:var(--pu-paper);font-family:var(--pu-font-mono);font-size:.9rem;
  color:var(--pu-ink-950);text-align:center;text-decoration:none;cursor:pointer;display:block}
.pu-slot:hover{border-color:var(--pu-green-700);background:var(--pu-green-tint)}

.pu-btn{display:inline-block;padding:.7rem 1.1rem;border-radius:var(--pu-radius);
  background:var(--pu-green-700);color:#fff;border:1px solid var(--pu-green-700);
  font:inherit;font-weight:600;cursor:pointer;text-decoration:none;text-align:center}
.pu-btn:hover{background:var(--pu-green-800);border-color:var(--pu-green-800)}
.pu-btn[disabled]{opacity:.6;cursor:default}
.pu-btn-ghost{background:none;color:var(--pu-ink-950);border-color:var(--pu-line)}
.pu-btn-danger{background:var(--pu-danger);border-color:var(--pu-danger);color:#fff}

label{display:block;font-size:.875rem;font-weight:600;margin:.85rem 0 .3rem}
input,select,textarea{width:100%;padding:.6rem .7rem;border:1px solid var(--pu-line);
  border-radius:var(--pu-radius);background:var(--pu-paper);color:var(--pu-ink-950);
  font:inherit}
textarea{min-height:5rem;resize:vertical}
.pu-err{color:var(--pu-danger);font-size:.8125rem;margin:.25rem 0 0}
.pu-badge{display:inline-block;padding:.15rem .5rem;border-radius:99px;font-size:.75rem;
  background:var(--pu-green-tint);color:var(--pu-green-700);font-weight:600}
.pu-dot{display:inline-block;width:.5rem;height:.5rem;border-radius:99px;
  background:var(--pu-signal);vertical-align:middle}
.pu-meta{display:flex;flex-wrap:wrap;gap:.5rem 1rem;font-size:.875rem;color:var(--pu-ink-500);
  list-style:none;padding:0;margin:.5rem 0 0}
.pu-skeleton{height:2.4rem;border-radius:var(--pu-radius);background:var(--pu-paper-dim);
  animation:pu-pulse 1.2s ease-in-out infinite}
@keyframes pu-pulse{50%{opacity:.55}}
@media(prefers-reduced-motion:reduce){.pu-skeleton{animation:none}}
.pu-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
  clip:rect(0 0 0 0);white-space:nowrap;border:0}
.pu-foot{margin-top:2.5rem;font-size:.8125rem;color:var(--pu-ink-500);text-align:center}
`

export function pageCss(): string {
  return TOKENS + BASE_CSS
}
