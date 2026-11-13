// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDocsFileAccess } from '../src/services/file-access'
import { createDocsDocumentCreation } from '../src/services/document-creation'

const scopes: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.dispose()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-create-'))
  const directory = join(root, 'documents')
  await mkdir(directory)
  const access = await createDocsFileAccess({
    stateDirectory: join(root, 'private'),
    readRoots: [directory],
    writeRoots: [directory],
  })
  scopes.push(access)
  return { root, directory, access }
}

it('creates exact supplied text using authorized exclusive outputs and reports failed opening truthfully', async () => {
  const { directory, access } = await fixture()
  await writeFile(join(directory, 'Report.md'), 'Existing file')
  const createWord = vi.fn()
  const printHtml = vi.fn()
  const openFile = vi.fn(async () => {
    throw new Error('Viewer unavailable')
  })
  const creator = createDocsDocumentCreation({ access, directory, createWord, printHtml, openFile })
  const created = await creator.create({
    type: 'md',
    title: 'Report',
    content: '# Supplied content',
  })
  expect(created).toMatchObject({
    ok: true,
    committed: true,
    opened: false,
    path: join(directory, 'Report-2.md'),
  })
  expect(await readFile(created.path!, 'utf8')).toBe('# Supplied content')
  expect(await readFile(join(directory, 'Report.md'), 'utf8')).toBe('Existing file')
  expect(createWord).not.toHaveBeenCalled()
  expect(printHtml).not.toHaveBeenCalled()
  const html = '<!doctype html><html><body>Supplied HTML</body></html>'
  const createdHtml = await creator.create({ type: 'html', title: '../Report', content: html })
  expect(createdHtml.path).toBe(join(directory, '.._Report.html'))
  expect(await readFile(createdHtml.path!, 'utf8')).toBe(html)
})

it('waits for the real Word save outcome instead of treating a new view as a saved file', async () => {
  const { directory, access } = await fixture()
  let acknowledge!: (value: {
    ok: boolean
    committed: boolean | null
    pending: boolean
    path?: string
  }) => void
  const createWord = vi.fn(
    () =>
      new Promise<Parameters<typeof acknowledge>[0]>((resolve) => {
        acknowledge = resolve
      }),
  )
  const creator = createDocsDocumentCreation({ access, directory, createWord, printHtml: vi.fn() })
  let settled = false
  const pending = creator
    .create({ type: 'docx', title: 'Word', content: '<p>Supplied Word</p>' })
    .then((result) => {
      settled = true
      return result
    })
  await vi.waitFor(() => expect(createWord).toHaveBeenCalledOnce())
  expect(settled).toBe(false)
  expect(createWord).toHaveBeenCalledWith({
    title: 'Word',
    html: '<p>Supplied Word</p>',
    path: join(directory, 'Word.docx'),
  })
  acknowledge({ ok: true, committed: true, pending: false, path: join(directory, 'Word.docx') })
  expect(await pending).toMatchObject({
    ok: true,
    committed: true,
    opened: true,
    path: join(directory, 'Word.docx'),
  })
})

it('sanitizes supplied PDF HTML through the shared template and persists the returned host bytes', async () => {
  const { directory, access } = await fixture()
  const pdf = Buffer.from('%PDF-test-host-bytes')
  const printHtml = vi.fn(async (_html: string) => pdf)
  const creator = createDocsDocumentCreation({ access, directory, createWord: vi.fn(), printHtml })
  const created = await creator.create({
    type: 'pdf',
    title: 'PDF',
    content: '<p>Supplied PDF</p><script>untrusted()</script>',
  })
  expect(created).toMatchObject({ ok: true, committed: true, opened: false })
  expect(printHtml.mock.calls[0]?.[0]).toContain('Supplied PDF')
  expect(printHtml.mock.calls[0]?.[0]).toContain('Content-Security-Policy')
  expect(printHtml.mock.calls[0]?.[0]).not.toContain('<script>')
  expect(await readFile(created.path!)).toEqual(pdf)
})

it('refuses unauthorized output before invoking a host and preserves unknown Word outcomes', async () => {
  const { root, directory, access } = await fixture()
  const createWord = vi.fn(async () => {
    throw new Error('Disconnected while saving')
  })
  const printHtml = vi.fn()
  const forbidden = createDocsDocumentCreation({ access, directory: root, createWord, printHtml })
  expect(
    await forbidden.create({ type: 'pdf', title: 'Forbidden', content: '<p>Text</p>' }),
  ).toMatchObject({ ok: false, committed: false, errorCode: 'permission_denied' })
  expect(printHtml).not.toHaveBeenCalled()
  const creator = createDocsDocumentCreation({ access, directory, createWord, printHtml })
  expect(
    await creator.create({ type: 'docx', title: 'Word', content: '<p>Text</p>' }),
  ).toMatchObject({ ok: false, committed: null })
})
