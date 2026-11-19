import { isAbsolute, relative, resolve, sep } from 'node:path'

export type PerformanceObservation = { ok: true; durationMs: number } | { ok: false; error: string }

export function summarizeScenario(observations: PerformanceObservation[], required: number) {
  if (!Number.isInteger(required) || required < 1) throw new Error('Invalid sample requirement')
  const values: number[] = []
  const errors: string[] = []
  for (const observation of observations) {
    if (!observation.ok) errors.push(observation.error)
    else if (!Number.isFinite(observation.durationMs) || observation.durationMs < 0)
      errors.push('Invalid measured duration')
    else values.push(observation.durationMs)
  }
  values.sort((a, b) => a - b)
  const middle = Math.floor(values.length / 2)
  return {
    status: errors.length === 0 && values.length >= required ? 'complete' : 'incomplete',
    valid: values.length,
    failed: errors.length,
    required,
    medianMs: values.length
      ? values.length % 2
        ? values[middle]
        : (values[middle - 1] + values[middle]) / 2
      : null,
    p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
    maxMs: values.at(-1) ?? null,
    errors,
  }
}

/** Real paths must be supplied by the caller after resolving existing ancestors. */
export function assertExternalArtifacts(repository: string, artifacts: string): void {
  if (!isAbsolute(artifacts)) throw new Error('Performance artifacts require an absolute path')
  const rel = relative(resolve(repository), resolve(artifacts))
  if (!rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)))
    throw new Error('Performance artifacts must stay outside the source repository')
}

type Report = {
  status: string
  condition: unknown
  summaries: Record<string, ReturnType<typeof summarizeScenario>>
}

/** A signed delta is evidence, never an automatic performance acceptance decision. */
export function comparePerformanceReports(before: Report, after: Report) {
  if (before.status !== 'complete' || after.status !== 'complete')
    throw new Error('Both reports must be complete')
  if (JSON.stringify(before.condition) !== JSON.stringify(after.condition))
    throw new Error('Performance conditions differ')
  const names = Object.keys(before.summaries).sort()
  if (
    !names.length ||
    JSON.stringify(names) !== JSON.stringify(Object.keys(after.summaries).sort())
  )
    throw new Error('Performance scenarios differ or are empty')
  return Object.fromEntries(
    names.map((name) => {
      const a = before.summaries[name]
      const b = after.summaries[name]
      if (
        a.status !== 'complete' ||
        b.status !== 'complete' ||
        a.required !== b.required ||
        a.medianMs === null ||
        b.medianMs === null ||
        a.p95Ms === null ||
        b.p95Ms === null
      )
        throw new Error(`Scenario ${name} must be complete with matching requirements`)
      return [
        name,
        {
          before: a,
          after: b,
          medianDeltaMs: b.medianMs - a.medianMs,
          p95DeltaMs: b.p95Ms - a.p95Ms,
          p95ChangePercent: a.p95Ms ? ((b.p95Ms - a.p95Ms) / a.p95Ms) * 100 : null,
        },
      ]
    }),
  )
}
