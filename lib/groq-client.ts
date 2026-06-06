import Groq from 'groq-sdk'

// Tries keys in random order — works correctly in serverless where process state resets per request
export default function getGroqClient(): Groq {
  const keys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_BACKUP_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ].filter(Boolean) as string[]

  if (keys.length === 0) throw new Error('No GROQ keys configured')

  // Pick randomly — distributes load across keys even with cold starts
  const key = keys[Math.floor(Math.random() * keys.length)]
  return new Groq({ apiKey: key })
}

// For routes that need fallback on 429: try keys until one works
export async function callGroqWithFallback(
  fn: (groq: Groq) => Promise<string>
): Promise<string> {
  const keys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_BACKUP_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ].filter(Boolean) as string[]

  if (keys.length === 0) throw new Error('No GROQ keys configured')

  // Shuffle so we don't always hammer key[0] first
  const shuffled = keys.sort(() => Math.random() - 0.5)

  let lastError = ''
  for (const key of shuffled) {
    try {
      const groq = new Groq({ apiKey: key })
      return await fn(groq)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('429') || msg.includes('rate_limit')) {
        lastError = msg
        continue // try next key
      }
      throw err // non-429 error, don't retry
    }
  }
  throw new Error(`All Groq keys rate limited: ${lastError}`)
}
