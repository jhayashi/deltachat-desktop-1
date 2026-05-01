import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'

import { fullParser, inlineParser } from '../utils/markdown/parser.js'
import { renderMarkdown } from '../utils/markdown/renderToReact.js'
import type {
  TextLeafCtx,
  RenderTextLeafFn,
} from '../utils/markdown/renderToReact.js'
import { parseElements } from '../utils/linkify/parseElements.js'

/**
 * Walk a React element tree into a flat list of `{type, props}` so we can
 * make assertions about structure without rendering. Strings collapse to
 * `{type: '#text', value}`.
 */
type Walked = { type: string; props: Record<string, any> }

function flatten(el: any): Walked[] {
  const out: Walked[] = []
  function walk(node: any) {
    if (node == null || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') {
      out.push({ type: '#text', props: { value: String(node) } })
      return
    }
    if (Array.isArray(node)) {
      for (const c of node) walk(c)
      return
    }
    if (typeof node === 'object' && 'type' in node && 'props' in node) {
      const t: any = (node as any).type
      const typeName: string =
        typeof t === 'string'
          ? t
          : (t && (t.displayName || t.name)) || 'Anonymous'
      const props: Record<string, any> = { ...((node as any).props || {}) }
      const children = props.children
      delete props.children
      out.push({ type: typeName, props })
      walk(children)
    }
  }
  walk(el)
  return out
}

const types = (els: Walked[]) => els.map(e => e.type)
const texts = (els: Walked[]) =>
  els
    .filter(e => e.type === '#text')
    .map(e => e.props.value)
    .join('')

// Plain-span renderer injected as the leaf-text renderer. The walker is
// decoupled from MessageParser via `RenderTextLeafFn`, so tests can run
// without dragging in Link/EmailLink/Dialog/etc.
const stubRender: RenderTextLeafFn = (text, _ctx, parentKey) => [
  React.createElement('span', { key: `${parentKey}t0` }, text),
]
const ctx: TextLeafCtx = { tabindex: 0 }
const md = (input: string) =>
  flatten(renderMarkdown(input, fullParser, ctx, stubRender))
const mdInline = (input: string) =>
  flatten(renderMarkdown(input, inlineParser, ctx, stubRender))

