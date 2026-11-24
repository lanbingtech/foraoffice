import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

test('CJK fragment reads preserve published shrink, glyph and caret geometry', async ({ page }) => {
  const bundle = await build({
    stdin: {
      resolveDir: resolve(__dirname, '..'),
      loader: 'ts',
      contents: `
        import { Editor, Extension, Node } from '@tiptap/core';
        import { Plugin } from '@tiptap/pm/state';
        import { Decoration, DecorationSet } from '@tiptap/pm/view';
        import { CjkPunctShrinkExtension, cjkPunctShrinkPluginKey, DOC_CSS_COMMITTED_EVENT }
          from './apps/docs/src/renderer/editor/cjk-punct-shrink';
        const Doc = Node.create({ name: 'doc', topNode: true, content: 'block+' });
        const Text = Node.create({ name: 'text', group: 'inline' });
        const Paragraph = Node.create({
          name: 'paragraph', group: 'block', content: 'inline*',
          parseHTML: () => [{ tag: 'p' }], renderHTML: () => ['p', 0],
        });
        const WrapWidgets = Extension.create({
          addProseMirrorPlugins() {
            return [new Plugin({ props: { decorations(state) {
              const widget = (className) => () => Object.assign(document.createElement('span'), { className });
              return DecorationSet.create(state.doc, [
                Decoration.widget(1, widget('doc-inline-img--wrap-square-left')),
                Decoration.widget(24, widget('page-gap-inline')),
              ]);
            } } })];
          },
        });
        window.measureLocalCjkEdit = (text, { coupled, replaceUnchanged, editPunctuation, sameWidthEdit }) => {
          const root = document.createElement('article');
          root.style.width = '169px';
          document.body.append(root);
          const paragraph = { type: 'docParagraph', content: [{ type: 'text', text }] };
          const editor = new Editor({
            element: root,
            extensions: [Doc, Text, Paragraph.extend({ name: 'docParagraph' }), CjkPunctShrinkExtension],
            content: { type: 'doc', content: [
              { type: 'docParagraph', content: [{ type: 'text', text: editPunctuation ? text : 'ABC 中文' }] },
              paragraph,
              paragraph,
            ] },
          });
          try {
            editor.storage.cjkPunctShrink.enabled = true;
            editor.storage.cjkPunctShrink.legacyLayout = true;
            const untouched = root.querySelector('p:nth-child(2)');
            if (coupled) untouched.classList.add('has-drop-cap');
            document.dispatchEvent(new Event(DOC_CSS_COMMITTED_EVENT));
            const decorations = () => {
              const leading = editor.state.doc.firstChild.nodeSize;
              return cjkPunctShrinkPluginKey.getState(editor.state).find(leading + 1)
                .map(({ from, to, spec }) => [from - leading, to - leading, spec.style, spec.hang]);
            };
            const previous = decorations();
            const leadingDecorations = (set, doc) => set.find(1, doc.firstChild.nodeSize - 1)
              .map(({ from, to, spec }) => [from, to, spec.style, spec.hang]);
            let mappedBefore;
            let untouchedReads = 0;
            const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
            Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { ...width, get() {
              if (this.parentElement === editor.view.dom && this !== editor.view.dom.firstElementChild)
                untouchedReads++;
              return width.get.call(this);
            } });
            try {
              const revision = sameWidthEdit
                ? editor.state.tr.insertText('試', 1, 2)
                : editor.state.tr.insertText('試', 3);
              if (replaceUnchanged) {
                const start = revision.doc.firstChild.nodeSize + 1;
                revision.insertText(text, start, start + text.length);
              }
              const mapped = cjkPunctShrinkPluginKey.getState(editor.state).map(revision.mapping, revision.doc);
              mappedBefore = leadingDecorations(mapped, revision.doc);
              editor.view.dispatch(revision);
            } finally {
              Object.defineProperty(HTMLElement.prototype, 'offsetWidth', width);
            }
            const origin = editor.view.dom.firstElementChild.getBoundingClientRect();
            const caret = editor.view.coordsAtPos(editPunctuation ? 24 : 4);
            return {
              untouchedReads, previous, offscreen: decorations(), mappedBefore,
              leadingAfter: leadingDecorations(cjkPunctShrinkPluginKey.getState(editor.state), editor.state.doc),
              text: editor.state.doc.firstChild.textContent, caret: [caret.left - origin.left, caret.top - origin.top],
            };
          } finally {
            editor.destroy();
            root.remove();
          }
        };
        window.measureCjk = (scenario, reference) => {
          const root = document.createElement('article');
          root.style.cssText = scenario.css;
          document.body.append(root);
          const editor = new Editor({
            element: root,
            extensions: [Doc, Text, Paragraph, CjkPunctShrinkExtension, ...(scenario.float ? [WrapWidgets] : [])],
            content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: scenario.text }] }] },
          });
          editor.storage.cjkPunctShrink.enabled = scenario.compress;
          editor.storage.cjkPunctShrink.hangPunct = !scenario.compress;
          editor.storage.cjkPunctShrink.legacyLayout = true;
          editor.commands.setTextSelection({ from: 5, to: 11 });
          editor.view.focus();
          const css = getComputedStyle(root.querySelector('p'));
          const fontSettings = [css.fontKerning, css.fontFeatureSettings, css.fontVariantEastAsian,
            css.writingMode, css.direction, css.unicodeBidi, css.letterSpacing];
          let glyphReads = 0;
          let fragmentReads = 0;
          let fragmentRects = 0;
          const getBounding = Range.prototype.getBoundingClientRect;
          const getFragments = Range.prototype.getClientRects;
          Range.prototype.getBoundingClientRect = function () {
            if (this.startContainer === this.endContainer && this.startContainer.nodeType === 3 &&
                this.endOffset === this.startOffset + 1) glyphReads++;
            return getBounding.call(this);
          };
          Range.prototype.getClientRects = function () {
            fragmentReads++;
            const fragments = reference ? [] : getFragments.call(this);
            fragmentRects += fragments.length;
            return fragments;
          };
          try {
            document.dispatchEvent(new Event(DOC_CSS_COMMITTED_EVENT));
          } finally {
            Range.prototype.getBoundingClientRect = getBounding;
            Range.prototype.getClientRects = getFragments;
          }
          try {
            const decos = cjkPunctShrinkPluginKey.getState(editor.state).find().map(
              ({from,to,spec}) => [from,to,spec.style,spec.hang],
            );
            const paragraph = root.querySelector('p');
            const origin = paragraph.getBoundingClientRect();
            const box = (r) => [r.left - origin.left, r.top - origin.top, r.right - origin.left, r.bottom - origin.top];
            const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
            const glyphs = [];
            const range = document.createRange();
            for (let tn = walker.nextNode(); tn; tn = walker.nextNode()) {
              for (let i = 0; i < tn.length; i++) {
                range.setStart(tn, i); range.setEnd(tn, i + 1);
                glyphs.push(box(range.getBoundingClientRect()));
              }
            }
            const caret = Array.from({ length: scenario.text.length }, (_, i) => box(editor.view.coordsAtPos(i + 1)));
            const { from, to } = editor.state.selection;
            return {
              glyphReads, fragmentReads, fragmentRects, fontSettings,
              outcome: { decos, glyphs, caret, from, to, selected: getSelection().toString(), text: editor.getText() },
            };
          } finally {
            editor.destroy();
            root.remove();
          }
        };
      `,
    },
    bundle: true,
    write: false,
    format: 'esm',
  })
  await page.setContent(`<style>
    article { font: 16px/19px "Noto Sans CJK SC", SimSun, sans-serif; font-kerning: none; }
    p { margin: 0; text-align: justify; }
    .doc-inline-img--wrap-square-left { float: left; width: 46px; height: 38px; }
    .page-gap-inline { display: inline-block; width: 100%; height: 31px; }
  </style>`)
  await page.addScriptTag({ type: 'module', content: bundle.outputFiles[0].text })
  await page.waitForFunction(() => 'measureCjk' in window)
  const text = '文字標點，留意「文章」如何換行。（正文，標點。文字看下一行。'.repeat(3)
  const edits = await page.evaluate((input) => {
    const { measureLocalCjkEdit } = window as unknown as {
      measureLocalCjkEdit: (
        text: string,
        options: {
          coupled?: boolean
          replaceUnchanged?: boolean
          editPunctuation?: boolean
          sameWidthEdit?: boolean
        },
      ) => {
        untouchedReads: number
        previous: unknown[]
        offscreen: unknown[]
        mappedBefore: unknown[]
        leadingAfter: unknown[]
        text: string
        caret: number[]
      }
    }
    return [
      measureLocalCjkEdit(input, {}),
      measureLocalCjkEdit(input, { coupled: true }),
      measureLocalCjkEdit(input, { replaceUnchanged: true }),
      measureLocalCjkEdit(input, { editPunctuation: true }),
      measureLocalCjkEdit(input, { editPunctuation: true, coupled: true }),
      measureLocalCjkEdit(input, { editPunctuation: true, sameWidthEdit: true }),
      measureLocalCjkEdit(input, { editPunctuation: true, sameWidthEdit: true, coupled: true }),
    ]
  }, text)
  expect(edits[0]!.previous.length).toBeGreaterThan(0)
  expect(edits[0]!.untouchedReads).toBe(0)
  expect(edits[0]!.offscreen).toEqual(edits[0]!.previous)
  expect(edits[0]!.text).toBe('AB試C 中文')
  expect(edits[1]!.untouchedReads).toBeGreaterThan(0)
  expect(edits[2]!.untouchedReads).toBeGreaterThan(0)
  expect(edits[2]!.offscreen).toEqual(edits[2]!.previous)
  expect(edits[3]!.untouchedReads).toBe(0)
  expect(edits[3]!.leadingAfter).not.toEqual(edits[3]!.mappedBefore)
  expect(edits[3]!.leadingAfter).toEqual(edits[4]!.leadingAfter)
  expect(edits[3]!.caret).toEqual(edits[4]!.caret)
  expect(edits[5]!.mappedBefore.length).toBeGreaterThan(0)
  expect(edits[5]!.leadingAfter).toEqual(edits[6]!.leadingAfter)
  expect(edits[5]!.caret).toEqual(edits[6]!.caret)
  expect(edits[5]!.untouchedReads).toBe(0)
  expect(edits[5]!.text).toBe('試' + text.slice(1))
  const scenarios = [
    { text, css: 'width:163px', compress: true, float: false },
    {
      text,
      css: 'width:215px;font:16px/13px Meiryo,sans-serif;font-kerning:none;zoom:.75',
      compress: true,
      float: true,
    },
    {
      text,
      css: 'width:179px;font:17px/20px "Yu Mincho",serif;font-kerning:none;letter-spacing:1px;zoom:1.25',
      compress: false,
      float: false,
    },
    { text: text + 'ABC 😀', css: 'width:181px;font-kerning:normal', compress: true, float: false },
    { text, css: 'width:168px;letter-spacing:-1px', compress: false, float: false },
    ...[120, 136, 152, 168].map((width) => ({
      text: text.repeat(17),
      css: `width:${width}px`,
      compress: true,
      float: false,
    })),
  ]
  const results = await page.evaluate((fixtures) => {
    type Scenario = (typeof fixtures)[number]
    const measure = (
      window as unknown as {
        measureCjk: (
          scenario: Scenario,
          reference: boolean,
        ) => {
          glyphReads: number
          fragmentReads: number
          fragmentRects: number
          fontSettings: string[]
          outcome: { text: string; selected: string; decos: unknown[] }
        }
      }
    ).measureCjk
    return fixtures.map((scenario) => ({
      reference: measure(scenario, true),
      candidate: measure(scenario, false),
    }))
  }, scenarios)
  for (const [i, { reference, candidate }] of results.entries()) {
    expect(candidate.outcome).toEqual(reference.outcome)
    expect(candidate.outcome.text).toBe(scenarios[i].text)
    expect(candidate.outcome.selected).toBe(scenarios[i].text.slice(4, 10))
  }
  expect(results.some(({ reference }) => reference.outcome.decos.length > 0)).toBe(true)
  for (const [i, { candidate, reference }] of results.slice(0, 3).entries()) {
    expect(
      candidate.glyphReads + candidate.fragmentReads,
      JSON.stringify([i, candidate.fontSettings, candidate.glyphReads, candidate.fragmentReads]),
    ).toBeLessThan(reference.glyphReads)
  }
  for (const { candidate, reference } of results.slice(3, 6)) {
    expect(candidate.glyphReads).toBe(reference.glyphReads)
    expect(candidate.fragmentReads).toBe(0)
  }
  for (const [i, { candidate, reference }] of results.slice(6).entries()) {
    expect(candidate.fragmentReads).toBeGreaterThan(0)
    expect(candidate.glyphReads + candidate.fragmentRects, scenarios[i + 6].css).toBeLessThan(
      reference.glyphReads,
    )
  }
})
