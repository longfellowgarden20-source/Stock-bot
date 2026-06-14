'use client'

/**
 * "Pipp" — StockBot's original green chibi-trader mascot.
 *
 * Wholly original character (NOT based on any existing/licensed mascot):
 * a chunky, friendly emerald bot with a rounded antenna, big glowing
 * scanline-free eyes, a chest "ticker" readout, and a little up-arrow
 * badge that gives him his trader personality.
 *
 * Pure inline SVG — crisp at any size, theme-matched to the app's
 * emerald/teal palette, with optional idle float + blink animations.
 *
 * Usage:
 *   <Mascot size={120} />                  // default, happy + float
 *   <Mascot size={48} expression="neutral" float={false} />
 *   <Mascot expression="excited" />        // for wins / share cards
 */

type Expression = 'happy' | 'neutral' | 'excited' | 'thinking'

export default function Mascot({
  size = 120,
  expression = 'happy',
  float = true,
  staticRender = false,
  className = '',
  title = 'Pipp — StockBot mascot',
}: {
  size?: number
  expression?: Expression
  float?: boolean
  /** Disable all motion + blur filter — use when snapshotting to PNG. */
  staticRender?: boolean
  className?: string
  title?: string
}) {
  // Per-expression eye + mouth geometry
  const eye = {
    happy:    { ry: 13, mouth: 'M 86 132 Q 110 150 134 132' },     // gentle smile
    neutral:  { ry: 13, mouth: 'M 90 138 L 130 138' },             // flat
    excited:  { ry: 15, mouth: 'M 84 130 Q 110 158 136 130 Z' },   // open grin
    thinking: { ry: 9,  mouth: 'M 92 140 Q 110 134 128 140' },     // slight purse
  }[expression]

  return (
    <div
      className={className}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        animation: float && !staticRender ? 'mascot-float 3.4s ease-in-out infinite' : undefined,
      }}
      role="img"
      aria-label={title}
    >
      <style>{`
        @keyframes mascot-float {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-5%); }
        }
        @keyframes mascot-blink {
          0%, 92%, 100% { transform: scaleY(1); }
          96%           { transform: scaleY(0.1); }
        }
        @keyframes mascot-antenna {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.45; }
        }
        @keyframes mascot-arrow {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-2px); }
        }
        .mascot-eye  { transform-box: fill-box; transform-origin: center; ${staticRender ? '' : 'animation: mascot-blink 5.2s infinite;'} }
        .mascot-eye2 { transform-box: fill-box; transform-origin: center; ${staticRender ? '' : 'animation: mascot-blink 5.2s infinite 0.08s;'} }
        .mascot-ant  { ${staticRender ? '' : 'animation: mascot-antenna 2.6s ease-in-out infinite;'} }
        .mascot-arr  { transform-box: fill-box; transform-origin: center; ${staticRender ? '' : 'animation: mascot-arrow 2s ease-in-out infinite;'} }
      `}</style>

      <svg viewBox="0 0 220 240" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          {/* Body gradient — deep emerald to bright teal */}
          <linearGradient id="m-body" x1="60" y1="40" x2="170" y2="210" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#34d399" />
            <stop offset="0.55" stopColor="#14b8a6" />
            <stop offset="1" stopColor="#0d9488" />
          </linearGradient>
          {/* Face glass */}
          <radialGradient id="m-face" cx="0.42" cy="0.36" r="0.8">
            <stop offset="0" stopColor="#06201c" />
            <stop offset="1" stopColor="#021512" />
          </radialGradient>
          {/* Eye glow */}
          <radialGradient id="m-eye" cx="0.5" cy="0.4" r="0.7">
            <stop offset="0" stopColor="#ccfbf1" />
            <stop offset="0.6" stopColor="#5eead4" />
            <stop offset="1" stopColor="#2dd4bf" />
          </radialGradient>
          {/* Top sheen */}
          <linearGradient id="m-sheen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.5" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </linearGradient>
          <filter id="m-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Soft ground shadow */}
        <ellipse cx="110" cy="226" rx="56" ry="9" fill="#000000" opacity="0.28" />

        {/* Antenna */}
        <g className="mascot-ant">
          <line x1="110" y1="40" x2="110" y2="16" stroke="#0d9488" strokeWidth="6" strokeLinecap="round" />
          <circle cx="110" cy="12" r="9" fill="url(#m-eye)" filter="url(#m-glow)" />
        </g>

        {/* Legs */}
        <rect x="74" y="196" width="22" height="26" rx="11" fill="#0d9488" />
        <rect x="124" y="196" width="22" height="26" rx="11" fill="#0d9488" />
        <ellipse cx="85" cy="224" rx="15" ry="7" fill="#0f766e" />
        <ellipse cx="135" cy="224" rx="15" ry="7" fill="#0f766e" />

        {/* Arms */}
        <rect x="34" y="120" width="20" height="58" rx="10" fill="url(#m-body)" />
        <rect x="166" y="120" width="20" height="58" rx="10" fill="url(#m-body)" />
        <circle cx="44" cy="182" r="12" fill="#14b8a6" />
        <circle cx="176" cy="182" r="12" fill="#14b8a6" />

        {/* Body */}
        <rect x="50" y="58" width="120" height="150" rx="46" fill="url(#m-body)" />
        {/* Body top sheen */}
        <rect x="62" y="66" width="96" height="60" rx="34" fill="url(#m-sheen)" opacity="0.6" />

        {/* Face panel */}
        <rect x="64" y="84" width="92" height="78" rx="34" fill="url(#m-face)" stroke="#0f766e" strokeWidth="3" />

        {/* Eyes */}
        <ellipse className="mascot-eye"  cx="90"  cy={120} rx="12" ry={eye.ry} fill="url(#m-eye)" filter="url(#m-glow)" />
        <ellipse className="mascot-eye2" cx="130" cy={120} rx="12" ry={eye.ry} fill="url(#m-eye)" filter="url(#m-glow)" />
        {/* Eye catchlights */}
        <circle cx="86" cy={115} r="3" fill="#ffffff" opacity="0.85" />
        <circle cx="126" cy={115} r="3" fill="#ffffff" opacity="0.85" />

        {/* Mouth */}
        <path
          d={eye.mouth}
          stroke="#5eead4"
          strokeWidth="4"
          strokeLinecap="round"
          fill={expression === 'excited' ? '#042f2e' : 'none'}
        />

        {/* Chest ticker readout — the "trader" personality */}
        <rect x="78" y="172" width="64" height="22" rx="7" fill="#021512" stroke="#0f766e" strokeWidth="2" />
        <g className="mascot-arr">
          {/* little up-arrow */}
          <path d="M 90 188 L 96 178 L 102 188 Z" fill="#4ade80" />
        </g>
        <rect x="108" y="181" width="26" height="4" rx="2" fill="#2dd4bf" opacity="0.9" />
        <rect x="108" y="187" width="18" height="3" rx="1.5" fill="#2dd4bf" opacity="0.55" />

        {/* Side rivets */}
        <circle cx="60" cy="132" r="3.5" fill="#0f766e" />
        <circle cx="160" cy="132" r="3.5" fill="#0f766e" />
      </svg>
    </div>
  )
}
