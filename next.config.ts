import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
  },
  // tambahkan hostname ngrok-mu (tanpa https://)
  allowedDevOrigins: [
    '75db-202-65-239-154.ngrok-free.app',
    // jika sering ganti subdomain, bisa wildcard:
    '*.ngrok-free.app',
  ]

};

export default nextConfig;

