const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const base = 'https://example.test/wordking/';
const word = (id, english, definition) => ({ id, english,
    meanings: [{ partOfSpeech: 'noun', definitions: [definition] }], lessonIds: ['測試U1'], isWrong: false });
const publicWords = [word('w_000001', 'apple', '蘋果')];

function publicResponse(url, body) {
    const pathname = new URL(url).pathname;
    let type = 'application/javascript';
    if (pathname.endsWith('.html')) type = 'text/html';
    else if (pathname.endsWith('.css')) type = 'text/css';
    else if (pathname.endsWith('.webmanifest')) type = 'application/manifest+json';
    else if (pathname.endsWith('.json')) type = 'application/json';
    else if (pathname.endsWith('.svg')) type = 'image/svg+xml';
    else if (pathname.endsWith('.png')) type = 'image/png';
    const content = body ?? (pathname.endsWith('.html') ? '<!doctype html><html lang="zh-Hant"><body>installed shell</body></html>'
        : pathname.endsWith('words.json') ? JSON.stringify(publicWords) : 'public shell');
    const response = new Response(content, { headers: { 'content-type': type } });
    Object.defineProperty(response, 'url', { value: url });
    return response;
}

function workerHarness(options = {}) {
    const stores = options.stores || new Map();
    const listeners = new Map();
    const calls = { fetches: [], imports: [], writes: [], deleted: [], claim: 0, skip: 0 };
    let writeFailure = null;
    let writeHook = null;
    const normalize = input => typeof input === 'string' ? input : input.url;
    const cacheAPI = {
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const store = stores.get(name);
            return {
                async put(key, response) {
                    calls.writes.push({ name, url: normalize(key) });
                    if (writeFailure?.(name, normalize(key))) throw new Error('Storage quota exceeded');
                    await writeHook?.(name, normalize(key));
                    store.set(normalize(key), response.clone());
                },
                async match(key) { return store.get(normalize(key))?.clone(); },
                async delete(key) { return store.delete(normalize(key)); }
            };
        },
        async keys() { return [...stores.keys()]; },
        async delete(name) { calls.deleted.push(name); return stores.delete(name); }
    };
    let network = options.fetch || (async request => publicResponse(normalize(request)));
    const context = vm.createContext({
        URL, Request, Response, Headers, AbortController, setTimeout, clearTimeout,
        ...(options.now ? { Date: { now: options.now } } : {}),
        caches: cacheAPI,
        importScripts(url) {
            calls.imports.push(url);
            assert.equal(new URL(url).pathname, new URL('assets/word-data.js', options.scope || base).pathname);
            vm.runInContext(fs.readFileSync(path.join(root, 'assets/word-data.js'), 'utf8'), context);
        },
        fetch: async (request, init) => {
            calls.fetches.push({ url: normalize(request), request, init });
            return network(request, init);
        },
        self: {
            registration: { scope: options.scope || base },
            clients: { async claim() { calls.claim += 1; } },
            async skipWaiting() { calls.skip += 1; },
            addEventListener(type, handler) { listeners.set(type, handler); }
        }
    });
    vm.runInContext(options.release ? source.replace(/const RELEASE = '[^']+'/,
        `const RELEASE = '${options.release}'`) : source, context, { filename: 'sw.js' });
    const values = JSON.parse(vm.runInContext('JSON.stringify({ RELEASE, CACHE_PREFIX, CACHE_NAME, PUBLIC_CACHE_NAME, INDEX_URL, WORDS_URL, PRECACHE_URLS, SHELL_URLS })', context));
    return {
        ...values, stores, calls, cacheAPI,
        setNetwork(fn) { network = fn; },
        setWriteFailure(fn) { writeFailure = fn; },
        setWriteHook(fn) { writeHook = fn; },
        async install() { await this.lifecycle('install'); await this.lifecycle('activate'); },
        async lifecycle(type) {
            let pending;
            listeners.get(type)({ waitUntil(promise) { pending = promise; } });
            return pending;
        },
        fetch(url, extras = {}) {
            let response;
            const request = { url: new URL(url, options.scope || base).href, method: 'GET', headers: new Headers(), mode: 'cors', ...extras };
            listeners.get('fetch')({ request, respondWith(value) { response = value; } });
            return response;
        },
        async message(data, clientURL = base, sourceID = 'app-client') {
            let pending;
            const replies = [];
            const port = { postMessage(value) { replies.push(JSON.parse(JSON.stringify(value))); }, close() {} };
            listeners.get('message')({ source: { id: sourceID, url: clientURL }, data, ports: [port], waitUntil(value) { pending = value; } });
            await pending;
            return replies;
        }
    };
}

