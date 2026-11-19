import { expect, it } from 'vitest'
import {
  mainStoryOracle,
  expectedTextboxStories,
  verifyTextboxStories,
} from '../../../e2e/docs-performance-stories'

const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const mc = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const wrap = (xml: string) =>
  `<doc:document xmlns:doc="${w}" xmlns:c="${mc}" xmlns:x="urn:unsupported"><doc:body>${xml}</doc:body></doc:document>`
const p = (text: string) => `<doc:p><doc:r><doc:t>${text}</doc:t></doc:r></doc:p>`

it('keeps separate textbox branches out of the main story without requiring an invented namespace capability set', () => {
  const textboxes =
    '<c:AlternateContent><c:Choice Requires="x"><doc:txbxContent>' +
    p('Chosen shape story') +
    '</doc:txbxContent></c:Choice><c:Fallback><doc:txbxContent>' +
    p('Archival fallback story') +
    '</doc:txbxContent></c:Fallback></c:AlternateContent>'
  const actual = mainStoryOracle(
    wrap(
      p('Start') +
        '<doc:p><doc:r><doc:t>Adjacent</doc:t>' +
        textboxes +
        '</doc:r></doc:p>' +
        p('End'),
    ),
  )
  expect(actual).toEqual({
    textRuns: ['Start', 'Adjacent', 'End'],
    paragraphs: [
      { text: 'Start', start: 0 },
      { text: 'Adjacent', start: 5 },
      { text: 'End', start: 13 },
    ],
    tail: 'End',
  })
})

it('allows a namespace-independent common main-story projection but rejects genuinely different unresolved alternatives', () => {
  expect(
    mainStoryOracle(
      wrap(
        '<c:AlternateContent><c:Choice Requires="x">' +
          p('Common') +
          '</c:Choice><c:Fallback>' +
          p('Common') +
          '</c:Fallback></c:AlternateContent>' +
          p('End'),
      ),
    ).textRuns,
  ).toEqual(['Common', 'End'])
  expect(() =>
    mainStoryOracle(
      wrap(
        '<c:AlternateContent><c:Choice Requires="x">' +
          p('Choice') +
          '</c:Choice><c:Fallback>' +
          p('Fallback') +
          '</c:Fallback></c:AlternateContent>' +
          p('End'),
      ),
    ),
  ).toThrow('Unresolved alternate main-story content')
  expect(() =>
    mainStoryOracle(
      wrap(
        '<c:AlternateContent><c:Choice Requires="x">' +
          p('Choice') +
          '</c:Choice></c:AlternateContent>' +
          p('End'),
      ),
    ),
  ).toThrow('Unresolved alternate main-story content')
})

it('fails explicitly for text in an unclassified non-WML story instead of silently dropping it', () => {
  expect(() => mainStoryOracle(wrap(p('Start') + '<x:t>Other story</x:t>' + p('End')))).toThrow(
    'Unclassified text-bearing XML story',
  )
})

it('keeps the full-document tail requirement while explicitly allowing an empty source table cell projection', () => {
  expect(() => mainStoryOracle(wrap(p('')))).toThrow(
    'Main story requires a nonempty final paragraph',
  )
  expect(mainStoryOracle(wrap(p('')), { allowEmpty: true })).toEqual({
    textRuns: [],
    paragraphs: [{ text: '', start: 0 }],
    tail: '',
  })
})

it('resolves a compatibility branch prefix declared on that branch itself', () => {
  const actual = mainStoryOracle(
    wrap(
      '<c:AlternateContent><local:Choice xmlns:local="' +
        mc +
        '" Requires="x">' +
        p('Common') +
        '</local:Choice><c:Fallback>' +
        p('Common') +
        '</c:Fallback></c:AlternateContent>' +
        p('End'),
    ),
  )
  expect(actual.textRuns).toEqual(['Common', 'End'])
})

it('binds rendered textbox text to an exact archived source rather than accepting fallback text or invented source indices', () => {
  const originalXml =
    '<doc:p><doc:r><c:AlternateContent><c:Choice Requires="x"><doc:txbxContent>' +
    p('Active source story') +
    '</doc:txbxContent></c:Choice><c:Fallback><doc:txbxContent>' +
    p('Other archived story') +
    '</doc:txbxContent></c:Fallback></c:AlternateContent></doc:r></doc:p>'
  const xml = wrap(originalXml + p('End'))
  const expected = expectedTextboxStories(xml, [{ docxIndex: 7, originalXml }])
  const actual = [{ docxIndex: 7, txbxIndex: 0, text: 'Active source story', laidOut: true }]
  expect(() => verifyTextboxStories(expected, actual)).not.toThrow()
  expect(() =>
    verifyTextboxStories(expected, [{ ...actual[0], text: 'Other archived story' }]),
  ).toThrow('Textbox story text differs')
  expect(() => verifyTextboxStories(expected, [{ ...actual[0], txbxIndex: undefined }])).toThrow(
    'Unknown rendered textbox source identity',
  )
  expect(() => verifyTextboxStories(expected, [])).toThrow(
    'Missing or duplicated rendered textbox story',
  )
  expect(() => verifyTextboxStories(expected, [{ ...actual[0], laidOut: false }])).toThrow(
    'Textbox story has no layout geometry',
  )
  expect(() =>
    expectedTextboxStories(xml, [
      { docxIndex: 7, originalXml: originalXml.replace('Active source story', 'Invented text') },
    ]),
  ).toThrow('Textbox source XML is not uniquely present in the archive')
  expect(() => expectedTextboxStories(xml, [])).toThrow(
    'Archived textbox stories lack source bindings',
  )
})
