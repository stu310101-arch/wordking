const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const data = require('../assets/word-data.js');

const catalog = [{ id: 'w_000001', english: 'record', meanings: [{ partOfSpeech: 'noun', definitions: ['紀錄'] }], lessonIds: ['lesson-1'] }];
const state = () => data.createUserWordState(catalog);
const invalid = operation => assert.throws(operation, { code: 'INVALID_DATA' });

test('plain JSON from another realm and null-prototype maps remain supported and detached', () => {
    const initial = runInNewContext('({ settings: { legacyOption: { enabled: true } }, customWords: { c_one: { english: "custom", meanings: [] } } })');
    const model = data.createUserWordState(catalog, initial);
    const folder = Object.assign(Object.create(null), { name: 'Personal' });
    model.setFolder('f_one', folder);
    initial.settings.legacyOption.enabled = false;
    folder.name = 'Changed outside model';
    assert.deepEqual(model.getSettings(), { legacyOption: { enabled: true } });
    assert.deepEqual(model.getUserFolder('f_one'), { name: 'Personal' });
    assert.equal(model.getEffectiveWord('c_one').english, 'custom');
});

test('inherited required fields and class instances cannot bypass canonical allowlists', () => {
    const model = state();
    class Settings { constructor() { this.bgmEnabled = false; } }
    const nullPrototypeParent = Object.assign(Object.create(null), { english: 'inherited' });
    const fakePlainParent = Object.assign(Object.create(null), { english: 'inherited', constructor: Object });
    const operations = [
        () => model.createCustomWord('c_inherited', Object.create({ english: 'inherited' })),
        () => model.createCustomWord('c_null_parent', Object.create(nullPrototypeParent)),
        () => model.createCustomWord('c_fake_parent', Object.create(fakePlainParent)),
        () => model.createCustomWord(Object.assign(Object.create({ id: 'c_inherited' }), { english: 'custom' })),
        () => model.setFolder('f_inherited', Object.create({ name: 'inherited' })),
        () => model.updateWordOverride('w_000001', { meanings: [Object.create({ partOfSpeech: 'verb', definitions: ['inherited'] })] }),
        () => model.setSettings(new Settings()),
        () => model.setSettings({ nested: Object.create({ injected: true }) }),
        () => model.setSettings({ nested: new Date() })
    ];
    for (const operation of operations) {
        const before = model.exportState();
        invalid(operation);
        assert.deepEqual(model.exportState(), before, 'validation failure must not partially change account state');
    }
});

test('unsafe JSON keys are rejected at every nesting level without affecting other accounts', () => {
    const first = state(), second = state();
    first.setSettings({ theme: 'dark' });
    for (const key of ['__proto__', 'constructor', 'prototype']) {
        for (const patch of [
            JSON.parse(`{"${key}":{"polluted":true}}`),
            JSON.parse(`{"nested":[{"${key}":{"polluted":true}}]}`)
        ]) {
            invalid(() => first.setSettings(patch));
            assert.deepEqual(first.getSettings(), { theme: 'dark' });
            assert.deepEqual(second.getSettings(), {});
            assert.equal({}.polluted, undefined);
        }
    }
});

test('malformed values fail before mutation while existing long text and unknown safe settings survive', () => {
    const model = state();
    const longText = '既有定義'.repeat(2000);
    model.createCustomWord('c_long', { english: 'long '.repeat(150).trim(), meanings: [{ partOfSpeech: 'verb', definitions: [longText] }] });
    model.setSettings({ legacyOption: { values: [null, true, 'keep', 1] } });
    const before = model.exportState();
    for (const patch of [
        { meanings: [{ partOfSpeech: 'verb', definitions: [false] }] },
        { meanings: [{ partOfSpeech: 'unknown', definitions: ['meaning'] }] },
        { meanings: [{ partOfSpeech: 'noun', definitions: [] }, { partOfSpeech: 'noun', definitions: [] }] },
        { lessonIds: ['valid', {}] }, { folderIds: ['constructor'] }, { isWrong: 'false' }
    ]) {
        invalid(() => model.updateCustomWord('c_long', patch));
        assert.deepEqual(model.exportState(), before);
    }
    assert.equal(model.getEffectiveWord('c_long').meanings[0].definitions[0], longText);
    assert.deepEqual(model.getSettings(), before.settings);
});
