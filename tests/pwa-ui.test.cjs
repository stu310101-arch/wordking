const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'pwa.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
const words = [{ id: 'w_000001', english: 'apple', meanings: [{ partOfSpeech: 'noun', definitions: ['蘋果'] }], lessonIds: ['U1'], isWrong: false }];

function eventTarget(extra = {}) {
    const listeners = new Map();
    return {
        ...extra,
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        async dispatch(type, event = {}) {
            await Promise.all((listeners.get(type) || []).map(handler => handler(event)));
            await flush();
        },
        dispatchEvent(event) {
            for (const handler of listeners.get(event.type) || []) handler(event);
            return true;
        }
    };
}

async function uiHarness(options = {}) {
    const ids = ['pwa-install', 'pwa-install-help', 'pwa-install-title', 'pwa-status', 'pwa-offline-banner',
        'pwa-network-title', 'pwa-offline-message', 'pwa-reconnect', 'pwa-update-banner', 'pwa-update-button', 'pwa-update-later', 'pwa-sync-status'];
    const nodes = Object.fromEntries(ids.map(id => [id, eventTarget({ hidden: ['pwa-install', 'pwa-offline-banner', 'pwa-reconnect', 'pwa-update-banner'].includes(id), textContent: '', disabled: false, open: false })]));
    const calls = { register: [], waiting: [], active: [], catalogs: [], reload: 0, confirm: 0, update: 0 };
    let readiness = options.ready ?? true;
    let syncResult = options.syncResult || { ok: true, updated: true, words, checkedAt: 1 };
    let pendingSyncReply = null;
    let now = 100000;
    const timers = new Map();
    let nextTimer = 0;
    function respond(message, ports) {
        if (message.type === 'GET_OFFLINE_STATUS') {
            ports[0].postMessage({ type: 'OFFLINE_STATUS', ready: readiness, publicSync: options.publicSync !== false });
        } else if (message.type === 'SYNC_PUBLIC_WORDS') {
            const reply = () => ports[0].postMessage({ type: 'PUBLIC_WORDS_SYNC', ...syncResult });
            if (options.deferSync) pendingSyncReply = reply;
            else reply();
        }
    }
    const channel = class {
        constructor() {
            this.port1 = { onmessage: null, close() {} };
            this.port2 = { postMessage: data => queueMicrotask(() => this.port1.onmessage?.({ data })), close() {} };
        }
    };
    const registration = eventTarget({
        active: options.active === false ? null : {
            postMessage(message, ports) {
                calls.active.push(message);
                respond(message, ports);
            }
        },
        waiting: options.waiting ? eventTarget({
            state: 'installed',
            postMessage(message, ports) {
                if (['GET_OFFLINE_STATUS', 'SYNC_PUBLIC_WORDS'].includes(message.type)) respond(message, ports);
                else calls.waiting.push(message);
            }
        }) : null,
        installing: null,
        async update() { calls.update += 1; }
    });
    const serviceWorker = eventTarget({ async register(url, init) { calls.register.push({ url, init }); return registration; } });
    const navigator = { onLine: options.online !== false, serviceWorker, standalone: options.standalone || false };
    if (options.unsupported) delete navigator.serviceWorker;
    const displayMode = eventTarget({ matches: false });
    const window = eventTarget({
        MessageChannel: channel, isSecureContext: true,
        matchMedia: () => displayMode,
        location: { reload() { calls.reload += 1; } },
        state: { game: { isFinished: !options.activeGame } },
        confirm() { calls.confirm += 1; return options.confirm !== false; }
    });
    const document = eventTarget({
        readyState: 'loading', visibilityState: 'visible', baseURI: 'https://example.test/wordking/',
        currentScript: { src: 'https://example.test/wordking/assets/pwa.js?v=20261106-pwa-security-1' },
        getElementById: id => nodes[id],
        querySelectorAll: () => options.openEditor ? [{ hidden: false }] : []
    });
    window.addEventListener('wordking-public-catalog', () => calls.catalogs.push(window.WordKingPendingPublicCatalog));
    vm.runInNewContext(source, {
        window, navigator, document, URL, MessageChannel: channel,
        CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
        setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        Date: class extends Date { static now() { return now; } }, Promise
    }, { filename: 'pwa.js' });
    await document.dispatch('DOMContentLoaded');
    return { nodes, calls, window, navigator, document, registration, serviceWorker, timers,
        setReadiness(value) { readiness = value; }, setSyncResult(value) { syncResult = value; },
        advanceTime(ms) { now += ms; }, async replySync() { pendingSyncReply?.(); pendingSyncReply = null; await flush(); },
        async fireTimer(id) { const timer = timers.get(id); timers.delete(id); timer?.callback(); await flush(); } };
}

