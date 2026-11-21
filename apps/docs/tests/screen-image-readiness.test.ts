// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { installScreenImageReadiness } from '../src/renderer/editor/screen-image-readiness'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function setup(positions: number[], imageStyle = 'width:100px;height:50px') {
  const app = document.createElement('div')
  app.className = 'app'
  const viewport = document.createElement('div')
  const root = document.createElement('div')
  viewport.append(root)
  app.append(viewport)
  document.body.append(app)
  const box = (top: number, height: number) => new DOMRect(0, top, 200, height)
  viewport.getBoundingClientRect = () => box(0, 200)
  const copies = positions.map((top, index) => {
    const image = document.createElement('img')
    image.className = 'doc-inline-img'
    image.src = `genoffice-docx-media://media/${'a'.repeat(64)}/word/media/image${index}.png`
    image.alt = 'Document image'
    image.style.cssText = imageStyle
    Object.defineProperties(image, {
      naturalWidth: { value: 600 },
      naturalHeight: { value: 300 },
      currentCSSZoom: { value: 1.25 },
    })
    image.getBoundingClientRect = () => box(top - viewport.scrollTop, 60)
    root.append(image)
    return image
  })
  const animations = copies.map((image) => {
    const cancel = vi.fn()
    Object.defineProperty(image, 'animate', { value: vi.fn(() => ({ cancel })) })
    return cancel
  })

  let onIntersect: IntersectionObserverCallback
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        onIntersect = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  let onResize: ResizeObserverCallback
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        onResize = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  const media = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
  vi.stubGlobal('matchMedia', () => media)
  vi.stubGlobal('devicePixelRatio', 2)
  let frame: FrameRequestCallback | undefined
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const flush = () => {
    const next = frame
    frame = undefined
    next?.(0)
  }
  let worker: FakeWorker
  class FakeWorker {
    postMessage = vi.fn()
    terminate = vi.fn()
    onmessage?: (event: MessageEvent<Blob | null>) => void
    constructor() {
      worker = this
    }
  }
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal(
    'Image',
    class {
      decode = () => Promise.resolve()
      removeAttribute() {}
    },
  )
  const revoke = vi.fn()
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = () => 'blob:docs-test'
      static revokeObjectURL = revoke
    },
  )

  const dispose = installScreenImageReadiness(root, viewport)
  const intersect = (...active: HTMLImageElement[]) => {
    onIntersect(
      copies.map((target) => ({
        target,
        isIntersecting: active.includes(target),
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRatio: 0,
        intersectionRect: new DOMRect(),
        rootBounds: viewport.getBoundingClientRect(),
        time: 0,
      })),
      {} as IntersectionObserver,
    )
  }
  const result = async (value: string) => {
    worker!.onmessage?.({ data: new Blob([value]) } as MessageEvent<Blob>)
    await Promise.resolve()
    await Promise.resolve()
  }
  return {
    app,
    viewport,
    copies,
    animations,
    media,
    flush,
    intersect,
    dispose,
    result,
    revoke,
    get worker() {
      return worker!
    },
    resize: (image: HTMLImageElement) => {
      onResize(
        [
          {
            target: image,
            contentRect: image.getBoundingClientRect(),
            contentBoxSize: [],
            borderBoxSize: [],
            devicePixelContentBoxSize: [],
          },
        ],
        {} as ResizeObserver,
      )
    },
  }
}

