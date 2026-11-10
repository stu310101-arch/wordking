'use strict';

// Every shell change must bump RELEASE and the HTML asset query versions together.
const RELEASE = '20261110-public-sync-1';
const APP_BASE = new URL('./', self.registration.scope);
const CACHE_PREFIX = `wordking-pwa:${encodeURIComponent(APP_BASE.pathname)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${RELEASE}`;
// Public data outlives a particular shell. A waiting worker must not restore an
// older installation-time word list when the user later accepts its update.
const PUBLIC_CACHE_NAME = `${CACHE_PREFIX}public-words-v1`;
const INDEX_URL = new URL('index.html', APP_BASE).href;
const WORDS_URL = new URL('data/words.json', APP_BASE).href;
const versioned = name => `${name}?v=${RELEASE}`;
const SHELL_URLS = [
    'index.html', 'manifest.webmanifest',
    versioned('assets/tailwind.css'), versioned('assets/styles.css'), versioned('assets/pwa.css'),
    versioned('assets/word-data.js'), versioned('assets/migration.js'), versioned('assets/persistence.js'),
    versioned('assets/app.js'), versioned('assets/pwa.js'),
    'assets/vendor/firebase-12.19.0/firebase-app.js',
    'assets/vendor/firebase-12.19.0/firebase-auth.js',
    'assets/vendor/firebase-12.19.0/firebase-firestore.js',
    'assets/icons/icon.svg', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png',
    'assets/icons/icon-maskable-512.png', 'assets/icons/apple-touch-icon.png'
].map(path => new URL(path, APP_BASE).href);
const PRECACHE_URLS = [...SHELL_URLS, WORDS_URL];
const SHELL_SET = new Set(SHELL_URLS);
const CHECKED_AT_HEADER = 'X-WordKing-Checked-At';
let publicSyncPromise = null;
let publicWritePromise = Promise.resolve();

// Reuse the application's schema rather than maintaining a permissive second
// validator. Imported worker scripts are kept with the installed worker itself.
importScripts(new URL(versioned('assets/word-data.js'), APP_BASE).href);

function isPublicRequest(request) {
    return request.method === 'GET' && new URL(request.url).origin === APP_BASE.origin
        && !request.headers.has('authorization') && !request.headers.has('cookie');
}

function isAppDocument(url) {
    return url.origin === APP_BASE.origin && (url.pathname === APP_BASE.pathname
        || url.pathname === new URL(INDEX_URL).pathname);
}

function expectedType(url) {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('.html')) return /^text\/html(?:;|$)/i;
    if (pathname.endsWith('.js')) return /^(?:text|application)\/javascript(?:;|$)/i;
    if (pathname.endsWith('.css')) return /^text\/css(?:;|$)/i;
    if (pathname.endsWith('.json') || pathname.endsWith('.webmanifest')) return /^application\/(?:manifest\+)?json(?:;|$)/i;
    if (pathname.endsWith('.png')) return /^image\/png(?:;|$)/i;
    if (pathname.endsWith('.svg')) return /^image\/svg\+xml(?:;|$)/i;
    return /$a/;
}

function isSafePublicResponse(response, url) {
    return response.status === 200 && response.type !== 'opaque' && response.type !== 'opaqueredirect'
        && !response.redirected && (!response.url || response.url === url)
        && expectedType(url).test(response.headers.get('content-type') || '')
        && !(response.headers.get('vary') || '').split(',').some(value => value.trim() === '*');
}

async function readPublicVocabulary(response) {
    const words = globalThis.WordKingData.normalizeCatalog(await response.clone().json());
    if (!words.length || words.some(word => !word.meanings.length
        || word.meanings.some(group => !group.definitions.length))) {
        throw new Error('Public vocabulary must contain complete meanings');
    }
    return words;
}

