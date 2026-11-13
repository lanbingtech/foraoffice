import { test, expect } from '@playwright/test'
import { launchSdkTestHost, sdkHostIsElectron, type SdkTestHost } from './sdk-host'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { buildDocx } from '../packages/docx-engine/tests/helpers/build-docx'
import type { DocsEditorHandle } from '../apps/docs/src/renderer/embedded'

type FixtureWindow = Window & { editor: DocsEditorHandle; sdkReady: boolean; saved: number[] }

test('embedded SDK polishes only selected cell text with pending whole-table revisions', async () => {
  test.setTimeout(120_000)
  const bytes = await buildDocx({
    bodyXml:
      '<w:p><w:r><w:t>Condition report</w:t></w:r></w:p>' +
      '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="3000"/></w:tblGrid>' +
      '<w:tr><w:tc><w:p><w:r><w:t>Bridge has old cracks; inspect further.</w:t></w:r></w:p></w:tc>' +
      '<w:tc><w:p><w:r><w:t>Keep adjacent cell.</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '<w:p><w:r><w:t>Keep closing paragraph.</w:t></w:r></w:p>',
  })
  const root = resolve(__dirname, '../apps/docs/out/embedded')
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/') {
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html><html><head><link rel="stylesheet" href="/sdk/editor.css"></head><body>
        <div id="root"></div><script type="module">
        import {mountDocsEditor,createExternalDocsHost} from '/sdk/editor.js';
        const defaults={getLanguage:'en',getSystemLocale:'en-US',getTheme:'light',getDocumentTheme:'follow',
          getAuthorName:'SDK reviewer',getAutoSaveDefault:{on:false,updatedAt:0},
          getAiPanelPrefs:{side:'left',fontSize:'default',spellcheck:false,openInNewDocs:false,showAiSidebar:false},
          spellLanguages:{active:[],available:[]},docPasswordIntentRevision:0};
        const services=new Proxy({}, {get(_,name){
          if(name==='then')return undefined;
          if(name.startsWith('on'))return ()=>()=>{};
          if(name==='confirmDocumentReplace')return async()=>true;
          return async()=>defaults[name];
        }});
        window.saved=[];
        const doc=()=>({id:'table:fixture',name:'Table.docx',data:window.saved.length
          ?Uint8Array.from(window.saved).buffer
          :Uint8Array.from(atob('${Buffer.from(bytes).toString('base64')}'),c=>c.charCodeAt(0)).buffer});
        const host=createExternalDocsHost('${sdkHostIsElectron ? 'electron' : 'browser'}',services);
        host.documents={initialDocument:async()=>doc(),openDocument:async()=>doc(),
          saveDocument:async r=>{window.saved=Array.from(new Uint8Array(r.data));return {ok:true,committed:true,pending:false};}};
        window.editor=await mountDocsEditor(document.getElementById('root'),{host});
        await window.editor.ready;window.sdkReady=true;
        </script></body></html>`)
      return
    }
    const file = resolve(root, decodeURIComponent(path.slice(5)))
    if (!path.startsWith('/sdk/') || !file.startsWith(root + sep)) {
      response.writeHead(404).end()
      return
    }
    try {
      response.setHeader(
        'content-type',
        (
          { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' } as Record<
            string,
            string
          >
        )[extname(file)] ?? 'application/octet-stream',
      )
      response.end(await readFile(file))
    } catch {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No SDK fixture port')
  let browser: SdkTestHost | undefined
  try {
    browser = await launchSdkTestHost()
    const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } })
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.waitForFunction(() => (window as unknown as FixtureWindow).sdkReady)
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    const track = page.getByRole('button', { name: 'Track Changes', exact: true })
    await track.click()
    await expect(track).toHaveClass(/active/)
    const replace = await page.evaluate(async () => {
      const { editor } = window as unknown as FixtureWindow
      const client = editor.runtime.connect({ id: 'table-replacement' })
      try {
        client.context()
        return await client.execute({
          id: 'replace',
          name: 'replace_blocks',
          input: {
            startBlockIndex: 1,
            endBlockIndex: 1,
            html: '<table><tr><td>Bridge has fine cracks; inspect further.</td><td>Keep adjacent cell.</td></tr></table>',
          },
        })
      } finally {
        client.close()
      }
    })
    expect(replace.isError, replace.output).not.toBe(true)
    const body = page.locator('.ProseMirror[contenteditable="true"]').first()
    const oldTable = body.locator('table.doc-del')
    const newTable = body.locator('table.doc-ins')
    for (const mode of ['No Markup', 'Original', 'Simple Markup', 'All Markup']) {
      await page.getByRole('button', { name: 'Markup', exact: true }).click()
      await page
        .locator('.layout-menu')
        .getByRole('button', { name: new RegExp(`^${mode}`) })
        .click()
      if (mode === 'No Markup' || mode === 'Simple Markup') {
        await expect(oldTable).toBeHidden()
        await expect(newTable).toBeVisible()
      } else if (mode === 'Original') {
        await expect(oldTable).toBeVisible()
        await expect(newTable).toBeHidden()
      } else {
        await expect(oldTable).toBeVisible()
        await expect(newTable).toBeVisible()
      }
    }
    // Use the browser's selection machinery so ProseMirror must observe a
    // genuine DOM selection inside the rendered, still-pending new table.
    await newTable
      .locator('td')
      .first()
      .evaluate((cell) => {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          const at = node.textContent!.indexOf('fine cracks')
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(node, at)
          range.setEnd(node, at + 'fine cracks'.length)
          const selection = window.getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          document.dispatchEvent(new Event('selectionchange'))
          return
        }
        throw new Error('Cell text was not rendered')
      })
    await expect
      .poll(() =>
        page.evaluate(() => {
          const { editor } = window as unknown as FixtureWindow
          const client = editor.runtime.connect({ id: crypto.randomUUID() })
          try {
            return client.context().text
          } finally {
            client.close()
          }
        }),
      )
      .toContain('Selected text (11 characters): "fine cracks"')
    const context = await page.evaluate(() => {
      const { editor } = window as unknown as FixtureWindow
      const scope = editor.runtime.capture()
      editor.commands.bindScope('cell-polish', scope)
      return scope.text
    })
    expect(context).toContain('<sel>fine cracks</sel>')
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    const result = await page.evaluate(async () => {
      const { editor } = window as unknown as FixtureWindow
      return editor.commands.handle({
        requestId: 'cell-polish',
        callerId: 'external-ai',
        bindingId: 'cell-polish',
        command: 'execute_tool',
        payload: { name: 'replace_selection', input: { html: 'minor surface cracks' } },
      }) as Promise<{ isError?: boolean; mutated?: boolean }>
    })
    expect(result.isError).not.toBe(true)
    expect(result.mutated).toBe(true)
    await expect(oldTable).toContainText('Bridge has old cracks; inspect further.')
    await expect(newTable.locator('td').nth(1)).toHaveText('Keep adjacent cell.')
    await expect(newTable.locator('span.doc-del')).toHaveText('fine cracks')
    await expect(newTable.locator('span.doc-ins')).toHaveText('minor surface cracks')
    const reloaded = await page.evaluate(async () => {
      const { editor } = window as unknown as FixtureWindow
      const saved = await editor.documents.save()
      const reopened = await editor.documents.open()
      const client = editor.runtime.connect({ id: 'after-reload' })
      try {
        client.context()
        const result = await client.execute({
          id: 'read',
          name: 'read_blocks',
          input: { startBlockIndex: 0, endBlockIndex: 3 },
        })
        return { saved, reopened, result }
      } finally {
        client.close()
      }
    })
    expect(reloaded.saved).toBe(true)
    expect(reloaded.reopened).toBe(true)
    expect(reloaded.result.isError).not.toBe(true)
    expect(reloaded.result.output).toContain('Bridge has minor surface cracks; inspect further.')
    expect(reloaded.result.output).toContain('Keep adjacent cell.')
    expect(reloaded.result.output).toContain('Keep closing paragraph.')
    expect(reloaded.result.output).not.toContain('old cracks')
    expect(reloaded.result.output).not.toContain('fine cracks')
    await page.screenshot({ path: test.info().outputPath('sdk-cell-polish.png') })
  } finally {
    await browser?.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
})
