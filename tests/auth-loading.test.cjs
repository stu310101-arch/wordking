const {M}=require('./helpers/grouped-fixtures.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppHarness, deferred } = require('./helpers/app-harness.cjs');

const publicWord = { id: 'w_000001', english: 'public', meanings: M('公用'), lessonIds: ['unit-1'] };
const personalWord = { english: 'private', meanings: M('個人'), lessonIds: [], folderIds: ['f_mine'] };
const userData = (word = personalWord, revision = 3) => ({
    snapshot: { userOverrides: {}, customWords: { 'custom-1': word }, hiddenWordIds: ['w_000001'],
        userFolders: { f_mine: { name: 'mine' } },
        settings: { bgmEnabled: false, lessonFolderNames: { 'unit-1': '私人的名稱' }, hiddenLessonIds: [] } }, revision
});

test('auth confirmation before catalog completion still holds the guest render barrier', async () => {
    const h = harness();
    const catalog = deferred();
    h.context.catalogWait = catalog.promise;
    h.run('const originalLoader = loadDefaultWordDatabase; loadDefaultWordDatabase = async () => { await catalogWait; await originalLoader(); };');
    await h.run('bootstrap()');
    h.events.authCallback(null);
    await h.flush();
    assert.equal(h.events.views.length, 0);
    assert.equal(h.run('isUserDataReady'), false);
    catalog.resolve();
    await h.flush();
    assert.equal(h.events.views.length, 1);
    assert.equal(h.run('state.words[0].source'), 'public');
});

test('public overrides appear on the first signed-in render with no unmodified flash', async () => {
    const h = harness();
    const loading = deferred();
    h.context.personalWait = loading.promise;
    h.run('persistence = {load: async () => personalWait};');
    const login = h.run("handleAuthStateChanged({uid:'alice'})");
    await h.flush();
    assert.equal(h.events.views.length, 0);
    const result = userData();
    result.snapshot.hiddenWordIds = [];
    result.snapshot.userOverrides = { w_000001: { meanings: M('只顯示私人解釋') } };
    loading.resolve(result);
    await login;
    assert.equal(h.events.views.length, 1);
    assert.equal(h.events.views[0].words.find(word => word.id === 'w_000001').meanings[0].definitions.join('；'), '只顯示私人解釋');
});

test('a timed-out load invalidates migration writes even before the user retries', async () => {
    const h = harness();
    const serverRead = deferred();
    h.context.serverWait = serverRead.promise;
    h.run(`let migrationWrites = 0;
        persistence = {load: async (_user, {assertCurrent}) => {
            __events.migrationGuard = assertCurrent;
            await serverWait; assertCurrent(); migrationWrites += 1; return {};
        }};`);
    const loading = h.run("handleAuthStateChanged({uid:'alice'})");
    await h.flush();
    h.fireSyncTimeouts();
    await loading;
    assert.equal(h.run('isUserDataReady'), false);
    assert.throws(h.events.migrationGuard, error => error.code === 'stale-user-session');
    serverRead.resolve();
    await h.flush();
    assert.equal(h.run('migrationWrites'), 0);
    assert.equal(h.run('state.words.length'), 0);
});

test('failed refresh of an established account clears all private state', async () => {
    const h = harness();
    h.context.personalData = userData();
    h.run('persistence = {load: async () => personalData};');
    await h.run("handleAuthStateChanged({uid:'alice'})");
    h.run("state.game.currentWords = state.words; state.isEditing = true; state.editingWordIndex = 0; persistence.load = async () => {throw new Error('reload offline');};");
    await assert.rejects(h.run('loadFromCloud(currentUser)'), /reload offline/);
    assert.equal(h.run('state.words.length'), 0);
    assert.equal(h.run('state.hiddenWords.length'), 0);
    assert.equal(h.run('state.game.currentWords.length'), 0);
    assert.equal(h.run('state.isEditing'), false);
    assert.equal(h.run('isUserDataReady'), false);
    assert.equal(h.run("JSON.stringify(state).includes('私人的名稱')"), false);
    assert.equal(h.run("JSON.stringify(snapshotUserState()).includes('private')"), false);
    assert.equal(h.elements.get('app-loading-retry').hidden, false);
});

test('conflicting saves followed by a failed reload never restore private snapshots to the screen', async () => {
    const h = harness();
    h.context.personalData = userData();
    h.run('persistence = {load: async () => personalData};');
    await h.run("handleAuthStateChanged({uid:'alice'})");
    h.run(`persistence = {
        load: async () => {throw new Error('reload offline');},
        save: async () => {const error = new Error('conflict'); error.code = 'cloud-revision-conflict'; throw error;}
    };`);
    assert.equal(await h.run("commitUserMutation(model => model.updateCustomWord('custom-1', {meanings: M('optimistic')}))"), false);
    assert.equal(h.run('isUserDataReady'), false);
    assert.equal(h.run('state.words.length'), 0);
    assert.equal(h.run('activeCloudWrites'), 0);
    assert.equal(h.run("JSON.stringify(snapshotUserState()).includes('optimistic')"), false);
    assert.equal(h.elements.get('app-loading').hidden, false);
    assert.match(h.events.alerts.at(-1), /重新載入失敗/);
});

test('successful save from a superseded same-uid session cannot acknowledge its revision', async () => {
    const h = harness();
    const saving = deferred();
    h.context.saving = saving.promise;
    h.run("currentUser = {uid:'alice'}; authSessionGeneration = 1; cloudRevision = 3; persistence = {save: async (_p,_n,_u,options) => {__events.guard = options.assertCurrent; return saving;}};");
    const write = h.run('saveDiffChangesToCloud({}, {}, currentUser)');
    h.run("currentUser = {uid:'alice'}; authSessionGeneration = 3; cloudRevision = 8; activeCloudWrites = 2;");
    assert.throws(h.events.guard, error => error.code === 'stale-user-session');
    saving.resolve({revision: 99});
    await write;
    assert.equal(h.run('cloudRevision'), 8);
    assert.equal(h.run('activeCloudWrites'), 2);
});

test('persistence receives canonical snapshots, expected revision and a current-session guard', async () => {
    const h = harness();
    h.context.personalData = userData();
    h.run(`persistence = {
        load: async (user, options) => {__events.loadedUser = user.uid; options.assertCurrent(); return personalData;},
        save: async (previous, next, user, options) => {
            options.assertCurrent(); __events.saved = JSON.parse(JSON.stringify({previous,next,uid:user.uid,revision:options.expectedRevision}));
            return {revision: options.expectedRevision + 1};
        }
    };`);
    await h.run("handleAuthStateChanged({uid:'alice'})");
    assert.equal(await h.run("commitUserMutation(model => model.updateCustomWord('custom-1', {meanings: M('')}))"), true);
    assert.equal(h.events.loadedUser, 'alice');
    const saved = h.events.saved;
    assert.equal(saved.uid, 'alice');
    assert.equal(saved.revision, 3);
    assert.deepEqual(Object.keys(saved.next).sort(), ['customWords','hiddenWordIds','settings','userFolders','userOverrides']);
    assert.equal(saved.previous.customWords['custom-1'].meanings[0].definitions.join('；'), '個人');
    assert.equal(saved.next.customWords['custom-1'].meanings[0].definitions.join('；'), '');
    assert.equal(h.run('cloudRevision'), 4);
});

function harness() {
    const h = createAppHarness();
    h.context.catalog = [publicWord];
    h.run(`
        loadDefaultWordDatabase = async () => {
            publicCatalog = wordData.normalizeCatalog(catalog);
        };
    `);
    return h;
}

test('initial catalog load and auth confirmation run together; neither displays words alone', async () => {
    const h = harness();
    const catalog = deferred();
    h.context.catalogWait = catalog.promise;
    h.run('const actualCatalogLoader = loadDefaultWordDatabase; loadDefaultWordDatabase = async () => { await catalogWait; await actualCatalogLoader(); };');
    await h.run('bootstrap()');
    assert.equal(typeof h.events.authCallback, 'function');
    assert.equal(h.events.views.length, 0);
    assert.equal(h.run('state.words.length'), 0);
    catalog.resolve();
    await h.flush();
    assert.equal(h.run('publicDataReady'), true);
    assert.equal(h.events.views.length, 0, 'the catalog alone must not render before auth confirmation');
    h.events.authCallback(null);
    await h.flush();
    assert.equal(h.run('isUserDataReady'), true);
    assert.equal(h.events.views.length, 1);
    assert.equal(h.events.views[0].words[0].english, 'public');
});

test('a signed-in session displays only merged personal data after both dependencies finish', async () => {
    const h = harness();
    const personal = deferred();
    h.context.personalWait = personal.promise;
    h.run('loadUserDiffData = async () => personalWait;');
    const loaded = h.run("handleAuthStateChanged({uid: 'alice'})");
    await h.flush();
    assert.equal(h.run('publicDataReady'), true);
    assert.equal(h.run('state.words.length'), 0);
    assert.equal(h.run('isUserDataReady'), false);
    assert.equal(h.events.views.length, 0);
    assert.equal(h.elements.get('app-loading').hidden, false);
    personal.resolve(userData());
    await loaded;
    assert.equal(h.run('state.words[0].english'), 'private');
    assert.equal(h.events.views.length, 1);
    assert.equal(h.events.views[0].words.some(word => word.english === 'public'), false);
    assert.equal(h.elements.get('app-loading').hidden, true);
});

test('personal load failure fails closed and retry restores a complete session', async () => {
    const h = harness();
    h.auth.currentUser = { uid: 'alice' };
    h.run("loadUserDiffData = async () => { throw new Error('offline'); };");
    await h.run('handleAuthStateChanged(auth.currentUser)');
    assert.equal(h.run('state.words.length'), 0);
    assert.equal(h.run('isUserDataReady'), false);
    assert.equal(h.events.views.length, 0);
    assert.equal(h.elements.get('app-loading').classList.contains('is-error'), true);
    assert.equal(h.elements.get('app-loading-retry').hidden, false);
    assert.match(h.elements.get('app-loading-message').textContent, /個人資料未能載入/);
    h.context.personalData = userData();
    h.run('loadUserDiffData = async () => personalData; retryAppLoading();');
    await h.flush();
    assert.equal(h.run('isUserDataReady'), true);
    assert.equal(h.run('state.words[0].english'), 'private');
    assert.equal(h.elements.get('app-loading').hidden, true);
});

test('switching accounts clears old data immediately and ignores its late read', async () => {
    const h = harness();
    const alice = deferred();
    const bob = deferred();
    h.context.requests = { alice: alice.promise, bob: bob.promise };
    h.run('loadUserDiffData = async user => requests[user.uid];');
    const first = h.run("handleAuthStateChanged({uid: 'alice'})");
    await h.flush();
    h.run("state.words = [{english:'stale'}]; state.settings.lessonFolderNames = {'unit-1':'Alice'}; state.game.currentWords = state.words;");
    const second = h.run("handleAuthStateChanged({uid: 'bob'})");
    assert.equal(h.run('state.words.length'), 0);
    assert.equal(h.run('state.game.currentWords.length'), 0);
    assert.equal(h.run('Object.keys(state.settings.lessonFolderNames).length'), 0);
    await h.flush();
    bob.resolve(userData({ ...personalWord, english: 'bob-only' }, 9));
    await second;
    alice.resolve(userData({ ...personalWord, english: 'alice-only' }, 90));
    await first;
    assert.equal(h.run('currentUser.uid'), 'bob');
    assert.equal(h.run('state.words[0].english'), 'bob-only');
    assert.equal(h.run('cloudRevision'), 9);
    assert.equal(h.events.views.some(view => view.words.some(word => word.english === 'alice-only')), false);
});

test('logout restores public data and clears custom words, settings, game and edit state', async () => {
    const h = harness();
    h.context.personalData = userData();
    h.run('loadUserDiffData = async () => personalData;');
    await h.run("handleAuthStateChanged({uid: 'alice'})");
    h.run("state.game.currentWords = state.words; state.isEditing = true; state.editingWordIndex = 0;");
    await h.run('handleAuthStateChanged(null)');
    assert.equal(h.run('currentUser'), null);
    assert.equal(h.run('state.words[0].english'), 'public');
    assert.equal(h.run('state.settings.bgmEnabled'), true);
    assert.equal(h.run('Object.keys(state.settings.lessonFolderNames).length'), 0);
    assert.equal(h.run('state.game.currentWords.length'), 0);
    assert.equal(h.run('state.isEditing'), false);
    assert.equal(h.run('state.editingWordIndex'), -1);
});

test('same uid after an intervening account switch still rejects an old request', async () => {
    const h = harness();
    const stale = deferred();
    h.context.stale = stale.promise;
    h.context.personalData = userData({ ...personalWord, english: 'current-alice' }, 4);
    h.run('let reads = 0; loadUserDiffData = async () => ++reads === 1 ? stale : personalData;');
    const old = h.run("handleAuthStateChanged({uid: 'alice'})");
    await h.flush();
    await h.run('handleAuthStateChanged(null)');
    await h.run("handleAuthStateChanged({uid: 'alice'})");
    stale.resolve(userData({ ...personalWord, english: 'old-alice' }, 99));
    await old;
    assert.equal(h.run('state.words[0].english'), 'current-alice');
    assert.equal(h.run('cloudRevision'), 4);
});

test('late failed mutations cannot roll back a new account or decrement its writes', async () => {
    const h = harness();
    h.context.personalData = userData();
    h.run('loadUserDiffData = async () => personalData;');
    await h.run("handleAuthStateChanged({uid: 'alice'})");
    const saving = deferred();
    h.context.saving = saving.promise;
    h.run('saveDiffChangesToCloud = async () => saving;');
    const mutation = h.run("commitUserMutation(model => model.updateCustomWord('custom-1', {meanings: M('editing')}))");
    h.context.personalData = userData({ ...personalWord, english: 'bob-only' });
    await h.run("handleAuthStateChanged({uid: 'bob'})");
    h.run('activeCloudWrites = 2;');
    saving.reject(new Error('old write failed'));
    assert.equal(await mutation, false);
    assert.equal(h.run('state.words[0].english'), 'bob-only');
    assert.equal(h.run('activeCloudWrites'), 2);
    assert.equal(h.events.alerts.length, 0);
});

test('write completion from an old session cannot acknowledge its revision in the next session', async () => {
    const h = harness();
    const saving = deferred();
    h.context.saving = saving.promise;
    h.run(`currentUser = {uid:'alice'}; authSessionGeneration = 1; cloudRevision = 3;
        persistence = {save: async (_prev, _next, _user, options) => { __events.saveGuard = options.assertCurrent; return saving; }};`);
    const save = h.run('saveDiffChangesToCloud({}, {}, currentUser)');
    h.run("currentUser = {uid:'bob'}; authSessionGeneration = 2; cloudRevision = 10; activeCloudWrites = 2;");
    saving.resolve({ revision: 99 });
    await save;
    assert.equal(h.run('cloudRevision'), 10);
    assert.equal(h.run('activeCloudWrites'), 2);
});

test('timed out personal requests cannot replace retry results when their response arrives late', async () => {
    const h = harness();
    const stale = deferred();
    h.context.stale = stale.promise;
    h.run('loadUserDiffData = async () => stale;');
    const first = h.run("handleAuthStateChanged({uid: 'alice'})");
    await h.flush();
    h.fireSyncTimeouts();
    await first;
    assert.equal(h.run('isUserDataReady'), false);
    assert.equal(h.elements.get('app-loading-retry').hidden, false);
    h.context.personalData = userData({ ...personalWord, english: 'retried' }, 7);
    h.run('loadUserDiffData = async () => personalData;');
    await h.run("handleAuthStateChanged({uid: 'alice'})");
    stale.resolve(userData({ ...personalWord, english: 'late' }, 100));
    await h.flush();
    assert.equal(h.run('state.words[0].english'), 'retried');
    assert.equal(h.run('cloudRevision'), 7);
});

test('visitors and failed personal sessions cannot mutate public words', async () => {
    const h = harness();
    await h.run('handleAuthStateChanged(null)');
    assert.equal(await h.run("commitUserMutation(model => model.hidePublicWord('w_000001'))"), false);
    assert.equal(h.run('state.words.length'), 1);
    h.run("currentUser = {uid:'alice'}; isUserDataReady = false;");
    assert.equal(await h.run("commitUserMutation(model => model.hidePublicWord('w_000001'))"), false);
    assert.equal(h.run('state.words.length'), 1);
    assert.equal(h.run('requireLoginForChange()'), false);
});

test('stale reads abort at the persistence boundary before automatic migration writes', async () => {
    const h = harness();
    const rootRead = deferred();
    h.context.rootWait = rootRead.promise;
    h.run(`currentUser = {uid:'alice'}; authSessionGeneration = 1; cloudLoadGeneration = 1;
        let migrationWrites = 0;
        persistence = {load: async (_user, {assertCurrent}) => {
            await rootWait; assertCurrent(); migrationWrites += 1; return {};
        }};`);
    const reading = h.run("loadUserDiffData({uid:'alice'}, {sessionGeneration:1, loadGeneration:1})");
    h.run("currentUser = {uid:'bob'}; authSessionGeneration = 2; cloudLoadGeneration = 2;");
    rootRead.resolve();
    await assert.rejects(reading, error => error.code === 'stale-user-session');
    assert.equal(h.run('migrationWrites'), 0);
});

test('a superseded load generation rejects migration even when the uid has not changed', async () => {
    const h = harness();
    const reading = deferred();
    h.context.readWait = reading.promise;
    h.run(`currentUser = {uid:'alice'}; authSessionGeneration = 1; cloudLoadGeneration = 1;
        let migrationWrites = 0;
        persistence = {load: async (_user, {assertCurrent}) => {
            await readWait; assertCurrent(); migrationWrites += 1; return {};
        }};`);
    const migration = h.run("loadUserDiffData({uid:'alice'}, {sessionGeneration:1, loadGeneration:1})");
    h.run('cloudLoadGeneration += 1;');
    reading.resolve();
    await assert.rejects(migration, error => error.code === 'stale-user-session');
    assert.equal(h.run('migrationWrites'), 0);
});

// Transaction chunk/retry/lease regressions are covered by persistence.test.cjs.
test('catalog failures can be retried before displaying any words', async () => {
    const h = harness();
    h.run("const catalogLoader = loadDefaultWordDatabase; loadDefaultWordDatabase = async () => {throw new Error('catalog offline');};");
    await h.run('handleAuthStateChanged(null)');
    assert.equal(h.run('state.words.length'), 0);
    assert.equal(h.elements.get('app-loading-retry').hidden, false);
    assert.match(h.elements.get('app-loading-message').textContent, /公用單字資料未能載入/);
    h.run('loadDefaultWordDatabase = catalogLoader; retryAppLoading();');
    await h.flush();
    assert.equal(h.run('state.words[0].english'), 'public');
    assert.equal(h.run('isUserDataReady'), true);
});
