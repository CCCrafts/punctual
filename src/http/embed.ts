/**
 * The embed widget (spec §5.1): `<script>` + iframe, light/dark, auto-height.
 *
 * An iframe rather than injected markup, deliberately. The booking page is a
 * whole document with its own CSS, and dropping that into a customer's page
 * would inherit their cascade and their JavaScript — the widget would break
 * differently on every site that used it. The iframe also keeps the engine's
 * origin as the security boundary, which is what lets the dashboard cookie stay
 * `SameSite=Lax`: the embedded page carries no session by design (ADR-0005 §5),
 * so third-party cookie policy never enters the critical path.
 *
 * The one thing an iframe cannot do by itself is size to its content, hence the
 * postMessage pair below. Both halves live in this file so they cannot drift:
 * `embedScript` runs on the customer's page and listens, `EMBED_RESIZE_SNIPPET`
 * runs on the booking page and posts.
 *
 * Budget: the served script stays under 2 KB uncompressed. It is a third-party
 * script on someone else's page, and that is the whole reason it must not grow
 * into a framework.
 */

import { Hono } from 'hono'
import type { EnginePorts } from '../ports.js'

/** The message name, shared by both halves. Versioned so a stale cached widget can be ignored later. */
export const EMBED_MESSAGE_TYPE = 'punctual:resize:1'

/**
 * What the booking page runs so the parent can size the frame.
 *
 * `targetOrigin` is `'*'`, which is correct here and would not be if this
 * carried anything private: the host page's origin is unknown by construction
 * (it is any customer's site), and the payload is one integer — a height
 * already visible to anyone who can see the frame.
 */
export const EMBED_RESIZE_SNIPPET = `(function(){
if(window.parent===window)return;
var last=0;
function p(){var h=Math.ceil(document.documentElement.getBoundingClientRect().height);
if(h&&h!==last){last=h;window.parent.postMessage({t:'${EMBED_MESSAGE_TYPE}',h:h},'*')}}
p();window.addEventListener('load',p);
if(window.ResizeObserver)new ResizeObserver(p).observe(document.documentElement);
else window.addEventListener('resize',p)})()`

/** Ready to concatenate into a server-rendered page. */
export function embedResizeScriptTag(): string {
  return `<script>${EMBED_RESIZE_SNIPPET}</script>`
}

/**
 * The script served at `/embed.js`.
 *
 * Usage on a customer's page:
 *
 * ```html
 * <script src="https://punctual.example/embed.js"
 *         data-user="serge" data-event="30min" data-theme="dark"></script>
 * ```
 *
 * `data-url` overrides the pair for a fully-qualified booking URL. The guest's
 * own timezone is read from the browser and passed along, which is strictly
 * better than the IP-derived guess the page falls back to.
 */
export function embedScript(baseUrl: string): string {
  const origin = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return `(function(){
var s=document.currentScript;if(!s)return;
var d=s.dataset,b=${JSON.stringify(origin)};
var u=d.url||(d.user?b+'/'+d.user+'/'+(d.event||'')  :'');
if(!u)return;
var q=[];
if(d.theme==='light'||d.theme==='dark')q.push('theme='+d.theme);
var tz=d.tz;
if(!tz){try{tz=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}}
if(tz)q.push('tz='+encodeURIComponent(tz));
q.push('embed=1');
var f=document.createElement('iframe');
f.src=u+(u.indexOf('?')<0?'?':'&')+q.join('&');
f.title=d.title||'Booking page';
f.loading='eager';
f.setAttribute('frameborder','0');
f.setAttribute('allowtransparency','true');
f.style.cssText='border:0;width:100%;display:block;min-height:'+(parseInt(d.height,10)||620)+'px;color-scheme:normal';
s.parentNode.insertBefore(f,s);
window.addEventListener('message',function(e){
if(e.source!==f.contentWindow)return;
var m=e.data;if(!m||m.t!==${JSON.stringify(EMBED_MESSAGE_TYPE)})return;
var h=parseInt(m.h,10);if(h>0&&h<20000)f.style.height=h+'px'})})()`
}

/**
 * `GET /embed.js`.
 *
 * Cached for an hour rather than immutably: the URL is unversioned by design —
 * a customer pastes one snippet and never touches it again — so the cache
 * lifetime is also the upper bound on how long a fix takes to reach them.
 */
export function buildEmbedRoutes(ports: EnginePorts): Hono<{ Bindings: Record<string, unknown> }> {
  const app = new Hono<{ Bindings: Record<string, unknown> }>()

  app.get('/embed.js', (c) =>
    c.body(embedScript(ports.config.baseUrl), 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      // Loaded cross-origin by <script src>, which needs no CORS header — but
      // a build tool fetching it does, and allowing that costs nothing.
      'access-control-allow-origin': '*',
    }),
  )

  return app
}
