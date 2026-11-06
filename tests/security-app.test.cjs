const assert = require('node:assert/strict');
const { test } = require('node:test');
const { inspect } = require('node:util');
const { createAppHarness, deferred } = require('./helpers/app-harness.cjs');

const copy = value => JSON.parse(JSON.stringify(value));
const publicCatalog = [{ id: 'w_000001', english: 'public', meanings: [{ partOfSpeech: 'noun', definitions: ['公用'] }], lessonIds: ['unit-1'] }];
const account = { uid: 'alice', email: 'alice@example.test' };
const personalData = () => ({ revision: 7, snapshot: {
    userOverrides: { w_000001: { meanings: [{ partOfSpeech: 'noun', definitions: ['PRIVATE_OVERRIDE'] }] } },
    customWords: { c_private: { english: 'PRIVATE_WORD', meanings: [{ partOfSpeech: 'noun', definitions: ['PRIVATE_DEFINITION'] }], lessonIds: [], folderIds: ['f_private'], isWrong: true } },
    hiddenWordIds: [], userFolders: { f_private: { name: 'PRIVATE_FOLDER' } },
    settings: { lessonFolderNames: { 'unit-1': 'PRIVATE_LESSON' }, bgmEnabled: false }
} });
const secretError = code => Object.assign(new Error('SECRET_TOKEN credential=SECRET_CREDENTIAL users/PRIVATE_UID/customWords/PRIVATE_PATH'), {
    code, customData: { accessToken: 'SECRET_TOKEN', email: 'PRIVATE_EMAIL' }
});

function harness({ online = true, marker = false, embedded = false, cachedUser = null, firebase = {}, persistence = {} } = {}) {
    const navigator = { onLine: online };
    const firebaseAuth = { currentUser: cachedUser };
    const callbacks = {};
    const calls = { initialize: 0, auth: 0, db: 0, observers: 0, popup: 0, signOut: 0, providers: [], publicFetches: [], privateLoads: [], privateSaves: [], rawPrivateReads: 0, rawPrivateWrites: 0 };
    const consoleOutput = [];
    const listeners = new Map();
    const window = {
        location: 'https://example.test/?page=library', scrollTo() {},
        crypto: require('node:crypto').webcrypto, speechSynthesis: { cancel() {} },
        addEventListener(type, callback) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(callback);
        },
        dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); return true; }
    };
    window.self = window;
    window.top = embedded ? {} : window;
    const h = createAppHarness({
        documentDataset: marker ? { wordkingOffline: 'true' } : {},
        firebase: {
            navigator, window,
            CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
            console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => consoleOutput.push({ level, args })])),
            initializeApp: () => { calls.initialize++; return {}; },
            getAuth: () => { calls.auth++; return firebaseAuth; },
            getFirestore: () => { calls.db++; return {}; },
            setPersistence: async (auth, provider) => {
                calls.providers.push(provider.type);
                if (firebase.setPersistence) return firebase.setPersistence(auth, provider);
            },
            onAuthStateChanged: (_auth, callback, error) => { calls.observers++; callbacks.auth = callback; callbacks.error = error; },
            signInWithPopup: async (...args) => { calls.popup++; return firebase.signInWithPopup?.(...args); },
            signOut: async (...args) => { calls.signOut++; return firebase.signOut?.(...args); },
            getDoc: async () => { calls.rawPrivateReads++; throw new Error('Unexpected private read'); },
            getDocs: async () => { calls.rawPrivateReads++; throw new Error('Unexpected private read'); },
            runTransaction: async () => { calls.rawPrivateWrites++; throw new Error('Unexpected private write'); },
            fetch: async url => {
                calls.publicFetches.push(url);
                assert.equal(url, './data/words.json', 'only the public catalog may be fetched');
                return { ok: true, json: async () => copy(publicCatalog) };
            }
        },
        persistence: {
            load: async (user, options) => {
                calls.privateLoads.push(user.uid);
                options.assertCurrent();
                return persistence.load ? persistence.load(user, options) : personalData();
            },
            save: async (previous, next, user, options) => {
                calls.privateSaves.push(user.uid);
                options.assertCurrent();
                return persistence.save ? persistence.save(previous, next, user, options) : { revision: options.expectedRevision + 1 };
            }
        }
    });
    return { ...h, navigator, firebaseAuth, callbacks, calls, consoleOutput, window,
        async start(user = null) {
            await h.run('bootstrap()');
            if (callbacks.auth) { firebaseAuth.currentUser = user; callbacks.auth(user); await h.flush(); }
        },
        offline() { navigator.onLine = false; window.dispatchEvent({ type: 'offline' }); }
    };
}