test('manifest stays within the deployment scope and app icons have declared dimensions', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.id, './');
    assert.equal(manifest.scope, './');
    assert.equal(manifest.display, 'standalone');
    for (const url of [manifest.start_url, ...manifest.shortcuts.map(item => item.url)]) {
        assert.equal(new URL(url, base).pathname, '/wordking/');
    }
    for (const icon of [...manifest.icons, { src: './assets/icons/apple-touch-icon.png', sizes: '180x180' }]) {
        const bytes = fs.readFileSync(path.join(root, icon.src));
        assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
        assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
    }
    assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
});

test('precache contains every local HTML script and stylesheet at its exact release URL', () => {
    const h = workerHarness();
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const references = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"|<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)]
        .map(match => new URL(match[1] || match[2], base));
    assert.ok(references.length >= 8);
    for (const url of references.filter(url => url.origin === new URL(base).origin)) {
        assert.ok(h.PRECACHE_URLS.includes(url.href), `Missing exact offline resource: ${url.href}`);
        assert.equal(url.searchParams.get('v'), h.RELEASE);
    }
    for (const url of h.PRECACHE_URLS) assert.ok(fs.existsSync(path.join(root, new URL(url).pathname.slice('/wordking/'.length))), url);
});

test('installation validates the complete public allowlist without credentials or early activation', async () => {
    const h = workerHarness();
    await h.install();
    assert.deepEqual(h.calls.fetches.map(call => call.url).sort(), [...h.PRECACHE_URLS].sort());
    assert.ok(h.calls.fetches.every(call => call.request.credentials === 'omit' && call.request.redirect === 'error'));
    assert.equal(h.calls.skip, 0);
    assert.equal(h.stores.get(h.CACHE_NAME).size, h.SHELL_URLS.length);
    assert.equal(h.stores.get(h.PUBLIC_CACHE_NAME).size, 1);
    assert.deepEqual(h.calls.imports, [new URL(`assets/word-data.js?v=${h.RELEASE}`, base).href]);
    const [status] = await h.message({ type: 'GET_OFFLINE_STATUS' });
    assert.equal(status.ready, true);
    assert.equal(status.release, h.RELEASE);
    assert.equal(status.publicSync, true);
});

test('installation drains streamed bodies before exhausting a bounded connection pool', async () => {
    const waiting = [];
    const active = new Set();
    let peakConnections = 0;
    let queuedRequests = 0;
    let completedBodies = 0;
    const acquire = () => new Promise((resolve, reject) => {
        const begin = () => {
            const connection = { fail: null };
            active.add(connection);
            peakConnections = Math.max(peakConnections, active.size);
            resolve(connection);
        };
        if (active.size < 2) begin();
        else { queuedRequests += 1; waiting.push({ begin, reject }); }
    });
    const release = connection => {
        if (!active.delete(connection)) return;
        waiting.shift()?.begin();
    };
    const h = workerHarness({ fetch: async request => {
        const connection = await acquire();
        const template = publicResponse(request.url);
        const bytes = new Uint8Array(await template.arrayBuffer());
        let offset = 0;
        // Headers arrive immediately, but an unread body retains its connection.
        // A zero high-water mark prevents this transport from draining itself.
        const stream = new ReadableStream({
            start(controller) { connection.fail = error => controller.error(error); },
            pull(controller) {
                if (offset < bytes.length) {
                    controller.enqueue(bytes.subarray(offset, offset += 8));
                } else {
                    controller.close();
                    completedBodies += 1;
                    release(connection);
                }
            },
            cancel() { release(connection); }
        }, { highWaterMark: 0 });
        const response = new Response(stream, { headers: template.headers });
        Object.defineProperty(response, 'url', { value: request.url });
        return response;
    } });
    let deadline;
    const installation = h.install();
    try {
        await Promise.race([
            installation,
            new Promise((resolve, reject) => {
                deadline = setTimeout(() => reject(new Error('Unread response bodies blocked the connection pool')), 1000);
            })
        ]);
        assert.equal(peakConnections, 2);
        assert.ok(queuedRequests > 0, 'The install must encounter the connection limit');
        assert.equal(completedBodies, h.PRECACHE_URLS.length);
        assert.equal(active.size, 0);
        assert.equal(h.stores.get(h.CACHE_NAME).size, h.SHELL_URLS.length);
        assert.deepEqual(await h.stores.get(h.PUBLIC_CACHE_NAME).get(h.WORDS_URL).clone().json(), publicWords);
    } finally {
        clearTimeout(deadline);
        const error = new Error('Connection-pool test finished');
        for (const entry of waiting.splice(0)) entry.reject(error);
        for (const connection of active) connection.fail?.(error);
        active.clear();
        await installation.catch(() => {});
    }
});

