// End-to-end test of the "Changed passages only" reply style against the fake model server: the model sends find/replace
// edits, LoreReviser builds the full text, the cards show the right diff, Approve saves the full correct text; edits that
// can't be placed mark the entry "Couldn't apply" with the passages listed and a working "Retry this entry as a full rewrite".
// Needs: a FRESH ST on :8766 (tests/start-test-st.sh), node tests/fixtures.mjs, node tests/fake-openai.mjs 9099.
import { chromium } from 'playwright-core';
const SHOTS = process.env.SHOTS_DIR ?? '/workspace/LoreReviser-shots';
const FAKE = 'http://127.0.0.1:9099';
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} ${ok ? '' : extra}`); if (!ok) failures++; };
const fake = {
  reset: () => fetch(`${FAKE}/__reset`, { method: 'POST' }),
  queue: (replies) => fetch(`${FAKE}/__queue`, { method: 'POST', body: JSON.stringify(replies) }),
  requests: async () => (await fetch(`${FAKE}/__requests`)).json(),
};
const FEST = 'The Festival of Lanterns is held each autumn in the harbor town of Saltmere. Every household floats a paper lantern for someone they have lost.\nThe festival is run by the Harbor Guild. The guild master lights the first lantern at dusk, and nobody may speak until the last one has drifted past the lighthouse.\nChildren are told that the lanterns guide the dead home. Sailors say the lanterns are only there to keep the fishing boats from the rocks.\nThe week after the festival, the town holds a market where the guild sells the remaining lantern paper at half price.';
const MAREN = 'Stern but fair monarch, 54 years old.';
const TRAVELER_END = "You distrust nobles and carry your father's brass compass everywhere.";

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', e => { console.log('[pageerror]', e.message); failures++; });
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|status of 404|status of 500/.test(m.text())) console.log('[console error]', m.text().slice(0, 200)); });
  await page.goto('http://localhost:8766/');
  await page.waitForSelector('#send_textarea', { timeout: 60000 });
  try { const ok = page.locator('dialog[open] .popup-button-ok').first(); await ok.waitFor({ timeout: 8000 }); await ok.click(); } catch {}
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    const ctx = SillyTavern.getContext();
    ctx.powerUserSettings.persona_description_lorebook = 'Persona Lore';
    ctx.extensionSettings.connectionManager.profiles.push(
      { id: 'prof-fake', name: 'Fake Model', mode: 'cc', api: 'custom', model: 'fake-model', 'api-url': 'http://127.0.0.1:9099/v1' });
    await ctx.selectCharacterById(ctx.characters.findIndex(c => c.name === 'Test Queen'));
    await new Promise(r => setTimeout(r, 1500));
    await ctx.openCharacterChat('Test Queen - 2026-10-04@12h00m00s');
    for (let i = 0; i < 50 && !(ctx.chat.length >= 9); i++) await new Promise(r => setTimeout(r, 200));
  });

  // ---- helpers ----
  const api = (url, body) => page.evaluate(async ([u, b]) => (await fetch(u, { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify(b) })).json(), [url, body]);
  const entryOnServer = async (name, uid) => (await api('/api/worldinfo/get', { name })).entries[uid];
  const snapshot = () => page.evaluate(async () => {
    const out = {};
    for (const n of SillyTavern.getContext().getWorldInfoNames()) out[n] = await (await fetch('/api/worldinfo/get', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify({ name: n }) })).json();
    return JSON.stringify(out);
  });
  const openModal = async () => { await page.click('#extensionsMenuButton'); await page.click('#lorereviser_open'); await page.waitForSelector('.lorerev_book'); };
  const closeModal = async () => { await page.locator('dialog.lorerev_popup .popup-button-ok').click(); await page.waitForSelector('.lorerev_root', { state: 'detached' }); };
  const book = (name) => page.locator(`.lorerev_book[data-book="${name}"]`);
  async function pick(bookName, titles) {
    const b = book(bookName);
    if (!(await b.locator('.lorerev_entries').isVisible())) await b.locator('.lorerev_toggle').click();
    for (const t of titles) await b.locator('.lorerev_entry', { hasText: t }).locator('input').check();
  }
  const clearSelection = async () => { for (const cb of await page.locator('.lorerev_book_check').all()) { await cb.check(); await cb.uncheck(); } };
  const nSessions = () => page.locator('.lorerev_session').count();
  const send = async (instruction) => { const n = await nSessions(); await page.fill('#lorerev_input', instruction); await page.click('#lorerev_send'); await page.waitForFunction((k) => document.querySelectorAll('.lorerev_session').length === k + 1, n); };
  const session = () => page.locator('.lorerev_session').last();
  const card = (title) => session().locator('.lorerev_card').filter({ has: page.locator('.lorerev_card_title > b', { hasText: new RegExp(`^${title}$`) }) });
  const pill = (title) => card(title).locator('.lorerev_pill:not(.lorerev_pill_edited)');
  const settle = (c) => c.locator('.lorerev_saving').waitFor({ state: 'detached' });
  const approve = async (c) => { await c.locator('.lorerev_btn_ok').click(); await settle(c); };
  const isCollapsed = (c) => c.evaluate(el => el.classList.contains('lorerev_card_folded'));
  const expand = async (c) => { if (await isCollapsed(c)) await c.locator('.lorerev_card_title').click(); };
  const undo = async (c) => { await expand(c); await c.locator('.menu_button', { hasText: 'Undo' }).click(); await settle(c); };
  const view = async (c, name) => { await c.locator('.lorerev_view', { hasText: new RegExp(`^${name}$`) }).click(); };
  const newText = async (c) => { await view(c, 'New'); return c.locator('.lorerev_text').textContent(); };
  const lastReq = async () => (await fake.requests()).at(-1);
  const userMsg = (req) => req.messages.find(m => m.role === 'user').content;
  const sysMsg = (req) => req.messages[0].content;
  const shot = async (name) => { await page.evaluate(() => toastr.clear()); await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/${name}` }); };
  const before = await snapshot();

  await openModal();
  await page.selectOption('#lorerev_profile', 'prof-fake');

  // ================= 1. setting: default, persisted, hidden for new entries =================
  check('1: Reply style defaults to "Changed passages only (saves tokens)"', (await page.inputValue('#lorerev_replystyle')) === 'passages' && (await page.locator('#lorerev_replystyle option:checked').textContent()) === 'Changed passages only (saves tokens)');
  check('1: both styles offered', (await page.locator('#lorerev_replystyle option').allTextContents()).join('|') === 'Changed passages only (saves tokens)|Full rewrite');
  await page.locator('.lorerev_mode[data-mode="create"]').click();
  check('1: hidden in New entries mode (new entries are always written in full)', !(await page.locator('#lorerev_replystyle').isVisible()));
  await page.locator('.lorerev_mode[data-mode="revise"]').click();
  check('1: visible again in Revise mode', await page.locator('#lorerev_replystyle').isVisible());
  const hdr = await page.$$eval('.lorerev_header > *', els => els.map(e => e.getBoundingClientRect()).filter(r => r.width).map(r => Math.round(r.right)));
  const rootBox = await page.locator('.lorerev_root').boundingBox();
  check('1: header controls fit inside the modal', Math.max(...hdr) <= rootBox.x + rootBox.width + 1);

  // ================= 2. passage reply: exact edit, insertion, keys, unchanged; diff + approve =================
  await pick('Persona Lore', ['Festival of Lanterns']);
  await pick('Eldoria', ['Queen Maren', 'Kingdom of Eldoria']);
  await fake.reset();
  await fake.queue([{ content: JSON.stringify([
    { id: '{{id:Festival of Lanterns}}', edits: [
      { find: 'The guild master lights the first lantern at dusk', replace: 'The guild master, old Hesk, lights the first lantern at dusk' },
      { after: 'at half price.', insert: '\nThis year the market was cancelled after the storm.' }],
      note: 'Named the guild master and noted the cancelled market.' },
    { id: '{{id:Queen Maren}}', keys: ['Maren', 'queen', 'Maren the Wise'], edits: [{ find: '54 years old', replace: '55 years old' }], note: 'Birthday.' },
  ]) }]);
  await send('Name the guild master Hesk, the market was cancelled, and the queen turned 55.');
  const r2 = await lastReq();
  const s2 = sysMsg(r2);
  check('2: system message has the passages rules (find/replace, verbatim, short but unique), not the full-rewrite rules', s2.includes('Do NOT write out whole entries') && s2.includes('"find" is copied VERBATIM') && s2.includes('Keep each "find" short but unique') && !s2.includes('the complete new text of the entry (not a diff)'));
  check('2: heading rule kept in the passages rules + system prompt', s2.includes('Copy every existing heading and field label exactly') && s2.includes('When a "find" includes a heading or label, "replace" must contain it unchanged') && s2.includes('Keep every existing heading and field label exactly'));
  check('2: the entries are still sent in full so "find" can be copied', userMsg(r2).includes(FEST) && userMsg(r2).includes(MAREN));
  check('2: automatic reply budget used (4096 floor for small entries)', r2.max_tokens === 4096, String(r2.max_tokens));
  check('2: session header says "changed passages only"', /changed passages only/.test(await session().locator('.lorerev_session_head').textContent()));
  check('2: cards: two Proposed, the omitted entry "No changes"', (await pill('Festival of Lanterns').textContent()) === 'Proposed' && (await pill('Queen Maren').textContent()) === 'Proposed' && (await pill('Kingdom of Eldoria').textContent()) === 'No changes');
  const fc = card('Festival of Lanterns');
  const FEST_NEW = FEST.replace('The guild master lights', 'The guild master, old Hesk, lights') + '\nThis year the market was cancelled after the storm.';
  check('2: Changes is the default view and shows the changed and the added passage', (await fc.locator('.lorerev_view_on').textContent()) === 'Changes' && (await fc.locator('.lorerev_blk_del').count()) >= 1 && (await fc.locator('.lorerev_blk_ins').allTextContents()).some(t => t.includes('old Hesk')) && (await fc.locator('.lorerev_blk_ins').allTextContents()).some(t => t.includes('market was cancelled')));
  check('2: Changes view: untouched sentences dimmed as unchanged', (await fc.locator('.lorerev_blk_same').allTextContents()).some(t => t.includes('Children are told')));
  await fc.scrollIntoViewIfNeeded();
  await shot('60-passages-changes.png');
  check('2: New view = full text with both edits put in, everything else byte for byte', (await newText(fc)) === FEST_NEW, JSON.stringify(await fc.locator('.lorerev_text').textContent()));
  await view(fc, 'Old');
  check('2: Old view = the original', (await fc.locator('.lorerev_text').textContent()) === FEST);
  await view(fc, 'Full Compare');
  check('2: Full Compare shows the changed paragraph old | new', (await fc.locator('.lorerev_para_ins').allTextContents()).some(t => t.includes('old Hesk')) && (await fc.locator('.lorerev_para_del').allTextContents()).some(t => t.includes('The guild master lights')));
  check('2: attempt info says how the reply came in', /Reply: 2 changed passages, put into the full text\./.test(await fc.locator('.lorerev_attempt_info').textContent()));
  check('2: model note shown', (await fc.locator('.lorerev_note').textContent()) === 'Named the guild master and noted the cancelled market.');
  const mc = card('Queen Maren');
  check('2: keys + edit on the second entry', (await newText(mc)) === 'Stern but fair monarch, 55 years old.' && (await mc.locator('.lorerev_chip_ins').allTextContents()).includes('Maren the Wise'));
  // Edit proposal works on the built text (green parts only)
  await mc.locator('.lorerev_btn_edit').click();
  check('2: "Edit proposal" opens on the changed part of the built text', (await mc.locator('.lorerev_ed_hunk').count()) === 1 && /55 years old/.test(await mc.locator('.lorerev_ed_hunk').first().inputValue()));
  await mc.locator('.lorerev_edit .menu_button', { hasText: 'Cancel' }).click();
  // approve saves the full, correct text
  await approve(fc);
  check('2: Approve saves the FULL built text to the lorebook', (await entryOnServer('Persona Lore', 1)).content === FEST_NEW);
  await approve(mc);
  const mOnServer = await entryOnServer('Eldoria', 1);
  check('2: second entry saved with its keys', mOnServer.content === 'Stern but fair monarch, 55 years old.' && JSON.stringify(mOnServer.key) === '["Maren","queen","Maren the Wise"]');
  await undo(fc); await undo(mc);
  check('2: Undo puts both originals back', (await snapshot()) === before);

  // ================= 3. tolerant match: curly apostrophe + different spacing in "find" =================
  await clearSelection();
  await pick('Persona Lore', ['Traveler Backstory']);
  await fake.reset();
  await fake.queue([{ content: JSON.stringify([{ id: '{{id:Traveler Backstory}}', edits: [{ find: 'You distrust nobles and  carry your father’s brass compass everywhere.', replace: "You distrust nobles, though you now map the border for the queen, and you still carry your father's brass compass everywhere." }] }]) }]);
  await send('The traveler now maps the border for the queen.');
  const tc = card('Traveler Backstory');
  const tNew = await newText(tc);
  check('3: tolerant match (curly vs straight apostrophe, double space) placed the edit at the right spot', (await pill('Traveler Backstory').textContent()) === 'Proposed' && tNew.endsWith("you still carry your father's brass compass everywhere.") && !tNew.includes(TRAVELER_END) && tNew.startsWith('You grew up in the fishing village of Saltmere') && tNew.includes('\nAt seventeen'), JSON.stringify(tNew));

  // ================= 4. edits that can't be placed: card error, nothing applied, full-rewrite retry =================
  await clearSelection();
  await pick('Eldoria', ['Queen Maren']);
  await pick('Persona Lore', ['Festival of Lanterns']);
  await fake.reset();
  await fake.queue([{ content: JSON.stringify([
    { id: '{{id:Queen Maren}}', edits: [{ find: 'Stern but fair', replace: 'Stern yet fair' }, { find: 'Stern and fair ruler', replace: 'x' }], note: 'Tweaked wording.' },
    { id: '{{id:Festival of Lanterns}}', edits: [{ find: 'the lanterns', replace: 'the paper lanterns' }, { find: 'The festival is run by the Harbor Guild.', replace: 'The festival is run by the Harbor Guild and the temple.' }] },
  ]) }]);
  await send('Tweak the queen, and the temple helps with the festival.');
  check('4: entries whose edits do not fit are "Couldn\'t apply", not Proposed', (await pill('Queen Maren').textContent()) === "Couldn't apply" && (await pill('Festival of Lanterns').textContent()) === "Couldn't apply");
  check('4: session header counts them', /2 couldn't be applied/.test(await session().locator('.lorerev_session_head').textContent()));
  const qc = card('Queen Maren');
  const qErr = await qc.locator('.lorerev_place_error').textContent();
  check('4: card says nothing was applied (no partial edits) and lists the passage that could not be placed', /1 of its 2 passage edits could not be placed/.test(qErr) && /nothing was changed \(no partial edits\)/.test(qErr) && (await qc.locator('.lorerev_place_passage').allTextContents()).join('|') === 'Stern and fair ruler' && /not in the entry/.test(qErr), qErr);
  check('4: the model note is shown in the error box', /Tweaked wording\./.test(qErr));
  const fErr = await card('Festival of Lanterns').locator('.lorerev_place_error').textContent();
  check('4: ambiguous passage reported with its count', (await card('Festival of Lanterns').locator('.lorerev_place_passage').allTextContents()).join('|') === 'the lanterns' && /appears 2 times/.test(fErr), fErr);
  check('4: "Retry this entry as a full rewrite", Regenerate and Edit offered; no Approve', (await qc.locator('.lorerev_btn_fullretry').count()) === 1 && (await qc.locator('.lorerev_btn_regen').count()) === 1 && (await qc.locator('.lorerev_btn_edit').count()) === 1 && (await qc.locator('.lorerev_btn_ok').count()) === 0);
  check('4: lorebooks untouched', (await snapshot()) === before);
  await qc.scrollIntoViewIfNeeded();
  await shot('61-passages-could-not-apply.png');
  // retry as a full rewrite
  await fake.reset();
  await fake.queue([{ content: JSON.stringify([{ id: '{{id:Queen Maren}}', content: 'Stern yet fair monarch, 54 years old.', note: 'Full text this time.' }]) }]);
  await qc.locator('.lorerev_btn_fullretry').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lorerev_session')].at(-1).querySelector('.lorerev_card .lorerev_pill_proposed'));
  const r4 = await lastReq();
  check('4: retry is one request for just that entry', (await fake.requests()).length === 1 && (userMsg(r4).match(/<entry id=/g) ?? []).length === 1 && userMsg(r4).includes(MAREN));
  check('4: retry uses the Full rewrite rules', sysMsg(r4).includes('the complete new text of the entry (not a diff)') && !sysMsg(r4).includes('Do NOT write out whole entries'));
  check('4: retry tells the model why and asks for the complete text', /could not be located in the entry's text, so nothing was applied/.test(userMsg(r4)) && /complete new text of the entry in "content"/.test(userMsg(r4)));
  check('4: card is Proposed with the full text, error gone, info says full rewrite', (await pill('Queen Maren').textContent()) === 'Proposed' && (await qc.locator('.lorerev_place_error').count()) === 0 && (await newText(qc)) === 'Stern yet fair monarch, 54 years old.' && /Reply: full rewrite\./.test(await qc.locator('.lorerev_attempt_info').textContent()));
  check('4: the Reply style setting itself is unchanged by the one-off retry', (await page.inputValue('#lorerev_replystyle')) === 'passages');
  await approve(qc);
  check('4: approving the full-rewrite retry saves it', (await entryOnServer('Eldoria', 1)).content === 'Stern yet fair monarch, 54 years old.');
  await undo(qc);
  // Edit on a "Couldn't apply" card: write it yourself
  const fl = card('Festival of Lanterns');
  await fl.locator('.lorerev_btn_edit').click();
  await fl.locator('.lorerev_ed_content').fill(FEST.replace('The festival is run by the Harbor Guild.', 'The festival is run by the Harbor Guild and the temple.'));
  await fl.locator('.lorerev_btn_save').click();
  check('4: Edit on a "Couldn\'t apply" card makes your own proposal', (await pill('Festival of Lanterns').textContent()) === 'Proposed' && /Written by you: the model's changes could not be applied/.test(await fl.textContent()) && (await fl.locator('.lorerev_place_error').count()) === 0);
  await fl.locator('.lorerev_btn_no').click();

  // ================= 5. regenerate in passage mode: failing edits keep the earlier attempt =================
  await fake.reset();
  await fake.queue([{ content: JSON.stringify([{ id: '{{id:Queen Maren}}', edits: [{ find: 'a sentence that is not there', replace: 'y' }] }]) }]);
  await qc.locator('.lorerev_regen textarea').fill('shorter please');
  await qc.locator('.lorerev_btn_regen').click();
  await qc.locator('.lorerev_place_error').waitFor();
  const r5 = await lastReq();
  check('5: Regenerate uses the current style (passages) and says edits apply to the entry text, not an earlier attempt', sysMsg(r5).includes('Do NOT write out whole entries') && /not to a previous attempt: copy every "find" from that text/.test(userMsg(r5)) && userMsg(r5).includes('<previous_attempts'));
  check('5: failing regeneration adds no attempt, keeps the card Proposed, shows the error', (await pill('Queen Maren').textContent()) === 'Proposed' && (await qc.locator('.lorerev_pager').count()) === 0 && /The last regeneration could not be applied/.test(await qc.locator('.lorerev_place_error').textContent()) && (await newText(qc)) === 'Stern yet fair monarch, 54 years old.');
  check('5: the typed regeneration request is kept for the next try', (await qc.locator('.lorerev_regen textarea').inputValue()) === 'shorter please');
  await fake.reset();
  await fake.queue([{ content: JSON.stringify([{ id: '{{id:Queen Maren}}', edits: [{ find: 'Stern but fair monarch', replace: 'Stern monarch' }] }]) }]);
  await qc.locator('.lorerev_btn_regen').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lorerev_session')].at(-1).querySelector('.lorerev_pager')?.textContent.includes('2/2'));
  check('5: a regeneration that fits adds attempt 2 built from the ORIGINAL text; error cleared', (await newText(qc)) === 'Stern monarch, 54 years old.' && (await qc.locator('.lorerev_place_error').count()) === 0);

  // ================= 6. Full rewrite style still works and is persisted =================
  await page.selectOption('#lorerev_replystyle', 'full');
  check('6: style persisted in settings', (await page.evaluate(() => SillyTavern.getContext().extensionSettings.LoreReviser.replyStyle)) === 'full');
  await clearSelection();
  await pick('Eldoria', ['Queen Maren']);
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Queen Maren}}","content":"Stern but fair monarch, 56 years old."}]' }]);
  await send('Full rewrite: the queen is 56.');
  const r6 = await lastReq();
  check('6: Full rewrite sends the full-rewrite rules', sysMsg(r6).includes('the complete new text of the entry (not a diff)') && !sysMsg(r6).includes('"edits"'));
  check('6: full-text reply shown as before', (await newText(card('Queen Maren'))) === 'Stern but fair monarch, 56 years old.' && /Reply: full rewrite\./.test(await card('Queen Maren').locator('.lorerev_attempt_info').textContent()) && !/changed passages only/.test(await session().locator('.lorerev_session_head').textContent()));
  await closeModal(); await openModal();
  check('6: Reply style restored when the modal is reopened', (await page.inputValue('#lorerev_replystyle')) === 'full');
  await page.selectOption('#lorerev_replystyle', 'passages');

  // ================= 7. a model that sends the whole text in passages mode is still understood =================
  await fake.reset();
  await fake.queue([{ content: '[{"id":"{{id:Queen Maren}}","content":"Stern but fair monarch, 57 years old."}]' }]);
  await send('Passages, but the model sends the whole text.');
  check('7: full "content" in passages mode is used, and the card says so', (await newText(card('Queen Maren'))) === 'Stern but fair monarch, 57 years old.' && /sent the whole text instead of passages/.test(await card('Queen Maren').locator('.lorerev_attempt_info').textContent()));

  // ================= 8. reply format rules: one editable set per style, each with Restore default (in the Prompts window) =================
  const openPrompts = async () => { await page.click('#lorerev_prompts_btn'); await page.waitForSelector('dialog[open].lorerev_prompts_popup .lorerev_prompts_root', { state: 'visible' }); await page.click('#lorerev_rules_box summary'); };
  const closePrompts = async () => { await page.click('dialog[open].lorerev_prompts_popup .popup-button-ok'); await page.waitForSelector('.lorerev_prompts_root', { state: 'detached' }); };
  await openPrompts();
  check('8: both rule sets shown, each with its own Restore default', (await page.inputValue('#lorerev_prules')).includes('Do NOT write out whole entries') && (await page.inputValue('#lorerev_rules')).includes('the complete new text of the entry (not a diff)') && (await page.locator('#lorerev_rules_box .lorerev_restore').count()) === 2);
  const MY_P = '## Reply format (mine)\nReply with ONE JSON array of {id, edits: [{find, replace}]} objects.';
  const MY_F = '## Full rules (mine)\nReply with ONE JSON array of {id, content} objects.';
  await page.fill('#lorerev_prules', MY_P);
  await page.fill('#lorerev_rules', MY_F);
  check('8: edits stored separately', await page.evaluate(([p, f]) => { const s = SillyTavern.getContext().extensionSettings.LoreReviser; return s.passageFormatRules === p && s.formatRules === f; }, [MY_P, MY_F]));
  check('8: no warning for acceptable edits; marked edited', !(await page.isVisible('#lorerev_prules_warn')) && !(await page.isVisible('#lorerev_rules_warn')) && (await page.textContent('#lorerev_prules_edited')) === '(edited)' && (await page.textContent('#lorerev_rules_box_edited')) === '(edited)');
  await closePrompts();
  await fake.reset(); await fake.queue([{ content: '[]' }]);
  await send('Custom passages rules.');
  check('8: passages request ends with MY passages rules', sysMsg(await lastReq()).endsWith(MY_P));
  await page.selectOption('#lorerev_replystyle', 'full');
  await fake.reset(); await fake.queue([{ content: '[]' }]);
  await send('Custom full rules.');
  check('8: customised Full rewrite rules keep working for Full rewrite', sysMsg(await lastReq()).endsWith(MY_F));
  await openPrompts();
  await page.fill('#lorerev_prules', 'Reply with a poem.');
  check('8: broken passages rules warn (find / replace / edits)', (await page.isVisible('#lorerev_prules_warn')) && /"find" field/.test(await page.textContent('#lorerev_prules_warn')) && /edits\?: \[\{find, replace\}\]/.test(await page.textContent('#lorerev_prules_warn')));
  await page.evaluate(() => document.querySelector('#lorerev_rules_box').scrollIntoView({ block: 'start' }));
  await shot('62-passages-rules.png');
  await page.click('#lorerev_prules_reset');
  check('8: Restore default (passages) resets only that set', (await page.inputValue('#lorerev_prules')).includes('Do NOT write out whole entries') && await page.evaluate((f) => { const s = SillyTavern.getContext().extensionSettings.LoreReviser; return s.passageFormatRules === '' && s.formatRules === f; }, MY_F));
  await page.click('#lorerev_rules_reset');
  check('8: Restore default (full) resets the other set', await page.evaluate(() => SillyTavern.getContext().extensionSettings.LoreReviser.formatRules === '') && !(await page.isVisible('#lorerev_prules_warn')) && (await page.textContent('#lorerev_rules_box_edited')) === '');
  await closePrompts();
  await page.selectOption('#lorerev_replystyle', 'passages');

  // ================= 9. reply token override still wins =================
  await page.fill('#lorerev_reply', '1234');
  await fake.reset(); await fake.queue([{ content: '[]' }]);
  await send('Override.');
  check('9: user "Reply tokens" overrides the automatic budget in passages mode', (await lastReq()).max_tokens === 1234);
  await page.fill('#lorerev_reply', '0');

  check('lorebooks back exactly as they were', (await snapshot()) === before);
} catch (e) {
  console.log('TEST ERROR', e); failures++;
  try { const pg = browser.contexts()[0].pages()[0]; console.log('TOASTS:', await pg.locator('.toast-message').allTextContents()); console.log('LAST SESSION:', (await pg.locator('.lorerev_session').last().textContent()).slice(0, 1500)); await pg.screenshot({ path: `${SHOTS}/zz-passage-failure.png` }); } catch {}
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
