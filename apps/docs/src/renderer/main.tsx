import './editor-styles'
import { getOptionalDocsHost, getDocsHost } from './host/docs-host'
import { createRoot } from 'react-dom/client'
import { htmlDir, htmlLang, type Lang } from '@genoffice/i18n'
import { App } from './App'
import { nativeDocsAgentUi } from './ai/native-ui'
import { setAuthorName } from './author-name'
import { LocaleProvider, setModuleLang } from './i18n/locale'
import type { DocTheme, UiTheme } from '../shared/ipc'
import { applyAiPanelPrefs, installScreenTips } from '@genoffice/ui/editor'
import { setAltChunkHtmlConverter } from '@genoffice/docx-engine'

installScreenTips()
if (getOptionalDocsHost()?.convertAltChunkHtml) {
  setAltChunkHtmlConverter((html) => getDocsHost().convertAltChunkHtml(html))
}

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

function applyDocumentTheme(theme: DocTheme): void {
  // data-doc-theme drives the canvas/paper (genoffice#1811); absent means 'follow' the UI theme
  if (theme === 'follow') document.documentElement.removeAttribute('data-doc-theme')
  else document.documentElement.setAttribute('data-doc-theme', theme)
}

async function bootstrap(): Promise<void> {
  let lang: Lang = 'zh'
  let theme: UiTheme = 'system'
  let docTheme: DocTheme = 'follow'
  try {
    // per-promise catch: standalone runs have no app:get-theme handler, and
    // that rejection must not drop a resolved language
    ;[lang, theme, docTheme] = await Promise.all([
      getDocsHost()
        .getLanguage()
        .catch(() => 'zh' as const),
      getDocsHost()
        .getTheme()
        .catch(() => 'system' as const),
      getDocsHost()
        .getDocumentTheme?.()
        .catch(() => 'follow' as const),
    ])
  } catch {
    /* dev renderer without the preload bridge */
  }
  setModuleLang(lang)
  document.documentElement.lang = htmlLang(lang)
  document.documentElement.dir = htmlDir(lang)
  applyTheme(theme)
  applyDocumentTheme(docTheme ?? 'follow')
  getOptionalDocsHost()?.onThemeChanged(applyTheme)
  getOptionalDocsHost()?.onDocumentThemeChanged?.(applyDocumentTheme)
  await getOptionalDocsHost()
    ?.getAiPanelPrefs?.()
    .then(applyAiPanelPrefs)
    .catch(() => {})
  getOptionalDocsHost()?.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  await getOptionalDocsHost()
    ?.getAuthorName?.()
    .then(setAuthorName)
    .catch(() => {})
  getOptionalDocsHost()?.onAuthorNameChanged?.(setAuthorName)
  createRoot(document.getElementById('root')!).render(
    <LocaleProvider initial={lang}>
      <App agentUi={nativeDocsAgentUi} />
    </LocaleProvider>,
  )
}

void bootstrap()
