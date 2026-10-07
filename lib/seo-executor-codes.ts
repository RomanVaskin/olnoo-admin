// The ONLY Technical SEO issue codes the SEO Executor may fix. Kept in a dependency-free file so the UI can import it too.
// Never auto-run for: site_unavailable, robots_disallow_all, sitemap_missing, sitemap_unreadable, noindex_in_sitemap, page_redirect,
// page_http_error, page_unreachable, check_failed, or any unknown code. Do not extend casually.
export const SAFE_EXECUTOR_CODES = ['robots_missing', 'canonical_missing', 'canonical_mismatch', 'title_missing', 'h1_missing'] as const
export const isSafeExecutorCode = (code: unknown): boolean => typeof code === 'string' && (SAFE_EXECUTOR_CODES as readonly string[]).includes(code)
