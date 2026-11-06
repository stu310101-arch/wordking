'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createAppHarness} = require('./helpers/app-harness.cjs');

function setup(mode) {
    const h = createAppHarness();
    const timers = [];
    h.context.setTimeout = (callback, delay) => {
        timers.push({callback, delay});
        return timers.length;
    };
    h.context.clearTimeout = id => { if (timers[id - 1]) timers[id - 1].cancelled = true; };
    h.run(`
        const makeElement = document.createElement;
        const watch = element => {
            element.addEventListener = (name, handler) => { element['on' + name] = handler; };
            return element;
        };
        document.createElement = tag => watch(makeElement(tag));
        ['btn-spelling-submit', 'btn-spelling-skip', 'btn-choice-skip', 'spelling-input']
            .forEach(id => watch(document.getElementById(id)));
        const queryAll = document.querySelectorAll;
        document.querySelectorAll = selector => selector === '#choice-options button' || selector === '.choice-btn'
            ? document.getElementById('choice-options').children
            : queryAll(selector);
        document.getElementById('spelling-input').parentElement = document.createElement('div');
        for (const prefix of ['spelling', 'choice']) document.getElementById(prefix + '-progress-bar').style = {};
        bindStaticEvents();
        publicCatalog = wordData.normalizeCatalog(['apple', 'banana', 'cherry', 'dragon', 'eagle'].map((english, i) => ({
            id: 'w_00000' + (i + 1), english, meanings: M('義' + i), lessonIds: ['測試課程']
        })));
        applyUserData({snapshot: {}});
        renderPracticeOptions();
        toggleAllPracticeWords(true);
    `);
    h.run(`startGame(${JSON.stringify(mode)});`);
    const el = id => h.elements.get(id);
    const skip = () => el(mode === 'spelling' ? 'btn-spelling-skip' : 'btn-choice-skip').onclick();
    const answer = () => {
        if (mode === 'spelling') {
            el('spelling-input').value = h.run('getCurrentWord().english');
            el('btn-spelling-submit').onclick();
        } else {
            const correct = h.run('state.game.currentChoiceOptions.indexOf(getCurrentWord())');
            el('choice-options').children[correct].onclick();
        }
    };
    const advance = () => {
        const timer = timers.shift();
        assert.ok(timer, 'an answer schedules its transition');
        if (!timer.cancelled) timer.callback();
        return timer;
    };
    const record = index => JSON.parse(h.run(`JSON.stringify(state.game.answeredHistory[${index}])`));
    return {h, el, skip, answer, advance, timers, record};
}

