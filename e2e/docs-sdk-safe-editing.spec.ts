// Modified for ForaOffice: verify safe edits through real mounted SDK hosts and hosted bytes.
import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, posix, resolve, sep } from 'node:path'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import type { DocsEditorHandle } from '../apps/docs/src/renderer/embedded'
import { launchSdkTestHost, sdkHostIsElectron, type SdkTestHost } from './sdk-host'

type FixtureWindow = Window & {
  editor: DocsEditorHandle
  ready: boolean
  fixture: { saved: number[]; saves: number }
}

test('mounted SDK refuses an invalid image and saves header edits in their original containers', async () => {
  test.setTimeout(120_000)
  const original = await readFile(
    resolve(__dirname, '../apps/docs/tests/fixtures/foraoffice-header-textbox.docx'),
  )
  const root = resolve(__dirname, '../apps/docs/out/embedded')
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (path === '/') {
      response.setHeader('content-type', 'text/html')
      response.end(`<!doctype html><html><head><link rel="stylesheet" href="/sdk/editor.css"></head><body>
        <div id="root"></div><script type="module">
        import {mountDocsEditor,createExternalDocsHost} from '/sdk/editor.js';
        const defaults={getLanguage:'en',getSystemLocale:'en-US',getTheme:'light',getDocumentTheme:'follow',
          getAuthorName:'Safe editing fixture',getAutoSaveDefault:{on:false,updatedAt:0},
          getAiPanelPrefs:{side:'left',fontSize:'default',spellcheck:false,openInNewDocs:false,showAiSidebar:false},
          spellLanguages:{active:[],available:[]},docPasswordIntentRevision:0};
        const services=new Proxy({}, {get(_,name){
          if(name==='then')return undefined;
          if(name.startsWith('on'))return ()=>()=>{};
          if(name==='confirmDocumentReplace')return async()=>true;
          return async()=>defaults[name];
        }});
        window.fixture={saved:[],saves:0};
        const host=createExternalDocsHost('${sdkHostIsElectron ? 'electron' : 'browser'}',services);
        const initial=Uint8Array.from(atob('${original.toString('base64')}'),c=>c.charCodeAt(0));
        const doc=()=>({id:'safe-editing:fixture',name:'Safe editing.docx',
          data:Uint8Array.from(window.fixture.saved.length?window.fixture.saved:initial).buffer});
        host.documents={initialDocument:async()=>doc(),openDocument:async()=>doc(),
          saveDocument:async request=>{window.fixture.saved=Array.from(new Uint8Array(request.data));window.fixture.saves++;
            return {ok:true,committed:true,pending:false,document:{id:'safe-editing:fixture',name:'Safe editing.docx'}};}};
        window.editor=await mountDocsEditor(document.getElementById('root'),{host});
        await window.editor.ready;window.ready=true;
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
          {
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.woff2': 'font/woff2',
            '.wasm': 'application/wasm',
          } as Record<string, string>
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
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.waitForFunction(() => (window as unknown as FixtureWindow).ready)
    const result = await page.evaluate(async () => {
      const { editor, fixture } = window as unknown as FixtureWindow
      const caller = editor.runtime.connect({ id: 'safe-editing-acceptance' })
      try {
        const before = caller.context()
        const dirtyBefore = editor.documents.state()!.dirty
        const invalidImage = await caller.execute({
          id: 'invalid-image',
          name: 'replace_blocks',
          input: {
            startBlockIndex: 0,
            endBlockIndex: 0,
            html: `<p>INVALID_IMAGE_MUST_NOT_APPEAR <img src="media:${before.documentId}:${before.revision}:99999.0"></p>`,
          },
        })
        const afterRefusal = caller.context()
        const dirtyAfterRefusal = editor.documents.state()!.dirty
        const header = await caller.execute({
          id: 'header',
          name: 'set_header_footer',
          input: {
            kind: 'header',
            section: 0,
            textboxIndex: 0,
            text: 'SAFE_HEADER {PAGE} / {NUMPAGES}',
          },
        })
        const saved = await editor.documents.save()
        return {
          before,
          invalidImage,
          afterRefusal,
          dirtyBefore,
          dirtyAfterRefusal,
          header,
          saved,
          state: editor.documents.state(),
          bytes: fixture.saved,
          saves: fixture.saves,
        }
      } finally {
        caller.close()
      }
    })
    expect(result.before.text).toContain('OLD_HEADER')
    expect(result.invalidImage).toMatchObject({
      isError: true,
      committed: false,
      mutated: false,
      errorCode: 'invalid_input',
      revision: result.before.revision,
    })
    expect(result.invalidImage.imageReferenceErrors).toHaveLength(1)
    expect(result.afterRefusal).toEqual(result.before)
    expect(result.dirtyBefore).toBe(false)
    expect(result.dirtyAfterRefusal).toBe(false)
    expect(result.header).toMatchObject({ committed: true })
    expect(result.header.isError).not.toBe(true)
    expect(result.saved).toBe(true)
    expect(result.saves).toBe(1)
    expect(result.state).toMatchObject({ path: null, dirty: false })

    const saved = Uint8Array.from(result.bytes)
    await writeFile(test.info().outputPath('hosted-safe.docx'), saved)
    const zip = await JSZip.loadAsync(saved)
    const body = await zip.file('word/document.xml')!.async('string')
    expect(body).toContain('HEADER FIXTURE')
    expect(body).not.toContain('INVALID_IMAGE_MUST_NOT_APPEAR')
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
    const section = parser.parse(body)['w:document']['w:body']['w:sectPr']
    const references = [section['w:headerReference']].flat()
    const rId = references.find((reference) => reference['w:type'] === 'default')['r:id']
    const rels = parser.parse(await zip.file('word/_rels/document.xml.rels')!.async('string'))
    const target = rels.Relationships.Relationship.find(
      (rel: { Id: string }) => rel.Id === rId,
    ).Target
    const part = posix.normalize(target.startsWith('/') ? target.slice(1) : `word/${target}`)
    const xml = await zip.file(part)!.async('string')
    expect(xml).not.toContain('OLD_HEADER')
    const boxes = [...xml.matchAll(/<w:txbxContent\b[^>]*>([\s\S]*?)<\/w:txbxContent>/g)]
    expect(boxes).toHaveLength(2)
    for (const [, contents] of boxes) {
      expect(contents).toContain('SAFE_HEADER')
      expect(contents).toMatch(/<w:instrText\b[^>]*>\s*PAGE\b/)
      expect(contents).toMatch(/<w:instrText\b[^>]*>\s*NUMPAGES\b/)
    }
    expect(xml.match(/<mc:Choice\b/g)).toHaveLength(1)
    expect(xml.match(/<mc:Fallback\b/g)).toHaveLength(1)
    expect(xml).toContain('<wp:extent cx="1828800" cy="1828800"/>')
    expect(xml).toContain('width:2in;height:2in')
    const paragraphs = [parser.parse(xml)['w:hdr']['w:p']].flat()
    expect(paragraphs).toHaveLength(1)

    const reopened = await page.evaluate(async () => {
      const { editor } = window as unknown as FixtureWindow
      const opened = await editor.documents.open()
      const caller = editor.runtime.connect({ id: 'safe-editing-reopened' })
      try {
        return { opened, context: caller.context(), body: editor.inspection.snapshot().text }
      } finally {
        caller.close()
      }
    })
    expect(reopened.opened).toBe(true)
    expect(reopened.context.documentId).not.toBe(result.before.documentId)
    expect(reopened.context.text).toContain('SAFE_HEADER {PAGE} / {NUMPAGES}')
    expect(reopened.context.text).not.toContain('OLD_HEADER')
    expect(reopened.body).toContain('HEADER FIXTURE')
    expect(reopened.body).not.toContain('INVALID_IMAGE_MUST_NOT_APPEAR')
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    await new Promise<void>((done) => server.close(() => done()))
  }
})
