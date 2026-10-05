// End-to-end test of milestone 4 (Approve writes, archive, History/Restore, stale checks, orphaned archives / relink)
// against the fake model server. Needs: a FRESH ST on :8766 (tests/start-test-st.sh), node tests/fixtures.mjs,
// node tests/fake-openai.mjs 9099. Every lorebook change is verified through ST's own API, not the UI.
import { chromium } from 'playwright-core';
const SHOTS = process.env.SHOTS_DIR ?? '/workspace/LoreReviser-shots';
const FAKE = 'http://127.0.0.1:9099';
let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name} ${ok ? '' : extra}`); if (!ok) failures++; };
const fake = {
  reset: () => fetch(`${FAKE}/__reset`, { method: 'POST' }),
  queue: (replies) => fetch(`${FAKE}/__queue`, { method: 'POST', body: JSON.stringify(replies) }),
};
const MAREN_OLD = 'Stern but fair monarch, 54 years old.';
const MAREN_NEW = 'Stern but fair monarch, 55 years old. Also called Maren the Wise.';
const HEIR_OLD = 'Prince Aldric vanished last winter.';

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
  /** Simulates an edit made elsewhere (e.g. the World Info editor): saved through ST so its cache is current too. */
  const editElsewhere = (name, uid, content) => page.evaluate(async ([n, u, c]) => {
    const ctx = SillyTavern.getContext(); const d = await ctx.loadWorldInfo(n); d.entries[u].content = c; await ctx.saveWorldInfo(n, d, true);
  }, [name, uid, content]);
  const index = () => page.evaluate(() => structuredClone(SillyTavern.getContext().extensionSettings.LoreReviser.archiveIndex));
  const readFile = (file) => page.evaluate(async (f) => { const r = await fetch(`/user/files/${f}`, { cache: 'no-cache' }); return r.ok ? r.json() : r.status; }, file);
  const openModal = async () => { await page.click('#extensionsMenuButton'); await page.click('#lorereviser_open'); await page.waitForSelector('.lorerev_book'); };
  const closeModal = async () => { await page.locator('dialog.lorerev_popup .popup-button-ok').click(); await page.waitForSelector('.lorerev_root', { state: 'detached' }); };
  const book = (name) => page.locator(`.lorerev_book[data-book="${name}"]`);
  async function pick(bookName, titles) {
    const b = book(bookName);
    if (!(await b.locator('.lorerev_entries').isVisible())) await b.locator('.lorerev_toggle').click();
    for (const t of titles) await b.locator('.lorerev_entry', { hasText: t }).locator('input').check();
  }
  const session = () => page.locator('.lorerev_session').last();
  const card = (title) => session().locator('.lorerev_card').filter({ has: page.locator('.lorerev_card_title > b', { hasText: new RegExp(`^${title}$`) }) });
  const pill = (title) => card(title).locator('.lorerev_pill:not(.lorerev_pill_edited)');
  const settle = (c) => c.locator('.lorerev_saving').waitFor({ state: 'detached' });
  const approve = async (c) => { await c.locator('.lorerev_btn_ok').click(); await settle(c); };
  // approved cards collapse to their header line; clicking the header expands them again
  const isCollapsed = (c) => c.evaluate(el => el.classList.contains('lorerev_card_folded'));
  const expand = async (c) => { if (await isCollapsed(c)) await c.locator('.lorerev_card_title').click(); };
  const hist = () => page.locator('dialog.lorerev_hist_popup');
  const recs = () => hist().locator('.lorerev_hist_rec');
  const confirmDlg = () => page.locator('dialog[open]').filter({ hasText: 'Restore the old version?' });
  const closeHist = async () => { await hist().locator('.popup-button-ok').click(); await hist().waitFor({ state: 'detached' }); };
  const shot = async (name) => { await page.evaluate(() => toastr.clear()); await page.waitForTimeout(1300); await page.screenshot({ path: `${SHOTS}/${name}` }); };

  const eldoriaBefore = await bookOnServer('Eldoria');
  check('setup: no archive index yet', JSON.stringify(await index()) === '{}');

  // ================= 1. Send, approve -> written to the lorebook =================
  await openModal();
  await page.selectOption('#lorerev_profile', 'prof-fake');
  await pick('Eldoria', ['Kingdom of Eldoria', 'Queen Maren']);
  await pick('Chat Lore', ['The Missing Heir']);
  await fake.reset();
  await fake.queue([{ content: JSON.stringify([
    { id: '{{id:Queen Maren}}', keys: ['Maren', 'queen', 'Maren the Wise'], secondary_keys: ['monarch'], content: MAREN_NEW, note: 'Birthday.' },
    { id: '{{id:Kingdom of Eldoria}}', content: 'A northern kingdom ruled by Queen Maren the Wise.' },
    { id: '{{id:The Missing Heir}}', content: 'Prince Aldric vanished last winter. He was seen near the Silverwood.' },
  ]) }]);
  await page.selectOption('#lorerev_intensity', 'light');
  await page.fill('#lorerev_input', 'The queen turned 55 and is now called Maren the Wise.');
  await page.click('#lorerev_send');
  await page.waitForSelector('.lorerev_session');
  check('1: three proposals', (await session().locator('.lorerev_status_proposed').count()) === 3);
  check('1: every card has a History button', (await session().locator('.lorerev_btn_hist').count()) === 3);
  await approve(card('Queen Maren'));
  const maren = await entryOnServer('Eldoria', 1);
  check('1: approve wrote content to the lorebook file', maren.content === MAREN_NEW, maren.content);
  check('1: approve wrote keys and secondary keys', JSON.stringify(maren.key) === '["Maren","queen","Maren the Wise"]' && JSON.stringify(maren.keysecondary) === '["monarch"]');
  const strip = (e) => { const { key, keysecondary, content, ...rest } = e; return JSON.stringify(rest); };
  check('1: no other entry setting touched', strip(maren) === strip(eldoriaBefore.entries[1]));
  check('1: other entries in the book untouched', JSON.stringify((await bookOnServer('Eldoria')).entries[0]) === JSON.stringify(eldoriaBefore.entries[0]) && JSON.stringify((await bookOnServer('Eldoria')).entries[2]) === JSON.stringify(eldoriaBefore.entries[2]));
  check('1: ST\'s own cache has the new text too', (await page.evaluate(async () => (await SillyTavern.getContext().loadWorldInfo('Eldoria')).entries[1].content)) === MAREN_NEW);
  // collapsible cards
  check('1: approve collapses the card to its header line', (await isCollapsed(card('Queen Maren'))) && (await card('Queen Maren').locator('.lorerev_buttons, .lorerev_text, .lorerev_keys').count()) === 0 && (await pill('Queen Maren').textContent()) === 'Approved' && /Eldoria/.test(await card('Queen Maren').locator('.lorerev_card_title').textContent()));
  check('1: other cards stay expanded', !(await isCollapsed(card('Kingdom of Eldoria'))) && !(await isCollapsed(card('The Missing Heir'))));
  await shot('56-collapsed-approved.png');
  await card('Queen Maren').locator('.lorerev_card_title').click();
  check('1: clicking the header expands it', !(await isCollapsed(card('Queen Maren'))) && (await card('Queen Maren').locator('.lorerev_buttons').count()) === 1);
  await card('Queen Maren').locator('.lorerev_collapse').click();
  check('1: the chevron collapses it again', await isCollapsed(card('Queen Maren')));
  await card('The Missing Heir').locator('.lorerev_card_title').click();
  check('1: a proposed card can be collapsed by hand too', await isCollapsed(card('The Missing Heir')));
  await closeModal(); await openModal();
  check('1: collapse state survives closing and reopening the modal', (await isCollapsed(card('Queen Maren'))) && (await isCollapsed(card('The Missing Heir'))) && !(await isCollapsed(card('Kingdom of Eldoria'))));
  await card('The Missing Heir').locator('.lorerev_card_title').click();
  await expand(card('Queen Maren'));
  check('1: card says saved', (await pill('Queen Maren').textContent()) === 'Approved' && /Saved to the lorebook "Eldoria"\. The old version is kept in History\./.test(await card('Queen Maren').textContent()));
  await shot('50-approved-saved.png');

  // ================= 2. archive file + index =================
  const idx = await index();
  check('2: index has Eldoria -> LoreReviser-archive__Eldoria__<hash>.json', /^LoreReviser-archive__Eldoria__[0-9a-f]{8}\.json$/.test(idx.Eldoria ?? ''), JSON.stringify(idx));
  const arc = await readFile(idx.Eldoria);
  const rec = arc.records?.[0];
  check('2: archive file exists with the real book name', arc.format === 'LoreReviser-archive' && arc.book === 'Eldoria' && arc.records.length === 1, JSON.stringify(arc).slice(0, 300));
  check('2: record has uid, title, old and new content/keys', rec?.uid === 1 && rec.title === 'Queen Maren' && rec.action === 'approve'
    && rec.old.content === MAREN_OLD && JSON.stringify(rec.old.keys) === '["Maren","queen"]' && JSON.stringify(rec.old.secondary) === '[]'
    && rec.new.content === MAREN_NEW && JSON.stringify(rec.new.secondary) === '["monarch"]', JSON.stringify(rec));
  check('2: record has time, instructions, intensity and change type', !isNaN(Date.parse(rec?.time)) && rec.instructions === 'The queen turned 55 and is now called Maren the Wise.' && rec.intensity === 'light' && rec.changeType === 'development', JSON.stringify(rec));

  // ================= 3. stale-entry check on Approve =================
  await editElsewhere('Eldoria', 0, 'Edited in the World Info editor meanwhile.');
  await approve(card('Kingdom of Eldoria'));
  check('3: changed entry -> not saved, card back to Proposed with the reason', (await pill('Kingdom of Eldoria').textContent()) === 'Proposed' && /Not saved: this entry was changed in the lorebook after LoreReviser read it/.test(await card('Kingdom of Eldoria').textContent()));
  check('3: the other change was not overwritten', (await entryOnServer('Eldoria', 0)).content === 'Edited in the World Info editor meanwhile.');
  check('3: nothing archived for the refused approval', (await readFile(idx.Eldoria)).records.length === 1);
  await card('Kingdom of Eldoria').scrollIntoViewIfNeeded();
  await shot('51-stale-not-saved.png');

  // ================= 4. Undo after a write = real revert, archived =================
  const heir = card('The Missing Heir');
  await approve(heir);
  check('4: second book written', (await entryOnServer('Chat Lore', 0)).content.includes('Silverwood'));
  check('4: approve collapsed it', await isCollapsed(heir));
  await expand(heir);
  await heir.locator('.menu_button', { hasText: 'Undo' }).click(); await settle(heir);
  check('4: Undo leaves the card expanded', !(await isCollapsed(heir)));
  check('4: Undo put the old text back in the lorebook', (await entryOnServer('Chat Lore', 0)).content === HEIR_OLD);
  check('4: card back to Proposed with a note', (await pill('The Missing Heir').textContent()) === 'Proposed' && /Undone: the old version is back in the lorebook/.test(await heir.textContent()));
  const chatFile = (await index())['Chat Lore'];
  const chatArc = await readFile(chatFile);
  check('4: a second archive file for the second book, with approve + undo records', /^LoreReviser-archive__Chat-Lore__[0-9a-f]{8}\.json$/.test(chatFile) && chatArc.records.map(r => r.action).join(',') === 'approve,undo' && chatArc.records[1].new.content === HEIR_OLD, JSON.stringify(chatArc.records?.map(r => r.action)));
  // Undo refused when the entry changed after approval
  await approve(heir);
  await editElsewhere('Chat Lore', 0, 'Changed after approval.');
  await expand(heir);
  await heir.locator('.menu_button', { hasText: 'Undo' }).click(); await settle(heir);
  check('4: Undo refused after an outside change, points to History', (await pill('The Missing Heir').textContent()) === 'Approved' && /Not undone: .*Use History/.test(await heir.textContent()) && (await entryOnServer('Chat Lore', 0)).content === 'Changed after approval.');

  // ================= 5. History from the card, Restore =================
  await expand(card('Queen Maren'));
  await card('Queen Maren').locator('.lorerev_btn_hist').click();
  await hist().waitFor();
  await recs().first().waitFor();
  check('5: History lists the approval', (await recs().count()) === 1 && /Approved change/.test(await recs().first().textContent()) && /The queen turned 55/.test(await recs().first().textContent()));
  check('5: History shows the diff (changes view, removed and added blocks)', /54 years old/.test(await recs().first().locator('.lorerev_blk_del').allTextContents().then(a => a.join(' '))) && /55 years old/.test(await recs().first().locator('.lorerev_blk_ins').allTextContents().then(a => a.join(' '))));
  check('5: key chips in History', (await recs().first().locator('.lorerev_chip_ins').allTextContents()).includes('Maren the Wise'));
  await recs().first().locator('.lorerev_view', { hasText: 'Full Compare' }).click();
  check('5: Full Compare view works in History', (await recs().first().locator('.lorerev_cmp').count()) === 1);
  await shot('52-history.png');
  await recs().first().locator('.lorerev_btn_restore').click();
  await confirmDlg().waitFor();
  check('5: Restore asks first, no outside-change note when none', !/changed outside LoreReviser/.test(await confirmDlg().textContent()));
  await shot('53-restore-confirm.png');
  await confirmDlg().locator('.popup-button-ok').click();
  await page.waitForFunction(() => document.querySelectorAll('dialog.lorerev_hist_popup .lorerev_hist_rec').length === 2);
  const marenR = await entryOnServer('Eldoria', 1);
  check('5: Restore put the old text and keys back', marenR.content === MAREN_OLD && JSON.stringify(marenR.key) === '["Maren","queen"]' && JSON.stringify(marenR.keysecondary) === '[]');
  check('5: History now shows the restore on top', /Restored from History/.test(await recs().first().textContent()) && /Approved change/.test(await recs().nth(1).textContent()));
  const arc2 = await readFile(idx.Eldoria);
  check('5: restore archived as a new record (old = replaced text, linked to its source)', arc2.records.length === 2 && arc2.records[1].action === 'restore' && arc2.records[1].old.content === MAREN_NEW && arc2.records[1].new.content === MAREN_OLD && arc2.records[1].restoredFrom === arc2.records[0].id);
  await shot('54-history-after-restore.png');
  await closeHist();

  // ================= 6. History from the sidebar; restore after an outside change; stale between confirm and write =================
  await editElsewhere('Eldoria', 1, 'Typed in the World Info editor.');
  await book('Eldoria').locator('.lorerev_hist_btn').click();
  await hist().waitFor(); await recs().first().waitFor();
  check('6: sidebar History shows every entry of the book with a filter', (await recs().count()) === 2 && (await hist().locator('.lorerev_hist_filter option').count()) === 2);
  // restore the "new" side of the restore record = the approved version
  await recs().first().locator('.lorerev_btn_restore').click();
  await confirmDlg().waitFor();
  check('6: confirm warns about the outside change', /changed outside LoreReviser/.test(await confirmDlg().textContent()));
  await editElsewhere('Eldoria', 1, 'Changed again while the question was open.');
  await confirmDlg().locator('.popup-button-ok').click();
  await page.waitForFunction(() => /Not restored/.test([...document.querySelectorAll('.toast-message')].map(t => t.textContent).join(' ')));
  check('6: change between confirm and write -> not restored, nothing overwritten', (await entryOnServer('Eldoria', 1)).content === 'Changed again while the question was open.' && (await readFile(idx.Eldoria)).records.length === 2);
  await page.evaluate(() => toastr.clear());
  await recs().first().locator('.lorerev_btn_restore').click();
  await confirmDlg().waitFor();
  await confirmDlg().locator('.popup-button-ok').click();
  await page.waitForFunction(() => document.querySelectorAll('dialog.lorerev_hist_popup .lorerev_hist_rec').length === 3);
  const arc3 = await readFile(idx.Eldoria);
  check('6: confirmed restore over an outside change: written, and the outside text is kept in History', (await entryOnServer('Eldoria', 1)).content === MAREN_NEW && arc3.records[2].old.content === 'Changed again while the question was open.');
  await hist().locator('.lorerev_hist_filter').selectOption('1');
  check('6: filter to one entry', (await recs().count()) === 3);
  await closeHist();
  await card('Kingdom of Eldoria').locator('.lorerev_btn_hist').click();
  await hist().waitFor(); await hist().locator('.lorerev_hist_empty').waitFor();
  check('6: entry without saved changes -> plain message', /No saved changes yet for this entry/.test(await hist().textContent()));
  await closeHist();

  // ================= 7. orphaned archive + relink =================
  await closeModal();
  await page.evaluate(async () => {
    const ctx = SillyTavern.getContext();
    const h = ctx.getRequestHeaders();
    const data = await (await fetch('/api/worldinfo/get', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Chat Lore' }) })).json();
    await fetch('/api/worldinfo/edit', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Chat Lore Renamed', data }) });
    await fetch('/api/worldinfo/delete', { method: 'POST', headers: h, body: JSON.stringify({ name: 'Chat Lore' }) });
    await ctx.updateWorldInfoList();
  });
  await openModal();
  const orphan = page.locator('.lorerev_orphan[data-book="Chat Lore"]');
  await orphan.waitFor();
  check('7: orphaned archive listed with its file', (await page.locator('.lorerev_orphan').count()) === 1 && (await orphan.textContent()).includes(chatFile));
  const targets = await orphan.locator('option').allTextContents();
  check('7: relink choices = existing lorebooks without their own history', targets.includes('Chat Lore Renamed') && !targets.includes('Eldoria') && !targets.includes('Chat Lore'), targets.join('|'));
  await page.locator('.lorerev_orphans_title').scrollIntoViewIfNeeded();
  await shot('55-orphaned-archive.png');
  await orphan.locator('.lorerev_btn_relink').click();
  check('7: Relink without a choice asks to pick', /Pick the lorebook/.test(await page.locator('.toast-message').last().textContent()) && (await index())['Chat Lore'] === chatFile);
  await orphan.locator('select').selectOption('Chat Lore Renamed');
  await orphan.locator('.lorerev_btn_relink').click();
  await page.waitForFunction(() => !document.querySelector('.lorerev_orphan'));
  const idx7 = await index();
  check('7: index key renamed, same file', idx7['Chat Lore Renamed'] === chatFile && !('Chat Lore' in idx7));
  const chatArc7 = await readFile(chatFile);
  check('7: file kept (nothing deleted), records intact, real name updated inside', chatArc7.book === 'Chat Lore Renamed' && chatArc7.records.length === 3 && JSON.stringify(chatArc7.renamedFrom) === '["Chat Lore"]');
  // history and restore work under the new name
  await page.evaluate(() => { import('/scripts/extensions/third-party/LoreReviser/history.js').then(m => m.openHistory({ book: 'Chat Lore Renamed' })); });
  await hist().waitFor(); await recs().first().waitFor();
  check('7: History of the relinked book shows its records', (await recs().count()) === 3);
  await recs().last().locator('.lorerev_btn_restore').click(); // the first approval: its old side is the original text
  await confirmDlg().waitFor(); await confirmDlg().locator('.popup-button-ok').click();
  await page.waitForFunction(() => document.querySelectorAll('dialog.lorerev_hist_popup .lorerev_hist_rec').length === 4);
  check('7: Restore into the renamed lorebook', (await entryOnServer('Chat Lore Renamed', 0)).content === HEIR_OLD);
  await closeHist();

  // ================= 8. archive names for awkward book names; a damaged/foreign file is never overwritten =================
  const odd = await page.evaluate(async () => {
    const a = await import('/scripts/extensions/third-party/LoreReviser/archive.js');
    const c = await import('/scripts/extensions/third-party/LoreReviser/archive-core.js');
    const name = 'Château Ünicode / 日本 ';
    const r = c.makeRecord({ action: 'approve', uid: 1, title: 'Ü', before: { keys: [], secondary: [], content: 'alt' }, after: { keys: ['ü'], secondary: [], content: 'neu – ✓' } });
    await a.appendRecord(name, r);
    const file = a.getArchiveIndex()[name];
    const back = await a.readArchive(name);
    await fetch('/api/files/upload', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify({ name: file, data: btoa('{"not":"ours"}') }) });
    let err = ''; try { await a.appendRecord(name, r); } catch (e) { err = e.message; }
    delete a.getArchiveIndex()[name];
    return { file, book: back.book, content: back.records[0].new.content, err };
  });
  check('8: non-ASCII / slash book name -> valid flat file name, UTF-8 text survives', /^LoreReviser-archive__Chateau-Unicode__[0-9a-f]{8}\.json$/.test(odd.file) && odd.book === 'Château Ünicode / 日本 ' && odd.content === 'neu – ✓', JSON.stringify(odd));
  check('8: a file that is not a LoreReviser history file is not overwritten', /not a LoreReviser history file/.test(odd.err), odd.err);
  await page.evaluate(() => SillyTavern.getContext().saveSettingsDebounced());
} catch (e) {
  console.log('TEST ERROR', e); failures++;
  try { const pg = browser.contexts()[0].pages()[0]; console.log('TOASTS:', await pg.locator('.toast-message').allTextContents()); await pg.screenshot({ path: `${SHOTS}/zz-archive-failure.png` }); } catch {}
} finally {
  await browser.close();
}
console.log(failures ? `${failures} FAILURE(S)` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
