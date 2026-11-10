'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppHarness, createMemoryFirestore, deferred } = require('./helpers/app-harness.cjs');
const copy = value => JSON.parse(JSON.stringify(value));
const word = (id, english, definition, lesson = 'U1') => ({ id, english,
    meanings: [{ partOfSpeech: 'noun', definitions: [definition] }], lessonIds: [lesson], isWrong: false });
const original = [word('w_000001', 'alpha', '原義甲'), word('w_000002', 'beta', '原義乙')];
const updated = [word('w_000001', 'alpha', '新義甲'), word('w_000002', 'beta', '新義乙'),
    word('w_000003', 'gamma', '新增字', '死神單字L5U99')];

function harness(snapshot = {}) {
    const cloud = createMemoryFirestore({});
    const h = createAppHarness({ firebase: cloud.firebase });
    h.context.__original = copy(original);
    h.context.__snapshot = copy(snapshot);
    h.run(`publicCatalog = wordData.normalizeCatalog(__original);
        restoreUserState(__snapshot); publicDataReady = true; isUserDataReady = true;
        authReady = true; isCloudLoading = false; refreshFolders();`);
    return { ...h, ...cloud };
}

function deliver(h, catalog = updated) {
    h.context.window.WordKingPendingPublicCatalog = copy(catalog);
    h.run('receivePublicCatalogUpdate()');
}

test('a downloaded catalog updates public content and new courses without changing personal data', () => {
    const snapshot = {
        userOverrides: { w_000001: { meanings: [{ partOfSpeech: 'noun', definitions: ['我的意思'] }],
            isWrong: true, folderIds: ['private'], removedLessonIds: ['U1'] } },
        userFolders: { private: { name: '私人資料夾' } }, hiddenWordIds: ['w_000002'],
        settings: { lessonFolderNames: { U1: '我的課名' }, hiddenLessonIds: ['U1'] },
        customWords: { custom: { english: 'personal', meanings: [], lessonIds: [], folderIds: ['private'], isWrong: false } }
    };
    const h = harness(snapshot);
    const before = copy(h.run('snapshotUserState()'));
    deliver(h);
    assert.deepEqual(copy(h.run('publicCatalog')), updated);
    assert.deepEqual(copy(h.run('snapshotUserState()')), before);
    assert.equal(h.run("userWordState.getEffectiveWord('w_000001').meanings[0].definitions[0]"), '我的意思');
    assert.equal(h.run("userWordState.getPublicWord('w_000002').meanings[0].definitions[0]"), '新義乙');
    assert.ok(h.run("state.folderIds.includes('lesson:死神單字L5U99')"));
    assert.equal(h.run("state.folderParents['lesson:死神單字L5U99']"), 'series:shishen-lv5');
    assert.equal(h.run("getFolderDisplayName('lesson:死神單字L5U99')"), '死神單字Lv5U99');
    assert.equal(h.context.window.WordKingPublicCatalogStatus, 'applied');
    assert.equal(h.writes.length, 0);
    assert.equal(h.reads.length, 0);
});

test('an active quiz keeps its questions, answer draft, history and timer generation until it ends', () => {
    const h = harness();
    h.run(`state.game.isFinished = false; state.game.currentWords = state.words.slice();
        state.game.spellingDrafts = { w_000001: 'alp' }; state.game.answeredHistory = [{ id: 'answered' }];`);
    const game = copy(h.run('state.game'));
    const generation = h.run('gameGeneration');
    deliver(h);
    assert.deepEqual(copy(h.run('publicCatalog')), original);
    assert.deepEqual(copy(h.run('state.game')), game);
    assert.equal(h.context.window.WordKingPublicCatalogStatus, 'pending');
    const newest = [...updated, word('w_000004', 'delta', '最新字')];
    deliver(h, newest);
    h.run('state.game.isFinished = true; applyPendingPublicCatalog()');
    assert.deepEqual(copy(h.run('publicCatalog')), newest);
    assert.deepEqual(copy(h.run('state.game.spellingDrafts')), game.spellingDrafts);
    assert.deepEqual(copy(h.run('state.game.currentWords')), game.currentWords);
    assert.deepEqual(copy(h.run('state.game.answeredHistory')), game.answeredHistory);
    assert.equal(h.run('gameGeneration'), generation);
    assert.equal(h.run('publicCatalogUpdateTimer'), null);
});

test('editors, account loads, cloud writes and recovery postpone application without losing the download', () => {
    for (const [busy, idle] of [
        ['state.isEditing = true', 'state.isEditing = false'],
        ['isCloudLoading = true', 'isCloudLoading = false'],
        ['activeCloudWrites = 1', 'activeCloudWrites = 0'],
        ['isSyncing = true', 'isSyncing = false'],
        ['state.recovery = {}', 'state.recovery = null'],
        ['getOpenModal = () => ({ hidden: false })', 'getOpenModal = () => null']
    ]) {
        const h = harness();
        h.run(busy);
        deliver(h);
        assert.deepEqual(copy(h.run('publicCatalog')), original, busy);
        assert.equal(h.context.window.WordKingPublicCatalogStatus, 'pending', busy);
        h.run(idle + '; applyPendingPublicCatalog()');
        assert.deepEqual(copy(h.run('publicCatalog')), updated, busy);
        assert.equal(h.writes.length, 0);
    }
});

test('a new public English collision preserves both the current account and public model', () => {
    const h = harness({ customWords: { custom: { english: 'gamma', meanings: [], lessonIds: [], folderIds: [], isWrong: false } } });
    const before = copy(h.run('snapshotUserState()'));
    deliver(h);
    assert.deepEqual(copy(h.run('publicCatalog')), original);
    assert.deepEqual(copy(h.run('snapshotUserState()')), before);
    assert.equal(h.run("userWordState.getPublicWord('w_000003')"), null);
    assert.equal(h.context.window.WordKingPublicCatalogStatus, 'conflict');
    assert.equal(h.writes.length, 0);
});

test('malformed, duplicate and empty downloads cannot replace a usable app catalog', () => {
    for (const invalid of [[], [{}], [...updated, updated[0]], [...updated, { ...updated[0], id: 'w_000009' }]]) {
        const h = harness();
        deliver(h, invalid);
        assert.deepEqual(copy(h.run('publicCatalog')), original);
        assert.equal(h.run('pendingPublicCatalog'), null);
        assert.equal(h.writes.length, 0);
    }
});

test('a sync received before bootstrap wins after the older initial fetch and account load finish', async () => {
    const h = harness();
    const loading = deferred();
    h.context.fetch = () => loading.promise;
    h.run('publicCatalog = []; publicDataReady = false; isUserDataReady = false; userWordState = null;');
    const boot = h.run('ensurePublicDataLoaded()');
    deliver(h);
    assert.equal(h.context.window.WordKingPublicCatalogStatus, 'pending');
    loading.resolve({ ok: true, json: async () => copy(original) });
    await boot;
    assert.deepEqual(copy(h.run('publicCatalog')), original);
    h.run('restoreUserState(__snapshot); isUserDataReady = true; finishAppLoading()');
    assert.deepEqual(copy(h.run('publicCatalog')), updated);
    assert.equal(h.context.window.WordKingPublicCatalogStatus, 'applied');
});