test('a failed public resource validation cannot publish a partially prepared shell', async () => {
    for (const invalid of [
        () => new Response('login', { headers: { 'content-type': 'text/html' } }),
        url => { const response = publicResponse(url); Object.defineProperty(response, 'redirected', { value: true }); return response; },
        url => { const response = publicResponse(url); Object.defineProperty(response, 'type', { value: 'opaque' }); return response; },
        url => { const response = publicResponse(url); response.headers.set('vary', '*'); return response; }
    ]) {
        const h = workerHarness({ fetch: async request => request.url.endsWith('words.json') ? invalid(request.url) : publicResponse(request.url) });
        h.stores.set(`${h.CACHE_PREFIX}previous`, new Map());
        await assert.rejects(h.lifecycle('install'));
        assert.equal(h.stores.has(h.CACHE_NAME), false);
        assert.ok(h.stores.has(`${h.CACHE_PREFIX}previous`));
        assert.deepEqual(h.calls.deleted, []);
        assert.equal(h.calls.skip, 0);
    }
});

test('activation retires only this app scope caches and claims without forcing a page reload', async () => {
    const h = workerHarness();
    const old = `${h.CACHE_PREFIX}old`;
    const foreign = 'wordking-pwa:%2Fanother-project%2F:old';
    for (const name of [old, h.CACHE_NAME, h.PUBLIC_CACHE_NAME, foreign, 'unrelated-cache']) h.stores.set(name, new Map());
    await h.lifecycle('activate');
    assert.deepEqual(h.calls.deleted, [old]);
    assert.ok(h.stores.has(foreign));
    assert.ok(h.stores.has('unrelated-cache'));
    assert.ok(h.stores.has(h.PUBLIC_CACHE_NAME));
    assert.equal(h.calls.claim, 1);
    assert.equal(h.calls.skip, 0);
});

test('private services, unrelated paths, music, archives and query variants bypass the worker', () => {
    const h = workerHarness();
    const bypass = [
        'https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel',
        'https://identitytoolkit.googleapis.com/v1/accounts:lookup',
        'https://securetoken.googleapis.com/v1/token',
        'https://example.test/other/index.html',
        './api/profile', './users/private-id', './data/migration-archive.json', './music/song.mp3',
        './data/words.json?token=private', './assets/app.js?v=unknown', './assets/private.json'
    ];
    for (const url of bypass) assert.equal(h.fetch(url, { mode: 'navigate' }), undefined, url);
    assert.equal(h.fetch('./data/words.json', { method: 'POST' }), undefined);
    assert.equal(h.fetch('./data/words.json', { headers: new Headers({ Authorization: 'Bearer test' }) }), undefined);
    assert.equal(h.fetch('./data/words.json', { headers: new Headers({ Cookie: 'session=test' }) }), undefined);
    assert.equal(h.calls.fetches.length, 0);
});

test('offline navigations use the installed canonical shell and mark public-only bootstrap', async () => {
    const h = workerHarness();
    await h.install();
    h.setNetwork(async () => { throw new TypeError('offline'); });
    for (const path of ['./?page=practice&folder=personal-secret', './index.html?page=library']) {
        const response = await h.fetch(path, { mode: 'navigate' });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('X-WordKing-Offline'), '1');
        assert.match(await response.text(), /<html data-wordking-offline="true" lang="zh-Hant">/);
    }
    const cached = h.stores.get(h.CACHE_NAME).get(h.INDEX_URL);
    assert.doesNotMatch(await cached.clone().text(), /data-wordking-offline/);
    assert.equal(h.stores.get(h.CACHE_NAME).size, h.SHELL_URLS.length);
    const empty = workerHarness({ fetch: async () => { throw new TypeError('offline'); } });
    assert.equal((await empty.fetch('./', { mode: 'navigate' })).status, 503);
});

