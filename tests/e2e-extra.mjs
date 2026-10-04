import { chromium } from 'playwright-core';
const SHOTS = process.env.SHOTS_DIR ?? '/workspace/LoreReviser-shots';
let failures = 0;
const check = (n, ok, x='') => { console.log(`${ok?'PASS':'FAIL'}: ${n} ${x}`); if(!ok) failures++; };
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'], headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:8766/');
  await page.waitForSelector('#send_textarea');
  await page.waitForTimeout(3000);
  // 1) no chat open -> warning, no modal
  const hasChat = await page.evaluate(() => !!SillyTavern.getContext().chatId);
  console.log('chat open after fresh load:', hasChat);
  if (!hasChat) {
    await page.click('#extensionsMenuButton'); await page.click('#lorereviser_open');
    await page.waitForTimeout(800);
    check('no chat: modal not opened', (await page.locator('.lorerev_root').count()) === 0);
    check('no chat: warning toast', (await page.locator('.toast-warning').count()) > 0);
    await page.screenshot({ path: `${SHOTS}/09-no-chat-warning.png` });
  }
  // 2) per-chat selection persists on the server
  await page.evaluate(async () => {
    const ctx = SillyTavern.getContext();
    await ctx.selectCharacterById(ctx.characters.findIndex(c => c.name === 'Test Queen'));
    await new Promise(r => setTimeout(r, 1500));
    await ctx.openCharacterChat('Test Queen - 2026-10-04@12h00m00s');
    await new Promise(r => setTimeout(r, 1500));
  });
  await page.click('#extensionsMenuButton'); await page.click('#lorereviser_open');
  await page.waitForSelector('.lorerev_book');
  check('selection restored from chat metadata after page reload', (await page.textContent('#lorerev_selected_info')) === '5 entries selected in 2 book(s)', await page.textContent('#lorerev_selected_info'));
  await page.screenshot({ path: `${SHOTS}/10-after-reload.png` });
  await page.click('dialog[open] .popup-button-ok');
  // 3) a lorebook edit in ST shows up next time (rename an entry title)
  await page.evaluate(async () => {
    const ctx = SillyTavern.getContext();
    const d = await ctx.loadWorldInfo('Chat Lore'); d.entries[0].comment = 'Renamed Heir'; await ctx.saveWorldInfo('Chat Lore', d, true);
  });
  await page.click('#extensionsMenuButton'); await page.click('#lorereviser_open');
  await page.waitForSelector('.lorerev_book');
  await page.locator('.lorerev_book[data-book="Chat Lore"] .lorerev_toggle').click();
  check('edited entry title visible on reopen', (await page.locator('.lorerev_book[data-book="Chat Lore"] .lorerev_entry span').allTextContents()).includes('Renamed Heir'));
  // 4) small screen: layout stacks, nothing overflows
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForTimeout(500);
  const small = await page.evaluate(() => { const r = s => document.querySelector(s).getBoundingClientRect(); return { popup: r('dialog[open].lorerev_popup'), sidebar: r('.lorerev_sidebar'), main: r('.lorerev_main'), vw: innerWidth }; });
  check('small screen: popup fits viewport', small.popup.width <= small.vw && small.popup.left >= 0, JSON.stringify(small.popup.width));
  check('small screen: sidebar stacks above main', small.sidebar.width > small.popup.width * 0.8 && small.main.top >= small.sidebar.bottom - 1);
  await page.screenshot({ path: `${SHOTS}/13-small-screen.png` });
} catch (e) { console.log('TEST ERROR', e); failures++; } finally { await browser.close(); }
console.log(failures ? 'FAILURES' : 'ALL PASSED');
