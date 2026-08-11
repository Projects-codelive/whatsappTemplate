import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { isNotificationCategory } from '@/lib/notifications/categories'
import { resolveRecipientScope } from '@/lib/notifications/recipient-scope'
import type { RecipientCountRequest, RecipientCountResponse } from '@/types'

/**
 * Lightweight exact-count endpoint for the Send Notification modal.
 *
 * Resolves the same target scope as the send route (shared
 * `resolveRecipientScope`, so "Premium" reaches both Premium and Paid rows)
 * and returns a single exact count — never a downloaded table.
 *
 * The count represents the resolved recipient set before FCM-token
 * filtering. A user with no valid FCM token is matched here but skipped
 * by the send route (which reports it as `skipped`). This mirrors the
 * send route's resolution and keeps the query a cheap exact count.
 */

interface RecipientCountBody {
  target?: unknown
  userIds?: unknown
  category?: unknown
}

type CountValidationResult =
  | { ok: true; payload: RecipientCountRequest }
  | { ok: false; error: string; status: number }

function validateCountRequest(body: RecipientCountBody): CountValidationResult {
  if (body.target === 'selected') {
    const userIds = Array.isArray(body.userIds)
      ? body.userIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
      : []
    if (userIds.length === 0) {
      return { ok: false, error: 'Select at least one user', status: 400 }
    }
    return { ok: true, payload: { target: 'selected', userIds } }
  }

  if (body.target === 'all') {
    return { ok: true, payload: { target: 'all' } }
  }

  if (body.target === 'category') {
    const category = typeof body.category === 'string' ? body.category.trim() : ''
    if (!category) {
      return { ok: false, error: 'Select a category', status: 400 }
    }
    if (!isNotificationCategory(category)) {
      return { ok: false, error: 'Invalid notification category', status: 400 }
    }
    return { ok: true, payload: { target: 'category', category } }
  }

  return { ok: false, error: 'Invalid notification target', status: 400 }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: RecipientCountBody
    try {
      body = (await request.json()) as RecipientCountBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const validation = validateCountRequest(body)
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: validation.status })
    }

    const scope = resolveRecipientScope(validation.payload)

    const query = supabaseAdmin().from('users').select('*', { count: 'exact', head: true })
    if (scope.column) {
      query.in(scope.column, scope.values)
    }

    const { count, error } = await query
    if (error) {
      console.error(
        '[notifications/recipient-count] failed to count users:',
        error.message,
      )
      return NextResponse.json(
        { error: `Failed to count users: ${error.message}` },
        { status: 500 },
      )
    }

    const response: RecipientCountResponse = { count: count ?? 0 }
    return NextResponse.json(response)
  } catch (error) {
    console.error('[notifications/recipient-count] unexpected error:', error)
    return NextResponse.json({ error: 'Failed to count recipients' }, { status: 500 })
  }
}
