/**
 * Browser smoke test for mock mode (real Chromium via the Edge/Chrome already installed on the machine).
 *
 *   npm run dev:mock            # terminal 1
 *   npm run smoke               # terminal 2   (SMOKE_URL, SMOKE_OUT, --only=flow1,flow2 are optional)
 *
 * It signs in, runs the morning flow, goes offline, plays a sample through the mock WebSocket, drives the microphone path with a
 * fake capture device, approves a form, syncs, and visits every page at tablet widths. It records console errors, uncaught
 * exceptions, failed requests and horizontal overflow, and saves screenshots to smoke-output/ for a visual check.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE = (process.env.SMOKE_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '');
const OUT = path.resolve(process.env.SMOKE_OUT ?? 'smoke-output');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const wanted = (name) => ONLY.length === 0 || ONLY.includes(name);

const problems = [];
const failures = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const log = (line) => console.log(line);

async function launch() {
  const errors = [];
  for (const channel of ['msedge', 'chrome']) {
    try {
      return await chromium.launch({
        channel,
        headless: true,
        args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
      });
    } catch (e) {
      errors.push(`${channel}: ${String(e.message).split('\n')[0]}`);
    }
  }
  throw new Error(`No Chromium-based browser could be launched.\n${errors.join('\n')}`);
}

async function newPage(browser, label, width, height, options = {}) {
  const context = await browser.newContext({ viewport: { width, height }, permissions: ['microphone'], ...options });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120_000); // the first dev-server load transforms every module on demand
  page.setDefaultTimeout(30_000);
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push({ where: label, kind: `console.${m.type()}`, text: m.text().slice(0, 400), url: m.location().url });
  });
  page.on('pageerror', (e) => problems.push({ where: label, kind: 'pageerror', text: String(e.stack ?? e).slice(0, 600) }));
  page.on('requestfailed', (r) => problems.push({ where: label, kind: 'requestfailed', text: `${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}` }));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push({ where: label, kind: `http ${r.status()}`, text: r.url() });
  });
  return { context, page, label };
}

async function shot(ctx, name) {
  const file = path.join(OUT, `${ctx.label}-${slug(name)}.png`);
  await ctx.page.screenshot({ path: file });
  return file;
}

async function step(ctx, name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    log(`  ok    ${ctx.label} / ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    const message = String(e.message ?? e).split('\n').slice(0, 3).join(' | ');
    failures.push({ where: `${ctx.label} / ${name}`, message });
    log(`  FAIL  ${ctx.label} / ${name}: ${message}`);
    try {
      await shot(ctx, `FAIL-${name}`);
    } catch {
      /* page may be gone */
    }
  }
}

const go = (page, hash) => page.evaluate((h) => void (window.location.hash = h), hash);
const text = (page, t, timeout = 15_000) => page.getByText(t).first().waitFor({ state: 'visible', timeout });
const button = (page, name, options = {}) => page.getByRole('button', { name, ...options });

async function overflow(ctx, name) {
  const info = await ctx.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bw: document.body.scrollWidth }));
  if (info.sw > info.iw + 1 || info.bw > info.iw + 1) throw new Error(`horizontal overflow on ${name}: scrollWidth ${info.sw} > viewport ${info.iw}`);
}

async function smallTargets(ctx, min) {
  const small = await ctx.page.evaluate((limit) => {
    const out = [];
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]):not(.sr-only), select, textarea, [role=radio], [role=tab], [role=switch]')) {
      const r = (el.matches('input[type=checkbox], input[type=radio]') ? (el.closest('label') ?? el) : el).getBoundingClientRect();
      const style = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || el.closest('[aria-hidden=true]')) continue;
      if (el.classList.contains('sr-only')) continue;
      if (r.height < limit) out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  }, min);
  return small;
}

// ---- Flow 1: the worker's day -----------------------------------------------------------------------------------------

