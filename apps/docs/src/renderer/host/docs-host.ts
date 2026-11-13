import type { DocsEditorApi, DocsNativeAgentApi } from '../../shared/ipc'
import type { ProjectApi } from '@genoffice/project-store'
import { electronDocsProjects, electronDocsServices } from './electron'
import type { DocsHarnessAdapter } from '../../shared/editor-action'
import type { DocsResourceTools } from '../../shared/resource-tools'
import { DOCS_FILE_COMMANDS } from '../../shared/resource-tools'
import type { DocsDocumentHost } from '../../shared/document-host'
import { withDocumentServices } from './document-services'
import type { DocsChecker } from '../sdk/annotations'

export interface DocsHostAdapter {
  /** Host-provided checkers are installed anew for each document; findings never cross identities. */
  checkers?: Record<string, DocsChecker>
  documents?: DocsDocumentHost
  kind: 'electron' | 'qt' | 'browser'
  services: DocsEditorServices
  projects?: ProjectApi
  harness?: DocsHarnessAdapter
  resources?: () => DocsResourceTools | undefined
  /** Whether the native print driver can invert the renderer's high-DPI print zoom. */
  supportsPrintScale?: boolean
}

type NativeAgentService = keyof DocsNativeAgentApi

export type DocsEditorServices = DocsEditorApi
export type DocsNativeAgentServices = DocsNativeAgentApi & Pick<DocsEditorApi, 'runCli'>

const editorAdapters = new WeakMap<DocsEditorServices, DocsEditorServices>()

function editorServices(services: DocsEditorServices): DocsEditorServices {
  const existing = editorAdapters.get(services)
  if (existing) return existing
  const unavailable = (): never => {
    throw new Error(
      'Native Agent services are disabled on the editor interface; use the Harness adapter',
    )
  }
  const blocked = new Set<NativeAgentService>([
    'getAiSettings',
    'setAiSettings',
    'onAiSettingsChanged',
    'openAiModelSettings',
    'aiChat',
    'aiStream',
    'aiStreamCancel',
    'onAiStream',
    'aiGskStatus',
    'aiGskLogin',
    'webSearch',
    'imageSearch',
    'analyzeMedia',
    'aiGenerateImage',
  ])
  const runCli: DocsEditorServices['runCli'] = async (args) => {
    if (!Array.isArray(args) || !DOCS_FILE_COMMANDS.has(args[0]))
      throw new Error(
        'Editor services expose file-only Office CLI operations; provider operations belong to the Harness',
      )
    return services.runCli(args)
  }
  // The facade owns its properties. Electron freezes preload objects, so those
  // non-configurable source properties cannot be proxy targets for adapted methods.
  const adapter = new Proxy(Object.create(null) as DocsEditorServices, {
    get(_target, key) {
      if (typeof key === 'string' && blocked.has(key as NativeAgentService)) return unavailable
      if (key === 'runCli') return runCli
      const value: unknown = Reflect.get(services, key, services)
      return typeof value === 'function' ? value.bind(services) : value
    },
  })
  editorAdapters.set(services, adapter)
  editorAdapters.set(adapter, adapter)
  return adapter
}

export function createExternalDocsHost(
  kind: DocsHostAdapter['kind'],
  services: DocsEditorServices,
  harness?: DocsHarnessAdapter,
  resources?: () => DocsResourceTools | undefined,
): DocsHostAdapter {
  return { kind, services: editorServices(services), harness, resources }
}

let installed: DocsHostAdapter | undefined

/** Install before mounting an editor. Disposal cannot remove a subsequently installed host. */
export function installDocsHost(adapter: DocsHostAdapter): () => void {
  if (installed) throw new Error('A Docs host is already installed in this renderer')
  const instance = {
    ...adapter,
    services: editorServices(
      adapter.documents
        ? withDocumentServices(adapter.services, adapter.documents)
        : adapter.services,
    ),
  }
  installed = instance
  return () => {
    if (installed === instance) installed = undefined
  }
}

export function getOptionalDocsHost(): DocsEditorServices | undefined {
  const services = installed?.services ?? electronDocsServices()
  return services && editorServices(services)
}

export function getDocsHost(): DocsEditorServices {
  const services = getOptionalDocsHost()
  if (!services) throw new Error('The Docs host adapter is not installed')
  return services
}

export function supportsDocsPrintScale(): boolean {
  return installed?.supportsPrintScale !== false
}

/** Only the native Agent adapter may request its model transport and providers. */
export function getOptionalNativeAgentServices(): DocsNativeAgentServices | undefined {
  return installed ? undefined : electronDocsServices()
}

export function getNativeAgentServices(): DocsNativeAgentServices {
  const services = getOptionalNativeAgentServices()
  if (!services) throw new Error('The native Agent provider adapter is not installed')
  return services
}

export function getDocsProjects(): ProjectApi | undefined {
  return installed ? installed.projects : electronDocsProjects()
}

export function getDocsHarness(): DocsHarnessAdapter | undefined {
  return installed?.harness
}

export function getDocsResources(): DocsResourceTools | undefined {
  return installed?.resources?.()
}

export function getDocsDocumentHost(): DocsDocumentHost | undefined {
  return installed?.documents
}
export function getDocsCheckers(): Record<string, DocsChecker> {
  return installed?.checkers ?? {}
}
