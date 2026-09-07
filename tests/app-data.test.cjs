const {M}=require('./helpers/grouped-fixtures.cjs');
'use strict';
const assert=require('node:assert/strict');const {test}=require('node:test');
const {createAppHarness,createMemoryFirestore}=require('./helpers/app-harness.cjs');
const rawCatalog=[{id:'w_000001',english:'penetrate',meanings:M('穿透',['verb']),lessonIds:['U6','U8']},
{id:'w_000002',english:'record',meanings:M('紀錄；錄製',['noun','verb']),lessonIds:['U8']}];
const copy=v=>JSON.parse(JSON.stringify(v));
function harness(snapshot={}){
 const cloud=createMemoryFirestore({'users/A':{schemaVersion:6,revision:0,migrationV6:{status:'complete'}}});
 const h=createAppHarness({firebase:cloud.firebase});h.context.__catalog=copy(rawCatalog);h.context.__snapshot=copy(snapshot);
 h.run(`publicCatalog=wordData.normalizeCatalog(__catalog);currentUser={uid:'A'};authReady=true;isUserDataReady=true;
 applyUserData({snapshot:__snapshot,revision:0});["new-word","new-meaning","new-folder-name","input-rename-folder"].forEach(id=>document.getElementById(id));renderLibrary=()=>{};renderWordList=()=>{};renderResultWordList=()=>{};
 renderResultFolderOptions=()=>{};openAddModal=()=>{};closeModal=()=>{};`);
 return {...h,...cloud};
}
function word(h,id='w_000001'){h.context.__id=id;return copy(h.run('userWordState.getEffectiveWord(__id)'));}
test('inline folders preserve meaning groups, course selections and review; word and folders save together',async()=>{
 const h=harness();h.elements.get('new-word').value='record';
 h.run("state.editingWordIndex=1;renderMeaningEditor([{partOfSpeech:'noun',definitions:['紀錄']},{partOfSpeech:'verb',definitions:['記錄','錄製']}]);renderFolderSelection(['lesson:U8'],true);");
 for(const name of ['考前複習','容易錯']) {
  h.elements.get('new-folder-name').value=name;assert.equal(h.run('stageNewWordFolder()'),true);
 }
 assert.equal(h.writes.length,0);assert.deepEqual(copy(h.run('snapshotUserState().userFolders')),{});
 assert.equal(h.run('document.querySelectorAll(".folder-checkbox:checked").length'),3);
 assert.deepEqual(copy(h.run('readMeaningEditor()')),[...M('紀錄',['noun']),...M('記錄；錄製')]);
 assert.equal(h.run("document.getElementById('wrong-checkbox').checked"),true);
 await h.run('saveNewWord()');
 const folders=Object.values(h.run('snapshotUserState().userFolders')).map(f=>f.name);assert.deepEqual(folders,['考前複習','容易錯']);
 assert.deepEqual(word(h,'w_000002').lessonIds,['U8']);assert.equal(word(h,'w_000002').folderIds.length,2);assert.equal(word(h,'w_000002').isWrong,true);
 assert.deepEqual(word(h,'w_000002').meanings,[...M('紀錄',['noun']),...M('記錄；錄製')]);
 assert.equal(h.documents.get('users/A').revision,1);assert.equal(h.run('draftWordFolders.length'),0);
});
test('cancelling an inline folder draft never creates a private folder or changes the word',()=>{
 const h=harness();h.elements.get('new-folder-name').value='取消的資料夾';h.run('stageNewWordFolder();closeAddModal();');
 assert.equal(h.writes.length,0);assert.deepEqual(copy(h.run('snapshotUserState().userFolders')),{});assert.equal(h.run('draftWordFolders.length'),0);
});
test('inline duplicate folder names are rejected without erasing entered definitions',()=>{
 const h=harness();h.setMeanings([...M('名詞獨立意思',['noun']),...M('動詞獨立意思')]);
 h.elements.get('new-folder-name').value='同名';h.run('stageNewWordFolder()');h.elements.get('new-folder-name').value='同名';
 assert.equal(h.run('stageNewWordFolder()'),false);assert.equal(h.run('draftWordFolders.length'),1);
 assert.deepEqual(copy(h.run('readMeaningEditor()')),[...M('名詞獨立意思',['noun']),...M('動詞獨立意思')]);assert.equal(h.writes.length,0);
});
test('editing only meaning through form writes a sparse override using stable identity',async()=>{
 const h=harness();h.elements.get('new-word').value='penetrate';h.setMeanings(M('我的穿透'));
 h.run(`state.editingWordIndex=0;document.querySelectorAll=selector=>selector.includes('word-meanings')?document.getElementById('word-meanings').children:selector.includes('folder-checkbox')?[{value:'lesson:U6'},{value:'lesson:U8'}]:[];`);
 await h.run('saveNewWord()');const override=h.documents.get('users/A/wordOverrides/w_000001');
 assert.equal(override.meanings[0].definitions.join('；'),'我的穿透');assert.equal(Object.hasOwn(override,'english'),false);assert.equal(Object.hasOwn(override,'lessonIds'),false);assert.equal(Object.hasOwn(override,'folderIds'),false);
 assert.equal(word(h).id,'w_000001');assert.equal(rawCatalog[0].meanings[0].definitions.join('；'),'穿透');
});
test('derived state is never the write model',async()=>{
 const h=harness();h.run("state.words[0].meanings[0].definitions=['rogue merged edit'];state.game.reviewSelection=[state.words[0]];state.game.wrongWords=new Set(state.game.reviewSelection);");
 await h.run('saveReviewWords()');assert.equal(word(h).meanings[0].definitions.join('；'),'穿透');assert.equal(word(h).isWrong,true);
 assert.equal(Object.hasOwn(h.documents.get('users/A/wordOverrides/w_000001'),'meanings'),false);
});
test('identical lesson/folder names have different view keys and edit independent memberships',async()=>{
 const h=harness({userFolders:{U6:{name:'U6'}},userOverrides:{w_000001:{folderIds:['U6']}}});
 assert.deepEqual(copy(h.run('getWordSourceFolderIds(state.words[0])')),['lesson:U6','lesson:U8','folder:U6']);
 await h.run("commitUserMutation(model=>model.setWordLessons('w_000001',['U8']))");
 assert.deepEqual(word(h).lessonIds,['U8']);assert.deepEqual(word(h).folderIds,['U6']);assert.equal(h.run("wordIsInFolder(state.words[0],'folder:U6')"),true);
});
test('hiding and restoring public words preserves modifications and uses hiddenWords existence',async()=>{
 const h=harness({userOverrides:{w_000001:{meanings:M('my hidden')}}});await h.run("deletePersonalWord('w_000001')");
 assert.ok(h.documents.has('users/A/hiddenWords/w_000001'));assert.equal(h.run('state.hiddenWords.length'),1);
 h.run('closeSettingsModal=()=>{};');await h.run('restoreHiddenWords()');assert.equal(h.documents.has('users/A/hiddenWords/w_000001'),false);assert.equal(word(h).meanings[0].definitions.join('；'),'my hidden');
 assert.equal(h.writes.some(w=>w.path.includes('deletedDefaults')),false);
});
test('clear a field or whole override deletes empty sparse documents and retains current public meaning',async()=>{
 const h=harness();await h.run("commitUserMutation(model=>model.updateWordOverride('w_000001',{meanings:M('mine'),isWrong:true}))");
 await h.run("changeWordOverride('w_000001',model=>model.clearWordOverrideField('w_000001','meanings'))");
 assert.equal(word(h).meanings[0].definitions.join('；'),'穿透');assert.equal(h.documents.get('users/A/wordOverrides/w_000001').isWrong,true);
 await h.run("changeWordOverride('w_000001',model=>model.clearWordOverride('w_000001'))");assert.equal(h.documents.has('users/A/wordOverrides/w_000001'),false);
});
test('custom word create/update/delete never changes a public entity',async()=>{
 const h=harness();await h.run("commitUserMutation(model=>model.createCustomWord({id:'c',english:'custom',meanings:M('mine',['noun','verb']),lessonIds:['U6'],folderIds:[]}))");
 await h.run("commitUserMutation(model=>model.updateCustomWord('c',{english:'renamed',meanings:M('changed')}))");assert.equal(h.documents.get('users/A/customWords/c').english,'renamed');
 await h.run("deletePersonalWord('c')");assert.equal(h.documents.has('users/A/customWords/c'),false);assert.equal(word(h).english,'penetrate');
});
test('case-insensitive duplicate form edits roll back newly created folders too',async()=>{
 const h=harness();h.elements.get('new-word').value='RECORD';h.setMeanings(M('duplicate'));h.elements.get('new-folder-name').value='New folder';
 h.run('state.editingWordIndex=-1;document.querySelectorAll=()=>[];');await h.run('saveNewWord()');
 assert.equal(Object.keys(h.run('snapshotUserState().customWords')).length,0);assert.equal(Object.keys(h.run('snapshotUserState().userFolders')).length,0);
 assert.equal(h.writes.length,0);assert.match(h.events.alerts.at(-1),/Duplicate/);
});
test('folder rename changes display name only, keeping fixed folder IDs and word associations',async()=>{
 const h=harness({userFolders:{f_1:{name:'before'}},userOverrides:{w_000001:{folderIds:['f_1']}}});
 h.elements.get('input-rename-folder').value='after';h.run("state.targetFolderAction='folder:f_1';");await h.run('executeRename()');
 assert.deepEqual(word(h).folderIds,['f_1']);assert.equal(h.run("getFolderDisplayName('folder:f_1')"),'after');assert.equal(h.writes.some(w=>w.path.includes('/wordOverrides/')),false);
});
test('folder deletion retains words belonging to other courses and hides only exclusive public words',async()=>{
 const h=harness({userOverrides:{w_000001:{removedLessonIds:['U8']}}});h.run("state.targetFolderAction='lesson:U6';state.pendingDeleteType='all';");await h.run('executeDelete()');
 assert.deepEqual(copy(h.run('snapshotUserState().hiddenWordIds')),['w_000001']);assert.equal(h.run('state.words[0].id'),'w_000002');
 assert.deepEqual(copy(h.run('state.settings.hiddenLessonIds')),['U6']);
});
test('reset clears private collections and immediately derives public catalog again',async()=>{
 const h=harness();await h.run("commitUserMutation(model=>{model.updateWordOverride('w_000001',{meanings:M('mine')});model.hidePublicWord('w_000001');model.createCustomWord('c',{english:'custom'});model.setFolder('f',{name:'mine'});})");
 await h.run('confirmReset()');assert.equal(h.run('state.words.length'),2);assert.equal(h.run('state.hiddenWords.length'),0);assert.equal(word(h).meanings[0].definitions.join('；'),'穿透');
 for(const group of ['wordOverrides','customWords','hiddenWords','folders'])assert.equal([...h.documents.keys()].some(path=>path.startsWith(`users/A/${group}/`)),false);
});
test('search, Chinese ordering, spelling history and practice definitions use effective canonical fields',async()=>{
 const h=harness();await h.run("commitUserMutation(model=>model.updateWordOverride('w_000001',{english:'newpenetrate',meanings:M('自己的穿透',['noun','verb'])}))");
 assert.equal(h.run("findSearchMatches('PEN')[0].word.id"),'w_000001');assert.equal(h.run("findSearchMatches('己透')[0].word.meanings[0].definitions.join('；')"),'自己的穿透');
 assert.equal(h.run("getMeaningWithPartOfSpeech(state.words[0])"),'名詞：自己的穿透\n動詞：自己的穿透');
 assert.equal(h.run("parseMeaning(M('紀錄 (正式用法)；錄製',['noun','verb']))[0].text"),'紀錄 (正式用法)；錄製');
 assert.deepEqual(copy(h.run('createAnswerRecord({word:state.words[0],result:"correct"}).meanings.map(group=>group.partOfSpeech)')),['noun','verb']);
});
test('a game timer from an older game or account cannot advance the current game',async()=>{
 const h=harness();h.run("let advanced=0;nextQuestion=()=>{advanced+=1;};scheduleGameAdvance(1);clearPracticeSession();");
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(h.run('advanced'),0);
 h.run('scheduleGameAdvance(1);authSessionGeneration+=1;');await new Promise(resolve=>setTimeout(resolve,10));assert.equal(h.run('advanced'),0);
});

