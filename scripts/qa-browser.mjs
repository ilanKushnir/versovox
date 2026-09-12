#!/usr/bin/env node
/**
 * Browser QA sweep against a running ReadPort server.
 *
 * Usage:
 *   node scripts/qa-browser.mjs [baseUrl] [username] [password]
 * Defaults: http://127.0.0.1:8383 astra astra-demo-password-1
 *
 * Captures screenshots to qa-output/ at desktop (1440), iPhone (390), and
 * narrow (320) widths, logs console/page errors, checks horizontal overflow,
 * exercises reader/player/pairing/PWA flows including the two-way switch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = createRequire('/usr/local/lib/node_modules/')('playwright'));
}

const BASE = process.argv[2] ?? 'http://127.0.0.1:8383';
const USER = process.argv[3] ?? 'astra';
const PASS = process.argv[4] ?? 'astra-demo-password-1';
// First-run bootstrap token (matches the RP_SETUP_TOKEN the QA server runs with).
const SETUP_TOKEN = process.env.RP_QA_SETUP_TOKEN ?? 'qa-setup-token';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'qa-output');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const issues = [];
const shots = [];

function note(kind, msg) {
  issues.push({ kind, msg });
  console.log(`  [${kind}] ${msg}`);
}

async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push(name);
  console.log(`  shot ${name}`);
}

/**
 * Wait until running CSS animations/transitions finish (plus two frames), so
 * screenshots of animated surfaces (sheets slide up over ~250ms) capture the
 * settled state instead of a mid-transition ghost.
 */
async function settle(page) {
  await page
    .evaluate(async () => {
      const deadline = Date.now() + 2000;
      let anims;
      do {
        anims = document.getAnimations().filter((a) => a.playState === 'running');
        await Promise.all(anims.map((a) => a.finished.catch(() => {})));
      } while (anims.length > 0 && Date.now() < deadline);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    })
    .catch(() => {});
}

/** Open-sheet geometry: every visible control/label must sit inside the sheet
 * and viewport, or inside a container that can actually scroll to reveal it. */
async function checkSheetContainment(page, name) {
  const problems = await page.evaluate(() => {
    const out = [];
    const sheet = document.querySelector('.sheet');
    if (!sheet) return ['no open .sheet'];
    const sr = sheet.getBoundingClientRect();
    const scrolls = (el, axis) => {
      const cs = getComputedStyle(el);
      return axis === 'x'
        ? /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1
        : /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
    };
    const scrollerFor = (el, axis) => {
      for (let n = el.parentElement; n && n !== sheet.parentElement; n = n.parentElement) {
        if (scrolls(n, axis)) return n;
      }
      return null;
    };
    const els = sheet.querySelectorAll('button, label, input, select, .chip, .sheet__title');
    for (const el of els) {
      if (el.checkVisibility && !el.checkVisibility()) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const label = (el.getAttribute('aria-label') || el.textContent || el.tagName)
        .trim()
        .slice(0, 40);
      // Horizontal: clipped by the sheet or viewport edge with no scroll
      // container able to reveal it => clipped label.
      if (!scrollerFor(el, 'x')) {
        const clipRight = Math.min(sr.right, window.innerWidth);
        const clipLeft = Math.max(sr.left, 0);
        if (r.right > clipRight + 1 || r.left < clipLeft - 1) {
          out.push(
            `"${label}" clipped horizontally (${Math.round(r.left)}..${Math.round(r.right)})`,
          );
        }
      }
      // Vertical: either fully on-screen, or inside a scroll container whose
      // own visible box is bounded by the viewport (i.e. reachable by scroll).
      const vScroller = scrollerFor(el, 'y');
      if (vScroller) {
        const sb = vScroller.getBoundingClientRect();
        if (sb.bottom > window.innerHeight + 1 || sb.top < -1) {
          out.push(`scroll container for "${label}" extends past the viewport`);
        }
      } else if (r.bottom > window.innerHeight + 1 || r.top < -1) {
        out.push(`"${label}" off-screen vertically with no scroll container`);
      }
      if (out.length >= 6) break;
    }
    return out;
  });
  for (const m of problems) note('layout', `${name}: ${m}`);
}

