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
  const send = async (instruction) => { await page.fill('#lorerev_input', instruction); await page.click('#lorerev_send'); };
  const session = () => page.locator('.lorerev_session').last();
  const card = (title) => session().locator('.lorerev_card').filter({ has: page.locator('.lorerev_card_title > b', { hasText: new RegExp(`^${title}$`) }) });
  const pill = (title) => card(title).locator('.lorerev_pill');
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
  check('A: diff shows 54 -> 55', (await card('Queen Maren').locator('.lorerev_del').allTextContents()).join('').includes('54') && (await card('Queen Maren').locator('.lorerev_ins').allTextContents()).join('').includes('55'));
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

  // ================= B. approve = mark only, nothing written =================
  await card('Queen Maren').locator('.lorerev_btn_ok').click();
  check('B: approved pill', (await pill('Queen Maren').textContent()) === 'Approved');
  check('B: note says nothing saved yet', /nothing was saved yet/.test(await card('Queen Maren').textContent()));
  check('B: lorebooks untouched after approve', (await snapshot()) === before);
  await page.screenshot({ path: `${SHOTS}/15-approved.png` });
  await card('Queen Maren').locator('.menu_button', { hasText: 'Undo' }).click();
  check('B: undo -> proposed', (await pill('Queen Maren').textContent()) === 'Proposed');

  // ================= C. inline edit =================
  await card('Queen Maren').locator('.menu_button', { hasText: 'Edit' }).click();
  await card('Queen Maren').locator('.lorerev_edit input').first().fill('Maren, queen, wise');
  await card('Queen Maren').locator('.lorerev_edit textarea').fill('Edited by the user, 55 years old.');
  await page.screenshot({ path: `${SHOTS}/16-edit.png` });
  await card('Queen Maren').locator('.menu_button', { hasText: 'Save edit' }).click();
  check('C: marked as edited', /edited by you/.test(await card('Queen Maren').textContent()));
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
  await fake.queue([{ finish_reason: 'length', content: '[{"id":"{{id:Queen Maren}}","content":"New text A"},{"id":"{{id:The Missing Heir}}","content":"New text B"},{"id":"{{id:Kingdom of Eldoria}}","content":"cut off mid-sen' }]);
  await send('Second pass: tidy everything.');
  await page.waitForFunction(() => document.querySelectorAll('.lorerev_session').length === 2);
  check('G: truncation warning', /cut off/.test(await session().locator('.lorerev_session_notes').textContent()));
  check('G: complete entries recovered', (await pill('Queen Maren').textContent()) === 'Proposed' && (await pill('The Missing Heir').textContent()) === 'Proposed');
  check('G: unreturned entry flagged, not "no changes"', (await pill('Kingdom of Eldoria').textContent()) === 'Not returned');
  await page.screenshot({ path: `${SHOTS}/18-truncated.png` });

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

  check('lorebooks never written during the whole flow', (await snapshot()) === before);
} catch (e) {
  console.log('TEST ERROR', e); failures++;
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