function checkedAt(response) {
    const value = Number(response?.headers.get(CHECKED_AT_HEADER));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function vocabularyResponse(response, words, timestamp) {
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('Content-Type', 'application/json; charset=utf-8');
    headers.set(CHECKED_AT_HEADER, String(timestamp));
    return new Response(JSON.stringify(words), { status: 200, headers });
}

async function writePublicVocabulary(response, words, timestamp) {
    const cache = await caches.open(PUBLIC_CACHE_NAME);
    const previous = await cache.match(WORDS_URL);
    let previousWords = null;
    if (previous) {
        try { previousWords = await readPublicVocabulary(previous); } catch { /* Replace corrupt local data. */ }
    }
    // A newly activated shell may have waited while the previous active worker
    // downloaded newer public words. Keep that newer saved snapshot.
    if (previousWords && checkedAt(previous) > timestamp) {
        return { response: previous, words: previousWords, updated: false, checkedAt: checkedAt(previous) };
    }
    const saved = vocabularyResponse(response, words, timestamp);
    // Cache.put replaces this one record atomically. Never delete the last good
    // copy first; quota/write failures must not claim the new words are saved.
    await cache.put(WORDS_URL, saved.clone());
    return { response: saved, words, updated: JSON.stringify(previousWords) !== JSON.stringify(words), checkedAt: timestamp };
}

function savePublicVocabulary(response, words, timestamp) {
    // Serialize activation and any early page messages in this worker. Other
    // workers only stage their install snapshot; they never write shared data.
    const pending = publicWritePromise.then(() => writePublicVocabulary(response, words, timestamp));
    publicWritePromise = pending.catch(() => {});
    return pending;
}

function synchronizePublicWords() {
    if (!publicSyncPromise) {
        publicSyncPromise = (async () => {
            // Always fetch the fixed public endpoint, never a client-provided URL
            // or credentials, and bypass stale browser HTTP-cache responses.
            const request = new Request(WORDS_URL, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
            const timestamp = Date.now();
            const response = await fetchPublic(request);
            if (!isSafePublicResponse(response, WORDS_URL)) throw new Error('Public vocabulary unavailable');
            const words = await readPublicVocabulary(response);
            return savePublicVocabulary(response, words, timestamp);
        })().finally(() => { publicSyncPromise = null; });
    }
    return publicSyncPromise;
}

async function fetchPublic(request, timeout = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(request, { signal: controller.signal });
        // Drain each body while its request owns a network connection. Waiting
        // for every response header before consuming bodies can exhaust the
        // browser's connection/stream buffers during parallel installation.
        // Read a clone to preserve the original response URL and cache metadata.
        await response.clone().arrayBuffer();
        return response;
    } finally {
        clearTimeout(timer);
    }
}

async function installPublicShell() {
    // Validate all resources before populating this new release's isolated cache.
    // An existing active worker keeps using its own complete release until activation.
    let vocabulary;
    const responses = await Promise.all(PRECACHE_URLS.map(async url => {
        const request = new Request(url, { cache: 'reload', credentials: 'omit', redirect: 'error' });
        const timestamp = Date.now();
        const response = await fetchPublic(request, 20000);
        if (!isSafePublicResponse(response, url)) throw new Error('Public offline resource unavailable');
        if (url === WORDS_URL) {
            vocabulary = { response, words: await readPublicVocabulary(response), timestamp };
        }
        return response;
    }));
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(SHELL_URLS.map((url, index) => cache.put(url, responses[index])));
    // Installation is isolated from the active public database. Even a delayed
    // Cache.put here cannot overwrite a concurrent active-worker data update.
    await cache.put(WORDS_URL, vocabularyResponse(vocabulary.response, vocabulary.words, vocabulary.timestamp));
    // Updates wait normally. Only an explicit message from an app page may skip waiting.
}

async function activatePublicShell() {
    // Try Activate waits for the previous worker's extendable events (including
    // its pending sync writes). Publish only now, then remove the staged copy.
    // https://w3c.github.io/ServiceWorker/#try-activate-algorithm
    const cache = await caches.open(CACHE_NAME);
    const staged = await cache.match(WORDS_URL);
    if (staged) {
        try {
            await savePublicVocabulary(staged, await readPublicVocabulary(staged), checkedAt(staged));
            await cache.delete(WORDS_URL);
        } catch {
            // Activation cannot roll back to the old worker after a rejected
            // waitUntil. Keep both the durable staged copy and older caches;
            // the new worker can use them and retry its public download later.
            await self.clients.claim();
            return;
        }
    }
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX)
        && name !== CACHE_NAME && name !== PUBLIC_CACHE_NAME)
        .map(name => caches.delete(name)));
    await self.clients.claim();
}

