/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [{ protocol: 'https', hostname: 'res.cloudinary.com' }],
  },

  /**
   * API proxy — all /api/v1/* requests are forwarded server-side to the
   * core service.  This makes auth cookies same-origin so SameSite=Strict
   * works in both local dev and production (Render + Vercel).
   *
   * Set BACKEND_URL in .env.local (dev) and Vercel env vars (prod).
   * Default: http://localhost:4000
   */
  async rewrites() {
    const backend = process.env.BACKEND_URL ?? 'http://localhost:4000';
    return [
      {
        source:      '/api/v1/:path*',
        destination: `${backend}/api/v1/:path*`,
      },
    ];
  },
};
module.exports = nextConfig;
