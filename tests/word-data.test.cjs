'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../assets/word-data.js');
const { validateCatalogFiles } = require('../config/validate-words.cjs');
const base = () => data.normalizeCatalog([{
    id: 'fixed-id', english: 'apple', meaning: '蘋果', partOfSpeech: 'noun', isWrong: true,
    tags: ['Lesson 1', 'Lesson 2']
}])[0];
const modern = (fields = {}) => ({ schemaVersion: 2, tagDiffVersion: 2, addedTags: [], removedTags: [], ...fields });

test('public catalog is unique, complete, and compatible with every frozen historical ID', () => {
    assert.deepEqual(validateCatalogFiles(), { words: 429, memberships: 446, aliases: 17, legacyIds: 446 });
});

test('stored IDs survive English and tag changes', () => {
    const word = base();
    const changed = data.normalizeCatalog([{ ...word, english: 'renamed apple', tags: ['Renamed lesson'] }])[0];
    assert.equal(changed.id, 'fixed-id');
    assert.equal(changed.defaultId, 'fixed-id');
});

test('catalog rejects missing IDs, duplicate English, duplicate IDs and invalid tags', () => {
    assert.throws(() => data.normalizeCatalog([{ english: 'apple', meaning: '', tags: [] }]), /ID/);
    assert.throws(() => data.normalizeCatalog([base(), { ...base(), id: 'another', english: ' APPLE ' }]), /英文重複/);
    assert.throws(() => data.normalizeCatalog([base(), { ...base(), english: 'banana' }]), /ID 重複/);
    assert.throws(() => data.normalizeCatalog([{ ...base(), tags: ['Lesson 1', 'Lesson 1'] }]), /無效標籤/);
});

test('each field inherits independently; explicit empty strings and false remain overrides', () => {
    const override = modern({ meaning: '', partOfSpeech: '', isWrong: false });
    const merged = data.applyOverride(base(), override);
    assert.equal(merged.english, 'apple');
    assert.equal(merged.meaning, '');
    assert.equal(merged.partOfSpeech, '');
    assert.equal(merged.isWrong, false);
    const future = { ...base(), english: 'green apple', meaning: '公用新解釋' };
    assert.equal(data.applyOverride(future, override).english, 'green apple');
    assert.equal(data.applyOverride(future, override).meaning, '');
    assert.equal(data.applyOverride(future, data.clearOverrideField(override, 'meaning')).meaning, '公用新解釋');
});

test('prototype values are never personal overrides', () => {
    const override = Object.create({ meaning: 'inherited attacker value' });
    assert.equal(data.applyOverride(base(), override).meaning, '蘋果');
});

test('tag merging inherits new public tags, removes explicit ones and deduplicates', () => {
    const override = modern({ addedTags: ['Personal', 'Lesson 2', 'Personal'], removedTags: ['Lesson 1'] });
    const merged = data.applyOverride({ ...base(), tags: ['Lesson 1', 'Lesson 2', 'New lesson'] }, override);
    assert.deepEqual(merged.tags, ['Lesson 2', 'New lesson', 'Personal']);
    assert.deepEqual(merged.folderIds, merged.tags);
    assert.equal(merged.folderId, 'Lesson 2');
});

test('empty final tags are intentional and remain empty', () => {
    const override = data.updateOverride(base(), {}, { ...base(), folderIds: [] });
    assert.deepEqual(override.removedTags, ['Lesson 1', 'Lesson 2']);
    assert.deepEqual(data.applyOverride(base(), override).tags, []);
});

test('contradictory input diffs resolve to removal and never retain overlap', () => {
    assert.deepEqual(data.normalizeTagChanges({ addedTags: ['Lesson 1', 'Personal'], removedTags: ['Lesson 1'] }),
        { addedTags: ['Personal'], removedTags: ['Lesson 1'] });
});

test('adding a removed public tag and removing a personal addition cancel the corresponding diff', () => {
    const prior = modern({ addedTags: ['Personal'], removedTags: ['Lesson 1'] });
    const updated = data.updateOverride(base(), prior, { ...data.applyOverride(base(), prior), folderIds: ['Lesson 1', 'Lesson 2'] });
    assert.deepEqual(updated.addedTags, []);
    assert.deepEqual(updated.removedTags, []);
});

test('tag diff cancellation restores inheritance even if current public tags have changed', () => {
    const prior = modern({ addedTags: ['Personal'], removedTags: ['Later lesson'] });
    const withoutRemoval = data.clearTagChange(prior, 'Later lesson');
    assert.deepEqual(data.applyOverride({ ...base(), tags: ['Later lesson'] }, withoutRemoval).tags, ['Later lesson', 'Personal']);
    assert.deepEqual(data.clearTagChange(prior, 'Personal').addedTags, []);
});

test('unrelated edits preserve a removed tag while that tag is temporarily absent from public data', () => {
    const prior = modern({ removedTags: ['Lesson 1'] });
    const current = { ...base(), tags: ['Lesson 2'] };
    const before = data.applyOverride(current, prior);
    const after = data.updateOverride(current, prior, { ...before, meaning: '我的解釋' }, before);
    assert.deepEqual(after.removedTags, ['Lesson 1']);
    assert.deepEqual(data.applyOverride(base(), after).tags, ['Lesson 2']);
});

