const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppHarness, deferred } = require('./helpers/app-harness.cjs');

const publicWord = { id: 'base-1', defaultId: 'base-1', source: 'default', english: 'public', meaning: '公用', tags: ['unit-1'], folderIds: ['unit-1'] };
const personalWord = { id: 'custom-1', source: 'custom', english: 'private', meaning: '個人', folderIds: ['mine'] };
const userData = (word = personalWord, revision = 3) => ({ words: [word], folders: ['mine'], settings: { bgmEnabled: false, lessonFolderNames: { 'unit-1': '私人的名稱' } }, revision });

function harness() {
    const h = createAppHarness();
    h.context.catalog = [publicWord];
    h.run(`
        loadDefaultWordDatabase = async () => {
            defaultWordDatabase = catalog.map(cloneWord);
            defaultWordMap = new Map(defaultWordDatabase.map(word => [word.id, word]));
            state.lessonFolderIds = ['unit-1'];
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
    const mutation = h.run("commitUserMutation(draft => { draft.words[0].meaning = 'editing'; })");
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
        collectDiffOperations = () => [() => {}]; commitBatchOperations = async () => saving;`);
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
    assert.equal(await h.run("commitUserMutation(draft => { draft.words = []; })"), false);
    assert.equal(h.run('state.words.length'), 1);
    h.run("currentUser = {uid:'alice'}; isUserDataReady = false;");
    assert.equal(await h.run("commitUserMutation(draft => { draft.words = []; })"), false);
    assert.equal(h.run('state.words.length'), 1);
    assert.equal(h.run('requireLoginForChange()'), false);
});

test('stale reads abort before automatic migration writes', async () => {
    const h = harness();
    const rootRead = deferred();
    h.context.rootWait = rootRead.promise;
    h.context.rootSnapshot = { exists: () => true, data: () => ({ revision: 0, words: [], folders: ['private'] }) };
    h.run(`currentUser = {uid:'alice'}; authSessionGeneration = 1; cloudLoadGeneration = 1;
        getStableUserRootSnapshot = async () => rootWait;
        getDoc = async () => rootSnapshot; readUserCollection = async () => [];
        let migrationWrites = 0; commitBatchOperations = async () => { migrationWrites += 1; return {revision: 1}; };`);
    const reading = h.run("loadUserDiffData({uid:'alice'}, {sessionGeneration:1, loadGeneration:1})");
    h.run("currentUser = {uid:'bob'}; authSessionGeneration = 2; cloudLoadGeneration = 2;");
    rootRead.resolve(h.context.rootSnapshot);
    await assert.rejects(reading, error => error.code === 'stale-user-session');
    assert.equal(h.run('migrationWrites'), 0);
});

test('an account change during a transaction read prevents its writes', async () => {
    const h = harness();
    const reading = deferred();
    h.context.transactionRead = reading.promise;
    h.run(`currentUser = {uid:'alice'}; authSessionGeneration = 1;
        let transactionWrites = 0;
        executeTransaction = async (_db, update) => update({
            get: async () => transactionRead, set: () => { transactionWrites += 1; }
        });`);
    const commit = h.run('commitBatchOperations([tx => tx.set({}, {})], currentUser, 0)');
    h.run("currentUser = {uid:'bob'}; authSessionGeneration += 1;");
    reading.resolve({ exists: () => true, data: () => ({ revision: 0 }) });
    await assert.rejects(commit, error => error.code === 'stale-user-session');
    assert.equal(h.run('transactionWrites'), 0);
});

test('large sync stops later chunks and cleanup after the initiating session changes', async () => {
    const h = harness();
    const firstChunk = deferred();
    h.context.chunkWait = firstChunk.promise;
    h.run(`currentUser = {uid:'alice'}; authSessionGeneration = 1;
        let transactionCount = 0; let batchCount = 0;
        executeTransaction = async (_db, update) => {
            transactionCount += 1;
            return update({ get: async () => ({exists: () => true, data: () => ({revision:0})}), set() {} });
        };
        createWriteBatch = () => { batchCount += 1; return {set() {}, commit: async () => chunkWait}; };`);
    const commit = h.run('commitBatchOperations(Array.from({length:441}, () => () => {}), currentUser, 0)');
    await h.flush();
    assert.equal(h.run('batchCount'), 1);
    h.run("currentUser = {uid:'bob'}; authSessionGeneration += 1;");
    firstChunk.resolve();
    await assert.rejects(commit, error => error.code === 'stale-user-session');
    assert.equal(h.run('batchCount'), 1);
    assert.equal(h.run('transactionCount'), 1, 'no lock cleanup may write after a session is invalidated');
});

test('large sync retries check the session again before starting another batch', async () => {
    const h = harness();
    const retry = deferred();
    h.context.retryWait = retry.promise;
    h.run(`currentUser = {uid:'alice'}; authSessionGeneration = 1;
        let batchCount = 0;
        executeTransaction = async (_db, update) => update({get: async () => ({exists: () => true, data: () => ({revision:0})}), set() {}});
        createWriteBatch = () => { batchCount += 1; return {set() {}, commit: async () => {throw new Error('network');}}; };
        waitBeforeRetry = async () => retryWait;`);
    const commit = h.run('commitBatchOperations(Array.from({length:441}, () => () => {}), currentUser, 0)');
    await h.flush();
    h.run("currentUser = {uid:'bob'}; authSessionGeneration += 1;");
    retry.resolve();
    await assert.rejects(commit, error => error.code === 'stale-user-session');
    assert.equal(h.run('batchCount'), 1);
});

test('migration transactions recheck the load generation after waiting for the server', async () => {
    const h = harness();
    const reading = deferred();
    h.context.transactionWait = reading.promise;
    h.context.rootSnapshot = { exists: () => true, data: () => ({ revision: 0, words: [], folders: ['legacy-folder'] }) };
    h.run(`currentUser = {uid:'alice'}; authSessionGeneration = 1; cloudLoadGeneration = 1;
        getStableUserRootSnapshot = async () => rootSnapshot;
        getDoc = async () => rootSnapshot; readUserCollection = async () => [];
        let migrationWrites = 0;
        executeTransaction = async (_db, update) => update({get: async () => transactionWait, set: () => {migrationWrites += 1;}});`);
    const migration = h.run("loadUserDiffData({uid:'alice'}, {sessionGeneration:1, loadGeneration:1})");
    await h.flush();
    h.run('cloudLoadGeneration += 1;');
    reading.resolve(h.context.rootSnapshot);
    await assert.rejects(migration, error => error.code === 'stale-user-session');
    assert.equal(h.run('migrationWrites'), 0);
});

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
