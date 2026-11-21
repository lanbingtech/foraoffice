import { parseLazyMediaUrl } from '@genoffice/docx-engine/lazy-media'
import { DOCS_IMAGE_MAX_BASE64_CHARS } from '../../shared/media-policy'

export interface ScreenImageRequest {
  src: string
  width: number
  height: number
}

const PICTURE = 'img.doc-inline-img, img.doc-protected-img, img.doc-diagram-img, img.doc-ole-img'
const CACHE_BYTES = 32 * 1024 * 1024
const MAX_RASTER_PIXELS = 4 * 1024 * 1024
const MAX_SOURCE_PIXELS = 32 * 1024 * 1024
const BACKGROUND_BATCH = 16

interface ReadyPicture {
  request: ScreenImageRequest
  animation: Animation
  url: string
  bytes: number
}

const matchesRequest = (a: ScreenImageRequest | undefined, b: ScreenImageRequest): boolean =>
  a?.src === b.src && a.width === b.width && a.height === b.height

function canPrepare(image: HTMLImageElement): boolean {
  if (
    !image.naturalWidth ||
    !image.naturalHeight ||
    image.naturalWidth * image.naturalHeight > MAX_SOURCE_PIXELS ||
    image.hasAttribute('srcset')
  )
    return false
  const src = image.src
  if (src.startsWith('data:')) {
    return (
      src.length <= DOCS_IMAGE_MAX_BASE64_CHARS + 32 &&
      /^data:image\/(?:png|jpeg);base64,/i.test(src)
    )
  }
  const path = parseLazyMediaUrl(src)?.partPath
  return !!path && /\.(?:png|jpe?g)$/i.test(path)
}

function displaySize(image: HTMLImageElement): ScreenImageRequest | undefined {
  const { width: authoredWidth, height: authoredHeight, aspectRatio } = image.style
  // Intrinsically sized objects keep the browser image's natural dimensions.
  if (
    (!authoredWidth.endsWith('px') && !image.hasAttribute('width')) ||
    (!authoredHeight.endsWith('px') && !image.hasAttribute('height') && !aspectRatio)
  )
    return

  // Use the content box before rotation, CSS zoom and browser device scale.
  // Both a crop window and a rotated picture still sample from this box.
  const style = getComputedStyle(image)
  if (style.objectFit && style.objectFit !== 'fill') return
  const px = (value: string) => parseFloat(value) || 0
  let width = px(style.width)
  let height = px(style.height)
  if (style.boxSizing === 'border-box') {
    width -=
      px(style.paddingLeft) +
      px(style.paddingRight) +
      px(style.borderLeftWidth) +
      px(style.borderRightWidth)
    height -=
      px(style.paddingTop) +
      px(style.paddingBottom) +
      px(style.borderTopWidth) +
      px(style.borderBottomWidth)
  }
  const scale = (image.currentCSSZoom || 1) * devicePixelRatio
  width = Math.ceil(width * scale)
  height = Math.ceil(height * scale)
  if (width > 0 && height > 0 && width * height <= MAX_RASTER_PIXELS) {
    return { src: image.src, width, height }
  }
}

/**
 * Prepare static body pictures for the editor viewport. Fill spare cache with
 * offscreen copies so a jump across pages can use the already scaled pixels.
 * The original image remains the fallback, clipboard source and serialized DOM.
 */
