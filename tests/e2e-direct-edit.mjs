// End-to-end test of the direct entry editor: the pencil next to a sidebar entry opens it (no model call), Save writes
// keys/text through the same safe path as Approve (stale check, History "Manual edit" record), Cancel writes nothing,
// History shows and restores Manual edit records, checkbox selection is not affected, and revision still works after.
// Needs: a FRESH ST on :8766 (tests/start-test-st.sh), node tests/fixtures.mjs, node tests/fake-openai.mjs 9099.
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
const KINGDOM_OLD = 'A northern kingdom ruled by Queen Maren.';
const KINGDOM_NEW = '## Overview\nA northern kingdom ruled by Queen Maren.\n\n## Climate\nLong winters; the rivers freeze from autumn to spring.';

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
  const records = async (book) => { const f = (await index())[book]; if (!f) return []; const a = await readFile(f); return typeof a === 'object' ? a.records : []; };
  const savedSelection = () => page.evaluate(() => structuredClone(SillyTavern.getContext().chatMetadata?.LoreReviser?.selection ?? {}));
  const openModal = async () => { await page.click('#extensionsMenuButton'); await page.click('#lorereviser_open'); await page.waitForSelector('.lorerev_book'); };
  const closeModal = async () => { await page.locator('dialog.lorerev_popup .popup-button-ok').click(); await page.waitForSelector('.lorerev_root', { state: 'detached' }); };
  const book = (name) => page.locator(`.lorerev_book[data-book="${name}"]`);
  const expandBook = async (name) => { const b = book(name); if (!(await b.locator('.lorerev_entries').isVisible())) await b.locator('.lorerev_toggle').click(); };
  const entryRow = (bookName, label) => book(bookName).locator('.lorerev_entry', { hasText: label });
  const checkbox = (bookName, label) => entryRow(bookName, label).locator('input.lorerev_entry_check');
  const pencil = (bookName, label) => entryRow(bookName, label).locator('.lorerev_entry_open');
  const checkStates = (bookName) => book(bookName).locator('input.lorerev_entry_check').evaluateAll(els => els.map(e => e.checked));
  const ed = () => page.locator('dialog.lorerev_entry_popup');
  const edOpen = async (bookName, label) => { await pencil(bookName, label).click(); await ed().locator('.lorerev_ed_text').waitFor(); };
  const edSave = () => ed().locator('.popup-button-ok').click();
  const edCancel = () => ed().locator('.popup-button-cancel').click();
  const edGone = () => ed().waitFor({ state: 'detached' });
  const discardDlg = () => page.locator('dialog[open]').filter({ hasText: 'Discard your changes?' });
  const hist = () => page.locator('dialog.lorerev_hist_popup');
  const recs = () => hist().locator('.lorerev_hist_rec');
  const histLoaded = () => hist().locator('.lorerev_hist_rec, .lorerev_hist_empty').first().waitFor();
  const closeHist = async () => { await hist().locator('.popup-button-ok').click(); await hist().waitFor({ state: 'detached' }); };
  const shot = async (name) => { await page.evaluate(() => toastr.clear()); await page.waitForTimeout(1300); await page.screenshot({ path: `${SHOTS}/${name}` }); };

  const eldoriaBefore = await bookOnServer('Eldoria');
  await fake.reset();

  // ================= 1. pencil opens the entry, no model call, checkboxes untouched =================
  await openModal();
  await expandBook('Eldoria');
  await checkbox('Eldoria', 'Queen Maren').check();
  await page.waitForTimeout(400);
  const statesBefore = await checkStates('Eldoria');
  await shot('79-sidebar-pencils.png');
  check('1: every sidebar entry has a pencil icon', (await book('Eldoria').locator('.lorerev_entry_open').count()) === 4 && (await book('Eldoria').locator('.lorerev_entry_check').count()) === 4);
  await edOpen('Eldoria', 'Kingdom of Eldoria');
  check('1: editor shows the title', (await ed().locator('.lorerev_ed_heading').textContent()) === 'Kingdom of Eldoria');
  check('1: editor shows keys, secondary keys and content', (await ed().locator('.lorerev_ed_keys').inputValue()) === 'Eldoria, the kingdom'
    && (await ed().locator('.lorerev_ed_sec').inputValue()) === '' && (await ed().locator('.lorerev_ed_text').inputValue()) === KINGDOM_OLD);
  check('1: editor names the entry number and book', /Entry #0 in “Eldoria”/.test(await ed().locator('.lorerev_ed_meta').textContent()));
  check('1: content is an editable textarea', await ed().locator('.lorerev_ed_text').isEditable());
  const box = await ed().locator('.lorerev_ed_text').boundingBox();
  check('1: the text box is roomy (uses the large popup)', box && box.width > 900 && box.height > 350, JSON.stringify(box));
  check('1: clicking the pencil did not tick or untick any checkbox', JSON.stringify(await checkStates('Eldoria')) === JSON.stringify(statesBefore) && JSON.stringify(statesBefore) === '[false,true,false,false]', JSON.stringify(await checkStates('Eldoria')));
  check('1: no request reached the model', (await fake.requests()).length === 0);
  await shot('80-direct-edit-open.png');

  // ================= 2. Cancel writes nothing =================
  await edCancel(); await edGone();
  check('2: Cancel without edits closes at once, lorebook unchanged', JSON.stringify(await bookOnServer('Eldoria')) === JSON.stringify(eldoriaBefore));
  await edOpen('Eldoria', 'Kingdom of Eldoria');
  await ed().locator('.lorerev_ed_text').fill('Something I will throw away.');
  check('2: unsaved-changes marker shows', /Unsaved changes/.test(await ed().locator('.lorerev_ed_dirty').textContent()));
  await edCancel();
  await discardDlg().waitFor();
  await discardDlg().locator('.popup-button-cancel').click(); // Keep editing
  await discardDlg().waitFor({ state: 'detached' });
  check('2: "Keep editing" keeps the editor open with the typed text', (await ed().isVisible()) && (await ed().locator('.lorerev_ed_text').inputValue()) === 'Something I will throw away.');
  await page.keyboard.press('Escape');
  await discardDlg().waitFor();
  await discardDlg().locator('.popup-button-ok').click(); // Discard
  await edGone();
  check('2: Discard closes, nothing written to the lorebook', JSON.stringify(await bookOnServer('Eldoria')) === JSON.stringify(eldoriaBefore));
  check('2: nothing recorded in History', (await records('Eldoria')).length === 0);
  check('2: still no model request, checkboxes still the same', (await fake.requests()).length === 0 && JSON.stringify(await checkStates('Eldoria')) === JSON.stringify(statesBefore));

  // ================= 3. edit text + keys, Save writes to the lorebook and History =================
  await edOpen('Eldoria', 'Kingdom of Eldoria');
  await ed().locator('.lorerev_ed_text').fill(KINGDOM_NEW);
  await ed().locator('.lorerev_ed_keys').fill('Eldoria, the kingdom, northern realm');
  await ed().locator('.lorerev_ed_sec').fill('crown');
  await shot('81-direct-edit-typed.png');
  await edSave(); await edGone();
  const kingdom = await entryOnServer('Eldoria', 0);
  check('3: Save wrote the text to the lorebook', kingdom.content === KINGDOM_NEW, JSON.stringify(kingdom.content));
  check('3: Save wrote keys and secondary keys', JSON.stringify(kingdom.key) === '["Eldoria","the kingdom","northern realm"]' && JSON.stringify(kingdom.keysecondary) === '["crown"]');
  const strip = (e) => { const { key, keysecondary, content, ...rest } = e; return JSON.stringify(rest); };
  check('3: no other setting of the entry touched', strip(kingdom) === strip(eldoriaBefore.entries[0]));
  const afterSave = await bookOnServer('Eldoria');
  check('3: other entries untouched', [1, 2, 3].every(u => JSON.stringify(afterSave.entries[u]) === JSON.stringify(eldoriaBefore.entries[u])));
  check('3: ST\'s own cache has the new text', (await page.evaluate(async () => (await SillyTavern.getContext().loadWorldInfo('Eldoria')).entries[0].content)) === KINGDOM_NEW);
  let recsE = await records('Eldoria');
  const man = recsE[0];
  check('3: one "manual" History record with old and new version', recsE.length === 1 && man.action === 'manual' && man.uid === 0 && man.title === 'Kingdom of Eldoria'
    && man.old.content === KINGDOM_OLD && JSON.stringify(man.old.keys) === '["Eldoria","the kingdom"]' && man.new.content === KINGDOM_NEW
    && JSON.stringify(man.new.secondary) === '["crown"]' && JSON.stringify(man.changed) === '["content","keys","secondary"]', JSON.stringify(recsE));
  check('3: still no model request', (await fake.requests()).length === 0);

  // text-only edit keeps the keys exactly (even a key that would not survive re-splitting)
  await page.evaluate(async () => { const ctx = SillyTavern.getContext(); const d = await ctx.loadWorldInfo('Eldoria'); d.entries[2].key = ['Silverwood', '/wood,s?/i']; await ctx.saveWorldInfo('Eldoria', d, true); });
  await edOpen('Eldoria', 'Silverwood');
  check('3: an untitled entry shows its keys as the heading', /Silverwood/.test(await ed().locator('.lorerev_ed_heading').textContent()));
  await ed().locator('.lorerev_ed_text').fill('An ancient forest on the border. Wolves live there.');
  await edSave(); await edGone();
  const silver = await entryOnServer('Eldoria', 2);
  check('3: text-only edit saved, keys kept exactly', silver.content === 'An ancient forest on the border. Wolves live there.' && JSON.stringify(silver.key) === '["Silverwood","/wood,s?/i"]', JSON.stringify(silver));
  recsE = await records('Eldoria');
  check('3: its record says only the text changed', recsE.length === 2 && JSON.stringify(recsE[1].changed) === '["content"]');
  // Save with nothing changed: closes, writes nothing
  await edOpen('Eldoria', 'Silverwood');
  await edSave(); await edGone();
  check('3: Save with no changes writes nothing', (await records('Eldoria')).length === 2 && (await entryOnServer('Eldoria', 2)).content === silver.content);
  // a disabled entry opens too
  await edOpen('Eldoria', 'Old rumor');
  check('3: a disabled entry opens and says it is disabled', (await ed().locator('.lorerev_ed_text').inputValue()) === 'Unused.' && /disabled/.test(await ed().locator('.lorerev_ed_meta').textContent()));
  await edCancel(); await edGone();

  // ================= 4. stale check: entry changed after the editor opened =================
  await edOpen('Eldoria', 'Queen Maren');
  await ed().locator('.lorerev_ed_text').fill('My hand-written queen text.');
  await editElsewhere('Eldoria', 1, 'Changed in the World Info editor meanwhile.');
  await edSave();
  await ed().locator('.lorerev_ed_msg', { hasText: 'Not saved' }).waitFor();
  check('4: Save refused with a clear message, editor stays open', (await ed().isVisible()) && /changed in the lorebook after you opened it/.test(await ed().locator('.lorerev_ed_msg').textContent()));
  check('4: the other change was not overwritten', (await entryOnServer('Eldoria', 1)).content === 'Changed in the World Info editor meanwhile.');
  check('4: nothing recorded for the refused save', (await records('Eldoria')).length === 2);
  check('4: Reload is highlighted', await ed().locator('.lorerev_ed_reload.lorerev_ed_attention').isVisible());
  await shot('82-direct-edit-stale.png');
  await ed().locator('.lorerev_ed_reload').click();
  const reloadDlg = page.locator('dialog[open]').filter({ hasText: 'Reload from the lorebook?' });
  await reloadDlg.waitFor(); await reloadDlg.locator('.popup-button-ok').click(); await reloadDlg.waitFor({ state: 'detached' });
  check('4: Reload loads the current text', (await ed().locator('.lorerev_ed_text').inputValue()) === 'Changed in the World Info editor meanwhile.');
  check('4: what was typed is kept below to copy', (await ed().locator('.lorerev_ed_draft_text').inputValue()) === 'My hand-written queen text.');
  await ed().locator('.lorerev_ed_text').fill('Changed in the World Info editor meanwhile. Also: 55 years old.');
  await edSave(); await edGone();
  check('4: after Reload, Save works', (await entryOnServer('Eldoria', 1)).content === 'Changed in the World Info editor meanwhile. Also: 55 years old.' && (await records('Eldoria')).length === 3);

  // ================= 5. History: Manual edit records, kind filter, Restore =================
  await edOpen('Eldoria', 'Kingdom of Eldoria');
  await ed().locator('.lorerev_ed_hist').click();
  await hist().waitFor(); await histLoaded();
  check('5: the editor\'s History button opens this entry\'s History', (await recs().count()) === 1 && (await hist().locator('.lorerev_hist_filter').inputValue()) === '0');
  check('5: the record is labelled "Manual edit"', (await recs().first().locator('.lorerev_pill_manual').textContent()) === 'Manual edit'
    && /Edited by hand in LoreReviser's entry editor \(no model\): text, keys and secondary keys/.test(await recs().first().textContent()));
  await shot('83-direct-edit-history.png');
  await closeHist();
  await edCancel(); await edGone();
  // sidebar clock: all entries, with the Kind filter
  await book('Eldoria').locator('.lorerev_hist_btn').click();
  await hist().waitFor(); await histLoaded();
  check('5: all three manual edits listed', (await recs().count()) === 3);
  const kindOpts = await hist().locator('.lorerev_hist_kind option').allTextContents();
  check('5: Kind filter lists "Manual edit (3)"', JSON.stringify(kindOpts) === '["All kinds of change","Manual edit (3)"]', JSON.stringify(kindOpts));
  await hist().locator('.lorerev_hist_kind').selectOption('manual');
  check('5: filtering by Manual edit keeps them', (await recs().count()) === 3);
  await hist().locator('.lorerev_hist_filter').selectOption('0');
  check('5: entry + kind filter together', (await recs().count()) === 1);
  // Restore the Kingdom manual edit
  await recs().first().locator('.lorerev_btn_restore').click();
  const confirmDlg = page.locator('dialog[open]').filter({ hasText: 'Restore the old version?' });
  await confirmDlg.waitFor();
  await confirmDlg.locator('.popup-button-ok').click();
  await confirmDlg.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('dialog.lorerev_hist_popup .lorerev_hist_rec').length >= 1);
  await page.waitForTimeout(500);
  const restored = await entryOnServer('Eldoria', 0);
  check('5: Restore put the text and keys from before the manual edit back', restored.content === KINGDOM_OLD && JSON.stringify(restored.key) === '["Eldoria","the kingdom"]' && JSON.stringify(restored.keysecondary) === '[]', JSON.stringify(restored));
  recsE = await records('Eldoria');
  check('5: the restore is recorded too', recsE.length === 4 && recsE[3].action === 'restore' && recsE[3].restoredFrom === man.id && recsE[3].old.content === KINGDOM_NEW);
  await hist().locator('.lorerev_hist_kind').selectOption('');
  check('5: Kind filter now also offers Restored from History', (await hist().locator('.lorerev_hist_kind option').allTextContents()).some(t => /^Restored from History \(1\)$/.test(t)));
  await closeHist();

  // History restore from inside the editor updates an unedited editor
  await edOpen('Eldoria', 'Silverwood');
  await ed().locator('.lorerev_ed_hist').click();
  await hist().waitFor(); await histLoaded();
  await recs().first().locator('.lorerev_btn_restore').click();
  await confirmDlg.waitFor(); await confirmDlg.locator('.popup-button-ok').click(); await confirmDlg.waitFor({ state: 'detached' });
  await page.waitForTimeout(800);
  await closeHist();
  await page.waitForTimeout(500);
  check('5: restore from the editor\'s History reloads the editor', (await ed().locator('.lorerev_ed_text').inputValue()) === 'An ancient forest on the border.' && (await entryOnServer('Eldoria', 2)).content === 'An ancient forest on the border.');
  await edCancel(); await edGone();

  // ================= 6. selection unaffected; revision still works on the edited entry =================
  check('6: checkboxes unchanged after all the edits', JSON.stringify(await checkStates('Eldoria')) === JSON.stringify(statesBefore));
  check('6: saved selection is still just Queen Maren', JSON.stringify(await savedSelection()) === '{"Eldoria":[1]}', JSON.stringify(await savedSelection()));
  check('6: no model request during any of it', (await fake.requests()).length === 0);
  await closeModal(); await openModal();
  await expandBook('Eldoria');
  check('6: selection survives reopening', JSON.stringify(await checkStates('Eldoria')) === JSON.stringify(statesBefore));
  await page.selectOption('#lorerev_profile', 'prof-fake');
  await page.selectOption('#lorerev_replystyle', 'full');
  await fake.queue([{ content: JSON.stringify([{ id: '{{id:Queen Maren}}', content: 'Changed in the World Info editor meanwhile. Also: 56 years old.' }]) }]);
  await page.fill('#lorerev_input', 'She had another birthday.');
  await page.click('#lorerev_send');
  await page.waitForSelector('.lorerev_session');
  const reqs = await fake.requests();
  check('6: Send makes exactly one model request, with the hand-edited text', reqs.length === 1 && JSON.stringify(reqs[0].messages).includes('Also: 55 years old.'));
  const c = page.locator('.lorerev_card').last();
  await c.locator('.lorerev_btn_ok').click();
  await c.locator('.lorerev_saving').waitFor({ state: 'detached' });
  check('6: approving after a manual edit saves', (await entryOnServer('Eldoria', 1)).content === 'Changed in the World Info editor meanwhile. Also: 56 years old.');
  recsE = await records('Eldoria');
  check('6: History has the approval after the manual records', recsE.at(-1).action === 'approve' && recsE.filter(r => r.action === 'manual').length === 3);
  await expandBook('Eldoria');
  await edOpen('Eldoria', 'Queen Maren');
  check('6: editor shows the approved text', (await ed().locator('.lorerev_ed_text').inputValue()) === 'Changed in the World Info editor meanwhile. Also: 56 years old.');
  await edCancel(); await edGone();
  await page.evaluate(() => SillyTavern.getContext().saveSettingsDebounced());
} catch (e) {
  console.log('TEST ERROR', e); failures++;
  try { const pg = browser.contexts()[0].pages()[0]; console.log('TOASTS:', await pg.locator('.toast-message').allTextContents()); await pg.screenshot({ path: `${SHOTS}/zz-direct-edit-failure.png` }); } catch {}
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