test('registration uses the exact app scope and reports readiness only from the active worker', async () => {
    const h = await uiHarness({ ready: false });
    assert.equal(h.calls.register[0].url, 'https://example.test/wordking/sw.js');
    assert.equal(h.calls.register[0].init.scope, 'https://example.test/wordking/');
    assert.equal(h.calls.register[0].init.updateViaCache, 'none');
    assert.match(h.nodes['pwa-status'].textContent, /尚未備妥/);
    h.setReadiness(true);
    await h.document.dispatch('visibilitychange');
    assert.match(h.nodes['pwa-status'].textContent, /公用單字已備妥/);
    h.setReadiness(false);
    await h.document.dispatch('visibilitychange');
    assert.match(h.nodes['pwa-status'].textContent, /尚未備妥/);
    const installing = await uiHarness({ active: false });
    assert.doesNotMatch(installing.nodes['pwa-status'].textContent, /已備妥/);
});

test('native install prompt is captured but runs only after the install button is clicked', async () => {
    const h = await uiHarness();
    let prompted = 0;
    let prevented = 0;
    assert.equal(h.nodes['pwa-install'].hidden, true);
    await h.window.dispatch('beforeinstallprompt', {
        preventDefault() { prevented += 1; },
        async prompt() { prompted += 1; },
        userChoice: Promise.resolve({ outcome: 'dismissed' })
    });
    assert.equal(prevented, 1);
    assert.equal(prompted, 0);
    assert.equal(h.nodes['pwa-install'].hidden, false);
    await h.nodes['pwa-install'].dispatch('click');
    assert.equal(prompted, 1);
    assert.equal(h.nodes['pwa-install'].hidden, true);
    assert.equal(h.nodes['pwa-install-help'].hidden, false);
    await h.nodes['pwa-install'].dispatch('click');
    assert.equal(prompted, 1);
    await h.window.dispatch('appinstalled');
    assert.equal(h.nodes['pwa-install-help'].hidden, true);
});

test('standalone and unsupported browsers get accurate install and offline states', async () => {
    const installed = await uiHarness({ standalone: true });
    assert.equal(installed.nodes['pwa-install-help'].hidden, true);
    assert.equal(installed.nodes['pwa-install'].hidden, true);
    const unsupported = await uiHarness({ unsupported: true });
    assert.match(unsupported.nodes['pwa-status'].textContent, /無法提供離線練習/);
    assert.equal(unsupported.calls.register.length, 0);
});

test('a first install briefly waiting does not show an update or reset active practice', async () => {
    const h = await uiHarness({ active: false, waiting: true, activeGame: true });
    const worker = h.registration.waiting;
    assert.equal(h.nodes['pwa-update-banner'].hidden, true);
    await worker.dispatch('statechange');
    assert.equal(h.nodes['pwa-update-banner'].hidden, true);
    h.registration.waiting = null;
    h.registration.active = worker;
    worker.state = 'activated';
    await worker.dispatch('statechange');
    await h.serviceWorker.dispatch('controllerchange');
    assert.equal(h.nodes['pwa-update-banner'].hidden, true);
    assert.match(h.nodes['pwa-status'].textContent, /已備妥/);
    assert.equal(h.calls.reload, 0);
    assert.equal(h.calls.confirm, 0);
    assert.equal(h.window.state.game.isFinished, false);
});

