import { describe, expect, it } from 'vitest'
import { fixtureSearch } from './fixtures'
import type { SearchRequest } from '../lib/types'

const req = (over: Partial<SearchRequest>): SearchRequest => ({ sessionId: 's', revision: 1, generation: 1, strokeCount: 0, pointCount: 0, textHint: '', selectedStyle: null, ...over })

describe('fixture reference search', () => {
  it('progresses from empty to provisional to confident', async () => {
    const empty = await fixtureSearch(req({ revision: 0, generation: 1, strokeCount: 0 }), new AbortController().signal)
    const provisional = await fixtureSearch(req({ revision: 1, generation: 2, strokeCount: 1 }), new AbortController().signal)
    const confident = await fixtureSearch(req({ revision: 3, generation: 3, strokeCount: 3 }), new AbortController().signal)
    expect(empty.mode).toBe('empty')
    expect(provisional.mode).toBe('provisional')
    expect(confident.mode).toBe('confident')
    expect(confident.groups[0]?.title).toBe('Best match')
  })

  it('honors request cancellation', async () => {
    const controller = new AbortController()
    const result = fixtureSearch(req({ revision: 1, generation: 2, strokeCount: 1, textHint: 'slow' }), controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  })
})
