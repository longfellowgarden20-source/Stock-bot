import Groq from 'groq-sdk'

const CEREBRAS_BASE = 'https://api.cerebras.ai/v1/chat/completions'
const CEREBRAS_MODEL = 'llama-3.3-70b'

function getGroqKeys(): string[] {
  return [
    process.env.GROQ_API_KEY,
    process.env.GROQ_BACKUP_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
    process.env.GROQ_API_KEY_5,
  ].filter(Boolean) as string[]
}

function getCerebrasKeys(): string[] {
  return [
    process.env.CEREBRAS_API_KEY,
    process.env.CEREBRAS_API_KEY_2,
    process.env.CEREBRAS_API_KEY_3,
  ].filter(Boolean) as string[]
}

// Picks a random Groq client — distributes load in serverless
export default function getGroqClient(): Groq {
  const keys = getGroqKeys()
  if (keys.length === 0) throw new Error('No GROQ keys configured')
  const key = keys[Math.floor(Math.random() * keys.length)]
  return new Groq({ apiKey: key })
}

// ── Primary interface: pass messages + options, handles Groq → Cerebras fallback
export async function callLLM(
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  options: { maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const { maxTokens = 500, temperature = 0.3 } = options
  const groqKeys = [...getGroqKeys()].sort(() => Math.random() - 0.5)
  const cerebrasKeys = getCerebrasKeys()

  let lastError = ''

  // Try all Groq keys
  for (const key of groqKeys) {
    try {
      const groq = new Groq({ apiKey: key })
      const res = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        max_tokens: maxTokens,
        temperature,
      })
      const content = res.choices[0]?.message?.content?.trim()
      if (content) return content
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('429') || msg.includes('rate_limit')) { lastError = msg; continue }
      throw err
    }
  }

  // Groq exhausted — fall back to Cerebras
  for (const key of cerebrasKeys) {
    try {
      const res = await fetch(CEREBRAS_BASE, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: CEREBRAS_MODEL, messages, max_tokens: maxTokens, temperature }),
      })
      if (res.status === 429) { lastError = `Cerebras 429`; continue }
      if (!res.ok) continue
      const data = await res.json()
      const content = data?.choices?.[0]?.message?.content?.trim()
      if (content) return content
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('429') || msg.includes('rate_limit')) { lastError = msg; continue }
    }
  }

  throw new Error(`All LLM keys rate limited: ${lastError}`)
}

// ── Legacy: kept for backward compat with existing routes that pass a fn(groq) callback
export async function callGroqWithFallback(
  fn: (groq: Groq) => Promise<string>
): Promise<string> {
  const groqKeys = [...getGroqKeys()].sort(() => Math.random() - 0.5)
  const cerebrasKeys = getCerebrasKeys()
  let lastError = ''

  for (const key of groqKeys) {
    try {
      const groq = new Groq({ apiKey: key })
      return await fn(groq)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('429') || msg.includes('rate_limit')) { lastError = msg; continue }
      throw err
    }
  }

  // Groq exhausted — re-run fn but extract the prompt via a capturing proxy
  // Since fn() calls groq.chat.completions.create({messages, ...}), we intercept it
  if (cerebrasKeys.length > 0) {
    let capturedMessages: { role: string; content: string }[] | null = null
    let capturedMaxTokens = 500
    let capturedTemperature = 0.3

    const proxy = {
      chat: {
        completions: {
          create: (opts: { messages: { role: string; content: string }[]; max_tokens?: number; temperature?: number }) => {
            capturedMessages = opts.messages
            capturedMaxTokens = opts.max_tokens ?? 500
            capturedTemperature = opts.temperature ?? 0.3
            return Promise.resolve(null) as unknown as ReturnType<Groq['chat']['completions']['create']>
          }
        }
      }
    } as unknown as Groq

    try { await fn(proxy) } catch { /* ignore — proxy returns null */ }

    if (capturedMessages) {
      for (const key of cerebrasKeys) {
        try {
          const res = await fetch(CEREBRAS_BASE, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: CEREBRAS_MODEL,
              messages: capturedMessages,
              max_tokens: capturedMaxTokens,
              temperature: capturedTemperature,
            }),
          })
          if (res.status === 429) { lastError = `Cerebras 429`; continue }
          if (!res.ok) continue
          const data = await res.json()
          const content = data?.choices?.[0]?.message?.content?.trim()
          if (content) return content
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('429') || msg.includes('rate_limit')) { lastError = msg; continue }
        }
      }
    }
  }

  throw new Error(`All LLM keys rate limited: ${lastError}`)
}