export function installScreenImageReadiness(root: HTMLElement, viewport: HTMLElement): () => void {
  if (!globalThis.Worker || !globalThis.IntersectionObserver || !globalThis.ResizeObserver) {
    return () => {}
  }

  const observed = new Set<HTMLImageElement>()
  const nearby = new Set<HTMLImageElement>()
  const background = new Set<HTMLImageElement>()
  const deferred = new Map<HTMLImageElement, number>()
  let deferredCursor: MapIterator<[HTMLImageElement, number]> | undefined
  let capacityFreed = false
  const ready = new Map<HTMLImageElement, ReadyPicture>()
  const resized = new Set<HTMLImageElement>()
  const failed = new WeakMap<HTMLImageElement, string>()
  const costs = new WeakMap<HTMLImageElement, { request: ScreenImageRequest; bytes: number }>()
  let preload: { image: HTMLImageElement; url: string } | undefined
  let bytes = 0
  let frame: number | undefined
  let worker: Worker | undefined
  let working = false
  let disabled = false
  let printing = false
  let lastTop = viewport.scrollTop
  let direction = 0
  let zoom = root.currentCSSZoom
  let scaleChanged = false
  let dpr = devicePixelRatio
  let resolution = matchMedia(`(resolution: ${dpr}dppx)`)
  const appRoot = root.closest('.app')
  const isParked = () => appRoot?.classList.contains('pv-exporting')

  function queue(image: HTMLImageElement): void {
    if (!observed.has(image)) return
    deferred.delete(image)
    background.add(image)
  }

  function release(image: HTMLImageElement): void {
    const copy = ready.get(image)
    if (!copy) return
    copy.animation.cancel()
    URL.revokeObjectURL(copy.url)
    bytes -= copy.bytes
    ready.delete(image)
    capacityFreed = true
    queue(image)
  }

  function schedule(): void {
    if (!disabled && !printing && frame === undefined) frame = requestAnimationFrame(update)
  }

  function watchResolution(): void {
    resolution.removeEventListener('change', watchResolution)
    resolution = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
    resolution.addEventListener('change', watchResolution)
    scaleChanged = true
    schedule()
  }

  function onScroll(): void {
    const top = viewport.scrollTop
    if (top !== lastTop) direction = Math.sign(top - lastTop)
    lastTop = top
    if (nearby.size) schedule()
  }

  function onLoad(event: Event): void {
    if (!(event.target instanceof HTMLImageElement)) return
    if (!ready.has(event.target)) queue(event.target)
    schedule()
  }

  function beforePrint(): void {
    printing = true
    for (const image of ready.keys()) release(image)
  }

  function afterPrint(): void {
    printing = false
    schedule()
  }

  const intersection = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        const image = target as HTMLImageElement
        if (isIntersecting && observed.has(image)) {
          nearby.add(image)
          const copy = ready.get(image)
          if (copy) {
            ready.delete(image)
            ready.set(image, copy)
          }
        } else if (nearby.delete(image) && !ready.has(image) && !deferred.has(image)) {
          queue(image)
        }
      }
      schedule()
    },
    { root: viewport, rootMargin: '175% 100%' },
  )

  const resize = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      if (target === viewport) {
        scaleChanged = true
      } else {
        const image = target as HTMLImageElement
        if (ready.has(image)) resized.add(image)
        else queue(image)
      }
    }
    schedule()
  })
  resize.observe(viewport)
  function collect(node: Node, adding: boolean): void {
    if (!(node instanceof Element)) return
    const images = [...node.querySelectorAll<HTMLImageElement>(PICTURE)]
    if (node.matches(PICTURE)) images.push(node as HTMLImageElement)
    for (const image of images) {
      if (adding && !observed.has(image)) {
        observed.add(image)
        queue(image)
        intersection.observe(image)
        resize.observe(image)
        schedule()
      } else if (!adding && !root.contains(image) && observed.delete(image)) {
        intersection.unobserve(image)
        resize.unobserve(image)
        nearby.delete(image)
        background.delete(image)
        deferred.delete(image)
        resized.delete(image)
        release(image)
        schedule()
      }
    }
  }

  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) collect(node, false)
      for (const node of record.addedNodes) collect(node, true)
      if (record.type === 'attributes' && observed.has(record.target as HTMLImageElement)) {
        const image = record.target as HTMLImageElement
        release(image)
        queue(image)
        schedule()
      }
    }
  })
  mutations.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  })
  // CSS zoom changes the number of device pixels while leaving content boxes intact.
  const zoomHost = root.closest('.doc-zoom')
  let wasParked = isParked()
  const viewChanges = new MutationObserver((records) => {
    const parked = isParked()
    if (records.some(({ target }) => target === zoomHost)) scaleChanged = true
    if (scaleChanged || parked !== wasParked) schedule()
    wasParked = parked
  })
  if (zoomHost) viewChanges.observe(zoomHost, { attributes: true, attributeFilter: ['style'] })
  // PDF export parks the live editor across all chunks, including between print events.
  if (appRoot) viewChanges.observe(appRoot, { attributes: true, attributeFilter: ['class'] })
  collect(root, true)
  viewport.addEventListener('scroll', onScroll, { passive: true })
  root.addEventListener('load', onLoad, true)
  resolution.addEventListener('change', watchResolution)
  window.addEventListener('beforeprint', beforePrint)
  window.addEventListener('afterprint', afterPrint)
  schedule()

  function update(): void {
    frame = undefined
    if (disabled || printing || isParked()) return
    if (scaleChanged) {
      scaleChanged = false
      const nextZoom = root.currentCSSZoom
      const nextDpr = devicePixelRatio
      if (zoom !== nextZoom || dpr !== nextDpr) {
        zoom = nextZoom
        dpr = nextDpr
        for (const image of ready.keys()) release(image)
        for (const image of observed) queue(image)
      }
    }

    const stale = Array.from(resized).filter((image) => {
      const request = ready.get(image)?.request
      const size = request && displaySize(image)
      return !size || !matchesRequest(request, size)
    })
    resized.clear()
    for (const image of stale) release(image)

    if (working) return
    const candidates = Array.from(nearby).filter(eligible)
    if (candidates.length) {
      const view = viewport.getBoundingClientRect()
      const ordered = candidates
        .map((image) => {
          const rect = image.getBoundingClientRect()
          const side = rect.bottom <= view.top ? -1 : rect.top >= view.bottom ? 1 : 0
          return {
            image,
            distance: Math.max(0, view.top - rect.bottom, rect.top - view.bottom),
            priority: side === 0 ? 0 : direction === 0 || side === direction ? 1 : 2,
          }
        })
        .sort((a, b) => a.priority - b.priority || a.distance - b.distance)

      let nearbyBytes = 0
      for (const image of nearby) nearbyBytes += ready.get(image)?.bytes ?? 0
      for (const { image } of ordered) {
        if (request(image, nearbyBytes, true)) return
      }
    }

    // Continue through unexamined pictures using spare cache. Pictures already
    // measured and refused for space are reconsidered when cache space is freed.
    if (capacityFreed) {
      capacityFreed = false
      deferredCursor = deferred.entries()
    }
    for (let checked = 0; checked < BACKGROUND_BATCH; checked++) {
      let image = background.values().next().value
      if (image) {
        background.delete(image)
      } else {
        const next = deferredCursor?.next()
        if (!next || next.done) {
          deferredCursor = undefined
          return
        }
        const [waiting, cost] = next.value
        if (bytes + cost > CACHE_BYTES) continue
        deferred.delete(waiting)
        image = waiting
      }
      if (!nearby.has(image) && eligible(image) && request(image, bytes, false)) return
    }
    schedule()
  }

  function eligible(image: HTMLImageElement): boolean {
    return !ready.has(image) && failed.get(image) !== image.src && canPrepare(image)
  }

  function request(
    image: HTMLImageElement,
    reservedBytes: number,
    mustStayNearby: boolean,
  ): boolean {
    const target = displaySize(image)
    if (!target) return false
    const previous = costs.get(image)
    const cost =
      previous && matchesRequest(previous.request, target)
        ? previous.bytes
        : target.width * target.height * 4
    if (reservedBytes + cost > CACHE_BYTES) {
      deferred.set(image, cost)
      return false
    }
    background.delete(image)
    deferred.delete(image)
    start(image, target, mustStayNearby)
    return true
  }

  function start(
    image: HTMLImageElement,
    request: ScreenImageRequest,
    mustStayNearby: boolean,
  ): void {
    try {
      worker ??= new Worker(new URL('./screen-image-worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.onmessage = ({ data }: MessageEvent<Blob | null>) =>
        void show(image, request, data, mustStayNearby)
      worker.onerror = () => {
        worker?.terminate()
        worker = undefined
        working = false
        disabled = true
      }
      working = true
      worker.postMessage(request)
    } catch {
      working = false
      disabled = true
    }
  }

  async function show(
    image: HTMLImageElement,
    request: ScreenImageRequest,
    blob: Blob | null,
    mustStayNearby: boolean,
  ): Promise<void> {
    try {
      if (!blob) {
        failed.set(image, request.src)
        return
      }
      const stillWanted = () =>
        !disabled &&
        !printing &&
        !isParked() &&
        (!mustStayNearby || nearby.has(image)) &&
        root.contains(image) &&
        matchesRequest(displaySize(image), request)
      if (!stillWanted()) {
        queue(image)
        return
      }
      const copyBytes = request.width * request.height * 4 + blob.size
      costs.set(image, { request, bytes: copyBytes })
      if (nearby.has(image) && bytes + copyBytes > CACHE_BYTES) {
        for (const prior of ready.keys()) {
          if (!nearby.has(prior)) release(prior)
          if (bytes + copyBytes <= CACHE_BYTES) break
        }
      }
      if (bytes + copyBytes > CACHE_BYTES) {
        deferred.set(image, copyBytes)
        return
      }
      const url = URL.createObjectURL(blob)
      const decoded = new Image()
      preload = { image: decoded, url }
      decoded.src = url
      await decoded.decode()
      if (!stillWanted()) {
        queue(image)
        return
      }
      // A filled content effect paints the prepared raster without mutating
      // ProseMirror's DOM. Clones and printed pages retain the source picture.
      const content = `url("${url}") / attr(alt)`
      const animation = image.animate(
        { content: [content, content] },
        { duration: 0, fill: 'both' },
      )
      ready.set(image, { request, animation, url, bytes: copyBytes })
      bytes += copyBytes
      preload = undefined
    } catch {
      failed.set(image, request.src)
    } finally {
      releasePreload()
      working = false
      schedule()
    }
  }

  return () => {
    disabled = true
    if (frame !== undefined) cancelAnimationFrame(frame)
    worker?.terminate()
    releasePreload()
    for (const image of ready.keys()) release(image)
    intersection.disconnect()
    resize.disconnect()
    mutations.disconnect()
    viewChanges.disconnect()
    root.removeEventListener('load', onLoad, true)
    viewport.removeEventListener('scroll', onScroll)
    resolution.removeEventListener('change', watchResolution)
    window.removeEventListener('beforeprint', beforePrint)
    window.removeEventListener('afterprint', afterPrint)
  }

  function releasePreload(): void {
    if (!preload) return
    preload.image.removeAttribute('src')
    URL.revokeObjectURL(preload.url)
    preload = undefined
  }
}