test('network navigation does not overwrite the older installed offline shell', async () => {
    const h = workerHarness();
    await h.install();
    h.setNetwork(async request => publicResponse(request.url, '<html><body>new release</body></html>'));
    const response = await h.fetch('./?page=home', { mode: 'navigate' });
    assert.match(await response.text(), /new release/);
    assert.match(await h.stores.get(h.CACHE_NAME).get(h.INDEX_URL).clone().text(), /installed shell/);
    h.setNetwork(async () => new Response('server unavailable', { status: 503 }));
    assert.equal((await h.fetch('./', { mode: 'navigate' })).headers.get('X-WordKing-Offline'), '1');
});

test('public vocabulary accepts valid refreshes and preserves the last good copy on failure', async () => {
    const h = workerHarness();
    await h.install();
    const fresh = [word('w_000002', 'book', '書')];
    h.setNetwork(async request => publicResponse(request.url, JSON.stringify(fresh)));
    assert.deepEqual(await (await h.fetch('./data/words.json')).json(), fresh);
    for (const invalid of ['not JSON', '{}', '[]']) {
        h.setNetwork(async request => publicResponse(request.url, invalid));
        assert.deepEqual(await (await h.fetch('./data/words.json')).json(), fresh);
    }
    h.setNetwork(async () => new Response('private login', { headers: { 'content-type': 'text/html' } }));
    assert.deepEqual(await (await h.fetch('./data/words.json')).json(), fresh);
    h.setNetwork(async () => { throw new TypeError('offline'); });
    assert.deepEqual(await (await h.fetch('./data/words.json')).json(), fresh);
    h.stores.get(h.PUBLIC_CACHE_NAME).delete(h.WORDS_URL);
    const absent = await h.fetch('./data/words.json');
    assert.equal(absent.status, 503);
    assert.deepEqual(await absent.json(), { error: 'public-vocabulary-unavailable' });
});

test('exact shell URLs work offline while unsafe eviction recovery cannot enter the cache', async () => {
    const h = workerHarness();
    await h.install();
    const asset = h.SHELL_URLS.find(url => url.includes('assets/app.js?'));
    h.setNetwork(async () => { throw new TypeError('offline'); });
    assert.equal((await h.fetch(asset)).status, 200);
    h.stores.get(h.CACHE_NAME).delete(asset);
    h.setNetwork(async () => new Response('login', { headers: { 'content-type': 'text/html' } }));
    await h.fetch(asset);
    assert.equal(h.stores.get(h.CACHE_NAME).has(asset), false);
    const [status] = await h.message({ type: 'GET_OFFLINE_STATUS' });
    assert.equal(status.ready, false);
});

test('only this app document can request waiting-worker activation or readiness', async () => {
    const h = workerHarness();
    for (const url of ['https://evil.test/wordking/', 'https://example.test/other/', `${base}api/private`]) {
        assert.deepEqual(await h.message({ type: 'GET_OFFLINE_STATUS' }, url), []);
        assert.deepEqual(await h.message({ type: 'SYNC_PUBLIC_WORDS' }, url), []);
        await h.message({ type: 'SKIP_WAITING' }, url);
    }
    assert.deepEqual(await h.message({ type: 'SYNC_PUBLIC_WORDS' }, base, ''), []);
    assert.equal(h.calls.fetches.length, 0);
    await h.message({ type: 'SKIP_WAITING' }, base, '');
    assert.equal(h.calls.skip, 0);
    const [status] = await h.message({ type: 'GET_OFFLINE_STATUS' }, `${base}index.html?page=home`);
    assert.equal(status.ready, false);
    await h.message({ type: 'SKIP_WAITING' }, `${base}?page=practice`);
    assert.equal(h.calls.skip, 1);
});

