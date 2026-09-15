/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The 2026-09 reset: the app is one page (/deals). All 32 legacy modules stay in the
  // codebase but are unreachable — they are catalogued on /roadmap under "Previous
  // Features". Delete this block to bring a module back.
  async redirects() {
    return [
      { source: '/modules', destination: '/deals', permanent: false },
      { source: '/modules/:path*', destination: '/deals', permanent: false },
    ]
  },
}

module.exports = nextConfig
