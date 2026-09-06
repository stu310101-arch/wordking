const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAppHarness } = require('./helpers/app-harness.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
const user = { uid: 'data-owner' };
const rawCatalog = [
    { id: 'fixed-apple', english: 'apple', meaning: 'public apple', partOfSpeech: 'noun', isWrong: true, tags: ['課程1', '課程2'] },
    { id: 'fixed-banana', english: 'banana', meaning: 'public banana', partOfSpeech: 'noun', tags: ['課程2'] }
];
const aliases = { aliases: { 'old-apple': 'fixed-apple' }, legacyTagsById: {
    'fixed-apple': ['課程1', '課程2'], 'old-apple': ['課程1', '課程2']
} };

function harness(initialDocuments = {}) {
    const documents = new Map(Object.entries(clone(initialDocuments)));
    const writes = [];
    const read = reference => {
        const data = documents.get(reference.path);
        return { exists: () => data !== undefined, data: () => data === undefined ? {} : clone(data) };
    };
    const apply = write => {
        writes.push(clone(write));
        if (write.type === 'delete') documents.delete(write.path);
        else documents.set(write.path, write.merge ? { ...documents.get(write.path), ...clone(write.data) } : clone(write.data));
    };
    const h = createAppHarness({ firebase: {
        getDoc: async reference => read(reference),
        getDocs: async reference => ({ docs: [...documents.entries()]
            .filter(([key]) => key.startsWith(`${reference.path}/`) && !key.slice(reference.path.length + 1).includes('/'))
            .map(([key, value]) => ({ id: key.slice(reference.path.length + 1), data: () => clone(value) })) }),
        runTransaction: async (_db, callback) => {
            const pending = [];
            const result = await callback({
                get: async reference => read(reference),
                set: (reference, data, options = {}) => pending.push({ type: 'set', path: reference.path, data, merge: !!options.merge }),
                delete: reference => pending.push({ type: 'delete', path: reference.path })
            });
            pending.forEach(apply);
            return result;
        }
    } });
    h.context.__catalog = clone(rawCatalog);
    h.context.__aliases = clone(aliases);
    h.context.__user = user;
    h.run(`
        defaultWordDatabase = wordData.normalizeCatalog(__catalog).map(cloneWord);
        defaultWordMap = new Map(defaultWordDatabase.map(word => [word.defaultId, word]));
        defaultWordEnglishMap = new Map(defaultWordDatabase.map(word => [word.english.toLowerCase(), word]));
        defaultWordAliases = __aliases;
        state.lessonFolderIds = ['課程1', '課程2'];
        currentUser = __user;
        authReady = true;
        isUserDataReady = true;
    `);
    return { ...h, documents, writes, apply };
}

function merged(h, diff = {}) {
    h.context.__diff = clone(diff);
    return clone(h.run('buildUserDataFromDiffs(__diff)'));
}

function operations(h, previous, next) {
    const recorded = [];
    h.context.__previous = clone(previous);
    h.context.__next = clone(next);
    h.context.__transaction = {
        set: (reference, data, options = {}) => recorded.push({ type: 'set', path: reference.path, data: clone(data), merge: !!options.merge }),
        delete: reference => recorded.push({ type: 'delete', path: reference.path })
    };
    h.run('collectDiffOperations(__previous, __next, __user).forEach(apply => apply(__transaction))');
    return recorded;
}

test('an untouched account produces no word copies; changing one field writes only that difference', () => {
    const h = harness();
    const before = merged(h);
    assert.equal(operations(h, before, clone(before)).length, 0);
    const after = clone(before);
    after.words[0].meaning = '';
    const changes = operations(h, before, after);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].path, 'users/data-owner/wordOverrides/fixed-apple');
    assert.equal(changes[0].data.meaning, '');
    assert.equal(Object.hasOwn(changes[0].data, 'english'), false);
    assert.equal(Object.hasOwn(changes[0].data, 'partOfSpeech'), false);
    assert.equal(Object.hasOwn(changes[0].data, 'folderIds'), false);
});

test('empty strings, false, and empty legacy tag arrays survive the actual app merge', () => {
    const h = harness();
    const result = merged(h, { wordOverrides: [{ id: 'fixed-apple', meaning: '', partOfSpeech: '', isWrong: false, folderIds: [] }] });
    const apple = result.words.find(word => word.id === 'fixed-apple');
    assert.equal(apple.meaning, '');
    assert.equal(apple.partOfSpeech, '');
    assert.equal(apple.isWrong, false);
    assert.deepEqual(apple.tags, []);
    assert.deepEqual(apple.folderIds, []);
    assert.equal(apple.english, 'apple');
});