async function flowDay(browser) {
  const ctx = await newPage(browser, 'day', 1366, 768);
  const { page } = ctx;
  await page.goto(`${BASE}/#/morning`, { waitUntil: 'networkidle' });

  await step(ctx, 'morning sign-in', async () => {
    const workers = page.getByRole('radiogroup', { name: 'Who is working today?' }).getByRole('radio');
    await workers.first().waitFor({ timeout: 60_000 });
    await workers.first().click();
    for (const d of ['1', '2', '3', '4']) await button(page, d, { exact: true }).click();
    await shot(ctx, 'morning-pin');
    await button(page, 'Sign in').click();
    await text(page, 'Sign out / switch worker');
  });

  await step(ctx, 'morning start my day (live steps)', async () => {
    await button(page, /Start my day/).click();
    await sleep(2500);
    await shot(ctx, 'morning-running');
    await page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => /^\s*Go offline/.test(b.textContent ?? '') && !b.disabled),
      null,
      { timeout: 120_000 },
    );
    await shot(ctx, 'morning-ready');
  });

  await step(ctx, 'go offline -> today + banner', async () => {
    await button(page, /^\s*Go offline/).click();
    await page.waitForFunction(() => window.location.hash === '#/' || window.location.hash === '' || window.location.hash === '#', null, { timeout: 15_000 });
    await text(page, 'Offline - working from local data');
    await page.getByRole('radio', { name: 'All', exact: true }).click();
    await page.locator('a[href*="/jobs/"]').first().waitFor({ timeout: 15_000 });
    await sleep(300);
    const n = await page.locator('a[href*="/jobs/"]').count();
    if (n !== 6) throw new Error(`expected 6 work-order cards under "All", found ${n}`);
    await page.getByRole('radio', { name: 'To do', exact: true }).click();
    await shot(ctx, 'today-offline');
    await sleep(600);
    const banner = await page.evaluate(() => [...document.querySelectorAll('[role=status]')].some((e) => /Offline - working from local data/.test(e.textContent ?? '') && e.getBoundingClientRect().height > 20));
    if (!banner) throw new Error('offline banner is not visible after going offline');
  });

  await step(ctx, 'today search + filter', async () => {
    await page.getByLabel('Search work orders').fill('pole 123');
    await sleep(300);
    const n = await page.locator('a[href*="/jobs/"]').count();
    if (n < 1 || n > 3) throw new Error(`search "pole 123" returned ${n} cards`);
    await page.getByLabel('Search work orders').fill('');
  });

  await step(ctx, 'job page layout', async () => {
    await page.locator('a[href*="/jobs/WO-1001"]').first().click();
    await text(page, 'Voice');
    await button(page, /Play sample/).waitFor({ timeout: 15_000 });
    await shot(ctx, 'job-empty');
    await overflow(ctx, 'job');
  });

  await step(ctx, 'play sample: progressive fill + waterfall', async () => {
    await button(page, /Play sample/).click();
    await sleep(1800);
    await shot(ctx, 'job-streaming');
    await page.getByText('Last extraction').first().waitFor({ timeout: 60_000 });
    await sleep(500);
    await shot(ctx, 'job-extracted');
    await text(page, 'Required fields complete', 5_000).catch(() => undefined);
  });

  await step(ctx, 'evidence highlight on hover', async () => {
    const rows = page.locator('[data-field]');
    const n = await rows.count();
    if (n === 0) throw new Error('no [data-field] rows rendered');
    let highlighted = false;
    for (let i = 0; i < n && !highlighted; i++) {
      await rows.nth(i).hover();
      await sleep(150);
      highlighted = (await page.locator('mark').count()) > 0;
    }
    if (!highlighted) throw new Error('hovering fields never highlighted evidence in the transcript');
    await shot(ctx, 'job-evidence');
  });

  await step(ctx, 'why popover', async () => {
    const why = page.getByRole('button', { name: /^Why .* has this value/ }).first();
    await why.click();
    await sleep(200);
    await shot(ctx, 'job-why');
    await page.keyboard.press('Escape');
  });

  await step(ctx, 'approve & save locally (offline)', async () => {
    await page.getByRole('button', { name: /Approve & save locally/ }).scrollIntoViewIfNeeded();
    await button(page, /Approve & save locally/).click();
    const anyway = button(page, /Approve anyway/);
    if (await anyway.isVisible().catch(() => false)) await anyway.click();
    else await sleep(300);
    if (await anyway.isVisible().catch(() => false)) await anyway.click();
    await text(page, 'Queued for sync', 15_000);
    await shot(ctx, 'job-approved');
  });

  await step(ctx, 'sync page (offline): outbox + dispatcher console', async () => {
    await go(page, '#/sync');
    await text(page, 'Dispatcher console');
    await sleep(600);
    await shot(ctx, 'sync-offline');
    const disabled = await button(page, /Sync now/).isDisabled();
    if (!disabled) throw new Error('"Sync now" must be disabled while offline');
    await overflow(ctx, 'sync');
  });

  await step(ctx, 'go online + sync now', async () => {
    await page.getByRole('radio', { name: /Online/ }).first().click();
    await sleep(800);
    await button(page, /Sync now/).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /Sync now/.test(b.textContent ?? '') && !b.disabled), null, { timeout: 10_000 });
    await button(page, /Sync now/).click();
    await sleep(2500);
    await shot(ctx, 'sync-after');
  });

  await step(ctx, 'conflict dialog', async () => {
    const open = page.getByRole('button', { name: /Resolve/ }).first();
    if (!(await open.isVisible().catch(() => false))) throw new Error('no "Resolve" button for the seeded conflict');
    await open.click();
    await sleep(400);
    await shot(ctx, 'sync-conflict');
    await button(page, /Keep mine|keep mine/).first().waitFor({ timeout: 5_000 });
    await page.keyboard.press('Escape');
  });

  await step(ctx, 'dispatcher: fault + bump dialogs', async () => {
    await page.getByRole('button', { name: /Bump version/ }).first().click();
    await sleep(300);
    await shot(ctx, 'sync-bump');
    await page.keyboard.press('Escape');
  });

  await ctx.context.close();
}

