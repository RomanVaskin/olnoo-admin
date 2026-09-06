import { SectionHeader, Metric, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { pages, clusters, crmMetrics, recentActivity } from '@/lib/data'

const totalKw = clusters.reduce((s, c) => s + c.items.length, 0)
const mapped = clusters.reduce(
  (s, c) => s + c.items.filter((i) => i.status === 'Mapped').length,
  0,
)
const missing = totalKw - mapped
const coverage = Math.round((mapped / totalKw) * 100)

export function ClientOverview() {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="C1"
        title={t.clientOverview.title}
        description={t.clientOverview.description}
      />

      <div className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">{t.clientOverview.seo}</span>
        <section className="grid grid-cols-2 border border-hairline bg-card md:grid-cols-4">
          <Metric label={t.clientOverview.metricPages} value={pages.length} />
          <Metric label={t.clientOverview.metricKeywords} value={totalKw} />
          <Metric label={t.clientOverview.metricCoverage} value={`${coverage}%`} accent />
          <Metric label={t.clientOverview.metricMissingPages} value={missing} />
        </section>
      </div>

      <div className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">{t.clientOverview.crm}</span>
        <section className="grid grid-cols-3 border border-hairline bg-card">
          <Metric label={t.clientOverview.metricLeads} value={crmMetrics.total} />
          <Metric label={t.clientOverview.metricInProgress} value={crmMetrics.inProgress} />
          <Metric label={t.clientOverview.metricWon} value={crmMetrics.won} accent />
        </section>
      </div>

      <div className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">{t.clientOverview.recentActivity}</span>
        <div className="border border-hairline bg-card">
          {recentActivity.map((a, i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-b border-hairline px-6 py-4 last:border-b-0"
            >
              <span className="label-mono w-10 shrink-0 text-muted-foreground">{t.module[a.module]}</span>
              <span className="flex-1 text-sm text-foreground/90">{a.text}</span>
              <span className="label-mono shrink-0 text-muted-foreground">{a.time}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export function ClientPages() {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="C2"
        title={t.clientPages.title}
        description={t.clientPages.description}
      />
      <TableShell>
        <thead>
          <tr>
            <Th>{t.table.url}</Th>
            <Th>{t.table.title}</Th>
            <Th>{t.table.locale}</Th>
            <Th>{t.table.status}</Th>
          </tr>
        </thead>
        <tbody>
          {pages.map((p) => (
            <tr key={p.url}>
              <Td className="font-mono text-xs text-blue">{p.url}</Td>
              <Td className="max-w-[280px] truncate">{p.title}</Td>
              <Td>
                <span className="label-mono text-muted-foreground">{p.locale}</span>
              </Td>
              <Td>
                <StatusPill status={p.status} />
              </Td>
            </tr>
          ))}
        </tbody>
      </TableShell>
    </div>
  )
}

export function ClientSeoMap() {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="C4"
        title={t.seoMap.title}
        description={t.seoMap.description}
      />

      <div className="flex flex-col gap-px border border-hairline bg-hairline">
        {clusters.map((cluster) => {
          const missing = cluster.items.filter((i) => i.status === 'Missing').length
          return (
            <section key={cluster.name} className="bg-card">
              <div className="flex items-center justify-between border-b border-hairline px-6 py-4">
                <span className="label-mono text-foreground">{cluster.name}</span>
                <span className="label-mono text-muted-foreground">
                  {missing > 0 ? t.seoMap.missing(missing) : t.seoMap.complete}
                </span>
              </div>
              <ul className="flex flex-col">
                {cluster.items.map((item) => {
                  const missingPage = item.status === 'Missing'
                  return (
                    <li
                      key={cluster.name + item.keyword}
                      className="grid grid-cols-1 items-center gap-3 border-b border-hairline px-6 py-4 last:border-b-0 md:grid-cols-[1fr_auto_1.2fr_auto]"
                    >
                      <span className="text-sm text-foreground">{item.keyword}</span>
                      <span
                        className="font-mono text-muted-foreground max-md:hidden"
                        aria-hidden
                      >
                        →
                      </span>
                      <span
                        className={
                          missingPage
                            ? 'font-mono text-xs text-muted-foreground'
                            : 'font-mono text-xs text-blue'
                        }
                      >
                        {missingPage ? t.seoMap.noPage : item.page}
                      </span>
                      <span className="inline-flex items-center gap-2 justify-self-start md:justify-self-end">
                        <span
                          className={`size-1.5 rounded-full ${missingPage ? 'bg-destructive' : 'bg-blue'}`}
                          aria-hidden
                        />
                        <span className="label-mono text-foreground/80">
                          {missingPage ? t.status.Missing : t.status.Mapped}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}

export function ClientKeywords() {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="C3"
        title={t.clientKeywords.title}
        description={t.clientKeywords.description}
      />
      <div className="flex flex-col gap-px border border-hairline bg-hairline">
        {clusters.map((cluster) => (
          <section key={cluster.name} className="bg-card">
            <div className="border-b border-hairline px-6 py-4">
              <span className="label-mono text-foreground">{cluster.name}</span>
            </div>
            <ul>
              {cluster.items.map((item) => {
                const missingPage = item.status === 'Missing'
                return (
                  <li
                    key={cluster.name + item.keyword}
                    className="grid grid-cols-1 items-center gap-3 border-b border-hairline px-6 py-4 last:border-b-0 md:grid-cols-[1fr_1.2fr_auto]"
                  >
                    <span className="text-sm text-foreground">{item.keyword}</span>
                    <span
                      className={
                        missingPage
                          ? 'font-mono text-xs text-muted-foreground'
                          : 'font-mono text-xs text-blue'
                      }
                    >
                      {missingPage ? t.clientKeywords.noPageYet : item.page}
                    </span>
                    <span className="inline-flex items-center gap-2 justify-self-start md:justify-self-end">
                      <span
                        className={`size-1.5 rounded-full ${missingPage ? 'bg-destructive' : 'bg-blue'}`}
                        aria-hidden
                      />
                      <span className="label-mono text-foreground/80">
                        {missingPage ? t.status.Missing : t.status.Mapped}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
