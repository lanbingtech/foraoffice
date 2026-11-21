import { expect, it, vi } from 'vitest'
import { readLayoutProbe } from '../../../e2e/docs-performance-layout-probe'

it('excludes pagination header widgets and repeated rows from the source body story without hiding ordinary inline text', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  document.body.innerHTML =
    '<div class="ProseMirror"><p>Source prefix' +
    '<span class="page-gap"><span>Header/footer decoration</span></span>source suffix</p>' +
    '<table><tbody><tr><td>Authored header</td></tr>' +
    '<tr class="page-repeat-header"><td>Repeated header decoration</td></tr></tbody></table>' +
    '<div class="doc-textbox">Separate textbox story</div><p>End</p></div>'
  try {
    const input = { end: 'End', textRuns: ['Sourceprefixsourcesuffix', 'Authoredheader', 'End'] }
    expect(readLayoutProbe(input).oracle.orderedTextPresent).toBe(true)
    expect(document.body.textContent).toContain('Header/footer decoration')
    document.querySelector('.page-gap')!.className = 'ordinary-inline-content'
    expect(readLayoutProbe(input).oracle.orderedTextPresent).toBe(false)
  } finally {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  }
})

it('excludes only src-less ProseMirror separator images while retaining genuine missing/broken image failures', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  document.body.innerHTML =
    '<div class="ProseMirror"><p>End<img class="ProseMirror-separator"></p></div>'
  try {
    expect(readLayoutProbe({ end: 'End', textRuns: ['End'] })).toMatchObject({
      imagesReady: true,
      images: 0,
      excludedSeparatorImages: 1,
    })
    const authored = document.createElement('img')
    document.querySelector('.ProseMirror')!.append(authored)
    expect(readLayoutProbe({ end: 'End', textRuns: ['End'] })).toMatchObject({
      imagesReady: false,
      images: 1,
    })
    authored.className = 'ProseMirror-separator'
    authored.setAttribute('src', 'missing-authored-image.png')
    expect(readLayoutProbe({ end: 'End', textRuns: ['End'] })).toMatchObject({
      imagesReady: false,
      images: 1,
    })
  } finally {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  }
})

it('requires the expected body images even when no broken image elements survive', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  document.body.innerHTML =
    '<div class="ProseMirror"><p>End</p><div class="page-gap"><img src="generated.png"></div>' +
    '<div class="doc-textbox"></div></div>'
  try {
    const input = { end: 'End', textRuns: ['End'], minimumBodyImages: 1 }
    const image = document.querySelector('img')!
    Object.defineProperties(image, {
      complete: { value: true },
      naturalWidth: { value: 20 },
    })
    expect(readLayoutProbe(input)).toMatchObject({
      complete: true,
      imagesReady: false,
      images: 1,
      bodyImages: 0,
      minimumBodyImages: 1,
      brokenImages: [],
    })
    document.querySelector('.doc-textbox')!.append(image)
    expect(readLayoutProbe(input)).toMatchObject({ imagesReady: false, bodyImages: 0 })
    document.querySelector('.ProseMirror > p')!.append(image)
    expect(readLayoutProbe(input)).toMatchObject({ imagesReady: true, bodyImages: 1 })
  } finally {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  }
})