test('public sync saves the complete canonical catalog before reporting success and survives a worker restart', async () => {
    let now = 1000;
    const h = workerHarness({ now: () => now });
    await h.install();
    const next = [
        { ...publicWords[0], meanings: [{ partOfSpeech: 'noun', definitions: ['蘋果', '蘋果樹'] }] },
        { ...word('w_000002', 'book', '書'), lessonIds: ['新課程U2'] }
    ];
    now = 2000;
    h.setNetwork(async request => publicResponse(request.url, JSON.stringify(next)));
    const [result] = await h.message({ type: 'SYNC_PUBLIC_WORDS', url: 'https://evil.test/private' });
    assert.equal(result.type, 'PUBLIC_WORDS_SYNC');
    assert.equal(result.ok, true);
    assert.equal(result.updated, true);
    assert.equal(result.checkedAt, now);
    assert.deepEqual(result.words, next);
    const saved = h.stores.get(h.PUBLIC_CACHE_NAME).get(h.WORDS_URL);
    assert.deepEqual(await saved.clone().json(), next);
    assert.equal(saved.headers.get('x-wordking-checked-at'), String(now));
    const call = h.calls.fetches.at(-1);
    assert.equal(call.url, h.WORDS_URL);
    assert.equal(call.request.cache, 'no-store');
    assert.equal(call.request.credentials, 'omit');
    assert.equal(call.request.redirect, 'error');
    now = 3000;
    const [unchanged] = await h.message({ type: 'SYNC_PUBLIC_WORDS' });
    assert.equal(unchanged.ok, true);
    assert.equal(unchanged.updated, false);
    assert.equal(unchanged.checkedAt, now);
    assert.deepEqual(unchanged.words, next);
    const restarted = workerHarness({ stores: h.stores, fetch: async () => { throw new TypeError('offline'); } });
    assert.deepEqual(await (await restarted.fetch('./data/words.json')).json(), next);
    assert.equal((await restarted.message({ type: 'GET_OFFLINE_STATUS' }))[0].ready, true);
});

test('schema-invalid public downloads never replace the last good offline vocabulary', async () => {
    const h = workerHarness();
    await h.install();
    const invalidCatalogs = [
        [], [{}], [null], [{ ...publicWords[0], id: 'w_000000' }],
        [{ ...publicWords[0], id: 'c_private' }],
        [publicWords[0], publicWords[0]],
        [publicWords[0], { ...publicWords[0], id: 'w_000002', english: ' APPLE ' }],
        [{ ...publicWords[0], english: '' }],
        [{ ...publicWords[0], meanings: [] }],
        [{ ...publicWords[0], meanings: [{ partOfSpeech: 'invalid', definitions: ['蘋果'] }] }],
        [{ ...publicWords[0], meanings: [{ partOfSpeech: 'noun', definitions: [] }] }],
        [{ ...publicWords[0], meanings: [{ partOfSpeech: 'noun', definitions: [' '] }] }],
        [{ ...publicWords[0], meanings: [publicWords[0].meanings[0], publicWords[0].meanings[0]] }],
        [{ ...publicWords[0], lessonIds: ['重複', '重複'] }],
        [{ ...publicWords[0], lessonIds: ['../private'] }],
        [{ ...publicWords[0], isWrong: 'false' }],
        [{ ...publicWords[0], privateData: { secret: 'must-not-cache' } }]
    ];
    const before = await h.stores.get(h.PUBLIC_CACHE_NAME).get(h.WORDS_URL).clone().text();
    for (const invalid of invalidCatalogs) {
        h.setNetwork(async request => publicResponse(request.url, JSON.stringify(invalid)));
        const [result] = await h.message({ type: 'SYNC_PUBLIC_WORDS' });
        assert.deepEqual(result, { type: 'PUBLIC_WORDS_SYNC', ok: false, updated: false, checkedAt: null });
        assert.equal(await h.stores.get(h.PUBLIC_CACHE_NAME).get(h.WORDS_URL).clone().text(), before);
    }
    h.setNetwork(async () => { throw new TypeError('offline'); });
    const [failed] = await h.message({ type: 'SYNC_PUBLIC_WORDS' });
    assert.equal(failed.ok, false);
    assert.equal(Object.hasOwn(failed, 'words'), false);
    assert.deepEqual(await (await h.fetch('./data/words.json')).json(), publicWords);
});