function assertNoPrivateAccess(h) {
    assert.deepEqual(h.calls.privateLoads, []);
    assert.deepEqual(h.calls.privateSaves, []);
    assert.equal(h.calls.rawPrivateReads, 0);
    assert.equal(h.calls.rawPrivateWrites, 0);
}

function assertPublicOnly(h) {
    assert.equal(h.run('currentUser'), null);
    assert.equal(h.run('isUserDataReady'), true);
    assert.deepEqual(copy(h.run('state.words.map(word => word.english)')), ['public']);
    assert.equal(h.run("JSON.stringify(state).includes('PRIVATE_')"), false);
    assert.equal(h.run("JSON.stringify(snapshotUserState()).includes('PRIVATE_')"), false);
}

function assertRedacted(h) {
    const visible = inspect({ alerts: h.events.alerts, console: h.consoleOutput,
        loading: h.elements.get('app-loading-message')?.textContent }, { depth: 20 });
    assert.doesNotMatch(visible, /SECRET_TOKEN|SECRET_CREDENTIAL|PRIVATE_UID|PRIVATE_PATH|PRIVATE_EMAIL/);
}

test('unknown sign-in errors redact credentials and arbitrary codes; known errors keep useful advice', async () => {
    for (const [code, expected, logged] of [
        ['unknown/SECRET_TOKEN', /登入未完成.*重試/, 'unexpected-error'],
        ['auth/popup-blocked', /允許.*彈出視窗/, 'auth/popup-blocked'],
        ['auth/network-request-failed', /確認網路/, 'auth/network-request-failed']
    ]) {
        const h = harness({ firebase: { signInWithPopup: async () => { throw secretError(code); } } });
        await h.start();
        await h.run('firebaseLogin()');
        assert.equal(h.calls.popup, 1);
        assert.match(h.events.alerts.at(-1), expected);
        assert.equal(h.consoleOutput.at(-1).args[1].code, logged);
        assert.equal(h.run('isLoggingIn'), false);
        assertRedacted(h);
    }
});

test('private load, save, logout and auth-observer errors do not expose response bodies or credentials', async () => {
    const loading = harness({ persistence: { load: async () => { throw secretError('unknown/SECRET_TOKEN'); } } });
    await loading.start(account);
    assert.match(loading.elements.get('app-loading-message').textContent, /個人資料未能載入/);
    assert.equal(loading.run('isUserDataReady'), false);
    assert.equal(loading.run('state.words.length'), 0);
    assertRedacted(loading);

    const saving = harness({ persistence: { save: async () => { throw secretError('permission-denied'); } },
        firebase: { signOut: async () => { throw secretError('unknown/SECRET_TOKEN'); } } });
    await saving.start(account);
    const before = copy(saving.run('snapshotUserState()'));
    assert.equal(await saving.run("commitUserMutation(model => model.updateCustomWord('c_private', { english: 'edited' }))"), false);
    assert.match(saving.events.alerts.at(-1), /沒有權限/);
    assert.deepEqual(copy(saving.run('snapshotUserState()')), before);
    await saving.run('firebaseLogout()');
    assert.match(saving.events.alerts.at(-1), /登出未完成/);
    saving.callbacks.error(secretError('unknown/SECRET_TOKEN'));
    assert.equal(saving.run('currentUser'), null);
    assert.equal(saving.run('state.words.length'), 0);
    assert.equal(saving.run('authReady'), false);
    assertRedacted(saving);
});

test('history failures use the same redacted logger without exposing private navigation details', () => {
    const h = harness();
    h.context.history.pushState = () => { throw secretError('unknown/SECRET_TOKEN'); };
    h.run("writeNavigationHistory('library', 'folder:PRIVATE_PATH')");
    assert.equal(h.consoleOutput.at(-1).args[1].operation, 'update-navigation');
    assert.equal(h.consoleOutput.at(-1).args[1].code, 'unexpected-error');
    assertRedacted(h);
});

for (const [label, environment] of [
    ['navigator reports offline', { online: false }],
    ['cached HTML carries the offline marker while navigator reports online', { online: true, marker: true }]
]) test(`${label}: cached auth is ignored and startup never reads or writes private data`, async () => {
    const h = harness({ ...environment, cachedUser: account });
    await h.start();
    assertPublicOnly(h);
    assert.equal(h.window.WordKingOffline, true);
    assert.equal(h.calls.auth, 0, 'offline boot must not initialize Auth storage');
    assert.equal(h.calls.db, 0, 'offline boot must not initialize Firestore');
    assert.equal(h.calls.observers, 0);
    assert.deepEqual(h.calls.providers, []);
    assert.deepEqual(h.calls.publicFetches, ['./data/words.json']);
    await h.run("handleAuthStateChanged({ uid: 'stale-cached-user' })");
    assertPublicOnly(h);
    assertNoPrivateAccess(h);
});

