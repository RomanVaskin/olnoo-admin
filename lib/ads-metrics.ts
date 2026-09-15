// Pure, dependency-free Ads KPI math — kept separate from lib/ads.ts (which needs the "@/..."
// path alias for lib/crm/lib/db) purely so it's testable with the project's plain-.ts node:test
// runner, the same reason lib/social-threads-text.ts exists as its own file.

/** spend / leads. null (not 0 or Infinity) when there are no leads to divide by — "not
 * computable" is a different fact from "zero cost per lead", and the UI renders it as "—". */
export function calculateCpl(spend: number, leads: number): number | null {
  if (!leads) return null
  return spend / leads
}

/** spend / sales — same "not computable" semantics as calculateCpl. */
export function calculateCac(spend: number, sales: number): number | null {
  if (!sales) return null
  return spend / sales
}

/** (revenue - spend) / spend * 100 — same "not computable" semantics as calculateCpl; a campaign
 * with 0 spend has no meaningful return-on-investment percentage, whatever the revenue is. */
export function calculateRoi(revenue: number, spend: number): number | null {
  if (!spend) return null
  return ((revenue - spend) / spend) * 100
}
