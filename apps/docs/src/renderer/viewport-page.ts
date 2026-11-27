interface PageInfo {
  current: number
  total: number
}

type PageObserver = (info: Readonly<PageInfo>) => void

/** Current viewport page from the same pagination lookup as its total. */
export class ViewportPage {
  private info: Readonly<PageInfo> = { current: 1, total: 1 }
  private readonly observers = new Set<PageObserver>()

  get snapshot(): Readonly<PageInfo> {
    return this.info
  }

  publish(current: number, total: number): void {
    if (this.info.current === current && this.info.total === total) return
    this.info = { current, total }
    for (const update of this.observers) update(this.info)
  }

  observe(update: PageObserver): () => void {
    this.observers.add(update)
    update(this.info)
    return () => {
      this.observers.delete(update)
    }
  }
}
