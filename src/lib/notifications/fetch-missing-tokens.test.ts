import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  backfillMissingFcmTokens,
  fetchUserFcmToken,
  type MissingTokenUser,
} from './fetch-missing-tokens'

const VALID_TOKEN = 'x'.repeat(160)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchUserFcmToken', () => {
  it('posts the mobile with the shared API key and returns the token', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://niveshbay.com/api/v1/user.php')
      expect(init.method).toBe('POST')
      expect((init.headers as Record<string, string>)['X-API-KEY']).toBe(
        'NBCOURSE_2026@Secure#API',
      )
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      )
      expect(String(init.body)).toBe('mobile=9876543210')
      return jsonResponse({ status: true, data: { fcm_token: VALID_TOKEN } })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchUserFcmToken('9876543210')).resolves.toBe(VALID_TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws when the API reports status=false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: false, message: 'User not found.' })),
    )
    await expect(fetchUserFcmToken('9876543210')).rejects.toThrow(/User not found/)
  })

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: true, data: {} }, 500)),
    )
    await expect(fetchUserFcmToken('9876543210')).rejects.toThrow(/HTTP 500/)
  })

  it('throws when the response has no fcm_token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: true, data: { fcm_token: '' } })),
    )
    await expect(fetchUserFcmToken('9876543210')).rejects.toThrow(/no fcm_token/)
  })

  it('throws when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('not json', { status: 200 })),
    )
    await expect(fetchUserFcmToken('9876543210')).rejects.toThrow(/invalid response/)
  })

  it('throws when the network fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )
    await expect(fetchUserFcmToken('9876543210')).rejects.toThrow(/Network error/)
  })
})

type FakeAdmin = Parameters<typeof backfillMissingFcmTokens>[0]

function fakeAdmin() {
  const updates: Record<string, string> = {}
  const admin = {
    from: (table: string) => {
      if (table !== 'users') throw new Error(`unexpected table ${table}`)
      return {
        update: (patch: Record<string, unknown>) => ({
          eq: (column: string, value: string) => {
            updates[value] = patch.fcm_token as string
            return Promise.resolve({ data: null, error: null })
          },
        }),
      }
    },
  } as unknown as FakeAdmin
  return { admin, updates }
}

describe('backfillMissingFcmTokens', () => {
  it('updates tokens for every reachable user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: true, data: { fcm_token: VALID_TOKEN } })),
    )
    const { admin, updates } = fakeAdmin()
    const users: MissingTokenUser[] = [
      { id: 'u1', mobile: '9876543210' },
      { id: 'u2', mobile: '9812345670' },
    ]

    const result = await backfillMissingFcmTokens(admin, users)

    expect(result).toEqual({ checkedForFcm: 2, tokensUpdated: 2, tokenFetchFailed: 0 })
    expect(updates).toEqual({ u1: VALID_TOKEN, u2: VALID_TOKEN })
  })

  it('counts not-found, no-mobile and error users as failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = String(init?.body ?? '')
        if (body === 'mobile=987') {
          return jsonResponse({ status: false, message: 'User not found.' })
        }
        return jsonResponse({ status: true, data: { fcm_token: VALID_TOKEN } })
      }),
    )
    const { admin, updates } = fakeAdmin()
    const users: MissingTokenUser[] = [
      { id: 'u1', mobile: '987' },
      { id: 'u2', mobile: null },
      { id: 'u3', mobile: '555' },
    ]

    const result = await backfillMissingFcmTokens(admin, users)

    expect(result).toEqual({ checkedForFcm: 3, tokensUpdated: 1, tokenFetchFailed: 2 })
    expect(updates).toEqual({ u3: VALID_TOKEN })
  })

  it('updates only the fcm_token field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: true, data: { fcm_token: VALID_TOKEN } })),
    )
    let patchSeen: Record<string, unknown> | undefined
    const admin = {
      from: () => ({
        update: (patch: Record<string, unknown>) => {
          patchSeen = patch
          return { eq: () => Promise.resolve({ data: null, error: null }) }
        },
      }),
    } as unknown as FakeAdmin

    await backfillMissingFcmTokens(admin, [{ id: 'u1', mobile: '9876543210' }])

    expect(patchSeen).toEqual({ fcm_token: VALID_TOKEN })
  })

  it('counts a Supabase update error as failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ status: true, data: { fcm_token: VALID_TOKEN } })),
    )
    const admin = {
      from: () => ({
        update: () => ({
          eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
        }),
      }),
    } as unknown as FakeAdmin

    const result = await backfillMissingFcmTokens(admin, [
      { id: 'u1', mobile: '9876543210' },
    ])

    expect(result).toEqual({ checkedForFcm: 1, tokensUpdated: 0, tokenFetchFailed: 1 })
  })

  it('checks each user exactly once, even across batches', async () => {
    let callCount = 0
    const seenBodies = new Set<string>()
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      callCount += 1
      seenBodies.add(String(init?.body))
      return jsonResponse({ status: true, data: { fcm_token: VALID_TOKEN } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { admin } = fakeAdmin()
    const users: MissingTokenUser[] = Array.from({ length: 8 }, (_, i) => ({
      id: `u${i}`,
      mobile: `99${i}`,
    }))

    const result = await backfillMissingFcmTokens(admin, users)

    expect(result).toEqual({ checkedForFcm: 8, tokensUpdated: 8, tokenFetchFailed: 0 })
    expect(callCount).toBe(8)
    expect(seenBodies.size).toBe(8)
  })
})
