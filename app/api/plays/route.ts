import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { callGroqWithFallback } from '@/lib/groq-client'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { ticker, direction, thesis, timeframe } = body as {
      ticker?: string
      direction?: string
      thesis?: string
      timeframe?: string
    }

    if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })

    const sym = ticker.trim().toUpperCase()

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Pull recent signals for this ticker (last 7 days)
    const since7d = new Date(Date.now() - 7 * 86400_000).toISOString()
    const { data: signals } = await supabase
      .from('signals')
      .select('signal_type,severity,title,body,created_at')
      .eq('ticker', sym)
      .gte('created_at', since7d)
      .order('created_at', { ascending: false })
      .limit(20)

    // Pull latest snapshot
    const { data: snap } = await supabase
      .from('snapshots')
      .select('price,change_pct,volume,created_at')
      .eq('ticker', sym)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    // Pull recent news headlines
    const { data: news } = await supabase
      .from('news')
      .select('headline,source,published_at,sentiment')
      .eq('ticker', sym)
      .order('published_at', { ascending: false })
      .limit(8)

    // Pull sandbox lessons for this ticker
    const { data: lessons } = await supabase
      .from('prediction_lessons')
      .select('date,bias,actual_bias,in_range,lesson,confidence_pct')
      .eq('ticker', sym)
      .order('date', { ascending: false })
      .limit(5)

    // Build context blocks
    const signalBlock = signals && signals.length > 0
      ? signals.map(s => `[${s.signal_type.toUpperCase()} | sev ${s.severity} | ${new Date(s.created_at).toLocaleDateString()}]\n  ${s.title}\n  ${s.body?.slice(0, 150)}`).join('\n\n')
      : 'No recent signals.'

    const priceBlock = snap
      ? `Current price: $${Number(snap.price).toFixed(2)} | Change: ${Number(snap.change_pct) >= 0 ? '+' : ''}${Number(snap.change_pct).toFixed(2)}% | Volume: ${snap.volume?.toLocaleString() ?? 'N/A'}`
      : 'No price data available.'

    const newsBlock = news && news.length > 0
      ? news.map(n => `[${n.sentiment?.toUpperCase() ?? 'NEUTRAL'}] ${n.headline} — ${n.source}`).join('\n')
      : 'No recent news.'

    const lessonsBlock = lessons && lessons.length > 0
      ? lessons.map(l => {
          const correct = l.bias === l.actual_bias && l.in_range
          return `${l.date}: predicted ${l.bias}, actual ${l.actual_bias} [${correct ? 'CORRECT' : 'WRONG'}]${l.lesson ? ` — ${l.lesson.slice(0, 120)}` : ''}`
        }).join('\n')
      : 'No prediction history.'

    const userThesis = thesis?.trim()
      ? `\nTRADER'S THESIS: ${thesis.trim()}`
      : ''

    const prompt = `You are a senior trading analyst. A trader wants to ${direction?.toUpperCase() ?? 'LONG'} ${sym} over a ${timeframe ?? 'swing'} timeframe.${userThesis}

CURRENT PRICE DATA:
${priceBlock}

RECENT SIGNALS (last 7 days, sorted newest first):
${signalBlock}

RECENT NEWS:
${newsBlock}

PAST PREDICTION ACCURACY FOR ${sym}:
${lessonsBlock}

Analyze the data objectively and give your honest recommendation. Your recommended direction should be whatever the DATA supports — if the signals support the trader's direction, confirm it. If the signals clearly contradict it, say so. Do NOT default to disagreeing with the trader.

Cover ALL of these sections:

**RECOMMENDED DIRECTION**: LONG or SHORT — based purely on the signals and data above. If the data supports the trader's chosen direction (${direction?.toUpperCase() ?? 'LONG'}), confirm it and explain why. Only recommend the opposite if the data clearly contradicts their direction.

**BULL CASE**: Key levels, catalysts, and signals that support a long trade.

**BEAR CASE**: Key levels, catalysts, and signals that support a short trade.

**ENTRY**: For your recommended direction — exact price or range. Enter now or wait for confirmation?

**STOP LOSS**: Exact price and why that level invalidates the trade.

**TARGET**: Target 1 (partial profit) and Target 2 (full target). Specific prices.

**RISK/REWARD**: R:R based on your entry, stop, and targets.

**RISKS**: Top 2-3 things that kill this trade.

**CONVICTION**: 1-10. Be honest about setup quality.

Specific prices only. No generic advice.`

    const analysis = await callGroqWithFallback(groq =>
      groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1200,
        temperature: 0.3,
      }).then(c => c.choices[0]?.message?.content ?? 'Analysis unavailable.')
    )

    return NextResponse.json({
      analysis,
      ticker: sym,
      price: snap?.price ?? null,
      change_pct: snap?.change_pct ?? null,
      signal_count: signals?.length ?? 0,
      news_count: news?.length ?? 0,
    })
  } catch (err) {
    console.error('[plays]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
