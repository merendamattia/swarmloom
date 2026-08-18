import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["swarmloom-backend"],
  experimental: { cpus: 5 },
};
export default config;
