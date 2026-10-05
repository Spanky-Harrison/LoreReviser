// End-to-end test of the revision flow (milestone 3) against a fake OpenAI-compatible server.
// Needs: ST on :8766 with the extension (tests/start-test-st.sh), node tests/fixtures.mjs, node tests/fake-openai.mjs 9099.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const SHOTS = process.env.SHOTS_DIR ?? '/workspace/LoreReviser-shots';
const FAKE = 'http://127.0.0.1:9099';
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} ${ok ? '' : extra}`); if (!ok) failures++; };

const fake = {
  reset: () => fetch(`${FAKE}/__reset`, { method: 'POST' }),
  queue: (replies) => fetch(`${FAKE}/__queue`, { method: 'POST', body: JSON.stringify(replies) }),
  requests: async () => (await fetch(`${FAKE}/__requests`)).json(),
};

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const sentLogs = [], removedLogs = [];
  page.on('console', m => { if (/removed from active lore:/.test(m.text()) && !/entries requested/.test(m.text())) removedLogs.push(m.text()); });
  page.on('console', m => { if (/\[LoreReviser\] entries requested/.test(m.text())) sentLogs.push(m.text()); });
  const wiLogs = [];
  page.on('console', m => { if (/\[LoreReviser\] WI scan:/.test(m.text())) wiLogs.push(m.text()); });
  page.on('pageerror', e => { console.log('[pageerror]', e.message); failures++; });
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|status of 500/.test(m.text())) console.log('[console error]', m.text().slice(0, 200)); });
  await page.goto('http://localhost:8766/');
  await page.waitForSelector('#send_textarea', { timeout: 60000 });
  try { const ok = page.locator('dialog[open] .popup-button-ok').first(); await ok.waitFor({ timeout: 8000 }); await ok.click(); } catch {}
  await page.waitForTimeout(1500);

  await page.evaluate(async () => {
    const ctx = SillyTavern.getContext();
    const wi = await import('/scripts/world-info.js');
    wi.updateWorldInfoSettings({}, ['Global Lore']);
    ctx.powerUserSettings.persona_description_lorebook = 'Persona Lore';
    ctx.extensionSettings.connectionManager.profiles.push(
      { id: 'prof-fake', name: 'Fake Model', mode: 'cc', api: 'custom', model: 'fake-model', 'api-url': 'http://127.0.0.1:9099/v1' });
    await ctx.selectCharacterById(ctx.characters.findIndex(c => c.name === 'Test Queen'));
    await new Promise(r => setTimeout(r, 1500));
    await ctx.openCharacterChat('Test Queen - 2026-10-04@12h00m00s');
    for (let i = 0; i < 50 && !(ctx.chat.length >= 9); i++) await new Promise(r => setTimeout(r, 200));
  });

  // snapshot of all lorebooks: approvals write since milestone 4, so every approval below is undone and this must match at the end
  const snapshot = () => page.evaluate(async () => {
    const out = {};
    for (const n of SillyTavern.getContext().getWorldInfoNames()) {
      out[n] = await (await fetch('/api/worldinfo/get', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify({ name: n }) })).json();
    }
    return JSON.stringify(out);
  });
  const before = await snapshot();

  await page.click('#extensionsMenuButton');
  await page.click('#lorereviser_open');
  await page.waitForSelector('.lorerev_book');
  await page.selectOption('#lorerev_profile', 'prof-fake');

  // ---- helpers ----
  const book = (name) => page.locator(`.lorerev_book[data-book="${name}"]`);
  async function pick(bookName, titles) {
    const b = book(bookName);
    if (!(await b.locator('.lorerev_entries').isVisible())) await b.locator('.lorerev_toggle').click();
    for (const t of titles) await b.locator('.lorerev_entry', { hasText: t }).locator('input').check();
  }
  const shot = async (name) => { await page.evaluate(() => toastr.clear()); await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/${name}` }); };
  const send = async (instruction) => { await page.fill('#lorerev_input', instruction); await page.click('#lorerev_send'); };
  const session = () => page.locator('.lorerev_session').last();
  const card = (title) => session().locator('.lorerev_card').filter({ has: page.locator('.lorerev_card_title > b', { hasText: new RegExp(`^${title}$`) }) });
  const pill = (title) => card(title).locator('.lorerev_pill:not(.lorerev_pill_edited)');
  const lastReq = async () => (await fake.requests()).at(-1);
  // Approve / Undo / Reject write to the lorebook since milestone 4: wait until the card has finished saving
  const settle = (c) => c.locator('.lorerev_saving').waitFor({ state: 'detached' });
  const approve = async (c) => { await c.locator('.lorerev_btn_ok').click(); await settle(c); };
  // approved cards collapse to their header line; clicking the header expands them again
  const isCollapsed = (c) => c.evaluate(el => el.classList.contains('lorerev_card_folded'));
  const expand = async (c) => { if (await isCollapsed(c)) await c.locator('.lorerev_card_title').click(); };
  const undo = async (c) => { await expand(c); await c.locator('.menu_button', { hasText: 'Undo' }).click(); await settle(c); };
  const entryOnServer = (bookName, uid) => page.evaluate(async ([n, u]) => (await (await fetch('/api/worldinfo/get', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify({ name: n }) })).json()).entries[u], [bookName, uid]);
  const userMsg = (req) => req.messages.find(m => m.role === 'user').content;

  // ================= A. normal reply (code fence + chatter), depth 3 =================
  await pick('Eldoria', ['Kingdom of Eldoria', 'Queen Maren']);
  await pick('Chat Lore', ['The Missing Heir']);
  await page.fill('#lorerev_depth', '3');
  await fake.reset();
  await fake.queue([{ content: 'Here you go:\n```json\n[{"id":"{{id:Queen Maren}}","keys":["Maren","queen","Maren the Wise"],"content":"Stern but fair monarch, 55 years old.","note":"She had a birthday."},{"id":"{{id:Kingdom of Eldoria}}","content":"A northern kingdom ruled by Queen Maren."}]\n```\nHope this helps!' }]);
  await send('The queen turned 55 and is now also called Maren the Wise.');
  await page.waitForSelector('.lorerev_session');
  check('A: 3 cards shown', (await session().locator('.lorerev_card').count()) === 3);
  check('A: Queen Maren proposed', (await pill('Queen Maren').textContent()) === 'Proposed');
  check('A: Kingdom (returned identical) = no changes', (await pill('Kingdom of Eldoria').textContent()) === 'No changes');
  check('A: omitted entry = no changes', (await pill('The Missing Heir').textContent()) === 'No changes');
  await card('Queen Maren').locator('.lorerev_view', { hasText: 'Full Compare' }).click();
  const cmpOld = await card('Queen Maren').locator('.lorerev_row:not(.lorerev_col_title) .lorerev_cell').nth(0).locator('.lorerev_para_del').allTextContents();
  const cmpNew = await card('Queen Maren').locator('.lorerev_row:not(.lorerev_col_title) .lorerev_cell').nth(1).locator('.lorerev_para_ins').allTextContents();
  check('A: compare view = whole old block | whole new block (no word-level marks)', cmpOld.join('').includes('54 years') && cmpNew.join('').includes('55 years') && (await card('Queen Maren').locator('.lorerev_ins, .lorerev_del, del, ins').count()) === 0);
  check('A: key chip added', (await card('Queen Maren').locator('.lorerev_chip_ins').allTextContents()).includes('Maren the Wise'));
  check('A: model note shown', (await card('Queen Maren').locator('.lorerev_note').textContent()) === 'She had a birthday.');
  await page.screenshot({ path: `${SHOTS}/14-review-cards.png` });

  const r1 = await lastReq();
  const u1 = userMsg(r1);
  if (process.env.SAMPLE_OUT) fs.writeFileSync(process.env.SAMPLE_OUT, JSON.stringify(r1, null, 2)); // example request for docs
  check('A: request: model + max_tokens', r1.model === 'fake-model' && r1.max_tokens >= 1500, JSON.stringify([r1.model, r1.max_tokens]));
  check('A: request: system prompt = editable prompt + fixed format rules', r1.messages[0].role === 'system' && /careful lorebook editor/.test(r1.messages[0].content) && /Reply format \(strict\)/.test(r1.messages[0].content));
  check('A: system message: default intensity Balanced + formatting-preservation rules', /## Rewrite intensity: Balanced\nBALANCED\./.test(r1.messages[0].content) && /Maintain ALL current formatting/.test(r1.messages[0].content) && r1.messages[0].content.indexOf('Rewrite intensity') < r1.messages[0].content.indexOf('Reply format (strict)'));
  check('A: system message forbids renaming/misspelling existing headings (system prompt, intensity, change type, rules)', ['Keep every existing heading and field label exactly', 'The liberty is for sentences, not for headings', "Record the change under the entry's existing headings", 'Copy every existing heading and field label exactly'].every(x => r1.messages[0].content.includes(x)));
  check('A: request: character card', /<character_card>\nCharacter: Test Queen/.test(u1) && /Description:\nA queen\./.test(u1));
  check('A: request: active lore (constant entry)', /<active_lore>[\s\S]*Silver crowns\.[\s\S]*<\/active_lore>/.test(u1));
  check('A: request: depth 3 -> last 3 messages only', /messages="3 of 8"/.test(u1) && u1.includes('Message number 8') && u1.includes('Message number 6') && !u1.includes('Message number 5'));
  check('A: request: hidden message excluded', !u1.includes('hidden message'));
  check('A: request: full entry content and keys with ids', /<entry id="E\d" book="Eldoria" title="Queen Maren">\n<keys>\["Maren","queen"\]<\/keys>[\s\S]*Stern but fair monarch, 54 years old\./.test(u1));
  check('A: request: instructions', u1.includes('<instructions>\nThe queen turned 55'));
  check('A: one request only', (await fake.requests()).length === 1);
  const reqIds = (u) => [...u.matchAll(/<entry id="(E\d+)"/g)].map(m => m[1]);
  check('A: every requested entry id is in <entries_to_revise>, in full (console log + request)', reqIds(u1).length === 3 && /requested: E1,E2,E3; entries in prompt: E1,E2,E3/.test(sentLogs.at(-1) ?? ''), `${reqIds(u1)} | ${sentLogs.at(-1)}`);

  // ================= B. approve writes to the lorebook; Undo puts the old version back =================
  await approve(card('Queen Maren'));
  check('B: approved pill', (await pill('Queen Maren').textContent()) === 'Approved');
  await expand(card('Queen Maren'));
  check('B: note says it was saved', /Saved to the lorebook "Eldoria"/.test(await card('Queen Maren').textContent()), await card('Queen Maren').textContent());
  check('B: the lorebook has the approved text', (await entryOnServer('Eldoria', 1)).content !== 'Stern but fair monarch, 54 years old.');
  await page.screenshot({ path: `${SHOTS}/15-approved.png` });
  await undo(card('Queen Maren'));
  check('B: undo -> proposed', (await pill('Queen Maren').textContent()) === 'Proposed');
  check('B: undo put the old version back (lorebooks as before)', (await snapshot()) === before);

  // ================= C. inline edit =================
  await card('Queen Maren').locator('.menu_button', { hasText: /^Edit full entry$/ }).click();
  await card('Queen Maren').locator('.lorerev_edit input').first().fill('Maren, queen, wise');
  await card('Queen Maren').locator('.lorerev_edit textarea').fill('Edited by the user, 55 years old.');
  await page.screenshot({ path: `${SHOTS}/16-edit.png` });
  await card('Queen Maren').locator('.menu_button', { hasText: 'Save edit' }).click();
  check('C: marked as edited', (await pill('Queen Maren').textContent()) === 'Proposed' && /Edited by you/.test(await card('Queen Maren').locator('.lorerev_card_title').textContent()));
  await card('Queen Maren').locator('.lorerev_view', { hasText: 'New' }).click();
  check('C: New view shows edited text', (await card('Queen Maren').locator('.lorerev_text').textContent()) === 'Edited by the user, 55 years old.');
  check('C: edited keys', (await card('Queen Maren').locator('.lorerev_chip_ins').allTextContents()).join('|') === 'wise');

  // ================= D. regenerate (swipe-style) =================
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Queen Maren}}","keys":["Maren","queen"],"content":"Regenerated: a stern monarch of 55.","note":"Second try."}]' }]);
  await card('Queen Maren').locator('.lorerev_regen textarea').fill('make it shorter');
  await card('Queen Maren').locator('.lorerev_regen .menu_button').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lorerev_session')].at(-1).querySelector('.lorerev_pager')?.textContent.includes('2/2'));
  check('D: pager shows 2/2', (await card('Queen Maren').locator('.lorerev_pager').textContent()).includes('2/2'));
  const r2 = await lastReq(); const u2 = userMsg(r2);
  check('D: request has previous attempts incl. the user edit', /<previous_attempts entry="E\d">/.test(u2) && u2.includes('edited_by_user="true"') && u2.includes('Edited by the user, 55 years old.'));
  check('D: request has the new guidance', /<regeneration_request>[\s\S]*make it shorter/.test(u2));
  check('D: request lists only the one entry', (u2.match(/<entry id=/g) ?? []).length === 1);
  check('D: request reuses the same context', u2.includes('<character_card>') && u2.includes('messages="3 of 8"'));
  await card('Queen Maren').locator('.lorerev_view', { hasText: 'New' }).click();
  check('D: shows new attempt', (await card('Queen Maren').locator('.lorerev_text').textContent()).startsWith('Regenerated'));
  await card('Queen Maren').locator('.lorerev_swipe.fa-chevron-left').click();
  check('D: page back -> attempt 1 (the edited one)', (await card('Queen Maren').locator('.lorerev_pager').textContent()).includes('1/2') && (await card('Queen Maren').locator('.lorerev_text').textContent()).startsWith('Edited by the user'));
  await page.screenshot({ path: `${SHOTS}/17-regenerate-pager.png` });
  await card('Queen Maren').locator('.lorerev_swipe.fa-chevron-right').click();
  check('D: page forward -> 2/2', (await card('Queen Maren').locator('.lorerev_pager').textContent()).includes('2/2'));

  // regenerate an entry that had "no changes"
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Kingdom of Eldoria}}","content":"A northern kingdom ruled by Queen Maren the Wise."}]' }]);
  await card('Kingdom of Eldoria').locator('.lorerev_regen .menu_button').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lorerev_card')].some(c => c.textContent.includes('Kingdom of Eldoria') && c.querySelector('.lorerev_pill_proposed')));
  check('D2: no-change entry can be regenerated into a proposal', (await pill('Kingdom of Eldoria').textContent()) === 'Proposed');
  check('D2: request says first pass found no change', userMsg(await lastReq()).includes('The first pass found no change'));

  // ================= E. reject / undo =================
  await card('Kingdom of Eldoria').locator('.lorerev_btn_no').click();
  check('E: rejected', (await pill('Kingdom of Eldoria').textContent()) === 'Rejected');
  await card('Kingdom of Eldoria').locator('.menu_button', { hasText: 'Undo' }).click();
  check('E: undo -> proposed', (await pill('Kingdom of Eldoria').textContent()) === 'Proposed');

  // ================= F. regenerate failure keeps old attempts =================
  await fake.reset();
  await fake.queue([{ status: 500, errorMessage: 'Model exploded' }]);
  await card('Queen Maren').locator('.lorerev_regen .menu_button').click();
  await card('Queen Maren').locator('.lorerev_error_line').waitFor();
  check('F: error shown on card', /Regeneration failed/.test(await card('Queen Maren').locator('.lorerev_error_line').textContent()));
  check('F: old attempts kept', (await card('Queen Maren').locator('.lorerev_pager').textContent()).includes('2/2') && (await pill('Queen Maren').textContent()) === 'Proposed');

  // ================= G. truncated reply =================
  await fake.reset();
  await fake.queue([{ finish_reason: 'length', usage: { completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 1200 } }, content: '[{"id":"{{id:Queen Maren}}","content":"New text A"},{"id":"{{id:The Missing Heir}}","content":"New text B"},{"id":"{{id:Kingdom of Eldoria}}","content":"cut off mid-sen' }]);
  await send('Second pass: tidy everything.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 2);
  check('G: truncation warning', /cut off/.test(await session().locator('.lorerev_session_notes').textContent()));
  check('G: complete entries recovered', (await pill('Queen Maren').textContent()) === 'Proposed' && (await pill('The Missing Heir').textContent()) === 'Proposed');
  check('G: unreturned entry flagged, not "no changes"', (await pill('Kingdom of Eldoria').textContent()) === 'Not returned');
  const gNotes = await session().locator('.lorerev_session_notes').textContent();
  check('G: message names the real evidence: finish_reason, tokens received/allowed, thinking', /finish_reason: length/.test(gNotes) && /4096 tokens received/.test(gNotes) && /1200 of them thinking/.test(gNotes) && /tokens allowed/.test(gNotes), gNotes);
  check('G: missing card says why', /The reply ended before this entry/.test(await card('Kingdom of Eldoria').textContent()));
  await page.screenshot({ path: `${SHOTS}/18-truncated.png` });
  // one-click retry of just the missing entry
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Kingdom of Eldoria}}","content":"A northern kingdom ruled by Queen Maren the Wise."}]' }]);
  await session().locator('.lorerev_btn_retry').click();
  await page.waitForFunction(() => { const s = [...document.querySelectorAll('.lorerev_session')].at(-1); return !s.querySelector('.lorerev_btn_retry') && !s.querySelector('.lorerev_pill_loading'); });
  for (let i = 0; i < 50 && (await fake.requests()).length < 1; i++) await new Promise(r => setTimeout(r, 100));
  const rq = await lastReq(); const ru = userMsg(rq);
  check('G: retry sends only the missing entry', reqIds(ru).length === 1 && ru.includes('Kingdom of Eldoria') && (await fake.requests()).length === 1);
  check('G: retried entry now proposed; others untouched; truncation note gone', (await pill('Kingdom of Eldoria').textContent()) === 'Proposed' && (await pill('Queen Maren').textContent()) === 'Proposed' && !/cut off/.test(await session().locator('.lorerev_session_notes').textContent()));
  await shot('30-retry-missing.png');

  // ================= H. malformed reply =================
  await fake.reset();
  await fake.queue([{ content: "I'm sorry, but I can't help with editing that lorebook." }]);
  await send('Third pass.');
  await page.waitForSelector('.lorerev_msg.lorerev_error');
  const errMsg = page.locator('.lorerev_msg.lorerev_error').last();
  check('H: parse error shown', /could not be used/.test(await errMsg.textContent()));
  check('H: raw reply visible', (await errMsg.locator('pre').textContent()).includes("I'm sorry, but I can't help"));
  check('H: no session added', (await page.locator('.lorerev_session').count()) === 2);
  await page.screenshot({ path: `${SHOTS}/19-parse-error.png` });

  // ================= I. API failure =================
  await fake.reset();
  await fake.queue([{ status: 500, errorMessage: 'Model exploded' }]);
  await send('Fourth pass.');
  await page.waitForFunction(() => document.querySelector('.lorerev_msg.lorerev_error')?.textContent.includes('request failed'));
  check('I: API failure shown', /request failed/i.test(await page.locator('.lorerev_msg.lorerev_error').last().textContent()));
  check('I: toast shown', (await page.locator('.toast-error').count()) > 0);
  check('I: Send usable again', !(await page.locator('#lorerev_send').evaluate(e => e.classList.contains('disabled'))));
  await page.screenshot({ path: `${SHOTS}/20-api-error.png` });

  // ================= J. cancel =================
  await fake.reset();
  await fake.queue([{ delayMs: 20000, content: '[]' }]);
  await send('Fifth pass (will be cancelled).');
  await page.waitForSelector('.lorerev_msg.lorerev_loading .lorerev_cancel');
  check('J: send disabled while running', await page.locator('#lorerev_send').evaluate(e => e.classList.contains('disabled')));
  await page.screenshot({ path: `${SHOTS}/21-loading.png` });
  await page.click('.lorerev_loading .lorerev_cancel');
  await page.waitForFunction(() => document.querySelector('#lorerev_chat').textContent.includes('Cancelled.'));
  check('J: cancelled message, loading gone', (await page.locator('.lorerev_loading').count()) === 0);
  await fake.reset();
  await fake.queue([{ content: '[]' }]);
  await send('Sixth pass: nothing to change.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 3);
  check('J: works after cancel; empty array -> everything "no changes"', (await session().locator('.lorerev_pill_unchanged').count()) === 3);

  // ================= K. decorators / macros / regex keys / secondary keys =================
  await book('Chat Lore').locator('.lorerev_book_check').uncheck(); // clear Chat Lore
  await pick('Chat Lore', ['Secret Passage']);
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Secret Passage}}","keys":["passage","/tunnel(s)?/i"],"secondary_keys":["throne","king"],"content":"Behind the throne. The way is known."}]' }]);
  await send('Rewrite the passage entry.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 4);
  const warns = await card('Secret Passage').locator('.lorerev_warn').allTextContents();
  check('K: decorator removal warned', warns.some(w => w.includes('@@activate')), JSON.stringify(warns));
  check('K: macro removal warned', warns.some(w => w.includes('{{user}}')));
  check('K: secondary keys shown', (await card('Secret Passage').locator('.lorerev_keys').nth(1).textContent()).includes('king'));
  const uK = userMsg(await lastReq());
  check('K: request carries secondary keys and decorator content', uK.includes('<secondary_keys>["throne"]</secondary_keys>') && uK.includes('@@activate'));
  await page.screenshot({ path: `${SHOTS}/22-warnings-secondary-keys.png` });

  // ================= L. token pre-flight warning + reply tokens setting =================
  await page.fill('#lorerev_context', '300');
  await page.fill('#lorerev_reply', '777');
  await fake.reset();
  await fake.queue([{ content: '[]' }]);
  await send('Check the size warning.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 5);
  const warnText = await page.locator('.lorerev_msg.lorerev_warn').last().textContent();
  const sizeWarn = (await page.locator('.lorerev_msg.lorerev_warn', { hasText: 'may not fit' }).allTextContents()).at(-1) ?? '';
  check('L: size warning shown but request still sent', /may not fit/.test(sizeWarn) && (await fake.requests()).length === 1, warnText);
  check('L: reply tokens setting used', (await lastReq()).max_tokens === 777);
  await page.screenshot({ path: `${SHOTS}/23-token-warning.png` });
  await page.fill('#lorerev_context', '0'); await page.fill('#lorerev_reply', '0');

  // ================= M. reopen the modal: sessions stay and still work =================
  await page.click('dialog[open] .popup-button-ok');
  await page.waitForTimeout(600);
  await page.click('#extensionsMenuButton'); await page.click('#lorereviser_open');
  await page.waitForSelector('.lorerev_book');
  check('M: sessions kept after reopen', (await page.locator('.lorerev_session').count()) === 5);
  const pagers = await page.locator('.lorerev_pager .lorerev_swipe_count').allTextContents();
  check('M: reopened cards show the attempt you were on (latest), not the first', pagers.length > 0 && pagers.every(t => { const [a, b] = t.split('/'); return a === b && a !== '1'; }), pagers.join(' '));
  const pg = page.locator('.lorerev_pager:not(.lorerev_pager_locked)').first();
  await pg.locator('.lorerev_swipe.fa-chevron-left').click();
  check('M: swipe arrows still work after reopen', /^1\//.test(await page.locator('.lorerev_pager:not(.lorerev_pager_locked)').first().locator('.lorerev_swipe_count').textContent()));
  await page.locator('.lorerev_pager:not(.lorerev_pager_locked)').first().locator('.lorerev_swipe.fa-chevron-right').click();
  await page.locator('.lorerev_session').first().locator('.lorerev_card').filter({ has: page.locator('.lorerev_card_title > b', { hasText: /^Queen Maren$/ }) }).locator('.lorerev_btn_no').click();
  check('M: cards still interactive after reopen', (await page.locator('.lorerev_session').first().locator('.lorerev_card').filter({ has: page.locator('.lorerev_card_title > b', { hasText: /^Queen Maren$/ }) }).locator('.lorerev_pill').textContent()) === 'Rejected');

  // ================= N. ST "World info budget reached" toast must not leak from our dry run =================
  // Root cause being tested: world-info.js shows toastr.warning('World info budget reached ...') during ANY scan (dry runs too)
  // when "Alert On Overflow" is on. Make the budget tiny so the scan overflows.
  await page.evaluate(() => {
    window.__toasts = [];
    const orig = toastr.warning;
    toastr.warning = function (m, t, ...r) { window.__toasts.push(String(m)); return orig.call(this, m, t, ...r); };
    $('#world_info_overflow_alert').prop('checked', true).trigger('change');
    $('#world_info_budget_cap').val(5).trigger('input'); // budget cap of 5 tokens: any activated entry overflows
  });
  // control: a plain ST dry run DOES show the toast (this is what the user saw)
  const raw = await page.evaluate(async () => {
    const wi = await import('/scripts/world-info.js');
    const ctx = SillyTavern.getContext();
    window.__toasts = [];
    await wi.getWorldInfoPrompt(ctx.chat.filter(m => !m.is_system).map(m => `${m.name}: ${m.mes}`).reverse(), ctx.maxContext, true, {});
    return window.__toasts.slice();
  });
  check('N: control - plain getWorldInfoPrompt dry run shows the budget toast', raw.some(t => /World info budget reached/.test(t)), JSON.stringify(raw));
  await page.evaluate(() => { window.__toasts = []; });
  await fake.reset();
  await fake.queue([{ content: '[]' }]);
  await send('Budget check.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 6);
  const toasts = await page.evaluate(() => window.__toasts);
  check('N: LoreReviser run shows no "World info budget" toast', !toasts.some(t => /budget/i.test(t)), JSON.stringify(toasts));
  const noteText = await page.locator('.lorerev_msg.lorerev_warn').last().textContent();
  check('N: modal shows a small note instead', /World Info budget was reached/.test(noteText) && /not an error/.test(noteText), noteText);
  check('N: toastr.warning restored after the scan', await page.evaluate(() => toastr.warning.toString().includes('__toasts')));
  check('N: request was still sent', (await fake.requests()).length === 1);
  // finding to confirm: selected entries are read with loadWorldInfo and never pass through the WI budget, even at ~1 token
  const selectedCount = await page.locator('.lorerev_entry input:checked').count();
  const nreq = userMsg(await lastReq());
  const nIds = [...nreq.matchAll(/<entry id="(E\d+)"/g)].map(m => m[1]);
  check('N: with the WI budget at its minimum every selected entry is still sent in full', selectedCount > 0 && nIds.length === selectedCount && nreq.includes('Stern but fair monarch, 54 years old.') && nreq.includes('Prince Aldric vanished last winter.') && nreq.includes('Behind the throne.'), `${selectedCount} selected, ${nIds.length} sent`);
  check('N: ...while the active-lore block is what the budget empties (constant entry gone from <active_lore>)', !nreq.includes('Silver crowns'));
  check('N: console log shows requested == sent', (() => { const m = (sentLogs.at(-1) ?? '').match(/requested: ([^;\s]+); entries in prompt: ([^;\s]+)/); return !!m && m[1] === m[2]; })(), sentLogs.at(-1));
  await shot('24-lore-budget-note.png');
  // with the alert off and a normal budget there is no note
  await page.evaluate(() => { $('#world_info_overflow_alert').prop('checked', false).trigger('change'); $('#world_info_budget_cap').val(0).trigger('input'); });
  await fake.reset();
  await fake.queue([{ content: '[]' }]);
  const budgetNotesBefore = await page.locator('.lorerev_msg.lorerev_warn', { hasText: 'World Info budget' }).count();
  await send('No budget issue now.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 7);
  check('N: no note when the budget is fine', (await page.locator('.lorerev_msg.lorerev_warn', { hasText: 'World Info budget' }).count()) === budgetNotesBefore);

  // ================= O. block-level views with realistic multi-sentence text =================
  await pick('Persona Lore', ['Traveler Backstory']);
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Traveler Backstory}}","keys":["traveler","Saltmere","cartographer"],"content":"You grew up in the fishing village of Saltmere, the youngest of five children. Your father mended nets and your mother ran a stall of smoked eel at the harbor market. You learned to read from the tide tables nailed to the harbor wall.\\nAt seventeen you left for the capital to apprentice with a cartographer. You are quietly proud of your maps, though you rarely show them to anyone. Since the queen\'s coronation you have been mapping the Silverwood border in secret, and you no longer trust anyone at court. You still carry your father\'s brass compass everywhere.","note":"Added the secret border survey from the latest chat."}]' }]);
  await send('Add that the traveler is secretly mapping the Silverwood border for the queen.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 8);
  const tcard = card('Traveler Backstory');
  check('O: changes is the default view', (await tcard.locator('.lorerev_view_on').textContent()) === 'Changes'); await tcard.locator('.lorerev_view', { hasText: 'Full Compare' }).click(); check('O: full compare shows one aligned row old | new', (await tcard.locator('.lorerev_row:not(.lorerev_col_title) .lorerev_cell').count()) === 2);
  check('O: both paragraphs changed -> 2 removed blocks left, 2 added blocks right', (await tcard.locator('.lorerev_para_del').count()) === 2 && (await tcard.locator('.lorerev_para_ins').count()) === 2);
  const cellText = (i) => tcard.locator('.lorerev_row:not(.lorerev_col_title) .lorerev_cell').nth(i).textContent();
  check('O: old cell has the whole old text, new cell the whole new text', (await cellText(0)).includes('mother sold smoked eel') && (await cellText(0)).includes('rarely show them') && (await cellText(1)).includes('in secret') && (await cellText(1)).includes('ran a stall'));
  await tcard.scrollIntoViewIfNeeded();
  await shot('25-block-compare.png');
  await tcard.locator('.lorerev_view', { hasText: 'Changes' }).click();
  check('O: Changes view: removed blocks followed by added blocks, unchanged sentences dimmed', (await tcard.locator('.lorerev_blk_del').count()) >= 1 && (await tcard.locator('.lorerev_blk_ins').count()) >= 1 && (await tcard.locator('.lorerev_blk_same').count()) >= 1);
  const order = await tcard.locator('.lorerev_blk').evaluateAll(els => els.map(e => e.className.replace(/.*lorerev_blk_/, '')).join(','));
  check('O: in Changes every removed block is directly followed by its added block', /del,ins/.test(order) && !/ins,del/.test(order), order);
  // Formatting: blocks keep newlines (not space-joined into one flat blob); New/Old keep paragraph breaks too.
  const blkInner = await tcard.locator('.lorerev_blk').evaluateAll(els => els.map(e => e.innerText));
  check('O: Changes view preserves multi-line structure (newlines inside blocks or several blocks, not one flattened blob)', blkInner.some(t => t.includes('\n')) || blkInner.length >= 3, JSON.stringify(blkInner.map(t => t.slice(0, 40))));
  const preWrap = await tcard.locator('.lorerev_blk').first().evaluate(el => getComputedStyle(el).whiteSpace);
  check('O: Changes blocks use pre-wrap so newlines render', preWrap === 'pre-wrap', preWrap);
  await tcard.locator('.lorerev_view', { hasText: 'New' }).click();
  check('O: New view keeps paragraph newlines', (await tcard.locator('.lorerev_text').innerText()).includes('\n'));
  await tcard.locator('.lorerev_view', { hasText: 'Old' }).click();
  check('O: Old view keeps paragraph newlines', (await tcard.locator('.lorerev_text').innerText()).includes('\n'));
  await tcard.locator('.lorerev_view', { hasText: 'Changes' }).click();
  await shot('26-block-changes.png');
  await page.setViewportSize({ width: 600, height: 900 });
  await tcard.locator('.lorerev_view', { hasText: 'Full Compare' }).click();
  const stacked = await tcard.locator('.lorerev_row:not(.lorerev_col_title) .lorerev_cell').evaluateAll(els => els[1].getBoundingClientRect().top > els[0].getBoundingClientRect().bottom - 2);
  check('O: narrow screen stacks old above new', stacked);
  await tcard.scrollIntoViewIfNeeded();
  await shot('27-block-compare-narrow.png');
  await page.setViewportSize({ width: 1400, height: 900 });

  // ================= O2. "Edit proposal" edits only the changed (green) parts; everything else stays exactly =================
  await tcard.locator('.lorerev_view', { hasText: 'New' }).click();
  const proposedText = await tcard.locator('.lorerev_text').textContent();
  check('O2: revision card: "Edit proposal" is the main Edit, "Edit full entry" next to it', (await tcard.locator('.lorerev_buttons .menu_button').allTextContents()).join('|') === 'Approve|Reject|Edit proposal|Edit full entry|History');
  await tcard.locator('.lorerev_btn_edit').click();
  const hunks = tcard.locator('.lorerev_ed_hunk');
  check('O2: one box per changed part, no whole-text box', (await hunks.count()) === 2 && (await tcard.locator('.lorerev_ed_content').count()) === 0, String(await hunks.count()));
  check('O2: the boxes hold the proposed (green) text', (await hunks.nth(0).inputValue()) === 'Your father mended nets and your mother ran a stall of smoked eel at the harbor market.' && (await hunks.nth(1).inputValue()) === "Since the queen's coronation you have been mapping the Silverwood border in secret, and you no longer trust anyone at court. You still carry your father's brass compass everywhere.", await hunks.nth(0).inputValue());
  check('O2: removed old text shown above its box, unchanged text dimmed', (await tcard.locator('.lorerev_hunk .lorerev_blk_del').first().textContent()).includes('mother sold smoked eel') && (await tcard.locator('.lorerev_hunk_same').count()) >= 2);
  check('O2: the first changed part has the focus', await hunks.nth(0).evaluate(el => document.activeElement === el));
  check('O2: keys are editable here too', (await tcard.locator('.lorerev_ed_keys').inputValue()) === 'traveler, Saltmere, cartographer');
  await tcard.scrollIntoViewIfNeeded();
  await shot('30-edit-proposal.png');
  await hunks.nth(0).fill('Your father mended nets and your mother ran a stall of smoked eel and pickled herring at the harbor market.');
  await tcard.locator('.lorerev_btn_hunk_old').nth(1).click();
  check('O2: "Use old text" puts the removed text into the box', (await hunks.nth(1).inputValue()) === "You distrust nobles and carry your father's brass compass everywhere.");
  await tcard.locator('.lorerev_ed_keys').fill('traveler, Saltmere, mapmaker');
  await tcard.locator('.lorerev_btn_save').click();
  await tcard.locator('.lorerev_view', { hasText: 'New' }).click();
  const expectedText = proposedText.replace('smoked eel at', 'smoked eel and pickled herring at').replace(/Since the queen's coronation[\s\S]*$/, "You distrust nobles and carry your father's brass compass everywhere.");
  check('O2: saved text = proposal with only the edited parts replaced (rest byte for byte, newline kept)', (await tcard.locator('.lorerev_text').textContent()) === expectedText, JSON.stringify(await tcard.locator('.lorerev_text').textContent()));
  check('O2: keys saved, card marked "Edited by you"', (await tcard.locator('.lorerev_chip_ins').allTextContents()).join('|') === 'Saltmere|mapmaker' && /Edited by you/.test(await tcard.locator('.lorerev_card_title').textContent()));
  // switching to the full editor keeps what was typed
  await tcard.locator('.lorerev_btn_edit').click();
  await tcard.locator('.lorerev_ed_hunk').first().fill('Your father mended nets.');
  await tcard.locator('.lorerev_edit .lorerev_btn_edit_full').click();
  check('O2: "Edit full entry" from the proposal editor carries the typed text over', (await tcard.locator('.lorerev_ed_content').inputValue()).includes('Your father mended nets. You learned') && (await tcard.locator('.lorerev_ed_hunk').count()) === 0);
  await tcard.locator('.lorerev_edit .menu_button', { hasText: 'Cancel' }).click();
  await tcard.locator('.lorerev_btn_edit').click();
  await tcard.locator('.lorerev_btn_reset').click();
  check("O2: reset restores the model's version", (await tcard.locator('.lorerev_text').textContent()) === proposedText && !/Edited by you/.test(await tcard.locator('.lorerev_card_title').textContent()));

  // ================= P. editing works in every state; committed text = edit box =================
  const EDIT = 'Exactly my text.\n\n  Two  spaces and a {{user}} macro stay as typed.  ';
  const editBtn = (t) => card(t).locator('.menu_button', { hasText: /^(Edit|Edit full entry)$/ }); // full editor ("Edit" on "No changes" cards)
  const edit = async (t, text, keys) => {
    await editBtn(t).click();
    if (keys !== undefined) await card(t).locator('.lorerev_ed_keys').fill(keys);
    await card(t).locator('.lorerev_ed_content').fill(text);
    await card(t).locator('.lorerev_btn_save').click();
  };
  await approve(tcard); await expand(tcard);
  check('P: approved card still has Edit', (await editBtn('Traveler Backstory').count()) === 1);
  await edit('Traveler Backstory', EDIT);
  check('P: editing an approved card puts it back to Proposed with re-approve notice + "Edited by you"', (await pill('Traveler Backstory').textContent()) === 'Proposed' && /Approve it again/.test(await tcard.textContent()) && /Edited by you/.test(await tcard.locator('.lorerev_card_title').textContent()));
  await shot('28-edited-reapprove.png');
  await approve(tcard);
  check('P: re-approval saves the edited text', (await entryOnServer('Persona Lore', 0)).content === EDIT);
  check('P: re-approval works', (await pill('Traveler Backstory').textContent()) === 'Approved' && !/Approve it again/.test(await tcard.textContent()));
  await expand(tcard);
  await tcard.locator('.lorerev_view', { hasText: 'New' }).click();
  check('P: approved text is exactly the edit box content (whitespace included)', (await tcard.locator('.lorerev_text').textContent()) === EDIT);
  // reopen the editor: the box holds exactly what was approved
  await editBtn('Traveler Backstory').click();
  check('P: editor reloads the exact text', (await tcard.locator('.lorerev_ed_content').inputValue()) === EDIT);
  await tcard.locator('.menu_button', { hasText: 'Cancel' }).click();
  // regenerate -> page between attempts -> edit attempt 1 only
  await undo(tcard);
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Traveler Backstory}}","content":"Second attempt text."}]' }]);
  await tcard.locator('.lorerev_regen .menu_button').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lorerev_session')].at(-1).querySelector('.lorerev_pager')?.textContent.includes('2/2'));
  await tcard.locator('.lorerev_view', { hasText: 'New' }).click();
  await edit('Traveler Backstory', 'Edited attempt two.');
  check('P: edit on attempt 2 applies to attempt 2', (await tcard.locator('.lorerev_text').textContent()) === 'Edited attempt two.' && /2\/2/.test(await tcard.locator('.lorerev_pager').textContent()));
  await tcard.locator('.lorerev_swipe.fa-chevron-left').click();
  check('P: attempt 1 is untouched (still the edited-by-me text, not attempt 2)', (await tcard.locator('.lorerev_text').textContent()) === EDIT);
  await edit('Traveler Backstory', 'Edited attempt one.');
  await tcard.locator('.lorerev_swipe.fa-chevron-right').click();
  check('P: attempt 2 keeps its own edit', (await tcard.locator('.lorerev_text').textContent()) === 'Edited attempt two.');
  // reset to the model's version
  await editBtn('Traveler Backstory').click();
  await tcard.locator('.lorerev_btn_reset').click();
  check("P: reset restores the model's text and clears the edited badge", (await tcard.locator('.lorerev_text').textContent()) === 'Second attempt text.' && !/Edited by you/.test(await tcard.locator('.lorerev_card_title').textContent()));
  // edit after reject
  await tcard.locator('.lorerev_btn_no').click(); await settle(tcard);
  check('P: rejected card has Edit', (await editBtn('Traveler Backstory').count()) === 1);
  await edit('Traveler Backstory', 'Edited after reject.', 'traveler, Saltmere');
  check('P: edit after reject -> Proposed again, keys saved', (await pill('Traveler Backstory').textContent()) === 'Proposed' && (await tcard.locator('.lorerev_chip_ins').allTextContents()).join('|') === 'Saltmere');
  // edit on an entry the model left unchanged
  const other = card('The Missing Heir');
  check('P: an unchanged card has Edit', (await editBtn('The Missing Heir').count()) === 1);
  await edit('The Missing Heir', 'Prince Aldric vanished last winter. He was last seen near the Silverwood.');
  check('P: editing a "No changes" entry creates your own proposal', (await pill('The Missing Heir').textContent()) === 'Proposed' && /Written by you/.test(await other.textContent()) && /Edited by you/.test(await other.locator('.lorerev_card_title').textContent()));
  await approve(other);
  check('P: ...which can be approved', (await pill('The Missing Heir').textContent()) === 'Approved');
  await undo(other);
  await tcard.scrollIntoViewIfNeeded();
  await shot('29-edit-every-state.png');

  // ================= Q. paragraph inserted in the middle: clean added block, later paragraphs stay "unchanged" =================
  await pick('Persona Lore', ['Festival of Lanterns']);
  const FEST_NEW = "The bargain: long ago a drowned child asked the lanterns to take her home. The guild's first master agreed and cast her out of the harbor as a hound of black water, and the lantern for her is never lit, so that the hound will not follow it back.";
  await fake.reset();
  await fake.queue([{ content: JSON.stringify([{ id: '{{id:Festival of Lanterns}}', note: 'Inserted the bargain paragraph after the guild paragraph.', content:
    'The Festival of Lanterns is held each autumn in the harbor town of Saltmere. Every household floats a paper lantern for someone they have lost.\n' +
    'The festival is run by the Harbor Guild. The guild master lights the first lantern at dusk, and nobody may speak until the last one has drifted past the lighthouse.\n' +
    FEST_NEW + '\n' +
    'Children are told that the lanterns guide the dead home. Sailors say the lanterns are only there to keep the fishing boats from the rocks.\n' +
    'The week after the festival, the town holds a market where the guild sells the remaining lantern paper at half price.' }]) }]);
  await send('Add the bargain with the drowned child to the festival.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 9);
  const fc = card('Festival of Lanterns');
  await fc.locator('.lorerev_view', { hasText: 'Full Compare' }).click();
  const rows = await fc.locator('.lorerev_cmp > *').evaluateAll(els => els.map(e => e.className.includes('lorerev_col_title') ? 'head' : e.className.includes('lorerev_same') ? 'same' : (e.querySelector('.lorerev_para_del') ? 'del' : '') + (e.querySelector('.lorerev_para_ins') ? 'ins' : '')));
  check('Q: compare = same, [added block only], same (nothing marked removed)', rows.join(',') === 'head,same,ins,same', rows.join(','));
  check('Q: the inserted paragraph is exactly one added block; no removed blocks anywhere', (await fc.locator('.lorerev_para_ins').count()) === 1 && (await fc.locator('.lorerev_para_del').count()) === 0 && (await fc.locator('.lorerev_para_ins').textContent()) === FEST_NEW);
  check('Q: unchanged paragraphs before and after are intact and dimmed', (await fc.locator('.lorerev_same').first().textContent()).includes('run by the Harbor Guild') && (await fc.locator('.lorerev_same').last().textContent()).includes('half price') && (await fc.locator('.lorerev_same').last().textContent()).includes('Children are told'));
  check('Q: New view = the model text with the later paragraphs preserved', await (async () => {
    await fc.locator('.lorerev_view', { hasText: /^New$/ }).click();
    const t = await fc.locator('.lorerev_text').textContent();
    return t.includes(FEST_NEW) && t.includes('Children are told that the lanterns guide the dead home') && t.includes('half price') && t.indexOf(FEST_NEW) < t.indexOf('Children are told');
  })());
  await fc.locator('.lorerev_view', { hasText: /^Changes$/ }).click();
  const chOrder = await fc.locator('.lorerev_blk').evaluateAll(els => els.map(e => e.className.replace(/.*lorerev_blk_/, '')).join(','));
  check('Q: Changes view = unchanged (dim), added, unchanged (dim)', chOrder === 'same,ins,same', chOrder);
  await fc.locator('.lorerev_view', { hasText: /^Full Compare$/ }).click();
  await fc.scrollIntoViewIfNeeded();
  await shot('31-mid-insertion-compare.png');
  await fc.locator('.lorerev_view', { hasText: /^Old$/ }).click();
  check('Q: Old view = plain original', (await fc.locator('.lorerev_text').textContent()).startsWith('The Festival of Lanterns is held') && !(await fc.locator('.lorerev_text').textContent()).includes('bargain'));

  // ================= R. reply with raw line breaks and quotes inside strings: parsed, NOT reported as cut off =================
  await fake.reset();
  await fake.queue([{ finish_reason: 'stop', content: '[{"id":"{{id:Festival of Lanterns}}","content":"Line one.\nLine two with a "quoted" word.\nLine three."},{"id":"{{id:Queen Maren}}"}]' }]);
  await send('Rewrite the festival as three short lines.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 10);
  const rNotes = await session().locator('.lorerev_session_notes').textContent();
  check('R: not reported as cut off or damaged', !/cut off|not valid JSON|Not returned/.test(rNotes + (await session().textContent())), rNotes);
  check('R: fixed-automatically note', /formatting slips/.test(rNotes));
  await card('Festival of Lanterns').locator('.lorerev_view', { hasText: /^New$/ }).click();
  check('R: text kept exactly (line breaks and quotes)', (await card('Festival of Lanterns').locator('.lorerev_text').textContent()) === 'Line one.\nLine two with a "quoted" word.\nLine three.');
  check('R: omitted entries show "No changes", not "Not returned"', (await session().locator('.lorerev_pill_missing').count()) === 0 && (await session().locator('.lorerev_pill_unchanged').count()) >= 1);

  // ================= S. depth -1: no chat history at all (also on regenerate); depth 0 = whole chat =================
  await page.fill('#lorerev_depth', '-1');
  check('S: label says no chat will be sent', (await page.textContent('#lorerev_depth_info')) === 'No chat will be sent');
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Queen Maren}}","content":"Stern but fair monarch, 55 years old."}]' }]);
  await send('Depth minus one: only update the queen\'s age to 55.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 11);
  const sq = await lastReq(); const su = userMsg(sq);
  check('S: <chat_history> is explicitly empty and no chat text is sent', /<chat_history messages="0 of 8">\n\(No chat history is provided/.test(su) && !/Message number \d/.test(su) && !su.includes('Greetings, traveler.'), su.slice(su.indexOf('<chat_history'), su.indexOf('<chat_history') + 200));
  check('S: card, active lore, entries and instructions are still sent', su.includes('<character_card>\nCharacter: Test Queen') && su.includes('Silver crowns.') && /<entry id="E\d" book="Eldoria" title="Queen Maren">/.test(su) && su.includes('Depth minus one: only update'));
  check('S: proposal reviewed as usual', (await pill('Queen Maren').textContent()) === 'Proposed');
  await shot('32b-depth-minus-one-review.png');
  // regenerate path keeps sending no chat
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Queen Maren}}","content":"Second try, 55."}]' }]);
  await card('Queen Maren').locator('.lorerev_regen .menu_button').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lorerev_session')].at(-1).querySelector('.lorerev_pager')?.textContent.includes('2/2'));
  const sr = userMsg(await lastReq());
  check('S: regenerate also sends no chat history', /<chat_history messages="0 of 8">\n\(No chat history is provided/.test(sr) && !/Message number \d/.test(sr) && sr.includes('<previous_attempts'));
  // depth 0 = whole chat again
  await page.fill('#lorerev_depth', '0');
  await fake.reset();
  await fake.queue([{ content: '[]' }]);
  await send('Depth zero: whole chat.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 12);
  const sz = userMsg(await lastReq());
  check('S: depth 0 still sends the whole visible chat', /<chat_history messages="8 of 8">/.test(sz) && sz.includes('Message number 1') && sz.includes('Message number 8') && !sz.includes('hidden message'));
  // stored setting survives
  check('S: depth setting stored as -1 after toggling back and forth', await (async () => { await page.fill('#lorerev_depth', '-1'); return (await page.evaluate(() => SillyTavern.getContext().extensionSettings.LoreReviser.depth)) === -1; })());

  // ================= T. selected entries that are also active are sent once =================
  for (const cb of await page.locator('.lorerev_book_check').all()) { await cb.check(); await cb.uncheck(); } // clear the selection
  const loreBlock = (u) => u.slice(u.indexOf('<active_lore>'), u.indexOf('</active_lore>'));
  const reviseBlock = (u) => u.slice(u.indexOf('<entries_to_revise>'), u.indexOf('</entries_to_revise>'));
  const count = (hay, needle) => hay.split(needle).length - 1;
  const infoCount = () => page.locator('.lorerev_msg.lorerev_info').count();
  const infosBefore = await infoCount();

  // T1: Currency (selected + active), The Missing Heir (only selected: its key is never triggered); Moon Calendar stays only active.
  // (In this test chat the active lore is: both Global constants, Queen Maren, Festival of Lanterns, Secret Passage.)
  await pick('Global Lore', ['Currency']);
  await pick('Chat Lore', ['The Missing Heir']);
  await fake.reset();
  await fake.queue([{ content: '[]' }]);
  await send('T1: nothing to change, just checking the prompt.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 13);
  const t1 = userMsg(await lastReq());
  check('T1: selected+active entry is NOT in <active_lore>', !loreBlock(t1).includes('Silver crowns.'));
  check('T1: ...and appears exactly once in the whole prompt, in full, in <entries_to_revise>', count(t1, 'Silver crowns.') === 1 && reviseBlock(t1).includes('Silver crowns.'));
  check('T1: only-active entry stays in <active_lore>, untouched', loreBlock(t1).includes('The moon festival falls on the third full moon.') && !reviseBlock(t1).includes('moon festival'));
  check('T1: only-selected entry is just in <entries_to_revise>', count(t1, 'Prince Aldric vanished last winter.') === 1 && reviseBlock(t1).includes('Prince Aldric'));
  check('T1: other active entries that were not selected are untouched (Queen Maren, Secret Passage, Festival)', loreBlock(t1).includes('Stern but fair monarch') && loreBlock(t1).includes('Behind the throne.') && loreBlock(t1).includes('Festival of Lanterns is held'));
  check('T1: modal note says 1 entry was already active, sent once', (await infoCount()) === infosBefore + 1 && /1 selected entry was already active/.test(await page.locator('.lorerev_msg.lorerev_info').last().textContent()));
  check('T1: sent-ids log mentions the de-duplicated entry and nothing left duplicated', /already active, sent once \(removed from active lore\): E\d; still also in active lore: -/.test(sentLogs.at(-1) ?? ''), sentLogs.at(-1));
  await shot('33-already-active-note.png');

  // T2: only-selected entry alone -> no note, nothing removed
  for (const cb of await page.locator('.lorerev_book_check').all()) { await cb.check(); await cb.uncheck(); }
  await pick('Chat Lore', ['The Missing Heir']);
  await fake.reset();
  await fake.queue([{ content: '[]' }]);
  await send('T2: only a non-active entry.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 14);
  const t2 = userMsg(await lastReq());
  check('T2: both constant entries stay in the active lore, no note', loreBlock(t2).includes('Silver crowns.') && loreBlock(t2).includes('moon festival') && (await infoCount()) === infosBefore + 1);
  check('T2: log shows none removed', /sent once \(removed from active lore\): -;/.test(sentLogs.at(-1) ?? ''), sentLogs.at(-1));

  // T3: EVERY active entry is selected -> the active lore is empty
  for (const cb of await page.locator('.lorerev_book_check').all()) { await cb.check(); await cb.uncheck(); }
  await pick('Global Lore', ['Currency', 'Moon Calendar']);
  await pick('Eldoria', ['Queen Maren']);
  await pick('Persona Lore', ['Festival of Lanterns']);
  await pick('Chat Lore', ['Secret Passage']);
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Currency}}","content":"Silver crowns and gold marks."}]' }]);
  await send('T3: every active entry selected; change the currency.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 15);
  const t3 = userMsg(await lastReq());
  check('T3: active lore is empty -> "(none active)"', /<active_lore>\n\(none active\)\n<\/active_lore>/.test(t3), loreBlock(t3));
  check('T3: each entry once, in full, in <entries_to_revise>; note says 5', count(t3, 'Silver crowns.') === 1 && count(t3, 'third full moon.') === 1 && count(t3, 'Behind the throne.') === 1 && count(t3, 'Festival of Lanterns is held') === 1 && /5 selected entries were already active/.test(await page.locator('.lorerev_msg.lorerev_info').last().textContent()));
  check('T3: matched by book+uid from the scan, not by guessing (also the entry whose @@decorator line the scan strips)', /matched by uid/.test(removedLogs.at(-1) ?? '') && !/matched by content/.test(removedLogs.at(-1) ?? ''), removedLogs.at(-1));
  // regenerate Currency: the request only lists Currency, so Moon Calendar (not part of it) reappears as lore
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Currency}}","content":"Silver crowns, gold marks and copper bits."}]' }]);
  await card('Currency').locator('.lorerev_regen .menu_button').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lorerev_session')].at(-1).querySelector('.lorerev_pager')?.textContent.includes('2/2'));
  const t4 = userMsg(await lastReq());
  check('T3: regenerate lists only Currency (once), keeps it out of the lore, and shows the entries not in this request as lore again', (t4.match(/<entry id=/g) ?? []).length === 1 && !loreBlock(t4).includes('Silver crowns') && loreBlock(t4).includes('third full moon.') && loreBlock(t4).includes('Stern but fair monarch') && count(t4, 'Silver crowns.') === 1);

  // ================= U. rewrite intensity (persisted, in the prompt, applies on regenerate) =================
  check('U: default intensity is Balanced', (await page.inputValue('#lorerev_intensity')) === 'balanced');
  const sysOf = async () => (await lastReq()).messages[0].content;
  await page.selectOption('#lorerev_intensity', 'light');
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Currency}}","content":"Silver crowns and gold marks."}]' }]);
  await send('U: change the currency.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 16);
  const uLight = await sysOf();
  check('U: Light touch wording in the system message (and only that level)', /## Rewrite intensity: Light touch\nLIGHT TOUCH\. Change only what MUST change/.test(uLight) && /verbatim/.test(uLight) && !/BALANCED\.|HEAVY-HANDED\./.test(uLight));
  check('U: attempt shows the intensity it was made with', /Rewrite intensity: Light touch/.test(await card('Currency').textContent()));
  await shot('34-intensity-light.png');

  // ================= V. regenerate box: always visible, multi-line, remembered per attempt =================
  const cur = card('Currency');
  check('V: regenerate box is visible without clicking anything, multi-line', (await cur.locator('.lorerev_regen_text').isVisible()) && Number(await cur.locator('.lorerev_regen_text').getAttribute('rows')) >= 3 && (await cur.locator('.menu_button', { hasText: 'Regenerate…' }).count()) === 0);
  check('V: also on "No changes" cards, not on approved cards', (await card('Moon Calendar').locator('.lorerev_regen_text').isVisible()) === true);
  await approve(cur); await expand(cur);
  check('V: approved card has no regenerate box (Undo first)', (await cur.locator('.lorerev_regen_text').count()) === 0);
  await undo(cur);
  const REQ1 = 'Make it shorter.\nMention the gold marks.';
  await page.selectOption('#lorerev_intensity', 'heavy');
  await cur.locator('.lorerev_regen_text').fill(REQ1);
  await cur.locator('.lorerev_view', { hasText: 'New' }).click(); // a rerender must keep the draft
  check('V: draft text survives a re-render', (await cur.locator('.lorerev_regen_text').inputValue()) === REQ1);
  await shot('35-regen-box.png');
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Currency}}","content":"Silver crowns, gold marks."}]' }]);
  await cur.locator('.lorerev_btn_regen').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lorerev_session')].at(-1).querySelector('.lorerev_pager')?.textContent.includes('2/2'));
  const v1 = await lastReq(); const vu = userMsg(v1);
  check('V: request text is sent in <regeneration_request>, both lines', /<regeneration_request>[\s\S]*Make it shorter\.\nMention the gold marks\.[\s\S]*<\/regeneration_request>/.test(vu));
  check('V: regenerate uses the CURRENT intensity (Heavy-handed)', /## Rewrite intensity: Heavy-handed\nHEAVY-HANDED\./.test(v1.messages[0].content) && !/LIGHT TOUCH\./.test(v1.messages[0].content));
  check('V: box is cleared after use; attempt 2 remembers request + intensity', (await cur.locator('.lorerev_regen_text').inputValue()) === '' && (await cur.locator('.lorerev_attempt_info').textContent()).includes('Make it shorter.') && /Heavy-handed/.test(await cur.locator('.lorerev_attempt_info').textContent()));
  await cur.locator('.lorerev_swipe.fa-chevron-left').click();
  check('V: attempt 1 has no request, shows its own intensity', !/Your request/.test(await cur.textContent()) && /Light touch/.test(await cur.locator('.lorerev_attempt_info').textContent()));
  await cur.locator('.lorerev_swipe.fa-chevron-right').click();
  await shot('36-regen-request-remembered.png');
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Currency}}","content":"Third."}]' }]);
  await cur.locator('.lorerev_regen_text').fill('Third try: be creative.');
  await cur.locator('.lorerev_btn_regen').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lorerev_session')].at(-1).querySelector('.lorerev_pager')?.textContent.includes('3/3'));
  const vu3 = userMsg(await lastReq());
  check('V: earlier attempts go back to the model with their own request', /<attempt n="2" user_request="Make it shorter\.\\nMention the gold marks\.">/.test(vu3) && /Third try: be creative\./.test(vu3.slice(vu3.indexOf('<regeneration_request>'))));
  check('U: intensity persisted in settings', (await page.evaluate(() => SillyTavern.getContext().extensionSettings.LoreReviser.intensity)) === 'heavy');

  // ================= W. Clear chat =================
  const dlg = () => page.locator('dialog[open]').last();
  const sessionsBefore = await page.locator('.lorerev_session').count();
  await page.click('#lorerev_clear');
  await dlg().locator('.popup-button-ok').waitFor();
  check('W: confirm mentions the unapproved proposals', /proposed change.*not been approved or rejected/.test(await dlg().textContent()));
  await shot('37-clear-confirm.png');
  await dlg().locator('.popup-button-cancel').click();
  await page.waitForTimeout(500);
  check('W: "Keep" leaves everything in place', (await page.locator('.lorerev_session').count()) === sessionsBefore && (await page.locator('dialog[open]').count()) === 1);
  await page.click('#lorerev_clear');
  await dlg().locator('.popup-button-ok').click();
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 0);
  check('W: chat emptied (messages and cards)', (await page.locator('.lorerev_msg').count()) === 0 && /Pick lore entries/.test(await page.locator('#lorerev_chat').textContent()));
  check('W: settings and selection kept', (await page.inputValue('#lorerev_intensity')) === 'heavy' && (await page.inputValue('#lorerev_depth')) === '-1' && (await page.textContent('#lorerev_selected_info')) === '5 entries selected in 4 book(s)', await page.textContent('#lorerev_selected_info'));
  await shot('38-chat-cleared.png');
  await fake.reset();
  await fake.queue([{ content: '[]' }]);
  await send('W: still works after clearing.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 1);
  await page.click('#lorerev_clear'); // nothing pending -> no confirm
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 0);
  check('W: clearing with nothing pending needs no confirmation', (await page.locator('dialog[open]').count()) === 1);

  // ================= X. editable system-message parts (intensity wording + reply format rules) =================
  await page.selectOption('#lorerev_intensity', 'light');
  await page.click('#lorerev_int_box summary');
  await page.fill('.lorerev_int_text[data-level="light"]', 'LIGHT (mine): touch only the currency line.');
  await page.click('#lorerev_rules_box summary');
  const CUSTOM_RULES = '## Reply format (mine)\nReply with ONE JSON array of {id, keys?, secondary_keys?, content?, note?} objects, nothing else.';
  await page.fill('#lorerev_rules', CUSTOM_RULES);
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Currency}}","content":"Silver crowns and gold marks."}]' }]);
  await send('X: change the currency.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 1);
  const xSys = await sysOf();
  check('X: edited Light wording is in the system message under the FIXED heading', xSys.includes('## Rewrite intensity: Light touch\nLIGHT (mine): touch only the currency line.') && !/LIGHT TOUCH\. Change only/.test(xSys));
  check('X: edited rules replace the default rules, and come last', xSys.endsWith(CUSTOM_RULES) && !xSys.includes('## Reply format (strict)'));
  check('X: system prompt text itself unchanged and still refers to the Rewrite intensity section', /Rewrite intensity/.test(xSys.split('## Rewrite intensity:')[0]));
  check('X: acceptable rules -> no warning in the chat', (await page.locator('.lorerev_msg.lorerev_warn:has-text("reply format rules")').count()) === 0);
  await page.click('[data-restore="light"]');
  await page.click('#lorerev_rules_reset');
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Currency}}","content":"Silver crowns and gold marks."}]' }]);
  await send('X: again with defaults.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 2);
  const xDef = await sysOf();
  check('X: Restore default puts the original wording and rules back in the request', /## Rewrite intensity: Light touch\nLIGHT TOUCH\. Change only what MUST change/.test(xDef) && xDef.includes('## Reply format (strict)') && !xDef.includes('(mine)'));
  check('X: restored defaults leave no overrides in settings', await page.evaluate(() => { const s = SillyTavern.getContext().extensionSettings.LoreReviser; return JSON.stringify(s.intensityTexts) === '{}' && s.formatRules === ''; }));
  // rules that would break parsing: loud warning in the UI and in the chat, request still goes out, the (bad) reply is handled
  await page.fill('#lorerev_rules', 'Reply as a short poem.');
  check('X: UI warns about rules that break parsing', (await page.isVisible('#lorerev_rules_warn')) && /JSON array of \{id, keys\?, secondary_keys\?, content\?, note\?\}/.test(await page.textContent('#lorerev_rules_warn')));
  await fake.reset();
  await fake.queue([{ content: 'Roses are red, violets are blue.' }]);
  await send('X: with broken rules.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_msg').length > 0 && /may break reading/.test(document.querySelector('#lorerev_chat').textContent));
  await page.waitForFunction(() => !document.querySelector('.lorerev_loading'), null, { timeout: 15000 }).catch(() => {});
  check('X: chat warns that edited rules may break reading; request still sent with them', /Reply as a short poem\./.test(await sysOf()) && /Sending anyway/.test(await page.locator('#lorerev_chat').textContent()));
  await page.click('#lorerev_int_box summary'); await page.click('#lorerev_rules_box summary'); // collapse so the chat is visible
  await shot('40-rules-warning-chat.png');
  await page.click('#lorerev_rules_box summary');
  await page.click('#lorerev_rules_reset');
  await page.click('#lorerev_rules_box summary');
  await page.fill('#lorerev_input', '');

  // ================= Y. change type: Development (default) / Retcon, editable wording, applies on Send and Regenerate =================
  check('Y: default change type is Development', (await page.inputValue('#lorerev_changetype')) === 'development');
  const nSess = await page.locator('.lorerev_session').count();
  const REPLY_Y = [{ content: '[{"id":"{{id:Currency}}","content":"Silver crowns and gold marks."}]' }];
  await fake.reset(); await fake.queue(REPLY_Y);
  await send('Y: development send.');
  await page.waitForFunction((n) => document.querySelectorAll('.lorerev_session').length === n + 1, nSess);
  const yDev = await sysOf();
  check('Y: Development section sits after the intensity section and before the reply format', /## Rewrite intensity: [^\n]+\n[\s\S]+\n\n## Change type: Development\nDEVELOPMENT\. [\s\S]*progression in the story[\s\S]*\n\n## Reply format \(strict\)/.test(yDev) && !/RETCON\./.test(yDev));
  check('Y: system prompt refers to the "Change type" section', /Follow the "Change type" section/.test(yDev));
  check('Y: attempt shows the change type', /Change type: Development/.test(await card('Currency').locator('.lorerev_attempt_info').textContent()));
  await page.selectOption('#lorerev_changetype', 'retcon');
  await fake.reset(); await fake.queue(REPLY_Y);
  await send('Y: retcon send.');
  await page.waitForFunction((n) => document.querySelectorAll('.lorerev_session').length === n + 2, nSess);
  const yRet = await sysOf();
  check('Y: Retcon wording replaces Development, forbids acknowledging the change', /## Change type: Retcon\nRETCON\. /.test(yRet) && /always true/.test(yRet) && /"no longer"/.test(yRet) && /"recently"/.test(yRet) && /"became"/.test(yRet) && !/DEVELOPMENT\./.test(yRet));
  check('Y: attempt shows Retcon', /Change type: Retcon/.test(await card('Currency').locator('.lorerev_attempt_info').textContent()));
  // regenerate uses the CURRENT type
  await page.selectOption('#lorerev_changetype', 'development');
  await fake.reset(); await fake.queue([{ content: '[{"id":"{{id:Currency}}","content":"Gold marks."}]' }]);
  await card('Currency').locator('.lorerev_btn_regen').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lorerev_session')].at(-1).querySelector('.lorerev_pager')?.textContent.includes('2/2'));
  check('Y: regenerate uses the current change type', /## Change type: Development\nDEVELOPMENT\./.test(await sysOf()) && /Change type: Development/.test(await card('Currency').locator('.lorerev_attempt_info').textContent()));
  await card('Currency').locator('.lorerev_swipe.fa-chevron-left').click();
  check('Y: attempt 1 keeps the type it was made with', /Change type: Retcon/.test(await card('Currency').locator('.lorerev_attempt_info').textContent()));
  // editable wording + Restore default
  await page.selectOption('#lorerev_changetype', 'retcon');
  await page.click('#lorerev_ct_box summary');
  await page.fill('.lorerev_ct_text[data-type="retcon"]', 'RETCON (mine): write it as always true.');
  check('Y: only the edited type is stored', JSON.stringify(await page.evaluate(() => SillyTavern.getContext().extensionSettings.LoreReviser.changeTypeTexts)) === '{"retcon":"RETCON (mine): write it as always true."}' && (await page.evaluate(() => SillyTavern.getContext().extensionSettings.LoreReviser.changeType)) === 'retcon');
  await page.evaluate(() => document.querySelector('#lorerev_ct_box').scrollIntoView({ block: 'start' }));
  await shot('42-change-type.png');
  await fake.reset(); await fake.queue(REPLY_Y);
  await send('Y: edited retcon wording.');
  await page.waitForFunction((n) => document.querySelectorAll('.lorerev_session').length === n + 3, nSess);
  const yEd = await sysOf();
  check('Y: edited wording used under the fixed heading', yEd.includes('## Change type: Retcon\nRETCON (mine): write it as always true.') && !/RETCON\. The change/.test(yEd));
  await page.click('[data-restore-ct="retcon"]');
  check('Y: Restore default brings the original wording back and clears the override', (await page.inputValue('.lorerev_ct_text[data-type="retcon"]')).startsWith('RETCON. The change is') && (await page.evaluate(() => JSON.stringify(SillyTavern.getContext().extensionSettings.LoreReviser.changeTypeTexts))) === '{}');
  const hdr = await page.$$eval('.lorerev_header > *', els => els.map(e => e.getBoundingClientRect()).filter(r => r.width).map(r => Math.round(r.right)));
  check('Y: header controls fit inside the modal', Math.max(...hdr) <= (await page.locator('.lorerev_root').boundingBox()).x + (await page.locator('.lorerev_root').boundingBox()).width + 1);
  await page.click('#lorerev_ct_box summary');
  await page.selectOption('#lorerev_changetype', 'development');

  check('lorebooks back exactly as they were (every approval in this flow was undone)', (await snapshot()) === before);
  // ================= Z. WI budget: the PROFILE's context (not ST's Text Completion slider), note only on a real cut =================
  // Bug: ctx.maxContext is only the Text Completion context slider. A Chat Completion user with 262144 context and a 50%
  // budget got budget = 50% of the slider value, so a modest lorebook "overflowed" and the note appeared.
  await page.fill('#lorerev_context', '0');
  // a modest lorebook: one extra constant entry of a few hundred tokens (restored at the end)
  const LONG = Array.from({ length: 40 }, (_, i) => `In year ${i + 1} of the old calendar the river guilds kept their records in the archive.`).join(' ');
  await page.evaluate(async (long) => {
    const c = SillyTavern.getContext();
    const data = await c.loadWorldInfo('Global Lore'); window.__zBook = structuredClone(data);
    data.entries[9] = { ...structuredClone(data.entries[1]), uid: 9, comment: 'Archive History', key: ['archive'], content: long, constant: true, displayIndex: 9 };
    await c.saveWorldInfo('Global Lore', data, true);
  }, LONG);
  const setCC = () => page.evaluate(() => { const c = SillyTavern.getContext(); c.chatCompletionSettings.openai_max_context = 262144; c.chatCompletionSettings.openai_max_tokens = 300; });
  await page.evaluate(() => {
    const c = SillyTavern.getContext();
    window.__z = { tc: $('#max_context').val(), pct: $('#world_info_budget').val(), cap: $('#world_info_budget_cap').val(), cc: c.chatCompletionSettings.openai_max_context, mt: c.chatCompletionSettings.openai_max_tokens };
    $('#max_context').val(512).trigger('input');
    $('#world_info_budget').val(50).trigger('input');
    $('#world_info_budget_cap').val(0).trigger('input');
    c.chatCompletionSettings.openai_max_context = 262144;
    c.chatCompletionSettings.openai_max_tokens = 300;
  });
  const control = await page.evaluate(async () => {
    const wi = await import('/scripts/world-info.js'); const c = SillyTavern.getContext();
    let over = false; const on = (a) => { if (a?.budget?.overflowed) over = true; };
    c.eventSource.on(c.eventTypes.WORLDINFO_SCAN_DONE, on);
    const realW = toastr.warning; toastr.warning = () => {};
    try { await wi.checkWorldInfo(c.chat.filter(m => !m.is_system).map(m => `${m.name}: ${m.mes}`).reverse(), c.maxContext, true, {}); } finally { toastr.warning = realW; c.eventSource.removeListener(c.eventTypes.WORLDINFO_SCAN_DONE, on); }
    return { maxContext: c.maxContext, over, pct: wi.world_info_budget };
  });
  check('Z: repro - the old call (ctx.maxContext = Text Completion slider) overflows a modest lorebook at 50%', control.maxContext === 512 && control.pct === 50 && control.over, JSON.stringify(control));
  const zSess = await page.locator('.lorerev_session').count();
  const zWarns = await page.locator('.lorerev_msg.lorerev_warn', { hasText: 'World Info budget' }).count();
  wiLogs.length = 0;
  await fake.reset(); await fake.queue([{ content: '[]' }]);
  await setCC();
  await send('Z: budget with a big Chat Completion context.');
  await page.waitForFunction((n) => document.querySelectorAll('.lorerev_session').length === n + 1, zSess);
  check('Z: scan uses the profile\'s Chat Completion context minus response length', /context 262144 \(your current Chat Completion settings\) - response 300 = 261844; budget 50% = 130922 tokens/.test(wiLogs.at(-1) ?? '') && /overflowed: false/.test(wiLogs.at(-1) ?? ''), wiLogs.at(-1));
  check('Z: no budget note with 262144 context and 50% budget', (await page.locator('.lorerev_msg.lorerev_warn', { hasText: 'World Info budget' }).count()) === zWarns);
  check('Z: active lore is complete (the long constant entry is in it)', userMsg(await lastReq()).includes(LONG));
  // a real cut: cap the budget; the note gives the numbers, the cap and where the context came from, and names what was cut
  await page.evaluate(() => $('#world_info_budget_cap').val(12).trigger('input'));
  wiLogs.length = 0;
  await fake.reset(); await fake.queue([{ content: '[]' }]);
  await setCC();
  await send('Z: with a budget cap.');
  await page.waitForFunction((n) => document.querySelectorAll('.lorerev_session').length === n + 2, zSess);
  const zNote = (await page.locator('.lorerev_msg.lorerev_warn', { hasText: 'World Info budget' }).allTextContents()).at(-1) ?? '';
  check('Z: real cut -> note with used/allowed tokens, the cap and the context source', /World Info budget was reached/.test(zNote) && /about \d+ of 12 tokens used/.test(zNote) && /capped at 12 tokens by your "Budget Cap" setting/.test(zNote) && /context 262144 from your current Chat Completion settings, minus 300 response tokens/.test(zNote) && /It left out \d+ (entry|entries)/.test(zNote), zNote);
  console.log('Z note:', zNote);
  await page.locator('.lorerev_msg.lorerev_warn', { hasText: 'World Info budget' }).last().scrollIntoViewIfNeeded();
  await page.evaluate(() => { const ch = document.querySelector('#lorerev_chat'); const n = [...ch.querySelectorAll('.lorerev_msg.lorerev_warn')].filter(m => /World Info budget/.test(m.textContent)).at(-1); ch.scrollTop = n.offsetTop - ch.offsetTop - 40; });
  await shot('43-budget-note-numbers.png');
  // the user's Context box wins
  await page.evaluate(() => $('#world_info_budget_cap').val(0).trigger('input'));
  await page.fill('#lorerev_context', '1000');
  wiLogs.length = 0;
  await fake.reset(); await fake.queue([{ content: '[]' }]);
  await setCC();
  await send('Z: with the Context box.');
  await page.waitForFunction((n) => document.querySelectorAll('.lorerev_session').length === n + 3, zSess);
  check('Z: the "Context" box overrides the context used for the budget', /context 1000 \(your "Context" box in LoreReviser\) - response 300 = 700; budget 50% = 350 tokens/.test(wiLogs.at(-1) ?? ''), wiLogs.at(-1));
  await page.fill('#lorerev_context', '0');
  await page.evaluate(() => { const z = window.__z, c = SillyTavern.getContext();
    $('#max_context').val(z.tc).trigger('input'); $('#world_info_budget').val(z.pct).trigger('input'); $('#world_info_budget_cap').val(z.cap).trigger('input');
    c.chatCompletionSettings.openai_max_context = z.cc; c.chatCompletionSettings.openai_max_tokens = z.mt; });
  await page.evaluate(async () => SillyTavern.getContext().saveWorldInfo('Global Lore', window.__zBook, true));

} catch (e) {
  console.log('TEST ERROR', e); failures++;
  try { const pg = browser.contexts()[0].pages()[0]; console.log('TOASTS:', await pg.locator('.toast-message').allTextContents()); console.log('LAST SESSION:', (await pg.locator('.lorerev_session').last().textContent()).slice(0, 1500)); await pg.screenshot({ path: `${SHOTS}/zz-failure.png` }); } catch {}
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
