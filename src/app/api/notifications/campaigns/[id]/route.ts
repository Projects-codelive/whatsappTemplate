import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'

/**
 * DELETE /api/notifications/campaigns/[id]
 *
 * Deletes a notification campaign and its recipients (cascaded).
 * Only the campaign owner can delete.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Verify ownership before delete.
    const { data: campaign, error: fetchError } = await supabaseAdmin()
      .from('notification_campaigns')
      .select('id, status')
      .eq('id', id)
      .eq('user_id', user.id)
      .single()

    if (fetchError || !campaign) {
      return NextResponse.json(
        { error: 'Campaign not found' },
        { status: 404 },
      )
    }

    if (campaign.status === 'sending') {
      return NextResponse.json(
        { error: 'Cannot delete a campaign that is still sending' },
        { status: 400 },
      )
    }

    // Delete — recipients cascade via FK.
    const { error: deleteError } = await supabaseAdmin()
      .from('notification_campaigns')
      .delete()
      .eq('id', id)

    if (deleteError) {
      return NextResponse.json(
        { error: `Failed to delete: ${deleteError.message}` },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('[notifications/campaigns/delete] unexpected error:', error)
    return NextResponse.json(
      { error: 'Failed to delete campaign' },
      { status: 500 },
    )
  }
}
