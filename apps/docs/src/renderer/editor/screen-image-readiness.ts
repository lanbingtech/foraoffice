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

function hasAuthoredExtent(image: HTMLImageElement): boolean {
  const { width, height, aspectRatio } = image.style
  // Intrinsically sized objects keep the browser image's natural dimensions.
  return (
    (width.endsWith('px') || image.hasAttribute('width')) &&
    (height.endsWith('px') || image.hasAttribute('height') || !!aspectRatio)
  )
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
  const nearby = new Map<HTMLImageElement, { top: number; bottom: number }>()
  const visible = new Set<HTMLImageElement>()
  const isInRange = (image: HTMLImageElement) => nearby.has(image) || visible.has(image)
  const boxes = new WeakMap<HTMLImageElement, { width: number; height: number }>()
  const styleInfo = new WeakMap<
    HTMLImageElement,
    { inline: string; objectFit: string; zoom: number; scaleRevision: number }
  >()
  const background = new Set<HTMLImageElement>()
  const deferred = new Map<HTMLImageElement, number>()
  let deferredCursor: MapIterator<[HTMLImageElement, number]> | undefined
  let capacityFreed = false
  const ready = new Map<HTMLImageElement, ReadyPicture>()
  const failed = new WeakMap<HTMLImageElement, string>()
  const costs = new WeakMap<HTMLImageElement, { request: ScreenImageRequest; bytes: number }>()
  let preload: { image: HTMLImageElement; url: string } | undefined
  let bytes = 0
  let frame: number | undefined
  let worker: Worker | undefined
  let working = false
  let disabled = false
  let printing = false
  let lastTop: number | undefined
  let direction = 0
  let viewportHalfHeight = 0
  let scaleRevision = 0
  let resolution = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
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

  function reobserveScale(): void {
    // A CSS-pixel observer is independent of subpixel positioning. Refresh its
    // snapshots when the layout's zoom or the window's device scale changes.
    scaleRevision++
    for (const image of observed) {
      boxes.delete(image)
      resize.unobserve(image)
      resize.observe(image)
    }
  }

  function watchResolution(): void {
    resolution.removeEventListener('change', watchResolution)
    resolution = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
    resolution.addEventListener('change', watchResolution)
    reobserveScale()
  }

  function onScroll(): void {
    const top = viewport.scrollTop
    if (lastTop !== undefined && top !== lastTop) direction = Math.sign(top - lastTop)
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
      const scrollTop = (lastTop ??= viewport.scrollTop)
      for (const { target, isIntersecting, boundingClientRect, rootBounds } of entries) {
        const image = target as HTMLImageElement
        if (isIntersecting && observed.has(image)) {
          // rootMargin is symmetric, so expanding it leaves the viewport centre intact.
          const centre = rootBounds ? (rootBounds.top + rootBounds.bottom) / 2 : 0
          nearby.set(image, {
            top: boundingClientRect.top - centre + scrollTop,
            bottom: boundingClientRect.bottom - centre + scrollTop,
          })
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

  // Geometry can move within the overscan window without notifying the broad
  // observer. Use the actual viewport to promote and protect visible pictures.
  const viewportIntersection = new IntersectionObserver(
    (entries) => {
      let changed = false
      for (const { target, isIntersecting } of entries) {
        const image = target as HTMLImageElement
        if (isIntersecting && observed.has(image)) {
          if (!visible.has(image)) {
            visible.add(image)
            changed = true
          }
        } else if (visible.delete(image)) {
          changed = true
        }
      }
      if (changed) schedule()
    },
    { root: viewport },
  )

  const resize = new ResizeObserver((entries) => {
    if (printing || isParked()) return
    const stale: HTMLImageElement[] = []
    for (const entry of entries) {
      if (entry.target === viewport) {
        viewportHalfHeight = entry.contentRect.height / 2
        continue
      }
      const image = entry.target as HTMLImageElement
      if (!observed.has(image)) continue

      // ResizeObserver delivers after layout. Record dimensions independently of
      // the async decoder and of frame callbacks, which can run with dirty layout.
      const inline = image.style.cssText
      let style = styleInfo.get(image)
      if (!style || style.inline !== inline || style.scaleRevision !== scaleRevision) {
        const { objectFit } = getComputedStyle(image)
        style = { inline, objectFit, zoom: image.currentCSSZoom || 1, scaleRevision }
        styleInfo.set(image, style)
      }
      const scale = style.zoom * devicePixelRatio
      const width = Math.ceil(entry.contentRect.width * scale)
      const height = Math.ceil(entry.contentRect.height * scale)
      if (
        hasAuthoredExtent(image) &&
        (!style.objectFit || style.objectFit === 'fill') &&
        width > 0 &&
        height > 0 &&
        width * height <= MAX_RASTER_PIXELS
      ) {
        boxes.set(image, { width, height })
      } else {
        boxes.delete(image)
      }
      const copy = ready.get(image)
      if (copy) {
        const current = targetOf(image)
        if (!current || !matchesRequest(copy.request, current)) stale.push(image)
      } else {
        queue(image)
      }
    }
    // Read the entire observer batch before changing any presentation.
    for (const image of stale) release(image)
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
        viewportIntersection.observe(image)
        resize.observe(image)
        schedule()
      } else if (!adding && !root.contains(image) && observed.delete(image)) {
        intersection.unobserve(image)
        viewportIntersection.unobserve(image)
        resize.unobserve(image)
        nearby.delete(image)
        visible.delete(image)
        background.delete(image)
        deferred.delete(image)
        boxes.delete(image)
        styleInfo.delete(image)
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
  const zoomHost = root.closest<HTMLElement>('.doc-zoom')
  let lastZoom = zoomHost?.style.zoom
  let wasParked = isParked()
  const viewChanges = new MutationObserver((records) => {
    const parked = isParked()
    if (records.some(({ target }) => target === zoomHost) && zoomHost?.style.zoom !== lastZoom) {
      lastZoom = zoomHost?.style.zoom
      reobserveScale()
    }
    if (parked !== wasParked) schedule()
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
    if (working) return
    const candidates = Array.from(nearby.keys()).filter(eligible)
    for (const image of visible) {
      if (!nearby.has(image) && eligible(image)) candidates.push(image)
    }
    if (candidates.length) {
      const top = (lastTop ?? 0) - viewportHalfHeight
      const bottom = (lastTop ?? 0) + viewportHalfHeight
      const ordered = candidates
        .map((image) => {
          const bounds = nearby.get(image)
          const side = !bounds ? 0 : bounds.bottom <= top ? -1 : bounds.top >= bottom ? 1 : 0
          return {
            image,
            distance: bounds ? Math.max(0, top - bounds.bottom, bounds.top - bottom) : 0,
            priority: visible.has(image)
              ? 0
              : direction === 0 || side === 0 || side === direction
                ? 1
                : 2,
          }
        })
        .sort((a, b) => a.priority - b.priority || a.distance - b.distance)

      let nearbyBytes = 0
      let visibleBytes = 0
      for (const [image, copy] of ready) {
        if (visible.has(image)) visibleBytes += copy.bytes
        if (isInRange(image)) nearbyBytes += copy.bytes
      }
      for (const { image } of ordered) {
        if (request(image, visible.has(image) ? visibleBytes : nearbyBytes, true)) return
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
      if (!isInRange(image) && eligible(image) && request(image, bytes, false)) return
    }
    schedule()
  }

  function eligible(image: HTMLImageElement): boolean {
    return (
      boxes.has(image) && !ready.has(image) && failed.get(image) !== image.src && canPrepare(image)
    )
  }

  function targetOf(image: HTMLImageElement): ScreenImageRequest | undefined {
    const box = boxes.get(image)
    return box && { ...box, src: image.src }
  }

  function request(
    image: HTMLImageElement,
    reservedBytes: number,
    mustStayNearby: boolean,
  ): boolean {
    const target = targetOf(image)
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

  function evictOutside(keep: (image: HTMLImageElement) => boolean, cost: number): void {
    for (const image of ready.keys()) {
      if (bytes + cost <= CACHE_BYTES) break
      if (!keep(image)) release(image)
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
        (!mustStayNearby || isInRange(image)) &&
        root.contains(image) &&
        matchesRequest(targetOf(image), request)
      if (!stillWanted()) {
        queue(image)
        return
      }
      const copyBytes = request.width * request.height * 4 + blob.size
      costs.set(image, { request, bytes: copyBytes })
      if (isInRange(image) && bytes + copyBytes > CACHE_BYTES) {
        evictOutside(isInRange, copyBytes)
        if (visible.has(image)) evictOutside((prior) => visible.has(prior), copyBytes)
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
    viewportIntersection.disconnect()
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
