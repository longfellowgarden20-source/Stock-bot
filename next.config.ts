import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  typescript: {
    // Don't fail prod build on type errors — Railway workers are separate
    ignoreBuildErrors: false,
  },
  experimental: {
    // Server actions are enabled by default in Next 15
  },
}

export default nextConfig