test('course removal persists a tag difference and preserves the word in other courses', () => {
    const h = harness();
    const before = merged(h);
    const after = clone(before);
    h.context.__word = after.words[0];
    after.words[0] = clone(h.run("removeWordFolderId(__word, '課程1')"));
    const changes = operations(h, before, after);
    assert.equal(changes.length, 1);
    assert.ok(changes[0].path.includes('/wordOverrides/'));
    assert.deepEqual(changes[0].data.removedTags, ['課程1']);
    assert.deepEqual(changes[0].data.addedTags, []);
    assert.equal(changes.some(change => change.path.includes('/deletedDefaults/')), false);
    const reloaded = merged(h, { wordOverrides: [{ ...changes[0].data, id: 'fixed-apple' }] });
    assert.deepEqual(reloaded.words[0].folderIds, ['課程2']);
});

test('public updates inherit through persisted sparse fields and tag differences', () => {
    const h = harness();
    const before = merged(h);
    const after = clone(before);
    after.words[0].meaning = 'my meaning';
    after.words[0].folderIds = ['課程2', '個人資料夾'];
    const changes = operations(h, before, after);
    const override = changes.find(change => change.path.includes('/wordOverrides/')).data;
    h.run(`
        defaultWordDatabase[0] = withWordFolderIds({ ...defaultWordDatabase[0], english: 'updated apple', partOfSpeech: 'verb' }, ['課程1', '課程2', '課程3']);
        defaultWordMap.set('fixed-apple', defaultWordDatabase[0]);
    `);
    const reloaded = merged(h, { wordOverrides: [{ ...override, id: 'fixed-apple' }] });
    assert.equal(reloaded.words[0].id, 'fixed-apple');
    assert.equal(reloaded.words[0].meaning, 'my meaning');
    assert.equal(reloaded.words[0].english, 'updated apple');
    assert.equal(reloaded.words[0].partOfSpeech, 'verb');
    assert.deepEqual(reloaded.words[0].folderIds, ['課程2', '課程3', '個人資料夾']);
});

test('hiding public words retains their overrides; deleting custom words deletes only their private record', () => {
    const h = harness();
    const before = merged(h, {
        wordOverrides: [{ id: 'fixed-apple', meaning: 'my meaning' }],
        customWords: [{ id: 'custom-one', english: 'custom', meaning: 'mine', folderIds: [] }]
    });
    const after = clone(before);
    after.words = after.words.filter(word => !['fixed-apple', 'custom-one'].includes(word.id));
    const changes = operations(h, before, after);
    assert.deepEqual(changes.filter(change => change.type === 'delete').map(change => change.path), ['users/data-owner/customWords/custom-one']);
    assert.equal(changes.find(change => change.path === 'users/data-owner/deletedDefaults/fixed-apple').data.deleted, true);
    assert.equal(changes.some(change => change.path.includes('/wordOverrides/')), false);
});

test('restoring default writes authoritative empty differences so retained aliases cannot resurrect old edits', () => {
    const h = harness();
    const oldAlias = { id: 'old-apple', meaning: 'old personal', folderIds: [] };
    const before = merged(h, { wordOverrides: [oldAlias], deletedDefaultIds: ['old-apple'] });
    const after = clone(h.run('createDefaultUserData()'));
    const changes = operations(h, before, after);
    const override = changes.find(change => change.path === 'users/data-owner/wordOverrides/fixed-apple').data;
    assert.equal(override.supersedesLegacyAliases, true);
    assert.equal(Object.hasOwn(override, 'meaning'), false);
    for (const id of ['fixed-apple', 'old-apple']) {
        assert.equal(changes.find(change => change.path === `users/data-owner/deletedDefaults/${id}`).data.deleted, false);
    }
    const reloaded = merged(h, { wordOverrides: [oldAlias, { ...override, id: 'fixed-apple' }] });
    assert.equal(reloaded.words[0].meaning, 'public apple');
    assert.deepEqual(reloaded.words[0].tags, ['課程1', '課程2']);
});

