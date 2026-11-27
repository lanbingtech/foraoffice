import { _electron as electron, expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PmNode } from '../apps/docs/src/renderer/editor/convert'
import type { ViewportPacket } from '../apps/docs/src/renderer/editor/viewport-surface'
import type { PageCut } from '../apps/docs/src/renderer/pagination-cuts'
import type { DesktopApi } from '../apps/docs/src/shared/ipc'
import { buildDocx } from '../packages/docx-engine/tests/helpers/build-docx'

type LayoutReply = Partial<ViewportPacket> & {
  type: string
  publication: number
  pages?: PageCut[]
  pageFrames?: Array<{ cutIndex: number; sourceStart: number | null; top: number; height: number }>
  reason?: string
  root?: Omit<PmNode, 'content'>
  blocks?: ReadableStream<PmNode[]>
}

type ViewportProbe = {
  mount(
    packet: ViewportPacket,
    source: PmNode,
  ): {
    applied: string
    length: number
    difference: { index: number; owner: number[]; viewport: number[] } | null
    focused: boolean
  }
  edits(): {
    edited: string
    editedViewport: string
    revision: number
  }
  destroy(): void
}

// The test source and viewport share ProseMirror schema and transaction classes.
const surfaceProbe = `
import { TextSelection } from '@tiptap/pm/state';
import { AuthoredDocument, AuthoredEditor } from './apps/docs/src/renderer/editor/authored-document';
import { editorExtensions } from './apps/docs/src/renderer/editor/extensions';
import { createViewportSurface } from './apps/docs/src/renderer/editor/viewport-surface';

let active;

export function mount(packet, source) {
  const native = document.querySelector('.editor-scroll .ProseMirror.doc-page');
  const original = native.querySelector('p > .page-gap-inline').nextSibling;
  if (!(original instanceof Text)) throw new Error('Native page did not begin with a text node');
  const editor = new AuthoredEditor(editorExtensions);
  const owner = new AuthoredDocument(editor, editor.schema.nodeFromJSON(source), () => {});
  const state = owner.read().state;
  owner.dispatch(state.tr.setSelection(TextSelection.create(state.doc, packet.content.model.from + 16)));
  const mount = document.createElement('div');
  mount.style.position = 'absolute';
  native.after(mount);
  const viewport = createViewportSurface(mount, {
    readSource: () => owner.read(),
    dispatch: (transaction) => owner.dispatch(transaction),
    requestRange: () => {},
    attributes: { class: native.className, style: native.style.cssText },
  });
  active = { owner, viewport, mount };
  try {
    const applied = viewport.publish(packet);
    const view = viewport.view;
    const projected = view?.dom.querySelector('p > .page-gap-inline')?.nextSibling;
    if (!(projected instanceof Text)) throw new Error('Viewport did not mount its page continuation: ' + applied);
    if (projected.data !== original.data) throw new Error('Mounted continuation differs from native source text');
    const coords = (node, root, index, range) => {
      const origin = root.getBoundingClientRect();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      const rect = range.getBoundingClientRect();
      return [rect.left - origin.left, rect.top - origin.top, rect.width, rect.height];
    };
    const nativeRange = document.createRange();
    const projectedRange = document.createRange();
    let difference = null;
    for (let index = 0; index < original.length; index++) {
      const owner = coords(original, native, index, nativeRange);
      const viewport = coords(projected, view.dom, index, projectedRange);
      if (owner.some((value, axis) => Math.abs(viewport[axis] - value) > 0.05)) {
        difference = { index, owner, viewport };
        break;
      }
    }
    view.focus();
    return { applied, length: original.length, difference, focused: view.hasFocus() };
  } catch (error) {
    destroy();
    throw error;
  }
}

export function edits() {
  const { owner, viewport } = active;
  return {
    edited: owner.read().state.doc.textContent,
    editedViewport: viewport.view.state.doc.textContent,
    revision: owner.read().revision,
  };
}

export function destroy() {
  if (!active) return;
  const { owner, viewport, mount } = active;
  active = undefined;
  viewport.destroy();
  owner.destroy();
  mount.remove();
}
`

const text = Array.from(
  { length: 170 },
  (_, i) =>
    `Test passage ${i + 1} contains varied short and long words to exercise browser wrapping.`,
).join(' ')
const variants = [
  { format: 'plain', properties: '', prefix: '' },
  {
    format: 'drop cap',
    properties:
      '<w:framePr w:dropCap="drop" w:lines="3" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/>',
    prefix: '',
  },
  {
    format: 'page break before',
    properties: '<w:pageBreakBefore/>',
    prefix: '<w:p><w:r><w:t>Earlier paragraph</w:t></w:r></w:p>',
  },
]