test('unrelated edits preserve explicit field override when the public value catches up', () => {
    const prior = modern({ meaning: '蘋果', isWrong: false });
    const before = data.applyOverride(base(), prior);
    const updated = data.updateOverride(base(), prior, { ...before, folderIds: [...before.folderIds, 'Personal'] }, before);
    assert.equal(updated.meaning, '蘋果');
    assert.equal(updated.isWrong, false);
    assert.equal(data.applyOverride({ ...base(), meaning: 'new public definition' }, updated).meaning, '蘋果');
});

test('legacy empty folder array removes historical tags and stores its original snapshot', () => {
    const raw = { id: 'fixed-id', folderIds: [], meaning: '' };
    const migrated = data.migrateOverride(base(), raw, { legacyBaseTags: ['Lesson 1'] });
    assert.deepEqual(migrated.removedTags, ['Lesson 1']);
    assert.deepEqual(migrated.folderIds, []);
    assert.deepEqual(migrated.legacyTagBackup.original, { folderIds: [] });
    assert.equal(migrated.legacyTagBackup.intentUncertain, true);
    assert.deepEqual(data.applyOverride(base(), migrated).tags, ['Lesson 2']);
    assert.deepEqual(raw, { id: 'fixed-id', folderIds: [], meaning: '' });
});

test('legacy migration is repeatable and public tags added after its frozen baseline inherit', () => {
    const raw = { id: 'fixed-id', folderIds: ['Personal'] };
    const options = { legacyBaseTags: ['Lesson 1'] };
    const migrated = data.migrateOverride(base(), raw, options);
    const future = { ...base(), tags: ['Lesson 1', 'Lesson 2', 'Lesson 3'] };
    assert.deepEqual(data.migrateOverride(future, migrated, options), migrated);
    assert.deepEqual(data.migrateOverride(future, raw, options), migrated);
    assert.deepEqual(data.applyOverride(future, migrated).tags, ['Lesson 2', 'Lesson 3', 'Personal']);
});

test('legacy folderId/tags compatibility preserves explicit false and converts review marker only once', () => {
    assert.deepEqual(data.migrateOverride(base(), { folderId: 'Personal' }).addedTags, ['Personal']);
    assert.deepEqual(data.migrateOverride(base(), { tags: [] }).removedTags, ['Lesson 1', 'Lesson 2']);
    assert.equal(data.migrateOverride(base(), { tags: ['錯題區'], isWrong: false }).isWrong, false);
    const migrated = data.migrateOverride(base(), { tags: ['錯題區', 'Lesson 1'] });
    assert.equal(migrated.isWrong, true);
    const cleared = data.clearOverrideField(migrated, 'isWrong');
    assert.equal(data.applyOverride({ ...base(), isWrong: false }, cleared).isWrong, false);
    assert.deepEqual(data.normalizeTags(['錯題區', '未分類', 'A', ' lesson ', 'lesson']), ['lesson']);
});

test('alias field conflicts use latest update, preserve all originals, and newer snapshots cancel older removal', () => {
    const aliases = { aliases: { old: 'fixed-id' }, legacyTagsById: { old: ['Lesson 1'], 'fixed-id': ['Lesson 1', 'Lesson 2'] } };
    const records = [
        { id: 'old', meaning: 'older', folderIds: [], unknown: { recover: true }, updatedAt: 1 },
        { id: 'fixed-id', meaning: 'newer', folderIds: ['Lesson 1', 'Lesson 2'], updatedAt: 2 }
    ];
    const merged = data.coalesceOverrides(base(), records, aliases);
    assert.equal(merged.meaning, 'newer');
    assert.deepEqual(merged.removedTags, []);
    assert.deepEqual(merged.aliasMigrationBackup, records);
    assert.equal(merged.supersedesLegacyAliases, true);
});

test('authoritative empty canonical document prevents retained alias data resurrecting after reset', () => {
    const aliases = { aliases: { old: 'fixed-id' } };
    const reset = modern({ id: 'fixed-id', supersedesLegacyAliases: true });
    const merged = data.coalesceOverrides(base(), [{ id: 'old', meaning: 'old private edit', updatedAt: 999 }, reset], aliases);
    assert.equal(data.applyOverride(base(), merged).meaning, '蘋果');
    assert.equal(data.hasPersonalChanges(merged), false);
});

test('single record unknown metadata is recoverable and migration does not grow on repeated reads', () => {
    const raw = { id: 'fixed-id', meaning: '', oldFeature: { draft: ['keep me'] } };
    const merged = data.coalesceOverrides(base(), [raw]);
    assert.deepEqual(merged.migrationBackup, raw);
    assert.deepEqual(data.coalesceOverrides(base(), [merged]), merged);
});

test('alias cycles fail explicitly', () => {
    assert.throws(() => data.resolveId('one', { one: 'two', two: 'one' }), /循環/);
});
