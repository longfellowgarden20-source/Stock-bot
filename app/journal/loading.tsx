export default function JournalLoading() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-6 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-white/5 animate-pulse" />
        <div className="flex flex-col gap-1.5">
          <div className="w-32 h-5 bg-white/8 rounded-lg animate-pulse" />
          <div className="w-56 h-3.5 bg-white/4 rounded-md animate-pulse" />
        </div>
      </div>

      {/* Tab bar skeleton */}
      <div className="flex gap-1 bg-white/3 border border-white/8 rounded-2xl p-1">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex-1 h-9 bg-white/5 rounded-xl animate-pulse" />
        ))}
      </div>

      {/* Form skeleton */}
      <div className="bg-white/2 border border-white/8 rounded-2xl p-5 flex flex-col gap-4">
        <div className="w-24 h-4 bg-white/8 rounded-md animate-pulse" />
        <div className="grid grid-cols-2 gap-3">
          <div className="h-10 bg-white/5 rounded-xl animate-pulse" />
          <div className="h-10 bg-white/5 rounded-xl animate-pulse" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="h-10 bg-white/5 rounded-xl animate-pulse" />
          <div className="h-10 bg-white/5 rounded-xl animate-pulse" />
          <div className="h-10 bg-white/5 rounded-xl animate-pulse" />
        </div>
        <div className="h-20 bg-white/5 rounded-xl animate-pulse" />
        <div className="flex gap-2 flex-wrap">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="w-24 h-7 bg-white/5 rounded-full animate-pulse" />
          ))}
        </div>
        <div className="h-10 bg-white/5 rounded-xl animate-pulse" />
      </div>
    </div>
  )
}
