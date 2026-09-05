import { describe, expect, it } from 'vitest'
import { fixtureSearch } from './fixtures'

describe('fixture reference search', () => {
  it('progresses from empty to provisional to confident', async () => {
    const empty = await fixtureSearch({ revision: 0, generation: 1, strokeCount: 0, textHint: '' }, new AbortController().signal)
    const provisional = await fixtureSearch({ revision: 1, generation: 2, strokeCount: 1, textHint: '' }, new AbortController().signal)
    const confident = await fixtureSearch({ revision: 3, generation: 3, strokeCount: 3, textHint: '' }, new AbortController().signal)
    expect(empty.mode).toBe('empty')
    expect(provisional.mode).toBe('provisional')
    expect(confident.mode).toBe('confident')
    expect(confident.groups[0]?.title).toBe('Best match')
  })

  it('honors request cancellation', async () => {
    const controller = new AbortController()
    const result = fixtureSearch({ revision: 1, generation: 2, strokeCount: 1, textHint: 'slow' }, controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })
})
