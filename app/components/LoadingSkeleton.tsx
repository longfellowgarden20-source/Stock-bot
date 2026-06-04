export function SignalCardSkeleton() {
  return (
    <div className="border border-white/8 rounded-2xl p-4 bg-white/2 animate-pulse">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-white/5 shrink-0" />
        <div className="flex-1 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="w-12 h-4 bg-white/8 rounded-md" />
            <div className="w-10 h-4 bg-white/5 rounded-full" />
            <div className="w-20 h-4 bg-white/5 rounded-md" />
            <div className="w-12 h-3 bg-white/4 rounded-md ml-auto" />
          </div>
          <div className="w-3/4 h-4 bg-white/8 rounded-md" />
          <div className="w-full h-3 bg-white/4 rounded-md" />
          <div className="w-2/3 h-3 bg-white/4 rounded-md" />
        </div>
      </div>
    </div>
  )
}

export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-2">
          <div className="w-32 h-7 bg-white/8 rounded-lg animate-pulse" />
          <div className="w-48 h-4 bg-white/4 rounded-md animate-pulse" />
        </div>
        <div className="flex gap-2">
          <div className="w-20 h-8 bg-white/5 rounded-xl animate-pulse" />
          <div className="w-24 h-8 bg-white/5 rounded-xl animate-pulse" />
        </div>
      </div>
      {/* Search bar */}
      <div className="w-full h-10 bg-white/4 rounded-xl animate-pulse" />
      {/* Filter row */}
      <div className="flex gap-2">
        <div className="w-24 h-8 bg-white/4 rounded-lg animate-pulse" />
        <div className="w-32 h-8 bg-white/4 rounded-lg animate-pulse" />
        <div className="w-28 h-8 bg-white/4 rounded-lg animate-pulse" />
      </div>
      {/* Signal cards */}
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <SignalCardSkeleton key={i} />
        ))}
      </div>
    </div>
  )
}

export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="w-40 h-7 bg-white/8 rounded-lg animate-pulse" />
      <div className="w-full h-40 bg-white/4 rounded-2xl animate-pulse" />
      <div className="w-full h-40 bg-white/4 rounded-2xl animate-pulse" />
      <div className="w-full h-40 bg-white/4 rounded-2xl animate-pulse" />
    </div>
  )
}
