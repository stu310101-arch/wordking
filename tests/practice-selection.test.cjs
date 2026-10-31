'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createAppHarness} = require('./helpers/app-harness.cjs');

const series = 'series:shishen-lv5', u12 = 'lesson:死神單字L5U12', u13 = 'lesson:死神單字L5U13';
const extra = 'folder:extra';

function setup() {
    const h = createAppHarness();
    // Exercise the registered UI handlers with the harness' DOM elements.
    h.run(`
        const makeElement = document.createElement;
        const watch = element => {
            element.addEventListener = (name, handler) => { element['on' + name] = handler; };
            return element;
        };
        document.createElement = tag => watch(makeElement(tag));
        ['practice-focus', 'btn-practice-exclude-review', 'btn-practice-select-all', 'btn-practice-select-none']
            .forEach(id => watch(document.getElementById(id)));
        for (const mode of ['spelling', 'choice']) document.getElementById(mode + '-progress-bar').style = {};
        bindStaticEvents();
        const courses = [['死神單字L5U12'], ['死神單字L5U12', '死神單字L5U13'], ['死神單字L5U13'], [], [], []];
        publicCatalog = wordData.normalizeCatalog(courses.map((lessonIds, i) => ({
            id: 'w_00000' + (i + 1), english: 'word' + (i + 1), meanings: M('義' + i), lessonIds
        })));
        const account = {userFolders: {extra: {name: '自選'}}, userOverrides: {
            w_000003: {isWrong: true}, w_000004: {folderIds: ['extra']}, w_000005: {folderIds: ['extra'], isWrong: true}
        }};
        applyUserData({snapshot: account});
        renderPracticeOptions();
    `);
    const el = id => h.elements.get(id);
    const select = (container, selector, match, checked) => {
        const input = el(container).querySelectorAll(selector).find(match);
        assert.ok(input, 'rendered checkbox exists');
        input.checked = checked;
        input.onchange();
    };
    return {
        h, el,
        scope: (key, checked = true) => select('practice-scope', '.practice-scope-checkbox', cb => cb.value === key, checked),
        word: (index, checked) => select('practice-word-selection', '.practice-checkbox', cb => cb.dataset.wordId === 'w_00000' + index, checked),
        focus: key => { el('practice-focus').value = key; el('practice-focus').onchange({target: el('practice-focus')}); },
        picks: () => Array.from(h.run('getSelectedPracticeWords().map(word => word.english)')),
        shown: () => el('practice-word-selection').querySelectorAll('.practice-checkbox').map(cb => [cb.dataset.wordId.slice(-1), cb.checked])
    };
}

test('practice combines selected folders by ID and remembers individual choices on focus, overlap and scope changes', () => {
    const p = setup();
    assert.equal(p.picks().length, 6);
    p.scope(u12);
    p.word(2, false);
    p.scope(u13);
    assert.deepEqual(p.shown(), [['2', false], ['3', true]]);
    assert.deepEqual(p.picks(), ['word1', 'word3']);
    p.focus(u12);
    assert.deepEqual(p.shown(), [['1', true], ['2', false]]);
    p.word(2, true);
    p.focus('');
    assert.deepEqual(p.shown(), [['1', true], ['2', true], ['3', true]]);
    assert.equal(p.el('selection-count').innerText, '合計已選 3 個單字');
    p.scope(u12, false);
    assert.deepEqual(p.picks(), ['word2', 'word3']);
    p.scope(series);
    assert.deepEqual(p.picks(), ['word1', 'word2', 'word3']);
    p.scope(u13, false);
    assert.deepEqual(p.picks(), ['word1', 'word2', 'word3']);
    p.scope(series, false);
    assert.deepEqual(p.picks(), []);
});

test('folder-specific bulk actions update shared checks once and both choice directions and spelling test exactly the picks', () => {
    const p = setup();
    p.scope(u13);
    p.scope(extra);
    p.el('btn-practice-select-none').onclick();
    p.word(4, true);
    p.focus(u13);
    p.el('btn-practice-exclude-review').onclick();
    assert.deepEqual(p.picks(), ['word2', 'word4']);
    p.el('btn-practice-select-all').onclick();
    assert.deepEqual(p.picks(), ['word2', 'word3', 'word4']);
    p.focus('');
    p.el('btn-practice-exclude-review').onclick();
    assert.deepEqual(p.picks(), ['word2', 'word4']);
    for (const mode of ['spelling', 'choice-en-ch', 'choice-ch-en']) {
        p.h.context.__mode = mode;
        p.h.run('startGame(__mode)');
        assert.deepEqual(Array.from(p.h.run('state.game.currentWords.map(w => w.english).sort()')), ['word2', 'word4']);
        assert.equal(p.h.run('state.game.mode'), mode);
        if (mode !== 'spelling') assert.equal(p.h.run('state.game.currentChoiceOptions.length'), 5);
    }
});

test('all, review and unfiled scopes, same-account reload and account switch retain the right isolation', () => {
    const p = setup();
    p.scope('錯題區');
    assert.deepEqual(p.picks(), ['word3', 'word5']);
    p.scope('未分類');
    assert.deepEqual(p.picks(), ['word3', 'word5', 'word6']);
    p.scope('all');
    p.word(1, false);
    p.scope(extra);
    p.word(4, false);
    p.h.run('applyUserData({snapshot: account});renderPracticeOptions();');
    assert.deepEqual(p.picks(), ['word5']);
    p.h.run('applyUserData({snapshot: {}});renderPracticeOptions();');
    assert.deepEqual(p.picks(), []);
    p.h.run('clearPersonalSessionData();applyUserData({snapshot: {}});renderPracticeOptions();');
    assert.equal(p.picks().length, 6);
});
