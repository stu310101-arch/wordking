'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAppHarness, createMemoryFirestore } = require('./helpers/app-harness.cjs');

const lesson = 'lesson:死神單字L5U12';
const series = 'series:shishen-lv5';
const folderKey = 'folder:child';

function harness() {
    const cloud = createMemoryFirestore({'users/A': {schemaVersion:6, revision:0, migrationV6:{status:'complete'}}});
    const h = createAppHarness({firebase: cloud.firebase});
    h.context.fixture = {
        userFolders: {child: {name:'延伸練習'}, nested: {name:'第三層'}, legacy: {name:'死神單字L5U7'}},
        settings: {folderParents: {[folderKey]:lesson, 'folder:nested':folderKey}},
        userOverrides: {w_000002: {folderIds:['nested']}}
    };
    h.run(`publicCatalog=wordData.normalizeCatalog([
        {id:'w_000001',english:'hoof',meanings:M('蹄',['noun']),lessonIds:['死神單字L5U12']},
        {id:'w_000002',english:'note',meanings:M('筆記',['noun']),lessonIds:[]}
    ]);currentUser={uid:'A'};authReady=true;isUserDataReady=true;applyUserData({snapshot:fixture});
    openModal=()=>{};closeModal=()=>true;`);
    return {...h, cloud};
}

test('drilling into a series and lesson shows immediate children and direct word cards', () => {
    const h = harness();
    const children = () => h.elements.get('category-grid').children.map(card => card.dataset.folderKey);
    h.run('renderLibrary()');
    assert.ok(children().includes(series));
    assert.ok(!children().includes(lesson));
    h.run("openLibraryFolder('series:shishen-lv5');renderLibrary()");
    assert.ok(children().includes(lesson));
    assert.ok(!children().includes(folderKey));
    h.run("openLibraryFolder('lesson:死神單字L5U12');renderLibrary()");
    assert.deepEqual(children(), [folderKey]);
    assert.deepEqual(h.elements.get('library-word-cards').children.map(card => card.dataset.wordId), ['w_000001']);
    assert.deepEqual(h.elements.get('library-breadcrumb').children.map(node => node.textContent),
        ['單字庫','›','死神單字Lv5','›','死神單字Lv5U12']);
    assert.equal(h.run("openLibraryFolder('folder:deleted')"), false);
    assert.equal(h.run('state.currentLibraryFolder'), '');
    h.run("window.onpopstate({state:{viewId:'library',folderKey:'folder:nested'}})");
    assert.equal(h.run('state.currentLibraryFolder'), 'folder:nested');
    assert.equal(h.run("openLibraryFolder('H')"), true);
    assert.equal(h.elements.get('list-title').dataset.folderId, 'H');
});

test('creating here and moving a subtree retain IDs and persist parent links', async () => {
    const h = harness();
    h.run(`openLibraryFolder('folder:child');openNewFolderModal();
        document.getElementById('input-new-folder-name').value='新資料夾';`);
    await h.run('confirmNewFolder()');
    const created = Object.entries(h.run('snapshotUserState().userFolders')).find(([, f]) => f.name === '新資料夾');
    assert.ok(created);
    assert.equal(h.run(`state.folderParents['folder:${created[0]}']`), folderKey);
    h.run(`openActionModal('folder:child');document.getElementById('move-folder-parent').value='folder:nested'`);
    await h.run('moveLibraryFolder()');
    assert.equal(h.run("state.folderParents['folder:child']"), lesson);
    assert.match(h.events.alerts.at(-1), /無法移入/);
    h.run("document.getElementById('move-folder-parent').value=''");
    await h.run('moveLibraryFolder()');
    assert.equal(h.run("state.folderParents['folder:child']"), '');
    assert.equal(h.run("state.folderParents['folder:nested']"), folderKey);
    assert.deepEqual(Array.from(h.run("userWordState.getEffectiveWord('w_000002').folderIds")), ['nested']);
    assert.equal(h.cloud.documents.get('users/A/settings/main').folderParents[folderKey], '');
});

test('deleting a personal parent or hiding a lesson promotes only its children', async () => {
    const h = harness();
    h.run("state.targetFolderAction='folder:child';state.pendingDeleteType='keep'");
    await h.run('executeDelete()');
    assert.equal(h.run("state.folderParents['folder:nested']"), lesson);
    assert.ok(!Object.hasOwn(h.run('state.settings.folderParents'),folderKey));
    h.run("state.targetFolderAction='lesson:死神單字L5U12';state.pendingDeleteType='all'");
    await h.run('executeDelete()');
    assert.equal(h.run("state.folderParents['folder:nested']"), series);
    assert.deepEqual(Array.from(h.run("userWordState.getEffectiveWord('w_000002').folderIds")), ['nested']);
    assert.deepEqual(Array.from(h.run('snapshotUserState().hiddenWordIds')), ['w_000001']);
});

test('renaming a private folder with an inferred parent keeps it in the same series', async () => {
    const h = harness();
    assert.equal(h.run("state.folderParents['folder:legacy']"), series);
    h.run("state.targetFolderAction='folder:legacy';document.getElementById('input-rename-folder').value='舊筆記'");
    await h.run('executeRename()');
    assert.equal(h.run("state.folderParents['folder:legacy']"), series);
    assert.equal(h.run("getFolderDisplayName('folder:legacy')"), '舊筆記');
});
