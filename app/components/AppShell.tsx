import Nav from './Nav'
import { ToastProvider } from './Toaster'

export default function AppShell({ children, unreadCount = 0 }: { children: React.ReactNode; unreadCount?: number }) {
  return (
    <ToastProvider>
      <div className="flex min-h-screen">
        <Nav unreadCount={unreadCount} />
        <main className="flex-1 md:ml-52 pb-24 md:pb-0">
          <div className="max-w-6xl mx-auto px-3 sm:px-5 py-4 fade-in-up">
            {children}
          </div>
        </main>
      </div>
    </ToastProvider>
  )
}
