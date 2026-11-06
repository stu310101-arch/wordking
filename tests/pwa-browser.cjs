'use strict';

// Real browser / Service Worker checks against the disposable Firebase fixture.
// Start tests/helpers/ui-fixture-server.cjs separately. This script refuses
// non-loopback URLs and verifies the fixture marker before opening a browser.
// WORDKING_TEST_BASE_URL: default http://127.0.0.1:<PORT or 4175>/
// WORDKING_TEST_PATHS: comma-separated mounts; default /,/wordking/
// WORDKING_TEST_ARTIFACTS: screenshots and JSON report; default .test-artifacts/pwa
// CHROME_BIN: optional native Chrome executable; otherwise use Playwright Chromium.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const repoRoot = path.resolve(__dirname, '..');
const { chromium } = createRequire(path.join(repoRoot, 'config/package.json'))('playwright');

const base = new URL(process.env.WORDKING_TEST_BASE_URL ||
    'http://127.0.0.1:' + (process.env.WORDKING_TEST_PORT || process.env.PORT || '4175') + '/');
assert.equal(base.protocol, 'http:', 'Use the disposable HTTP loopback fixture only');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname),
    'PWA tests must never run against a production host');
assert.ok(!base.username && !base.password && !base.search && !base.hash, 'Invalid fixture URL');
const mounts = (process.env.WORDKING_TEST_PATHS ||
    (base.pathname === '/' ? '/,/wordking/' : base.pathname)).split(',').map(value => {
    const mount = value.trim();
    assert.ok(/^\/(?:[^?#\\]*\/)?$/.test(mount) && !mount.includes('..') && !mount.includes('//'),
        'Mounts must be absolute paths with trailing slashes');
    return new URL(mount, base.origin).href;
});
const artifacts = path.resolve(process.env.WORDKING_TEST_ARTIFACTS || '.test-artifacts/pwa');
const profiles = [
    { name: 'mobile-390', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    { name: 'desktop', viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false }
];
const report = {
    startedAt: new Date().toISOString(),
    fixtureOrigin: base.origin,
    mounts,
    authBackend: 'disposable local mock; no production accounts or writes',
    coverage: 'Chromium mobile emulation and desktop; not an actual iOS/Android installation',
    scenarios: []
};

function message(error) {
    return { message: error?.message || String(error), stack: error?.stack, code: error?.code };
}

async function check(scenario, name, run) {
    const entry = { name, status: 'running' };
    const started = Date.now();
    scenario.checks.push(entry);
    process.stdout.write('START ' + scenario.name + ' | ' + name + '\n');
    try {
        entry.details = await run();
        entry.status = 'passed';
        return entry.details;
    } catch (error) {
        entry.status = 'failed';
        entry.error = message(error);
        throw error;
    } finally {
        entry.durationMs = Date.now() - started;
        process.stdout.write(entry.status.toUpperCase() + ' ' + scenario.name + ' | ' + name +
            ' (' + entry.durationMs + 'ms)' + (entry.error ? ' | ' + entry.error.message : '') + '\n');
    }
}

async function fixturePreflight(appURL) {
    const info = await fetch(new URL('__fixture-info', appURL), {
        redirect: 'error', signal: AbortSignal.timeout(10000)
    });
    assert.equal(info.status, 200, 'Start the disposable fixture server before running this script');
    assert.ok(info.headers.get('x-wordking-fixture'), 'Missing disposable fixture response header');
    const data = await info.json();
    assert.equal(data.fixture, true, 'Refusing to run outside the disposable fixture');
    assert.ok(data.seededWords?.includes('fixtureword'), 'The private-account test seed is missing');
}

async function appReady(page) {
    await page.waitForFunction(() => window.__wordkingFixture &&
        Array.isArray(window.state?.words) && window.state.words.length > 0 &&
        document.body.getAttribute('aria-busy') === 'false' &&
        document.getElementById('app-loading')?.hidden === true, null, { timeout: 60000 });
}

async function publicWords(page) {
    return page.evaluate(() => window.state.words.map(word => ({
        id: word.id, english: word.english, meanings: word.meanings,
        lessonIds: word.lessonIds, folderIds: word.folderIds, tags: word.tags,
        isWrong: word.isWrong, source: word.source
    })).sort((a, b) => a.id.localeCompare(b.id)));
}

async function noHorizontalOverflow(page) {
    const sizes = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)
    }));
    assert.ok(sizes.document <= sizes.viewport + 2,
        'Horizontal overflow: ' + JSON.stringify(sizes));
}

