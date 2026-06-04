import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const SUBREDDITS = [
  'wallstreetbets',
  'stocks',
  'investing',
  'options',
]

type RedditPost = {
  title: string
  score: number
  num_comments: number
  subreddit: string
  permalink: string
  selftext: string
}

type RedditChild = {
  data: RedditPost
}

type RedditListing = {
  data: {
    children: RedditChild[]
  }
}

async function fetchSubreddit(subreddit: string): Promise<RedditPost[]> {
  try {
    const res = await fetch(
      `https://www.reddit.com/r/${subreddit}/hot.json?limit=100`,
      {
        headers: { 'User-Agent': 'StockBot/1.0' },
        next: { revalidate: 0 },
      }
    )
    if (!res.ok) return []
    const json = (await res.json()) as RedditListing
    return json.data?.children?.map((c) => ({
      ...c.data,
      subreddit,
    })) ?? []
  } catch {
    return []
  }
}

async function fetchSearch(ticker: string): Promise<RedditPost[]> {
  try {
    const res = await fetch(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(ticker)}&sort=new&limit=25&t=day`,
      {
        headers: { 'User-Agent': 'StockBot/1.0' },
        next: { revalidate: 0 },
      }
    )
    if (!res.ok) return []
    const json = (await res.json()) as RedditListing
    return json.data?.children?.map((c) => c.data) ?? []
  } catch {
    return []
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function postMentionsTicker(post: RedditPost, ticker: string): boolean {
  const upper = ticker.toUpperCase()
  const escaped = escapeRegex(upper)
  const combined = `${post.title} ${post.selftext ?? ''}`.toUpperCase()
  const dollarPattern = new RegExp(`\\$${escaped}\\b`)
  const wordPattern = new RegExp(`\\b${escaped}\\b`)
  return dollarPattern.test(combined) || wordPattern.test(combined)
}

type GroqMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

type GroqResponse = {
  choices: Array<{
    message: {
      content: string
    }
  }>
}

async function callGroq(messages: GroqMessage[]): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY not set')

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 512,
      temperature: 0.3,
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Groq API error ${res.status}: ${text}`)
  }

  const json = (await res.json()) as GroqResponse
  return json.choices?.[0]?.message?.content ?? ''
}

function parseGroqResponse(raw: string): {
  verdict: string
  score: number
  summary: string
  watch: string
} {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)

  let verdict = 'NEUTRAL'
  let score = 5
  let summary = ''
  let watch = ''

  for (const line of lines) {
    if (line.startsWith('VERDICT:')) {
      const v = line.replace('VERDICT:', '').trim().toUpperCase()
      if (['BULLISH', 'BEARISH', 'NEUTRAL', 'MIXED'].includes(v)) verdict = v
    } else if (line.startsWith('SCORE:')) {
      const n = parseInt(line.replace('SCORE:', '').trim())
      if (!isNaN(n) && n >= 1 && n <= 10) score = n
    } else if (line.startsWith('SUMMARY:')) {
      summary = line.replace('SUMMARY:', '').trim()
    } else if (line.startsWith('WATCH:')) {
      watch = line.replace('WATCH:', '').trim()
    }
  }

  return { verdict, score, summary, watch }
}

export async function POST(req: NextRequest) {
  let body: { ticker?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const ticker = (body.ticker ?? '').trim().toUpperCase()
  if (!ticker) {
    return NextResponse.json({ error: 'ticker is required' }, { status: 400 })
  }

  // Fetch all subreddits + search in parallel
  const [searchPosts, ...subredditResults] = await Promise.all([
    fetchSearch(ticker),
    ...SUBREDDITS.map(fetchSubreddit),
  ])

  const allPosts: RedditPost[] = [
    ...searchPosts,
    ...subredditResults.flat(),
  ]

  // Deduplicate by permalink
  const seen = new Set<string>()
  const unique = allPosts.filter((p) => {
    if (seen.has(p.permalink)) return false
    seen.add(p.permalink)
    return true
  })

  // Filter to posts mentioning the ticker
  const relevant = unique.filter((p) => postMentionsTicker(p, ticker))

  // Sort by score descending
  relevant.sort((a, b) => b.score - a.score)

  const topPosts = relevant.slice(0, 25).map((p) => ({
    title: p.title,
    score: p.score,
    comments: p.num_comments,
    subreddit: p.subreddit,
    url: `https://www.reddit.com${p.permalink}`,
  }))

  if (relevant.length === 0) {
    return NextResponse.json({
      ticker,
      verdict: 'NEUTRAL',
      score: 5,
      summary: 'No significant Reddit discussion found for this ticker today.',
      watch: '',
      post_count: 0,
      top_posts: [],
      generated_at: new Date().toISOString(),
    })
  }

  // Build posts summary for Groq
  const postsSummary = topPosts
    .slice(0, 20)
    .map(
      (p, i) =>
        `${i + 1}. [r/${p.subreddit}] "${p.title}" (score: ${p.score}, comments: ${p.comments})`
    )
    .join('\n')

  const prompt = `You are a trading analyst. Here are Reddit posts mentioning ${ticker} from the last 24 hours:

${postsSummary}

Analyze the sentiment. Respond in this exact format:

VERDICT: [BULLISH / BEARISH / NEUTRAL / MIXED]
SCORE: [1-10 where 1=extremely bearish, 5=neutral, 10=extremely bullish]
SUMMARY: [2-3 sentences: what are people saying, what's the main thesis or concern, any specific catalysts mentioned]
WATCH: [One specific thing to watch based on what Reddit is saying]`

  let verdict = 'NEUTRAL'
  let score = 5
  let summary = ''
  let watch = ''

  try {
    const raw = await callGroq([{ role: 'user', content: prompt }])
    const parsed = parseGroqResponse(raw)
    verdict = parsed.verdict
    score = parsed.score
    summary = parsed.summary
    watch = parsed.watch
  } catch (e) {
    // Return partial result if Groq fails
    return NextResponse.json(
      {
        ticker,
        verdict: 'NEUTRAL',
        score: 5,
        summary: 'Could not generate AI analysis at this time.',
        watch: '',
        post_count: relevant.length,
        top_posts: topPosts.slice(0, 3),
        generated_at: new Date().toISOString(),
        error: e instanceof Error ? e.message : 'Groq error',
      },
      { status: 200 }
    )
  }

  return NextResponse.json({
    ticker,
    verdict,
    score,
    summary,
    watch,
    post_count: relevant.length,
    top_posts: topPosts.slice(0, 3),
    generated_at: new Date().toISOString(),
  })
}
