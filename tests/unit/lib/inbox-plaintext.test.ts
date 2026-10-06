import { describe, expect, it } from 'vitest'
import { messagePlainText, stripHtmlToPlainText } from '@/lib/inbox/plaintext'

const payload = '<img src="invalid" onerror="document.body.dataset.inboxXss=\'executed\'">'

describe('inbox plaintext helpers', () => {
  it('never emits markup and neutralizes an inline event handler', () => {
    const text = stripHtmlToPlainText(`${payload}<p>Hello reviewer</p>`)
    expect(text).not.toContain('<img')
    expect(text).not.toContain('onerror')
    expect(text).toContain('Hello reviewer')
  })

  it('converts html-only bodies and keeps visible text', () => {
    expect(messagePlainText('', '<p>Line one</p><p>Line two</p>')).toBe('Line one\n\nLine two')
    expect(messagePlainText(null, '<div>Only html</div>')).toBe('Only html')
  })

  it('prefers a measured plain-text body over stored html', () => {
    expect(messagePlainText('Already plain', payload)).toBe('Already plain')
  })

  it('drops raw-text containers including an unterminated script tail', () => {
    expect(stripHtmlToPlainText('<script>alert(1)</script>visible')).toBe('visible')
    expect(stripHtmlToPlainText('<style>.x{}</style>safe')).toBe('safe')
    expect(stripHtmlToPlainText('<iframe src="x">hidden')).toBe('')
  })

  it('decodes a bounded set of entities without resurrecting markup', () => {
    expect(stripHtmlToPlainText('Tom &amp; Jerry &lt;tag&gt;')).toBe('Tom & Jerry <tag>')
  })
})
