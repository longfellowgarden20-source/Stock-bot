'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { TrendingUp, LayoutDashboard, Briefcase, Search, Bookmark, LogOut, Bell, Settings, BookOpen, FlaskConical, Crosshair, Brain } from 'lucide-react'
import { useRouter } from 'next/navigation'

const links = [
  { href: '/dashboard', label: 'Signals', icon: LayoutDashboard },
  { href: '/scanner', label: 'Scanner', icon: Search },
  { href: '/portfolio', label: 'Portfolio', icon: Briefcase },
  { href: '/watchlist', label: 'Watchlist', icon: Bookmark },
  { href: '/journal', label: 'Journal', icon: BookOpen },
  { href: '/sandbox', label: 'Sandbox', icon: FlaskConical },
  { href: '/plays', label: 'Plays', icon: Crosshair },
  { href: '/brain', label: 'Brain', icon: Brain },
]

export default function Nav({ unreadCount = 0 }: { unreadCount?: number }) {
  const pathname = usePathname()
  const router = useRouter()

  const signOut = () => {
    document.cookie = 'sb-access=; path=/; max-age=0'
    router.push('/sign-in')
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-52 min-h-screen border-r border-white/[0.06] bg-[#080c0b]/85 backdrop-blur-xl fixed left-0 top-0 z-30">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-4 py-4 border-b border-white/[0.06]">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-sky-500/10 border border-sky-500/25 shrink-0" style={{ boxShadow: '0 0 16px -6px rgba(45, 212, 191,0.6)' }}>
            <TrendingUp className="w-3.5 h-3.5 text-sky-400" />
          </div>
          <div>
            <p className="text-xs font-bold text-white tracking-widest uppercase">StockBot</p>
            <p className="text-[9px] text-slate-600 tracking-widest uppercase">Intelligence</p>
          </div>
        </div>

        {/* Market status */}
        <MarketStatus />

        {/* Nav links */}
        <nav className="flex flex-col py-2 flex-1">
          {links.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={`relative flex items-center gap-3 px-4 py-2.5 text-sm font-medium border-l-2 ${
                  active
                    ? 'border-l-sky-400 text-sky-400 bg-sky-400/[0.08]'
                    : 'border-l-transparent text-slate-500 hover:text-slate-200 hover:bg-white/[0.03]'
                }`}
                style={active ? { transition: 'background 0.1s, color 0.1s', boxShadow: 'inset 8px 0 18px -14px rgba(45, 212, 191,0.9)' } : { transition: 'background 0.1s, color 0.1s' }}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {label}
                {label === 'Signals' && unreadCount > 0 && (
                  <span className="ml-auto text-[10px] font-bold text-red-400 tabular-nums">{unreadCount}</span>
                )}
              </Link>
            )
          })}
        </nav>

        {/* Admin + Sign out */}
        <div className="border-t border-white/[0.06]">
          <Link
            href="/admin"
            className={`flex items-center gap-3 px-4 py-2.5 text-sm font-medium border-l-2 ${
              pathname.startsWith('/admin')
                ? 'border-l-sky-400 text-sky-400 bg-sky-400/[0.06]'
                : 'border-l-transparent text-slate-600 hover:text-slate-300 hover:bg-white/[0.03]'
            }`}
            style={{ transition: 'background 0.1s, color 0.1s' }}
          >
            <Settings className="w-4 h-4 shrink-0" />
            Admin
          </Link>
          <button
            onClick={signOut}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-600 hover:text-slate-300 hover:bg-white/[0.03] border-l-2 border-l-transparent"
            style={{ transition: 'color 0.1s, background 0.1s' }}
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile bottom bar */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex items-center bg-[#080c0b]/90 backdrop-blur-xl border-t border-white/[0.08]"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {links.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={`flex-1 flex flex-col items-center gap-1 pt-2 pb-1.5 min-w-0 ${active ? 'text-sky-400' : 'text-slate-500'}`}
            >
              <div className={`relative flex items-center justify-center w-9 h-6 rounded-md ${active ? 'bg-sky-400/10' : ''}`}>
                <Icon className="w-[18px] h-[18px]" />
                {label === 'Signals' && unreadCount > 0 && (
                  <span className="absolute -top-1 -right-0.5 w-3.5 h-3.5 rounded-full bg-red-500 text-white text-[8px] font-bold flex items-center justify-center">{unreadCount}</span>
                )}
              </div>
              <span className="w-full text-center text-[8px] font-semibold tracking-tight uppercase truncate px-0.5">{label}</span>
            </Link>
          )
        })}
      </nav>
    </>
  )
}

function MarketStatus() {
  const now = new Date()
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const hour = et.getHours()
  const min = et.getMinutes()
  const day = et.getDay()
  const totalMin = hour * 60 + min

  const isWeekend = day === 0 || day === 6
  const isPreMarket = !isWeekend && totalMin >= 240 && totalMin < 570
  const isMarketHours = !isWeekend && totalMin >= 570 && totalMin < 960
  const isAfterHours = !isWeekend && totalMin >= 960 && totalMin < 1200

  let label = 'CLOSED'
  let color = 'bg-slate-600'
  if (isPreMarket) { label = 'PRE-MKT'; color = 'bg-yellow-400' }
  if (isMarketHours) { label = 'OPEN'; color = 'bg-emerald-400' }
  if (isAfterHours) { label = 'AFTER-HRS'; color = 'bg-sky-400' }

  return (
    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/[0.06]">
      <div className={`w-1.5 h-1.5 rounded-full ${color} ${isMarketHours ? 'animate-pulse' : ''} shrink-0`} />
      <span className="text-[10px] font-semibold tracking-widest text-slate-500 uppercase">{label}</span>
    </div>
  )
}
