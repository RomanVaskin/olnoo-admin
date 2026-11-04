import { loadCatalogDeployEnvironment } from './scripts/catalog-deploy-env.mjs'

loadCatalogDeployEnvironment(new URL('./.env.catalog.json', import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
