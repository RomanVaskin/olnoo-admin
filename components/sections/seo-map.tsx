import { SectionHeader } from '@/components/primitives'
import { useI18n } from '@/components/i18n-provider'
import { clusters } from '@/lib/data'

export function SeoMap() {
  const { t } = useI18n()

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="05"
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
