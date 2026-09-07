const {M}=require('./helpers/grouped-fixtures.cjs');
'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const migration=require('../assets/migration.js');const data=require('../assets/word-data.js');
const catalog=[{id:'w_000001',english:'penetrate',meanings:M('穿透；滲透',['verb']),lessonIds:['U6','new']},{id:'w_000002',english:'record',meanings:M('紀錄',['noun']),lessonIds:['U8']}];
const inputs={catalog,idMap:{aliases:{old:'w_000001',alias:'w_000001',oldRecord:'w_000002'},previousAliases:{alias:'old'}},tagBaseline:{legacyTagsById:{old:['U6'],alias:['U6'],oldRecord:['U8']}},legacyCatalog:[{id:'old',english:'penetrate',meaning:'穿透；滲透 (v.)',partOfSpeech:'',tags:['U6']},{id:'oldRecord',english:'record',meaning:'紀錄 (n.)',partOfSpeech:'',tags:['U8']}]};
const row=(id,data)=>({id,data});const plan=(sources={})=>migration.createMigrationPlan(sources,inputs);
test('legacy POS labels attach definitions to their own group and retain ordinary notes',()=>{
 assert.deepEqual(migration.convertLegacyMeanings('記錄；錄製 (v.) / 紀錄 (n.)'),[
  {partOfSpeech:'noun',definitions:['紀錄']},{partOfSpeech:'verb',definitions:['記錄','錄製']}]);
 assert.deepEqual(migration.convertLegacyMeanings('攀爬 (v.)(n.) / 爭奪 (v.)(n.) / 炒 (v.)'),[
  {partOfSpeech:'noun',definitions:['攀爬','爭奪']},{partOfSpeech:'verb',definitions:['攀爬','爭奪','炒']}]);
 assert.deepEqual(migration.convertLegacyMeanings('紀錄 (正式用法) (n.)'),M('紀錄 (正式用法)',['noun']));
});
test('completed v5 accounts never resurrect old root, alias, custom, hidden, folder or settings data',()=>{
 for(const version of [5,6]) {
  const p=plan({root:{schemaVersion:version,migrationV5:{status:'complete'},words:[{english:'old custom',meaning:'old'}],deletedDefaults:['old']},
   wordOverrides:[row('alias',{meaning:'stale'}),row('w_000001',{schemaVersion:5,meaning:'mine',folderIds:['f'],removedLessonIds:['U6']})],
   customWords:[row('stale',{english:'stale custom',meaning:'old'}),row('c',{schemaVersion:5,english:'custom',meaning:'自己',partOfSpeech:['noun'],lessonIds:[],folderIds:['f'],isWrong:false})],
   hiddenWords:[row('w_000002',{schemaVersion:5})],deletedDefaults:[row('old',{deleted:true})],
   folders:[row('f',{schemaVersion:5,name:'私人'}),row('stale',{name:'過期'})],settings:{bgmEnabled:false}});
  assert.deepEqual(p.snapshot.userOverrides.w_000001,{meanings:M('mine'),folderIds:['f'],removedLessonIds:['U6']});
  assert.deepEqual(Object.keys(p.snapshot.customWords),['c']);assert.deepEqual(p.snapshot.customWords.c.meanings,M('自己',['noun']));
  assert.deepEqual(p.snapshot.hiddenWordIds,['w_000002']);assert.deepEqual(p.snapshot.userFolders,{f:{name:'私人'}});assert.deepEqual(p.snapshot.settings,{});
 }
});
test('v5 flat personal definitions are conservatively retained per POS with an ambiguity report',()=>{
 const p=plan({wordOverrides:[row('w_000002',{schemaVersion:5,meaning:'我的記錄；我的錄製',partOfSpeech:['noun','verb']})]});
 assert.deepEqual(p.snapshot.userOverrides.w_000002.meanings,M('我的記錄；我的錄製',['noun','verb']));
 assert.equal(p.conflicts[0].reason,'flat-v5-meaning-grouping-preserved');
});
test('replanning completed v6 preserves canonical groups and does not resurrect retained v5 documents',()=>{
 const meanings=[...M('名詞解釋',['noun']),...M('動詞解釋')];
 const p=plan({root:{schemaVersion:6,migrationV6:{status:'complete'},migrationV5:{status:'complete'},words:[{english:'stale custom'}]},
  wordOverrides:[row('w_000001',{schemaVersion:5,meaning:'stale'}),row('w_000002',{schemaVersion:6,meanings})]});
 assert.deepEqual(p.snapshot.userOverrides,{w_000002:{meanings}});assert.deepEqual(p.snapshot.customWords,{});assert.equal(p.conflicts.length,0);
});
test('frozen v5 public values recover distinct historical POS definitions without guessing from current catalog',()=>{
 const p=migration.createMigrationPlan({wordOverrides:[row('w_000002',{schemaVersion:5,meaning:'紀錄 / 記錄；錄製',partOfSpeech:['noun','verb']})]},
  {...inputs,legacyCatalog:[{id:'oldRecord',english:'record',meaning:'紀錄 (n.) / 記錄；錄製 (v.)'}],
   v5Catalog:[{id:'w_000002',english:'record',meaning:'紀錄 / 記錄；錄製',partOfSpeech:['noun','verb']}]});
 assert.deepEqual(p.snapshot.userOverrides.w_000002.meanings,[{partOfSpeech:'noun',definitions:['紀錄']},{partOfSpeech:'verb',definitions:['記錄','錄製']}]);
 assert.equal(p.conflicts.length,0);
});
test('old IDs and alias document paths preserve fields and split frozen lessons from private folders',()=>{
 const sources={wordOverrides:[row('alias',{id:'oldRecord',meaning:'我的意思 (v.)',folderIds:['U6','考前'],unknown:{keep:true}})]};
 const before=JSON.stringify(sources),p=plan(sources),m=data.createUserWordState(catalog,p.snapshot),word=m.getEffectiveWord('w_000001');
 assert.equal(word.meanings[0].definitions.join('；'),'我的意思');assert.deepEqual(word.meanings.map(group=>group.partOfSpeech),['verb']);assert.deepEqual(word.lessonIds,['U6','new']);
 assert.equal(p.snapshot.userFolders[word.folderIds[0]].name,'考前');assert.equal(JSON.stringify(sources),before);
 assert.equal(m.getEffectiveWord('w_000002').meanings[0].definitions.join('；'),'紀錄');assert.deepEqual(plan(sources),p);
});
test('empty legacy snapshots remove only historical lessons and explicit empty/false remain personal',()=>{
 const p=plan({wordOverrides:[row('old',{folderIds:[],meaning:'',partOfSpeech:'',isWrong:false})]});
 assert.deepEqual(p.snapshot.userOverrides.w_000001,{meanings:M('',['other']),isWrong:false,removedLessonIds:['U6']});
 assert.deepEqual(data.createUserWordState(catalog,p.snapshot).getEffectiveWord('w_000001').lessonIds,['new']);
});
test('legacy folderId/tags/lessonIds and wrong markers are handled only by migration',()=>{
 for(const [field,value] of [['folderId','錯題區'],['tags',['錯題區']],['lessonIds',[]]]) {
  const p=plan({wordOverrides:[row('old',{[field]:value})]});assert.deepEqual(p.snapshot.userOverrides.w_000001.removedLessonIds,['U6']);
  if(field!=='lessonIds') assert.equal(p.snapshot.userOverrides.w_000001.isWrong,true);
 }
 assert.equal(plan({wordOverrides:[row('old',{tags:['錯題區'],isWrong:false})]}).snapshot.userOverrides.w_000001.isWrong,false);
});
test('sparse tag changes preserve disjoint alias changes and removals win conflicts by source order',()=>{
 const p=plan({wordOverrides:[row('old',{addedTags:['私人'],removedTags:['U6'],updatedAt:1}),row('alias',{addedTags:['U8'],removedTags:[],updatedAt:2})]});
 assert.deepEqual(p.snapshot.userOverrides.w_000001.removedLessonIds,['U6']);assert.deepEqual(p.snapshot.userOverrides.w_000001.addedLessonIds,['U8']);
 assert.equal(p.snapshot.userOverrides.w_000001.folderIds.length,1);
});
test('a newer full snapshot cancels prior removal and canonical empty reset supersedes aliases',()=>{
 const p=plan({wordOverrides:[row('alias',{folderIds:[],updatedAt:1}),row('old',{folderIds:['U6'],updatedAt:2})]});
 assert.equal(p.snapshot.userOverrides.w_000001,undefined);
 const reset=plan({wordOverrides:[row('alias',{meaning:'stale',updatedAt:999}),row('old',{schemaVersion:2,supersedesLegacyAliases:true,addedTags:[],removedTags:[]})]});
 assert.equal(reset.snapshot.userOverrides.w_000001,undefined);
});
test('oldest root arrays without IDs recover public identity and retain custom content deterministically',()=>{
 const root={words:[{english:'penetrate',meaning:'穿透；滲透 (v.)',tags:['U6']},{english:'custom',meaning:'自己新增 (n.)',tags:['我的']}],folders:['我的'],settings:{deletedLessonIds:['U8']}};
 const p=plan({root});assert.equal(p.snapshot.userOverrides.w_000001,undefined);
 const custom=Object.values(p.snapshot.customWords)[0];assert.equal(custom.english,'custom');assert.deepEqual(custom.meanings.map(group=>group.partOfSpeech),['noun']);
 assert.deepEqual(p.snapshot.settings.hiddenLessonIds,['U8']);assert.equal(Object.hasOwn(p.snapshot.settings,'deletedLessonIds'),false);assert.deepEqual(plan({root}),p);
});
test('retained root snapshots never resurrect once an earlier migration marker exists',()=>{
 const p=plan({root:{migratedToDiffStorageAt:'earlier',words:[{defaultId:'old',meaning:'stale'}],folders:['stale'],deletedDefaults:['old'],settings:{bgmEnabled:false}}});
 assert.deepEqual(p.snapshot,migration.emptySnapshot());
});
test('subcollections outrank old root fields and all conflicting originals remain in caller-owned sources',()=>{
 const root={words:[{defaultId:'old',english:'penetrate',meaning:'older',folderId:'U6'}]};
 const p=plan({root,wordOverrides:[row('alias',{meaning:'latest',updatedAt:5})]});assert.equal(p.snapshot.userOverrides.w_000001.meanings[0].definitions.join('；'),'latest');assert.ok(p.conflicts.some(c=>c.reason==='override-field-conflict'));
});
test('same English custom and public records merge meanings, POS and memberships into one entity',()=>{
 const p=plan({customWords:[row('c_record',{english:'Record',meaning:'錄製 (v.)',folderIds:['私人的']}),row('c_record_two',{english:'record',meaning:'記錄 (v.)',folderIds:['U6'],isWrong:true})]});
 assert.deepEqual(p.snapshot.customWords,{});const word=data.createUserWordState(catalog,p.snapshot).getEffectiveWord('w_000002');
 assert.deepEqual(word.meanings,[...M('紀錄',['noun']),...M('錄製；記錄')]);assert.deepEqual(word.meanings.map(group=>group.partOfSpeech),['noun','verb']);assert.deepEqual(word.lessonIds,['U8','U6']);assert.equal(word.isWrong,true);assert.equal(p.conflicts.filter(c=>c.reason==='same-english-merged').length,2);
});
test('custom/custom duplicates merge once; colliding public renames preserve disputed text in recovery',()=>{
 const p=plan({wordOverrides:[row('old',{english:'record',meaning:'personal'})],customWords:[row('c1',{english:'mine',meaning:'一'}),row('c2',{english:'MINE',meaning:'二'})]});
 assert.equal(Object.keys(p.snapshot.customWords).length,1);assert.equal(Object.values(p.snapshot.customWords)[0].meanings[0].definitions.join('；'),'一；二');
 const m=data.createUserWordState(catalog,p.snapshot);assert.equal(m.getEffectiveWord('w_000001').english,'penetrate');assert.equal(m.getEffectiveWord('w_000001').meanings[0].definitions.join('；'),'personal');
 assert.ok(p.conflicts.some(c=>c.reason==='conflicting-english-retained-in-backup'));
});
test('same-named historical lesson and private folder are both conservatively retained',()=>{
 const p=plan({folders:[row('f_U6',{name:'U6'})],wordOverrides:[row('old',{folderIds:['U6']})]});
 const w=data.createUserWordState(catalog,p.snapshot).getEffectiveWord('w_000001');assert.deepEqual(w.lessonIds,['U6','new']);assert.deepEqual(w.folderIds,['f_U6']);assert.ok(p.conflicts.length);
});
test('hidden alias true/false conflicts preserve visibility, while new hidden existence wins',()=>{
 const source={deletedDefaults:[row('old',{deleted:true}),row('alias',{deleted:false})]};assert.deepEqual(plan(source).snapshot.hiddenWordIds,[]);
 assert.deepEqual(plan({...source,hiddenWords:[row('w_000001',{})]}).snapshot.hiddenWordIds,['w_000001']);
});
test('unknown sources are reported, ordinary parentheses preserved, unsupported future versions fail closed',()=>{
 const p=plan({wordOverrides:[row('unknown',{meaning:'recover me'}),row('old',{meaning:'例子 (正式用法) (a.)',partOfSpeech:''})]});
 assert.ok(p.conflicts.some(c=>c.legacyId==='unknown'));assert.equal(p.snapshot.userOverrides.w_000001.meanings[0].definitions.join('；'),'例子 (正式用法)');assert.deepEqual(p.snapshot.userOverrides.w_000001.meanings.map(group=>group.partOfSpeech),['adjective']);
 assert.throws(()=>plan({root:{schemaVersion:7}}),error=>error.code==='unsupported-schema-version');
 assert.throws(()=>plan({wordOverrides:[row('old',{schemaVersion:7})]}),error=>error.code==='unsupported-schema-version');
 for(const name of ['folders','hiddenWords','customWords','deletedDefaults']) assert.throws(()=>plan({[name]:[row('old',{schemaVersion:7})]}),error=>error.code==='unsupported-schema-version');
 assert.throws(()=>plan({settings:{schemaVersion:7}}),error=>error.code==='unsupported-schema-version');
});
test('canonical snapshots have no legacy fields and prototype fields never migrate as overrides',()=>{
 assert.throws(()=>migration.normalizeSnapshot({words:[]}),/canonical snapshot/);assert.throws(()=>migration.normalizeSnapshot({userOverrides:{w_000001:{tags:[]}}}),/Unknown word field/);
 const p=plan({wordOverrides:[row('old',Object.create({meaning:'inherited'}))]});assert.equal(p.snapshot.userOverrides.w_000001,undefined);
});

