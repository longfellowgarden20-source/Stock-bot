import AppShell from '@/app/components/AppShell'

export default function PositionDetailLoading() {
  return (
    <AppShell>
      <div className="flex flex-col gap-5 max-w-[1100px] animate-pulse">

        {/* Header skeleton */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/8" />
          <div className="h-7 w-24 rounded-lg bg-white/8" />
          <div className="h-5 w-40 rounded-lg bg-white/5 hidden sm:block" />
          <div className="ml-auto h-8 w-24 rounded-xl bg-white/8" />
        </div>

        {/* Tab nav skeleton */}
        <div className="flex gap-1.5 bg-white/4 border border-white/10 rounded-2xl p-1.5">
          {[80, 72, 64, 72, 56].map((w, i) => (
            <div key={i} className="h-8 rounded-xl bg-white/8" style={{ width: w }} />
          ))}
        </div>

        {/* Chart skeleton */}
        <div className="bg-white/4 border border-white/10 rounded-2xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-white/8 flex items-center gap-2">
            <div className="h-3.5 w-10 rounded bg-white/8" />
            <div className="h-3.5 w-16 rounded bg-white/5" />
          </div>
          <div className="h-[400px] bg-white/3" />
        </div>

        {/* Summary card skeleton */}
        <div className="bg-white/4 border border-white/10 rounded-2xl p-5">
          <div className="h-3.5 w-32 rounded bg-white/8 mb-4" />
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <div className="h-3 w-16 rounded bg-white/5" />
                <div className="h-4 w-20 rounded bg-white/8" />
              </div>
            ))}
          </div>
        </div>

        {/* Stats grid skeleton */}
        <div className="bg-white/4 border border-white/10 rounded-2xl p-5">
          <div className="h-3.5 w-24 rounded bg-white/8 mb-4" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2 bg-white/3 border border-white/8 rounded-xl p-3">
                <div className="h-3 w-16 rounded bg-white/5" />
                <div className="h-4 w-20 rounded bg-white/8" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </AppShell>
  )
}
