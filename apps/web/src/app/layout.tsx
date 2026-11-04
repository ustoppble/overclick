import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { DEFAULT_THEME, THEME_BOOT_SCRIPT } from "../lib/theme";
import { inter } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "overclick",
  description:
    "Self-hosted board for you and your AI agents. Data stays on this server.",
  robots: { index: false, follow: false },
  /**
   * The tab wears the monogram (OCL-37). The SVG leads because it is the only
   * one that can follow the browser's own light/dark chrome — it carries the
   * media query inside the file — and the two PNGs are the fallback for the
   * clients that will not take an SVG icon. All three are local files under
   * `public/brand/`: a self-hosted board fetches nothing, not even its mark.
   */
  icons: {
    icon: [
      { url: "/brand/favicon.svg", type: "image/svg+xml" },
      { url: "/brand/icon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [
      { url: "/brand/apple-touch-icon-180.png", sizes: "180x180", type: "image/png" },
    ],
  },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // The nonce the proxy made for this request (src/proxy.ts); the policy lets
  // an inline script run only if it carries it.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" data-theme={DEFAULT_THEME} className={inter.variable}>
      <head>
        {/*
          OCL-56: the theme, before the first paint. The document ships with
          the default on it and this script corrects it from the cookie while
          the browser is still parsing <head>, so a person who chose nebula
          never sees xai flash past on the way in. It is inline on purpose: an
          external file would be a network round trip in front of the paint,
          which is the flash it exists to prevent. The CSP admits it by nonce.
        */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
