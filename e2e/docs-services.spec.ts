import { expect, test } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { buildBlankDocx } from '../packages/docx-engine/src'
import ts from 'typescript'

test('the relocated Docs service opens and saves Word using only a plain Node runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-docs-node-'))
  const artifact = join(root, 'services.cjs')
  await copyFile(resolve(__dirname, '../apps/docs/out/services/services.cjs'), artifact)
  const bytes = await buildBlankDocx()
  await writeFile(join(root, 'source.docx'), bytes)
  const script = `
    const [artifact, root] = process.argv.slice(1);
    const Module = require('node:module');
    const allowed = new Set(Module.builtinModules.flatMap(name => [name, 'node:' + name]));
    const load = Module._load;
    Module._load = function(name, ...args) {
      if (name !== artifact && !allowed.has(name)) throw new Error('Undeclared runtime dependency: ' + name);
      return load.call(this, name, ...args);
    };
    const { createDocsFileSession } = require(artifact);
    const { join } = require('node:path');
    (async () => {
      const session = await createDocsFileSession({ stateDirectory: join(root, '.state'), readRoots: [root], writeRoots: [root] });
      try {
        const source = join(root, 'source.docx');
        const opened = await session.open(source);
        if (!opened || opened.needsPassword) throw new Error('The document did not open');
        const resource = await session.readAsset(opened.dataUrl);
        if (!resource) throw new Error('Document bytes are unavailable');
        await session.save(join(root, 'saved.docx'), resource.body, { sourcePath: source, overwrite: false });
        process.stdout.write('saved');
      } finally { session.dispose(); }
    })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
  `
  const result = await promisify(execFile)(process.execPath, ['-e', script, artifact, root], {
    cwd: root,
  })
  expect(result.stdout).toBe('saved')
  expect(new Uint8Array(await readFile(join(root, 'saved.docx')))).toEqual(bytes)
})

test('the packaged Docs SDK and its examples work outside the source checkout', async () => {
  test.setTimeout(120_000)
  const root = await mkdtemp(join(tmpdir(), 'foraoffice-docs-sdk-'))
  const scoped = join(root, 'node_modules/@foraoffice')
  await mkdir(scoped, { recursive: true })
  const artifact = join(scoped, 'docs-sdk')
  await cp(resolve(__dirname, '../apps/docs/out/sdk'), artifact, { recursive: true })
  const notices = await readFile(join(artifact, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
  expect(notices).toContain('MIT License')
  expect(notices).toContain('jszip')
  expect(notices).toContain('@modelcontextprotocol/sdk')
  const peer = join(root, 'node_modules/@modelcontextprotocol')
  await mkdir(peer)
  await symlink(
    resolve(__dirname, '../node_modules/@modelcontextprotocol/sdk'),
    join(peer, 'sdk'),
    'junction',
  )
  const consumer = join(root, 'consumer.mts')
  await writeFile(
    consumer,
    `
    import { mountDocsEditor, createExternalDocsHost, type DocsEditorServices } from '@foraoffice/docs-sdk';
    import { createDocsFileSession, createDocsMcpServer } from '@foraoffice/docs-sdk/services';
    declare const services: DocsEditorServices;
    const supportedLanguage: ReturnType<DocsEditorServices['getLanguage']> = Promise.resolve('vi' as const);
    const languageSubscription: DocsEditorServices['onLanguageChanged'] = callback => { callback('zh-TW'); return () => {}; };
    void supportedLanguage; void languageSubscription;
    const host = createExternalDocsHost('browser', services);
    // @ts-expect-error The editor host has no Agent mode.
    host.agentMode;
    // @ts-expect-error Native Agent injection is outside the editor SDK.
    host.nativeAgent;
    // @ts-expect-error Model requests are outside editor services.
    host.services.aiChat;
    void mountDocsEditor(document.body, { host }).then(async editor => {
      await editor.ready;
      const caller = editor.runtime.connect({ id: 'independent-caller' });
      caller.context();
      await caller.execute({ id: 'insert', name: 'insert_content', input: { html: '<p>Caller supplied</p>' } });
      caller.close(); editor.dispose();
    });
    void createDocsFileSession; void createDocsMcpServer;
  `,
  )
  const program = ts.createProgram([consumer, join(artifact, 'examples/browser.ts')], {
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: ['node'],
    typeRoots: [resolve(__dirname, '../node_modules/@types')],
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
  const privatePackages = resolve(__dirname, '../packages') + sep
  expect(
    program.getSourceFiles().filter((file) => resolve(file.fileName).startsWith(privatePackages)),
  ).toEqual([])
  const browserTypes = ts.createProgram([join(artifact, 'examples/browser.ts')], {
    ...program.getCompilerOptions(),
    types: [],
  })
  expect(
    ts
      .getPreEmitDiagnostics(browserTypes)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
  ).toEqual([])
  const documents = join(root, 'documents')
  await mkdir(documents)
  const bytes = await buildBlankDocx()
  await writeFile(join(documents, 'source.docx'), bytes)
  await promisify(execFile)(
    process.execPath,
    [join(artifact, 'examples/files.mjs'), documents, 'source.docx', 'saved.docx'],
    { cwd: root },
  )
  expect(new Uint8Array(await readFile(join(documents, 'saved.docx')))).toEqual(bytes)
})
