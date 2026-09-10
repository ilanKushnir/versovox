import { describe, expect, it } from 'vitest';
import { sanitizeChapter } from './sanitize.js';

const known = new Set(['OEBPS/ch1.xhtml', 'OEBPS/ch2.xhtml', 'OEBPS/img/pic.png']);

function clean(html: string) {
  return sanitizeChapter(`<html><body>${html}</body></html>`, 'OEBPS/ch1.xhtml', known);
}

describe('sanitizeChapter', () => {
  it('strips scripts, styles, iframes, forms, and event handlers', () => {
    const r = clean(
      `<p onclick="alert(1)">Hello</p><script>alert(2)</script><style>p{}</style>` +
        `<iframe src="https://evil.example"></iframe><form><input/></form>` +
        `<object data="x"></object><embed src="y"/><video src="z"></video>`,
    );
    expect(r.html).toContain('Hello');
    expect(r.html).not.toMatch(/script|iframe|form|input|object|embed|video|onclick/i);
  });

  it('drops javascript: and external image references', () => {
    const r = clean(
      `<a href="javascript:alert(1)">x</a><img src="https://evil.example/x.png"/><img src="img/pic.png" alt="ok"/>`,
    );
    expect(r.html).not.toContain('javascript:');
    expect(r.html).not.toContain('evil.example');
    expect(r.html).toContain('asset/OEBPS%2Fimg%2Fpic.png');
    expect(r.assets).toEqual(['OEBPS/img/pic.png']);
  });

  it('rewrites internal links to data attributes and keeps https external links inert', () => {
    const r = clean(`<a href="ch2.xhtml#part2">next</a><a href="https://example.org/">site</a>`);
    expect(r.html).toContain('data-vx-href="OEBPS/ch2.xhtml#part2"');
    expect(r.html).toContain('rel="noopener noreferrer nofollow"');
  });

  it('blocks path escapes in hrefs and srcs', () => {
    const r = clean(`<img src="../../../../etc/passwd"/><a href="../../secret.xhtml">x</a>`);
    expect(r.html).not.toContain('passwd');
    expect(r.html).not.toContain('secret');
    expect(r.assets).toEqual([]);
  });

  it('preserves semantic structure and dir attributes', () => {
    const r = clean(
      `<section><h1>ל…title</h1><p dir="rtl" lang="he">שלום <em>עולם</em></p><blockquote>q</blockquote></section>`,
    );
    expect(r.html).toContain('<h1>');
    expect(r.html).toContain('dir="rtl"');
    expect(r.html).toContain('<em>');
  });

  it('drops inline style attributes', () => {
    const r = clean(`<p style="background:url(https://t.example/x)">t</p>`);
    expect(r.html).not.toContain('style=');
  });

  it('extracts text with block boundaries for sentence indexing', () => {
    const r = clean(`<p>One two.</p><p>Three four.</p>`);
    expect(r.text).toBe('One two.\nThree four.\n');
  });

  it('unwraps unknown-but-harmless elements, keeping their text', () => {
    const r = clean(`<custom-widget><p>Kept text</p></custom-widget>`);
    expect(r.html).toContain('Kept text');
    expect(r.html).not.toContain('custom-widget');
  });
});
