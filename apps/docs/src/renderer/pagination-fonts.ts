/** One pagination effect's font notifications, including the initial ready promise. */
export function observePaginationFonts(
  fonts: Pick<FontFaceSet, 'status' | 'ready' | 'addEventListener' | 'removeEventListener'>,
  changed: (reprobe: boolean) => void,
): () => void {
  const loading = fonts.status === 'loading'
  let disposed = false
  const notify = (reprobe: boolean) => {
    if (!disposed) changed(reprobe)
  }
  fonts.ready.then(() => notify(loading)).catch(() => {})
  const loaded = () => notify(true)
  fonts.addEventListener('loadingdone', loaded)
  return () => {
    disposed = true
    fonts.removeEventListener('loadingdone', loaded)
  }
}
