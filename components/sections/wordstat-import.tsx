'use client'

import { useState } from 'react'
import { SectionHeader, StatusPill, TableShell, Th, Td } from '@/components/primitives'
import { projects, previewRows, recentImports } from '@/lib/data'

export function WordstatImport() {
  const [project, setProject] = useState(projects[0].id)

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        index="06"
        title="Wordstat Import"
        description="Bring Yandex Wordstat exports into a project. Expected columns: Keyword, Frequency, Region."
      />

      <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr]">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <label htmlFor="project" className="label-mono text-muted-foreground">
              Project
            </label>
            <div className="relative">
              <select
                id="project"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                className="w-full appearance-none border border-hairline bg-card px-4 py-3 text-sm text-foreground outline-none focus:border-blue"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.domain}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground">
                ▾
              </span>
            </div>
          </div>

          <label
            htmlFor="upload"
            className="flex cursor-pointer flex-col items-center justify-center gap-3 border border-dashed border-border bg-card px-6 py-12 text-center transition-colors hover:border-blue"
          >
            <span className="font-mono text-2xl text-muted-foreground">↑</span>
            <span className="text-sm text-foreground">Drop CSV / XLSX or click to browse</span>
            <span className="label-mono text-muted-foreground">Keyword · Frequency · Region</span>
            <input id="upload" type="file" accept=".csv,.xlsx" className="sr-only" />
          </label>

          <button className="label-mono w-full border border-foreground bg-foreground px-4 py-3 text-background transition-colors hover:bg-transparent hover:text-foreground">
            Import keywords
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <span className="label-mono text-muted-foreground">Preview — 5 of 214 rows</span>
          <TableShell>
            <thead>
              <tr>
                <Th>Keyword</Th>
                <Th className="text-right">Frequency</Th>
                <Th>Region</Th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((r) => (
                <tr key={r.keyword}>
                  <Td>{r.keyword}</Td>
                  <Td className="text-right font-mono">
                    {r.frequency.toLocaleString('ru-RU')}
                  </Td>
                  <Td className="text-muted-foreground">{r.region}</Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <span className="label-mono text-muted-foreground">Recent imports</span>
        <TableShell>
          <thead>
            <tr>
              <Th>File</Th>
              <Th>Project</Th>
              <Th className="text-right">Rows</Th>
              <Th>Date</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {recentImports.map((r) => (
              <tr key={r.file}>
                <Td className="font-mono text-xs">{r.file}</Td>
                <Td>{r.project}</Td>
                <Td className="text-right font-mono">{r.rows}</Td>
                <Td className="font-mono text-xs text-muted-foreground">{r.date}</Td>
                <Td>
                  <StatusPill status={r.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </TableShell>
      </div>
    </div>
  )
}