async function screenshot(page, scenario, label) {
    const filename = scenario.name + '-' + label + '.png';
    await page.screenshot({ path: path.join(artifacts, filename), fullPage: true, animations: 'disabled' });
    scenario.screenshots.push(filename);
}

async function goHome(page) {
    await page.locator('#btn-home-brand').click();
    await page.locator('#view-home').waitFor({ state: 'visible' });
}

async function workerReady(page, appURL) {
    try {
        await page.waitForFunction(() => !!navigator.serviceWorker?.controller ||
            window.__wordkingTestWorkerDiagnostics?.some(event =>
                event.type === 'register-rejected' || event.type === 'register-threw' ||
                (event.type === 'worker-state' && event.state === 'redundant')), null, { timeout: 30000 });
        const startup = await page.evaluate(async () => ({
            controlled: !!navigator.serviceWorker?.controller,
            diagnostics: window.__wordkingTestWorkerDiagnostics || [],
            registrations: await navigator.serviceWorker.getRegistrations().then(items => items.map(item => ({
                scope: item.scope, active: item.active?.state, waiting: item.waiting?.state,
                installing: item.installing?.state
            })))
        }));
        if (!startup.controlled) throw new Error('Service Worker did not activate: ' + JSON.stringify(startup));
    } catch (error) {
        error.code = 'PWA_WORKER_STARTUP';
        throw error;
    }
    const status = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        const readiness = await new Promise((resolve, reject) => {
            const channel = new MessageChannel();
            const timeout = setTimeout(() => {
                channel.port1.close();
                reject(new Error('Service Worker readiness acknowledgement timed out'));
            }, 10000);
            channel.port1.onmessage = event => {
                if (event.data?.type !== 'OFFLINE_STATUS') return;
                clearTimeout(timeout);
                channel.port1.close();
                resolve(event.data);
            };
            registration.active.postMessage({ type: 'GET_OFFLINE_STATUS' }, [channel.port2]);
        });
        return {
            scope: registration.scope, scriptURL: registration.active.scriptURL,
            controller: navigator.serviceWorker.controller.scriptURL, readiness
        };
    });
    assert.equal(status.scope, appURL);
    assert.equal(status.scriptURL, new URL('sw.js', appURL).href);
    assert.equal(status.controller, status.scriptURL);
    assert.equal(status.readiness.ready, true, 'The entire offline shell must be ready');
    await page.waitForFunction(() => /已備妥/.test(
        document.getElementById('pwa-status')?.textContent || ''), null, { timeout: 15000 });
    return status;
}

