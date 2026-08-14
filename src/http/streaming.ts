/**
 * Streaming responses (ADR-0007 §3).
 *
 * Why this exists: on the deployed Worker the edge answers in ~100 ms while
 * the booking page took ~320 ms, because the page awaited D1 before emitting
 * a single byte. Streaming makes TTFB a function of edge render alone, which
 * is what the §7 budget actually measures.
 *
 * This is also exactly the kind of metric that can be gamed, which is why
 * ADR-0007 adds a time-to-first-slot budget alongside TTFB — flushing an empty
 * shell fast is not "instant" in any sense a user recognises. Both numbers are
 * held, and both are reported honestly.
 */

/**
 * Stream a page: `head` goes out immediately, `body` is awaited and appended.
 *
 * The parts are emitted in document order, so the browser parses and applies
 * the stylesheet in `head` while D1 is still being read — the paint is already
 * set up by the time the content lands.
 */
export function streamPage(
  head: string,
  body: () => Promise<string>,
  foot: string,
  init: ResponseInit = {},
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(head))
      try {
        controller.enqueue(encoder.encode(await body()))
      } catch (err) {
        // The status line is already sent, so a failure here cannot become a
        // 500. Emitting a visible message beats a silently truncated page.
        console.error('[punctual] streamed body failed', err)
        controller.enqueue(
          encoder.encode(
            '<section class="pu-card"><h1>Something went wrong</h1>' +
              '<p class="pu-muted">Please reload the page.</p></section>',
          ),
        )
      }
      controller.enqueue(encoder.encode(foot))
      controller.close()
    },
  })

  return new Response(stream, {
    ...init,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Chunks must reach the browser as they are produced; a proxy that
      // buffers the whole response would silently undo all of this.
      'cache-control': 'no-transform',
      ...(init.headers ?? {}),
    },
  })
}