test('U1 title change preserves personal hidden lessons, removed memberships, custom names and same-named folders',()=>{
 const fullCatalog=copy(require('../data/words.json'));
 const existing=fullCatalog.find(w=>w.english==='abuse');
 const initial={userOverrides:{[existing.id]:{removedLessonIds:['死神單字Lv5 a'],folderIds:['private']}},
  userFolders:{private:{name:'死神單字Lv5 a'}},settings:{hiddenLessonIds:['死神單字Lv5 a']}};
 const h=harness(initial);h.context.__fullCatalog=fullCatalog;
 h.run('publicCatalog=wordData.normalizeCatalog(__fullCatalog);applyUserData({snapshot:__snapshot});');
 assert.equal(h.run("getFolderDisplayName('lesson:死神單字Lv5 a')"),'死神單字Lv5U1');
 assert.equal(h.run("getFolderDisplayName('folder:private')"),'死神單字Lv5 a');
 assert.equal(h.run("state.folders.includes('lesson:死神單字Lv5 a')"),false);
 assert.equal(word(h,existing.id).lessonIds.includes('死神單字Lv5 a'),false);
 assert.deepEqual(copy(h.run('snapshotUserState()')),{customWords:{},hiddenWordIds:[],...initial});
 h.run("restoreUserState({settings:{lessonFolderNames:{'死神單字Lv5 a':'我的課程名稱'}}})");
 assert.equal(h.run("getFolderDisplayName('lesson:死神單字Lv5 a')"),'我的課程名稱');
 h.run('currentUser=null;restoreUserState({})');
 assert.equal(h.run("getFolderDisplayName('lesson:死神單字Lv5 a')"),'死神單字Lv5U1');
 assert.equal(h.run("state.folders.includes('lesson:死神單字Lv5 a')"),true);
 assert.equal(h.run("state.words.filter(w=>wordIsInFolder(w,'lesson:死神單字Lv5U2')).length"),32);
 assert.equal(h.run("findSearchMatches('auction')[0].folderName"),'死神單字Lv5U2');
 assert.equal(h.run("getMeaningWithPartOfSpeech(state.words.find(w=>w.english==='auction'))"),'名詞：拍賣\n動詞：拍賣');
 assert.equal(h.writes.length,0);
});

test('registered U2 is selectable as an empty course before its catalog import',()=>{
 const h=harness();assert.equal(h.run("state.folders.includes('lesson:死神單字Lv5U2')"),true);
 assert.equal(h.run("state.words.filter(w=>wordIsInFolder(w,'lesson:死神單字Lv5U2')).length"),0);
});
