'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAppHarness } = require('./helpers/app-harness.cjs');

function searchHarness() {
    const h = createAppHarness();
    h.run(`
        const makeElement = document.createElement;
        document.createElement = tag => Object.assign(makeElement(tag), {
            style: {},
            addEventListener(type, listener) { this['on' + type] = listener; }
        });
        document.createTextNode = text => Object.assign(makeElement('text'), { textContent: text });
        const searchBox = document.getElementById('search-input');
        const searchList = document.getElementById('search-suggestions');
        searchList.style = {};
        searchList.querySelectorAll = () => searchList.children.filter(child => child.getAttribute('role') === 'option');
        publicCatalog = wordData.normalizeCatalog([{
            id: 'w_000001', english: 'hoof', meanings: M('蹄', ['noun']), lessonIds: ['死神單字L5U12']
        }]);
        applyUserData({ snapshot: {
            userFolders: {
                rootA: {name:'學校'}, rootB: {name:'自習'}, left: {name:'小考'}, right: {name:'小考'},
                english: {name:'hoof'}
            },
            settings: {
                hiddenLessonIds: ['死神單字Lv5U2'],
                folderParents: { 'folder:left':'folder:rootA', 'folder:right':'folder:rootB' }
            }
        }});
    `);
    return h;
}

test('folder search includes public series, visible lessons, and distinct private folders with the same name', () => {
    const h = searchHarness();
    const keys = query => Array.from(h.run(`findLibrarySearchMatches(${JSON.stringify(query)}).map(r => r.folderId)`));
    assert.deepEqual(keys('ＬＶ５Ｕ１２'), ['lesson:死神單字L5U12']);
    assert.equal(keys('死神單字Lv5')[0], 'series:shishen-lv5');
    assert.deepEqual(keys('Lv5U2'), []);
    assert.deepEqual(new Set(keys('考')), new Set(['folder:left', 'folder:right']));
    const paths = Array.from(h.run("findLibrarySearchMatches('考').map(r => r.path)"));
    assert.deepEqual(new Set(paths), new Set(['學校 / 小考', '自習 / 小考']));
    assert.equal(h.run("findLibrarySearchMatches('hoof')[0].word.id"), 'w_000001');
    assert.equal(h.run("findLibrarySearchMatches('蹄')[0].word.id"), 'w_000001');
});

test('empty folders remain searchable with no words; pointer, keyboard and search button open the selected folder', () => {
    const h = searchHarness();
    h.run("state.words = []; searchBox.value = '小考'; handleSearchInput()");
    assert.equal(h.run('searchList.children.length'), 2);
    const second = h.run('searchSuggestions[1].folderId');
    const secondRow = h.run('searchList.children[1]');
    assert.equal(secondRow.children[0].children[1].textContent, h.run('searchSuggestions[1].path'));
    secondRow.onclick();
    assert.equal(h.run('state.currentLibraryFolder'), second);

    h.run("handleSearchInput(); handleSearchKeydown({key:'ArrowUp', preventDefault(){}}); handleSearchKeydown({key:'Enter', preventDefault(){}})");
    assert.equal(h.run('state.currentLibraryFolder'), second);
    h.run("searchBox.value = '晟景'; searchWord()");
    assert.equal(h.run('state.currentLibraryFolder'), 'series:shengjing-lv5');
});

test('exact word results still navigate to the word’s lesson; old account suggestions cannot open a new result', () => {
    const h = searchHarness();
    h.run("searchBox.value = 'HOOF'; searchWord()");
    assert.equal(h.run('state.currentLibraryFolder'), 'lesson:死神單字L5U12');

    h.run("searchBox.value = '小考'; handleSearchInput()");
    const staleOption = h.run('searchList.children[0]');
    h.run("clearPersonalSessionData(); applyUserData({ snapshot: {userFolders: {other:{name:'小考'}}} }); searchBox.value = '小考'; handleSearchInput()");
    assert.equal(h.run('searchSuggestions.length'), 1);
    staleOption.onclick();
    assert.equal(h.run('state.currentLibraryFolder'), '');
    assert.equal(h.run("findLibrarySearchMatches('學校').length"), 0);
    assert.equal(h.run('selectSearchSuggestion(0)'), true);
    assert.equal(h.run('state.currentLibraryFolder'), 'folder:other');
});

test('a broad folder search preserves partial-word suggestions and all identical exact folder names are reachable', () => {
    const h = searchHarness();
    h.run(`
        const manyFolders = {};
        const parents = {};
        for (let i = 0; i < 205; i++) {
            manyFolders['parent' + i] = {name:'課程' + i};
            manyFolders['child' + i] = {name:'hoops'};
            parents['folder:child' + i] = 'folder:parent' + i;
        }
        applyUserData({ snapshot: {userFolders:manyFolders, settings:{folderParents:parents}} });
        searchBox.value = 'hoo';
        handleSearchInput();
    `);
    assert.equal(h.run('searchSuggestions[0].word.english'), 'hoof');
    assert.equal(h.run('searchSuggestions[1].name'), 'hoops');
    assert.equal(h.run('searchSuggestions.length'), 201);
    assert.match(h.run('searchList.children.at(-1).textContent'), /更多/);
    h.run("searchBox.value = 'hoops'; handleSearchInput()");
    assert.equal(h.run('new Set(searchSuggestions.map(match => match.path)).size'), 205);
    assert.equal(h.run('searchList.children.length'), 205);
});
