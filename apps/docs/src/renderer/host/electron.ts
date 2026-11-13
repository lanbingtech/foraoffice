import type { DesktopApi } from '../../shared/ipc'
import type { ProjectApi } from '@genoffice/project-store'

/** The Electron preload is confined to this adapter; embedded hosts inject their own services. */
export function electronDocsServices(): DesktopApi | undefined {
  return typeof window === 'undefined' ? undefined : window.desktop
}

export function electronDocsProjects(): ProjectApi | undefined {
  return typeof window === 'undefined' ? undefined : window.projectApi
}