test('another tab activating an update clears the banner without interrupting this quiz', async () => {
    const h = await uiHarness({ waiting: true, activeGame: true });
    const worker = h.registration.waiting;
    assert.equal(h.nodes['pwa-update-banner'].hidden, false);
    h.registration.waiting = null;
    h.registration.active = worker;
    worker.state = 'activated';
    await worker.dispatch('statechange');
    assert.equal(h.nodes['pwa-update-banner'].hidden, true);
    await h.serviceWorker.dispatch('controllerchange');
    assert.equal(h.calls.reload, 0);
    assert.equal(h.calls.confirm, 0);
    assert.equal(h.window.state.game.isFinished, false);
});

test('clicking a stale update banner reconciles a worker that is no longer waiting', async () => {
    const h = await uiHarness({ waiting: true, activeGame: true });
    h.registration.waiting = null;
    await h.nodes['pwa-update-button'].dispatch('click');
    assert.equal(h.nodes['pwa-update-banner'].hidden, true);
    assert.equal(h.nodes['pwa-update-button'].disabled, false);
    assert.equal(h.calls.waiting.length, 0);
    assert.equal(h.calls.reload, 0);
    assert.equal(h.calls.confirm, 0);
});

test('a real waiting update reloads once only after explicit acceptance', async () => {
    const h = await uiHarness({ waiting: true });
    await h.serviceWorker.dispatch('controllerchange');
    assert.equal(h.calls.reload, 0);
    assert.equal(h.nodes['pwa-update-banner'].hidden, false);
    assert.equal(h.calls.waiting.length, 0);
    await h.nodes['pwa-update-button'].dispatch('click');
    assert.equal(h.calls.waiting.length, 1);
    assert.equal(h.calls.waiting[0].type, 'SKIP_WAITING');
    assert.equal(h.calls.reload, 0);
    h.registration.waiting = null;
    await h.serviceWorker.dispatch('controllerchange');
    await h.serviceWorker.dispatch('controllerchange');
    assert.equal(h.nodes['pwa-update-banner'].hidden, true);
    assert.equal(h.calls.reload, 1);
});

test('active practice or unsaved editors can cancel updates and later defers without activation', async () => {
    for (const state of [{ activeGame: true }, { openEditor: true }]) {
        const h = await uiHarness({ waiting: true, confirm: false, ...state });
        await h.nodes['pwa-update-button'].dispatch('click');
        assert.equal(h.calls.confirm, 1);
        assert.equal(h.calls.waiting.length, 0);
        assert.equal(h.calls.reload, 0);
        assert.equal(h.nodes['pwa-update-button'].disabled, false);
    }
    const h = await uiHarness({ waiting: true });
    await h.nodes['pwa-update-later'].dispatch('click');
    assert.equal(h.nodes['pwa-update-banner'].hidden, true);
    assert.equal(h.calls.waiting.length, 0);
});

test('offline and restored connections preserve the public-mode session until explicit reload', async () => {
    const h = await uiHarness();
    assert.equal(h.nodes['pwa-offline-banner'].hidden, true);
    h.navigator.onLine = false;
    h.window.WordKingOffline = true;
    await h.window.dispatch('offline');
    assert.equal(h.nodes['pwa-offline-banner'].hidden, false);
    assert.match(h.nodes['pwa-network-title'].textContent, /離線/);
    assert.equal(h.nodes['pwa-reconnect'].hidden, true);
    h.navigator.onLine = true;
    await h.window.dispatch('online');
    assert.equal(h.nodes['pwa-reconnect'].hidden, false);
    assert.equal(h.calls.reload, 0);
    await h.nodes['pwa-reconnect'].dispatch('click');
    assert.equal(h.calls.reload, 1);
    h.window.WordKingOffline = false;
    await h.window.dispatch('wordking-offline-mode');
    assert.equal(h.nodes['pwa-offline-banner'].hidden, true);
});

