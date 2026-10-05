// Seeds the test ST instance: lorebooks, a character linked to one, and a chat linked to another.
const BASE = 'http://localhost:8766';
let cookie = '';
const res0 = await fetch(`${BASE}/csrf-token`);
cookie = (res0.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
const token = (await res0.json()).token;
const H = { 'Content-Type': 'application/json', 'X-CSRF-Token': token, Cookie: cookie };
const post = async (url, body) => {
  const r = await fetch(BASE + url, { method: 'POST', headers: H, body: JSON.stringify(body) });
  console.log(url, r.status);
  return r;
};
const entry = (uid, comment, key, content, extra = {}) => ({ uid, key, keysecondary: [], comment, content, constant: false, selective: true, order: 100, position: 0, disable: false, displayIndex: uid, ...extra });
const book = (...es) => ({ entries: Object.fromEntries(es.map(e => [e.uid, e])) });

await post('/api/worldinfo/edit', { name: 'Eldoria', data: book(
  entry(0, 'Kingdom of Eldoria', ['Eldoria', 'the kingdom'], 'A northern kingdom ruled by Queen Maren.'),
  entry(1, 'Queen Maren', ['Maren', 'queen'], 'Stern but fair monarch, 54 years old.'),
  entry(2, '', ['Silverwood', 'forest'], 'An ancient forest on the border.'),
  entry(3, 'Old rumor (disabled)', ['rumor'], 'Unused.', { disable: true })) });
await post('/api/worldinfo/edit', { name: 'Eldoria Extras', data: book(
  entry(0, 'Festival of Lanterns', ['festival'], 'Held each autumn.'),
  entry(1, 'Harbor Guild', ['guild', 'harbor'], 'Controls trade.')) });
await post('/api/worldinfo/edit', { name: 'Global Lore', data: book(
  entry(0, 'Magic System', ['magic'], 'Magic is drawn from lanterns.'),
  entry(1, 'Currency', ['coin', 'gold'], 'Silver crowns.', { constant: true })) });
await post('/api/worldinfo/edit', { name: 'Chat Lore', data: book(
  entry(0, 'The Missing Heir', ['heir'], 'Prince Aldric vanished last winter.'),
  entry(1, 'Secret Passage', ['passage'], '@@activate\nBehind the throne. {{user}} knows the way.', { keysecondary: ['throne'] })) });
await post('/api/worldinfo/edit', { name: 'Persona Lore', data: book(
  entry(1, 'Festival of Lanterns', ['festival'], 'The Festival of Lanterns is held each autumn in the harbor town of Saltmere. Every household floats a paper lantern for someone they have lost.\nThe festival is run by the Harbor Guild. The guild master lights the first lantern at dusk, and nobody may speak until the last one has drifted past the lighthouse.\nChildren are told that the lanterns guide the dead home. Sailors say the lanterns are only there to keep the fishing boats from the rocks.\nThe week after the festival, the town holds a market where the guild sells the remaining lantern paper at half price.'),
  entry(0, 'Traveler Backstory', ['traveler'], 'You grew up in the fishing village of Saltmere, the youngest of five children. Your father mended nets and your mother sold smoked eel at the harbor market. You learned to read from the tide tables nailed to the harbor wall.\nAt seventeen you left for the capital to apprentice with a cartographer. You are quietly proud of your maps, though you rarely show them to anyone. You distrust nobles and carry your father\'s brass compass everywhere.')) });
await post('/api/worldinfo/edit', { name: 'The Wishing Game - Frankie', data: book(
  entry(0, 'Frankie', ['Frankie'], 'Runs the wishing game.'),
  entry(1, 'The Wishing Well', ['well'], 'Grants one wish per night.')) });
await post('/api/worldinfo/edit', { name: 'Intimate Encounters - Complete Compendium', data: book(
  entry(0, 'Compendium Index', ['index'], 'Table of contents.')) });
await post('/api/worldinfo/edit', { name: 'Unlinked Book', data: book(
  entry(0, 'Should not appear', ['x'], 'nope')) });

// Character linked to "Eldoria"
const fd = new FormData();
for (const [k, v] of Object.entries({ ch_name: 'Test Queen', description: 'A queen.', first_mes: 'Greetings, traveler.', personality: 'stern', scenario: 'Throne room', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', tags: '', creator: '', character_version: '', talkativeness: '0.5', fav: 'false', world: 'Eldoria', depth_prompt_prompt: '', depth_prompt_depth: '4', depth_prompt_role: 'system', alternate_greetings: '' })) fd.append(k, v);
const r = await fetch(`${BASE}/api/characters/create`, { method: 'POST', headers: { 'X-CSRF-Token': token, Cookie: cookie }, body: fd });
console.log('create char', r.status, await r.text());

// Chat linked to "Chat Lore"
const msgs = [{ chat_metadata: { world_info: 'Chat Lore' }, user_name: 'User', character_name: 'Test Queen', create_date: '2026-10-04@12h00m00s' }];
for (let i = 0; i < 8; i++) msgs.push({ name: i % 2 ? 'Test Queen' : 'User', is_user: i % 2 === 0, is_system: false, send_date: Date.now() + i, mes: `Message number ${i + 1}`, extra: {} });
msgs.push({ name: 'Narrator', is_user: false, is_system: true, send_date: Date.now(), mes: 'hidden message', extra: {} });
await post('/api/chats/save', { avatar_url: 'Test Queen.png', file_name: 'Test Queen - 2026-10-04@12h00m00s', chat: msgs });
