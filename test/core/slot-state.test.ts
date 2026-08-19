import { describe, expect, it } from 'vitest'
import {
  isInteractiveSlotState,
  slotStateClassName,
  SLOT_STATES,
  type SlotState,
} from '../../src/core/slot-state.js'

describe('slotStateClassName', () => {
  it('always includes the base .pu-slot class plus exactly one state modifier', () => {
    for (const state of SLOT_STATES) {
      const className = slotStateClassName(state)
      const classes = className.split(' ')
      expect(classes[0]).toBe('pu-slot')
      expect(classes).toHaveLength(2)
    }
  })

  it('maps hover onto the available modifier — hover is a pointer transiently over an available slot, not a state of its own in markup', () => {
    expect(slotStateClassName('hover')).toBe(slotStateClassName('available'))
    expect(slotStateClassName('hover')).toBe('pu-slot pu-slot-available')
  })

  it('gives every non-hover state a distinct modifier class', () => {
    const nonHover = SLOT_STATES.filter((s) => s !== 'hover')
    const classNames = nonHover.map(slotStateClassName)
    expect(new Set(classNames).size).toBe(classNames.length)
  })

  it('names the outside-notice-window modifier without the full state string (CSS class, not a data attribute)', () => {
    expect(slotStateClassName('outside-notice-window')).toBe('pu-slot pu-slot-outside-notice')
  })
})

describe('isInteractiveSlotState', () => {
  const interactive: SlotState[] = ['available', 'hover', 'selected']
  const inert: SlotState[] = ['held', 'booked', 'past', 'outside-notice-window']

  it('treats available, hover and selected as clickable', () => {
    for (const state of interactive) expect(isInteractiveSlotState(state)).toBe(true)
  })

  it('treats held, booked, past and outside-notice-window as inert — never a real navigation target', () => {
    for (const state of inert) expect(isInteractiveSlotState(state)).toBe(false)
  })

  it('covers every declared state exactly once between the two groups', () => {
    expect([...interactive, ...inert].sort()).toEqual([...SLOT_STATES].sort())
  })
})