describe('markdown — full parser', () => {
  describe('enabled rules', () => {
    it('renders **bold** as <strong>', () => {
      const out = md('**hello**')
      expect(types(out)).to.include('strong')
      expect(texts(out)).to.equal('hello')
    })

    it('renders *italic* as <em>', () => {
      const out = md('*hi*')
      expect(types(out)).to.include('em')
      expect(texts(out)).to.equal('hi')
    })

    it('renders ~~strike~~ as <s>', () => {
      const out = md('~~gone~~')
      expect(types(out)).to.include('s')
      expect(texts(out)).to.equal('gone')
    })

    it('renders `inline` as <code> (mm-inline-code)', () => {
      const out = md('`x`')
      const code = out.find(e => e.type === 'code')
      expect(code, 'expected a <code> element').to.not.equal(undefined)
      expect(code!.props.className).to.contain('mm-inline-code')
      expect(texts(out)).to.equal('x')
    })

    it('renders fenced code as <pre><code>', () => {
      const out = md('```\nhello\n```')
      const pre = out.find(e => e.type === 'pre')
      expect(pre, 'expected a <pre>').to.not.equal(undefined)
      expect(pre!.props.className).to.contain('mm-code')
      // a11y: keyboard users must be able to focus the overflow region
      // to scroll horizontally.
      expect(pre!.props.tabIndex).to.equal(0)
      expect(pre!.props.role).to.equal('region')
      expect(texts(out)).to.contain('hello')
    })

    it('drops the language info string from fenced code output', () => {
      const out = md('```js\nvar x = 1\n```')
      const all = JSON.stringify(out)
      expect(all).to.not.contain('"js"')
      expect(texts(out)).to.contain('var x = 1')
    })

    it('renders a GFM table wrapped in mm-table-scroll', () => {
      const out = md('| a | b |\n|---|---|\n| 1 | 2 |')
      const wrapper = out.find(
        e => e.type === 'div' && /mm-table-scroll/.test(e.props.className || '')
      )
      const table = out.find(e => e.type === 'table')
      expect(wrapper, 'expected an mm-table-scroll wrapper div').to.not.equal(undefined)
      // a11y: keyboard scrollability for overflow.
      expect(wrapper!.props.tabIndex).to.equal(0)
      expect(wrapper!.props.role).to.equal('region')
      expect(table, 'expected a <table>').to.not.equal(undefined)
      expect(types(out)).to.include('thead')
      expect(types(out)).to.include('tbody')
      expect(types(out).filter(t => t === 'th').length).to.equal(2)
      expect(types(out).filter(t => t === 'td').length).to.equal(2)
    })

    it('renders blank-line-separated paragraphs as distinct mm-paragraph blocks', () => {
      const out = md('hello\n\nworld')
      const paragraphs = out.filter(
        e => e.type === 'div' && /mm-paragraph/.test(e.props.className || '')
      )
      expect(paragraphs.length).to.equal(2)
      // both texts should be present
      expect(texts(out)).to.contain('hello')
      expect(texts(out)).to.contain('world')
    })
  })

  describe('disabled rules pass through as plain text', () => {
    const passthrough: Array<[string, string]> = [
      ['heading', '# H1'],
      ['list-bullet', '- item'],
      ['list-ordered', '1. item'],
      ['blockquote', '> quoted'],
      ['hr', '---'],
      ['indented-code', '    pretend code'],
      ['image', '![alt](url)'],
      ['markdown-link', '[text](https://x.com)'],
      ['html-inline', 'a <b>bold</b> b'],
      ['autolink', '<https://x.com>'],
    ]

    for (const [name, input] of passthrough) {
      it(`${name}: ${JSON.stringify(input)}`, () => {
        const out = md(input)
        expect(types(out)).to.not.include('h1')
        expect(types(out)).to.not.include('h2')
        expect(types(out)).to.not.include('ul')
        expect(types(out)).to.not.include('ol')
        expect(types(out)).to.not.include('li')
        expect(types(out)).to.not.include('a')
        expect(types(out)).to.not.include('img')
        expect(types(out)).to.not.include('hr')
        expect(types(out)).to.not.include('blockquote')
        const visibleText = texts(out)
        expect(visibleText.length).to.be.greaterThan(0)
      })
    }

    it('escapes inline HTML — does not produce a real <b>', () => {
      const out = md('a <b>bold</b> b')
      expect(types(out)).to.not.include('b')
      expect(texts(out)).to.contain('<b>')
    })
  })

  describe('soft and hard breaks', () => {
    it('renders softbreak as <br>', () => {
      const out = md('line1\nline2')
      expect(types(out)).to.include('br')
    })

    it('renders explicit hardbreak as <br>', () => {
      const out = md('line1  \nline2')
      expect(types(out)).to.include('br')
    })
  })

  describe('keys are stable across re-runs', () => {
    it('same input produces same key sequence', () => {
      const a = renderMarkdown(
        '**hi** there',
        fullParser,
        ctx,
        stubRender
      ) as any[]
      const b = renderMarkdown(
        '**hi** there',
        fullParser,
        ctx,
        stubRender
      ) as any[]
      const keysA = a.map((n: any) => n?.key).filter(Boolean)
      const keysB = b.map((n: any) => n?.key).filter(Boolean)
      expect(keysA.length).to.be.greaterThan(0)
      expect(keysA).to.deep.equal(keysB)
    })
  })

  describe('formatting + bot commands', () => {
    it('text leaves inside <strong> get suppressBotCommands=true', () => {
      // We can verify this indirectly: the stubRender ignores ctx; but we
      // can spy on the ctx that the walker hands the leaf renderer.
      const seen: TextLeafCtx[] = []
      const spy: RenderTextLeafFn = (text, ctxArg, key) => {
        seen.push(ctxArg)
        return [React.createElement('span', { key: `${key}t0` }, text)]
      }
      renderMarkdown('**hello /help**', fullParser, ctx, spy)
      // text leaf inside <strong> should have suppressBotCommands true
      expect(seen.some(c => c.suppressBotCommands === true)).to.equal(true)
    })

    it('top-level text leaves do NOT have suppressBotCommands set', () => {
      const seen: TextLeafCtx[] = []
      const spy: RenderTextLeafFn = (text, ctxArg, key) => {
        seen.push(ctxArg)
        return [React.createElement('span', { key: `${key}t0` }, text)]
      }
      renderMarkdown('use /help today', fullParser, ctx, spy)
      expect(seen.some(c => !c.suppressBotCommands)).to.equal(true)
    })
  })
})

describe('markdown — inline-only parser', () => {
  it('does not render fenced code as a code block (passes through)', () => {
    const out = mdInline('```\ncode\n```')
    expect(types(out)).to.not.include('pre')
  })

  it('does not render tables (passes through)', () => {
    const out = mdInline('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(types(out)).to.not.include('table')
  })

  it('still renders bold', () => {
    const out = mdInline('**x**')
    expect(types(out)).to.include('strong')
  })
})

describe('parseElements suppressBotCommands option', () => {
  it('demotes /command to text when suppressBotCommands=true', () => {
    const out = parseElements('/help', { suppressBotCommands: true })
    expect(out.some(e => e.t === 'botcommand')).to.equal(false)
  })

  it('keeps /command as botcommand when suppressBotCommands=false (default)', () => {
    // botcommand.test.ts in this suite registers the plugin earlier.
    const out = parseElements('/help')
    expect(out.some(e => e.t === 'botcommand')).to.equal(true)
  })
})
