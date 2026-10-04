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
  const sentLogs = [];
  page.on('console', m => { if (/\[LoreReviser\] entries requested/.test(m.text())) sentLogs.push(m.text()); });
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

  // snapshot of all lorebooks, to prove nothing is written in this milestone
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
  check('A: request: character card', /<character_card>\nCharacter: Test Queen/.test(u1) && /Description:\nA queen\./.test(u1));
  check('A: request: active lore (constant entry)', /<active_lore>[\s\S]*Silver crowns\.[\s\S]*<\/active_lore>/.test(u1));
  check('A: request: depth 3 -> last 3 messages only', /messages="3 of 8"/.test(u1) && u1.includes('Message number 8') && u1.includes('Message number 6') && !u1.includes('Message number 5'));
  check('A: request: hidden message excluded', !u1.includes('hidden message'));
  check('A: request: full entry content and keys with ids', /<entry id="E\d" book="Eldoria" title="Queen Maren">\n<keys>\["Maren","queen"\]<\/keys>[\s\S]*Stern but fair monarch, 54 years old\./.test(u1));
  check('A: request: instructions', u1.includes('<instructions>\nThe queen turned 55'));
  check('A: one request only', (await fake.requests()).length === 1);
  const reqIds = (u) => [...u.matchAll(/<entry id="(E\d+)"/g)].map(m => m[1]);
  check('A: every requested entry id is in <entries_to_revise>, in full (console log + request)', reqIds(u1).length === 3 && /requested: E1,E2,E3; entries in prompt: E1,E2,E3/.test(sentLogs.at(-1) ?? ''), `${reqIds(u1)} | ${sentLogs.at(-1)}`);

  // ================= B. approve = mark only, nothing written =================
  await card('Queen Maren').locator('.lorerev_btn_ok').click();
  check('B: approved pill', (await pill('Queen Maren').textContent()) === 'Approved');
  check('B: note says nothing saved yet', /nothing was saved yet/.test(await card('Queen Maren').textContent()));
  check('B: lorebooks untouched after approve', (await snapshot()) === before);
  await page.screenshot({ path: `${SHOTS}/15-approved.png` });
  await card('Queen Maren').locator('.menu_button', { hasText: 'Undo' }).click();
  check('B: undo -> proposed', (await pill('Queen Maren').textContent()) === 'Proposed');

  // ================= C. inline edit =================
  await card('Queen Maren').locator('.menu_button', { hasText: /^Edit$/ }).click();
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
  await card('Queen Maren').locator('.menu_button', { hasText: 'Regenerate…' }).click();
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
  await card('Queen Maren').locator('.lorerev_pg', { hasText: '‹' }).click();
  check('D: page back -> attempt 1 (the edited one)', (await card('Queen Maren').locator('.lorerev_pager').textContent()).includes('1/2') && (await card('Queen Maren').locator('.lorerev_text').textContent()).startsWith('Edited by the user'));
  await page.screenshot({ path: `${SHOTS}/17-regenerate-pager.png` });
  await card('Queen Maren').locator('.lorerev_pg', { hasText: '›' }).click();
  check('D: page forward -> 2/2', (await card('Queen Maren').locator('.lorerev_pager').textContent()).includes('2/2'));

  // regenerate an entry that had "no changes"
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Kingdom of Eldoria}}","content":"A northern kingdom ruled by Queen Maren the Wise."}]' }]);
  await card('Kingdom of Eldoria').locator('.menu_button', { hasText: 'Regenerate…' }).click();
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
  await card('Queen Maren').locator('.menu_button', { hasText: 'Regenerate…' }).click();
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
  check('L: size warning shown but request still sent', /may not fit/.test(warnText) && (await fake.requests()).length === 1, warnText);
  check('L: reply tokens setting used', (await lastReq()).max_tokens === 777);
  await page.screenshot({ path: `${SHOTS}/23-token-warning.png` });
  await page.fill('#lorerev_context', '0'); await page.fill('#lorerev_reply', '0');

  // ================= M. reopen the modal: sessions stay and still work =================
  await page.click('dialog[open] .popup-button-ok');
  await page.waitForTimeout(600);
  await page.click('#extensionsMenuButton'); await page.click('#lorereviser_open');
  await page.waitForSelector('.lorerev_book');
  check('M: sessions kept after reopen', (await page.locator('.lorerev_session').count()) === 5);
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
  check('N: console log shows requested == sent', (() => { const m = (sentLogs.at(-1) ?? '').match(/requested: (\S+); entries in prompt: (\S+)/); return !!m && m[1] === m[2]; })(), sentLogs.at(-1));
  await shot('24-lore-budget-note.png');
  // with the alert off and a normal budget there is no note
  await page.evaluate(() => { $('#world_info_overflow_alert').prop('checked', false).trigger('change'); $('#world_info_budget_cap').val(0).trigger('input'); });
  await fake.reset();
  await fake.queue([{ content: '[]' }]);
  const warnsBefore = await page.locator('.lorerev_msg.lorerev_warn').count();
  await send('No budget issue now.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 7);
  check('N: no note when the budget is fine', (await page.locator('.lorerev_msg.lorerev_warn').count()) === warnsBefore);

  // ================= O. block-level views with realistic multi-sentence text =================
  await pick('Persona Lore', ['Traveler Backstory']);
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Traveler Backstory}}","keys":["traveler","Saltmere","cartographer"],"content":"You grew up in the fishing village of Saltmere, the youngest of five children. Your father mended nets and your mother ran a stall of smoked eel at the harbor market. You learned to read from the tide tables nailed to the harbor wall.\\nAt seventeen you left for the capital to apprentice with a cartographer. You are quietly proud of your maps, though you rarely show them to anyone. Since the queen\'s coronation you have been mapping the Silverwood border in secret, and you no longer trust anyone at court. You still carry your father\'s brass compass everywhere.","note":"Added the secret border survey from the latest chat."}]' }]);
  await send('Add that the traveler is secretly mapping the Silverwood border for the queen.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 8);
  const tcard = card('Traveler Backstory');
  check('O: compare is the default view, one aligned row old | new', (await tcard.locator('.lorerev_view_on').textContent()) === 'Compare' && (await tcard.locator('.lorerev_row:not(.lorerev_col_title) .lorerev_cell').count()) === 2);
  check('O: both paragraphs changed -> 2 removed blocks left, 2 added blocks right', (await tcard.locator('.lorerev_para_del').count()) === 2 && (await tcard.locator('.lorerev_para_ins').count()) === 2);
  const cellText = (i) => tcard.locator('.lorerev_row:not(.lorerev_col_title) .lorerev_cell').nth(i).textContent();
  check('O: old cell has the whole old text, new cell the whole new text', (await cellText(0)).includes('mother sold smoked eel') && (await cellText(0)).includes('rarely show them') && (await cellText(1)).includes('in secret') && (await cellText(1)).includes('ran a stall'));
  await tcard.scrollIntoViewIfNeeded();
  await shot('25-block-compare.png');
  await tcard.locator('.lorerev_view', { hasText: 'Changes' }).click();
  check('O: Changes view: removed blocks followed by added blocks, unchanged sentences dimmed', (await tcard.locator('.lorerev_blk_del').count()) >= 1 && (await tcard.locator('.lorerev_blk_ins').count()) >= 1 && (await tcard.locator('.lorerev_blk_same').count()) >= 1);
  const order = await tcard.locator('.lorerev_blk').evaluateAll(els => els.map(e => e.className.replace(/.*lorerev_blk_/, '')).join(','));
  check('O: in Changes every removed block is directly followed by its added block', /del,ins/.test(order) && !/ins,del/.test(order), order);
  await shot('26-block-changes.png');
  await page.setViewportSize({ width: 600, height: 900 });
  await tcard.locator('.lorerev_view', { hasText: 'Compare' }).click();
  const stacked = await tcard.locator('.lorerev_row:not(.lorerev_col_title) .lorerev_cell').evaluateAll(els => els[1].getBoundingClientRect().top > els[0].getBoundingClientRect().bottom - 2);
  check('O: narrow screen stacks old above new', stacked);
  await tcard.scrollIntoViewIfNeeded();
  await shot('27-block-compare-narrow.png');
  await page.setViewportSize({ width: 1400, height: 900 });

  // ================= P. editing works in every state; committed text = edit box =================
  const EDIT = 'Exactly my text.\n\n  Two  spaces and a {{user}} macro stay as typed.  ';
  const editBtn = (t) => card(t).locator('.menu_button', { hasText: /^Edit$/ });
  const edit = async (t, text, keys) => {
    await editBtn(t).click();
    if (keys !== undefined) await card(t).locator('.lorerev_ed_keys').fill(keys);
    await card(t).locator('.lorerev_ed_content').fill(text);
    await card(t).locator('.lorerev_btn_save').click();
  };
  await tcard.locator('.lorerev_btn_ok').click();
  check('P: approved card still has Edit', (await editBtn('Traveler Backstory').count()) === 1);
  await edit('Traveler Backstory', EDIT);
  check('P: editing an approved card puts it back to Proposed with re-approve notice + "Edited by you"', (await pill('Traveler Backstory').textContent()) === 'Proposed' && /Approve it again/.test(await tcard.textContent()) && /Edited by you/.test(await tcard.locator('.lorerev_card_title').textContent()));
  await shot('28-edited-reapprove.png');
  await tcard.locator('.lorerev_btn_ok').click();
  check('P: re-approval works', (await pill('Traveler Backstory').textContent()) === 'Approved' && !/Approve it again/.test(await tcard.textContent()));
  await tcard.locator('.lorerev_view', { hasText: 'New' }).click();
  check('P: approved text is exactly the edit box content (whitespace included)', (await tcard.locator('.lorerev_text').textContent()) === EDIT);
  // reopen the editor: the box holds exactly what was approved
  await editBtn('Traveler Backstory').click();
  check('P: editor reloads the exact text', (await tcard.locator('.lorerev_ed_content').inputValue()) === EDIT);
  await tcard.locator('.menu_button', { hasText: 'Cancel' }).click();
  // regenerate -> page between attempts -> edit attempt 1 only
  await tcard.locator('.menu_button', { hasText: 'Undo' }).click();
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Traveler Backstory}}","content":"Second attempt text."}]' }]);
  await tcard.locator('.menu_button', { hasText: 'Regenerate…' }).click();
  await tcard.locator('.lorerev_regen .menu_button').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lorerev_session')].at(-1).querySelector('.lorerev_pager')?.textContent.includes('2/2'));
  await tcard.locator('.lorerev_view', { hasText: 'New' }).click();
  await edit('Traveler Backstory', 'Edited attempt two.');
  check('P: edit on attempt 2 applies to attempt 2', (await tcard.locator('.lorerev_text').textContent()) === 'Edited attempt two.' && /2\/2/.test(await tcard.locator('.lorerev_pager').textContent()));
  await tcard.locator('.lorerev_pg', { hasText: '‹' }).click();
  check('P: attempt 1 is untouched (still the edited-by-me text, not attempt 2)', (await tcard.locator('.lorerev_text').textContent()) === EDIT);
  await edit('Traveler Backstory', 'Edited attempt one.');
  await tcard.locator('.lorerev_pg', { hasText: '›' }).click();
  check('P: attempt 2 keeps its own edit', (await tcard.locator('.lorerev_text').textContent()) === 'Edited attempt two.');
  // reset to the model's version
  await editBtn('Traveler Backstory').click();
  await tcard.locator('.lorerev_btn_reset').click();
  check("P: reset restores the model's text and clears the edited badge", (await tcard.locator('.lorerev_text').textContent()) === 'Second attempt text.' && !/Edited by you/.test(await tcard.locator('.lorerev_card_title').textContent()));
  // edit after reject
  await tcard.locator('.lorerev_btn_no').click();
  check('P: rejected card has Edit', (await editBtn('Traveler Backstory').count()) === 1);
  await edit('Traveler Backstory', 'Edited after reject.', 'traveler, Saltmere');
  check('P: edit after reject -> Proposed again, keys saved', (await pill('Traveler Backstory').textContent()) === 'Proposed' && (await tcard.locator('.lorerev_chip_ins').allTextContents()).join('|') === 'Saltmere');
  // edit on an entry the model left unchanged
  const other = card('The Missing Heir');
  check('P: an unchanged card has Edit', (await editBtn('The Missing Heir').count()) === 1);
  await edit('The Missing Heir', 'Prince Aldric vanished last winter. He was last seen near the Silverwood.');
  check('P: editing a "No changes" entry creates your own proposal', (await pill('The Missing Heir').textContent()) === 'Proposed' && /Written by you/.test(await other.textContent()) && /Edited by you/.test(await other.locator('.lorerev_card_title').textContent()));
  await other.locator('.lorerev_btn_ok').click();
  check('P: ...which can be approved', (await pill('The Missing Heir').textContent()) === 'Approved');
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
  await fc.locator('.lorerev_view', { hasText: /^Compare$/ }).click();
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

  check('lorebooks never written during the whole flow', (await snapshot()) === before);
} catch (e) {
  console.log('TEST ERROR', e); failures++;
  try { const pg = browser.contexts()[0].pages()[0]; console.log('TOASTS:', await pg.locator('.toast-message').allTextContents()); console.log('LAST SESSION:', (await pg.locator('.lorerev_session').last().textContent()).slice(0, 1500)); await pg.screenshot({ path: `${SHOTS}/zz-failure.png` }); } catch {}
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
