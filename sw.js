'use strict';

// Every shell change must bump RELEASE and the HTML asset query versions together.
const RELEASE = '20261106-pwa-security-1';
const APP_BASE = new URL('./', self.registration.scope);
const CACHE_PREFIX = `wordking-pwa:${encodeURIComponent(APP_BASE.pathname)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${RELEASE}`;
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

async function hasPublicVocabulary(response) {
    const words = await response.clone().json();
    return Array.isArray(words) && words.length > 0;
}

async function fetchPublic(request, timeout = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        return await fetch(request, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function installPublicShell() {
    // Validate all resources before populating this new release's isolated cache.
    // An existing active worker keeps using its own complete release until activation.
    const responses = await Promise.all(PRECACHE_URLS.map(async url => {
        const request = new Request(url, { cache: 'reload', credentials: 'omit', redirect: 'error' });
        const response = await fetchPublic(request, 20000);
        if (!isSafePublicResponse(response, url)) throw new Error('Public offline resource unavailable');
        if (url === WORDS_URL && !await hasPublicVocabulary(response)) {
            throw new Error('Invalid public vocabulary');
        }
        return response;
    }));
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(PRECACHE_URLS.map((url, index) => cache.put(url, responses[index])));
    // Updates wait normally. Only an explicit message from an app page may skip waiting.
}

async function activatePublicShell() {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map(name => caches.delete(name)));
    await self.clients.claim();
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

async function servePublicWords(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const response = await fetchPublic(request);
        if (!isSafePublicResponse(response, WORDS_URL) || !await hasPublicVocabulary(response)) {
            throw new Error('Public vocabulary unavailable');
        }
        await cache.put(WORDS_URL, response.clone());
        return response;
    } catch {
        return await cache.match(WORDS_URL) || new Response('{"error":"public-vocabulary-unavailable"}', {
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
    else if (url.href === WORDS_URL) event.respondWith(servePublicWords(request));
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
    const entries = await Promise.all(PRECACHE_URLS.map(url => cache.match(url)));
    return entries.every(Boolean);
}

function handleMessage(event) {
    if (!isAppClient(event.source) || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
    else if (event.data.type === 'GET_OFFLINE_STATUS' && event.ports?.[0]) {
        event.waitUntil((async () => {
            const ready = await offlineResourcesReady().catch(() => false);
            event.ports[0].postMessage({ type: 'OFFLINE_STATUS', ready, release: RELEASE });
            event.ports[0].close();
        })());
    }
}

self.addEventListener('install', event => event.waitUntil(installPublicShell()));
self.addEventListener('activate', event => event.waitUntil(activatePublicShell()));
self.addEventListener('fetch', handleFetch);
self.addEventListener('message', handleMessage);