async function savedPublicVocabulary() {
    let newest = null;
    // The shell's staged copy is normally removed at activation. It remains a
    // usable public-only fallback if publishing to the shared cache failed.
    for (const name of [PUBLIC_CACHE_NAME, CACHE_NAME]) {
        try {
            const response = await (await caches.open(name)).match(WORDS_URL);
            if (!response) continue;
            await readPublicVocabulary(response);
            if (!newest || checkedAt(response) > checkedAt(newest)) newest = response;
        } catch { /* A damaged/unavailable store must not hide another good copy. */ }
    }
    return newest;
}

async function offlineDocument(cache) {
    const cached = await cache.match(INDEX_URL);
    if (!cached) return new Response('目前無法連線。請先連網開啟單字王，完成公用單字的離線準備。', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
    // A constant DOM marker lets app bootstrap choose public-only mode even when
    // navigator.onLine says online but the network cannot reach the site.
    const html = (await cached.text()).replace(/<html\b/i, '<html data-wordking-offline="true"');
    const headers = new Headers(cached.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'no-store');
    headers.set('X-WordKing-Offline', '1');
    return new Response(html, { status: 200, headers });
}

async function serveDocument(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const response = await fetchPublic(request);
        if (response.status < 500) return response;
    } catch { /* Offline or timed out: use only the shell installed with this release. */ }
    // Fresh navigation HTML is never mixed into an older release's offline shell.
    return offlineDocument(cache);
}

async function servePublicWords() {
    try {
        return (await synchronizePublicWords()).response.clone();
    } catch {
        const cached = await savedPublicVocabulary();
        return cached || new Response('{"error":"public-vocabulary-unavailable"}', {
            status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
    }
}

async function serveShellAsset(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request.url);
    if (cached) return cached;
    // An evicted resource can be recovered only at an exact, public allowlisted URL.
    const response = await fetchPublic(request);
    if (isSafePublicResponse(response, request.url)) await cache.put(request.url, response.clone());
    return response;
}

function handleFetch(event) {
    const request = event.request;
    if (!isPublicRequest(request)) return;
    const url = new URL(request.url);
    if (request.mode === 'navigate' && isAppDocument(url)) event.respondWith(serveDocument(request));
    else if (url.href === WORDS_URL) event.respondWith(servePublicWords());
    else if (SHELL_SET.has(url.href)) event.respondWith(serveShellAsset(request));
    // Every other request, including Auth, Firestore, API endpoints, migration
    // archives, music and unrelated GitHub Pages projects, bypasses this worker.
}

function isAppClient(source) {
    if (!source || !source.id || typeof source.url !== 'string') return false;
    try { return isAppDocument(new URL(source.url)); } catch { return false; }
}

async function offlineResourcesReady() {
    const cache = await caches.open(CACHE_NAME);
    const entries = await Promise.all(SHELL_URLS.map(url => cache.match(url)));
    const vocabulary = await savedPublicVocabulary();
    if (!entries.every(Boolean) || !vocabulary) return false;
    await readPublicVocabulary(vocabulary);
    return true;
}

function handleMessage(event) {
    if (!isAppClient(event.source) || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
    else if (event.data.type === 'GET_OFFLINE_STATUS' && event.ports?.[0]) {
        event.waitUntil((async () => {
            const ready = await offlineResourcesReady().catch(() => false);
            event.ports[0].postMessage({ type: 'OFFLINE_STATUS', ready, release: RELEASE, publicSync: true });
            event.ports[0].close();
        })());
    } else if (event.data.type === 'SYNC_PUBLIC_WORDS' && event.ports?.[0]) {
        event.waitUntil((async () => {
            let result;
            try {
                const saved = await synchronizePublicWords();
                result = { type: 'PUBLIC_WORDS_SYNC', ok: true, updated: saved.updated,
                    words: saved.words, checkedAt: saved.checkedAt };
            } catch {
                result = { type: 'PUBLIC_WORDS_SYNC', ok: false, updated: false, checkedAt: null };
            }
            try { event.ports[0].postMessage(result); } finally { event.ports[0].close(); }
        })());
    }
}

self.addEventListener('install', event => event.waitUntil(installPublicShell()));
self.addEventListener('activate', event => event.waitUntil(activatePublicShell()));
self.addEventListener('fetch', handleFetch);
self.addEventListener('message', handleMessage);
