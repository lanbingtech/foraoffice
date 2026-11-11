import { test, expect, chromium } from '@playwright/test'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('extension buttons match native ribbon geometry, typography and caret layout', async () => {
  const root = resolve(__dirname, '..')
  const css = (
    await Promise.all(
      [
        'packages/ui/src/tokens.css',
        'apps/docs/src/renderer/styles.css',
        'apps/docs/src/renderer/ribbon-extensions.css',
      ].map((file) => readFile(resolve(root, file), 'utf8')),
    )
  ).join('\n')
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `
      import {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {RibbonExtensionGroups,RibbonQuickAccess} from './apps/docs/src/renderer/components/RibbonExtensions';
      import {IconShapes,IconCaret} from './apps/docs/src/renderer/components/icons';
      const initialIcon='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';
      const interaction={openMenuId:null,onOpenMenu:()=>{},onInvoke:()=>{}};
      function Native({menu=false,label}) {
        const button=<button className="rb-big"><span className="rb-big-icon"><IconShapes size={28}/>{menu&&<IconCaret/>}</span><span>{label}</span></button>;
        return <div className="ribbon-group" data-native={menu?'menu':'button'}><div className="ribbon-group-items">{menu?<div className="rb-split-wrap">{button}</div>:button}</div></div>;
      }
      function App(){
        const [state,setState]=useState({icon:initialIcon,label:'Tool panel'});window.updateParity=setState;
        const {icon,label}=state;
        return <div className="ribbon"><div className="ribbon-tabs">
          <button className="qa-btn" data-native="quick"><IconShapes size={16}/></button>
          <RibbonQuickAccess items={[{type:'button',id:'quick',label,actionId:'quick',icon},{type:'button',id:'quick-fallback',label:'Fallback',actionId:'fallback'},
            {type:'menu',id:'quick-menu',label:'Quick menu',icon,items:[{type:'action',id:'quick-action',label,actionId:'action'}]}]} {...interaction}/>
          <button className="qa-btn qa-btn-menu" data-native="quick-menu"><IconShapes size={16}/><IconCaret/></button>
        </div><div className="ribbon-body"><Native label={label}/><Native label={label} menu/>
          <RibbonExtensionGroups groups={[
            {id:'button',label,items:[{type:'button',id:'button',label,actionId:'button',icon}]},
            {id:'menu',label,items:[{type:'menu',id:'menu',label,icon,items:[{type:'action',id:'action',label,actionId:'action'}]}]},
            {id:'fallback',label,items:[{type:'button',id:'fallback',label,actionId:'fallback'}]},
            {id:'fallback-menu',label,items:[{type:'menu',id:'fallback-menu',label,items:[{type:'action',id:'fallback-action',label,actionId:'action'}]}]},
          ]} {...interaction}/></div></div>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    `,
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
    const page = await browser.newPage({ viewport: { width: 1180, height: 420 } })
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({ content: css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.locator('[data-native="button"] button').waitFor()
    for (const theme of ['light', 'dark', 'system']) {
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.evaluate((theme) => {
        if (theme === 'system') document.documentElement.removeAttribute('data-theme')
        else document.documentElement.setAttribute('data-theme', theme)
      }, theme)
      for (const label of ['Tool panel', '工具面板']) {
        // Rasterize the actual native glyph at high resolution; only its container differs.
        await page.evaluate(async (label) => {
          const source = document
            .querySelector('[data-native="button"] svg')!
            .cloneNode(true) as SVGSVGElement
          source.style.color = getComputedStyle(
            document.querySelector('[data-native="button"] svg')!,
          ).color
          source.style.setProperty(
            '--surface',
            getComputedStyle(
              document.querySelector('[data-native="button"] svg')!,
            ).getPropertyValue('--surface'),
          )
          source.setAttribute('width', '112')
          source.setAttribute('height', '112')
          const url = URL.createObjectURL(
            new Blob([new XMLSerializer().serializeToString(source)], { type: 'image/svg+xml' }),
          )
          try {
            const image = new Image()
            image.src = url
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = canvas.height = 112
            canvas.getContext('2d')!.drawImage(image, 0, 0)
            ;(
              window as unknown as { updateParity(value: { label: string; icon: string }): void }
            ).updateParity({ label, icon: canvas.toDataURL() })
            await new Promise(requestAnimationFrame)
          } finally {
            URL.revokeObjectURL(url)
          }
        }, label)
        for (const direction of ['ltr', 'rtl']) {
          await page.evaluate((direction) => (document.documentElement.dir = direction), direction)
          for (const compact of [false, true]) {
            await page
              .locator('.ribbon')
              .evaluate(
                (ribbon, compact) => ribbon.classList.toggle('ribbon-compact', compact),
                compact,
              )
            const metrics = await page.evaluate(() => {
              const rect = (element: Element | null) => {
                if (!element) return null
                const box = element.getBoundingClientRect()
                return { width: box.width, height: box.height, top: box.top }
              }
              const measure = (selector: string) => {
                const button = document.querySelector(selector)!
                const style = getComputedStyle(button)
                const plate = button.querySelector('.rb-big-icon')
                const child = (element: Element | null) =>
                  element
                    ? {
                        ...rect(element),
                        left:
                          element.getBoundingClientRect().left -
                          button.getBoundingClientRect().left,
                      }
                    : null
                return {
                  box: rect(button),
                  plate: child(plate),
                  glyph: child(button.querySelector('svg:not(.rb-caret-svg),img')),
                  caret: child(button.querySelector('.rb-caret-svg')),
                  label: child(button.querySelector(':scope > span:not(.rb-big-icon)')),
                  font: style.font,
                  lineHeight: style.lineHeight,
                  padding: style.padding,
                  gap: style.gap,
                  color: style.color,
                }
              }
              return {
                native: measure('[data-native="button"] button'),
                nativeMenu: measure('[data-native="menu"] button'),
                nativeQuick: measure('[data-native="quick"]'),
                button: measure('[data-ribbon-extension="button"] button'),
                menu: measure('[data-ribbon-extension="menu"] button'),
                fallback: measure('[data-ribbon-extension="fallback"] button'),
                fallbackMenu: measure('[data-ribbon-extension="fallback-menu"] button'),
                quick: measure('.ribbon-tabs button:nth-child(2)'),
                quickFallback: measure('.ribbon-tabs button:nth-child(3)'),
                quickMenu: measure('.ribbon-tabs button[aria-label="Quick menu"]'),
                nativeQuickMenu: measure('[data-native="quick-menu"]'),
              }
            })
            for (const name of ['button', 'fallback'] as const)
              expect(metrics[name], `${theme}/${label}/compact=${compact}/${name}`).toEqual(
                metrics.native,
              )
            for (const name of ['menu', 'fallbackMenu'] as const)
              expect(metrics[name], `${theme}/${label}/compact=${compact}/${name}`).toEqual(
                metrics.nativeMenu,
              )
            for (const name of ['quick', 'quickFallback'] as const) {
              expect(metrics[name], `${theme}/compact=${compact}/${name}`).toEqual(
                metrics.nativeQuick,
              )
            }
            expect(metrics.quickMenu).toEqual(metrics.nativeQuickMenu)
            if (label === 'Tool panel' && direction === 'ltr')
              await page.screenshot({
                path: test
                  .info()
                  .outputPath(`ribbon-parity-${theme}-${compact ? 'compact' : 'full'}.png`),
              })
          }
        }
      }
    }
  } finally {
    await browser.close()
  }
})
