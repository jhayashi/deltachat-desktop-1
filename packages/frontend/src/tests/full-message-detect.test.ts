import { expect } from 'chai'
import { describe, it } from 'mocha'

import { extractPlaintext } from '../components/full-message/detectPlaintext.js'

describe('extractPlaintext (regex fallback path)', () => {
  describe('simple wrappers', () => {
    it('returns empty for empty input', () => {
      expect(extractPlaintext('')).to.equal('')
    })

    it('extracts a `<pre>`-wrapped body', () => {
      const html =
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head>' +
        '<body><pre>hello world</pre></body></html>'
      expect(extractPlaintext(html)).to.equal('hello world')
    })

    it('preserves paragraph breaks for `<p>...</p><p>...</p>`', () => {
      const html =
        '<html><body><p># Heading</p><p>## Sub</p><p>body</p></body></html>'
      // Each </p> maps to a paragraph break; markdown-friendly.
      const out = extractPlaintext(html)
      expect(out).to.contain('# Heading')
      expect(out).to.contain('## Sub')
      // Heading and sub must not be glued onto one line — markdown
      // requires the # and ## to start lines.
      const lines = out.split('\n').filter(l => l.trim().length > 0)
      expect(lines).to.deep.equal(['# Heading', '## Sub', 'body'])
    })

    it('decodes common HTML entities', () => {
      const html =
        '<html><body><pre>5 &lt; 10 &amp;&amp; foo &gt; bar &quot;ok&quot;</pre></body></html>'
      expect(extractPlaintext(html)).to.equal('5 < 10 && foo > bar "ok"')
    })

    it('decodes numeric and hex character references', () => {
      const html = '<html><body><pre>&#65; &#x42; &#x1F600;</pre></body></html>'
      expect(extractPlaintext(html)).to.equal('A B \u{1F600}')
    })

    it('converts <br> to newlines', () => {
      const html = '<html><body><p>line1<br>line2<br/>line3</p></body></html>'
      expect(extractPlaintext(html)).to.contain('line1\nline2\nline3')
    })

    it('drops <head> children', () => {
      const html =
        '<html><head><title>Subject</title></head>' +
        '<body><pre>just the body</pre></body></html>'
      const out = extractPlaintext(html)
      expect(out).to.equal('just the body')
      expect(out).to.not.contain('Subject')
    })

    it('drops <script> and <style> blocks', () => {
      const html =
        '<html><body><script>evil()</script>' +
        '<style>.x{}</style>' +
        '<p>safe content</p></body></html>'
      const out = extractPlaintext(html)
      expect(out).to.equal('safe content')
      expect(out).to.not.contain('evil')
      expect(out).to.not.contain('.x')
    })

    it('drops HTML comments', () => {
      const html =
        '<html><body><pre>before<!-- secret --> after</pre></body></html>'
      expect(extractPlaintext(html)).to.equal('before after')
    })
  })

  describe('markdown structure preserved through the extractor', () => {
    it('keeps blank lines between paragraphs', () => {
      // DC core's wrapping for a multi-paragraph plaintext message —
      // the original message had `\n\n` between paragraphs.
      const html =
        '<html><body>' +
        '<p># Heading</p>' +
        '<p>**bold text**</p>' +
        '<p>plain paragraph</p>' +
        '</body></html>'
      const out = extractPlaintext(html)
      // Markdown-significant tokens must each be on their own line.
      expect(out).to.match(/^# Heading$/m)
      expect(out).to.match(/^\*\*bold text\*\*$/m)
      expect(out).to.match(/^plain paragraph$/m)
    })

    it('handles a fenced code block inside <pre>', () => {
      const html = '<html><body><pre>```\ncode\nblock\n```</pre></body></html>'
      const out = extractPlaintext(html)
      expect(out).to.contain('```\ncode\nblock\n```')
    })

    it('collapses runs of 3+ newlines to exactly two', () => {
      // Pathological input: many empty paragraphs back-to-back.
      const html =
        '<html><body><p>a</p><p></p><p></p><p></p><p>b</p></body></html>'
      const out = extractPlaintext(html)
      expect(out).to.match(/a\n\nb/)
      expect(out).to.not.match(/\n\n\n/)
    })

    it('rejoins table rows that DC core wrapped per-line in <p>', () => {
      // DC core wraps each line of the source in its own <p>, which
      // our walker turns into \n\n between rows. The post-pass must
      // restore the consecutive-line layout markdown-it requires.
      const html =
        '<html><body>' +
        '<p>| h1 | h2 |</p>' +
        '<p>|----|----|</p>' +
        '<p>| a  | b  |</p>' +
        '</body></html>'
      const out = extractPlaintext(html)
      expect(out).to.equal('| h1 | h2 |\n|----|----|\n| a  | b  |')
    })

    it('preserves paragraph break before and after a table block', () => {
      // The table rows should collapse to single \n between them, but
      // the surrounding paragraphs should still get their \n\n.
      const html =
        '<html><body>' +
        '<p>before</p>' +
        '<p>| a | b |</p>' +
        '<p>|---|---|</p>' +
        '<p>| 1 | 2 |</p>' +
        '<p>after</p>' +
        '</body></html>'
      const out = extractPlaintext(html)
      expect(out).to.equal(
        'before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter'
      )
    })
  })
})
