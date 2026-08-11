import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  // Emits .next/standalone — a self-contained server plus only the node_modules
  // files that were actually traced. The production image (./Dockerfile) runs it.
  output: "standalone",
  async headers() {
    const documentServer = process.env.NEXT_PUBLIC_DS_URL?.trim().replace(/\/$/, "");
    if (!documentServer) return [];
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-src 'self' ${documentServer};`,
          },
        ],
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
