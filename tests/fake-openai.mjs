// Fake OpenAI-compatible server for tests. Replies come from a queue set by the test.
//   POST /__queue    body: [{content, finish_reason?, status?, delayMs?}, ...]   replaces the queue
//   GET  /__requests list of request bodies received on /v1/chat/completions
//   POST /__reset    clears queue and request log
// In `content`, {{id:Some Title}} is replaced by the entry id (E1, E2...) that has that title in the request.
// Usage: node tests/fake-openai.mjs [port]
import http from 'node:http';

const port = Number(process.argv[2] ?? 9099);
let queue = [];
let requests = [];

const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d)); });

function fill(content, body) {
    const userText = (body.messages ?? []).map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    return content.replace(/\{\{id:([^}]+)\}\}/g, (_, title) => {
        const m = userText.match(new RegExp(`<entry id="(E\\d+)" book="[^"]*" title="${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
        return m ? m[1] : 'E?';
    });
}

http.createServer(async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/__queue' && req.method === 'POST') { queue = JSON.parse(await readBody(req)); return json(200, { ok: true, queued: queue.length }); }
    if (req.url === '/__requests') return json(200, requests);
    if (req.url === '/__reset') { queue = []; requests = []; return json(200, { ok: true }); }
    if (req.url?.endsWith('/chat/completions') && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        requests.push(body);
        const next = queue.shift() ?? { content: '[]' };
        if (next.delayMs) {
            let aborted = false;
            req.on('close', () => { aborted = true; });
            await new Promise(r => setTimeout(r, next.delayMs));
            if (aborted) return;
        }
        if (next.status && next.status !== 200) return json(next.status, { error: { message: next.errorMessage ?? 'Scripted failure', type: 'server_error' } });
        return json(200, {
            id: 'fake-1', object: 'chat.completion', created: 0, model: body.model ?? 'fake-model',
            choices: [{ index: 0, message: { role: 'assistant', content: fill(next.content ?? '[]', body) }, finish_reason: next.finish_reason ?? 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
    }
    if (req.url?.endsWith('/models')) return json(200, { data: [{ id: 'fake-model' }] });
    json(404, { error: 'not found' });
}).listen(port, '127.0.0.1', () => console.log(`fake OpenAI server on http://127.0.0.1:${port}`));
