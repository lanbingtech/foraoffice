import { useCallback, useState } from 'react'
import { useAutoSavePref } from '@genoffice/ui/editor'
import { getDocsDocumentHost, getDocsHost } from './host/docs-host'

/** Managed preferences belong to this editor instance, never the shell's local storage. */
export function useDocsAutoSave(readOnly = false) {
  const host = getDocsDocumentHost()
  const [stored, setStored] = useAutoSavePref('aidocs.autoSave', getDocsHost())
  const [managedOverride, setManagedOverride] = useState<boolean>()
  const canSave = !host || (!!host.saveDocument && host.capabilities?.save !== false && !readOnly)
  const canToggle = canSave && host?.autoSave?.allowToggle !== false
  const requested = host
    ? host.autoSave?.allowToggle === false
      ? host.autoSave.enabled
      : (managedOverride ?? host.autoSave?.enabled === true)
    : stored
  const autoSave = canSave && requested
  const setAutoSave = useCallback(
    (enabled: boolean) => {
      if (!canToggle) return
      if (host) setManagedOverride(enabled)
      else setStored(enabled)
    },
    [host, canToggle, setStored],
  )
  return { autoSave, setAutoSave, canToggle }
}
