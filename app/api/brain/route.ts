import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function sb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// GET — fetch all brain data
export async function GET() {
  const supabase = sb()

  const [lessons, critiques, outlooks, watchlistNotes] = await Promise.all([
    // Ticker-specific lessons (not GROQ_SELF)
    supabase
      .from('prediction_lessons')
      .select('*')
      .neq('ticker', 'GROQ_SELF')
      .order('date', { ascending: false })
      .limit(100),

    // Self-critiques
    supabase
      .from('prediction_lessons')
      .select('*')
      .eq('ticker', 'GROQ_SELF')
      .order('date', { ascending: false })
      .limit(14),

    // Morning outlooks
    supabase
      .from('market_outlooks')
      .select('*')
      .order('date', { ascending: false })
      .limit(14),

    // Watchlist notes (user-fed info)
    supabase
      .from('watchlist')
      .select('ticker, notes')
      .not('notes', 'is', null)
      .neq('notes', ''),
  ])

  // User-injected brain notes
  const { data: brainNotes } = await supabase
    .from('brain_notes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)

  return NextResponse.json({
    lessons: lessons.data ?? [],
    critiques: critiques.data ?? [],
    outlooks: outlooks.data ?? [],
    watchlist_notes: watchlistNotes.data ?? [],
    brain_notes: brainNotes ?? [],
  })
}

// POST — add a brain note (user feeds Groq info)
export async function POST(req: NextRequest) {
  const { content, ticker, category } = await req.json().catch(() => ({}))
  if (!content?.trim()) return NextResponse.json({ error: 'content required' }, { status: 400 })

  const { data, error } = await sb()
    .from('brain_notes')
    .insert({
      content: content.trim().slice(0, 1000),
      ticker: ticker?.trim().toUpperCase() || null,
      category: category || 'general',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, note: data })
}

// DELETE — remove a brain note
export async function DELETE(req: NextRequest) {
  const { id } = await req.json().catch(() => ({}))
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  await sb().from('brain_notes').delete().eq('id', id)
  return NextResponse.json({ ok: true })
}
