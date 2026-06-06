import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const keys = {
    GROQ_API_KEY: process.env.GROQ_API_KEY ? `...${process.env.GROQ_API_KEY.slice(-6)}` : 'MISSING',
    GROQ_BACKUP_API_KEY: process.env.GROQ_BACKUP_API_KEY ? `...${process.env.GROQ_BACKUP_API_KEY.slice(-6)}` : 'MISSING',
    GROQ_API_KEY_2: process.env.GROQ_API_KEY_2 ? `...${process.env.GROQ_API_KEY_2.slice(-6)}` : 'MISSING',
    GROQ_API_KEY_3: process.env.GROQ_API_KEY_3 ? `...${process.env.GROQ_API_KEY_3.slice(-6)}` : 'MISSING',
  }
  return NextResponse.json(keys)
}
