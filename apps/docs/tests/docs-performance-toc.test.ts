// @vitest-environment node
import { expect, it } from 'vitest'
import {
  matchesPrintedTocLeader,
  projectPrintedTocLeaders,
} from '../../../e2e/docs-performance-toc'

const archived =
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:body><w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/>' +
  '</w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:pPr><w:tabs>' +
  '<w:tab w:val="right" w:leader="dot" w:pos="3000"/></w:tabs></w:pPr>' +
  '<w:hyperlink w:anchor="Public"><w:r><w:t>3.1 Title</w:t></w:r><w:r><w:tab/></w:r>' +
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGEREF Public</w:instrText></w:r>' +
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>12</w:t></w:r>' +
  '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:hyperlink></w:p></w:sdtContent></w:sdt>' +
  '</w:body></w:document>'
const body = { body: 'Before3.1Title12After' }
const measure = { anchor: 'Public', page: 2, minimum: 3, maximum: 4 }

it('binds generated dots to the exact archived TOC entry and measured range', () => {
  const { chains, leaders } = projectPrintedTocLeaders(archived, body, [measure])
  const source = leaders['toc:Public']
  expect(chains.body).toBe('BeforeAfter')
  expect(matchesPrintedTocLeader('3.1Title...12', source)).toBe(true)
  expect(matchesPrintedTocLeader('3.1Title....12', source)).toBe(true)
  expect(matchesPrintedTocLeader('3.1Title..12', source)).toBe(false)
  expect(matchesPrintedTocLeader('3.1Title.....12', source)).toBe(false)
  expect(matchesPrintedTocLeader('3.1Title.a.12', source)).toBe(false)
  expect(matchesPrintedTocLeader('3.1Title...13', source)).toBe(false)
})

it('rejects an ambiguous source or a region that lacks an authored matching tab', () => {
  expect(() => projectPrintedTocLeaders(archived, body, [])).toThrow('no unique')
  expect(() => projectPrintedTocLeaders(archived, body, [measure, measure])).toThrow('no unique')
  expect(() =>
    projectPrintedTocLeaders(archived.replace('w:leader="dot"', 'w:leader="none"'), body, [
      measure,
    ]),
  ).toThrow('no independently authored tab')
  expect(() =>
    projectPrintedTocLeaders(archived, { body: 'Before3.1Title123.1Title12After' }, [measure]),
  ).toThrow('ambiguous')
})
