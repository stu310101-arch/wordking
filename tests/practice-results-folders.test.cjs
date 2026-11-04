'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAppHarness, createMemoryFirestore } = require('./helpers/app-harness.cjs');

function setup() {
    const cloud = createMemoryFirestore({
        'users/A': { schemaVersion: 6, revision: 0, migrationV6: { status: 'complete' } }
    });
    const h = createAppHarness({ firebase: cloud.firebase });
    h.elements.get('spelling-progress-bar').style = {};
    h.elements.get('choice-progress-bar').style = {};
    h.run(`
        publicCatalog = wordData.normalizeCatalog([
            { id: 'w_000001', english: 'apple', meanings: M('蘋果'), lessonIds: ['U1'] },
            { id: 'w_000002', english: 'banana', meanings: M('香蕉'), lessonIds: ['U1'] },
            { id: 'w_000003', english: 'cherry', meanings: M('櫻桃'), lessonIds: ['U1'] },
            { id: 'w_000004', english: 'date', meanings: M('椰棗'), lessonIds: ['U1'] },
            { id: 'w_000005', english: 'elderberry', meanings: M('接骨木莓'), lessonIds: ['U1'] }
        ]);
        currentUser = { uid: 'A' };
        authReady = true;
        isUserDataReady = true;
        applyUserData({ snapshot: {
            userFolders: { f: { name: '常用' } },
            userOverrides: {
                w_000001: { folderIds: ['f'] },
                w_000002: { folderIds: ['f'] }
            }
        } });
    `);
    return { h, cloud, el: id => h.elements.get(id) };
}

test('English-Chinese and Chinese-English choices can both be skipped and recorded as wrong', () => {
    for (const mode of ['choice-en-ch', 'choice-ch-en']) {
        const { h, el } = setup();
        h.run(`startGame('${mode}');skipChoiceWord();`);
        assert.equal(h.run('state.game.answeredHistory[0].result'), 'skipped');
        assert.equal(h.run('state.game.wrongWords.size'), 1);
        assert.equal(h.run('state.game.reviewSelection.length'), 0);
        assert.equal(el('btn-choice-skip').disabled, true);
        assert.equal(h.run('state.game.answeredHistory[0].choices.length'), 5);
        assert.equal(h.run('state.game.answeredHistory[0].choices.some(c => c.isSelected)'), false);
        const current = h.run('state.game.currentWords[0].english');
        const answer = h.run('state.game.answeredHistory[0].correctAnswer');
        if (mode === 'choice-ch-en') assert.equal(answer, current);
        else assert.notEqual(answer, current);
        h.run('showHistoryEntry(0);skipChoiceWord();');
        assert.equal(h.run('state.game.answeredHistory.length'), 1);
    }
});

test('settlement separates correct answers from skipped or wrong and permits bulk selection of either group', () => {
    const { h, el } = setup();
    h.run(`
        state.game.currentWords = state.words.slice(0, 3);
        state.game.mode = 'choice-ch-en';
        state.game.answeredHistory = [
            createAnswerRecord({ word: state.words[0], result: 'correct' }),
            createAnswerRecord({ word: state.words[1], result: 'skipped' }),
            createAnswerRecord({ word: state.words[2], result: 'correct' })
        ];
        state.game.wrongWords = new Set([state.words[1]]);
        endGame();
    `);
    assert.equal(el('result-skipped-items').children.length, 1);
    assert.equal(el('result-correct-items').children.length, 2);
    assert.equal(h.run('state.game.reviewSelection.length'), 1);
    assert.equal(el('result-correct-stat').innerText, '答對：2 個');

    h.run("changeResultWordSelection('correct', true)");
    assert.equal(h.run('state.game.reviewSelection.length'), 3);
    h.run("changeResultWordSelection('wrong', false)");
    assert.deepEqual(Array.from(h.run('state.game.reviewSelection.map(getWordKey)')), ['w_000001','w_000003']);
    h.run("openAddModal = idx => { window.openedIndex = idx; };openResultWordEditor('w_000003')");
    assert.equal(h.context.window.openedIndex, 2);
});

test('settlement folder browser opens a folder, supports select-all, and removes only its membership', async () => {
    const { h, el, cloud } = setup();
    h.run("state.game.currentWords = state.words.slice(0, 2);endGame()");
    el('result-remove-folder-select').value = 'folder:f';
    h.run('openResultRemovalFolder()');
    assert.equal(el('result-remove-items').children.length, 2);
    assert.equal(h.run('state.game.removeSelection.size'), 0);
    h.run('selectAllResultRemovalWords(true)');
    assert.equal(h.run('state.game.removeSelection.size'), 2);
    await h.run('removeResultWordsFromFolder()');
    assert.equal(h.run("state.words.filter(w => getWordGroupIds(w).includes('folder:f')).length"), 0);
    assert.equal(h.run("state.words.filter(w => getWordGroupIds(w).includes('lesson:U1')).length"), 5);
    assert.equal(el('result-remove-items').children.length, 1); // empty-state hint
    assert.ok(cloud.writes.some(write => write.path.includes('/wordOverrides/')));
});

test('library folder opens to bulk selection and removal while preserving every other course', async () => {
    const { h, el } = setup();
    h.run("openLibraryFolder('folder:f');selectAllLibraryWords(true)");
    assert.equal(h.run('state.librarySelectedWordIds.size'), 2);
    assert.equal(el('library-selected-count').textContent, '已選 2 個');
    await h.run('removeSelectedLibraryWords()');
    assert.equal(h.run('state.librarySelectedWordIds.size'), 0);
    assert.equal(h.run("state.words.filter(w => wordIsInFolder(w, 'folder:f')).length"), 0);
    assert.equal(h.run("state.words.filter(w => wordIsInFolder(w, 'lesson:U1')).length"), 5);
});