async function installWorkerDiagnostics(context, page, scenario) {
    const record = (group, event, immediate = false) => {
        scenario[group].push({ ...event, at: Date.now() });
        if (immediate) process.stdout.write('SW ' + scenario.name + ' | ' + JSON.stringify(event) + '\n');
    };
    context.on('console', event => {
        const worker = event.worker?.();
        const item = {
            type: event.type(), text: event.text(), location: event.location(),
            worker: worker?.url() || null
        };
        record('contextConsole', item, !!worker || event.type() === 'error');
        if (event.type() === 'error') scenario.consoleErrors.push(event.text());
    });
    context.on('serviceworker', worker => {
        record('serviceWorkerEvents', { type: 'worker-created', url: worker.url() }, true);
        worker.on('console', event => record('serviceWorkerEvents', {
            type: 'worker-console', level: event.type(), url: worker.url(),
            text: event.text(), location: event.location()
        }, true));
        worker.on('close', () => record('serviceWorkerEvents', { type: 'worker-closed', url: worker.url() }, true));
    });
    context.on('requestfailed', request => {
        const item = {
            url: request.url(), error: request.failure()?.errorText,
            worker: request.serviceWorker()?.url() || null
        };
        scenario.failedRequests.push(item);
        if (item.worker || /\/sw\.js(?:\?|$)/.test(item.url)) {
            record('workerNetwork', { type: 'request-failed', ...item }, true);
        }
    });
    context.on('response', response => {
        const request = response.request();
        const worker = request.serviceWorker();
        if (!worker && !/\/sw\.js(?:\?|$)/.test(response.url())) return;
        record('workerNetwork', {
            type: 'response', url: response.url(), status: response.status(),
            contentType: response.headers()['content-type'], worker: worker?.url() || null,
            fromServiceWorker: response.fromServiceWorker()
        }, true);
    });
    await page.exposeBinding('__wordkingTestReportSW', (_source, event) =>
        record('workerDiagnostics', event, true));
    await page.addInitScript(() => {
        const diagnostics = window.__wordkingTestWorkerDiagnostics = [];
        const report = event => {
            diagnostics.push(event);
            void window.__wordkingTestReportSW(event).catch(() => {});
        };
        if (!('serviceWorker' in navigator)) {
            report({ type: 'service-worker-unavailable', secureContext: window.isSecureContext });
            return;
        }
        const container = navigator.serviceWorker;
        const seenWorkers = new WeakSet();
        const seenRegistrations = new WeakSet();
        const observeWorker = worker => {
            if (!worker || seenWorkers.has(worker)) return;
            seenWorkers.add(worker);
            const state = () => report({ type: 'worker-state', url: worker.scriptURL, state: worker.state });
            state();
            worker.addEventListener('statechange', state);
            worker.addEventListener('error', event => report({
                type: 'worker-error', url: worker.scriptURL, message: event.message || String(event)
            }));
        };
        const observeRegistration = registration => {
            const snapshot = () => {
                report({
                    type: 'registration-state', scope: registration.scope,
                    active: registration.active?.state, waiting: registration.waiting?.state,
                    installing: registration.installing?.state
                });
                [registration.installing, registration.waiting, registration.active].forEach(observeWorker);
            };
            snapshot();
            if (!seenRegistrations.has(registration)) {
                seenRegistrations.add(registration);
                registration.addEventListener('updatefound', snapshot);
            }
        };
        container.addEventListener('controllerchange', () => report({
            type: 'controller-change', url: container.controller?.scriptURL,
            state: container.controller?.state
        }));
        const original = container.register;
        container.register = function (...args) {
            report({ type: 'register-called', script: String(args[0]), options: args[1],
                secureContext: window.isSecureContext, origin: location.origin });
            try {
                return Reflect.apply(original, this, args).then(registration => {
                    report({ type: 'register-resolved', scope: registration.scope });
                    observeRegistration(registration);
                    return registration;
                }, error => {
                    report({ type: 'register-rejected', name: error.name, message: error.message, stack: error.stack });
                    throw error;
                });
            } catch (error) {
                report({ type: 'register-threw', name: error.name, message: error.message, stack: error.stack });
                throw error;
            }
        };
    });
    // Chromium reports install-event promise rejections here even when they do
    // not produce a page error or console call. Observation only: no worker
    // source, request, response, lifecycle, or browser security settings change.
    try {
        const cdp = await context.newCDPSession(page);
        cdp.on('ServiceWorker.workerErrorReported', event =>
            record('cdpWorkerEvents', { type: 'worker-error', ...event }, true));
        cdp.on('ServiceWorker.workerVersionUpdated', event =>
            record('cdpWorkerEvents', { type: 'worker-versions', ...event }, true));
        cdp.on('ServiceWorker.workerRegistrationUpdated', event =>
            record('cdpWorkerEvents', { type: 'worker-registrations', ...event }, true));
        await cdp.send('ServiceWorker.enable');
    } catch (error) {
        record('cdpWorkerEvents', { type: 'diagnostic-unavailable', message: error.message }, true);
    }
}

async function cacheInventory(page, appURL, release) {
    const inventory = await page.evaluate(async () => {
        const result = [];
        for (const name of await caches.keys()) {
            if (!name.startsWith('wordking-pwa:')) continue;
            const cache = await caches.open(name);
            result.push({ name, entries: (await cache.keys()).map(request => ({
                url: request.url, method: request.method,
                authorization: request.headers.has('authorization'),
                cookie: request.headers.has('cookie')
            })) });
        }
        return result;
    });
    const mount = new URL(appURL);
    const prefix = 'wordking-pwa:' + encodeURIComponent(mount.pathname) + ':';
    assert.equal(inventory.length, 1, 'A fresh browser context should contain one app cache');
    assert.equal(inventory[0].name, prefix + release);
    const unversioned = [
        'index.html', 'manifest.webmanifest', 'data/words.json',
        'assets/icons/icon.svg', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png',
        'assets/icons/icon-maskable-512.png', 'assets/icons/apple-touch-icon.png',
        'assets/vendor/firebase-12.19.0/firebase-app.js',
        'assets/vendor/firebase-12.19.0/firebase-auth.js',
        'assets/vendor/firebase-12.19.0/firebase-firestore.js'
    ];
    const versioned = [
        'assets/tailwind.css', 'assets/styles.css', 'assets/pwa.css',
        'assets/word-data.js', 'assets/migration.js', 'assets/persistence.js',
        'assets/app.js', 'assets/pwa.js'
    ];
    const allowed = new Set([
        ...unversioned.map(relative => new URL(relative, appURL).href),
        ...versioned.map(relative => new URL(relative + '?v=' + release, appURL).href)
    ]);
    const entries = inventory[0].entries;
    for (const entry of entries) {
        assert.equal(entry.method, 'GET');
        assert.equal(entry.authorization, false);
        assert.equal(entry.cookie, false);
        assert.ok(allowed.has(entry.url), 'Unexpected offline cache entry: ' + entry.url);
    }
    assert.deepEqual(entries.map(entry => entry.url).sort(), [...allowed].sort(),
        'Cache must contain the complete public allowlist, without API, private, media, or unrelated URLs');
    return inventory;
}

