'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const data = require('../assets/word-data.js');
const {validateCatalogFiles} = require('../config/validate-words.cjs');
const catalog = () => [{id:'w_000001',english:'penetrate',meaning:'穿透；滲透',partOfSpeech:['verb'],lessonIds:['U6']},
 {id:'w_000002',english:'record',meaning:'紀錄；記錄；錄製',partOfSpeech:['noun','verb'],lessonIds:['U8']}];
const model = (initial={}) => data.createUserWordState(catalog(),initial);
test('all 429 allocated entities, 446 memberships, 892 old ID spellings and frozen recovery files validate',()=>{
 assert.deepEqual(validateCatalogFiles(),{words:429,memberships:446,aliases:17,legacyIds:446,mappedIds:892,lessonFiles:9,frozenFiles:14});
});
test('opaque IDs survive corrections of English, meaning and lessons',()=>{
 const m=model();m.updateWordOverride('w_000001',{english:'penetrated',meaning:'個人'});m.setWordLessons('w_000001',['U8']);
 assert.equal(m.getEffectiveWord('w_000001').id,'w_000001');
 assert.equal(data.normalizeCatalog([{...catalog()[0],english:'changed',lessonIds:['changed']}])[0].id,'w_000001');
 assert.throws(()=>data.normalizeCatalog([{...catalog()[0],id:'U6::penetrate'}]),/ID/);
});
test('public IDs and English are unique; canonical input rejects all old aliases',()=>{
 assert.throws(()=>data.normalizeCatalog([...catalog(),{...catalog()[0],id:'w_000003',english:'PENETRATE'}]),/Duplicate public English/);
 assert.throws(()=>data.normalizeCatalog([...catalog(),{...catalog()[0],english:'new'}]),/Duplicate public ID/);
 for(const field of ['tags','folderIds','folderId','defaultId','source']) assert.throws(()=>data.normalizeCatalog([{...catalog()[0],[field]:[]}]),/Unknown catalog/);
 assert.throws(()=>data.normalizeCatalog([{...catalog()[0],partOfSpeech:'verb'}]),/array/);
});
test('multiple meanings and parts of speech remain one word entity',()=>{
 const m=model();assert.deepEqual(m.getEffectiveWord('w_000002').partOfSpeech,['noun','verb']);assert.equal(m.deriveEffectiveWords().length,2);
 m.updateWordOverride('w_000002',{partOfSpeech:['verb','noun','other']});assert.deepEqual(m.getEffectiveWord('w_000002').partOfSpeech,['noun','verb','other']);
});
test('account A, B and visitors own independent state and never mutate the catalog',()=>{
 const publicCatalog=catalog(),frozen=JSON.stringify(publicCatalog);
 const a=data.createUserWordState(publicCatalog),b=data.createUserWordState(publicCatalog),visitor=data.createUserWordState(publicCatalog);
 a.updateWordOverride('w_000001',{meaning:'A解釋'});b.updateWordOverride('w_000001',{meaning:'B解釋'});
 assert.equal(a.getEffectiveWord('w_000001').meaning,'A解釋');assert.equal(b.getEffectiveWord('w_000001').meaning,'B解釋');
 assert.equal(visitor.getEffectiveWord('w_000001').meaning,'穿透；滲透');assert.equal(JSON.stringify(publicCatalog),frozen);
 const exported=a.exportState();exported.userOverrides.w_000001.meaning='external mutation';assert.equal(a.getWordOverride('w_000001').meaning,'A解釋');
 a.getPublicWord('w_000001').lessonIds.push('bad');a.getEffectiveWord('w_000001').folderIds.push('bad');assert.deepEqual(a.getPublicWord('w_000001').lessonIds,['U6']);
});
test('patching an override stores only changes, equality deletes the field and then the document',()=>{
 const m=model();m.updateWordOverride('w_000001',{meaning:'私人'});assert.deepEqual(m.exportState().userOverrides,{w_000001:{meaning:'私人'}});
 m.updateWordOverride('w_000001',{meaning:'穿透；滲透'});assert.deepEqual(m.exportState().userOverrides,{});
});
test('empty meaning/POS and explicit false override independently and field reset restores latest public',()=>{
 const m=data.createUserWordState([{...catalog()[0],isWrong:true}]);m.updateWordOverride('w_000001',{meaning:'',partOfSpeech:[],isWrong:false});
 assert.equal(m.getEffectiveWord('w_000001').meaning,'');assert.deepEqual(m.getEffectiveWord('w_000001').partOfSpeech,[]);assert.equal(m.getEffectiveWord('w_000001').isWrong,false);
 m.setPublicCatalog([{...catalog()[0],meaning:'新版公用',isWrong:true}]);m.clearWordOverrideField('w_000001','meaning');assert.equal(m.getEffectiveWord('w_000001').meaning,'新版公用');
 assert.deepEqual(m.getWordOverride('w_000001'),{partOfSpeech:[],isWrong:false});
});
test('public updates inherit unless the exact field has a personal override',()=>{
 const a=model(),b=model();a.updateWordOverride('w_000001',{meaning:'custom'});
 const updated=catalog();updated[0].meaning='v2';a.setPublicCatalog(updated);b.setPublicCatalog(updated);
 assert.equal(a.getEffectiveWord('w_000001').meaning,'custom');assert.equal(b.getEffectiveWord('w_000001').meaning,'v2');
 a.clearWordOverride('w_000001');assert.equal(a.getEffectiveWord('w_000001').meaning,'v2');
});
test('unrelated patches preserve explicit intent even after public catches up',()=>{
 const m=model({userOverrides:{w_000001:{meaning:'穿透；滲透',removedLessonIds:['future']}}});
 m.updateWordOverride('w_000001',{isWrong:true});m.setWordFolders('w_000001',['f_mine']);
 assert.equal(m.getWordOverride('w_000001').meaning,'穿透；滲透');assert.deepEqual(m.getWordOverride('w_000001').removedLessonIds,['future']);
});
test('lesson differences are independent of private folders and of other accounts',()=>{
 const a=model({userOverrides:{w_000001:{addedLessonIds:['U8'],removedLessonIds:['U6'],folderIds:['U6']}}});
 assert.deepEqual(a.getEffectiveWord('w_000001').lessonIds,['U8']);assert.deepEqual(a.getEffectiveWord('w_000001').folderIds,['U6']);
 assert.deepEqual(model().getEffectiveWord('w_000001').lessonIds,['U6']);
 a.setWordLessons('w_000001',[]);assert.deepEqual(a.getEffectiveWord('w_000001').lessonIds,[]);assert.deepEqual(a.getEffectiveWord('w_000001').folderIds,['U6']);
 a.clearLessonChange('w_000001','U6');assert.deepEqual(a.getEffectiveWord('w_000001').lessonIds,['U6']);
});
test('dormant lesson removals survive unrelated membership changes and future public lessons inherit',()=>{
 const m=model({userOverrides:{w_000001:{removedLessonIds:['future']}}});m.setWordLessons('w_000001',['U6','extra']);
 const updated=catalog();updated[0].lessonIds=['U6','future','new'];m.setPublicCatalog(updated);
 assert.deepEqual(m.getEffectiveWord('w_000001').lessonIds,['U6','new','extra']);m.clearLessonChange('w_000001','future');
 assert.ok(m.getEffectiveWord('w_000001').lessonIds.includes('future'));
});
test('hide/restore retain sparse overrides; deleting customs never affects public words',()=>{
 const m=model();m.updateWordOverride('w_000001',{meaning:'mine'});m.hidePublicWord('w_000001');assert.equal(m.deriveEffectiveWords().length,1);
 assert.equal(m.getEffectiveWord('w_000001',{includeHidden:true}).meaning,'mine');m.restorePublicWord('w_000001');assert.equal(m.deriveEffectiveWords().length,2);
 m.createCustomWord({id:'c_one',english:'custom',meaning:'mine',partOfSpeech:['noun']});m.deleteCustomWord('c_one');assert.equal(m.deriveEffectiveWords().length,2);
 assert.throws(()=>m.deleteCustomWord('w_000001'),/Reserved/);
});
test('new and renamed English cannot collide including case and hidden words',()=>{
 const m=model();m.hidePublicWord('w_000001');
 assert.throws(()=>m.createCustomWord('c_one',{english:'PENETRATE'}),error=>error.code==='DUPLICATE_ENGLISH');
 m.createCustomWord('c_two',{english:'mine'});assert.throws(()=>m.updateCustomWord('c_two',{english:'Record'}),/Duplicate/);
 assert.throws(()=>m.updateWordOverride('w_000002',{english:'Penetrate'}),/Duplicate/);
 assert.throws(()=>model({customWords:{c_dup:{english:'record'}}}),/Duplicate/);
});
test('folder rename keeps identity and deleting a folder removes only personal memberships',()=>{
 const m=model();m.setFolder('f_1',{name:'U6'});m.setWordFolders('w_000001',['f_1']);m.setFolder('f_1',{name:'renamed'});
 assert.deepEqual(m.getEffectiveWord('w_000001').folderIds,['f_1']);m.hidePublicWord('w_000001');m.deleteFolder('f_1');
 assert.deepEqual(m.getEffectiveWord('w_000001').folderIds,[]);assert.deepEqual(m.getEffectiveWord('w_000001').lessonIds,['U6']);
});
test('reset clears all private data and re-inherits latest public values',()=>{
 const m=model();m.setFolder('f',{name:'mine'});m.updateWordOverride('w_000001',{meaning:'mine',isWrong:true});m.hidePublicWord('w_000001');
 m.createCustomWord('c',{english:'custom'});m.setSettings({bgmEnabled:false});m.reset();
 assert.deepEqual(m.exportState(),{userOverrides:{},customWords:{},hiddenWordIds:[],userFolders:{},settings:{}});assert.equal(m.deriveEffectiveWords().length,2);
});
test('canonical model never interprets legacy or prototype fields',()=>{
 const m=model();for(const field of ['tags','folderId','defaultId','lessonIds']) assert.throws(()=>m.updateWordOverride('w_000001',{[field]:[]}));
 m.updateWordOverride('w_000001',Object.create({meaning:'inherited'}));assert.deepEqual(m.getWordOverride('w_000001'),{});
 assert.throws(()=>m.setSettings(JSON.parse('{"__proto__":{"bad":true}}')),/Unsafe/);
});
