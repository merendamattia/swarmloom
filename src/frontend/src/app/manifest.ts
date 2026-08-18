import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Swarmloom",
    short_name: "Swarmloom",
    description: "Operational health, job history, and durable evidence for Swarmloom.",
    start_url: "/",
    display: "standalone",
    background_color: "#f8f7f3",
    theme_color: "#171923",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
