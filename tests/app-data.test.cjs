'use strict';
const assert=require('node:assert/strict');const {test}=require('node:test');
const {createAppHarness,createMemoryFirestore}=require('./helpers/app-harness.cjs');
const rawCatalog=[{id:'w_000001',english:'penetrate',meaning:'穿透',partOfSpeech:['verb'],lessonIds:['U6','U8']},
{id:'w_000002',english:'record',meaning:'紀錄；錄製',partOfSpeech:['noun','verb'],lessonIds:['U8']}];
const copy=v=>JSON.parse(JSON.stringify(v));
function harness(snapshot={}){
 const cloud=createMemoryFirestore({'users/A':{schemaVersion:5,revision:0,migrationV5:{status:'complete'}}});
 const h=createAppHarness({firebase:cloud.firebase});h.context.__catalog=copy(rawCatalog);h.context.__snapshot=copy(snapshot);
 h.run(`publicCatalog=wordData.normalizeCatalog(__catalog);currentUser={uid:'A'};authReady=true;isUserDataReady=true;
 applyUserData({snapshot:__snapshot,revision:0});["new-word","new-meaning","new-folder-name","input-rename-folder"].forEach(id=>document.getElementById(id));renderLibrary=()=>{};renderWordList=()=>{};renderResultWordList=()=>{};
 renderResultFolderOptions=()=>{};openAddModal=()=>{};closeAddModal=()=>{state.editingWordIndex=-1;};`);
 return {...h,...cloud};
}
function word(h,id='w_000001'){h.context.__id=id;return copy(h.run('userWordState.getEffectiveWord(__id)'));}
test('editing only meaning through form writes a sparse override using stable identity',async()=>{
 const h=harness();h.elements.get('new-word').value='penetrate';h.elements.get('new-meaning').value='我的穿透';
 h.run(`state.editingWordIndex=0;document.querySelectorAll=selector=>selector.includes('new-part-of-speech')?[{value:'verb'}]:selector.includes('folder-checkbox')?[{value:'lesson:U6'},{value:'lesson:U8'}]:[];`);
 await h.run('saveNewWord()');const override=h.documents.get('users/A/wordOverrides/w_000001');
 assert.equal(override.meaning,'我的穿透');assert.equal(Object.hasOwn(override,'english'),false);assert.equal(Object.hasOwn(override,'lessonIds'),false);assert.equal(Object.hasOwn(override,'folderIds'),false);
 assert.equal(word(h).id,'w_000001');assert.equal(rawCatalog[0].meaning,'穿透');
});
test('derived state is never the write model',async()=>{
 const h=harness();h.run("state.words[0].meaning='rogue merged edit';state.game.reviewSelection=[state.words[0]];state.game.wrongWords=new Set(state.game.reviewSelection);");
 await h.run('saveReviewWords()');assert.equal(word(h).meaning,'穿透');assert.equal(word(h).isWrong,true);
 assert.equal(Object.hasOwn(h.documents.get('users/A/wordOverrides/w_000001'),'meaning'),false);
});
test('identical lesson/folder names have different view keys and edit independent memberships',async()=>{
 const h=harness({userFolders:{U6:{name:'U6'}},userOverrides:{w_000001:{folderIds:['U6']}}});
 assert.deepEqual(copy(h.run('getWordSourceFolderIds(state.words[0])')),['lesson:U6','lesson:U8','folder:U6']);
 await h.run("commitUserMutation(model=>model.setWordLessons('w_000001',['U8']))");
 assert.deepEqual(word(h).lessonIds,['U8']);assert.deepEqual(word(h).folderIds,['U6']);assert.equal(h.run("wordIsInFolder(state.words[0],'folder:U6')"),true);
});
test('hiding and restoring public words preserves modifications and uses hiddenWords existence',async()=>{
 const h=harness({userOverrides:{w_000001:{meaning:'my hidden'}}});await h.run("deletePersonalWord('w_000001')");
 assert.ok(h.documents.has('users/A/hiddenWords/w_000001'));assert.equal(h.run('state.hiddenWords.length'),1);
 h.run('closeSettingsModal=()=>{};');await h.run('restoreHiddenWords()');assert.equal(h.documents.has('users/A/hiddenWords/w_000001'),false);assert.equal(word(h).meaning,'my hidden');
 assert.equal(h.writes.some(w=>w.path.includes('deletedDefaults')),false);
});
test('clear a field or whole override deletes empty sparse documents and retains current public meaning',async()=>{
 const h=harness();await h.run("commitUserMutation(model=>model.updateWordOverride('w_000001',{meaning:'mine',isWrong:true}))");
 await h.run("changeWordOverride('w_000001',model=>model.clearWordOverrideField('w_000001','meaning'))");
 assert.equal(word(h).meaning,'穿透');assert.equal(h.documents.get('users/A/wordOverrides/w_000001').isWrong,true);
 await h.run("changeWordOverride('w_000001',model=>model.clearWordOverride('w_000001'))");assert.equal(h.documents.has('users/A/wordOverrides/w_000001'),false);
});
test('custom word create/update/delete never changes a public entity',async()=>{
 const h=harness();await h.run("commitUserMutation(model=>model.createCustomWord({id:'c',english:'custom',meaning:'mine',partOfSpeech:['noun','verb'],lessonIds:['U6'],folderIds:[]}))");
 await h.run("commitUserMutation(model=>model.updateCustomWord('c',{english:'renamed',meaning:'changed'}))");assert.equal(h.documents.get('users/A/customWords/c').english,'renamed');
 await h.run("deletePersonalWord('c')");assert.equal(h.documents.has('users/A/customWords/c'),false);assert.equal(word(h).english,'penetrate');
});
test('case-insensitive duplicate form edits roll back newly created folders too',async()=>{
 const h=harness();h.elements.get('new-word').value='RECORD';h.elements.get('new-meaning').value='duplicate';h.elements.get('new-folder-name').value='New folder';
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
 const h=harness();await h.run("commitUserMutation(model=>{model.updateWordOverride('w_000001',{meaning:'mine'});model.hidePublicWord('w_000001');model.createCustomWord('c',{english:'custom'});model.setFolder('f',{name:'mine'});})");
 await h.run('confirmReset()');assert.equal(h.run('state.words.length'),2);assert.equal(h.run('state.hiddenWords.length'),0);assert.equal(word(h).meaning,'穿透');
 for(const group of ['wordOverrides','customWords','hiddenWords','folders'])assert.equal([...h.documents.keys()].some(path=>path.startsWith(`users/A/${group}/`)),false);
});
test('search, Chinese ordering, spelling history and practice definitions use effective canonical fields',async()=>{
 const h=harness();await h.run("commitUserMutation(model=>model.updateWordOverride('w_000001',{english:'newpenetrate',meaning:'自己的穿透',partOfSpeech:['noun','verb']}))");
 assert.equal(h.run("findSearchMatches('PEN')[0].word.id"),'w_000001');assert.equal(h.run("findSearchMatches('己透')[0].word.meaning"),'自己的穿透');
 assert.equal(h.run("getMeaningWithPartOfSpeech(state.words[0])"),'自己的穿透 (n.) / (v.)');
 assert.equal(h.run("parseMeaning('紀錄 (正式用法)；錄製',['noun','verb'])[0].text"),'紀錄 (正式用法)');
 assert.deepEqual(copy(h.run('createAnswerRecord({word:state.words[0],result:"correct"}).partOfSpeech')),['noun','verb']);
});
test('a game timer from an older game or account cannot advance the current game',async()=>{
 const h=harness();h.run("let advanced=0;nextQuestion=()=>{advanced+=1;};scheduleGameAdvance(1);clearPracticeSession();");
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(h.run('advanced'),0);
 h.run('scheduleGameAdvance(1);authSessionGeneration+=1;');await new Promise(resolve=>setTimeout(resolve,10));assert.equal(h.run('advanced'),0);
});