test('worker schema accepts the shipped catalog and the application default for absent isWrong', async () => {
    const shipped = JSON.parse(fs.readFileSync(path.join(root, 'data/words.json'), 'utf8'));
    const h = workerHarness({ fetch: async request => publicResponse(request.url,
        request.url.endsWith('words.json') ? JSON.stringify(shipped) : undefined) });
    await h.install();
    assert.deepEqual(await h.stores.get(h.PUBLIC_CACHE_NAME).get(h.WORDS_URL).clone().json(), shipped);
    const withoutFlag = { ...publicWords[0] };
    delete withoutFlag.isWrong;
    h.setNetwork(async request => publicResponse(request.url, JSON.stringify([withoutFlag])));
    const [result] = await h.message({ type: 'SYNC_PUBLIC_WORDS' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.words, publicWords);
});

test('simultaneous messages and a words fetch share one download and one atomic write', async () => {
    const h = workerHarness();
    await h.install();
    const next = [...publicWords, word('w_000002', 'book', '書')];
    let finishDownload;
    const download = new Promise(resolve => { finishDownload = resolve; });
    h.setNetwork(async request => {
        await download;
        return publicResponse(request.url, JSON.stringify(next));
    });
    const beforeFetches = h.calls.fetches.length;
    const beforeWrites = h.calls.writes.length;
    const first = h.message({ type: 'SYNC_PUBLIC_WORDS' });
    const second = h.message({ type: 'SYNC_PUBLIC_WORDS' });
    const page = h.fetch('./data/words.json');
    assert.equal(h.calls.fetches.length, beforeFetches + 1);
    finishDownload();
    const [one, two, response] = await Promise.all([first, second, page]);
    assert.equal(one[0].ok, true);
    assert.deepEqual(two, one);
    assert.deepEqual(await response.json(), next);
    assert.equal(h.calls.writes.length, beforeWrites + 1);
});

test('storage failure reports no saved update and leaves the previous public copy intact', async () => {
    const h = workerHarness();
    await h.install();
    const next = [...publicWords, word('w_000002', 'book', '書')];
    h.setNetwork(async request => publicResponse(request.url, JSON.stringify(next)));
    h.setWriteFailure(name => name === h.PUBLIC_CACHE_NAME);
    const [result] = await h.message({ type: 'SYNC_PUBLIC_WORDS' });
    assert.deepEqual(result, { type: 'PUBLIC_WORDS_SYNC', ok: false, updated: false, checkedAt: null });
    assert.deepEqual(await h.stores.get(h.PUBLIC_CACHE_NAME).get(h.WORDS_URL).clone().json(), publicWords);
    assert.deepEqual(await (await h.fetch('./data/words.json')).json(), publicWords);
    h.setWriteFailure(null);
    assert.equal((await h.message({ type: 'SYNC_PUBLIC_WORDS' }))[0].ok, true,
        'A failed single-flight operation must allow the next retry');
});

test('a failed shell installation cannot replace the active public snapshot', async () => {
    const active = workerHarness();
    await active.install();
    const next = [...publicWords, word('w_000002', 'book', '書')];
    const update = workerHarness({ stores: active.stores, release: 'future-release', fetch: async request =>
        publicResponse(request.url, request.url.endsWith('words.json') ? JSON.stringify(next) : undefined) });
    update.setWriteFailure((name, url) => name === update.CACHE_NAME && url.includes('assets/app.js'));
    await assert.rejects(update.lifecycle('install'), /Storage quota/);
    assert.deepEqual(await active.stores.get(active.PUBLIC_CACHE_NAME).get(active.WORDS_URL).clone().json(), publicWords);
    assert.ok(active.stores.has(active.CACHE_NAME));
});

test('waiting-worker installation and later activation preserve a newer public-only update', async () => {
    let now = 1000;
    const active = workerHarness({ now: () => now });
    await active.install();
    let finishShell;
    const shell = new Promise(resolve => { finishShell = resolve; });
    let wordsDownloaded;
    const gotWords = new Promise(resolve => { wordsDownloaded = resolve; });
    now = 2000;
    const waiting = workerHarness({ stores: active.stores, release: 'future-release', now: () => now,
        fetch: async request => {
            if (request.url.includes('assets/app.js')) await shell;
            if (request.url.endsWith('words.json')) wordsDownloaded();
            return publicResponse(request.url);
        } });
    const installation = waiting.lifecycle('install');
    await gotWords;
    // Let that download's body and schema validation finish before advancing time.
    await new Promise(resolve => setTimeout(resolve, 20));
    now = 3000;
    const next = [...publicWords, word('w_000002', 'book', '書')];
    active.setNetwork(async request => publicResponse(request.url, JSON.stringify(next)));
    assert.equal((await active.message({ type: 'SYNC_PUBLIC_WORDS' }))[0].ok, true);
    finishShell();
    await installation;
    assert.deepEqual(await active.stores.get(active.PUBLIC_CACHE_NAME).get(active.WORDS_URL).clone().json(), next);
    now = 4000;
    const latest = [...next, word('w_000003', 'day', '日')];
    active.setNetwork(async request => publicResponse(request.url, JSON.stringify(latest)));
    await active.message({ type: 'SYNC_PUBLIC_WORDS' });
    await waiting.lifecycle('activate');
    assert.equal(waiting.stores.has(active.CACHE_NAME), false);
    waiting.setNetwork(async () => { throw new TypeError('offline'); });
    assert.deepEqual(await (await waiting.fetch('./data/words.json')).json(), latest);
    assert.equal((await waiting.message({ type: 'GET_OFFLINE_STATUS' }))[0].ready, true);
});

test('a delayed installer Cache.put cannot overwrite an active worker write that finishes first', async () => {
    let now = 1000;
    const active = workerHarness({ now: () => now });
    await active.install();
    now = 2000;
    const waiting = workerHarness({ stores: active.stores, release: 'next-shell', now: () => now });
    let releasePut, reachedPut;
    const putGate = new Promise(resolve => { releasePut = resolve; });
    const putStarted = new Promise(resolve => { reachedPut = resolve; });
    waiting.setWriteHook(async (name, url) => {
        if (url !== waiting.WORDS_URL) return;
        reachedPut(name);
        await putGate;
    });
    const installation = waiting.lifecycle('install');
    assert.equal(await putStarted, waiting.CACHE_NAME,
        'The installer may write only its own release, never the shared database');
    now = 3000;
    const next = [...publicWords, word('w_000002', 'book', '書')];
    active.setNetwork(async request => publicResponse(request.url, JSON.stringify(next)));
    await active.message({ type: 'SYNC_PUBLIC_WORDS' });
    releasePut();
    await installation;
    assert.deepEqual(await active.stores.get(active.PUBLIC_CACHE_NAME).get(active.WORDS_URL).clone().json(), next,
        'Completing the older write after the newer write cannot roll the catalog back');
    assert.ok(waiting.stores.get(waiting.CACHE_NAME).has(waiting.WORDS_URL), 'Only a staged snapshot exists before activation');
    await waiting.lifecycle('activate');
    assert.equal(waiting.stores.get(waiting.CACHE_NAME).has(waiting.WORDS_URL), false);
    assert.deepEqual(await waiting.stores.get(waiting.PUBLIC_CACHE_NAME).get(waiting.WORDS_URL).clone().json(), next);
});

test('activation storage failure retains a validated staged offline fallback and can recover on the next sync', async () => {
    const h = workerHarness();
    await h.lifecycle('install');
    const legacy = `${h.CACHE_PREFIX}legacy-shell`;
    h.stores.set(legacy, new Map());
    h.setWriteFailure(name => name === h.PUBLIC_CACHE_NAME);
    await h.lifecycle('activate');
    assert.ok(h.stores.has(legacy), 'Do not erase fallback caches after a failed promotion');
    assert.ok(h.stores.get(h.CACHE_NAME).has(h.WORDS_URL), 'The installed snapshot remains durable');
    assert.equal(h.calls.claim, 1);
    h.setNetwork(async () => { throw new TypeError('offline'); });
    assert.deepEqual(await (await h.fetch('./data/words.json')).json(), publicWords);
    assert.equal((await h.message({ type: 'GET_OFFLINE_STATUS' }))[0].ready, true,
        'Readiness is truthful because the full shell and validated staged vocabulary can be served');
    const [failed] = await h.message({ type: 'SYNC_PUBLIC_WORDS' });
    assert.equal(failed.ok, false);
    assert.equal(Object.hasOwn(failed, 'words'), false);
    h.setWriteFailure(null);
    const next = [...publicWords, word('w_000002', 'book', '書')];
    h.setNetwork(async request => publicResponse(request.url, JSON.stringify(next)));
    assert.equal((await h.message({ type: 'SYNC_PUBLIC_WORDS' }))[0].ok, true);
    h.setNetwork(async () => { throw new TypeError('offline'); });
    assert.deepEqual(await (await h.fetch('./data/words.json')).json(), next);
    h.stores.get(h.PUBLIC_CACHE_NAME).delete(h.WORDS_URL);
    h.stores.get(h.CACHE_NAME).delete(h.WORDS_URL);
    assert.equal((await h.message({ type: 'GET_OFFLINE_STATUS' }))[0].ready, false);
});
