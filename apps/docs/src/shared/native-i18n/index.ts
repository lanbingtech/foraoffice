import { createI18n } from '@genoffice/i18n'
import zh from './zh'
import en from './en'
import vi from './vi'
import tr from './tr'
import ja from './ja'
import ko from './ko'
import fr from './fr'
import de from './de'
import es from './es'
import th from './th'
import id from './id'
import ru from './ru'
import ar from './ar'
import pt from './pt'
import it from './it'
import pl from './pl'
import cs from './cs'
import nl from './nl'
import ms from './ms'
import he from './he'
import hi from './hi'
import zhTW from './zh-TW'

export const docsNativeDictionaries = {
  zh,
  en,
  vi,
  tr,
  ja,
  ko,
  fr,
  de,
  es,
  th,
  id,
  ru,
  ar,
  pt,
  it,
  pl,
  cs,
  nl,
  ms,
  he,
  hi,
  'zh-TW': zhTW,
}
export const tDocsNative = createI18n(docsNativeDictionaries)
