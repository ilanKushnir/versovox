import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * One stylesheet, one namespace.
 *
 * The reading list shipped with its container class named `.queue`, which the
 * processing panel had already used for a year. The second definition, six
 * hundred lines further down, quietly reset the panel's padding and margin —
 * a feature breaking a page it never touched, invisible to every test and to
 * anyone who did not open Settings after building a reading list.
 *
 * A bare single-class selector at the top level of the file is a component
 * root claiming a name. Two of them with the same name is that bug.
 */

const CSS = fs.readFileSync(
  path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'base.css'),
  'utf8',
);

/**
 * Selectors of every top-level rule. Rules nested in @media/@container/@supports
 * are skipped: redefining a class inside one is the whole point of a breakpoint.
 */
function topLevelSelectors(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors: string[] = [];
  let buf = '';
  let atDepth = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') {
      const selector = buf.trim();
      buf = '';
      i++;
      if (selector.startsWith('@')) {
        atDepth++; // step INTO the at-rule; its children are not top level
        continue;
      }
      let depth = 1; // step OVER a plain rule's declarations
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      if (atDepth === 0) selectors.push(selector);
      continue;
    }
    if (c === '}') {
      if (atDepth > 0) atDepth--;
      buf = '';
    } else {
      buf += c;
    }
    i++;
  }
  return selectors;
}

/**
 * Class names that already had two top-level rules before this guard existed.
 * They are debt, not licence: nothing may be added here. Give the new
 * component a name of its own instead.
 */
const PRE_EXISTING = ['continue-rail', 'book-card', 'auth-page', 'auth-card', 'pair-card'];

describe('base.css', () => {
  it('gives every component root class exactly one top-level rule', () => {
    const counts = new Map<string, number>();
    for (const selector of topLevelSelectors(CSS)) {
      const bare = /^\.([a-zA-Z0-9_-]+)$/.exec(selector.trim());
      if (!bare) continue;
      counts.set(bare[1]!, (counts.get(bare[1]!) ?? 0) + 1);
    }
    const claimedTwice = [...counts.entries()]
      .filter(([name, n]) => n > 1 && !PRE_EXISTING.includes(name))
      .map(([name]) => name)
      .sort();
    expect(claimedTwice).toEqual([]);
  });

  it('does not let the reading list and the processing panel share a root', () => {
    // The exact collision that shipped. `.queue` belongs to Processing.tsx;
    // the reading list is `.readlist`.
    const roots = topLevelSelectors(CSS).map((s) => s.trim());
    expect(roots.filter((s) => s === '.queue')).toHaveLength(1);
    expect(roots).toContain('.readlist');
  });
});
