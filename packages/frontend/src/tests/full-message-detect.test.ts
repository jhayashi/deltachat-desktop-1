import { expect } from 'chai'
import { describe, it } from 'mocha'

import { detectPlaintext } from '../components/full-message/detectPlaintext.js'

describe('detectPlaintext', () => {
  describe('wrapped-plaintext recognition', () => {
    it('accepts an empty string', () => {
      const out = detectPlaintext('')
      expect(out.isPlaintext).to.equal(true)
      expect(out.text).to.equal('')
    })

    it('accepts a `<pre>`-wrapped body and extracts the text', () => {
      const html =
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
        '<body><pre>hello world</pre></body></html>'
      const out = detectPlaintext(html)
      expect(out.isPlaintext).to.equal(true)
      expect(out.text).to.equal('hello world')
    })

    it('accepts a `<p>`-wrapped body', () => {
      const html = '<html><body><p>hello</p><p>world</p></body></html>'
      const out = detectPlaintext(html)
      expect(out.isPlaintext).to.equal(true)
      expect(out.text).to.contain('hello')
      expect(out.text).to.contain('world')
    })

    it('decodes common HTML entities back to their literals', () => {
      const html =
        '<html><body><pre>5 &lt; 10 &amp;&amp; foo &gt; bar &quot;ok&quot;</pre></body></html>'
      const out = detectPlaintext(html)
      expect(out.isPlaintext).to.equal(true)
      expect(out.text).to.equal('5 < 10 && foo > bar "ok"')
    })

    it('decodes numeric and hex character references', () => {
      const html = '<html><body><pre>&#65; &#x42; &#x1F600;</pre></body></html>'
      const out = detectPlaintext(html)
      expect(out.isPlaintext).to.equal(true)
      // U+1F600 is the grinning-face emoji.
      expect(out.text).to.equal('A B \u{1F600}')
    })

    it('converts <br> to newlines so soft breaks survive', () => {
      const html = '<html><body><p>line1<br>line2<br/>line3</p></body></html>'
      const out = detectPlaintext(html)
      expect(out.isPlaintext).to.equal(true)
      expect(out.text).to.equal('line1\nline2\nline3')
    })

    it('drops <head> children from extracted text (no <title> bleed)', () => {
      const html =
        '<html><head><title>Subject Line</title></head>' +
        '<body><pre>just the body</pre></body></html>'
      const out = detectPlaintext(html)
      expect(out.isPlaintext).to.equal(true)
      expect(out.text).to.equal('just the body')
      expect(out.text).to.not.contain('Subject Line')
    })

    it('drops HTML comments', () => {
      const html =
        '<html><body><pre>before<!-- secret --> after</pre></body></html>'
      const out = detectPlaintext(html)
      expect(out.isPlaintext).to.equal(true)
      expect(out.text).to.equal('before after')
    })
  })

  describe('rich HTML rejection', () => {
    const richCases: Array<[string, string]> = [
      [
        '<style>',
        '<html><body><style>p{color:red}</style><p>x</p></body></html>',
      ],
      [
        '<script>',
        '<html><body><script>alert(1)</script><p>x</p></body></html>',
      ],
      [
        '<table>',
        '<html><body><table><tr><td>a</td></tr></table></body></html>',
      ],
      ['<img>', '<html><body><img src="https://x"/><p>x</p></body></html>'],
      ['<iframe>', '<html><body><iframe src="https://x"/></body></html>'],
      ['inline style', '<html><body><p style="color:red">x</p></body></html>'],
      ['<svg>', '<html><body><svg><circle/></svg></body></html>'],
      ['<form>', '<html><body><form><input/></form></body></html>'],
      [
        '<a> link (not in allow list)',
        '<html><body><p>see <a href="x">link</a></p></body></html>',
      ],
    ]

    for (const [name, input] of richCases) {
      it(`rejects ${name}`, () => {
        const out = detectPlaintext(input)
        expect(out.isPlaintext).to.equal(false)
        expect(out.text).to.equal(undefined)
      })
    }
  })

  describe('size guard', () => {
    it('rejects bodies larger than the cap, regardless of contents', () => {
      const big =
        '<html><body><pre>' + 'a'.repeat(600 * 1024) + '</pre></body></html>'
      const out = detectPlaintext(big)
      expect(out.isPlaintext).to.equal(false)
    })
  })
})