/** Player hero geometry: top bar, title block, and cover must not overlap
 * and must all be inside the viewport. */
async function checkPlayerLayout(page, name) {
  const problems = await page.evaluate(() => {
    const out = [];
    const boxes = {};
    for (const [key, sel] of [
      ['top bar', '.player-top'],
      ['cover', '.player-cover'],
      ['title', '.player-titles h1'],
      ['chapter', '.player-titles .chapter'],
    ]) {
      const el = document.querySelector(sel);
      if (!el) return [`missing ${sel}`];
      boxes[key] = el.getBoundingClientRect();
    }
    const overlaps = (a, b) =>
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2 &&
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2;
    for (const other of ['top bar', 'title', 'chapter']) {
      if (overlaps(boxes.cover, boxes[other])) out.push(`cover overlaps the ${other}`);
    }
    for (const [key, r] of Object.entries(boxes)) {
      if (r.top < -1 || r.bottom > window.innerHeight + 1) {
        out.push(
          `${key} outside the viewport (top=${Math.round(r.top)}, bottom=${Math.round(r.bottom)})`,
        );
      }
    }
    return out;
  });
  for (const m of problems) note('layout', `${name}: ${m}`);
}

async function checkOverflow(page, name) {
  const overflow = await page.evaluate(() => {
    const bad = [];
    const docOver = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (docOver > 1) bad.push(`document overflows by ${docOver}px`);
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 2 && r.width > 24 && el.checkVisibility?.()) {
        const cls = (el.className && String(el.className).slice(0, 60)) || el.tagName;
        bad.push(`${cls} right=${Math.round(r.right)}`);
        if (bad.length > 4) break;
      }
    }
    return bad;
  });
  // Reader pagination intentionally lays columns beyond the viewport inside
  // an overflow-hidden container; only report document-level overflow.
  const docLevel = overflow.filter((o) => o.startsWith('document'));
  if (docLevel.length) note('overflow', `${name}: ${docLevel.join('; ')}`);
}

