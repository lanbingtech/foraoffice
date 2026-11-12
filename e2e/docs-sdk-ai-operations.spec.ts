import { test, expect } from '@playwright/test'
import { launchSdkTestHost, sdkHostIsElectron, type SdkTestHost } from './sdk-host'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { buildDocx } from '../packages/docx-engine/tests/helpers/build-docx'
import type { DocsEditorHandle } from '../apps/docs/src/renderer/embedded'
import type { DocsEditorAction, DocsAiInstructionRequest } from '../apps/docs/src/renderer/embedded'

type Fixture = Window & {
  editor: DocsEditorHandle
  ready: boolean
  actions: DocsEditorAction[]
  fixture: {
    requests: DocsAiInstructionRequest[]
    custom: string | null
    mode: 'normal' | 'pending'
    aborts: number
    pending: {
      request: DocsAiInstructionRequest
      resolve(value: string): void
      signal: AbortSignal
    } | null
  }
}
const output = resolve(
  tmpdir(),
  'foraoffice-host-tests',
  sdkHostIsElectron ? 'electron-parity/ai-operations' : 'ai-operations',
)
for (const language of ['en', 'zh'] as const)
  test(`neutral shortcut resolution and free input (${language})`, async () => {
    test.setTimeout(120_000)
    const bytes = await buildDocx({
      bodyXml:
        '<w:p><w:r><w:t>Opening paragraph.</w:t></w:r></w:p>' +
        '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="7000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>Cell text to polish.</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>',
    })
    const root = resolve('apps/docs/out/embedded')
    const server = createServer(async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path === '/') {
        res.setHeader('content-type', 'text/html')
        res.end(`<!doctype html><html><head><link rel="stylesheet" href="/sdk/editor.css"></head><body><div id="root"></div><script type="module">
        import {mountDocsEditor,createExternalDocsHost} from '/sdk/editor.js';
        const defaults={getLanguage:'${language}',getSystemLocale:'en-US',getTheme:'light',getDocumentTheme:'follow',getAuthorName:'Fixture',getAutoSaveDefault:{on:false,updatedAt:0},getAiPanelPrefs:{side:'left',fontSize:'default',spellcheck:false,openInNewDocs:false,showAiSidebar:false},spellLanguages:{active:[],available:[]},docPasswordIntentRevision:0};
        const services=new Proxy({}, {get(_,key){if(key==='then')return undefined;if(key.startsWith('on'))return ()=>()=>{};if(key==='confirmDocumentReplace')return async()=>true;return async()=>defaults[key];}});
        window.actions=[];window.fixture={requests:[],custom:null,mode:'normal',pending:null,aborts:0};
        const host=createExternalDocsHost('${sdkHostIsElectron ? 'electron' : 'browser'}',services,{
          resolveInstruction:(request,signal)=>{
            window.fixture.requests.push(structuredClone(request));
            if(window.fixture.mode==='pending')return new Promise(resolve=>{
              const aborted=()=>{window.fixture.aborts++;};signal.addEventListener('abort',aborted,{once:true});
              window.fixture.pending={request,signal,resolve:value=>{signal.removeEventListener('abort',aborted);resolve(value);}};
            });
            return window.fixture.custom;
          },
          submit:async action=>{window.actions.push(structuredClone(action));}
        });
        let generation=0;
        const doc=()=>({id:'metadata:fixture:'+generation,name:'Fixture.docx',data:Uint8Array.from(atob('${Buffer.from(bytes).toString('base64')}'),c=>c.charCodeAt(0)).buffer});
        host.documents={initialDocument:async()=>doc(),openDocument:async()=>{generation++;return doc();}};
        window.editor=await mountDocsEditor(document.getElementById('root'),{host,language:'${language}'});await window.editor.ready;window.ready=true;
        </script></body></html>`)
        return
      }
      const file = resolve(root, path.slice(5))
      if (!path.startsWith('/sdk/') || !file.startsWith(root + sep)) {
        res.writeHead(404).end()
        return
      }
      try {
        res.setHeader(
          'content-type',
          (
            { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' } as Record<
              string,
              string
            >
          )[extname(file)] ?? 'application/octet-stream',
        )
        res.end(await readFile(file))
      } catch {
        res.writeHead(404).end()
      }
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No port')
    let browser: SdkTestHost | undefined
    try {
      browser = await launchSdkTestHost()
      const page = await browser.newPage({ viewport: { width: 1360, height: 800 } })
      page.on('dialog', (dialog) => dialog.accept())
      await page.goto(`http://127.0.0.1:${address.port}/`)
      await page.waitForFunction(() => (window as unknown as Fixture).ready)
      const review = language === 'en' ? 'Review' : '审阅'
      const home = language === 'en' ? 'Home' : '开始'
      const editorLabel = language === 'en' ? 'Editor' : '编辑器'
      const translateLabel = language === 'en' ? 'Translate' : '翻译'
      const frenchLabel = language === 'en' ? 'Translate to French' : '翻译为法文'
      const select = async (range = true) =>
        page.evaluate((range) => {
          const { editor } = window as unknown as Fixture
          const found = editor.inspection.find('Cell text')
          const match = found.matches[0]
          editor.inspection.locate({ ...match, to: range ? match.to : match.from }, { focus: true })
        }, range)
      await select(false)
      await page.getByRole('button', { name: review, exact: true }).click()
      await page.getByRole('button', { name: editorLabel, exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
        .toBe(1)
      await select()
      await page.getByRole('button', { name: editorLabel, exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
        .toBe(2)
      const shortcut = await page.evaluate(() => (window as unknown as Fixture).actions[1])
      expect(shortcut.context).toContain('Selected text (9 characters): "Cell text"')
      await select(false)
      await page.getByRole('button', { name: translateLabel, exact: true }).click()
      const languageMenu = page.locator('.layout-menu').filter({
        has: page.getByRole('button', { name: frenchLabel, exact: true }),
      })
      const menuBox = await languageMenu.boundingBox()
      expect(menuBox).not.toBeNull()
      expect(menuBox!.y).toBeGreaterThanOrEqual(0)
      expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(800)
      await page
        .locator('.layout-menu')
        .getByRole('button', { name: frenchLabel, exact: true })
        .click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
        .toBe(3)
      await select()
      await page.getByRole('button', { name: translateLabel, exact: true }).click()
      await page
        .locator('.layout-menu')
        .getByRole('button', { name: frenchLabel, exact: true })
        .click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
        .toBe(4)
      await page.getByRole('button', { name: home, exact: true }).click()
      await select()
      await expect(page.locator('.ai-ask-trigger')).toBeVisible()
      await page.locator('.ai-ask-trigger').click()
      const freeInstruction = `  ${shortcut.instruction}  `
      await page.locator('.ai-ask-pop-input').fill(freeInstruction)
      await page.locator('.ai-ask-confirm').click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
        .toBe(5)
      const actions = await page.evaluate(() => (window as unknown as Fixture).actions)
      const [fullProof, selectedProof, fullTranslation, selectedTranslation, free] = actions
      expect(free.instruction).toBe(freeInstruction)
      expect(free.kind).toBe(selectedProof.kind)
      expect(free.context).toBe(selectedProof.context)
      expect(fullTranslation.kind).toBe('edit')
      expect(selectedTranslation.kind).toBe('edit')
      await mkdir(output, { recursive: true })
      expect(fullProof).toHaveProperty('operationId', 'proofread_document')
      expect(selectedProof).toHaveProperty('operationId', 'proofread_selection')
      expect(fullTranslation).toMatchObject({
        operationId: 'translate_document',
        parameters: { targetLanguage: 'fr' },
      })
      expect(selectedTranslation).toMatchObject({
        operationId: 'translate_selection',
        parameters: { targetLanguage: 'fr' },
      })
      expect(free).not.toHaveProperty('operationId')
      expect(free).not.toHaveProperty('parameters')
      expect(
        await page.evaluate(() => (window as unknown as Fixture).fixture.requests.length),
      ).toBe(4)

      await page.evaluate(() => {
        ;(window as unknown as Fixture).fixture.custom = '  Use the configured operation.  '
      })
      await select()
      await page.getByRole('button', { name: review, exact: true }).click()
      await page.getByRole('button', { name: editorLabel, exact: true }).click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
        .toBe(6)
      await page.evaluate(() => {
        ;(window as unknown as Fixture).fixture.custom = 'Changed after submission'
      })
      const custom = await page.evaluate(() => (window as unknown as Fixture).actions[5])
      expect(custom.instruction).toBe('  Use the configured operation.  ')
      const edited = await page.evaluate(async () => {
        const { editor, actions } = window as unknown as Fixture
        return editor.commands.handle({
          requestId: 'cell-polish',
          callerId: 'external',
          bindingId: actions[5].bindingId,
          command: 'execute_tool',
          payload: { name: 'replace_selection', input: { html: 'Cell text improved' } },
        }) as Promise<{ isError?: boolean }>
      })
      expect(edited.isError).not.toBe(true)
      expect(
        await page.evaluate(() => (window as unknown as Fixture).editor.inspection.snapshot().text),
      ).toContain('Cell text improved to polish.')

      const startPending = async () => {
        await page.evaluate(() => {
          const f = (window as unknown as Fixture).fixture
          f.mode = 'pending'
          f.pending = null
        })
        await select()
        await page.getByRole('button', { name: editorLabel, exact: true }).click()
        await page.waitForFunction(() => (window as unknown as Fixture).fixture.pending !== null)
      }
      const finishLate = async () => {
        await page.evaluate(() => {
          ;(window as unknown as Fixture).fixture.pending!.resolve('Late configuration result')
        })
        await expect
          .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
          .toBe(6)
      }
      await startPending()
      await select()
      await page.keyboard.insertText('Cell text user')
      await page.waitForFunction(
        () => (window as unknown as Fixture).fixture.pending!.signal.aborted,
      )
      await finishLate()
      expect(
        await page.evaluate(() => (window as unknown as Fixture).editor.inspection.snapshot().text),
      ).toContain('Cell text user improved')

      await startPending()
      await page.evaluate(() => {
        const w = window as unknown as Fixture
        w.editor.commands.releaseScope(w.fixture.pending!.request.bindingId)
      })
      await page.waitForFunction(
        () => (window as unknown as Fixture).fixture.pending!.signal.aborted,
      )
      await finishLate()

      await startPending()
      expect(
        await page.evaluate(() => (window as unknown as Fixture).editor.documents.open()),
      ).toBe(true)
      await page.waitForFunction(
        () => (window as unknown as Fixture).fixture.pending!.signal.aborted,
      )
      await finishLate()
      await page.evaluate(() => {
        const f = (window as unknown as Fixture).fixture
        f.mode = 'normal'
        f.custom = null
      })
      await page
        .getByRole('button', { name: language === 'en' ? 'File' : '文件', exact: true })
        .click()
      await page.locator('.qa-name-with-ai').click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
        .toBe(7)
      await select()
      await page.keyboard.press('F7')
      await expect
        .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
        .toBe(8)
      const openContext = async () => {
        await select()
        await page
          .locator('.ProseMirror[contenteditable="true"] td p')
          .first()
          .evaluate((paragraph) => {
            const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect()
            paragraph.dispatchEvent(
              new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: rect.left + 2,
                clientY: rect.top + 2,
              }),
            )
          })
        await expect(page.locator('.ctx-menu')).toBeVisible()
      }
      await openContext()
      await page
        .locator('.ctx-menu')
        .getByRole('button', { name: language === 'en' ? 'Synonyms' : '同义词', exact: true })
        .click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
        .toBe(9)
      await openContext()
      await page
        .locator('.ctx-menu')
        .getByRole('button', { name: `${translateLabel} ›`, exact: true })
        .hover()
      await page
        .locator('.ctx-submenu')
        .getByRole('button', {
          name: language === 'en' ? 'Translate to French' : '翻译成法文',
          exact: true,
        })
        .click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
        .toBe(10)
      const comment = await page.evaluate(async () => {
        const { editor, actions, fixture } = window as unknown as Fixture
        const request = {
          callerId: 'external',
          bindingId: actions[7].bindingId,
        }
        await editor.commands.handle({
          ...request,
          requestId: crypto.randomUUID(),
          command: 'read_document',
          payload: {},
        })
        fixture.custom = 'Configured comment task'
        return editor.commands.handle({
          ...request,
          requestId: crypto.randomUUID(),
          command: 'execute_tool',
          payload: {
            name: 'add_comment',
            input: { blockIndex: 0, text: 'Opening', comment: 'Please clarify the opening.' },
          },
        }) as Promise<{ isError?: boolean }>
      })
      expect(comment.isError).not.toBe(true)
      await select(false)
      const resolveComments = page.getByRole('button', {
        name: language === 'en' ? 'AI Resolve Comments' : 'AI 处理批注',
        exact: true,
      })
      if (!(await resolveComments.isVisible()))
        await page.getByRole('button', { name: review, exact: true }).click()
      await resolveComments.click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
        .toBe(11)
      await page
        .getByRole('button', {
          name: language === 'en' ? 'Track Changes' : '修订',
          exact: true,
        })
        .click()
      await page.evaluate(() => {
        const { editor, fixture } = window as unknown as Fixture
        fixture.custom = 'Configured revision task'
        editor.inspection.locate(editor.inspection.find('Opening').matches[0], { focus: true })
      })
      await page.keyboard.insertText('Revised opening')
      await select(false)
      await page
        .getByRole('button', {
          name: language === 'en' ? 'AI Revision Summary' : 'AI 总结修订',
          exact: true,
        })
        .click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as Fixture).actions.length))
        .toBe(12)
      const final = await page.evaluate(() => {
        const w = window as unknown as Fixture
        return {
          requests: w.fixture.requests,
          actions: w.actions,
          aborts: w.fixture.aborts,
          state: w.editor.documents.state(),
          text: w.editor.inspection.snapshot().text,
        }
      })
      expect(final.state!.id).toBe('metadata:fixture:1')
      expect(final.text).toContain('Cell text to polish.')
      expect(final.aborts).toBe(3)
      expect(final.actions[6]).toMatchObject({
        kind: 'name_document',
        operationId: 'name_document',
        instruction: '',
      })
      expect(final.actions[7].operationId).toBe(fullProof.operationId)
      expect(final.actions[8]).toMatchObject({ operationId: 'suggest_synonyms', parameters: {} })
      expect(final.actions[9]).toMatchObject({
        operationId: selectedTranslation.operationId,
        parameters: selectedTranslation.parameters,
      })
      for (const [index, operationId, instruction] of [
        [10, 'resolve_comments', 'Configured comment task'],
        [11, 'summarize_revisions', 'Configured revision task'],
      ] as const) {
        const action = final.actions[index]
        expect(action).toMatchObject({ operationId, parameters: {}, instruction })
        expect(
          final.requests.find((request) => request.bindingId === action.bindingId),
        ).toMatchObject({
          operationId,
          parameters: {},
          documentId: action.documentId,
          context: action.context,
        })
        expect(action.context).toContain('Cell text to polish.')
      }
      expect(final.actions[11].context).toContain('Revised opening')
      await writeFile(
        resolve(output, `${language}.json`),
        JSON.stringify({ language, ...final }, null, 2),
      )
      await page.screenshot({ path: test.info().outputPath(`${language}-operations.png`) })
    } finally {
      await browser?.close()
      await new Promise<void>((done) => server.close(() => done()))
    }
  })
