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
      naturalWidth: { get: () => 600, configurable: true },
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

  let onNear: IntersectionObserverCallback
  let onVisible: IntersectionObserverCallback | undefined
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
        if (options.rootMargin) onNear = callback
        else onVisible = callback
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
  }
  vi.stubGlobal('Worker', function Worker() {
    worker = new FakeWorker()
    return worker
  })
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
  const notifyIntersection = (
    notify: IntersectionObserverCallback | undefined,
    active: HTMLImageElement[],
  ) => {
    notify?.(
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
  const showInViewport = (...active: HTMLImageElement[]) => notifyIntersection(onVisible, active)
  const intersect = (...active: HTMLImageElement[]) => {
    notifyIntersection(onNear, active)
    const viewportBox = viewport.getBoundingClientRect()
    showInViewport(
      ...active.filter((image) => {
        const box = image.getBoundingClientRect()
        return box.top < viewportBox.bottom && box.bottom > viewportBox.top
      }),
    )
  }
  const result = async (value: string) => {
    worker!.onmessage?.({ data: new Blob([value]) } as MessageEvent<Blob>)
    await Promise.resolve()
    await Promise.resolve()
  }
  const resize = (
    target: HTMLImageElement,
    width = parseFloat(target.style.width),
    height = parseFloat(target.style.height),
  ) => {
    notifyResize(target, new DOMRect(0, 0, width, height))
  }
  const notifyResize = (target: HTMLElement, contentRect: DOMRect) => {
    onResize(
      [
        {
          target,
          contentRect,
          contentBoxSize: [],
          borderBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      {} as ResizeObserver,
    )
  }
  notifyResize(viewport, viewport.getBoundingClientRect())
  for (const image of copies) resize(image)
  return {
    app,
    viewport,
    copies,
    animations,
    media,
    flush,
    intersect,
    showInViewport,
    dispose,
    result,
    revoke,
    get worker() {
      return worker!
    },
    resize,
  }
}

it('prepares display-sized copies for the newest viewport and leaves source markup intact', async () => {
  const f = setup([180, 270, 520])
  const { copies, viewport, intersect, flush, result, media, dispose, animations, revoke, resize } =
    f
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
  resize(copies[2])
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
  const admission = copies.map((image) => vi.spyOn(image, 'naturalWidth', 'get'))
  intersect(copies[0])
  flush()
  await result('one')
  flush()
  expect(copies[0].animate).toHaveBeenCalledOnce()
  expect(f.worker.postMessage).toHaveBeenCalledOnce()
  expect(admission.at(-1)).not.toHaveBeenCalled()
  flush()
  flush()
  expect(admission.at(-1)).toHaveBeenCalled()
  expect(styleRead).not.toHaveBeenCalled()
  for (const check of admission) check.mockClear()

  for (const top of [10, 20, 30, 40, 50]) {
    viewport.scrollTop = top
    viewport.dispatchEvent(new Event('scroll'))
    flush()
  }
  expect(styleRead).not.toHaveBeenCalled()
  for (const check of admission) expect(check).not.toHaveBeenCalled()

  const added = copies[3].cloneNode() as HTMLImageElement
  Object.defineProperties(added, {
    naturalWidth: { value: 600 },
    naturalHeight: { value: 300 },
    currentCSSZoom: { value: 1.25 },
  })
  copies[3].after(added)
  await Promise.resolve()
  resize(added)
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

it('uses the delivered content box for both admission and in-flight validation', async () => {
  const f = setup([0])
  const {
    copies: [image],
    intersect,
    flush,
    resize,
    result,
    dispose,
  } = f
  const styleRead = vi.spyOn(window, 'getComputedStyle')
  intersect(image)
  resize(image, 96, 48)
  flush()
  expect(f.worker.postMessage).toHaveBeenLastCalledWith({ src: image.src, width: 240, height: 120 })

  // A layout constraint changes the actual size while the authored CSS stays the same.
  resize(image, 92, 46)
  await result('old dimensions')
  expect(image.animate).not.toHaveBeenCalled()
  flush()
  expect(f.worker.postMessage).toHaveBeenLastCalledWith({ src: image.src, width: 230, height: 115 })
  await result('new dimensions')
  expect(image.animate).toHaveBeenCalledOnce()
  expect(styleRead).not.toHaveBeenCalled()
  dispose()
})

it('prioritizes and protects the actual viewport when overscan membership stays the same', async () => {
  const f = setup([0, 550], 'width:819.2px;height:819.2px')
  const {
    copies: [first, next],
    viewport,
    intersect,
    showInViewport,
    flush,
    result,
    animations,
    dispose,
  } = f
  intersect(first, next)
  flush()
  expect(f.worker.postMessage).toHaveBeenLastCalledWith({
    src: first.src,
    width: 2048,
    height: 2048,
  })
  await result('first')
  flush()
  expect(animations[0]).not.toHaveBeenCalled()
  expect(f.worker.postMessage).toHaveBeenCalledTimes(1)

  // Layout shifts both pictures without either crossing the broad observer's boundary.
  // Only the exact observer sends notifications.
  showInViewport(next)
  const rectReads = [viewport, first, next].map((element) =>
    vi.spyOn(element, 'getBoundingClientRect'),
  )
  const styleRead = vi.spyOn(window, 'getComputedStyle')
  flush()
  expect(f.worker.postMessage).toHaveBeenLastCalledWith({
    src: next.src,
    width: 2048,
    height: 2048,
  })
  await result('next')
  expect(animations[0]).toHaveBeenCalledOnce()
  expect(next.animate).toHaveBeenCalledOnce()
  for (const read of rectReads) expect(read).not.toHaveBeenCalled()
  expect(styleRead).not.toHaveBeenCalled()
  dispose()
})