async function run() {
  const browser = await chromium.launch({
    executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH || undefined,
  });

  const widths = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'iphone', width: 390, height: 844, mobile: true },
    { name: 'narrow', width: 320, height: 680, mobile: true },
  ];

  for (const vp of widths) {
    console.log(`\n== ${vp.name} (${vp.width}x${vp.height}) ==`);
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.mobile ? 2 : 1,
      isMobile: vp.mobile ?? false,
      hasTouch: vp.mobile ?? false,
    });
    const page = await context.newPage();
    page.on('console', (m) => {
      // A 401 before login (session probe) is expected, not a defect.
      if (m.type() === 'error' && !m.text().includes('status of 401')) {
        note('console', `${vp.name}: ${m.text().slice(0, 200)}`);
      }
    });
    page.on('pageerror', (e) => note('pageerror', `${vp.name}: ${String(e).slice(0, 200)}`));

    // --- first-run setup (bootstrap token) or login ---
    await page.goto(BASE, { waitUntil: 'networkidle' });
    if (
      await page
        .locator('#su-user')
        .isVisible()
        .catch(() => false)
    ) {
      await shot(page, `${vp.name}-00-setup`);
      await page.fill('#su-token', SETUP_TOKEN);
      await page.fill('#su-user', USER);
      await page.fill('#su-pass', PASS);
      await page.fill('#su-confirm', PASS);
      await page.click('button[type=submit]');
      await page.waitForSelector('.book-grid, .empty-state', { timeout: 15000 });
      // Wait for the initial scan/index/pair/align pipeline to finish — the
      // sweep needs a SWITCHABLE pair, so poll for exactly that (a fixed
      // sleep is flaky on a cold start).
      let pipelineReady = false;
      for (let i = 0; i < 90 && !pipelineReady; i++) {
        pipelineReady = await page
          .evaluate(async () => {
            try {
              const res = await fetch('/api/pairs', {
                credentials: 'same-origin',
                headers: { 'x-rp-csrf': '1' },
              });
              if (!res.ok) return false;
              const { pairs } = await res.json();
              return pairs.some((p) => p.switchable);
            } catch {
              return false;
            }
          })
          .catch(() => false);
        if (!pipelineReady) await page.waitForTimeout(1000);
      }
      if (!pipelineReady) note('logic', 'initial align pipeline did not finish within 90s');
      await page.goto(BASE, { waitUntil: 'networkidle' });
    }
    if (
      await page
        .locator('#li-user')
        .isVisible()
        .catch(() => false)
    ) {
      await shot(page, `${vp.name}-01-login`);
      await page.fill('#li-user', USER);
      await page.fill('#li-pass', PASS);
      await page.click('button[type=submit]');
      await page.waitForSelector('.book-grid, .empty-state', { timeout: 10000 });
    }

    // --- library ---
    await page.waitForSelector('.book-card', { timeout: 10000 });
    await page.waitForTimeout(400);
    await shot(page, `${vp.name}-02-library`);
    await checkOverflow(page, `${vp.name} library`);
    // Cover badges must not obscure placeholder cover titles.
    const badgeClash = await page.evaluate(() => {
      const out = [];
      for (const wrap of document.querySelectorAll('.book-card__coverwrap')) {
        const badges = wrap.querySelector('.book-card__badges');
        const title = wrap.querySelector('.book-card__fallback > span');
        if (!badges || !title) continue;
        const b = badges.getBoundingClientRect();
        const t = title.getBoundingClientRect();
        const overlap =
          Math.min(b.bottom, t.bottom) - Math.max(b.top, t.top) > 1 &&
          Math.min(b.right, t.right) - Math.max(b.left, t.left) > 1;
        if (overlap) out.push(title.textContent?.trim().slice(0, 40) ?? '?');
      }
      return out.slice(0, 3);
    });
    for (const t of badgeClash) note('layout', `${vp.name}: badge overlaps cover title "${t}"`);

    // Search filter
    await page.fill('input[type=search]', 'lantern');
    await page.waitForTimeout(500);
    const cardCount = await page.locator('.book-card').count();
    if (cardCount !== 2)
      note('logic', `${vp.name}: search "lantern" returned ${cardCount} cards, expected 2`);
    await page.fill('input[type=search]', '');
    await page.waitForTimeout(400);

    // --- book detail (ebook) ---
    await page.click('.book-card:has-text("The Lantern of Ash Harbor"):has-text("EPUB")');
    await page.waitForSelector('.book-hero');
    await page.waitForTimeout(300);
    await shot(page, `${vp.name}-03-book-detail`);
    await checkOverflow(page, `${vp.name} book detail`);

    // --- reader ---
    await page.click('a.btn:has-text("Read")');
    await page.waitForSelector('.reader-content', { timeout: 10000 });
    await page.waitForTimeout(700);
    await shot(page, `${vp.name}-04-reader`);
    await checkOverflow(page, `${vp.name} reader`);

    // page forward via keyboard, then tap zone
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(350);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(350);
    await shot(page, `${vp.name}-05-reader-paged`);

    // Resize regression: repagination must keep the reading position, and
    // must NOT write page-zero progress.
    const footerBefore = await page
      .locator('.reader-footer-row span')
      .first()
      .textContent()
      .catch(() => '');
    if (/Page [2-9]/.test(footerBefore ?? '')) {
      await page.setViewportSize({ width: vp.width - 64, height: vp.height - 40 });
      await page.waitForTimeout(600);
      const footerAfter = await page
        .locator('.reader-footer-row span')
        .first()
        .textContent()
        .catch(() => '');
      if (/^Page 1 of/.test((footerAfter ?? '').trim())) {
        note('logic', `${vp.name}: resize reset the reader to page 1 (was "${footerBefore}")`);
      }
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(500);
    }

    // Reader settings: theme + font size
    await page.click('button[aria-label="Reading settings"]');
    await page.waitForSelector('.sheet');
    await settle(page);
    await shot(page, `${vp.name}-06-reader-settings`);
    await checkSheetContainment(page, `${vp.name} reader settings sheet`);
    // Focus trap: Tab must cycle inside the open sheet.
    if (vp.name === 'desktop') {
      for (let i = 0; i < 14; i++) await page.keyboard.press('Tab');
      const inSheet = await page.evaluate(() => !!document.activeElement?.closest('.sheet'));
      if (!inSheet) note('a11y', 'focus escaped the settings sheet while tabbing');
      // Regression: when focus is the dialog CONTAINER itself (the initial
      // state), Shift+Tab must wrap to the LAST focusable control inside the
      // sheet — never escape into the page behind it.
      await page.evaluate(() => document.querySelector('.sheet')?.focus());
      await page.keyboard.press('Shift+Tab');
      const wrap = await page.evaluate(() => {
        const sheet = document.querySelector('.sheet');
        const active = document.activeElement;
        const focusables = sheet
          ? [
              ...sheet.querySelectorAll(
                'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
              ),
            ].filter((el) => el.offsetParent !== null)
          : [];
        return {
          inside: !!active?.closest('.sheet'),
          isLast: focusables.length > 0 && active === focusables[focusables.length - 1],
        };
      });
      if (!wrap.inside) note('a11y', 'Shift+Tab from the dialog container ESCAPED the sheet');
      else if (!wrap.isLast) {
        note('a11y', 'Shift+Tab from the dialog container did not wrap to the last control');
      } else console.log('  focus trap: container Shift+Tab wraps to last control');
    }
    await page.click('.sheet button.chip:has-text("Night")');
    await page.waitForTimeout(250);
    await page.click('.sheet button[aria-label=Close]');
    await page.waitForTimeout(300);
    await shot(page, `${vp.name}-07-reader-night`);
    // back to paper for later shots
    await page.click('button[aria-label="Reading settings"]');
    await page.click('.sheet button.chip:has-text("Paper")');
    await page.click('.sheet button[aria-label=Close]');

    // TOC
    await page.click('button[aria-label="Table of contents"]');
    await page.waitForSelector('.sheet');
    await settle(page);
    await shot(page, `${vp.name}-08-toc`);
    await checkSheetContainment(page, `${vp.name} toc sheet`);
    await page.click('.sheet .list-row:has-text("Fog Signals")');
    await page.waitForTimeout(600);

    // Search in book
    await page.click('button[aria-label="Search in book"]');
    await page.fill('.sheet input[type=search]', 'ledger');
    await page.click('.sheet button:has-text("Search")');
    await page.waitForTimeout(500);
    const matches = await page.locator('.sheet .list-row').count();
    if (matches < 2)
      note('logic', `${vp.name}: in-book search found ${matches} matches for "ledger"`);
    await settle(page);
    await shot(page, `${vp.name}-09-book-search`);
    await page.click('.sheet button[aria-label=Close]');

    // Scroll-mode lifecycle: pagehide INSIDE the 600ms scroll debounce must
    // persist the live viewport position, not the stale debounced one.
    if (vp.name === 'desktop') {
      const readerBookId = page.url().split('/read/')[1]?.split('?')[0];
      const progressOf = () =>
        page.evaluate(async (id) => {
          const res = await fetch(`/api/progress/${id}`, {
            credentials: 'same-origin',
            headers: { 'x-rp-csrf': '1' },
          });
          const data = await res.json();
          return data.state?.locator ?? null;
        }, readerBookId);
      await page.click('button[aria-label="Reading settings"]');
      await page.waitForSelector('.sheet');
      await page.click('.sheet button.chip:has-text("Continuous scroll")');
      await page.click('.sheet button[aria-label=Close]');
      // Short demo chapters: shrink the viewport so the chapter genuinely
      // scrolls, making the stale-vs-live distinction measurable.
      await page.setViewportSize({ width: vp.width, height: 380 });
      await page.waitForTimeout(700);
      const before = await progressOf();
      const scrolled = await page.evaluate(() => {
        const s = document.querySelector('.reader-scroller');
        if (!s || s.scrollHeight <= s.clientHeight + 120) return null;
        // Scroll deep into the chapter and fire pagehide IMMEDIATELY —
        // squarely inside the 600ms debounce window.
        s.scrollTop = s.scrollHeight - s.clientHeight;
        window.dispatchEvent(new Event('pagehide'));
        return s.scrollTop;
      });
      if (scrolled === null) {
        note('logic', 'scroll-lifecycle check could not run (chapter not scrollable)');
      } else {
        await page.waitForTimeout(1000); // keepalive flush lands server-side
        const after = await progressOf();
        const beforeOff = before?.charOffset ?? 0;
        const afterOff = after?.charOffset ?? 0;
        if (!(afterOff > beforeOff + 100)) {
          note(
            'logic',
            `pagehide inside the scroll debounce persisted a stale position (before=${beforeOff}, after=${afterOff})`,
          );
        } else {
          console.log(
            `  scroll-mode pagehide persisted the live position (${beforeOff} -> ${afterOff})`,
          );
        }
      }
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // Restore paginated mode and the pre-check position for the rest of
      // the sweep.
      await page.click('button[aria-label="Reading settings"]');
      await page.waitForSelector('.sheet');
      await page.click('.sheet button.chip:has-text("Pages")');
      await page.click('.sheet button[aria-label=Close]');
      await page.waitForTimeout(400);
      await page.click('button[aria-label="Table of contents"]');
      await page.waitForSelector('.sheet');
      await page.click('.sheet .list-row:has-text("Fog Signals")');
      await page.waitForTimeout(600);
    }

    // Switch to audio (the two-way switch, ebook -> audio)
    const listenBtn = page.locator('.immersive-chrome--bottom button:has-text("Listen")');
    if (await listenBtn.isEnabled().catch(() => false)) {
      await listenBtn.click();
      await page.waitForSelector('.player-page', { timeout: 10000 });
      await page.waitForTimeout(700);
      await settle(page);
      await shot(page, `${vp.name}-10-player-handoff`);
      await checkOverflow(page, `${vp.name} player`);
      await checkPlayerLayout(page, `${vp.name} player`);
    } else {
      note('logic', `${vp.name}: Listen switch button not enabled`);
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    }

    // --- player controls ---
    if (
      await page
        .locator('.play-btn')
        .isVisible()
        .catch(() => false)
    ) {
      // Handoff navigation autoplays; only press play if actually paused.
      await page.waitForTimeout(900);
      const wasPlaying = await page.evaluate(() => {
        const a = document.querySelector('audio');
        return a ? !a.paused : false;
      });
      if (!wasPlaying) await page.click('.play-btn');
      await page.waitForTimeout(1500);
      const playing = await page.evaluate(() => {
        const a = document.querySelector('audio');
        return a ? !a.paused && a.currentTime > 0 : false;
      });
      if (!playing) note('logic', `${vp.name}: audio did not start playing`);
      await page.click('button[aria-label="Forward 30 seconds"]');
      await page.waitForTimeout(400);
      await shot(page, `${vp.name}-11-player-playing`);
      // Chapters sheet
      await page.click('button.chip:has-text("Chapters")');
      await page.waitForSelector('.sheet');
      await settle(page);
      await shot(page, `${vp.name}-12-chapters`);
      await checkSheetContainment(page, `${vp.name} chapters sheet`);
      await page.click('.sheet button[aria-label=Close]');
      // Switch back to text (audio -> ebook)
      const readBtn = page.locator('button.chip:has-text("Read")');
      if (await readBtn.isEnabled().catch(() => false)) {
        await readBtn.click();
        await page.waitForSelector('.reader-content', { timeout: 10000 });
        await page.waitForTimeout(800);
        await shot(page, `${vp.name}-13-reader-handoff`);
      } else {
        note('logic', `${vp.name}: Read switch button not enabled`);
      }
    }

    // --- RTL Hebrew book ---
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.click('.book-card:has-text("אורות")');
    await page.waitForSelector('.book-hero');
    await page.click('a.btn:has-text("Read")');
    await page.waitForSelector('.reader-content', { timeout: 10000 });
    await page.waitForTimeout(600);
    const dir = await page.locator('.reader-viewport').getAttribute('dir');
    if (dir !== 'rtl') note('logic', `${vp.name}: Hebrew book viewport dir=${dir}, expected rtl`);
    await shot(page, `${vp.name}-14-reader-rtl`);

    // --- pairs ---
    await page.goto(`${BASE}/pairs`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.pair-card', { timeout: 10000 });
    await page.waitForTimeout(400);
    await shot(page, `${vp.name}-15-pairs`);
    await checkOverflow(page, `${vp.name} pairs`);
    if (vp.name === 'desktop') {
      // Honest labeling: no blanket "Exact switch ready"; instead a badge
      // carrying the sentence-exact coverage percentage.
      const overclaim = await page.locator('text="Exact switch ready"').count();
      if (overclaim > 0) note('logic', 'pairs page still shows the "Exact switch ready" overclaim');
      const honest = await page.locator('.badge:has-text("sentence-exact")').count();
      if (honest === 0) note('logic', 'pairs page missing the sentence-exact coverage badge');
      // Truthful state wording: a linked pair must not still claim it is
      // waiting for content verification (candidates keep that warning).
      const staleWaiting = await page
        .locator('section[aria-label="Linked pairs"] .pair-card', {
          hasText: 'awaits content verification',
        })
        .count();
      if (staleWaiting > 0) {
        note('logic', 'linked pair still shows the "awaits content verification" waiting note');
      }
      // Manual arbitrary pairing UI.
      const manualBtn = page.locator('button:has-text("Link two books manually")');
      if ((await manualBtn.count()) === 0) {
        note('logic', 'manual pair selector button missing');
      } else {
        await manualBtn.click();
        await page.waitForSelector('.sheet #ml-ebook');
        await settle(page);
        await shot(page, `${vp.name}-15b-manual-link`);
        await checkSheetContainment(page, `${vp.name} manual-link sheet`);
        await page.click('.sheet button[aria-label=Close]');
      }
    }

    // --- settings ---
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.settings-section');
    await shot(page, `${vp.name}-16-settings`);
    await checkOverflow(page, `${vp.name} settings`);

    // --- audio-only book page (m4b chapters) ---
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.click('.book-card:has-text("Clockmaker")');
    await page.waitForSelector('.book-hero');
    await shot(page, `${vp.name}-17-audiobook-detail`);

    await context.close();
  }

  // --- PWA checks (desktop context) ---
  console.log('\n== PWA ==');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const manifestOk = await page.evaluate(async () => {
    const link = document.querySelector('link[rel=manifest]');
    if (!link) return 'no manifest link';
    const res = await fetch(link.href);
    if (!res.ok) return `manifest ${res.status}`;
    const m = await res.json();
    if (m.display !== 'standalone') return 'not standalone';
    if (!m.icons || m.icons.length < 2) return 'missing icons';
    return 'ok';
  });
  if (manifestOk !== 'ok') note('pwa', `manifest: ${manifestOk}`);
  else console.log('  manifest ok');
  const swState = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      return reg.active ? 'active' : 'registered';
    } catch (e) {
      return `error: ${e}`;
    }
  });
  if (swState !== 'active' && swState !== 'registered') note('pwa', `service worker: ${swState}`);
  else console.log(`  service worker ${swState}`);

  // Pinch zoom must not be disabled (a11y).
  const viewportMeta = await page.evaluate(
    () => document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? '',
  );
  if (/user-scalable\s*=\s*no/.test(viewportMeta)) {
    note('a11y', 'viewport meta still sets user-scalable=no');
  }

  // Offline app-shell startup: after one online visit (SW installed the
  // build-time precache), a full offline navigation must boot the app.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800); // let install/precache settle
  await ctx.setOffline(true);
  await page.goto(BASE, { waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(1200);
  const shellBooted = await page.evaluate(() => {
    const root = document.querySelector('#root');
    return !!root && root.children.length > 0;
  });
  if (!shellBooted) note('pwa', 'offline app-shell startup failed (blank page offline)');
  else console.log('  offline app-shell startup works');
  await shot(page, 'pwa-17b-offline-shell');
  await ctx.setOffline(false);
  await page.goto(BASE, { waitUntil: 'networkidle' });

  // Login and exercise the offline download flow end-to-end.
  if (
    await page
      .locator('#li-user')
      .isVisible()
      .catch(() => false)
  ) {
    await page.fill('#li-user', USER);
    await page.fill('#li-pass', PASS);
    await page.click('button[type=submit]');
    await page.waitForSelector('.book-card');
  }
  await page.click('.book-card:has-text("The Lantern of Ash Harbor"):has-text("EPUB")');
  await page.waitForSelector('.book-hero');
  await page.click('button:has-text("Download")');
  await page.waitForSelector('button:has-text("Offline ·")', { timeout: 20000 }).catch(() => {
    note('pwa', 'offline download did not complete');
  });
  await shot(page, 'pwa-18-downloaded');
  // Simulate offline: chapter should come from Cache Storage via SW.
  await ctx.setOffline(true);
  await page
    .goto(`${BASE}/read/${page.url().split('/book/')[1]}`, { waitUntil: 'load' })
    .catch(() => {});
  await page.waitForTimeout(1200);
  const offlineReaderOk = await page
    .locator('.reader-content')
    .isVisible()
    .catch(() => false);
  if (!offlineReaderOk) note('pwa', 'offline reading failed (reader did not render offline)');
  else console.log('  offline reading works');
  await shot(page, 'pwa-19-offline-reader');
  await ctx.setOffline(false);

  // Offline audio: chunked download + service-worker Range playback.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('.book-card:has-text("Clockmaker")');
  await page.waitForSelector('.book-hero');
  await page.click('button:has-text("Download")');
  await page
    .waitForSelector('button:has-text("Offline ·")', { timeout: 30000 })
    .catch(() => note('pwa', 'audiobook offline download did not complete'));
  const audioBookId = page.url().split('/book/')[1];
  await ctx.setOffline(true);
  await page.goto(`${BASE}/listen/${audioBookId}`, { waitUntil: 'load' }).catch(() => {});
  await page.waitForSelector('.play-btn', { timeout: 8000 }).catch(() => {});
  const offlinePlays = await page
    .evaluate(async () => {
      const a = document.querySelector('audio');
      if (!a) return 'no-audio-element';
      try {
        await a.play();
      } catch (e) {
        return `play-failed: ${e}`;
      }
      await new Promise((r) => setTimeout(r, 1500));
      return a.currentTime > 0 ? 'ok' : 'no-progress';
    })
    .catch((e) => `eval-failed: ${e}`);
  if (offlinePlays !== 'ok') note('pwa', `offline audio playback: ${offlinePlays}`);
  else console.log('  offline audio playback works (SW Range/206)');
  await shot(page, 'pwa-20-offline-audio');
  await ctx.setOffline(false);

  // ONLINE REVOCATION fails closed: with downloads present and the app open,
  // server-side session loss (cookies cleared = revoked/expired) must purge
  // the offline cache and stop cache-first serving — not keep reading books.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await ctx.clearCookies();
  await page.goto(`${BASE}/book/${audioBookId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500); // 401 discovery + awaited purge
  const revoked = await page.evaluate(async () => {
    const loginVisible = !!document.querySelector('#li-user');
    const cacheGone = !(await caches.has('rp-offline-v1'));
    // Cache-first must no longer answer for book content: the request goes
    // to the network, which refuses it.
    let apiStatus = 0;
    try {
      const res = await fetch('/api/books', {
        credentials: 'same-origin',
        headers: { 'x-rp-csrf': '1' },
      });
      apiStatus = res.status;
    } catch {
      apiStatus = -1;
    }
    return { loginVisible, cacheGone, apiStatus };
  });
  if (!revoked.loginVisible) note('pwa', 'revoked session did not drop the open app to login');
  if (!revoked.cacheGone) {
    note('pwa', 'revoked session left the offline cache bucket in place (revocation not closed)');
  }
  if (revoked.apiStatus !== 401) {
    note('pwa', `revoked session still got API content (status ${revoked.apiStatus})`);
  }
  if (revoked.loginVisible && revoked.cacheGone && revoked.apiStatus === 401) {
    console.log('  online revocation fails closed (cache purged, app at login)');
  }
  await ctx.close();

  await browser.close();

  console.log(`\n${shots.length} screenshots -> ${outDir}`);
  if (issues.length === 0) console.log('QA: no issues found');
  else {
    console.log(`QA: ${issues.length} issue(s):`);
    for (const i of issues) console.log(` - [${i.kind}] ${i.msg}`);
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
