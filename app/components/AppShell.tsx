import Nav from './Nav'

export default function AppShell({ children, unreadCount = 0 }: { children: React.ReactNode; unreadCount?: number }) {
  return (
    <div className="flex min-h-screen bg-[#0a0f1a]">
      <Nav unreadCount={unreadCount} />
      <main className="flex-1 md:ml-56 pb-20 md:pb-0">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
          {children}
        </div>
      </main>
    </div>
  )
}