test('clearing a currently invisible tag or field difference is still persisted and restores future inheritance', () => {
    const h = harness();
    const before = merged(h, { wordOverrides: [{
        id: 'fixed-apple', schemaVersion: 2, tagDiffVersion: 2, supersedesLegacyAliases: true,
        meaning: 'public apple', addedTags: ['課程1'], removedTags: ['未來課程']
    }] });
    const after = clone(before);
    h.context.__apple = after.words[0];
    after.words[0] = clone(h.run(`(() => {
        const base = defaultWordMap.get('fixed-apple');
        let override = wordData.clearOverrideField(getDefaultOverrideFields(__apple, base), 'meaning');
        override = wordData.clearTagChange(override, '課程1');
        override = wordData.clearTagChange(override, '未來課程');
        return cloneWord({ ...wordData.applyOverride(base, override), _override: override });
    })()`));
    assert.equal(after.words[0].meaning, before.words[0].meaning);
    assert.deepEqual(after.words[0].folderIds, before.words[0].folderIds);
    const changes = operations(h, before, after);
    assert.equal(changes.length, 1);
    const override = changes[0].data;
    assert.equal(Object.hasOwn(override, 'meaning'), false);
    assert.deepEqual(override.addedTags, []);
    assert.deepEqual(override.removedTags, []);
    h.run(`
        defaultWordDatabase[0] = withWordFolderIds({ ...defaultWordDatabase[0], meaning: 'new public' }, ['課程2', '未來課程']);
        defaultWordMap.set('fixed-apple', defaultWordDatabase[0]);
    `);
    const reloaded = merged(h, { wordOverrides: [{ ...override, id: 'fixed-apple' }] });
    assert.equal(reloaded.words[0].meaning, 'new public');
    assert.deepEqual(reloaded.words[0].folderIds, ['課程2', '未來課程']);
});

test('unhiding a word restores its retained personal fields and tag differences', () => {
    const h = harness();
    const before = merged(h, { wordOverrides: [{ id: 'old-apple', meaning: 'personal hidden', folderIds: ['課程2'] }], deletedDefaultIds: ['old-apple'] });
    const after = clone(before);
    after.words.push(...after.hiddenWords);
    after.hiddenWords = [];
    const changes = operations(h, before, after);
    const override = changes.find(change => change.path === 'users/data-owner/wordOverrides/fixed-apple').data;
    assert.equal(override.meaning, 'personal hidden');
    assert.deepEqual(override.removedTags, ['課程1']);
    assert.ok(override.aliasMigrationBackup.length, 'restoring a hidden word must retain migration recovery data');
    assert.equal(changes.filter(change => change.path.includes('/deletedDefaults/') && change.data.deleted === false).length, 2);
});

test('legacy root migration preserves originals, personal same-English words, hidden state and newer subcollection data, then stops writing', async () => {
    const root = {
        words: [
            { defaultId: 'old-apple', english: 'apple', meaning: 'old root meaning', folderIds: ['課程1'] },
            { id: 'my-apple', source: 'custom', english: 'apple', meaning: 'personal separate word', folderIds: [] }
        ],
        folders: ['私人課程'], settings: { bgmEnabled: false }, deletedDefaults: ['fixed-banana']
    };
    const h = harness({
        'users/data-owner': root,
        'users/data-owner/wordOverrides/old-apple': { meaning: 'new subcollection meaning', folderIds: ['課程2'] }
    });
    const first = clone(await h.run('loadUserDiffData(__user)'));
    assert.equal(first.words.find(word => word.id === 'fixed-apple').meaning, 'new subcollection meaning');
    assert.deepEqual(first.words.find(word => word.id === 'fixed-apple').folderIds, ['課程2']);
    assert.equal(first.words.find(word => word.id === 'my-apple').source, 'custom');
    assert.equal(first.words.some(word => word.id === 'fixed-banana'), false);
    assert.equal(first.settings.bgmEnabled, false);
    assert.deepEqual(h.documents.get('users/data-owner').words, root.words);
    assert.deepEqual(h.documents.get('users/data-owner/wordOverrides/old-apple'), { meaning: 'new subcollection meaning', folderIds: ['課程2'] });
    assert.equal(h.documents.get('users/data-owner').legacySnapshotRetained, true);
    assert.ok(h.documents.get('users/data-owner/wordOverrides/fixed-apple').aliasMigrationBackup.length);
    const writeCount = h.writes.length;
    const second = clone(await h.run('loadUserDiffData(__user)'));
    assert.equal(h.writes.length, writeCount, 'repeated migration should make no writes');
    const visibleData = data => JSON.parse(JSON.stringify(data, (key, value) => key === 'updatedAt' ? undefined : value));
    assert.deepEqual(visibleData(second), visibleData(first));
});

test('Firestore document paths determine identity even when legacy payload contains a conflicting id', async () => {
    const h = harness({ 'users/data-owner/wordOverrides/fixed-apple': { id: 'fixed-banana', meaning: 'applies to apple' } });
    const result = clone(await h.run('loadUserDiffData(__user)'));
    assert.equal(result.words.find(word => word.id === 'fixed-apple').meaning, 'applies to apple');
    assert.equal(result.words.find(word => word.id === 'fixed-banana').meaning, 'public banana');
});
