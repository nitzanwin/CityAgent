import type { NextConfig } from "next";

// The brain reads src/cities/<id>/knowledge.md at runtime, so it must ship with the function.
const nextConfig: NextConfig = {
  outputFileTracingIncludes: { "/api/vapi/chat/completions": ["./src/cities/**/*.md"] },
};

export default nextConfig;
