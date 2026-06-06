import Groq from 'groq-sdk'

// Round-robin counter shared across requests in the same process
let _counter = 0

function getGroqClient(): Groq {
  const keys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_BACKUP_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ].filter(Boolean) as string[]

  if (keys.length === 0) throw new Error('No GROQ keys configured')

  const key = keys[_counter % keys.length]
  _counter++
  return new Groq({ apiKey: key })
}

export default getGroqClient
