export type Activity = {
  version: number
  generation: number
  owners: number
  contentPending: boolean
  pending: number
  active: number
  fontProbes: number
  errors: string[]
}
type ProbeWindow = Window & {
  __docsLayoutActivity?: { snapshot(): Activity }
  __pageDebug?: { slices?: unknown[] }
}

export function readLayoutProbe({ end, textRuns }: { end: string; textRuns: string[] }) {
  const probeStarted = performance.now()
  const win = window as ProbeWindow
  const activity = win.__docsLayoutActivity?.snapshot()
  const pm = document.querySelector<HTMLElement>('.ProseMirror')
  const allImages = pm ? [...pm.querySelectorAll('img')] : []
  const images = allImages.filter(
    (image) => !(image.classList.contains('ProseMirror-separator') && !image.hasAttribute('src')),
  )
  let texts = ''
  if (pm) {
    const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (!node.parentElement?.closest('.doc-textbox,.page-gap,.page-repeat-header'))
        texts += node.textContent ?? ''
  }
  texts = texts.replace(/\s+/g, ' ')
  const fonts = document.fonts
  const visible =
    !!pm && pm.getBoundingClientRect().width > 0 && pm.getBoundingClientRect().height > 0
  const normalized = texts.replace(/\s+/g, '')
  let position = 0
  let missingRunIndex: number | null = null
  const orderedTextPresent = textRuns.every((run, index) => {
    const found = normalized.indexOf(run, position)
    if (found < 0) {
      missingRunIndex = index
      return false
    }
    position = found + run.length
    return true
  })
  const tailPresent = !!end && normalized.includes(end.replace(/\s+/g, ''))
  const complete = tailPresent && orderedTextPresent
  const last = pm?.lastElementChild?.getBoundingClientRect()
  return {
    activity,
    fonts: fonts
      ? {
          status: fonts.status,
          count: fonts.size,
          faces: [...fonts].map((font) => ({ family: font.family, status: font.status })),
        }
      : null,
    visible,
    complete,
    incompleteText: complete ? undefined : texts,
    oracle: {
      tailPresent,
      orderedTextPresent,
      missingRunIndex,
    },
    imagesReady: images.every((image) => image.complete && image.naturalWidth > 0),
    images: images.length,
    excludedSeparatorImages: allImages.length - images.length,
    brokenImages: images.flatMap((image, index) =>
      image.complete && image.naturalWidth > 0
        ? []
        : [{ index, complete: image.complete, naturalWidth: image.naturalWidth }],
    ),
    pages: win.__pageDebug?.slices?.length,
    signature: JSON.stringify([
      activity?.generation,
      pm?.children.length,
      pm?.scrollHeight,
      last?.top,
      last?.bottom,
      win.__pageDebug?.slices?.length,
    ]),
    characters: texts.length,
    domElements: pm?.querySelectorAll('*').length,
    environment: {
      viewport: [innerWidth, innerHeight],
      devicePixelRatio,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      theme: document.documentElement.dataset.theme ?? 'system/default',
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
      documentDarkPage: !!pm?.closest('.page-dark'),
      zoom: '',
      spellcheck: pm?.spellcheck,
    },
    validationProbeMs: performance.now() - probeStarted,
  }
}
