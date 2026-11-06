'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createAppHarness} = require('./helpers/app-harness.cjs');

const series = 'series:shishen-lv5', u12 = 'lesson:死神單字L5U12', u13 = 'lesson:死神單字L5U13';
const extra = 'folder:extra', nested = 'folder:nested', deep = 'folder:deep', empty = 'folder:empty';

function setup() {
    const h = createAppHarness();
    // Exercise the actual registered event handlers using the lightweight DOM harness.
    h.run(`
        const makeElement = document.createElement;
        const watch = element => {
            element.addEventListener = (name, handler) => { element['on' + name] = handler; };
            return element;
        };
        document.createElement = tag => watch(makeElement(tag));
        ['practice-select-all', 'btn-practice-exclude-review', 'btn-practice-back']
            .forEach(id => watch(document.getElementById(id)));
        const startButtons = ['spelling', 'choice-en-ch', 'choice-ch-en'].map(mode => {
            const button = watch(document.getElementById('start-' + mode));
            button.dataset.startMode = mode;
            return button;
        });
        const queryAll = document.querySelectorAll;
        document.querySelectorAll = selector => selector === '#view-practice [data-start-mode]' ? startButtons : queryAll(selector);
        for (const mode of ['spelling', 'choice']) document.getElementById(mode + '-progress-bar').style = {};
        bindStaticEvents();
        const courses = [['死神單字L5U12'], ['死神單字L5U12', '死神單字L5U13'], ['死神單字L5U13'], [], [], [], [], []];
        publicCatalog = wordData.normalizeCatalog(courses.map((lessonIds, i) => ({
            id: 'w_00000' + (i + 1), english: 'word' + (i + 1), meanings: M('義' + i), lessonIds
        })));
        const account = {
            userFolders: {extra: {name: '自選'}, nested: {name: '延伸練習'}, deep: {name: '第三層'}, empty: {name: '空資料夾'}},
            settings: {folderParents: {'folder:nested': 'lesson:死神單字L5U12', 'folder:deep': 'folder:nested'}},
            userOverrides: {
                w_000003: {isWrong: true}, w_000004: {folderIds: ['extra']}, w_000005: {folderIds: ['extra'], isWrong: true},
                w_000007: {folderIds: ['nested']}, w_000008: {folderIds: ['deep']}
            }
        };
        applyUserData({snapshot: account});
        renderPracticeOptions();
    `);
    const el = id => h.elements.get(id);
    const select = (input, checked) => {
        assert.ok(input, 'rendered checkbox exists');
        input.checked = checked;
        input.onchange({target: input});
    };
    const scopes = () => el('practice-scope').querySelectorAll('.practice-scope-checkbox');
    const scopeInput = key => scopes().find(input => input.value === key);
    return {
        h, el, scopeInput,
        children: () => scopes().map(input => input.value),
        scope: (key, checked = true) => select(scopeInput(key), checked),
        all: (checked = true) => select(el('practice-select-all'), checked),
        open: key => {
            const button = el('practice-scope').querySelectorAll('.practice-folder-open').find(button => button.dataset.folderKey === key);
            assert.ok(button, 'only an immediate child can be opened');
            button.onclick();
        },
        back: () => el('btn-practice-back').onclick(),
        word: (index, checked) => select(el('practice-word-selection').querySelectorAll('.practice-checkbox').find(cb => cb.dataset.wordId === 'w_00000' + index), checked),
        picks: () => Array.from(h.run('getSelectedPracticeWords().map(word => word.english)')),
        shown: () => el('practice-word-selection').querySelectorAll('.practice-checkbox').map(cb => [cb.dataset.wordId.slice(-1), cb.checked])
    };
}

test('practice browses only immediate children and direct words, with breadcrumbs and back independent of selection', () => {
    const p = setup();
    assert.deepEqual(p.picks(), []);
    assert.equal(p.el('start-spelling').disabled, true);
    assert.ok(p.children().includes(series));
    assert.ok(!p.children().includes(u12));
    assert.ok(!p.children().includes(nested));
    assert.equal(p.el('practice-word-section').hidden, true);
    p.open(series);
    assert.ok(p.children().includes(u12));
    assert.ok(!p.children().includes(nested));
    assert.deepEqual(p.shown(), []);
    p.open(u12);
    assert.deepEqual(p.children(), [nested]);
    assert.deepEqual(p.shown(), [['1', false], ['2', false]]);
    assert.deepEqual(p.el('practice-breadcrumb').children.map(node => node.textContent),
        ['全部資料夾', '›', '死神單字Lv5', '›', '死神單字Lv5U12']);
    p.open(nested);
    assert.deepEqual(p.children(), [deep]);
    assert.deepEqual(p.shown(), [['7', false]]);
    p.back();
    assert.equal(p.h.run('currentPracticeFolder'), u12);
    p.el('practice-breadcrumb').children[0].onclick();
    assert.equal(p.h.run('currentPracticeFolder'), '');
    assert.deepEqual(p.picks(), []);
});