test('decoded alias reset markers cannot supersede the authoritative original ID',()=>{
 const encoded=encodeURIComponent('舊課程::penetrate');
 const decoded=decodeURIComponent(encoded);
 const customInputs={...inputs,idMap:{aliases:{...inputs.idMap.aliases,[encoded]:'w_000001',[decoded]:'w_000001'},previousAliases:{[encoded]:'old'}},tagBaseline:{legacyTagsById:{...inputs.tagBaseline.legacyTagsById,[encoded]:['U6'],[decoded]:['U6']}}};
 const p=migration.createMigrationPlan({wordOverrides:[row(decoded,{schemaVersion:2,supersedesLegacyAliases:true,meaning:'stale',updatedAt:999}),row('old',{schemaVersion:2,supersedesLegacyAliases:true,addedTags:[],removedTags:[]})]},customInputs);
 assert.equal(p.snapshot.userOverrides.w_000001,undefined);
});
test('planner validates the actual write model before allowing a migration cutover',()=>{
 assert.throws(()=>plan({wordOverrides:[row('old',{lessonIds:[' invalid lesson ']})]}),/Invalid/);
 const p=plan({customWords:[row('constructor',{english:'recoverme',meaning:'保留在來源備份'})]});
 assert.deepEqual(p.snapshot.customWords,{});assert.ok(p.conflicts.some(c=>c.reason==='invalid-custom-id'));
});