it('prepares display-sized copies for the newest viewport and leaves source markup intact', async () => {
  const f = setup([180, 270, 520])
  const { copies, viewport, intersect, flush, result, media, dispose, animations, revoke } = f
  const sources = copies.map((image) => image.outerHTML)
  intersect(...copies)
  flush()
  expect(f.worker.postMessage).toHaveBeenCalledWith({
    src: copies[0].src,
    width: 250,
    height: 125,
  })

  viewport.scrollTop = 480
  viewport.dispatchEvent(new Event('scroll'))
  intersect(...copies.slice(1))
  flush()
  await result('stale')
  flush()
  expect(copies[0].animate).not.toHaveBeenCalled()
  expect(f.worker.postMessage).toHaveBeenLastCalledWith({
    src: copies[2].src,
    width: 250,
    height: 125,
  })

  await result('ready')
  expect(copies[2].animate).toHaveBeenCalledWith(
    { content: ['url("blob:docs-test") / attr(alt)', 'url("blob:docs-test") / attr(alt)'] },
    { duration: 0, fill: 'both' },
  )
  expect(copies.map((image) => image.outerHTML)).toEqual(sources)

  vi.stubGlobal('devicePixelRatio', 3)
  media.addEventListener.mock.calls.at(-1)?.[1]()
  flush()
  expect(animations[2]).toHaveBeenCalledOnce()
  expect(revoke).toHaveBeenCalledWith('blob:docs-test')
  expect(f.worker.postMessage).toHaveBeenLastCalledWith({
    src: copies[2].src,
    width: 375,
    height: 188,
  })

  const inFlight = result('new scale')
  dispose()
  await inFlight
  expect(copies[2].animate).toHaveBeenCalledOnce()
  expect(revoke).toHaveBeenCalledTimes(2)
  expect(f.worker.terminate).toHaveBeenCalledOnce()
})

it('checks saturated offscreen admission once and resumes only when input or capacity changes', async () => {
  const positions = [0, ...Array.from({ length: 32 }, (_, i) => 10_000 * (i + 1))]
  const f = setup(positions, 'width:819.2px;height:819.2px')
  const { app, copies, viewport, intersect, flush, result, resize, dispose } = f
  const styleRead = vi.spyOn(window, 'getComputedStyle')
  intersect(copies[0])
  flush()
  await result('one')
  flush()
  expect(copies[0].animate).toHaveBeenCalledOnce()
  expect(f.worker.postMessage).toHaveBeenCalledOnce()
  expect(styleRead).not.toHaveBeenCalledWith(copies.at(-1))
  flush()
  flush()
  expect(styleRead).toHaveBeenCalledWith(copies.at(-1))
  styleRead.mockClear()

  for (const top of [10, 20, 30, 40, 50]) {
    viewport.scrollTop = top
    viewport.dispatchEvent(new Event('scroll'))
    flush()
  }
  expect(styleRead).not.toHaveBeenCalled()

  const added = copies[3].cloneNode() as HTMLImageElement
  Object.defineProperties(added, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 300 },
    currentCSSZoom: { value: 1.25 },
  })
  copies[3].after(added)
  await Promise.resolve()
  flush()
  expect(styleRead).toHaveBeenCalledExactlyOnceWith(added)
  expect(f.worker.postMessage).toHaveBeenCalledOnce()

  copies[2].style.width = '700px'
  resize(copies[2])
  flush()
  expect(f.worker.postMessage).toHaveBeenLastCalledWith({
    src: copies[2].src,
    width: 1750,
    height: 2048,
  })
  await result('two')
  flush()

  // Internal PDF export fires afterprint between chunks while the editor is parked.
  app.classList.add('pv-exporting')
  window.dispatchEvent(new Event('beforeprint'))
  window.dispatchEvent(new Event('afterprint'))
  await Promise.resolve()
  styleRead.mockClear()
  flush()
  expect(styleRead).not.toHaveBeenCalled()
  expect(f.worker.postMessage).toHaveBeenCalledTimes(2)

  app.classList.remove('pv-exporting')
  await Promise.resolve()
  flush()
  await result('print finished')
  flush()
  expect(copies[0].animate).toHaveBeenCalledTimes(2)
  await result('two after print')
  for (let i = 0; i < 3; i++) flush()

  copies[0].remove()
  await Promise.resolve()
  flush()
  expect(f.worker.postMessage).toHaveBeenLastCalledWith({
    src: copies[1].src,
    width: 2048,
    height: 2048,
  })
  dispose()
})