async function manifestChecks(context, page, appURL) {
    const manifestURL = await page.locator('link[rel="manifest"]').getAttribute('href');
    assert.ok(manifestURL, 'A manifest link is required');
    const absolute = new URL(manifestURL, appURL).href;
    assert.equal(absolute, new URL('manifest.webmanifest', appURL).href);
    const response = await context.request.get(absolute);
    assert.equal(response.status(), 200);
    assert.match(response.headers()['content-type'], /^application\/(?:manifest\+)?json/);
    const manifest = await response.json();
    assert.equal(manifest.name, '單字王');
    assert.equal(manifest.display, 'standalone');
    assert.equal(new URL(manifest.scope, absolute).href, appURL);
    assert.equal(new URL(manifest.start_url, absolute).pathname, new URL(appURL).pathname);
    assert.ok(manifest.prefer_related_applications !== true);
    assert.ok(manifest.icons.some(icon => icon.sizes === '192x192'));
    assert.ok(manifest.icons.some(icon => icon.sizes === '512x512'));
    assert.ok(manifest.icons.some(icon => (icon.purpose || '').split(' ').includes('maskable')));
    for (const icon of manifest.icons) {
        const url = new URL(icon.src, absolute);
        assert.equal(url.origin, base.origin);
        assert.ok(url.pathname.startsWith(new URL(appURL).pathname + 'assets/icons/'));
        const image = await context.request.get(url.href);
        assert.equal(image.status(), 200);
        assert.match(image.headers()['content-type'], /^image\/png/);
        const bytes = await image.body();
        assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(bytes.readUInt32BE(16) + 'x' + bytes.readUInt32BE(20), icon.sizes);
    }
    const appleIcon = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
    assert.ok(appleIcon);
    const appleResponse = await context.request.get(new URL(appleIcon, appURL).href);
    assert.equal(appleResponse.status(), 200);
    assert.match(appleResponse.headers()['content-type'], /^image\/png/);
    assert.ok(await page.locator('meta[name="theme-color"]').getAttribute('content'));
    await page.locator('#pwa-install-help').waitFor({ state: 'visible' });
    for (const shortcut of manifest.shortcuts || []) {
        const url = new URL(shortcut.url, absolute);
        assert.equal(url.origin, base.origin);
        assert.ok(url.pathname.startsWith(new URL(appURL).pathname));
    }
    return { manifestURL: absolute, icons: manifest.icons.length, startURL: manifest.start_url };
}

async function bypassProbes(page, appURL) {
    // These are local fixture requests only. A fake Authorization header must
    // bypass even a URL that is otherwise in the public cache.
    const probes = [
        { relative: '__fixture-info?private-api-probe=1', headers: {} },
        { relative: 'assets/icons/icon-192.png?unlisted-probe=1', headers: {} },
        { relative: 'assets/icons/icon-192.png', headers: { Authorization: 'Bearer fixture-test-only' } }
    ];
    const results = [];
    for (const probe of probes) {
        const url = new URL(probe.relative, appURL).href;
        const observed = page.waitForResponse(response => response.url() === url);
        const fetched = await page.evaluate(async ({ url, headers }) => {
            const response = await fetch(url, { headers, cache: 'no-store' });
            await response.arrayBuffer();
            return response.status;
        }, { url, headers: probe.headers });
        const response = await observed;
        assert.equal(fetched, 200);
        assert.equal(response.fromServiceWorker(), false, 'Non-public requests must bypass the worker');
        results.push({ url, fromServiceWorker: false });
    }
    return results;
}

