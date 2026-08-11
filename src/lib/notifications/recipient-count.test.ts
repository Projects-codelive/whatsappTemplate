import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRecipientCount } from './recipient-count'

function stubFetch(response: { body: unknown; status: number }) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(
      new Response(JSON.stringify(response.body), { status: response.status }),
    )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getRecipientCount', () => {
  it('posts a selected request and returns the count', async () => {
    const fetchMock = stubFetch({ body: { count: 3 }, status: 200 })

    await expect(
      getRecipientCount({ target: 'selected', userIds: ['a', 'b', 'c'] }),
    ).resolves.toBe(3)

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/notifications/recipient-count',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'selected', userIds: ['a', 'b', 'c'] }),
      }),
    )
  })

  it('posts an all request and returns the count', async () => {
    stubFetch({ body: { count: 246 }, status: 200 })
    await expect(getRecipientCount({ target: 'all' })).resolves.toBe(246)
  })

  it('posts a category request and returns the count', async () => {
    stubFetch({ body: { count: 87 }, status: 200 })
    await expect(
      getRecipientCount({ target: 'category', category: 'Premium' }),
    ).resolves.toBe(87)
  })

  it('throws the server error on a non-ok response', async () => {
    stubFetch({ body: { error: 'Invalid notification target' }, status: 400 })
    await expect(getRecipientCount({ target: 'all' })).rejects.toThrow(
      'Invalid notification target',
    )
  })

  it('throws a network error when fetch itself fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'))
    await expect(getRecipientCount({ target: 'all' })).rejects.toThrow(
      'Network error while counting recipients',
    )
  })
})
