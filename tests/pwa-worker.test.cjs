const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const base = 'https://example.test/wordking/';
const publicWords = [{ id: 'public-1', word: 'apple', meaning: '蘋果' }];

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
    const stores = new Map();
    const listeners = new Map();
    const calls = { fetches: [], deleted: [], claim: 0, skip: 0 };
    const normalize = input => typeof input === 'string' ? input : input.url;
    const cacheAPI = {
        async open(name) {
            if (!stores.has(name)) stores.set(name, new Map());
            const store = stores.get(name);
            return {
                async put(key, response) { store.set(normalize(key), response.clone()); },
                async match(key) { return store.get(normalize(key))?.clone(); }
            };
        },
        async keys() { return [...stores.keys()]; },
        async delete(name) { calls.deleted.push(name); return stores.delete(name); }
    };
    let network = options.fetch || (async request => publicResponse(normalize(request)));
    const context = vm.createContext({
        URL, Request, Response, Headers, AbortController, setTimeout, clearTimeout,
        caches: cacheAPI,
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
    vm.runInContext(source, context, { filename: 'sw.js' });
    const values = JSON.parse(vm.runInContext('JSON.stringify({ RELEASE, CACHE_PREFIX, CACHE_NAME, INDEX_URL, WORDS_URL, PRECACHE_URLS, SHELL_URLS })', context));
    return {
        ...values, stores, calls, cacheAPI,
        setNetwork(fn) { network = fn; },
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
            const port = { postMessage(value) { replies.push(value); }, close() {} };
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
    await h.lifecycle('install');
    assert.deepEqual(h.calls.fetches.map(call => call.url).sort(), [...h.PRECACHE_URLS].sort());
    assert.ok(h.calls.fetches.every(call => call.request.credentials === 'omit' && call.request.redirect === 'error'));
    assert.equal(h.calls.skip, 0);
    assert.equal(h.stores.get(h.CACHE_NAME).size, h.PRECACHE_URLS.length);
    const [status] = await h.message({ type: 'GET_OFFLINE_STATUS' });
    assert.equal(status.ready, true);
    assert.equal(status.release, h.RELEASE);
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
    const installation = h.lifecycle('install');
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
        assert.equal(h.stores.get(h.CACHE_NAME).size, h.PRECACHE_URLS.length);
        assert.deepEqual(await h.stores.get(h.CACHE_NAME).get(h.WORDS_URL).clone().json(), publicWords);
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
    for (const name of [old, h.CACHE_NAME, foreign, 'unrelated-cache']) h.stores.set(name, new Map());
    await h.lifecycle('activate');
    assert.deepEqual(h.calls.deleted, [old]);
    assert.ok(h.stores.has(foreign));
    assert.ok(h.stores.has('unrelated-cache'));
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
    await h.lifecycle('install');
    h.setNetwork(async () => { throw new TypeError('offline'); });
    for (const path of ['./?page=practice&folder=personal-secret', './index.html?page=library']) {
        const response = await h.fetch(path, { mode: 'navigate' });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('X-WordKing-Offline'), '1');
        assert.match(await response.text(), /<html data-wordking-offline="true" lang="zh-Hant">/);
    }
    const cached = h.stores.get(h.CACHE_NAME).get(h.INDEX_URL);
    assert.doesNotMatch(await cached.clone().text(), /data-wordking-offline/);
    assert.equal(h.stores.get(h.CACHE_NAME).size, h.PRECACHE_URLS.length);
    const empty = workerHarness({ fetch: async () => { throw new TypeError('offline'); } });
    assert.equal((await empty.fetch('./', { mode: 'navigate' })).status, 503);
});

test('network navigation does not overwrite the older installed offline shell', async () => {
    const h = workerHarness();
    await h.lifecycle('install');
    h.setNetwork(async request => publicResponse(request.url, '<html><body>new release</body></html>'));
    const response = await h.fetch('./?page=home', { mode: 'navigate' });
    assert.match(await response.text(), /new release/);
    assert.match(await h.stores.get(h.CACHE_NAME).get(h.INDEX_URL).clone().text(), /installed shell/);
    h.setNetwork(async () => new Response('server unavailable', { status: 503 }));
    assert.equal((await h.fetch('./', { mode: 'navigate' })).headers.get('X-WordKing-Offline'), '1');
});

test('public vocabulary accepts valid refreshes and preserves the last good copy on failure', async () => {
    const h = workerHarness();
    await h.lifecycle('install');
    const fresh = [{ id: 'public-2', word: 'book', meaning: '書' }];
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
    h.stores.get(h.CACHE_NAME).delete(h.WORDS_URL);
    const absent = await h.fetch('./data/words.json');
    assert.equal(absent.status, 503);
    assert.deepEqual(await absent.json(), { error: 'public-vocabulary-unavailable' });
});

test('exact shell URLs work offline while unsafe eviction recovery cannot enter the cache', async () => {
    const h = workerHarness();
    await h.lifecycle('install');
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
        await h.message({ type: 'SKIP_WAITING' }, url);
    }
    await h.message({ type: 'SKIP_WAITING' }, base, '');
    assert.equal(h.calls.skip, 0);
    const [status] = await h.message({ type: 'GET_OFFLINE_STATUS' }, `${base}index.html?page=home`);
    assert.equal(status.ready, false);
    await h.message({ type: 'SKIP_WAITING' }, `${base}?page=practice`);
    assert.equal(h.calls.skip, 1);
});
