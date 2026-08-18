import type { Metadata, Viewport } from "next";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "GitHub Agent Worker", template: "%s · GitHub Agent Worker" },
  description: "Operational health, job history, and durable evidence for GitHub Agent Worker.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body suppressHydrationWarning><Providers>{children}</Providers></body></html>;
}
