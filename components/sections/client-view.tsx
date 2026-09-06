import { SectionHeader, Metric, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { pages, clusters, crmMetrics, recentActivity } from '@/lib/data'

const totalKw = clusters.reduce((s, c) => s + c.items.length, 0)
const mapped = clusters.reduce(
  (s, c) => s + c.items.filter((i) => i.status === 'Mapped').length,
  0,
)
const missing = totalKw - mapped
const coverage = Math.round((mapped / totalKw) * 100)

export function ClientOverview() {
  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="C1"
        title="Client Overview"
        description="A read-only summary of your website's SEO coverage, prepared by the OLNOO team."
      />

      <div className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">SEO</span>
        <section className="grid grid-cols-2 border border-hairline bg-card md:grid-cols-4">
          <Metric label="Pages" value={pages.length} />
          <Metric label="Keywords" value={totalKw} />
          <Metric label="Coverage" value={`${coverage}%`} accent />
          <Metric label="Missing pages" value={missing} />
        </section>
      </div>

      <div className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">CRM</span>
        <section className="grid grid-cols-3 border border-hairline bg-card">
          <Metric label="Leads" value={crmMetrics.total} />
          <Metric label="In progress" value={crmMetrics.inProgress} />
          <Metric label="Won" value={crmMetrics.won} accent />
        </section>
      </div>

      <div className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">Recent activity</span>
        <div className="border border-hairline bg-card">
          {recentActivity.map((a, i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-b border-hairline px-6 py-4 last:border-b-0"
            >
              <span className="label-mono w-10 shrink-0 text-muted-foreground">{a.module}</span>
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
  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="C2"
        title="Client Pages"
        description="Recently published and in-progress pages on your website."
      />
      <TableShell>
        <thead>
          <tr>
            <Th>URL</Th>
            <Th>Title</Th>
            <Th>Locale</Th>
            <Th>Status</Th>
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

export function ClientKeywords() {
  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="C3"
        title="Client Keywords"
        description="Which search queries point to which page, and where a page is still needed."
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
                      {missingPage ? 'No page yet' : item.page}
                    </span>
                    <span className="inline-flex items-center gap-2 justify-self-start md:justify-self-end">
                      <span
                        className={`size-1.5 rounded-full ${missingPage ? 'bg-destructive' : 'bg-blue'}`}
                        aria-hidden
                      />
                      <span className="label-mono text-foreground/80">
                        {missingPage ? 'Missing' : 'Mapped'}
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
