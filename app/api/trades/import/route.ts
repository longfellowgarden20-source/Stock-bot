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

// ─── Types ────────────────────────────────────────────────────────────────────

export type ParsedRow = {
  activityDate: string   // MM/DD/YYYY
  instrument: string
  transCode: string
  quantity: number
  price: number
  amount: number
}

type MatchedTrade = {
  date: string           // YYYY-MM-DD
  ticker: string
  direction: 'long' | 'short'
  entry_price: number
  exit_price: number | null
  shares: number
  pnl: number | null
}

const IMPORT_CODES = new Set(['Buy', 'Sell', 'BTO', 'STO', 'BTC', 'STC'])

function parseDate(mmddyyyy: string): string {
  const parts = mmddyyyy.trim().split('/')
  if (parts.length !== 3) return mmddyyyy
  const [mm, dd, yyyy] = parts
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
}

// ─── FIFO matching ────────────────────────────────────────────────────────────

function matchTrades(rows: ParsedRow[]): { matched: MatchedTrade[]; open: MatchedTrade[] } {
  // Group by instrument
  const byTicker: Record<string, ParsedRow[]> = {}
  for (const row of rows) {
    if (!IMPORT_CODES.has(row.transCode)) continue
    const key = row.instrument.toUpperCase()
    if (!byTicker[key]) byTicker[key] = []
    byTicker[key].push(row)
  }

  const matched: MatchedTrade[] = []
  const open: MatchedTrade[] = []

  for (const [ticker, tickerRows] of Object.entries(byTicker)) {
    // Sort chronologically
    const sorted = [...tickerRows].sort((a, b) => {
      return new Date(parseDate(a.activityDate)).getTime() - new Date(parseDate(b.activityDate)).getTime()
    })

    // Separate into buy-side and sell-side queues
    // Long: Buy/BTO are entries, Sell/STC are exits
    // Short: STO are entries, BTC are exits
    const longBuys: ParsedRow[] = []  // Buy, BTO
    const longSells: ParsedRow[] = [] // Sell, STC
    const shortSells: ParsedRow[] = [] // STO
    const shortBuys: ParsedRow[] = []  // BTC

    for (const row of sorted) {
      if (row.transCode === 'Buy' || row.transCode === 'BTO') longBuys.push(row)
      else if (row.transCode === 'Sell' || row.transCode === 'STC') longSells.push(row)
      else if (row.transCode === 'STO') shortSells.push(row)
      else if (row.transCode === 'BTC') shortBuys.push(row)
    }

    // Match long trades FIFO
    const remainingBuys = longBuys.map((r) => ({ ...r, remaining: r.quantity }))
    const remainingSells = longSells.map((r) => ({ ...r, remaining: r.quantity }))

    let bi = 0
    let si = 0
    while (bi < remainingBuys.length && si < remainingSells.length) {
      const buy = remainingBuys[bi]
      const sell = remainingSells[si]
      const qty = Math.min(buy.remaining, sell.remaining)

      const pnl = Math.round(((sell.price - buy.price) * qty) * 100) / 100
      matched.push({
        date: parseDate(buy.activityDate),
        ticker,
        direction: 'long',
        entry_price: buy.price,
        exit_price: sell.price,
        shares: qty,
        pnl,
      })

      buy.remaining -= qty
      sell.remaining -= qty
      if (buy.remaining <= 0) bi++
      if (sell.remaining <= 0) si++
    }

    // Remaining buys without sells = open long positions
    while (bi < remainingBuys.length) {
      const buy = remainingBuys[bi]
      if (buy.remaining > 0) {
        open.push({
          date: parseDate(buy.activityDate),
          ticker,
          direction: 'long',
          entry_price: buy.price,
          exit_price: null,
          shares: buy.remaining,
          pnl: null,
        })
      }
      bi++
    }

    // Match short trades FIFO
    const remainingShortEntries = shortSells.map((r) => ({ ...r, remaining: r.quantity }))
    const remainingShortExits = shortBuys.map((r) => ({ ...r, remaining: r.quantity }))

    let sei = 0
    let sxi = 0
    while (sei < remainingShortEntries.length && sxi < remainingShortExits.length) {
      const entry = remainingShortEntries[sei]
      const exit = remainingShortExits[sxi]
      const qty = Math.min(entry.remaining, exit.remaining)

      const pnl = Math.round(((entry.price - exit.price) * qty) * 100) / 100
      matched.push({
        date: parseDate(entry.activityDate),
        ticker,
        direction: 'short',
        entry_price: entry.price,
        exit_price: exit.price,
        shares: qty,
        pnl,
      })

      entry.remaining -= qty
      exit.remaining -= qty
      if (entry.remaining <= 0) sei++
      if (exit.remaining <= 0) sxi++
    }

    // Remaining short entries without exits = open short positions
    while (sei < remainingShortEntries.length) {
      const entry = remainingShortEntries[sei]
      if (entry.remaining > 0) {
        open.push({
          date: parseDate(entry.activityDate),
          ticker,
          direction: 'short',
          entry_price: entry.price,
          exit_price: null,
          shares: entry.remaining,
          pnl: null,
        })
      }
      sei++
    }
  }

  return { matched, open }
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: { rows: ParsedRow[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { rows } = body
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: 'No rows provided' }, { status: 400 })
  }

  const { matched, open } = matchTrades(rows)
  const allTrades = [...matched, ...open]

  if (allTrades.length === 0) {
    return NextResponse.json({ imported: 0, open: 0, skipped: rows.length, trades: [] })
  }

  const db = getDb()

  // Insert all trades
  const inserts = allTrades.map((t) => ({
    date: t.date,
    ticker: t.ticker,
    direction: t.direction,
    entry_price: t.entry_price,
    exit_price: t.exit_price,
    shares: t.shares,
    pnl: t.pnl,
    pattern: null,
    grade: null,
    grade_accurate: null,
    writeup: null,
    mistakes: null,
    best_ops: null,
  }))

  const { data, error } = await db
    .from('trades')
    .insert(inserts)
    .select()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const skipped = rows.filter((r) => !IMPORT_CODES.has(r.transCode)).length

  return NextResponse.json({
    imported: matched.length,
    open: open.length,
    skipped,
    trades: data ?? [],
  }, { status: 201 })
}
