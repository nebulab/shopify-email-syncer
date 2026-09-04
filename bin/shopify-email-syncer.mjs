#!/usr/bin/env node
/**
 * shopify-email-syncer — sync local notification-email templates into a
 * Shopify store's Admin.
 *
 * Shopify exposes no API for notification template bodies, so this drives the
 * Admin editor (admin.shopify.com/store/<store>/email_templates/<handle>/edit)
 * with Playwright: replaces the "Email body (HTML)" editor content with the
 * local file, fills "Email subject" from the `Subject:` line of the file's
 * {% comment %} header, and clicks Save.
 *
 * Run with --help for usage.
 */

import { access, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

const VERSION = '0.1.0';

const HELP = `shopify-email-syncer v${VERSION}

Push local Shopify notification-email templates (Liquid files) into a store's
Admin editor with Playwright. Idempotent: templates whose Admin body and
subject already match the local files are skipped, so --dry-run doubles as a
drift checker.

USAGE
  shopify-email-syncer --store <handle> --templates <dir> [options]

REQUIRED
  --store <handle>      Admin store handle: the part after /store/ in
                        admin.shopify.com/store/<handle>.
  --templates <dir>     Directory containing the .liquid template files.

OPTIONS
  --map <file>          JSON file mapping Admin template handles to file names
                        (relative to the templates dir), e.g.
                        {"order_confirmation": "order-confirmation.liquid"}.
                        Default: <templates>/templates.json if it exists;
                        otherwise handles are derived from file names
                        (order-confirmation.liquid -> order_confirmation).
  --only a,b,c          Limit to these template handles or file names.
  --dry-run             Read + compare only; never edits, never saves.
  --send-test           After processing each template, trigger Admin's
                        "Send test email" (goes to the logged-in staff
                        account). Under --dry-run this sends whatever is
                        currently SAVED, not the local copy.
  --profile <dir>       Chrome profile directory used to keep the Admin
                        session between runs.
                        Default: ~/.shopify-email-syncer/chrome-profile
  --help                Show this help.
  --version             Show the version.

TEMPLATE FILES
  The whole file is pasted as the email body. The subject is parsed from a
  "Subject:" line inside the file's leading {% comment %} block:

    {% comment %}
      Subject: Order {% raw %}{{ name }}{% endraw %} confirmed
    {% endcomment %}

  {% raw %} tags around Liquid in the subject are stripped before pasting
  (they exist so the header comment survives body rendering). A file without
  a Subject: line gets its body pasted and its subject left untouched.

FIRST RUN
  Opens a headed Google Chrome: log in to the Shopify Admin by hand
  (email/2FA). The session is kept in the profile directory, so later runs
  reuse it. Requires Google Chrome installed; no browser download is needed.

EXIT STATUS
  0 when every selected template was processed (and every requested test
  email sent); 1 otherwise.
`;

// --- CLI ---------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};

if (flag('help') !== null) {
  console.log(HELP);
  process.exit(0);
}
if (flag('version') !== null) {
  console.log(VERSION);
  process.exit(0);
}

const store = flag('store');
const templatesArg = flag('templates');
const mapArg = flag('map');
const dryRun = flag('dry-run') !== null;
const sendTest = flag('send-test') !== null;
const only = flag('only');
const profileArg = flag('profile');

if (!store || store === true) {
  console.error('Missing required --store <handle> (the part after /store/ in the Admin URL). See --help.');
  process.exit(1);
}
if (!templatesArg || templatesArg === true) {
  console.error('Missing required --templates <dir>. See --help.');
  process.exit(1);
}

const TEMPLATES_DIR = path.resolve(templatesArg);
const exists = (p) => access(p).then(() => true, () => false);

if (!(await exists(TEMPLATES_DIR))) {
  console.error(`Templates directory not found: ${TEMPLATES_DIR}`);
  process.exit(1);
}

// --- handle -> file mapping --------------------------------------------

// Explicit map (--map, or <templates>/templates.json), else derived from the
// file names: Shopify handles never contain hyphens, so kebab-case file names
// translate 1:1 (order-confirmation.liquid -> order_confirmation).
async function loadMapping() {
  let mapPath = null;
  if (mapArg && mapArg !== true) {
    mapPath = path.resolve(mapArg);
    if (!(await exists(mapPath))) {
      console.error(`Map file not found: ${mapPath}`);
      process.exit(1);
    }
  } else {
    const candidate = path.join(TEMPLATES_DIR, 'templates.json');
    if (await exists(candidate)) mapPath = candidate;
  }

  if (mapPath) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(mapPath, 'utf8'));
    } catch (err) {
      console.error(`Could not parse ${mapPath}: ${err.message}`);
      process.exit(1);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error(`${mapPath} must be a JSON object of {"<handle>": "<file.liquid>"}.`);
      process.exit(1);
    }
    for (const [handle, file] of Object.entries(parsed)) {
      if (typeof file !== 'string' || !file.endsWith('.liquid')) {
        console.error(`${mapPath}: entry "${handle}" must map to a .liquid file name, got: ${JSON.stringify(file)}`);
        process.exit(1);
      }
    }
    console.log(`Using handle map: ${mapPath} (${Object.keys(parsed).length} templates)`);
    return parsed;
  }

  const files = (await readdir(TEMPLATES_DIR)).filter((f) => f.endsWith('.liquid')).sort();
  if (!files.length) {
    console.error(`No .liquid files in ${TEMPLATES_DIR} and no templates.json map found.`);
    process.exit(1);
  }
  const mapping = {};
  for (const file of files) {
    mapping[file.replace(/\.liquid$/, '').replace(/-/g, '_')] = file;
  }
  return mapping;
}