test('subtree selection includes all descendants, shows mixed state and keeps separate folder selections', () => {
    const p = setup();
    p.scope(series);
    assert.deepEqual(p.picks(), ['word1', 'word2', 'word3', 'word7', 'word8']);
    assert.equal(p.scopeInput(series).checked, true);
    p.open(series);
    p.open(u12);
    assert.equal(p.el('practice-select-all').checked, true);
    p.word(2, false);
    assert.equal(p.el('practice-select-all').indeterminate, true);
    assert.equal(p.el('practice-select-all').getAttribute('aria-checked'), 'mixed');
    p.back();
    assert.equal(p.scopeInput(u12).indeterminate, true);
    assert.equal(p.scopeInput(u13).indeterminate, true);
    p.scope(u12, false);
    assert.deepEqual(p.picks(), ['word3']);
    p.scope(u12);
    p.back();
    p.scope(extra);
    p.open(extra);
    p.word(4, false);
    assert.deepEqual(p.picks(), ['word1', 'word2', 'word3', 'word5', 'word7', 'word8']);
    assert.equal(p.el('selection-count').innerText, '合計已選 6 個單字');
    p.back();
    assert.equal(p.el('practice-select-all').indeterminate, true);
    p.all();
    assert.equal(p.picks().length, 8);
    p.all(false);
    assert.deepEqual(p.picks(), []);
    assert.equal(p.el('start-choice-en-ch').disabled, true);
});

test('shared word checks stay in sync across lessons and all three game modes use exactly the chosen IDs', () => {
    const p = setup();
    p.open(series);
    p.scope(u12);
    p.scope(u13);
    p.open(u12);
    p.word(2, false);
    p.back();
    p.open(u13);
    assert.deepEqual(p.shown(), [['2', false], ['3', true]]);
    p.word(2, true);
    p.word(3, false);
    const expected = ['word1', 'word2', 'word7', 'word8'];
    assert.deepEqual(p.picks(), expected);
    for (const mode of ['spelling', 'choice-en-ch', 'choice-ch-en']) {
        assert.equal(p.el('start-' + mode).disabled, false);
        p.el('start-' + mode).onclick();
        assert.deepEqual(Array.from(p.h.run('state.game.currentWords.map(word => word.english).sort()')), expected);
        assert.equal(p.h.run('state.game.mode'), mode);
        if (mode !== 'spelling') assert.equal(p.h.run('state.game.currentChoiceOptions.length'), 5);
    }
});

test('review exclusion and select-all apply to the open subtree without changing other selected folders', () => {
    const p = setup();
    p.scope(series);
    p.scope(extra);
    p.open(series);
    p.el('btn-practice-exclude-review').onclick();
    assert.deepEqual(p.picks(), ['word1', 'word2', 'word4', 'word5', 'word7', 'word8']);
    assert.equal(p.el('btn-practice-exclude-review').disabled, true);
    p.all();
    assert.ok(p.picks().includes('word3'));
    p.all(false);
    assert.deepEqual(p.picks(), ['word4', 'word5']);
    p.back();
    p.open('錯題區');
    assert.deepEqual(p.shown(), [['3', false], ['5', true]]);
    p.all();
    assert.deepEqual(p.picks(), ['word3', 'word4', 'word5']);
    p.back();
    p.open('未分類');
    assert.deepEqual(p.shown(), [['6', false]]);
    p.word(6, true);
    assert.deepEqual(p.picks(), ['word3', 'word4', 'word5', 'word6']);
});

test('empty folders remain navigable, and a deleted or invalid path returns safely to the root', () => {
    const p = setup();
    assert.equal(p.scopeInput(empty).disabled, true);
    p.open(empty);
    assert.equal(p.el('practice-select-all').disabled, true);
    assert.deepEqual(p.shown(), []);
    assert.equal(p.el('practice-word-selection').children[0].textContent, '這個資料夾還沒有單字。');
    p.h.run('applyUserData({snapshot: {}});renderPracticeOptions();');
    assert.equal(p.h.run('currentPracticeFolder'), '');
    assert.equal(p.h.run("openPracticeFolder('folder:missing')"), false);
    assert.deepEqual(p.picks(), []);
});

test('same-account refresh preserves valid picks, prunes hidden words, and account reset clears private selections and paths', () => {
    const p = setup();
    p.scope(extra);
    p.open(extra);
    p.h.run('applyUserData({snapshot: account});renderPracticeOptions();');
    assert.deepEqual(p.picks(), ['word4', 'word5']);
    assert.equal(p.h.run('currentPracticeFolder'), extra);
    p.h.run("applyUserData({snapshot: {...account, hiddenWordIds: ['w_000004']}});renderPracticeOptions();");
    assert.deepEqual(p.picks(), ['word5']);
    p.h.run('applyUserData({snapshot: account});renderPracticeOptions();');
    assert.deepEqual(p.shown(), [['4', false], ['5', true]]);
    p.h.run('clearPersonalSessionData();applyUserData({snapshot: {}});renderPracticeOptions();');
    assert.deepEqual(p.picks(), []);
    assert.equal(p.h.run('currentPracticeFolder'), '');
    assert.ok(!p.children().includes(extra));
    assert.deepEqual(p.el('practice-breadcrumb').children.map(node => node.textContent), ['全部資料夾']);
});