// ---- Flow 2: microphone path (fake capture device) + press and hold ---------------------------------------------------------

async function flowMic(browser) {
  const ctx = await newPage(browser, 'mic', 1366, 768);
  const { page } = ctx;
  await page.goto(`${BASE}/#/morning`, { waitUntil: 'networkidle' });
  await step(ctx, 'skip morning via demo menu', async () => {
    await page.getByRole('button', { name: /Demo data/ }).click();
    await page.getByRole('menuitem', { name: /Skip morning/ }).click();
    await go(page, '#/jobs/WO-1001');
    await button(page, /Start recording/).waitFor({ timeout: 15_000 });
  });
  await step(ctx, 'tap to record -> live partials -> stop -> result', async () => {
    await button(page, /Start recording/).click();
    await text(page, /Listening/, 10_000);
    await sleep(1500);
    await shot(ctx, 'mic-listening');
    await button(page, /Stop recording/).click();
    await page.getByText('Last extraction').first().waitFor({ timeout: 60_000 });
    await shot(ctx, 'mic-result');
  });
  await step(ctx, 'press and hold to talk', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Demo data/ }).click();
    await page.getByRole('menuitem', { name: /Skip morning/ }).click();
    await go(page, '#/jobs/WO-1002');
    const rec = button(page, /Start recording/);
    await rec.waitFor({ timeout: 15_000 });
    const box = await rec.boundingBox();
    if (!box) throw new Error('no record button box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await sleep(1400);
    await text(page, /Listening/, 5_000);
    await page.mouse.up();
    await page.getByText('Last extraction').first().waitFor({ timeout: 60_000 });
  });
  await ctx.context.close();
}

// ---- Flow 3: every page at tablet widths --------------------------------------------------------------------------------------

const ROUTES = [
  ['today', '#/'],
  ['morning', '#/morning'],
  ['job', '#/jobs/WO-1001'],
  ['sync', '#/sync'],
  ['lab', '#/lab'],
  ['results-datasets', '#/results'],
  ['results-runs', '#/results/runs'],
  ['results-run', '#/results/runs/run-0001'],
  ['models', '#/models'],
  ['about', '#/about'],
];

async function flowRoutes(browser) {
  for (const [width, height] of [
    [768, 1024],
    [1024, 768],
    [1366, 768],
  ]) {
    const ctx = await newPage(browser, `w${width}`, width, height, { hasTouch: width <= 1024 });
    const { page } = ctx;
    await page.goto(`${BASE}/#/morning`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Demo data/ }).click();
    await page.getByRole('menuitem', { name: /Skip morning/ }).click();
    await sleep(500);
    for (const [name, hash] of ROUTES) {
      await step(ctx, `route ${name}`, async () => {
        await go(page, hash);
        await page.waitForLoadState('networkidle');
        await sleep(name.startsWith('results-run') && name !== 'results-runs' ? 2500 : 900);
        await shot(ctx, name);
        await overflow(ctx, name);
      });
    }
    await ctx.context.close();
  }
}

