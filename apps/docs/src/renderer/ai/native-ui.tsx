import { useEffect, useState } from 'react'
import { suggestFileName } from '@genoffice/ui'
import { AiPanel, type AiPanelProps } from './AiPanel'
import { type AiSettings } from '../../shared/ipc'
import { getNativeAgentServices } from '../host/docs-host'
import type { DocsAgentUi } from '../agent-ui'
import { useI18n } from '../i18n/locale'

function NativeDocsPanel(props: Omit<AiPanelProps, 'settings'>) {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [error, setError] = useState('')
  const { t } = useI18n()
  useEffect(() => {
    let alive = true
    const load = () => {
      void getNativeAgentServices()
        .getAiSettings()
        .then((value) => {
          if (alive) {
            setSettings(value)
            setError('')
          }
        })
        .catch((error: unknown) => {
          if (alive) setError(error instanceof Error ? error.message : String(error))
        })
    }
    load()
    const off = getNativeAgentServices().onAiSettingsChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [])
  return (
    <>
      {error && (
        <div className="ai-msg-error" role="alert">
          {t('aiErrorPrefix', { error })}
        </div>
      )}
      {settings && <AiPanel {...props} settings={settings} />}
    </>
  )
}

export const nativeDocsAgentUi: DocsAgentUi = { Panel: NativeDocsPanel, suggestFileName }
