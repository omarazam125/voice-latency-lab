/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // Workspace packages are TypeScript source; Next compiles them in-place.
  transpilePackages: ['@vll/core', '@vll/telemetry'],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  webpack: (config) => {
    // onnxruntime-web ships optional node bindings that must not be bundled
    // for the browser.
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };
    // The workspace packages use NodeNext-style ".js" specifiers that actually
    // point at ".ts" sources. Webpack must be told to follow them, or every
    // cross-file import inside @vll/* fails to resolve.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};
export default nextConfig;
