import { NextRequest, NextResponse } from 'next/server'

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl
  const access = req.cookies.get('sb-access')?.value

  if (!access && pathname !== '/sign-in') {
    return NextResponse.redirect(new URL('/sign-in', req.url))
  }
  if (access && pathname === '/sign-in') {
    return NextResponse.redirect(new URL('/dashboard', req.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
}
