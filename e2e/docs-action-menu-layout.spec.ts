import { test, expect, chromium } from '@playwright/test'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Exercise the shared menu renderer in a real browser, without document services.
test('native action menus keep RTL submenus and long lists inside the viewport', async () => {
  const css = await readFile(resolve(__dirname, '../apps/docs/src/renderer/styles.css'), 'utf8')
  const extensionCss = await readFile(
    resolve(__dirname, '../apps/docs/src/renderer/ribbon-extensions.css'),
    'utf8',
  )
  const bundle = await build({
    stdin: {
      contents: `
      import {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {ActionMenu} from './apps/docs/src/renderer/components/ActionMenu';
      const actions=Array.from({length:30},(_,i)=>({type:'action',id:'action-'+i,label:'Action '+i,actionId:'action-'+i}));
      function App(){const [open,setOpen]=useState(false);const [items,setItems]=useState([{type:'submenu',id:'nested',label:'Nested',items:actions}]);
        window.useLongRoot=()=>setItems(actions);
        return <div style={{position:'absolute',left:500,top:50}}><ActionMenu className="ribbon-extension-menu" label="Tools" items={items}
          open={open} onOpenChange={setOpen} commandLabel={()=>''} canExecute={()=>false} onInvoke={id=>window.lastAction=id}/></div>}
      createRoot(document.getElementById('root')).render(<App/>);
    `,
      resolveDir: resolve(__dirname, '..'),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"production"' },
    jsx: 'automatic',
  })
  const browser = await chromium.launch({
    headless: true,
    channel:
      process.env.FORAOFFICE_BROWSER_CHANNEL ??
      (process.platform === 'win32' ? 'chrome' : undefined),
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    for (const direction of ['rtl', 'ltr']) {
      await page.setContent(`<html dir="${direction}"><body><div id="root"></div></body></html>`)
      await page.addStyleTag({ content: css + '\n' + extensionCss })
      await page.addScriptTag({ content: bundle.outputFiles[0].text })
      await page.getByRole('button', { name: 'Tools', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Nested', exact: true }).click()
      const submenu = await page.locator('.file-submenu').boundingBox()
      expect(submenu!.x).toBeGreaterThanOrEqual(0)
      expect(submenu!.x + submenu!.width).toBeLessThanOrEqual(1000)
      expect(submenu!.y).toBeGreaterThanOrEqual(0)
      expect(submenu!.y + submenu!.height).toBeLessThanOrEqual(700)
      await page.getByRole('menuitem', { name: 'Action 29', exact: true }).click()
      expect(
        await page.evaluate(() => (window as unknown as { lastAction: string }).lastAction),
      ).toBe('action-29')
      await page.evaluate(() => (window as unknown as { useLongRoot(): void }).useLongRoot())
      await page.getByRole('button', { name: 'Tools', exact: true }).click()
      const menu = await page.getByRole('menu', { name: 'Tools', exact: true }).boundingBox()
      expect(menu!.y).toBeGreaterThanOrEqual(0)
      expect(menu!.y + menu!.height).toBeLessThanOrEqual(700)
      await page.getByRole('menuitem', { name: 'Action 29', exact: true }).click()
    }
  } finally {
    await browser.close()
  }
})
