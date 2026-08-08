import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncUserTypes } from './sync-user-types'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

type FakeAdmin = Parameters<typeof syncUserTypes>[0]

function fakeAdmin(
  localMobiles: Array<{ mobile: string | null }> = [
    { mobile: '111' },
    { mobile: '222' },
    { mobile: '333' },
  ],
) {
  const updates: Record<string, string> = {}
  const admin = {
    from: (table: string) => {
      if (table !== 'users') throw new Error(`unexpected table ${table}`)
      return {
        select: () => Promise.resolve({ data: localMobiles, error: null }),
        update: (patch: Record<string, unknown>) => ({
          eq: (_column: string, value: string) => {
            updates[value] = patch.category as string
            return Promise.resolve({ data: null, error: null })
          },
        }),
      }
    },
  } as unknown as FakeAdmin
  return { admin, updates }
}

describe('syncUserTypes', () => {
  it('posts the api_key and last_user_id params and applies every record', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://niveshbay.com/api/v1/user_type.php')
      expect(init.method).toBe('POST')
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      )
      const body = new URLSearchParams(String(init.body))
      expect(body.get('api_key')).toBe('NBCOURSE_2026@Secure#API')
      expect(body.get('last_user_id')).toBe('0')
      return jsonResponse({
        status: true,
        count: 2,
        data: [
          { number: '111', user_type: 'Free' },
          { number: '222', user_type: 'Day Pass' },
        ],
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { admin, updates } = fakeAdmin()

    const result = await syncUserTypes(admin)

    expect(result).toEqual({ typesChecked: 2, categoriesUpdated: 2, typeFetchFailed: 0 })
    expect(updates).toEqual({ 111: 'Free', 222: 'Day Pass' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('pages until the API stops advancing last_user_id', async () => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const lastUserId = new URLSearchParams(String(init.body)).get('last_user_id')
      calls.push(lastUserId ?? '')
      if (lastUserId === '2') {
        return jsonResponse({
          status: true,
          count: 1,
          last_user_id: 3,
          has_more: false,
          data: [{ number: '333', user_type: 'Premium' }],
        })
      }
      return jsonResponse({
        status: true,
        count: 2,
        last_user_id: 2,
        has_more: true,
        data: [
          { number: '111', user_type: 'Free' },
          { number: '222', user_type: 'Day Pass' },
        ],
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { admin, updates } = fakeAdmin()

    const result = await syncUserTypes(admin)

    expect(calls).toEqual(['0', '2'])
    expect(result).toEqual({ typesChecked: 3, categoriesUpdated: 3, typeFetchFailed: 0 })
    expect(updates).toEqual({ 111: 'Free', 222: 'Day Pass', 333: 'Premium' })
  })

  it('stops when has_more is true but last_user_id stops advancing', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const lastUserId = new URLSearchParams(String(init.body)).get('last_user_id')
      if (lastUserId === '2') {
        return jsonResponse({
          status: true,
          last_user_id: 2,
          has_more: true,
          data: [{ number: '333', user_type: 'Premium' }],
        })
      }
      return jsonResponse({
        status: true,
        last_user_id: 2,
        has_more: true,
        data: [{ number: '111', user_type: 'Free' }],
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { admin, updates } = fakeAdmin()

    const result = await syncUserTypes(admin)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ typesChecked: 2, categoriesUpdated: 2, typeFetchFailed: 0 })
    expect(updates).toEqual({ 111: 'Free', 333: 'Premium' })
  })

  it('skips records with a blank or null number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: true,
          data: [
            { number: '', user_type: 'Free' },
            { number: null, user_type: 'Free' },
            { number: '111', user_type: 'Free' },
          ],
        }),
      ),
    )

    const { admin, updates } = fakeAdmin()

    const result = await syncUserTypes(admin)

    expect(result).toEqual({ typesChecked: 3, categoriesUpdated: 1, typeFetchFailed: 2 })
    expect(updates).toEqual({ 111: 'Free' })
  })

  it('skips records with a blank user_type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: true,
          data: [
            { number: '111', user_type: '' },
            { number: '222', user_type: null },
          ],
        }),
      ),
    )

    const { admin, updates } = fakeAdmin()

    const result = await syncUserTypes(admin)

    expect(result).toEqual({ typesChecked: 2, categoriesUpdated: 0, typeFetchFailed: 2 })
    expect(updates).toEqual({})
  })

  it('does not update numbers with no local match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ status: true, data: [{ number: '999', user_type: 'Free' }] }),
      ),
    )

    const { admin, updates } = fakeAdmin([{ mobile: '111' }])

    const result = await syncUserTypes(admin)

    expect(result).toEqual({ typesChecked: 1, categoriesUpdated: 0, typeFetchFailed: 1 })
    expect(updates).toEqual({})
  })

  it('counts a status=false page as failed without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: false, message: 'Invalid API key.' })),
    )

    const { admin, updates } = fakeAdmin()

    const result = await syncUserTypes(admin)

    expect(result).toEqual({ typesChecked: 0, categoriesUpdated: 0, typeFetchFailed: 1 })
    expect(updates).toEqual({})
  })

  it('counts an HTTP error page as failed without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: true, data: [] }, 500)),
    )

    const { admin } = fakeAdmin()

    const result = await syncUserTypes(admin)

    expect(result).toEqual({ typesChecked: 0, categoriesUpdated: 0, typeFetchFailed: 1 })
  })

  it('counts a bad-JSON page as failed without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 })),
    )

    const { admin } = fakeAdmin()

    const result = await syncUserTypes(admin)

    expect(result).toEqual({ typesChecked: 0, categoriesUpdated: 0, typeFetchFailed: 1 })
  })

  it('counts a network-error page as failed without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )

    const { admin } = fakeAdmin()

    const result = await syncUserTypes(admin)

    expect(result).toEqual({ typesChecked: 0, categoriesUpdated: 0, typeFetchFailed: 1 })
  })

  it('updates only the category column and stores the normalized canonical value', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: true,
          data: [
            { number: '111', user_type: 'paid' },
            { number: '222', user_type: 'Day Pass' },
            { number: '333', user_type: 'Free Expired' },
          ],
        }),
      ),
    )

    const patches: Array<Record<string, unknown>> = []
    const admin = {
      from: () => ({
        select: () =>
          Promise.resolve({
            data: [{ mobile: '111' }, { mobile: '222' }, { mobile: '333' }],
            error: null,
          }),
        update: (patch: Record<string, unknown>) => {
          patches.push(patch)
          return { eq: () => Promise.resolve({ data: null, error: null }) }
        },
      }),
    } as unknown as FakeAdmin

    await syncUserTypes(admin)

    expect(patches).toEqual([
      { category: 'Paid' },
      { category: 'Day Pass' },
      { category: 'Free Expired' },
    ])
  })

  it('normalizes every known user_type to its canonical category', async () => {
    const cases: Array<{ raw: string; canonical: string }> = [
      { raw: 'premium', canonical: 'Premium' },
      { raw: 'Premium', canonical: 'Premium' },
      { raw: 'paid', canonical: 'Paid' },
      { raw: 'Paid', canonical: 'Paid' },
      { raw: 'free', canonical: 'Free' },
      { raw: 'free expired', canonical: 'Free Expired' },
      { raw: 'day pass', canonical: 'Day Pass' },
      { raw: 'premium expired', canonical: 'Premium Expired' },
      { raw: 'no trader', canonical: 'No Trader' },
    ]

    const records = cases.map(({ raw }, i) => ({ number: `${i + 1}00`, user_type: raw }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: true, data: records })),
    )

    const { admin, updates } = fakeAdmin(
      cases.map((_, i) => ({ mobile: `${i + 1}00` })),
    )

    const result = await syncUserTypes(admin)

    const expectedUpdates: Record<string, string> = {}
    cases.forEach(({ canonical }, i) => {
      expectedUpdates[`${i + 1}00`] = canonical
    })
    expect(updates).toEqual(expectedUpdates)
    expect(result).toEqual({
      typesChecked: cases.length,
      categoriesUpdated: cases.length,
      typeFetchFailed: 0,
    })
  })

  it('preserves the existing normalization behaviour for unknown user_type values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          status: true,
          data: [{ number: '111', user_type: 'platinum' }],
        }),
      ),
    )

    const { admin, updates } = fakeAdmin([{ mobile: '111' }])

    await syncUserTypes(admin)

    expect(updates).toEqual({ 111: 'Platinum' })
  })

  it('counts a Supabase update error as failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: true, data: [{ number: '111', user_type: 'Free' }] })),
    )

    const admin = {
      from: () => ({
        select: () => Promise.resolve({ data: [{ mobile: '111' }], error: null }),
        update: () => ({
          eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
        }),
      }),
    } as unknown as FakeAdmin

    const result = await syncUserTypes(admin)

    expect(result).toEqual({ typesChecked: 1, categoriesUpdated: 0, typeFetchFailed: 1 })
  })

  it('returns zeros when the local mobile query fails', async () => {
    const admin = {
      from: () => ({
        select: () => Promise.resolve({ data: null, error: { message: 'rls denied' } }),
      }),
    } as unknown as FakeAdmin

    const result = await syncUserTypes(admin)

    expect(result).toEqual({ typesChecked: 0, categoriesUpdated: 0, typeFetchFailed: 0 })
  })

  it('checks every record exactly once, even across batches', async () => {
    let callCount = 0
    const fetchMock = vi.fn(async () => {
      callCount += 1
      return jsonResponse({
        status: true,
        data: Array.from({ length: 8 }, (_, i) => ({
          number: `${i + 1}00`,
          user_type: 'Free',
        })),
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { admin, updates } = fakeAdmin(
      Array.from({ length: 8 }, (_, i) => ({ mobile: `${i + 1}00` })),
    )

    const result = await syncUserTypes(admin)

    expect(result).toEqual({ typesChecked: 8, categoriesUpdated: 8, typeFetchFailed: 0 })
    expect(callCount).toBe(1)
    expect(Object.keys(updates).length).toBe(8)
  })
})
