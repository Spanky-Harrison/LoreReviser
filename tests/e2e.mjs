import { chromium } from 'playwright-core';
const SHOTS = process.env.SHOTS_DIR ?? '/workspace/LoreReviser-shots';
const BASE = 'http://localhost:8766/';
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} ${extra}`); if (!ok) failures++; };

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' || /LoreReviser/i.test(t)) console.log('[console]', m.type(), t.slice(0, 300)); });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(BASE);
  await page.waitForSelector('#send_textarea', { timeout: 60000 });

  // First run onboarding popup: accept it
  const ok = page.locator('dialog[open] .popup-button-ok').first();
  try { await ok.waitFor({ timeout: 8000 }); await ok.click(); } catch {}
  await page.waitForTimeout(1500);

  // ---- test data setup, done through ST's own exports ----
  const setup = await page.evaluate(async () => {
    const ctx = SillyTavern.getContext();
    const wi = await import('/scripts/world-info.js');
    wi.updateWorldInfoSettings({}, ['Global Lore', 'The Wishing Game - Frankie']);
    ctx.powerUserSettings.persona_description_lorebook = 'Persona Lore';
    wi.charSetAuxWorlds('Test Queen', ['Eldoria Extras', 'Intimate Encounters - Complete Compendium']);
    ctx.extensionSettings.connectionManager.profiles.push(
      { id: 'prof-a', name: 'Profile A (Chat Completion)', mode: 'cc', api: 'openai', model: 'test-model' },
      { id: 'prof-b', name: 'Profile B (KoboldCpp)', mode: 'tc', api: 'koboldcpp', model: 'x' });
    const idx = ctx.characters.findIndex(c => c.name === 'Test Queen');
    await ctx.selectCharacterById(idx);
    await new Promise(r => setTimeout(r, 1500));
    await ctx.openCharacterChat('Test Queen - 2026-10-04@12h00m00s');
    for (let i = 0; i < 50 && !(ctx.chat.length >= 9); i++) await new Promise(r => setTimeout(r, 200));
    const c2 = SillyTavern.getContext();
    return { idx, chatLen: c2.chat.length, chatBook: c2.chatMetadata.world_info, world_names: wi.world_names, ext: !!c2.extensionSettings.LoreReviser };
  });
  console.log('setup', JSON.stringify(setup));
  check('chat with chat-bound lorebook opened', setup.chatLen >= 9 && setup.chatBook === 'Chat Lore');
  await page.screenshot({ path: `${SHOTS}/01-chat.png` });

  // ---- wand menu ----
  await page.click('#extensionsMenuButton');
  await page.waitForSelector('#lorereviser_open', { state: 'visible' });
  check('wand menu has LoreReviser entry', true);
  await page.screenshot({ path: `${SHOTS}/02-wand-menu.png`, clip: { x: 0, y: 500, width: 700, height: 400 } });

  // ---- modal ----
  await page.click('#lorereviser_open');
  await page.waitForSelector('.lorerev_root', { state: 'visible' });
  await page.waitForSelector('.lorerev_book');
  const bookNames = await page.$$eval('.lorerev_book_name', els => els.map(e => e.textContent));
  console.log('books:', bookNames);
  check('sidebar lists exactly the 7 linked books', JSON.stringify([...bookNames].sort()) === JSON.stringify(['Chat Lore', 'Eldoria', 'Eldoria Extras', 'Global Lore', 'Intimate Encounters - Complete Compendium', 'Persona Lore', 'The Wishing Game - Frankie']));
  check('unlinked book hidden', !bookNames.includes('Unlinked Book'));
  const sources = await page.$$eval('.lorerev_book', els => Object.fromEntries(els.map(e => [e.dataset.book, e.querySelector('.lorerev_book_sources').textContent])));
  console.log('sources:', sources);
  check('source labels', sources['Eldoria'] === 'Character' && sources['Eldoria Extras'] === 'Character' && sources['Global Lore'] === 'Global' && sources['Chat Lore'] === 'Chat' && sources['Persona Lore'] === 'Persona');
  await page.screenshot({ path: `${SHOTS}/03-modal-initial.png` });

  // ---- size: wide modal, sidebar wide enough that long book names are not shredded ----
  const dims = await page.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect();
    const long = [...document.querySelectorAll('.lorerev_book_name')].find(e => e.textContent.startsWith('Intimate'));
    return { vw: innerWidth, vh: innerHeight, popup: r('dialog[open].lorerev_popup'), sidebar: r('.lorerev_sidebar'), main: r('.lorerev_main'), longName: long.getBoundingClientRect(), lineH: parseFloat(getComputedStyle(long).lineHeight) || 20 };
  });
  console.log('dims', JSON.stringify({ popupW: dims.popup.width, popupH: dims.popup.height, sidebarW: dims.sidebar.width, mainW: dims.main.width, longNameH: dims.longName.height }));
  check('popup width >= 90% of viewport', dims.popup.width >= dims.vw * 0.9, `${dims.popup.width}/${dims.vw}`);
  check('popup height >= 85% of viewport', dims.popup.height >= dims.vh * 0.85, `${dims.popup.height}/${dims.vh}`);
  check('sidebar width 300-380px', dims.sidebar.width >= 299 && dims.sidebar.width <= 381, String(dims.sidebar.width));
  check('main panel gets the rest (> 2x sidebar)', dims.main.width > dims.sidebar.width * 2);
  check('long book name wraps at words only (<= 3 lines)', dims.longName.height <= dims.lineH * 3 + 4, String(dims.longName.height));

  // expand / collapse
  const eld = page.locator('.lorerev_book[data-book="Eldoria"]');
  check('entries collapsed by default', !(await eld.locator('.lorerev_entries').isVisible()));
  await eld.locator('.lorerev_toggle').click();
  check('expand shows entries', await eld.locator('.lorerev_entries').isVisible());
  const labels = await eld.locator('.lorerev_entry span').allTextContents();
  console.log('Eldoria entries:', labels);
  check('entry labels: title, key fallback', labels.includes('Kingdom of Eldoria') && labels.includes('Silverwood, forest') && labels.length === 4);
  await page.screenshot({ path: `${SHOTS}/04-expanded.png` });

  // tri-state
  const bookBox = eld.locator('.lorerev_book_check');
  await eld.locator('.lorerev_entry_check').first().check();
  check('one entry -> book indeterminate', await bookBox.evaluate(e => e.indeterminate && !e.checked));
  check('count shows 1/4', (await eld.locator('.lorerev_count').textContent()) === '1/4');
  await page.screenshot({ path: `${SHOTS}/05-indeterminate.png` });
  await bookBox.check();
  check('book checkbox selects all', (await eld.locator('.lorerev_entry_check:checked').count()) === 4 && await bookBox.evaluate(e => e.checked && !e.indeterminate));
  await eld.locator('.lorerev_entry_check').nth(1).uncheck();
  check('uncheck one -> indeterminate again', await bookBox.evaluate(e => e.indeterminate));
  const cl = page.locator('.lorerev_book[data-book="Chat Lore"]');
  await cl.locator('.lorerev_book_check').check();
  check('selected info updated', (await page.textContent('#lorerev_selected_info')) === '5 entries selected in 2 book(s)', await page.textContent('#lorerev_selected_info'));
  await page.screenshot({ path: `${SHOTS}/06-selection.png` });

  // profile dropdown
  const opts = await page.$$eval('#lorerev_profile option', os => os.map(o => o.textContent));
  console.log('profiles:', opts);
  check('profile dropdown lists Connection Manager profiles', opts.includes('Profile A (Chat Completion)') && opts.includes('Profile B (KoboldCpp)'));
  await page.selectOption('#lorerev_profile', 'prof-b');

  // system prompt
  await page.click('.lorerev_system summary');
  await page.fill('#lorerev_system', 'MY CUSTOM SYSTEM PROMPT');
  await page.screenshot({ path: `${SHOTS}/07-system-prompt.png` });

  // depth
  const info0 = await page.textContent('#lorerev_depth_info');
  check('depth info default = whole visible chat (8 of 8, hidden excluded)', info0 === '8 of 8 messages will be sent', info0);
  await page.fill('#lorerev_depth', '3');
  const info1 = await page.textContent('#lorerev_depth_info');
  check('depth 3 -> 3 of 8', info1 === '3 of 8 messages will be sent', info1);

  // ---- send validation ----
  const nMsgs = () => page.locator('.lorerev_msg').count();
  const errText = () => page.locator('.lorerev_msg.lorerev_error').last().textContent();
  const userMsgs = () => page.locator('.lorerev_msg.lorerev_user').count();
  // currently: profile B chosen and 5 entries selected; clear both to test errors
  await page.selectOption('#lorerev_profile', '');
  await page.fill('#lorerev_input', 'Update the queen\'s age.');
  await page.click('#lorerev_send');
  check('no profile: inline error shown', (await errText()) === 'Select a connection profile first.', await errText());
  check('no profile: toast error shown', (await page.locator('.toast-error').count()) > 0);
  check('no profile: nothing echoed', (await userMsgs()) === 0);
  check('no profile: typed text kept', (await page.inputValue('#lorerev_input')) === "Update the queen's age.");
  await page.screenshot({ path: `${SHOTS}/11-error-no-profile.png` });
  await page.selectOption('#lorerev_profile', 'prof-b');

  // no entries selected
  for (const b of ['Eldoria', 'Chat Lore']) await page.locator(`.lorerev_book[data-book="${b}"] .lorerev_book_check`).evaluate(e => { e.checked = true; e.click(); });
  check('cleared selection', (await page.textContent('#lorerev_selected_info')) === 'No entries selected', await page.textContent('#lorerev_selected_info'));
  await page.click('#lorerev_send');
  check('no entries: inline error', /Select at least one lorebook entry/.test(await errText()));
  check('no entries: nothing echoed', (await userMsgs()) === 0);
  await page.screenshot({ path: `${SHOTS}/12-error-no-entries.png` });
  // restore selection: 4 of Eldoria + 1 + Chat Lore all = same as before (5 entries in 2 books)
  await eld.locator('.lorerev_book_check').check();
  await eld.locator('.lorerev_entry_check').nth(1).uncheck();
  await cl.locator('.lorerev_book_check').check();
  check('selection restored', (await page.textContent('#lorerev_selected_info')) === '5 entries selected in 2 book(s)', await page.textContent('#lorerev_selected_info'));

  // empty instruction
  await page.fill('#lorerev_input', '   ');
  await page.click('#lorerev_send');
  check('empty instruction: inline error', /Write instructions first/.test(await errText()));
  check('empty instruction: nothing echoed', (await userMsgs()) === 0);
  check('only one error message kept (replaced, not stacked)', (await page.locator('.lorerev_msg.lorerev_error').count()) === 1);

  // valid send
  await page.fill('#lorerev_input', 'Update the queen\'s age.');
  await page.click('#lorerev_send');
  const msgs = await page.$$eval('.lorerev_msg:not(.lorerev_error)', els => els.map(e => e.textContent));
  console.log('msgs:', msgs);
  check('valid send echoes user message and not-implemented reply', msgs[0] === "Update the queen's age." && /isn't implemented yet/.test(msgs[1]) && /5 selected entries, 3 of 8 chat messages/.test(msgs[1]) && /Profile B \(KoboldCpp\)/.test(msgs[1]), msgs[1]);
  await page.screenshot({ path: `${SHOTS}/08-send-echo.png` });

  // Enter key sends
  await page.fill('#lorerev_input', 'second');
  await page.press('#lorerev_input', 'Enter');
  check('Enter sends', (await userMsgs()) === 2);

  // close
  await page.click('dialog[open] .popup-button-ok');
  await page.waitForTimeout(800);
  check('modal closes', (await page.locator('.lorerev_root').count()) === 0);

  // ---- reopen: persistence in-session ----
  await page.click('#extensionsMenuButton');
  await page.click('#lorereviser_open');
  await page.waitForSelector('.lorerev_book');
  check('reopen: selection restored', (await page.textContent('#lorerev_selected_info')) === '5 entries selected in 2 book(s)');
  check('reopen: profile restored', (await page.inputValue('#lorerev_profile')) === 'prof-b');
  check('reopen: system prompt restored', (await page.inputValue('#lorerev_system')) === 'MY CUSTOM SYSTEM PROMPT');
  check('reopen: depth restored', (await page.inputValue('#lorerev_depth')) === '3');
  check('reopen: conversation kept', (await page.locator('.lorerev_msg.lorerev_user').count()) === 2);
  await page.click('dialog[open] .popup-button-ok');
  await page.waitForTimeout(800);

  // flush saves, then reload to check persistence on server
  await page.evaluate(async () => { const c = SillyTavern.getContext(); await c.saveMetadata?.(); });
  await page.evaluate(() => fetch('/api/settings/get', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: '{}' }).then(r => r.json()).then(j => window.__s = j));
  await page.waitForTimeout(3000); // let the debounced settings save finish
  await page.reload();
  await page.waitForSelector('#send_textarea');
  await page.waitForTimeout(3000);
  const persisted = await page.evaluate(() => JSON.stringify(SillyTavern.getContext().extensionSettings.LoreReviser));
  console.log('after reload settings:', persisted);
  const p = JSON.parse(persisted);
  check('settings persisted across reload', p.profileId === 'prof-b' && p.systemPrompt === 'MY CUSTOM SYSTEM PROMPT' && p.depth === 3);
} catch (e) {
  console.log('TEST ERROR', e);
  failures++;
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