const TEMPLATES = await loadMapping();

let handles = Object.keys(TEMPLATES);
if (only && only !== true) {
  const wanted = only.split(',').map((s) => s.trim());
  handles = handles.filter(
    (h) => wanted.includes(h) || wanted.includes(TEMPLATES[h]) || wanted.includes(TEMPLATES[h].replace(/\.liquid$/, '')),
  );
  const unknown = wanted.filter(
    (w) => !Object.keys(TEMPLATES).includes(w)
      && !Object.values(TEMPLATES).includes(w)
      && !Object.values(TEMPLATES).includes(`${w}.liquid`),
  );
  if (unknown.length) {
    console.error(`Unknown template(s) in --only: ${unknown.join(', ')}`);
    process.exit(1);
  }
}

// Catch missing files before the login dance, not per-template mid-run.
{
  const missing = [];
  for (const handle of handles) {
    if (!(await exists(path.join(TEMPLATES_DIR, TEMPLATES[handle])))) missing.push(TEMPLATES[handle]);
  }
  if (missing.length) {
    console.error(`Template file(s) not found in ${TEMPLATES_DIR}: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// --- Editor plumbing ---------------------------------------------------

// The body editor is CodeMirror 6 today (verified 2026-09); the other
// branches cover Ace/CM5/textarea in case Shopify swaps it again, and the
// keyboard path is the editor-agnostic last resort.
async function readEditor(page) {
  return page.evaluate(() => {
    const ace = document.querySelector('.ace_editor');
    if (ace && window.ace) return window.ace.edit(ace).getValue();
    const cm5 = document.querySelector('.CodeMirror');
    if (cm5 && cm5.CodeMirror) return cm5.CodeMirror.getValue();
    const cm6 = document.querySelector('.cm-content');
    if (cm6 && cm6.cmView) return cm6.cmView.view.state.doc.toString();
    const ta = document.querySelector('textarea[name*="body"], textarea[id*="body"], textarea');
    if (ta) return ta.value;
    return null;
  });
}

async function writeEditor(page, content) {
  const via = await page.evaluate((body) => {
    const ace = document.querySelector('.ace_editor');
    if (ace && window.ace) {
      const editor = window.ace.edit(ace);
      editor.setValue(body, -1);
      return 'ace';
    }
    const cm5 = document.querySelector('.CodeMirror');
    if (cm5 && cm5.CodeMirror) {
      cm5.CodeMirror.setValue(body);
      return 'codemirror5';
    }
    const cm6 = document.querySelector('.cm-content');
    if (cm6 && cm6.cmView) {
      const view = cm6.cmView.view;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: body } });
      return 'codemirror6';
    }
    const ta = document.querySelector('textarea[name*="body"], textarea[id*="body"], textarea');
    if (ta) {
      // go through the native setter + input event so React notices
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, body);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return 'textarea';
    }
    return null;
  }, content);
  if (via) return via;

  // Fallback: drive it like a user. Slower but editor-agnostic.
  const editor = page.locator('.ace_editor, .CodeMirror, .cm-content, textarea').first();
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await page.keyboard.insertText(content);
  return 'keyboard';
}

async function save(page) {
  const saveButton = page.getByRole('button', { name: /^(save|salva)$/i }).first();
  await saveButton.click();
  // The contextual save bar retracting is Shopify's own "persisted" signal —
  // a bar that never retracts (validation error, dead session) is a failure,
  // not something to shrug off.
  await saveButton.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {
    throw new Error('save bar did not retract within 30s — the save likely failed');
  });
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
}

const normalize = (s) => (s ?? '').replace(/\r\n/g, '\n').trim();

// Poll until the editor has hydrated its content — multi-thousand-line
// templates take well over the first paint, and longer still on a cold
// Chrome. Returns '' if it never hydrates.
async function readEditorStable(page) {
  await page
    .locator('.ace_editor, .CodeMirror, .cm-content, textarea')
    .first()
    .waitFor({ timeout: 30_000 });
  let content = '';
  for (let tries = 0; tries < 120 && !content; tries++) {
    await page.waitForTimeout(500);
    content = normalize(await readEditor(page));
  }
  return content;
}

// The Subject: line from a template's {% comment %} header — the string a
// human would otherwise re-type into the Admin subject field. {% raw %} tags
// are stripped: they exist so the header comment survives body rendering and
// were never part of the subject (pasting them verbatim would suppress the
// Liquid the subject is meant to interpolate).
function parseSubject(fileContent) {
  const header = fileContent.split('{% endcomment %}')[0] ?? '';
  const match = header.match(/^\s*Subject:\s*(.+)\s*$/m);
  return match ? match[1].replace(/\{%-?\s*(end)?raw\s*-?%\}/g, '').trim() : null;
}

// Resolve the "Email subject" input, insisting on exactly one match: fill and
// readback use the same locator, so a wrong-but-consistent resolution would
// silently agree with itself while clobbering some other field.
async function subjectField(page) {
  const field = page
    .locator('input[name*="title" i], input[name*="subject" i], input[id*="subject" i]')
    .or(page.getByLabel(/email subject|oggetto/i));
  const n = await field.count();
  if (n !== 1) throw new Error(`subject field ambiguous (${n} matches) — the selector needs updating`);
  return field;
}

// Trigger Admin's "Send test email" for the template open on `page`.
// It emails the logged-in staff account. Renders the last SAVED body —
// which is why this runs only after save() (or on an unchanged template).
async function sendTestEmail(page) {
  const namePattern = /send test|invia.*prova|email di prova/i;
  // "Send test email" lives inside the Preview modal (verified 2026-09) —
  // open Preview unless the button is already visible (e.g. the modal is
  // still open from a previous check).
  let trigger = page.getByRole('button', { name: namePattern }).first();
  if (!(await trigger.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /preview|anteprima/i }).first().click();
    trigger = page.getByRole('button', { name: namePattern }).first();
  }
  await trigger.waitFor({ state: 'visible', timeout: 15_000 });
  await trigger.click();
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  // Close the preview modal so the next action starts from the editor.
  const close = page.getByRole('button', { name: /^(close|chiudi)$/i }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
}

// --- Main --------------------------------------------------------------

const profileDir = profileArg && profileArg !== true
  ? path.resolve(profileArg)
  : path.join(os.homedir(), '.shopify-email-syncer', 'chrome-profile');

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  channel: 'chrome', // use installed Google Chrome; no browser download needed
  viewport: { width: 1440, height: 900 },
});
const page = context.pages()[0] ?? (await context.newPage());

// Login gate: land on the store home and wait until the session is real.
console.log(`Opening admin for ${store} — log in in the browser window if asked.`);
await page.goto(`https://admin.shopify.com/store/${store}`, { waitUntil: 'domcontentloaded' });
try {
  await page.waitForURL(new RegExp(`admin\\.shopify\\.com/store/${store}`), { timeout: 900_000 });
} catch {
  console.error(`Never reached admin.shopify.com/store/${store} — wrong --store handle, or the login was not completed. Current URL: ${page.url()}`);
  await context.close();
  process.exit(1);
}
console.log('Session OK.\n');

const results = { updated: [], skipped: [], failed: [], testsSent: [], testsFailed: [] };

async function maybeSendTest(label, handle) {
  if (!sendTest) return;
  try {
    await sendTestEmail(page);
    console.log(`  ✉ ${label}: test email sent to the logged-in staff account`);
    results.testsSent.push(handle);
  } catch (err) {
    console.error(`  ✉ ${label}: test send FAILED — ${err.message}`);
    results.testsFailed.push(handle);
  }
}

async function processTemplate(handle, file, label) {
  const raw = await readFile(path.join(TEMPLATES_DIR, file), 'utf8');
  const body = normalize(raw);
  const subject = parseSubject(raw);
  if (subject === null) console.warn(`  ⚠ ${label}: no "Subject:" line in the {% comment %} header — subject left untouched`);
  await page.goto(`https://admin.shopify.com/store/${store}/email_templates/${handle}/edit`, {
    waitUntil: 'domcontentloaded',
  });
  // An Admin body is never genuinely empty (Shopify always ships a
  // default), so empty-after-poll means we couldn't read the editor: fail
  // the template rather than misreport it as "differs" and blind-write
  // over a body we never saw.
  let current;
  try {
    current = await readEditorStable(page);
  } catch {
    throw new Error(`no body editor on the page — is "${handle}" a valid notification template handle on this store?`);
  }
  if (!current) throw new Error('editor content never hydrated (60s) — retry this handle');

  const currentSubject = subject === null ? null : normalize(await (await subjectField(page)).inputValue());
  const bodyDiffers = current !== body;
  const subjectDiffers = subject !== null && currentSubject !== subject;

  if (!bodyDiffers && !subjectDiffers) {
    console.log(`= ${label}: already current, skipped`);
    results.skipped.push(handle);
    await maybeSendTest(label, handle);
    return;
  }

  const parts = [
    bodyDiffers && `body (admin ${current.length} vs local ${body.length} chars)`,
    subjectDiffers && `subject ("${currentSubject}" → "${subject}")`,
  ].filter(Boolean).join(' + ');

  if (dryRun) {
    console.log(`~ ${label}: DIFFERS — would update ${parts}`);
    results.updated.push(handle);
    await maybeSendTest(label, handle); // sends the currently SAVED (old) template
    return;
  }

  if (subjectDiffers) await (await subjectField(page)).fill(subject);
  const via = bodyDiffers ? await writeEditor(page, body) : null;
  // Let the page's form state absorb the programmatic edits before saving:
  // clicking Save in the same tick can submit stale state — observed in the
  // wild, with Shopify toasting "Notification template saved" while
  // persisting the OLD body+subject.
  await page.waitForTimeout(1500);
  await save(page);

  // Prove SERVER state: reload and re-read. The in-page editor still holds
  // whatever we wrote even when the save request failed, so reading it
  // without a reload would let a failed save report success.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const after = await readEditorStable(page);
  if (after !== body) throw new Error(`post-save body mismatch after reload${via ? ` (wrote via ${via})` : ''}`);
  if (subject !== null && normalize(await (await subjectField(page)).inputValue()) !== subject) {
    throw new Error('post-save subject mismatch after reload');
  }
  console.log(`+ ${label}: updated ${parts} & saved${via ? ` (via ${via})` : ''}`);
  results.updated.push(handle);
  await maybeSendTest(label, handle);
}

for (const handle of handles) {
  const file = TEMPLATES[handle];
  const label = `${handle} (${file})`;
  let failure = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await processTemplate(handle, file, label);
      failure = null;
      break;
    } catch (err) {
      failure = err;
      // A post-save mismatch (the save race) and an editor that never
      // hydrated (a cold Chrome painting a huge body) are both transient.
      // Nothing has been recorded for this handle yet (the throws precede
      // every results push), so one clean retry — fresh page load, fresh
      // comparison — is safe and usually heals it.
      if (attempt === 1 && /post-save|never hydrated/.test(err.message)) {
        console.warn(`  ↻ ${label}: ${err.message} — retrying once`);
        continue;
      }
      break;
    }
  }
  if (failure) {
    console.error(`! ${label}: FAILED — ${failure.message}`);
    results.failed.push(handle);
  }
}

console.log(`\n${dryRun ? 'Dry run' : 'Done'}: ${results.updated.length} ${dryRun ? 'differing' : 'updated'}, ${results.skipped.length} already current, ${results.failed.length} failed.`);
if (sendTest) console.log(`Test emails: ${results.testsSent.length} sent, ${results.testsFailed.length} failed — check the inbox of the logged-in staff account.`);
if (results.failed.length) console.log(`Failed: ${results.failed.join(', ')}`);
if (results.testsFailed.length) console.log(`Test send failed: ${results.testsFailed.join(', ')}`);
console.log('Subjects are parsed from each file\'s {% comment %} header and pasted along with the body.');

await context.close();
process.exit(results.failed.length || results.testsFailed.length ? 1 : 0);