test('offline login, private mutations, direct cloud calls and manual sync are blocked before side effects', async () => {
    const h = harness({ online: false, cachedUser: account });
    await h.start();
    const before = copy(h.run('snapshotUserState()'));
    h.run('globalThis.mutationCalls = 0;');
    assert.equal(await h.run("commitUserMutation(model => { mutationCalls++; model.createCustomWord('c_blocked', {english:'blocked'}); })"), false);
    assert.equal(h.run('mutationCalls'), 0);
    assert.equal(h.run('requireLoginForChange()'), false);
    await h.run('firebaseLogin(); syncCloudNow();');
    assert.equal(h.calls.popup, 0);
    assert.throws(() => h.run('getPersistence()'), { code: 'offline-public-mode' });
    await assert.rejects(h.run("loadUserDiffData({ uid: 'alice' })"), { code: 'offline-public-mode' });
    await assert.rejects(h.run("saveDiffChangesToCloud({}, {}, { uid: 'alice' })"), { code: 'offline-public-mode' });
    assert.deepEqual(copy(h.run('snapshotUserState()')), before);
    assert.ok(h.events.alerts.every(message => /僅能練習公用單字/.test(message)));
    assertNoPrivateAccess(h);
});

test('online-to-offline transition immediately clears private state and ignores stale auth after reconnect', async () => {
    const h = harness();
    await h.start(account);
    assert.equal(h.run("state.words.some(word => word.english === 'PRIVATE_WORD')"), true);
    h.run(`state.game.currentWords = state.words; state.game.answeredHistory = [{answer:'PRIVATE_ANSWER'}];
        state.isEditing = true; state.editingWordIndex = 1;
        document.getElementById('practice-folder-heading').textContent = 'PRIVATE_FOLDER';
        globalThis.revisionStops = 0; unsubscribeUserRevision = () => { revisionStops++; };`);
    h.offline();
    assert.equal(h.run('currentUser'), null, 'private identity clears synchronously on the offline event');
    assert.equal(h.run('state.words.length'), 0);
    assert.equal(h.elements.get('practice-folder-heading').textContent, '');
    assert.equal(h.run('revisionStops'), 1);
    await h.flush();
    assertPublicOnly(h);
    assert.equal(h.run('state.game.currentWords.length'), 0);
    assert.equal(h.run('state.game.answeredHistory.length'), 0);
    assert.equal(h.run('state.isEditing'), false);
    assert.equal(h.run('state.editingWordIndex'), -1);
    h.navigator.onLine = true;
    h.callbacks.auth(account);
    h.callbacks.error(secretError('unknown/SECRET_TOKEN'));
    await h.flush();
    assertPublicOnly(h);
    assert.equal(h.calls.privateLoads.length, 1, 'a stale cached account must not reopen private data');
    assert.equal(h.window.WordKingOffline, true, 'public mode stays active until an explicit reload');
    assertRedacted(h);
});

test('an offline transition invalidates an in-flight private load before late migration or rendering', async () => {
    const pending = deferred();
    let guard, migrations = 0;
    const h = harness({ persistence: { load: async (_user, options) => {
        guard = options.assertCurrent;
        await pending.promise;
        guard(); migrations++;
        return personalData();
    } } });
    await h.run('bootstrap()');
    h.callbacks.auth(account);
    await h.flush();
    assert.equal(typeof guard, 'function');
    h.offline();
    await h.flush();
    assertPublicOnly(h);
    assert.throws(guard, { code: 'stale-user-session' });
    pending.resolve();
    await h.flush();
    assert.equal(migrations, 0);
    assertPublicOnly(h);
    assert.equal(h.events.views.some(view => view.words.some(word => word.english === 'PRIVATE_WORD')), false);
});

