// @vitest-environment node
import { expect, it } from 'vitest'
import { paginationActivity, trackPaginationActivity } from '../src/renderer/pagination-activity'

it('keeps newer pending layout visible after an older effect is disposed or completes late', () => {
  const old = trackPaginationActivity()
  old.update({ pending: true, fontProbe: true })
  const current = trackPaginationActivity()
  current.update({ pending: true })
  old.dispose()
  old.update({ pending: false, fontProbe: false })
  expect(paginationActivity.snapshot()).toMatchObject({
    owners: 1,
    pending: 1,
    active: 0,
    fontProbes: 0,
  })
  current.update({ pending: false, active: true })
  expect(paginationActivity.snapshot()).toMatchObject({ pending: 0, active: 1 })
  current.update({ active: false, error: 'layout failed' })
  expect(paginationActivity.snapshot().errors).toEqual(['layout failed'])
  current.dispose()
  expect(paginationActivity.snapshot()).toMatchObject({ owners: 0, pending: 0, active: 0 })
})