async function practiceTree(page) {
    await goHome(page);
    await page.locator('#btn-home-practice').click();
    await page.locator('#view-practice').waitFor({ state: 'visible' });
    const tree = await page.evaluate(() => {
        const ids = window.state.folderIds;
        const parents = window.state.folderParents;
        const roots = ids.filter(id => !parents[id]);
        const lesson = ids.find(id => id.startsWith('lesson:') && parents[id] &&
            window.state.words.some(word => (word.lessonIds || []).includes(id.slice(7))));
        const route = [];
        let key = lesson;
        while (key && route.length < 30) {
            route.unshift(key);
            key = parents[key];
        }
        return { roots, route, total: window.state.words.length };
    });
    assert.ok(tree.route.length >= 2, 'The public catalog must exercise a nested folder');
    assert.deepEqual((await page.locator('.practice-folder-open').evaluateAll(nodes =>
        nodes.map(node => node.dataset.folderKey))).sort(), [...tree.roots].sort(),
    'Only immediate child folders should appear at the root');
    await page.locator('#practice-select-all').check();
    assert.match(await page.locator('#selection-count').innerText(), new RegExp('已選 ' + tree.total + ' 個'));
    await page.locator('#practice-select-all').uncheck();
    const open = async key => {
        const buttons = page.locator('.practice-folder-open');
        const index = await buttons.evaluateAll((nodes, target) =>
            nodes.findIndex(node => node.dataset.folderKey === target), key);
        assert.ok(index >= 0, 'Expected folder is missing: ' + key);
        await buttons.nth(index).click();
        const expected = await page.evaluate(parent => window.state.folderIds.filter(id =>
            (window.state.folderParents[id] || '') === parent), key);
        assert.deepEqual((await page.locator('.practice-folder-open').evaluateAll(nodes =>
            nodes.map(node => node.dataset.folderKey))).sort(), expected.sort());
    };
    await open(tree.route[0]);
    await page.locator('#practice-select-all').check();
    for (const key of tree.route.slice(1)) await open(key);
    const inherited = await page.locator('.practice-checkbox').evaluateAll(inputs =>
        ({ total: inputs.length, selected: inputs.filter(input => input.checked).length }));
    assert.ok(inherited.total > 0);
    assert.equal(inherited.selected, inherited.total, 'Parent selection must include descendant words');
    await page.locator('#practice-breadcrumb button').first().click();
    // A partly selected root is indeterminate, with checked === false. Native
    // uncheck() is then a no-op; select it fully before clearing through the UI.
    await page.locator('#practice-select-all').check();
    await page.locator('#practice-select-all').uncheck();
    assert.match(await page.locator('#selection-count').innerText(), /已選 0 個/);
    for (const key of tree.route) await open(key);
    const firstWord = page.locator('.practice-checkbox').first();
    await firstWord.check();
    assert.match(await page.locator('#selection-count').innerText(), /已選 1 個/);
    await noHorizontalOverflow(page);
    return { route: tree.route, selectedId: await firstWord.getAttribute('data-word-id') };
}

async function blockedAction(page, selector, modalSelector) {
    const control = page.locator(selector);
    assert.equal(await control.count(), 1, 'Missing guarded control: ' + selector);
    if (!(await control.isVisible())) return { selector, blockedBy: 'hidden' };
    if (!(await control.isEnabled())) return { selector, blockedBy: 'disabled' };
    const previous = await page.evaluate(() => window.__wordkingFixture.events.length);
    await control.click();
    await page.waitForFunction(before => window.__wordkingFixture.events.slice(before)
        .some(event => event.type === 'dialog'), previous, { timeout: 5000 });
    const dialog = await page.evaluate(before => window.__wordkingFixture.events.slice(before)
        .filter(event => event.type === 'dialog').at(-1)?.message, previous);
    assert.match(dialog || '', /離線|連線|公用單字|登入/);
    if (modalSelector) assert.equal(await page.locator(modalSelector).isVisible(), false);
    return { selector, blockedBy: 'guard', message: dialog };
}