test('startup and reconnection download public words without reloading or restoring private sessions', async () => {
    const h = await uiHarness();
    assert.equal(h.calls.catalogs.length, 1);
    assert.deepEqual(h.calls.catalogs[0], words);
    assert.match(h.nodes['pwa-sync-status'].textContent, /已同步 1 個/);
    h.navigator.onLine = false;
    h.window.WordKingOffline = true;
    await h.window.dispatch('offline');
    const fresh = [...words, { ...words[0], id: 'w_000002', english: 'book' }];
    h.setSyncResult({ ok: true, words: fresh });
    h.navigator.onLine = true;
    await h.window.dispatch('online');
    assert.deepEqual(h.calls.catalogs.at(-1), fresh);
    assert.equal(h.window.WordKingOffline, true);
    assert.equal(h.calls.reload, 0);
    assert.equal(h.calls.confirm, 0);
});

test('resume checks are throttled and simultaneous events share one download', async () => {
    const h = await uiHarness({ deferSync: true });
    await h.window.dispatch('online');
    await h.document.dispatch('visibilitychange');
    await h.window.dispatch('pageshow', { persisted: true });
    const downloads = () => h.calls.active.filter(message => message.type === 'SYNC_PUBLIC_WORDS').length;
    assert.equal(downloads(), 1);
    await h.replySync();
    await h.window.dispatch('pageshow');
    assert.equal(downloads(), 1);
    h.advanceTime(60001);
    await h.document.dispatch('visibilitychange');
    assert.equal(downloads(), 2);
    await h.replySync();
});

test('failed downloads retain the session and retry after a transient connection failure', async () => {
    const h = await uiHarness({ syncResult: { ok: false } });
    assert.equal(h.calls.catalogs.length, 0);
    assert.match(h.nodes['pwa-sync-status'].textContent, /保留上次下載/);
    const retry = [...h.timers.entries()].find(([, timer]) => timer.delay === 15000);
    assert.ok(retry);
    h.setSyncResult({ ok: true, words });
    await h.fireTimer(retry[0]);
    assert.equal(h.calls.catalogs.length, 1);
    assert.equal(h.calls.reload, 0);
    assert.match(h.nodes['pwa-sync-status'].textContent, /已同步/);
});

test('offline launches and older workers do not receive unsupported network sync requests', async () => {
    for (const options of [{ online: false }, { publicSync: false }]) {
        const h = await uiHarness(options);
        assert.equal(h.calls.active.some(message => message.type === 'SYNC_PUBLIC_WORDS'), false);
        assert.equal(h.calls.catalogs.length, 0);
        assert.equal(h.calls.reload, 0);
    }
});

test('returning from the background retries a failed sync even inside the success throttle window', async () => {
    const h = await uiHarness();
    h.setSyncResult({ ok: false });
    await h.window.dispatch('online');
    assert.match(h.nodes['pwa-sync-status'].textContent, /重試/);
    h.document.visibilityState = 'hidden';
    await h.document.dispatch('visibilitychange');
    assert.equal(h.timers.size, 0);
    const before = h.calls.catalogs.length;
    h.setSyncResult({ ok: true, words });
    h.document.visibilityState = 'visible';
    await h.document.dispatch('visibilitychange');
    assert.equal(h.calls.catalogs.length, before + 1);
    assert.equal(h.calls.reload, 0);
});

test('saved downloads accurately report deferred application and personal conflicts', async () => {
    const h = await uiHarness();
    h.window.WordKingPublicCatalogStatus = 'pending';
    await h.window.dispatch('wordking-public-catalog-status');
    assert.match(h.nodes['pwa-sync-status'].textContent, /結束後會自動套用/);
    h.window.WordKingPublicCatalogStatus = 'conflict';
    await h.window.dispatch('wordking-public-catalog-status');
    assert.match(h.nodes['pwa-sync-status'].textContent, /保留你的原有內容/);
});