for (const { format, properties, prefix } of variants) {
  test(`physical page continuation for a ${format} paragraph`, async () => {
    const workspace = test.info().outputPath('workspace')
    await mkdir(workspace, { recursive: true })
    const file = join(workspace, 'Continuation.docx')
    await writeFile(
      file,
      await buildDocx({
        bodyXml: `${prefix}<w:p><w:pPr>${properties}<w:ind w:firstLine="720"/><w:jc w:val="both"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`,
        sectPrXml:
          '<w:sectPr><w:pgSz w:w="11906" w:h="10800"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>',
      }),
    )
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined,
      ),
    ) as Record<string, string>
    const app = await electron.launch({
      args: [resolve(__dirname, '../apps/docs'), file],
      env: { ...env, AI_OFFICE_USER_DATA: join(workspace, 'profile'), GENOFFICE_LANG: 'en' },
    })
    try {
      const page = await app.firstWindow()
      const paragraph = page.locator('.editor-scroll .ProseMirror.doc-page > p', {
        hasText: 'Test passage 1 contains',
      })
      await expect(paragraph.locator(':scope > .page-gap-inline').nth(1)).toBeAttached({
        timeout: 35_000,
      })
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      const result = await page.evaluate(async (filePath) => {
        const owner = window as unknown as Window & { desktop: DesktopApi }
        const file = await owner.desktop.openDocxPath(filePath)
        if (!file || 'needsPassword' in file) throw new Error('Cannot read the paragraph fixture')
        const bytes = await fetch(file.dataUrl).then((response) => response.arrayBuffer())
        const ports = new MessageChannel()
        let range: { from: number; to: number; publication: number }
        let source: Promise<PmNode> | undefined
        const packet = new Promise<{
          from: number
          to: number
          source: PmNode
          viewport: ViewportPacket
        }>((resolve, reject) => {
          ports.port1.onmessage = ({ data }: MessageEvent<LayoutReply>) => {
            if (data.type === 'failure') reject(new Error(data.reason))
            else if (data.type === 'source' && data.root && data.blocks) {
              const root = data.root
              const content: PmNode[] = []
              source = data.blocks
                .pipeTo(
                  new WritableStream({
                    write: (chunk) => {
                      content.push(...chunk)
                    },
                  }),
                )
                .then(() => ({ ...root, content }))
            } else if (data.type === 'layout') {
              const second = data.pageFrames?.find(
                (frame) => data.pages?.[frame.cutIndex].lead.kind === 'line',
              )
              const third =
                second && data.pageFrames?.find((frame) => frame.cutIndex === second.cutIndex + 1)
              if (
                !second ||
                !third ||
                data.pages?.[third.cutIndex].lead.kind !== 'line' ||
                second.sourceStart == null ||
                third.sourceStart == null
              ) {
                reject(
                  new Error(
                    'The layout did not publish two adjacent physical page turns inside the paragraph',
                  ),
                )
                return
              }
              range = {
                from: second.sourceStart,
                to: third.sourceStart,
                publication: data.publication,
              }
              ports.port1.postMessage({
                type: 'viewport',
                sequence: 1,
                publication: data.publication,
                bounds: {
                  top: second.top + second.height / 4,
                  bottom: second.top + (second.height * 3) / 4,
                },
              })
            } else if (data.type === 'viewport' && data.publication === range.publication) {
              if (
                !source ||
                !data.content ||
                data.revision === undefined ||
                data.sequence === undefined
              ) {
                reject(new Error('The layout did not publish the viewport and its source'))
                return
              }
              const { content, publication, revision, sequence } = data
              source.then(
                (source) =>
                  resolve({
                    ...range,
                    source,
                    viewport: { content, publication, revision, sequence },
                  }),
                reject,
              )
            }
          }
        })
        window.postMessage(
          {
            type: 'docs:connect-layout',
            width: innerWidth,
            height: innerHeight,
            expectedScale: devicePixelRatio,
          },
          '*',
          [ports.port2],
        )
        ports.port1.postMessage(
          {
            type: 'open',
            includeSource: true,
            width: innerWidth,
            height: innerHeight,
            language: 'en',
            file: { path: '', dataUrl: '', name: file.name, hash: file.hash, data: bytes },
          },
          [bytes],
        )
        try {
          return await packet
        } finally {
          ports.port1.close()
        }
      }, file)
      const { blocks, model } = result.viewport.content
      expect(blocks).toHaveLength(1)
      if (format !== 'plain') {
        await expect(paragraph).toHaveClass(
          format === 'drop cap' ? /has-drop-cap/ : /page-break-before/,
        )
        expect(blocks[0].paragraph).toBeUndefined()
        expect(model?.document.content?.[0].content?.[0].text).toBe(text)
        return
      }

      expect(blocks[0].paragraph).toEqual({ from: result.from, to: result.to })
      expect([model?.from, model?.to]).toEqual([result.from, result.to])
      expect(model?.document.content?.[0].content?.[0].text).toBe(
        text.slice(result.from - 1, result.to - 1),
      )
      const script = await build({
        stdin: { contents: surfaceProbe, resolveDir: resolve(__dirname, '..'), loader: 'ts' },
        bundle: true,
        format: 'iife',
        platform: 'browser',
        write: false,
        globalName: 'viewportParagraphProbe',
        define: { 'import.meta.env': '{}' },
      })
      const cdp = await page.context().newCDPSession(page)
      try {
        const injected = await cdp.send('Runtime.evaluate', {
          expression: script.outputFiles[0].text,
          allowUnsafeEvalBlockedByCSP: true,
        })
        expect(injected.exceptionDetails).toBeUndefined()
      } finally {
        await cdp.detach()
      }
      try {
        const observed = await page.evaluate(({ viewport, source }) => {
          const probe = (window as unknown as { viewportParagraphProbe: ViewportProbe })
            .viewportParagraphProbe
          return probe.mount(viewport, source)
        }, result)
        expect(observed.applied).toBe('applied')
        expect(observed.length).toBe(result.to - result.from)
        expect(observed.difference).toBeNull()
        expect(observed.focused).toBe(true)
        await page.keyboard.insertText('!')
        const insertion = result.from + 15
        await expect
          .poll(() =>
            page.evaluate(() =>
              (
                window as unknown as { viewportParagraphProbe: ViewportProbe }
              ).viewportParagraphProbe.edits(),
            ),
          )
          .toEqual({
            revision: 1,
            edited: text.slice(0, insertion) + '!' + text.slice(insertion),
            editedViewport:
              text.slice(result.from - 1, insertion) + '!' + text.slice(insertion, result.to - 1),
          })
      } finally {
        await page.evaluate(() =>
          (
            window as unknown as { viewportParagraphProbe: ViewportProbe }
          ).viewportParagraphProbe.destroy(),
        )
      }
    } finally {
      await app.close()
    }
  })
}