async function practiceSmoke(page, scenario, phase, offline) {
    const selected = await practiceTree(page);
    await screenshot(page, scenario, phase + '-tree');
    // Exercise a submitted answer as well as every mode's skip action.
    await page.locator('[data-start-mode="spelling"]').click();
    await page.locator('#view-game-spelling').waitFor({ state: 'visible' });
    const english = await page.evaluate(() => window.state.game.currentWords[0].english);
    await page.locator('#spelling-input').fill(english);
    await page.locator('#btn-spelling-submit').click();
    await page.locator('#view-game-result').waitFor({ state: 'visible' });
    assert.match(await page.locator('#result-stat').innerText(), /錯誤\/跳過：0 個/);
    await page.locator('#btn-result-return').click();
    const outcomes = [];
    for (const mode of ['spelling', 'choice-en-ch', 'choice-ch-en']) {
        await page.locator('[data-start-mode="' + mode + '"]').click();
        const view = mode === 'spelling' ? '#view-game-spelling' : '#view-game-choice';
        const skip = mode === 'spelling' ? '#btn-spelling-skip' : '#btn-choice-skip';
        const feedback = mode === 'spelling' ? '#spelling-feedback' : '#choice-feedback';
        await page.locator(view).waitFor({ state: 'visible' });
        if (mode !== 'spelling') {
            assert.equal(await page.locator('#choice-options button').count(), 5);
            assert.ok((await page.locator('#choice-question').innerText()).trim());
        }
        await noHorizontalOverflow(page);
        await screenshot(page, scenario, phase + '-' + mode);
        await page.locator(skip).click();
        assert.match(await page.locator(feedback).innerText(), /已跳過，答案：/);
        assert.equal(await page.locator(skip).isDisabled(), true);
        await page.locator('#view-game-result').waitFor({ state: 'visible' });
        assert.match(await page.locator('#result-stat').innerText(), /錯誤\/跳過：1 個/);
        const record = await page.evaluate(() => ({
            history: window.state.game.answeredHistory.map(answer => answer.result),
            wrongCount: window.state.game.wrongWords.size
        }));
        assert.deepEqual(record.history, ['skipped']);
        assert.equal(record.wrongCount, 1);
        if (offline && mode === 'spelling') {
            outcomes.push(await blockedAction(page, '#btn-save-review'));
            await page.locator('#result-new-folder-name').fill('離線不得建立的測試資料夾');
            outcomes.push(await blockedAction(page, '#btn-save-result-folder'));
            await screenshot(page, scenario, phase + '-blocked-save');
        }
        await page.locator('#btn-result-return').click();
        outcomes.push({ mode, skipped: 1, result: 'passed' });
    }
    return { ...selected, spellingSubmitted: true, outcomes };
}