// ---- Flow 4: Field mode -------------------------------------------------------------------------------------------------------

async function flowFieldMode(browser) {
  const ctx = await newPage(browser, 'field', 1024, 768, { hasTouch: true });
  const { page } = ctx;
  await page.goto(`${BASE}/#/morning`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Demo data/ }).click();
  await page.getByRole('menuitem', { name: /Skip morning/ }).click();
  await step(ctx, 'field mode on: job page', async () => {
    await go(page, '#/jobs/WO-1001');
    await button(page, /Play sample/).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: /Field mode/ }).click();
    await sleep(400);
    const on = await page.evaluate(() => document.documentElement.dataset.fieldMode);
    if (on !== 'on') throw new Error(`data-field-mode is "${on}"`);
    await button(page, /Play sample/).click();
    await page.getByText('Last extraction').first().waitFor({ timeout: 60_000 });
    await shot(ctx, 'job-field-mode');
    const small = await smallTargets(ctx, 44);
    if (small.length > 0) throw new Error(`${small.length} touch targets below 44px in Field mode: ${small.slice(0, 8).join('; ')}`);
  });
  await step(ctx, 'field mode persists across reload', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    const on = await page.evaluate(() => document.documentElement.dataset.fieldMode);
    if (on !== 'on') throw new Error('Field mode did not persist in localStorage');
  });
  await ctx.context.close();
}

// ---- Flow 5: Lab and Results interactions ----------------------------------------------------------------------------------

async function flowLabResults(browser) {
  const ctx = await newPage(browser, 'lab', 1366, 768);
  const { page } = ctx;
  await page.goto(`${BASE}/#/morning`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Demo data/ }).click();
  await page.getByRole('menuitem', { name: /Skip morning/ }).click();

  await step(ctx, 'lab: preset + compare', async () => {
    await go(page, '#/lab');
    await text(page, /Presets/);
    await button(page, /Baseline vs hybrid/).click();
    await sleep(300);
    await shot(ctx, 'lab-builder');
    await button(page, /^\s*Compare \d+/).click();
    await page.waitForFunction(() => document.body.innerText.includes('silent-wrong') || document.body.innerText.includes('Silent-wrong'), null, { timeout: 90_000 });
    await sleep(800);
    await shot(ctx, 'lab-results');
  });

  await step(ctx, 'results: run detail, pareto, decision, drill-down', async () => {
    await go(page, '#/results/runs/run-0001');
    await text(page, /Pareto/i, 30_000);
    await sleep(1500);
    await shot(ctx, 'run-detail-top');
    await page.evaluate(() => window.scrollTo(0, 900));
    await sleep(500);
    await shot(ctx, 'run-detail-mid');
    await page.evaluate(() => window.scrollTo(0, 99999));
    await sleep(500);
    await shot(ctx, 'run-detail-bottom');
  });

  await step(ctx, 'models: prepare a model', async () => {
    await go(page, '#/models');
    await text(page, /Whisper small/i, 15_000);
    await shot(ctx, 'models');
    const prep = page.getByRole('button', { name: /^\s*Prepare/ }).first();
    if (await prep.isVisible().catch(() => false)) {
      await prep.click();
      await sleep(1200);
      await shot(ctx, 'models-preparing');
    }
  });
  await ctx.context.close();
}

// ---- main -----------------------------------------------------------------------------------------------------------------------

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const browser = await launch();
log(`Browser ${browser.version()} -> ${BASE}`);
const t0 = Date.now();
try {
  if (wanted('day')) await flowDay(browser);
  if (wanted('mic')) await flowMic(browser);
  if (wanted('routes')) await flowRoutes(browser);
  if (wanted('field')) await flowFieldMode(browser);
  if (wanted('lab')) await flowLabResults(browser);
} finally {
  await browser.close();
}

const seen = new Set();
const unique = problems.filter((p) => {
  const k = `${p.where}|${p.kind}|${p.text}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
log(`\n${failures.length} failed step(s), ${unique.length} console/network problem(s) in ${((Date.now() - t0) / 1000).toFixed(0)} s. Screenshots: ${OUT}`);
for (const f of failures) log(`  FAIL ${f.where}: ${f.message}`);
for (const p of unique) log(`  ${p.kind} [${p.where}] ${p.text}`);
process.exit(failures.length + unique.length > 0 ? 1 : 0);
