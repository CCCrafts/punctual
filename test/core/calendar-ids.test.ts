import { describe, expect, it } from 'vitest'
import { stableEventIds } from '../../src/adapters/calendar-ids.js'

describe('stable calendar event ids', () => {
  it('are the same for the same booking and connection, and differ otherwise', async () => {
    const a = await stableEventIds('bk_1:cal_1')
    const again = await stableEventIds('bk_1:cal_1')
    const other = await stableEventIds('bk_1:cal_2')
    expect(again).toEqual(a)
    expect(other.googleEventId).not.toBe(a.googleEventId)
    expect(other.short).not.toBe(a.short)
  })

  it("fit Google's event id rules: base32hex alphabet, 5 to 1024 characters", async () => {
    const { googleEventId, short } = await stableEventIds('bk_1:cal_1')
    expect(googleEventId).toMatch(/^[a-v0-9]{5,1024}$/)
    expect(googleEventId.length).toBe(2 + 52)
    expect(short).toMatch(/^[0-9a-f]{24}$/)
  })
})
