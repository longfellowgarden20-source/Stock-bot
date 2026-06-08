import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getDb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function POST(req: NextRequest) {
  const { trades } = await req.json() as { trades: Record<string, unknown>[] }

  if (!trades || trades.length === 0) {
    return NextResponse.json({ error: 'No trades provided' }, { status: 400 })
  }

  const groqKeys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_BACKUP_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ].filter(Boolean) as string[]
  if (groqKeys.length === 0) return NextResponse.json({ error: 'No GROQ keys configured' }, { status: 500 })
  // Round-robin: use request timestamp to spread load
  const groqApiKey = groqKeys[Math.floor(Date.now() / 1000) % groqKeys.length]

  const closedTrades = trades.filter((t) => t.pnl != null)
  const winCount = closedTrades.filter((t) => (t.pnl as number) > 0).length
  const winRate = closedTrades.length > 0 ? (winCount / closedTrades.length) * 100 : 0

  const tradesSummary = trades.map((t) => {
    return `${t.date} | ${t.ticker} | ${t.direction} | Entry: ${t.entry_price} | Exit: ${t.exit_price ?? 'open'} | P&L: ${t.pnl != null ? `$${t.pnl}` : 'open'} | Grade: ${t.grade ?? 'N/A'} | Pattern: ${t.pattern ?? 'none'} | Mistakes: ${Array.isArray(t.mistakes) && t.mistakes.length > 0 ? (t.mistakes as string[]).join(', ') : 'none'} | Writeup: ${t.writeup ?? ''}`
  }).join('\n')

  const prompt = `You are a trading performance coach. Analyze these trades and writeups. Find patterns, recurring mistakes, and tendencies. Be specific and direct. Call out exact patterns by name. Format: 2-3 paragraphs. First: what's working. Second: recurring mistakes/tendencies with exact counts. Third: one specific thing to focus on this week.

Trades (${closedTrades.length} closed, ${winRate.toFixed(1)}% win rate):
${tradesSummary}`

  let noteText = ''
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
        temperature: 0.7,
      }),
    })

    if (!groqRes.ok) {
      const err = await groqRes.text()
      return NextResponse.json({ error: `Groq error: ${err}` }, { status: 500 })
    }

    const groqData = await groqRes.json() as { choices: { message: { content: string } }[] }
    noteText = groqData.choices?.[0]?.message?.content ?? ''
    if (!noteText) return NextResponse.json({ error: 'Groq returned empty response' }, { status: 502 })
  } catch (e) {
    return NextResponse.json({ error: `Groq fetch failed: ${String(e)}` }, { status: 500 })
  }

  // Tally tendencies from mistakes
  const mistakeCounts: Record<string, number> = {}
  for (const t of trades) {
    if (Array.isArray(t.mistakes)) {
      for (const m of t.mistakes as string[]) {
        mistakeCounts[m] = (mistakeCounts[m] ?? 0) + 1
      }
    }
  }

  const db = getDb()
  const { data: saved, error: dbErr } = await db
    .from('coaching_notes')
    .insert({
      period: `Last ${trades.length} trades`,
      note: noteText,
      tendencies: mistakeCounts,
      trade_count: trades.length,
      win_rate: Math.round(winRate * 100) / 100,
    })
    .select()
    .single()

  if (dbErr) return NextResponse.json({ error: dbErr.message }, { status: 500 })
  return NextResponse.json(saved)
}
