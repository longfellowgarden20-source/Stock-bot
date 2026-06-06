import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { callGroqWithFallback } from '@/lib/groq-client'

export const dynamic = 'force-dynamic'

type RawData = Record<string, unknown>

interface SourceLink {
  title: string
  url: string
  type: 'news' | 'sec_filing' | 'analyst' | 'reddit' | 'other'
}

const URL_FIELDS = ['url', 'article_url', 'news_url', 'source_url', 'filing_url', 'link']

function classifyUrl(url: string, key: string): SourceLink['type'] {
  if (key === 'filing_url' || url.includes('sec.gov') || url.includes('edgar')) return 'sec_filing'
  if (url.includes('reddit.com')) return 'reddit'
  if (key === 'article_url' || key === 'news_url' || url.includes('news') || url.includes('article')) return 'news'
  if (key === 'analyst' || url.includes('finnhub') || url.includes('analyst')) return 'analyst'
  return 'other'
}

function extractUrls(raw: RawData, ticker: string): SourceLink[] {
  const found: SourceLink[] = []
  const seen = new Set<string>()

  function walk(obj: unknown, depth = 0) {
    if (depth > 4 || !obj || typeof obj !== 'object') return
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && v.startsWith('http') && URL_FIELDS.includes(k)) {
        if (!seen.has(v)) {
          seen.add(v)
          found.push({
            title: (obj as Record<string, string>).title || (obj as Record<string, string>).headline || ticker + ' — ' + k.replace(/_/g, ' '),
            url: v,
            type: classifyUrl(v, k),
          })
        }
      } else if (typeof v === 'object') {
        walk(v, depth + 1)
      }
    }
  }

  walk(raw)
  return found
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { signal_id } = body as { signal_id?: string }

    if (!signal_id) {
      return NextResponse.json({ error: 'signal_id required' }, { status: 400 })
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch the primary signal
    const { data: signal, error } = await supabase
      .from('signals')
      .select('*')
      .eq('id', signal_id)
      .single()

    if (error || !signal) {
      return NextResponse.json({ error: 'Signal not found' }, { status: 404 })
    }

    const ticker: string = signal.ticker

    // Fetch related signals from last 2 hours for same ticker
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const { data: related } = await supabase
      .from('signals')
      .select('*')
      .eq('ticker', ticker)
      .neq('id', signal_id)
      .gte('created_at', twoHoursAgo)
      .order('created_at', { ascending: false })
      .limit(8)

    const relatedSignals = related || []

    // Extract source links from primary + related raw_data
    const sources: SourceLink[] = []
    if (signal.raw_data) {
      sources.push(...extractUrls(signal.raw_data as RawData, ticker))
    }
    for (const s of relatedSignals) {
      if (s.raw_data) {
        sources.push(...extractUrls(s.raw_data as RawData, ticker))
      }
    }
    // Deduplicate
    const seenUrls = new Set<string>()
    const uniqueSources = sources.filter(s => {
      if (seenUrls.has(s.url)) return false
      seenUrls.add(s.url)
      return true
    })

    // Build supporting signals text
    const supportingText = relatedSignals.length > 0
      ? relatedSignals.map(s => `• [${s.signal_type.toUpperCase()}] ${s.title}\n  ${s.body}`).join('\n\n')
      : 'No other signals in the last 2 hours.'

    const rawDataStr = signal.raw_data
      ? JSON.stringify(signal.raw_data, null, 2).slice(0, 1500)
      : 'No raw data available.'

    const prompt = `You are a senior trading analyst. A ${signal.signal_type} alert just fired on ${ticker}. Here is the full picture:

PRIMARY SIGNAL:
${signal.title}
${signal.body}

SUPPORTING SIGNALS (last 2 hours):
${supportingText}

RAW DATA:
${rawDataStr}

Write a comprehensive trader-focused analysis (300 words max). Cover:

1. WHAT'S HAPPENING: The specific setup and why multiple signals converging matters here
2. KEY LEVELS: Exact price levels to watch (support, resistance, the trigger level)
3. THESIS: The bull case in 2-3 sentences — what needs to happen for this to work
4. RISKS: The bear case — what invalidates this setup
5. TIMING: Is this a day trade, swing trade, or longer-term setup based on the signals?

Be specific with numbers. No generic advice.`

    const analysis = await callGroqWithFallback(groq =>
      groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
        temperature: 0.4,
      }).then(c => c.choices[0]?.message?.content || 'Analysis unavailable.')
    )

    return NextResponse.json({ analysis, ticker, sources: uniqueSources })
  } catch (err) {
    console.error('[signal-analysis]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    )
  }
}
