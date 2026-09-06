'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const data = require('../assets/word-data.js');

function validateCatalogFiles(root = path.resolve(__dirname, '..')) {
    const read = file => fs.readFileSync(path.join(root, file));
    const json = file => JSON.parse(read(file).toString('utf8').replace(/^\uFEFF/, ''));
    const words = data.normalizeCatalog(json('data/words.json'));
    for (const word of words) assert.ok(!/[（(]\s*(?:n|v|vi|vt|a|adj|adv|pron|prep|conj|interj|det|art|num|aux|phr)\.\s*[)）]/i.test(word.meaning),
        `Move the legacy POS annotation into partOfSpeech: ${word.id}`);
    const mapping = json('migration/legacy-word-id-map.json');
    const baseline = json('migration/legacy-tag-baseline.json');
    const original = json('migration/legacy-catalog.json');
    const oldAliases = json('migration/legacy-word-id-aliases.json');
    const frozen = json('migration/frozen-sources.json');
    const manifest = json('migration/legacy-lessons/manifest.json');
    assert.equal(mapping.schemaVersion, 5, 'ID mapping schema');
    assert.equal(baseline.schemaVersion, 5, 'Tag baseline schema');
    assert.equal(frozen.schemaVersion, 5, 'Frozen checksum schema');
    assert.equal(original.length, 429, 'Frozen public entities');
    assert.equal(original.reduce((n, word) => n + word.tags.length, 0), 446, 'Frozen memberships');
    assert.equal(Object.keys(oldAliases.aliases).length, 17, 'Frozen course aliases');
    assert.equal(Object.keys(oldAliases.legacyTagsById).length, 446, 'Frozen source IDs');
    assert.deepEqual(mapping.previousAliases, oldAliases.aliases, 'All 17 original aliases must survive');
    assert.deepEqual(mapping.allocation, { lastAllocatedId: 'w_000429', nextId: 'w_000430' }, 'Frozen initial allocation');
    assert.equal(manifest.lessons.length, 9, 'Frozen lesson count');
    const lessonFiles = manifest.lessons.map(lesson => lesson.file);
    assert.deepEqual(fs.readdirSync(path.join(root, 'migration/legacy-lessons')).sort(),
        ['manifest.json', ...lessonFiles].sort(), 'All original lesson files are preserved');
    const historicalRows = [];
    for (const lesson of manifest.lessons) {
        assert.equal(path.basename(lesson.file), lesson.file, 'Lesson path must be a filename');
        const file = json(`migration/legacy-lessons/${lesson.file}`);
        assert.equal(file.id, lesson.id);
        assert.equal(file.title, lesson.title);
        for (const word of file.words) {
            assert.ok(word.tags.includes(file.id), `Missing source membership: ${word.english}`);
            historicalRows.push(word);
        }
    }
    assert.equal(historicalRows.length, 429);
    const originalByEnglish = new Map(original.map(word => [word.english, word]));
    for (const word of historicalRows) {
        const publicWord = originalByEnglish.get(word.english);
        assert.ok(publicWord, `Historical entity missing: ${word.english}`);
        assert.equal(publicWord.meaning, word.meaning);
        assert.deepEqual(publicWord.tags, word.tags);
    }
    const ids = new Set(words.map(word => word.id));
    // Allocation is verified against frozen sources, never the order or text of live words.
    const allocated = new Map(original.map((word, i) => [word.id, `w_${String(i + 1).padStart(6, '0')}`]));
    const expectedMap = {}, expectedBaseline = {};
    for (const [oldId, tags] of Object.entries(oldAliases.legacyTagsById)) {
        const target = allocated.get(oldAliases.aliases[oldId] || oldId);
        assert.ok(target && ids.has(target), `Historical entity lost: ${oldId}`);
        assert.ok(Array.isArray(tags) && tags.every(tag => typeof tag === 'string' && tag === tag.trim() && tag));
        assert.equal(new Set(tags).size, tags.length);
        for (const key of [oldId, decodeURIComponent(oldId)]) {
            expectedMap[key] = target;
            expectedBaseline[key] = tags;
        }
    }
    assert.deepEqual(mapping.aliases, expectedMap, 'Every encoded/decoded ID must retain its one-time target');
    assert.deepEqual(baseline.legacyTagsById, expectedBaseline, 'Do not recalculate historical baselines');
    const frozenFiles = ['legacy-catalog.json', 'legacy-word-id-aliases.json', 'legacy-word-id-map.json',
        'legacy-tag-baseline.json', ...['manifest.json', ...lessonFiles].map(file => `legacy-lessons/${file}`)];
    assert.deepEqual(Object.keys(frozen.sha256).sort(), frozenFiles.sort(), 'Frozen source inventory');
    for (const file of frozenFiles) {
        const actual = crypto.createHash('sha256').update(read(`migration/${file}`)).digest('hex');
        assert.equal(actual, frozen.sha256[file], `Frozen source bytes changed: ${file}`);
    }
    assert.equal(fs.existsSync(path.join(root, 'data/word-id-aliases.json')), false, 'Runtime aliases must be removed');
    assert.equal(fs.existsSync(path.join(root, 'data/lessons')), false, 'Historical lessons belong under migration');
    return { words: words.length, memberships: words.reduce((count, word) => count + word.lessonIds.length, 0),
        aliases: 17, legacyIds: 446, mappedIds: Object.keys(mapping.aliases).length,
        lessonFiles: lessonFiles.length, frozenFiles: frozenFiles.length };
}

if (require.main === module) {
    try { console.log(`Public catalog validated: ${JSON.stringify(validateCatalogFiles())}`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { validateCatalogFiles };
