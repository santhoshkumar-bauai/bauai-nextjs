import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  // Emits .next/standalone — a self-contained server plus only the node_modules
  // files that were actually traced. The production image (./Dockerfile) runs it.
  output: "standalone",
  async headers() {
    const documentServer = process.env.NEXT_PUBLIC_DS_URL?.trim().replace(/\/$/, "");
    // The :9000 UI-dev Document Server needs frame-src too when the opt-in
    // switch is on; the normal server stays allowed either way.
    const devServer =
      process.env.ONLYOFFICE_UI_DEV === "true"
        ? process.env.ONLYOFFICE_DEV_URL?.trim().replace(/\/$/, "")
        : undefined;
    const frameSources = [documentServer, devServer].filter(Boolean);
    if (!frameSources.length) return [];
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-src 'self' ${frameSources.join(" ")};`,
          },
        ],
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin();

export default withNextIntl(nextConfig);
