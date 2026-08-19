/**
 * The semantic *slot* states the booking flow renders.
 *
 * This is deliberately a closed enum, not a free-form status string: every
 * value here has a matching `.pu-slot-*` rule in `../http/styles.ts` (TOKENS'
 * `--pu-slot-*` custom properties) and a swatch in the brand reference page.
 * Add a state in both places at once, or the CSS silently falls back to
 * `.pu-slot`'s bare (available-looking) styling.
 *
 * `held` and `booked` are visually distinct from `available` without relying
 * on the accent (meridian/signal green) — that hue is reserved for the
 * guest's own current selection (`selected`/`hover`), never for a system
 * state. See the `--pu-slot-held-*` / `--pu-slot-booked-*` tokens.
 */
export type SlotState =
  | 'available'
  | 'hover'
  | 'selected'
  | 'held'
  | 'booked'
  | 'past'
  | 'outside-notice-window'

export const SLOT_STATES: readonly SlotState[] = [
  'available',
  'hover',
  'selected',
  'held',
  'booked',
  'past',
  'outside-notice-window',
]

/**
 * `hover` has no modifier class of its own: it is never a state a server
 * render picks — it is a pointer transiently passing over an `available`
 * slot, styled in CSS via `.pu-slot-available:hover`. Mapping it here (rather
 * than treating it as invalid input) keeps `SlotState` usable end-to-end as
 * one closed type for both server-rendered markup and the swatch page, which
 * does need to render a `hover` swatch explicitly since nothing in a static
 * page can trigger a real `:hover`.
 */
export function slotStateClassName(state: SlotState): string {
  switch (state) {
    case 'available':
    case 'hover':
      return 'pu-slot pu-slot-available'
    case 'selected':
      return 'pu-slot pu-slot-selected'
    case 'held':
      return 'pu-slot pu-slot-held'
    case 'booked':
      return 'pu-slot pu-slot-booked'
    case 'past':
      return 'pu-slot pu-slot-past'
    case 'outside-notice-window':
      return 'pu-slot pu-slot-outside-notice'
  }
}

/**
 * Whether a slot in this state is a real navigation target. `available` (and
 * the guest's own `hover`/`selected` moments on it) is the only state a
 * click can act on — `held`, `booked`, `past` and `outside-notice-window`
 * exist to be *seen*, not clicked, so the caller must render a `<span>`
 * rather than an `<a>`/`<button>` for them (no `href`, no tab stop, no
 * `:active`/`:focus-visible` affordance implying otherwise).
 */
export function isInteractiveSlotState(state: SlotState): boolean {
  return state === 'available' || state === 'hover' || state === 'selected'
}