async function runScenario(browser, profile, appURL) {
    const mountName = new URL(appURL).pathname === '/' ? 'root' :
        new URL(appURL).pathname.replace(/^\/|\/$/g, '').replace(/[^a-z0-9_-]/gi, '-');
    const scenario = {
        name: profile.name + '-' + mountName, appURL, viewport: profile.viewport,
        status: 'running', checks: [], screenshots: [], pageErrors: [],
        consoleErrors: [], failedRequests: [], blockedExternalRequests: [],
        contextConsole: [], serviceWorkerEvents: [], workerDiagnostics: [],
        workerNetwork: [], cdpWorkerEvents: []
    };
    report.scenarios.push(scenario);
    const context = await browser.newContext({
        viewport: profile.viewport, isMobile: profile.isMobile, hasTouch: profile.hasTouch,
        deviceScaleFactor: 1, locale: 'zh-TW', serviceWorkers: 'allow', acceptDownloads: false
    });
    // Also prevents accidental real Firebase or media requests if fixture
    // replacement regresses. Service Worker precaching itself uses only origin URLs.
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === base.origin) return route.continue();
        scenario.blockedExternalRequests.push(url.href);
        return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.setDefaultNavigationTimeout(45000);
    page.on('pageerror', error => scenario.pageErrors.push(message(error)));
    await installWorkerDiagnostics(context, page, scenario);
    await page.addInitScript(() => {
        window.__wordkingTestCspViolations = [];
        window.addEventListener('securitypolicyviolation', event => {
            window.__wordkingTestCspViolations.push({
                directive: event.effectiveDirective, blockedURI: event.blockedURI
            });
        });
    });
    try {
        await check(scenario, 'fresh public startup and mobile/desktop layout', async () => {
            const response = await page.goto(appURL + '?page=home', { waitUntil: 'domcontentloaded' });
            assert.ok(response.headers()['x-wordking-fixture']);
            await appReady(page);
            assert.equal(await page.evaluate(() => window.__wordkingFixture.account), 'guest');
            await noHorizontalOverflow(page);
            await screenshot(page, scenario, 'online-home');
        });
        const baseline = await publicWords(page);
        assert.ok(baseline.length >= 5);
        await check(scenario, 'manifest, install metadata, and PNG icon dimensions',
            () => manifestChecks(context, page, appURL));
        const worker = await check(scenario, 'real Service Worker controller and complete readiness',
            () => workerReady(page, appURL));
        await check(scenario, 'strict public cache and private/auth/query bypass', async () => {
            await cacheInventory(page, appURL, worker.readiness.release);
            const probes = await bypassProbes(page, appURL);
            const inventory = await cacheInventory(page, appURL, worker.readiness.release);
            return { probes, cacheName: inventory[0].name, entries: inventory[0].entries.length };
        });
        await check(scenario, 'online tree selection, spelling submission, and all skip modes',
            () => practiceSmoke(page, scenario, 'online', false));
        let privateDocuments;
        await check(scenario, 'fixture account has private data before going offline', async () => {
            await goHome(page);
            await page.evaluate(() => window.__wordkingFixture.setAccount('a'));
            await appReady(page);
            await page.waitForFunction(() => window.state.words.some(word => word.english === 'fixtureword'));
            assert.equal(await page.evaluate(() => window.__wordkingFixture.account), 'fixture-account-a');
            assert.ok(await page.evaluate(() => Object.values(window.state.folderNames)
                .some(name => name.includes('Fixture A 私人'))));
            privateDocuments = await page.evaluate(() => window.__wordkingFixture.documents);
            return { account: 'fixture-account-a', privateWordWasLoaded: true };
        });
        await check(scenario, 'real offline reload serves the full app and ignores cached private session', async () => {
            await context.setOffline(true);
            const response = await page.reload({ waitUntil: 'domcontentloaded' });
            assert.ok(response.fromServiceWorker(), 'Offline HTML must come from the actual Service Worker');
            assert.equal(response.headers()['x-wordking-offline'], '1');
            await appReady(page);
            const offline = await page.evaluate(() => ({
                online: navigator.onLine, marker: document.documentElement.dataset.wordkingOffline,
                publicMode: window.WordKingOffline,
                cachedFixtureAccount: window.__wordkingFixture.account,
                events: window.__wordkingFixture.events,
                privateFolders: Object.values(window.state.folderNames).filter(name => name.includes('Fixture A')),
                privateDOM: /fixtureword|A 的私人解釋|A 自己新增的單字/.test(
                    document.querySelector('main').textContent)
            }));
            // navigator.onLine is an OS/browser hint and may stay true during
            // transport emulation. Verify a real, uncacheable request fails.
            const networkProbe = new URL('__fixture-info?offline-probe=1', appURL).href;
            const canReachNetwork = await page.evaluate(async url => {
                try { await fetch(url, { cache: 'no-store' }); return true; }
                catch { return false; }
            }, networkProbe);
            assert.equal(canReachNetwork, false, 'An uncached network request must fail while offline');
            assert.equal(offline.marker, 'true');
            assert.equal(offline.publicMode, true);
            assert.deepEqual(offline.privateFolders, []);
            assert.equal(offline.privateDOM, false);
            assert.deepEqual(await publicWords(page), baseline,
                'Offline state must contain exactly the original public words and meanings');
            assert.equal(offline.events.some(event => /^(read:|write:|transaction|batch)/.test(event.type)), false,
                'Cached authentication must not start cloud reads or writes offline');
            await page.locator('#pwa-offline-banner').waitFor({ state: 'visible' });
            await noHorizontalOverflow(page);
            await screenshot(page, scenario, 'offline-home');
            return { fromServiceWorker: true, navigatorOnlineHint: offline.online,
                networkRequestFailed: true, publicWordCount: baseline.length,
                cachedFixtureAccount: offline.cachedFixtureAccount };
        });
        await check(scenario, 'offline tree and all practice modes, with save guards',
            () => practiceSmoke(page, scenario, 'offline', true));
        await check(scenario, 'offline add/login/sync guards and unchanged private documents', async () => {
            await goHome(page);
            await page.locator('#btn-home-library').click();
            await page.locator('#view-library').waitFor({ state: 'visible' });
            const guarded = [
                await blockedAction(page, '#btn-add-word', '#add-modal'),
                await blockedAction(page, '#btn-create-folder', '#new-folder-modal'),
                await blockedAction(page, '#btn-login'),
                await blockedAction(page, '#btn-sync')
            ];
            assert.deepEqual(await page.evaluate(() => window.__wordkingFixture.documents), privateDocuments);
            const cloudEvents = await page.evaluate(() => window.__wordkingFixture.events.filter(event =>
                /^(read:|write:|transaction|batch)/.test(event.type)));
            assert.deepEqual(cloudEvents, [], 'Offline operations must not reach even the mock cloud');
            assert.deepEqual(await publicWords(page), baseline);
            await screenshot(page, scenario, 'offline-library-guards');
            return guarded;
        });
        await check(scenario, 'reconnect remains public until explicit reload', async () => {
            await context.setOffline(false);
            const reachable = await page.evaluate(async url => {
                const response = await fetch(url, { cache: 'no-store' });
                return response.ok;
            }, new URL('__fixture-info?reconnect-probe=1', appURL).href);
            assert.equal(reachable, true, 'The uncached network probe must succeed after reconnecting');
            assert.equal(await page.evaluate(() => window.WordKingOffline), true);
            assert.deepEqual(await publicWords(page), baseline);
            await page.locator('#pwa-reconnect').waitFor({ state: 'visible' });
            await cacheInventory(page, appURL, worker.readiness.release);
            await screenshot(page, scenario, 'reconnected-public-mode');
        });
        await check(scenario, 'no uncaught JavaScript, CSP violations, or real Firebase requests', async () => {
            assert.deepEqual(scenario.pageErrors, []);
            const violations = await page.evaluate(() => window.__wordkingTestCspViolations);
            assert.deepEqual(violations, []);
            assert.equal(scenario.blockedExternalRequests.some(url =>
                /firebase|googleapis|gstatic|accounts\.google/.test(new URL(url).hostname)), false);
            return { pageErrors: 0, cspViolations: 0, realFirebaseRequests: 0 };
        });
        scenario.status = 'passed';
    } catch (error) {
        scenario.status = 'failed';
        scenario.error = message(error);
        try { await screenshot(page, scenario, 'failure'); } catch { /* Browser may already be closed. */ }
        try {
            scenario.failureState = await page.evaluate(() => ({
                url: location.href,
                loading: document.getElementById('app-loading-message')?.textContent,
                pwaStatus: document.getElementById('pwa-status')?.textContent,
                offline: window.WordKingOffline, account: window.__wordkingFixture?.account,
                fixtureEvents: window.__wordkingFixture?.events.slice(-30),
                workerDiagnostics: window.__wordkingTestWorkerDiagnostics
            }));
        } catch { /* Preserve the original failure. */ }
        process.stdout.write('FAILURE ' + scenario.name + ' | ' +
            JSON.stringify({ error: scenario.error, state: scenario.failureState,
                workerNetwork: scenario.workerNetwork, cdpWorkerEvents: scenario.cdpWorkerEvents }) + '\n');
    } finally {
        await context.close();
    }
    process.stdout.write(scenario.status.toUpperCase() + ' ' + scenario.name + '\n');
    return scenario;
}

