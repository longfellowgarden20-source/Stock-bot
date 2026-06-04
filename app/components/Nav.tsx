'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { TrendingUp, LayoutDashboard, Briefcase, Search, Bookmark, LogOut, Bell, Settings } from 'lucide-react'
import { useRouter } from 'next/navigation'

const links = [
  { href: '/dashboard', label: 'Signals', icon: LayoutDashboard },
  { href: '/scanner', label: 'Scanner', icon: Search },
  { href: '/portfolio', label: 'Portfolio', icon: Briefcase },
  { href: '/watchlist', label: 'Watchlist', icon: Bookmark },
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
      <aside className="hidden md:flex flex-col w-56 min-h-screen border-r border-white/8 bg-[#080d18] fixed left-0 top-0 z-30">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-white/8">
          <div className="w-8 h-8 rounded-lg bg-[#0ea5e9]/15 border border-[#0ea5e9]/30 flex items-center justify-center shrink-0">
            <TrendingUp className="w-4 h-4 text-[#0ea5e9]" />
          </div>
          <div>
            <p className="text-sm font-bold text-white">StockBot</p>
            <p className="text-xs text-slate-600">Intelligence</p>
          </div>
        </div>

        {/* Market status */}
        <MarketStatus />

        {/* Nav links */}
        <nav className="flex flex-col gap-1 px-3 py-4 flex-1">
          {links.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href)
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium ${active ? 'bg-[#0ea5e9]/15 text-[#0ea5e9] border border-[#0ea5e9]/20' : 'text-slate-400 hover:text-white hover:bg-white/5'}`}
                style={{ transition: 'background 0.15s, color 0.15s' }}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {label}
                {label === 'Signals' && unreadCount > 0 && (
                  <span className="ml-auto px-1.5 py-0.5 rounded-full text-xs font-bold bg-red-500/20 text-red-400">{unreadCount}</span>
                )}
              </Link>
            )
          })}
        </nav>

        {/* Admin + Sign out */}
        <div className="p-3 border-t border-white/8 flex flex-col gap-1">
          <Link
            href="/admin"
            className={`flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium ${pathname.startsWith('/admin') ? 'bg-[#0ea5e9]/15 text-[#0ea5e9] border border-[#0ea5e9]/20' : 'text-slate-500 hover:text-white hover:bg-white/5'}`}
            style={{ transition: 'background 0.15s, color 0.15s' }}
          >
            <Settings className="w-4 h-4 shrink-0" />
            Admin
          </Link>
          <button
            onClick={signOut}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-slate-500 hover:text-white hover:bg-white/5"
            style={{ transition: 'color 0.15s, background 0.15s' }}
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile bottom bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 flex items-center bg-[#080d18] border-t border-white/8 px-2 pb-safe">
        {links.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={`flex-1 flex flex-col items-center gap-1 py-3 text-xs font-medium ${active ? 'text-[#0ea5e9]' : 'text-slate-500'}`}
            >
              <div className="relative">
                <Icon className="w-5 h-5" />
                {label === 'Signals' && unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">{unreadCount}</span>
                )}
              </div>
              {label}
            </Link>
          )
        })}
        <button onClick={signOut} className="flex-1 flex flex-col items-center gap-1 py-3 text-xs font-medium text-slate-500">
          <LogOut className="w-5 h-5" />
          Out
        </button>
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

  let label = 'Market Closed'
  let color = 'bg-slate-500'
  if (isPreMarket) { label = 'Pre-Market'; color = 'bg-yellow-400' }
  if (isMarketHours) { label = 'Market Open'; color = 'bg-green-400' }
  if (isAfterHours) { label = 'After Hours'; color = 'bg-blue-400' }

  return (
    <div className="flex items-center gap-2 px-5 py-3 border-b border-white/8">
      <div className={`w-2 h-2 rounded-full ${color} ${isMarketHours ? 'animate-pulse' : ''}`} />
      <span className="text-xs text-slate-400">{label}</span>
    </div>
  )
}
