const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'pwa.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

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
        }
    };
}

async function uiHarness(options = {}) {
    const ids = ['pwa-install', 'pwa-install-help', 'pwa-install-title', 'pwa-status', 'pwa-offline-banner',
        'pwa-network-title', 'pwa-offline-message', 'pwa-reconnect', 'pwa-update-banner', 'pwa-update-button', 'pwa-update-later'];
    const nodes = Object.fromEntries(ids.map(id => [id, eventTarget({ hidden: ['pwa-install', 'pwa-offline-banner', 'pwa-reconnect', 'pwa-update-banner'].includes(id), textContent: '', disabled: false, open: false })]));
    const calls = { register: [], waiting: [], active: [], reload: 0, confirm: 0, update: 0 };
    let readiness = options.ready ?? true;
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
                ports[0].postMessage({ type: 'OFFLINE_STATUS', ready: readiness });
            }
        },
        waiting: options.waiting ? { postMessage(message) { calls.waiting.push(message); } } : null,
        installing: null,
        async update() { calls.update += 1; }
    });
    const serviceWorker = eventTarget({ async register(url, init) { calls.register.push({ url, init }); return registration; } });
    const navigator = { onLine: true, serviceWorker, standalone: options.standalone || false };
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
    vm.runInNewContext(source, { window, navigator, document, URL, MessageChannel: channel, setTimeout, clearTimeout, Date, Promise }, { filename: 'pwa.js' });
    await document.dispatch('DOMContentLoaded');
    return { nodes, calls, window, navigator, document, registration, serviceWorker, setReadiness(value) { readiness = value; } };
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

test('first worker control never reloads; an update reloads once after explicit acceptance', async () => {
    const h = await uiHarness({ waiting: true });
    await h.serviceWorker.dispatch('controllerchange');
    assert.equal(h.calls.reload, 0);
    assert.equal(h.nodes['pwa-update-banner'].hidden, false);
    assert.equal(h.calls.waiting.length, 0);
    await h.nodes['pwa-update-button'].dispatch('click');
    assert.equal(h.calls.waiting.length, 1);
    assert.equal(h.calls.waiting[0].type, 'SKIP_WAITING');
    assert.equal(h.calls.reload, 0);
    await h.serviceWorker.dispatch('controllerchange');
    await h.serviceWorker.dispatch('controllerchange');
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