test('an offline transition invalidates an in-flight save guard and cannot restore an optimistic private snapshot', async () => {
    const pending = deferred();
    let guard, commits = 0;
    const h = harness({ persistence: { save: async (_previous, _next, _user, options) => {
        guard = options.assertCurrent;
        await pending.promise;
        guard(); commits++;
        return { revision: 99 };
    } } });
    await h.start(account);
    const saving = h.run("commitUserMutation(model => model.updateCustomWord('c_private', { english: 'PRIVATE_OPTIMISTIC' }))");
    await h.flush();
    assert.equal(typeof guard, 'function');
    h.offline();
    await h.flush();
    assertPublicOnly(h);
    assert.throws(guard, { code: 'stale-user-session' });
    pending.resolve();
    assert.equal(await saving, false);
    assert.equal(commits, 0);
    assert.equal(h.run('cloudRevision'), 0);
    assert.equal(h.run('activeCloudWrites'), 0);
    assertPublicOnly(h);
});

test('offline transition keeps a ready guest public quiz intact', async () => {
    const h = harness();
    await h.start();
    h.run("state.game.currentWords = state.words; state.game.mode = 'spelling'; state.game.isFinished = false; state.game.spellingDrafts = {w_000001: 'pub'};");
    const before = copy(h.run('state.game'));
    h.offline();
    await h.flush();
    assert.equal(h.window.WordKingOffline, true);
    assert.deepEqual(copy(h.run('state.game')), before);
    assertPublicOnly(h);
    assertNoPrivateAccess(h);
});

test('auth observer waits for session persistence and uses memory only if session storage fails', async () => {
    for (const fallback of [false, true]) {
        const session = deferred(), memory = deferred();
        const h = harness({ firebase: { setPersistence: async (_auth, provider) => provider.type === 'SESSION' ? session.promise : memory.promise } });
        const boot = h.run('bootstrap()');
        await h.flush();
        assert.deepEqual(h.calls.providers, ['SESSION']);
        assert.equal(h.calls.observers, 0);
        if (fallback) {
            session.reject(secretError('unknown/SECRET_TOKEN'));
            await h.flush();
            assert.deepEqual(h.calls.providers, ['SESSION', 'NONE']);
            assert.equal(h.calls.observers, 0);
            memory.resolve();
        } else session.resolve();
        await boot;
        assert.equal(h.calls.observers, 1);
        assertNoPrivateAccess(h);
        assertRedacted(h);
    }
});

test('failure of both auth persistence providers fails closed without private reads or a raw error', async () => {
    const h = harness({ cachedUser: account, firebase: { setPersistence: async () => { throw secretError('unknown/SECRET_TOKEN'); } } });
    await h.run('bootstrap()');
    assert.deepEqual(h.calls.providers, ['SESSION', 'NONE']);
    assert.equal(h.calls.observers, 0);
    assert.equal(h.run('authReady'), false);
    assert.equal(h.run('currentUser'), null);
    assert.equal(h.run('state.words.length'), 0);
    assert.match(h.elements.get('app-loading-message').textContent, /網站初始化失敗/);
    assertNoPrivateAccess(h);
    assertRedacted(h);
});

test('going offline while persistence initializes never registers an auth observer afterward', async () => {
    for (const fallback of [false, true]) {
        const pending = deferred();
        const h = harness({ cachedUser: account, firebase: { setPersistence: async (_auth, provider) => {
            if (fallback && provider.type === 'SESSION') throw secretError('unknown/SECRET_TOKEN');
            return pending.promise;
        } } });
        const boot = h.run('bootstrap()');
        await h.flush();
        assert.deepEqual(h.calls.providers, fallback ? ['SESSION', 'NONE'] : ['SESSION']);
        assert.equal(h.calls.observers, 0);
        h.offline();
        await h.flush();
        assertPublicOnly(h);
        pending.resolve();
        await boot;
        assert.equal(h.calls.observers, 0);
        assertPublicOnly(h);
        assertNoPrivateAccess(h);
    }
});

test('embedded frame boot shows a direct-open link without Firebase or catalog initialization', async () => {
    const h = harness({ embedded: true, cachedUser: account });
    await h.run('bootstrap()');
    assert.equal(h.calls.initialize, 0);
    assert.equal(h.calls.auth, 0);
    assert.equal(h.calls.db, 0);
    assert.equal(h.calls.observers, 0);
    assert.deepEqual(h.calls.providers, []);
    assert.deepEqual(h.calls.publicFetches, []);
    const notice = h.elements.get('body').children[0];
    assert.match(notice.children[0].textContent, /請直接開啟單字王/);
    assert.equal(notice.children[1].href, 'https://example.test/');
    assert.equal(notice.children[1].target, '_top');
    assert.equal(h.elements.get('body').getAttribute('aria-busy'), 'false');
    assertNoPrivateAccess(h);
});