for (const mode of ['spelling', 'choice-en-ch', 'choice-ch-en']) {
    test(`${mode}: skip records an unanswered review item and advances only once`, () => {
        const p = setup(mode);
        const first = p.h.run('getCurrentWord().english');
        p.skip();
        assert.equal(p.record(0).result, 'skipped');
        assert.equal(p.record(0).userAnswer, '');
        assert.equal(p.h.run('state.game.wrongWords.size'), 1);
        assert.equal(p.h.run('Array.from(state.game.wrongWords)[0].english'), first);
        for (const id of ['btn-spelling-submit', 'btn-spelling-skip', 'btn-choice-skip']) {
            assert.equal(p.el(id).disabled, true);
        }
        if (mode.startsWith('choice')) {
            assert.equal(p.record(0).choices.length, 5);
            assert.equal(p.record(0).choices.filter(choice => choice.isCorrect).length, 1);
            assert.equal(p.record(0).choices.some(choice => choice.isSelected), false);
            assert.equal(p.el('choice-options').children.every(button => button.disabled), true);
            assert.equal(p.el('choice-options').children.filter(button => button.classList.contains('choice-correct')).length, 1);
            const expected = p.h.run(mode === 'choice-en-ch' ? 'formatMeaning(getCurrentWord().meanings)' : 'getCurrentWord().english');
            assert.ok(p.el('choice-feedback').innerText.includes(expected));
        }
        p.skip();
        p.answer();
        assert.equal(p.record(0).result, 'skipped', 'repeated actions cannot overwrite the record');
        assert.equal(p.timers.length, 1);
        const timer = p.advance();
        assert.equal(p.h.run('state.game.index'), 1);
        assert.equal(p.h.run('canAnswerCurrentQuestion()'), true);
        timer.callback();
        assert.equal(p.h.run('state.game.index'), 1, 'a stale callback cannot skip another question');
    });

    test(`${mode}: correct answers cannot subsequently become skipped`, () => {
        const p = setup(mode);
        p.answer();
        p.skip();
        p.answer();
        assert.equal(p.record(0).result, 'correct');
        assert.equal(p.h.run('state.game.wrongWords.size'), 0);
        assert.equal(p.timers.length, 1);
        assert.equal(p.el('btn-choice-skip').disabled, true);
        assert.equal(p.el('btn-spelling-skip').disabled, true);
    });

    test(`${mode}: pending answers and history are read-only, with a usable return to the next question`, () => {
        const p = setup(mode);
        p.skip();
        p.h.run('showCurrentQuestion();');
        assert.equal(p.h.run('state.game.viewingHistoryIndex'), 0);
        assert.equal(p.h.run('canAnswerCurrentQuestion()'), false);
        assert.equal(p.el('btn-choice-skip').disabled, true);
        assert.equal(p.el('btn-spelling-skip').disabled, true);
        p.skip();
        assert.equal(p.timers.length, 1);
        p.advance();
        assert.equal(p.h.run('state.game.index'), 1);
        assert.equal(p.h.run('state.game.viewingHistoryIndex'), 0, 'transition preserves the history being read');
        p.h.run('navigateHistory("current");');
        assert.equal(p.h.run('canAnswerCurrentQuestion()'), true);
        p.h.run('navigateHistory("prev");');
        assert.equal(p.h.run('state.game.viewingHistoryIndex'), 0);
        p.skip();
        assert.equal(p.h.run('state.game.answeredHistory.length'), 1);
        assert.equal(p.timers.length, 0);
        p.h.run('navigateHistory("current");');
        p.skip();
        assert.equal(p.record(1).result, 'skipped');
    });

    test(`${mode}: skipping the final question completes with all skipped words selected for review`, () => {
        const p = setup(mode);
        for (let i = 0; i < 5; i += 1) { p.skip(); p.advance(); }
        assert.equal(p.h.run('state.game.isFinished'), true);
        assert.equal(p.h.run('state.game.index'), 5);
        assert.equal(p.h.run('state.game.answeredHistory.every(entry => entry.result === "skipped")'), true);
        assert.equal(p.el('result-title').innerText, '練習完成！');
        assert.equal(p.el('result-stat').innerText, '錯誤/跳過：5 個');
        assert.equal(p.el('result-skipped-items').children.length, 5);
        assert.equal(p.h.run('state.game.reviewSelection.length'), 5);
        assert.equal(p.el('btn-save-review').disabled, false);
        assert.equal(p.h.run('canAnswerCurrentQuestion()'), false);
    });

    test(`${mode}: settling early invalidates pending transitions and a new game ignores old callbacks`, () => {
        const p = setup(mode);
        p.skip();
        const oldTimer = p.timers.shift();
        p.h.run('quitGameAndSave();');
        assert.equal(p.h.run('state.game.isFinished'), true);
        assert.equal(p.el('result-title').innerText, '練習已結算');
        oldTimer.callback();
        assert.equal(p.h.run('state.game.index'), 0);
        assert.equal(p.el('result-title').innerText, '練習已結算');
        p.h.run(`startGame(${JSON.stringify(mode)});`);
        oldTimer.callback();
        assert.equal(p.h.run('state.game.index'), 0);
        assert.equal(p.h.run('state.game.answeredHistory.length'), 0);
        assert.equal(p.h.run('canAnswerCurrentQuestion()'), true);
    });
}

test('spelling keeps a draft and prior mistake when returning from skipped-question history', () => {
    const p = setup('spelling');
    p.skip();
    p.advance();
    p.el('spelling-input').value = 'unfinished';
    p.el('btn-spelling-submit').onclick();
    p.h.run('navigateHistory("prev"); navigateHistory("current");');
    assert.equal(p.el('spelling-input').value, 'unfinished');
    assert.equal(p.h.run('state.game.currentHadMistake'), true);
    p.answer();
    assert.equal(p.record(1).result, 'correct-after-wrong');
});

test('both game panels expose an explicit skip button in their static markup', () => {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    for (const id of ['btn-spelling-skip', 'btn-choice-skip']) {
        assert.match(html, new RegExp(`<button[^>]*id="${id}"[^>]*>[^<]*跳過此題`));
    }
});
