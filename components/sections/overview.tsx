import { SectionHeader, Metric, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { metrics, projects, clusters } from '@/lib/data'

export function Overview() {
  const totalKw = clusters.reduce((s, c) => s + c.items.length, 0)
  const mapped = clusters.reduce(
    (s, c) => s + c.items.filter((i) => i.status === 'Mapped').length,
    0,
  )
  const coverage = Math.round((mapped / totalKw) * 100)

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="01"
        title="Overview"
        description="Operating snapshot across every OLNOO property — inventory, semantic coverage and outstanding gaps."
      />

      <section className="grid grid-cols-2 border border-hairline bg-card md:grid-cols-3 lg:grid-cols-5">
        <Metric label="Projects" value={metrics.projects} />
        <Metric label="Pages" value={metrics.pages} />
        <Metric label="Keywords" value={metrics.keywords} />
        <Metric label="Mapped keywords" value={metrics.mappedKeywords} accent />
        <Metric label="Missing pages" value={metrics.missingPages} />
      </section>

      <section className="grid gap-8 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <span className="label-mono text-muted-foreground">Fig. 01 — Projects</span>
            <span className="label-mono text-muted-foreground">Rev. 03</span>
          </div>
          <TableShell>
            <thead>
              <tr>
                <Th>Project</Th>
                <Th>Pages</Th>
                <Th>Keywords</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <div className="flex flex-col">
                      <span className="font-medium text-foreground">{p.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{p.domain}</span>
                    </div>
                  </Td>
                  <Td className="font-mono">{p.pages}</Td>
                  <Td className="font-mono">{p.keywords}</Td>
                  <Td>
                    <StatusPill status={p.status} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </div>

        <div className="flex flex-col gap-4">
          <span className="label-mono text-muted-foreground">Fig. 02 — Semantic coverage</span>
          <div className="flex flex-1 flex-col justify-between border border-hairline bg-card p-6">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-5xl font-light tracking-tight text-foreground">
                {coverage}
              </span>
              <span className="label-mono text-muted-foreground">% mapped</span>
            </div>
            <div className="mt-6 flex flex-col gap-3">
              {clusters.map((c) => {
                const m = c.items.filter((i) => i.status === 'Mapped').length
                const pct = Math.round((m / c.items.length) * 100)
                return (
                  <div key={c.name} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-foreground/90">{c.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {m}/{c.items.length}
                      </span>
                    </div>
                    <div className="h-px w-full bg-hairline">
                      <div className="h-px bg-blue" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
