// End-to-end test of milestone 5 (new entries) against the fake model server. Needs: a FRESH ST on :8766
// (tests/start-test-st.sh), node tests/fixtures.mjs, node tests/fake-openai.mjs 9099.
// Every lorebook change is verified through ST's own API, not the UI.
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
const TOM = { title: 'Tom the Blacksmith', keys: ['Tom', 'blacksmith'], secondary_keys: [], content: 'Tom forges blades for the royal guard.\nHe works by the north gate.', note: 'Tom appeared in the last scene.' };
const WATCH = { title: 'Silverwood Watch', keys: ['Silverwood', 'watch'], content: 'Rangers who guard the border forest.', note: 'Mentioned by the queen.' };

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
    ctx.extensionSettings.connectionManager.profiles.push(
      { id: 'prof-fake', name: 'Fake Model', mode: 'cc', api: 'custom', model: 'fake-model', 'api-url': 'http://127.0.0.1:9099/v1' });
    await ctx.selectCharacterById(ctx.characters.findIndex(c => c.name === 'Test Queen'));
    await new Promise(r => setTimeout(r, 1500));
    await ctx.openCharacterChat('Test Queen - 2026-10-04@12h00m00s');
    for (let i = 0; i < 50 && !(ctx.chat.length >= 9); i++) await new Promise(r => setTimeout(r, 200));
    // Give "Queen Maren" distinctive settings, to see them copied onto new entries
    const d = await ctx.loadWorldInfo('Eldoria');
    Object.assign(d.entries[1], { order: 42, position: 4, depth: 2, probability: 70, useProbability: true, group: 'royals', role: 1, sticky: 3, selective: false, excludeRecursion: true });
    await ctx.saveWorldInfo('Eldoria', d, true);
  });

  // ---- helpers ----
  const api = (url, body) => page.evaluate(async ([u, b]) => {
    const r = await fetch(u, { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify(b) });
    const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
  }, [url, body]);
  const bookOnServer = (name) => api('/api/worldinfo/get', { name });
  const entryOnServer = async (name, uid) => (await bookOnServer(name)).entries[uid];
  const editElsewhere = (name, uid, content) => page.evaluate(async ([n, u, c]) => {
    const ctx = SillyTavern.getContext(); const d = await ctx.loadWorldInfo(n); d.entries[u].content = c; await ctx.saveWorldInfo(n, d, true);
  }, [name, uid, content]);
  const index = () => page.evaluate(() => structuredClone(SillyTavern.getContext().extensionSettings.LoreReviser.archiveIndex));
  const readFile = (file) => page.evaluate(async (f) => { const r = await fetch(`/user/files/${f}`, { cache: 'no-cache' }); return r.ok ? r.json() : r.status; }, file);
  const records = async (book) => (await readFile((await index())[book])).records;
  const openModal = async () => { await page.click('#extensionsMenuButton'); await page.click('#lorereviser_open'); await page.waitForSelector('.lorerev_book'); };
  const closeModal = async () => { await page.locator('dialog.lorerev_popup .popup-button-ok').click(); await page.waitForSelector('.lorerev_root', { state: 'detached' }); };
  const book = (name) => page.locator(`.lorerev_book[data-book="${name}"]`);
  const sidebarEntries = async (name) => { const b = book(name); if (!(await b.locator('.lorerev_entries').isVisible())) await b.locator('.lorerev_toggle').click(); return b.locator('.lorerev_entry').allTextContents(); };
  const session = () => page.locator('.lorerev_session').last();
  const card = (title) => session().locator('.lorerev_card').filter({ has: page.locator('.lorerev_card_title > b', { hasText: new RegExp(`^${title}$`) }) });
  const status = (c) => c.locator('.lorerev_pill[class*="lorerev_pill_"]:not(.lorerev_pill_edited):not(.lorerev_pill_new)').textContent();
  const settle = (c) => c.locator('.lorerev_saving').waitFor({ state: 'detached' });
  const approve = async (c) => { await c.locator('.lorerev_btn_ok').click(); await settle(c); };
  const isCollapsed = (c) => c.evaluate(el => el.classList.contains('lorerev_card_folded'));
  const expand = async (c) => { if (await isCollapsed(c)) await c.locator('.lorerev_card_title').click(); };
  const hist = () => page.locator('dialog.lorerev_hist_popup');
  const recs = () => hist().locator('.lorerev_hist_rec');
  const closeHist = async () => { await hist().locator('.popup-button-ok').click(); await hist().waitFor({ state: 'detached' }); };
  const isHistFolded = (rec) => rec.evaluate(el => el.classList.contains('lorerev_hist_folded'));
  const expandHist = async (rec) => { if (await isHistFolded(rec)) await rec.locator('.lorerev_card_title').click(); };
  const lastToast = () => page.locator('.toast-message').last().textContent();
  const shot = async (name) => { await page.evaluate(() => toastr.clear()); await page.waitForTimeout(1300); await page.screenshot({ path: `${SHOTS}/${name}` }); };
  const chooseBook = async (name, copyUid = null) => {
    await page.selectOption('#lorerev_new_book', name);
    if (copyUid !== null) { await page.waitForSelector(`#lorerev_new_copy option[value="${copyUid}"]`, { state: 'attached' }); await page.selectOption('#lorerev_new_copy', String(copyUid)); }
    else { await page.waitForFunction(() => document.querySelector('#lorerev_new_copy option')); await page.selectOption('#lorerev_new_copy', ''); }
  };
  const propose = async (text, replies) => {
    const before = await page.locator('.lorerev_msg.lorerev_user').count();
    await fake.reset(); await fake.queue(replies);
    await page.fill('#lorerev_input', text);
    await page.click('#lorerev_send');
    await page.waitForFunction((n) => document.querySelectorAll('.lorerev_msg.lorerev_user').length > n && !document.querySelector('.lorerev_msg.lorerev_loading'), before);
    return (await fake.requests()).at(-1);
  };
  const userMsg = (req) => req?.messages?.find(m => m.role === 'user')?.content ?? '';
  const sysMsg = (req) => req?.messages?.find(m => m.role === 'system')?.content ?? '';
  const eldoriaBefore = await bookOnServer('Eldoria');
  const maren = eldoriaBefore.entries[1];

  // ================= 1. mode switch and the new-entry panel =================
  await openModal();
  await page.selectOption('#lorerev_profile', 'prof-fake');
  check('1: revise mode by default, panel hidden', (await page.locator('#lorerev_create_panel').isHidden()) && (await page.locator('#lorerev_send').textContent()) === 'Send' && (await page.locator('.lorerev_mode_on').getAttribute('data-mode')) === 'revise');
  await page.click('.lorerev_mode[data-mode="create"]');
  check('1: the chosen mode is highlighted', (await page.locator('.lorerev_mode.lorerev_mode_on').count()) === 1 && (await page.locator('.lorerev_mode.lorerev_mode_on').getAttribute('data-mode')) === 'create');
  check('1: New entries mode shows the panel, button says Propose', (await page.locator('#lorerev_create_panel').isVisible()) && (await page.locator('#lorerev_send').textContent()) === 'Propose' && /new entries you want/.test(await page.getAttribute('#lorerev_input', 'placeholder')));
  const linked = await page.locator('#lorerev_new_book optgroup[label="Linked to this chat"] option').allTextContents();
  const others = await page.locator('#lorerev_new_book optgroup[label="Other lorebooks"] option').allTextContents();
  check('1: lorebook list: linked first, then all other lorebooks', linked.includes('Eldoria') && linked.includes('Chat Lore') && others.includes('Unlinked Book') && !others.includes('Eldoria'), `${linked} | ${others}`);
  await page.fill('#lorerev_input', '');
  await page.click('#lorerev_send');
  check('1: empty instructions -> error, nothing sent', /Write instructions first: which new entries/.test(await page.locator('.lorerev_msg.lorerev_error').last().textContent()));
  await chooseBook('Eldoria', 1);
  const copyOpts = await page.locator('#lorerev_new_copy option').allTextContents();
  check('1: "Copy settings from" lists the book\'s entries plus none', copyOpts[0].startsWith('(none') && copyOpts.some(o => o.startsWith('Queen Maren (#1)')) && copyOpts.length === 5, copyOpts.join('|'));
  check('1: format-example box enabled when an entry is chosen', !(await page.locator('#lorerev_new_example').isDisabled()));
  await page.check('#lorerev_new_example');
  check('1: info line names the target book', /New entries will go into “Eldoria”/.test(await page.locator('#lorerev_selected_info').textContent()));

  // ================= 2. propose: request and cards =================
  const req1 = await propose('Add the blacksmith Tom and the Silverwood rangers.', [{ content: JSON.stringify([TOM, WATCH]) }]);
  const u1 = userMsg(req1), s1 = sysMsg(req1);
  check('2: system = new-entry prompt + Change type + new-entry rules, no rewrite intensity', s1.startsWith('You are a careful lorebook writer') && s1.includes('## Change type: Development') && s1.includes('"title": "..."') && !s1.includes('Rewrite intensity'), s1.slice(0, 200));
  check('2: user message has target book with existing entries, format example, instructions', u1.includes('<target_lorebook name="Eldoria" existing_entries="4">') && u1.includes('<existing_entry title="Queen Maren" keys=["Maren","queen"]/>')
    && u1.includes('<format_example title="Queen Maren">') && u1.includes(maren.content) && u1.includes('<instructions>\nAdd the blacksmith Tom and the Silverwood rangers.') && u1.includes('<chat_history messages="8 of 8">'), u1.slice(0, 400));
  check('2: reply budget 8192 by default for new entries', req1.max_tokens === 8192, String(req1.max_tokens));
  check('2: user echo in the chat', /New entries for “Eldoria”: Add the blacksmith Tom/.test(await page.locator('.lorerev_msg.lorerev_user').last().textContent()));
  check('2: session header says New entries', /New entries/.test(await session().locator('.lorerev_session_head').textContent()) && /into “Eldoria” · 2 proposed/.test(await session().locator('.lorerev_session_head').textContent()));
  check('2: settings note names the copied entry', /copied from “Queen Maren” \(#1\).*format example/.test(await session().locator('.lorerev_create_settings').textContent()));
  check('2: two proposed cards with a New entry pill', (await session().locator('.lorerev_status_proposed').count()) === 2 && (await session().locator('.lorerev_pill_new').count()) === 2);
  const tom = card(TOM.title), watch = card(WATCH.title);
  check('2: card shows title, keys and the New view by default', (await tom.locator('.lorerev_new_title').textContent()).includes(TOM.title) && (await tom.locator('.lorerev_chip_ins').allTextContents()).join(',') === 'Tom,blacksmith'
    && (await tom.locator('.lorerev_view_on').textContent()) === 'New' && (await tom.locator('.lorerev_text').textContent()).includes('He works by the north gate.'));
  await tom.locator('.lorerev_view', { hasText: 'Old' }).click();
  check('2: Old view is empty', (await tom.locator('.lorerev_text').textContent()) === '(empty)');
  await tom.locator('.lorerev_view', { hasText: 'Changes' }).click();
  check('2: Changes view shows the whole text as added', (await tom.locator('.lorerev_blk_ins').count()) >= 1 && (await tom.locator('.lorerev_blk_del').count()) === 0);
  await tom.locator('.lorerev_view', { hasText: 'New' }).click();
  check('2: duplicate-key warning on the Silverwood card', /"Silverwood" already used by "Silverwood, forest" \(#2\)/.test(await watch.locator('.lorerev_warn').allTextContents().then(a => a.join('|'))));
  check('2: note from the model shown', (await tom.locator('.lorerev_note').textContent()) === TOM.note);
  check('2: nothing written before Approve', Object.keys((await bookOnServer('Eldoria')).entries).length === 4);
  await shot('60-new-entry-cards.png');

  // ================= 3. Approve creates the entry with copied settings =================
  await approve(tom);
  const e4 = await entryOnServer('Eldoria', 4);
  check('3: entry created with the proposal\'s title, keys and text', e4 && e4.comment === TOM.title && JSON.stringify(e4.key) === '["Tom","blacksmith"]' && e4.content === TOM.content && JSON.stringify(e4.keysecondary) === '[]', JSON.stringify(e4));
  const copied = ['order', 'position', 'depth', 'probability', 'group', 'role', 'sticky', 'selective', 'excludeRecursion'];
  check('3: settings copied from Queen Maren', copied.every(k => JSON.stringify(e4[k]) === JSON.stringify(maren[k])), copied.map(k => `${k}=${e4[k]}`).join(','));
  check('3: listed last in the editor, title shown', e4.displayIndex === 4 && e4.addMemo === true && e4.uid === 4);
  const after3 = await bookOnServer('Eldoria');
  check('3: the other entries are untouched', [0, 1, 2, 3].every(u => JSON.stringify(after3.entries[u]) === JSON.stringify(eldoriaBefore.entries[u])));
  check('3: an untitled existing entry is sent with its real (empty) title', u1.includes('<existing_entry title="" keys=["Silverwood","forest"]/>'));
  check('3: card approved, folded, says created', (await isCollapsed(tom)) && (await status(tom)) === 'Approved' && /new entry #4/.test(await tom.locator('.lorerev_card_title').textContent()));
  await expand(tom);
  check('3: card message', /Created in the lorebook "Eldoria" as entry #4, with the settings of "Queen Maren"\. Recorded in History\./.test(await tom.textContent()));
  check('3: sidebar lists the new entry', (await sidebarEntries('Eldoria')).includes(TOM.title));
  let recs3 = await records('Eldoria');
  const r3 = recs3.at(-1);
  check('3: History record "create": empty old side, new side, settings source, instructions', r3.action === 'create' && r3.uid === 4 && r3.title === TOM.title && r3.comment === TOM.title && r3.old.content === '' && r3.old.keys.length === 0
    && r3.new.content === TOM.content && r3.settingsFrom?.uid === 1 && r3.instructions === 'Add the blacksmith Tom and the Silverwood rangers.' && r3.changeType === 'development' && !('intensity' in r3), JSON.stringify(r3));

  // ================= 4. Edit before Approve (title too) =================
  await watch.locator('.menu_button', { hasText: /^Edit$/ }).click();
  await watch.locator('.lorerev_ed_title').fill('Silverwood Watchtower');
  await watch.locator('.lorerev_ed_content').fill('Rangers who guard the border forest from a tall watchtower.');
  await watch.locator('.lorerev_btn_save').click();
  const watch2 = card('Silverwood Watchtower');
  check('4: edited card shows the new title and Edited by you', (await watch2.count()) === 1 && (await watch2.locator('.lorerev_pill_edited').count()) === 1);
  await approve(watch2);
  const e5 = await entryOnServer('Eldoria', 5);
  check('4: edited version created as #5', e5?.comment === 'Silverwood Watchtower' && e5.content === 'Rangers who guard the border forest from a tall watchtower.' && e5.order === 42, JSON.stringify(e5));
  check('4: record marked edited', (await records('Eldoria')).at(-1).edited === true);

  // ================= 5. Undo removes the created entry again =================
  await tom.locator('.menu_button', { hasText: /^Undo$/ }).click();
  await settle(tom);
  check('5: Undo removed entry #4 from the lorebook', !(await entryOnServer('Eldoria', 4)));
  check('5: card back to Proposed, expanded, with a notice', (await status(tom)) === 'Proposed' && !(await isCollapsed(tom)) && /Undone: the new entry #4 was removed/.test(await tom.textContent()));
  const r5 = (await records('Eldoria')).at(-1);
  check('5: History record "remove" with a full snapshot', r5.action === 'remove' && r5.uid === 4 && r5.via === 'undo' && r5.snapshot?.order === 42 && r5.snapshot.content === TOM.content && r5.new.content === '' && r5.old.content === TOM.content, JSON.stringify(r5).slice(0, 300));
  check('5: sidebar no longer lists it', !(await sidebarEntries('Eldoria')).includes(TOM.title));

  // ================= 6. Regenerate (with request, Retcon) and approve: uid 4 is not reused =================
  await page.selectOption('#lorerev_changetype', 'retcon');
  await fake.reset();
  await fake.queue([{ content: JSON.stringify([{ ...TOM, keys: ['Tom', 'blacksmith', 'smithy'], content: 'Tom forges blades for the royal guard, helped by his apprentice Lia.' }]) }]);
  await tom.locator('.lorerev_regen_text').fill('mention his apprentice');
  await tom.locator('.lorerev_btn_regen').click();
  await page.waitForFunction(() => !document.querySelector('.lorerev_status_loading'));
  const req6 = (await fake.requests()).at(-1);
  check('6: regeneration request has the earlier attempt, the extra request and Retcon', userMsg(req6).includes('<previous_attempts proposal="N1">') && userMsg(req6).includes('{"title":"Tom the Blacksmith"') && userMsg(req6).includes('follow it): mention his apprentice') && sysMsg(req6).includes('## Change type: Retcon'));
  check('6: pager 2/2, change type and request on the attempt', (await tom.locator('.lorerev_swipe_count').textContent()) === '2/2' && /Change type: Retcon/.test(await tom.locator('.lorerev_attempt_info').textContent()) && /mention his apprentice/.test(await tom.locator('.lorerev_attempt_info').textContent()));
  await approve(tom);
  const e6 = await entryOnServer('Eldoria', 6);
  check('6: created as #6 (uid 4 has History, #5 is used), not #4', !!e6 && !(await entryOnServer('Eldoria', 4)) && e6.content.includes('apprentice Lia') && JSON.stringify(e6.key) === '["Tom","blacksmith","smithy"]');
  check('6: record has request and Retcon', (await records('Eldoria')).at(-1).request === 'mention his apprentice' && (await records('Eldoria')).at(-1).changeType === 'retcon');
  await page.selectOption('#lorerev_changetype', 'development');

  // ================= 7. Reject after an edit on an approved card removes the entry =================
  await expand(watch2);
  await watch2.locator('.menu_button', { hasText: /^Edit$/ }).click();
  await watch2.locator('.lorerev_ed_content').fill('Second thoughts.');
  await watch2.locator('.lorerev_btn_save').click();
  check('7: edited after approval -> approve again warning, entry unchanged so far', /Approve it again to save your edited version/.test(await watch2.textContent()) && (await entryOnServer('Eldoria', 5)).content.includes('tall watchtower'));
  await watch2.locator('.lorerev_btn_no').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.lorerev_card')].some(c => /Silverwood Watchtower/.test(c.textContent) && c.classList.contains('lorerev_status_rejected')));
  check('7: Reject removed the created entry #5', !(await entryOnServer('Eldoria', 5)) && (await status(watch2)) === 'Rejected');
  check('7: recorded as removal', (await records('Eldoria')).at(-1).action === 'remove' && (await records('Eldoria')).at(-1).uid === 5);

  // ================= 8. Re-approve after an edit updates the created entry =================
  await expand(tom);
  await tom.locator('.menu_button', { hasText: /^Edit$/ }).click();
  await tom.locator('.lorerev_ed_title').fill('Tom (blacksmith)');
  await tom.locator('.lorerev_ed_content').fill('Tom forges blades. Apprentice: Lia.');
  await tom.locator('.lorerev_btn_save').click();
  const tom2 = card('Tom \\(blacksmith\\)');
  await approve(tom2);
  const e6b = await entryOnServer('Eldoria', 6);
  check('8: re-approve updated #6 (text and title), no extra entry', e6b.content === 'Tom forges blades. Apprentice: Lia.' && e6b.comment === 'Tom (blacksmith)' && Object.keys((await bookOnServer('Eldoria')).entries).length === 5 && e6b.order === 42);
  const r8 = (await records('Eldoria')).at(-1);
  check('8: recorded as a change with the old title', r8.action === 'approve' && r8.uid === 6 && r8.old.content.includes('apprentice Lia') && r8.oldTitle === TOM.title, JSON.stringify(r8).slice(0, 300));

  // ================= 9. Undo refuses when the created entry was edited elsewhere =================
  await editElsewhere('Eldoria', 6, 'Changed in the World Info editor.');
  await expand(tom2);
  await tom2.locator('.menu_button', { hasText: /^Undo$/ }).click();
  await settle(tom2);
  check('9: Undo refused, entry kept, card stays approved', (await entryOnServer('Eldoria', 6))?.content === 'Changed in the World Info editor.' && (await status(tom2)) === 'Approved' && /Not undone: the new entry was changed after you approved it/.test(await tom2.textContent()));

  // ================= 10. History: labels, Remove this entry, Create it again =================
  await book('Eldoria').locator('.lorerev_hist_btn').click();
  await hist().waitFor(); await recs().first().waitFor();
  const labels = await hist().locator('.lorerev_hist_rec .lorerev_pill').allTextContents();
  check('10: History lists creates and removals', labels.includes('New entry created') && labels.includes('Entry removed (creation undone)') && labels.includes('Approved change'), labels.join('|'));
  await hist().locator('.lorerev_hist_filter').selectOption('6');
  check('10: entry #6: change + create', (await recs().count()) === 2);
  await expandHist(recs().last());
  check('10: create row: settings source, New view, Remove button', /Settings copied from “Queen Maren” \(#1\)/.test(await recs().last().textContent()) && (await recs().last().locator('.lorerev_view_on').textContent()) === 'New'
    && (await recs().last().locator('.lorerev_btn_restore').textContent()) === 'Remove this entry');
  await recs().last().locator('.lorerev_btn_restore').click();
  await page.waitForFunction(() => /Not removed: this entry was changed after it was created/.test([...document.querySelectorAll('.toast-message')].map(t => t.textContent).join(' ')));
  check('10: Remove refused for an entry changed since its creation', !!(await entryOnServer('Eldoria', 6)));
  await page.evaluate(() => toastr.clear());
  await hist().locator('.lorerev_hist_filter').selectOption('4');
  check('10: entry #4: remove + create', (await recs().count()) === 2 && (await recs().first().locator('.lorerev_btn_restore').textContent()) === 'Create it again');
  check('10: removal row says how and shows the Old side', /Removed with Undo on its review card/.test(await recs().first().textContent()) && (await recs().first().locator('.lorerev_view_on').textContent()) === 'Old');
  await shot('61-history-new-entry.png');
  await recs().first().locator('.lorerev_btn_restore').click();
  const createDlg = page.locator('dialog[open]').filter({ hasText: 'Create the entry again?' });
  await createDlg.waitFor();
  await createDlg.locator('.popup-button-ok').click();
  await page.waitForFunction(() => document.querySelectorAll('dialog.lorerev_hist_popup .lorerev_hist_rec').length === 3);
  const e4b = await entryOnServer('Eldoria', 4);
  check('10: Create it again: back as #4 with all settings', e4b?.content === TOM.content && e4b.comment === TOM.title && e4b.order === 42 && e4b.group === 'royals', JSON.stringify(e4b));
  check('10: recorded as recreate', (await records('Eldoria')).at(-1).action === 'recreate' && (await records('Eldoria')).at(-1).uid === 4);
  check('10: sidebar refreshed after the History action', (await sidebarEntries('Eldoria')).includes(TOM.title));
  // the newest row (recreate) now offers Remove this entry; it is unchanged, so it works after confirming
  check('10: recreate row offers Remove this entry', (await recs().first().locator('.lorerev_btn_restore').textContent()) === 'Remove this entry');
  await recs().first().locator('.lorerev_btn_restore').click();
  const removeDlg = page.locator('dialog[open]').filter({ hasText: 'Remove this entry?' });
  await removeDlg.waitFor();
  await removeDlg.locator('.popup-button-ok').click();
  await page.waitForFunction(() => document.querySelectorAll('dialog.lorerev_hist_popup .lorerev_hist_rec').length === 4);
  check('10: removed again via History, recorded with its source', !(await entryOnServer('Eldoria', 4)) && (await records('Eldoria')).at(-1).action === 'remove' && (await records('Eldoria')).at(-1).via === 'history');
  await recs().first().locator('.lorerev_btn_restore').click();
  await createDlg.waitFor(); await createDlg.locator('.popup-button-ok').click();
  await page.waitForFunction(() => document.querySelectorAll('dialog.lorerev_hist_popup .lorerev_hist_rec').length === 5);
  check('10: and created again', !!(await entryOnServer('Eldoria', 4)));
  await expandHist(recs().nth(4 - 1)); // the first removal (Undo), older
  await recs().nth(3).locator('.lorerev_btn_restore').click();
  await page.waitForFunction(() => /Nothing to do: “Eldoria” already has this entry \(#4\)/.test([...document.querySelectorAll('.toast-message')].map(t => t.textContent).join(' ')));
  check('10: an older removal does not create a duplicate', Object.values((await bookOnServer('Eldoria')).entries).filter(e => e.content === TOM.content).length === 1);
  await closeHist();

  // ================= 11. Defaults (no copy) into a lorebook that is not linked =================
  await chooseBook('Unlinked Book', null);
  check('11: format-example box disabled without an entry to copy', await page.locator('#lorerev_new_example').isDisabled());
  const req11 = await propose('Add a hidden shrine.', [{ content: '```json\n[{"title":"Hidden Shrine","keys":"shrine, altar","content":"A shrine in the hills."}]\n```' }]);
  check('11: no format example, target is the unlinked book', !userMsg(req11).includes('<format_example') && userMsg(req11).includes('<target_lorebook name="Unlinked Book" existing_entries="1">'));
  check('11: settings note says defaults', /SillyTavern's defaults/.test(await session().locator('.lorerev_create_settings').textContent()));
  await approve(card('Hidden Shrine'));
  const sh = await entryOnServer('Unlinked Book', 1);
  const defaults = await page.evaluate(async () => (await import('/scripts/world-info.js')).newWorldInfoEntryTemplate);
  const defKeys = Object.keys(defaults).filter(k => !['key', 'keysecondary', 'comment', 'content', 'addMemo'].includes(k));
  check('11: created with SillyTavern\'s defaults', sh && defKeys.every(k => JSON.stringify(sh[k]) === JSON.stringify(defaults[k])) && sh.comment === 'Hidden Shrine' && JSON.stringify(sh.key) === '["shrine","altar"]' && sh.displayIndex === 1, defKeys.filter(k => JSON.stringify(sh[k]) !== JSON.stringify(defaults[k])).join(','));
  check('11: History file created for that book, settings = defaults', (await records('Unlinked Book'))?.[0]?.settingsFrom === 'defaults');

  // ================= 12. Empty and unreadable replies =================
  await propose('Anything new?', [{ content: '[]' }]);
  check('12: [] -> session says no new entries', /did not propose any new entries/.test(await session().locator('.lorerev_create_none').textContent()) && (await session().locator('.lorerev_card').count()) === 0);
  await propose('Anything new?', [{ content: 'Sorry, I cannot help with that.' }]);
  check('12: unreadable reply -> error with the raw reply', /The model's reply could not be used/.test(await page.locator('.lorerev_msg.lorerev_error').last().textContent()) && (await page.locator('.lorerev_msg.lorerev_error').last().locator('pre').textContent()).includes('Sorry'));

  // ================= 13. Safety: copy source or target book gone before Approve =================
  await chooseBook('Eldoria', 0);
  await propose('Add the harbor.', [{ content: JSON.stringify([{ title: 'Harbor', keys: ['harbor'], content: 'Busy harbor.' }]) }]);
  await page.evaluate(async () => { const ctx = SillyTavern.getContext(); const d = await ctx.loadWorldInfo('Eldoria'); delete d.entries[0]; await ctx.saveWorldInfo('Eldoria', d, true); });
  const countBefore = Object.keys((await bookOnServer('Eldoria')).entries).length;
  await approve(card('Harbor'));
  check('13: copy source deleted -> not created, card stays Proposed with the reason', (await status(card('Harbor'))) === 'Proposed' && /Not created: the entry to copy settings from \("Kingdom of Eldoria", #0\) is no longer in "Eldoria"/.test(await card('Harbor').textContent()) && Object.keys((await bookOnServer('Eldoria')).entries).length === countBefore);
  await chooseBook('Unlinked Book', null);
  await propose('Add a cave.', [{ content: JSON.stringify([{ title: 'Cave', keys: ['cave'], content: 'Dark.' }]) }]);
  await page.evaluate(async () => { const ctx = SillyTavern.getContext(); await fetch('/api/worldinfo/delete', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ name: 'Unlinked Book' }) }); await ctx.updateWorldInfoList(); });
  await approve(card('Cave'));
  check('13: target lorebook deleted -> not created', (await status(card('Cave'))) === 'Proposed' && /Not created: the lorebook "Unlinked Book" no longer exists/.test(await card('Cave').textContent()));

  // ================= 14. Mode and cards survive closing/reopening; revise mode still works =================
  await closeModal(); await openModal();
  check('14: reopened in New entries mode with the cards', (await page.locator('#lorerev_create_panel').isVisible()) && (await page.locator('.lorerev_session_create').count()) >= 4);
  await page.click('.lorerev_mode[data-mode="revise"]');
  check('14: back to revise mode', (await page.locator('#lorerev_create_panel').isHidden()) && (await page.locator('#lorerev_send').textContent()) === 'Send' && /entries selected|No entries selected/.test(await page.locator('#lorerev_selected_info').textContent()));
  const b = book('Eldoria');
  if (!(await b.locator('.lorerev_entries').isVisible())) await b.locator('.lorerev_toggle').click();
  await b.locator('.lorerev_entry', { hasText: 'Tom (blacksmith)' }).locator('input').check();
  await fake.reset();
  await fake.queue([{ content: JSON.stringify([{ id: 'E1', content: 'Revised Tom.' }]) }]);
  await page.fill('#lorerev_input', 'Revise Tom.');
  await page.click('#lorerev_send');
  await page.waitForFunction(() => document.querySelector('.lorerev_session:last-of-type .lorerev_status_proposed') && !document.querySelector('.lorerev_msg.lorerev_loading'));
  const rev = page.locator('.lorerev_session').last().locator('.lorerev_card').first();
  await approve(rev);
  const e6c = await entryOnServer('Eldoria', 6);
  check('14: a created entry can be revised normally (content only, title kept)', e6c.content === 'Revised Tom.' && e6c.comment === 'Tom (blacksmith)');
  await page.evaluate(() => SillyTavern.getContext().saveSettingsDebounced());
} catch (e) {
  console.log('TEST ERROR', e); failures++;
  try { const pg = browser.contexts()[0].pages()[0]; console.log('TOASTS:', await pg.locator('.toast-message').allTextContents()); await pg.screenshot({ path: `${SHOTS}/zz-create-failure.png` }); } catch {}
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