async function main() {
    await fs.mkdir(artifacts, { recursive: true });
    let browser;
    try {
        for (const appURL of mounts) await fixturePreflight(appURL);
        browser = await chromium.launch({
            headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
            args: ['--mute-audio']
        });
        report.browserVersion = browser.version();
        const cases = mounts.flatMap(appURL => profiles.map(profile => ({ appURL, profile })));
        report.plannedScenarios = cases.length;
        let startupFailures = 0;
        for (let index = 0; index < cases.length; index += 1) {
            const { appURL, profile } = cases[index];
            const scenario = await runScenario(browser, profile, appURL);
            if (scenario.error?.code === 'PWA_WORKER_STARTUP') startupFailures += 1;
            if (startupFailures >= 2 && index + 1 < cases.length) {
                report.stoppedEarly = {
                    reason: 'Two independent contexts failed to activate a real Service Worker.',
                    unrun: cases.slice(index + 1).map(item => ({
                        appURL: item.appURL, viewport: item.profile.name, status: 'not-run'
                    }))
                };
                process.stdout.write('STOPPED EARLY | ' + JSON.stringify(report.stoppedEarly) + '\n');
                break;
            }
        }
        report.status = report.scenarios.every(scenario => scenario.status === 'passed') ? 'passed' : 'failed';
    } catch (error) {
        report.status = 'failed';
        report.infrastructureError = message(error);
    } finally {
        if (browser) await browser.close();
        report.finishedAt = new Date().toISOString();
        await fs.writeFile(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        process.stdout.write(JSON.stringify({
            status: report.status,
            passed: report.scenarios.filter(scenario => scenario.status === 'passed').length,
            total: report.scenarios.length,
            report: path.join(artifacts, 'report.json'),
            error: report.infrastructureError?.message
        }, null, 2) + '\n');
        if (report.status !== 'passed') process.exitCode = 1;
    }
}

main().catch(error => {
    process.stderr.write((error.stack || String(error)) + '\n');
    process.exitCode = 1;
});
