import { isPhasedContentPending } from './phased-content'

/** Internal diagnostics only. No editing or scheduling decision reads this state. */
interface Activity {
  pending: boolean
  active: boolean
  fontProbe: boolean
  error: string | null
}

const owners = new Set<Activity>()
let generation = 0

export const paginationActivity = {
  snapshot() {
    const values = [...owners]
    return {
      version: 1,
      generation,
      contentPending: isPhasedContentPending(),
      owners: values.length,
      pending: values.filter((value) => value.pending).length,
      active: values.filter((value) => value.active).length,
      fontProbes: values.filter((value) => value.fontProbe).length,
      errors: values.flatMap((value) => (value.error ? [value.error] : [])),
    }
  },
}

export function trackPaginationActivity() {
  const value: Activity = { pending: false, active: false, fontProbe: false, error: null }
  owners.add(value)
  generation++
  return {
    update(next: Partial<Activity>) {
      if (owners.has(value)) Object.assign(value, next)
    },
    dispose() {
      owners.delete(value)
    },
  }
}

if (typeof window !== 'undefined')
  (window as unknown as Record<string, unknown>).__docsLayoutActivity = paginationActivity
