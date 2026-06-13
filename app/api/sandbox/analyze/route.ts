import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { callGroqWithFallback } from '@/lib/groq-client'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { trade_id } = await req.json().catch(() => ({}))
    if (!trade_id) return NextResponse.json({ error: 'trade_id required' }, { status: 400 })

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch the trade
    const { data: trade, error } = await supabase
      .from('sandbox_trades')
      .select('*')
      .eq('id', trade_id)
      .single()

    if (error || !trade) return NextResponse.json({ error: 'Trade not found' }, { status: 404 })

    const ticker = trade.ticker

    // Fetch snapshots around the trade period for P&L simulation
    const entryDate = new Date(trade.entry_date + 'T09:30:00Z')
    // For closed trades: include full exit day. For open trades: use now, no +1.
    const endDate = trade.exit_date
      ? (() => { const d = new Date(trade.exit_date + 'T23:59:00Z'); d.setDate(d.getDate() + 1); return d })()
      : new Date()

    const { data: snapshots } = await supabase
      .from('snapshots')
      .select('price,change_pct,created_at')
      .eq('ticker', ticker)
      .gte('created_at', entryDate.toISOString())
      .lte('created_at', endDate.toISOString())
      .order('created_at', { ascending: true })
      .limit(200)

    // Build P&L curve from snapshots
    const entry = Number(trade.entry_price)
    const direction = trade.direction
    const pnlCurve = (snapshots ?? []).map(s => {
      const price = Number(s.price)
      const pct = direction === 'long'
        ? (price - entry) / entry * 100
        : (entry - price) / entry * 100
      return {
        time: s.created_at,
        price: Number(price.toFixed(2)),
        pnl_pct: Number(pct.toFixed(3)),
        pnl_dollar: Number((pct / 100 * entry * Number(trade.shares)).toFixed(2)),
      }
    })

    // Fetch signals at/around entry date
    const signalWindow = new Date(entryDate)
    signalWindow.setDate(signalWindow.getDate() - 1)
    const { data: signals } = await supabase
      .from('signals')
      .select('signal_type,severity,title,body,created_at')
      .eq('ticker', ticker)
      .gte('created_at', signalWindow.toISOString())
      .lte('created_at', endDate.toISOString())
      .order('severity', { ascending: false })
      .limit(15)

    // Past sandbox trades on this ticker for pattern analysis
    const { data: pastTrades } = await supabase
      .from('sandbox_trades')
      .select('entry_date,direction,entry_price,exit_price,pnl_pct,exit_reason,groq_thesis')
      .eq('ticker', ticker)
      .eq('status', 'closed')
      .neq('id', trade_id)
      .order('entry_date', { ascending: false })
      .limit(5)

    // Build prompt context
    const isOpen = trade.status === 'open'
    const currentPnl = pnlCurve.length > 0 ? pnlCurve[pnlCurve.length - 1] : null
    const maxPnl = pnlCurve.length > 0 ? Math.max(...pnlCurve.map(p => p.pnl_pct)) : null
    const minPnl = pnlCurve.length > 0 ? Math.min(...pnlCurve.map(p => p.pnl_pct)) : null

    const signalBlock = (signals ?? []).length > 0
      ? signals!.map(s => `[${s.signal_type} | sev ${s.severity}] ${s.title}`).join('\n')
      : 'No signals found.'

    const pastBlock = (pastTrades ?? []).length > 0
      ? pastTrades!.map(t => {
          const outcome = (t.pnl_pct ?? 0) > 0 ? 'WIN' : 'LOSS'
          return `${t.entry_date} ${t.direction} @ $${t.entry_price} → ${outcome} ${(t.pnl_pct ?? 0).toFixed(1)}% (${t.exit_reason ?? '?'}) — "${t.groq_thesis?.slice(0, 80) ?? ''}"`
        }).join('\n')
      : 'No prior trades on this ticker.'

    const tradeStatus = isOpen
      ? `OPEN — entered ${trade.entry_date}, currently at ${currentPnl ? `${currentPnl.pnl_pct > 0 ? '+' : ''}${currentPnl.pnl_pct.toFixed(2)}% ($${currentPnl.price})` : 'unknown'}`
      : `CLOSED — ${trade.exit_reason} on ${trade.exit_date} at $${trade.exit_price} (${(trade.pnl_pct ?? 0) > 0 ? '+' : ''}${(trade.pnl_pct ?? 0).toFixed(2)}%)`

    const pnlContext = pnlCurve.length > 0
      ? `Max gain during trade: ${maxPnl?.toFixed(2)}% | Max drawdown: ${minPnl?.toFixed(2)}% | Data points: ${pnlCurve.length}`
      : 'No price data available for this period.'

    // Contract math for the breakdown section
    const entryNum = Number(trade.entry_price)
    const stopNum = Number(trade.stop_loss)
    const targetNum = Number(trade.target_price)
    const sharesNum = Number(trade.shares) || 1
    const capitalDeployed = Math.round(entryNum * sharesNum * 100) / 100
    const riskPerShare = Math.max(0, trade.direction === 'long' ? entryNum - stopNum : stopNum - entryNum)
    const rewardPerShare = Math.max(0, trade.direction === 'long' ? targetNum - entryNum : entryNum - targetNum)
    const maxLossDollar = Math.round(riskPerShare * sharesNum * 100) / 100
    const maxGainDollar = Math.round(rewardPerShare * sharesNum * 100) / 100
    const maxLossPct = entryNum > 0 ? Math.round(riskPerShare / entryNum * 10000) / 100 : 0
    const maxGainPct = entryNum > 0 ? Math.round(rewardPerShare / entryNum * 10000) / 100 : 0
    const rrRatio = riskPerShare > 0 ? Math.round(rewardPerShare / riskPerShare * 100) / 100 : 0

    const prompt = `You are a senior trading coach reviewing a ${trade.direction.toUpperCase()} trade on ${ticker}.

CONTRACT BREAKDOWN:
Direction: ${trade.direction.toUpperCase()} | Type: ${trade.trade_type} | Shares: ${sharesNum}
Entry: $${entryNum.toFixed(2)} | Stop: $${stopNum.toFixed(2)} | Target: $${targetNum.toFixed(2)}
Capital deployed: $${capitalDeployed.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Max loss: -$${maxLossDollar.toFixed(2)} (${maxLossPct.toFixed(2)}% of position)
Max gain at target: +$${maxGainDollar.toFixed(2)} (+${maxGainPct.toFixed(2)}% of position)
Reward-to-risk: ${rrRatio}:1

TRADE STATUS:
${tradeStatus}

ORIGINAL THESIS:
"${trade.groq_thesis ?? 'No thesis recorded'}"

P&L JOURNEY:
${pnlContext}

SIGNALS AROUND ENTRY:
${signalBlock}

PAST TRADES ON ${ticker}:
${pastBlock}

Write a detailed trade review covering:

**CONTRACT BREAKDOWN**: In plain English, explain exactly what this trade was — what it cost to enter, what the maximum loss would be, and what the return at target looks like. Make it clear like a brief to a new trader.

**TRADE QUALITY**: Was this a good entry? Was the setup valid based on the signals? Rate the entry quality 1-10.

**WHAT WENT RIGHT**: What signals or factors supported this trade? What did the setup do correctly?

**WHAT WENT WRONG**: ${isOpen ? 'What risks are developing? What should the trader watch?' : `Why did the trade ${(trade.pnl_pct ?? 0) > 0 ? 'work' : 'fail'}? What could have been done differently?`}

**P&L ANALYSIS**: Comment on the price action — did it reach the target, get stopped out, or close at EOD? Was the stop placement appropriate given the actual move?

**KEY LESSON**: The single most important lesson from this trade for future setups on ${ticker} or similar setups.

**NEXT SETUP**: Given everything you know, if a similar setup appeared on ${ticker} again, what would you do differently? Give specific adjustments to entry, stop, or target.

Be direct, specific, and trader-focused. Reference actual prices and percentages.`

    const analysis = await callGroqWithFallback(groq =>
      groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1200,
        temperature: 0.3,
      }).then(c => c.choices[0]?.message?.content ?? 'Analysis unavailable.')
    )

    return NextResponse.json({ analysis, pnl_curve: pnlCurve, trade })
  } catch (err) {
    console.error('[sandbox/analyze]', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal error' }, { status: 500 })
  }
}
