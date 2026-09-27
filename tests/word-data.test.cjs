'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const data=require('../assets/word-data.js');const {M}=require('./helpers/grouped-fixtures.cjs');
const {validateCatalogFiles}=require('../config/validate-words.cjs');
const catalog=()=>[{id:'w_000001',english:'penetrate',meanings:M('穿透；滲透'),lessonIds:['U6']},{id:'w_000002',english:'record',meanings:[...M('紀錄',['noun']),...M('記錄；錄製')],lessonIds:['U8']}];
const model=(state={})=>data.createUserWordState(catalog(),state);
// Import spellings and identity assignments from the reviewed U3/U4/U5 source.
// Keep these expectations independent of the runtime catalog and local working files.
const addedLessonImports={
 '死神單字Lv5U3': `betray:453 beware:164 bias:454 bid:312 bizarre:455 blacksmith:456 blast:62 blizzard:457
 blueprint:458 blur:233 blush:459 bodyguard:234 bog:460 bolt:165 booth:168 boredom:324 botany:461 bound:462
 boundary:463 boundless:464 bowel:339 boyhood:465 braid:466 breakthrough:467 briefcase:169 bronze:326
 brooch:468 brood:469 browse:235 bruise:327 bulge:470 bulk:53 bureau:471 bureaucracy:472 burial:473
 butcher:237 cactus:474 calcium:475 calf:476 canal:171 cannon:477 canvas:478 capability:479 carbon:79`,
 '死神單字Lv5U4': `carnation:480 carnival:238 carp:481 casino:482 categorize:483 cathedral:484 caution:28
 cautious:29 cautiously:485 celebrity:172 cellar:486 cello:487 cemetery:488 centigrade:489 ceremony:490
 certainty:491 certificate:173 chaos:492 chapel:493 characterize:494 chatter:495 chatterbox:496 check-in:497
 check-out:498 checkbook:499 chef:239 choir:174 chord:328 chore:500 chronic:501 chubby:329 chunk:502
 circuit:503 cite:504 citizenship:505 civic:506 civics:507 clan:508 clarity:509 clause:175 cling:510
 clinical:511 clover:512 cluster:106 clutch:513 cocaine:514 cocoon:515 coffin:516 coherent:517 coil:518`,
 '死神單字Lv5U5': `coincidence:519 collaboration:520 collective:521 collector:522 colonel:523 colonial:524
 columnist:525 combat:526 comedian:176 commend:527 commentary:178 commentator:177 commission:528 commissioner:529
 commitment:530 commodity:26 communal:531 commune:532 communism:533 communist:534 commute:66 commuter:67
 compact:138 comparable:535 compassion:330 compassionate:331 compatible:536 compel:537 compensate:538 compensation:539
 competence:540 competent:541 complexity:542 complication:543 compliment:179 comply:544 component:545 compound:299
 comprehend:180 comprehensible:182 comprehension:181 comprise:546 compromise:56 compulsory:547 conceal:34
 concede:548 conceive:549 conception:550 condemn:551 conduct:301`
};
const addedLessonWords=Object.fromEntries(Object.entries(addedLessonImports).map(([lesson,source])=>[
 lesson,source.trim().split(/\s+/).map(pair=>{const [english,number]=pair.split(':');return {english,id:`w_${number.padStart(6,'0')}`};})
]));
test('expanded catalog retains all 892 historical identity mappings and frozen backups',()=>{assert.deepEqual(validateCatalogFiles(),{words:551,memberships:622,aliases:17,legacyIds:446,mappedIds:892,lessonFiles:9,frozenFiles:14});});
test('U2 imports 32 spellings with shared identities and retains all existing course memberships',()=>{
 const words=require('../data/words.json'), before=require('../migration/schema-v5-catalog.json');
 const shared={antique:'w_000157',applause:'w_000081',apt:'w_000060',asset:'w_000108',attendance:'w_000148',ballot:'w_000142',barren:'w_000322',batch:'w_000323',behalf:'w_000017'};
 const newNames=['analyst','anonymous','antarctic','appliance','arctic','armor','arouse','array','arrogant','artery','articulate','artifact','assert','attic','attorney','attribute','auction','authorize','autonomy','availability','bandit','barefoot','bazaar'];
 const u2=words.filter(w=>w.lessonIds.includes('死神單字Lv5U2'));
 assert.deepEqual(u2.map(w=>w.english).sort(),[...Object.keys(shared),...newNames].sort());
 for(const old of before){
  const word=words.find(w=>w.id===old.id);assert.equal(word.english,old.english);
  const addedLessons=Object.entries(addedLessonWords).filter(([,expected])=>expected.some(w=>w.english===old.english)).map(([lesson])=>lesson);
  assert.deepEqual(word.lessonIds,[...old.lessonIds,...(Object.hasOwn(shared,old.english)?['死神單字Lv5U2']:[]),...addedLessons]);
  assert.equal(word.isWrong,old.isWrong);
 }
 for(const [english,id] of Object.entries(shared))assert.equal(u2.find(w=>w.english===english).id,id);
 newNames.forEach((english,index)=>assert.equal(u2.find(w=>w.english===english).id,`w_${String(430+index).padStart(6,'0')}`));
 assert.equal(words.filter(w=>w.lessonIds.includes('死神單字Lv5 a')).length,40);
 assert.deepEqual(u2.find(w=>w.english==='batch').meanings,[...M('一批；一組',['noun']),...M('分批')]);
 assert.deepEqual(u2.find(w=>w.english==='auction').meanings,M('拍賣',['noun','verb']));
 assert.deepEqual(u2.find(w=>w.english==='arctic').meanings,[...M('北極',['noun']),...M('北極的',['adjective'])]);
 assert.deepEqual(u2.find(w=>w.english==='antarctic').meanings,[...M('南極',['noun']),...M('南極的',['adjective'])]);
});
test('U3, U4 and U5 import every reviewed spelling exactly once with stable shared identities',()=>{
 const words=require('../data/words.json');
 const counts={'死神單字Lv5U3':44,'死神單字Lv5U4':50,'死神單字Lv5U5':50};
 assert.deepEqual(Object.keys(addedLessonWords),Object.keys(counts));
 for(const [lesson,expected] of Object.entries(addedLessonWords)){
  const imported=words.filter(w=>w.lessonIds.includes(lesson));
  assert.equal(expected.length,counts[lesson],`${lesson} reviewed source count`);
  assert.equal(new Set(expected.map(w=>w.english)).size,expected.length,`${lesson} unique source spellings`);
  assert.deepEqual(imported.map(w=>w.english).sort(),expected.map(w=>w.english).sort(),`${lesson} complete spellings`);
  for(const entry of expected){
   const matches=words.filter(w=>w.english.toLowerCase()===entry.english);
   assert.equal(matches.length,1,`${entry.english} has one public entity across courses`);
   assert.equal(matches[0].id,entry.id,`${entry.english} retains its assigned identity`);
   assert.equal(matches[0].isWrong,false);
  }
 }
});
test('each imported unit keeps noun and verb definitions in separate groups',()=>{
 const words=require('../data/words.json');
 const examples=[
  ['bias',[...M('偏見',['noun']),...M('偏心')]],
  ['carp',[...M('鯉魚',['noun']),...M('挑剔；吹毛求疵')]],
  ['combat',[...M('戰鬥',['noun']),...M('打擊')]]
 ];
 for(const [english,meanings] of examples)assert.deepEqual(words.find(w=>w.english===english).meanings,meanings,english);
});
test('communal and commune remain distinct words with their own meanings and parts of speech',()=>{
 const words=require('../data/words.json');
 const communal=words.find(w=>w.english==='communal'),commune=words.find(w=>w.english==='commune');
 assert.notEqual(communal.id,commune.id);
 assert.deepEqual(communal.meanings,M('公共的；共有的；集體的；公用的',['adjective']));
 assert.deepEqual(commune.meanings,[...M('公社；群居團體',['noun']),...M('親密交談；交流；接觸；交融')]);
 assert.ok(communal.lessonIds.includes('死神單字Lv5U5'));
 assert.ok(commune.lessonIds.includes('死神單字Lv5U5'));
});
test('registered public lessons exist before import and a renamed title retains its identity',()=>{
 assert.deepEqual(data.getPublicLessonIds([]),['死神單字Lv5 a','死神單字Lv5U2','死神單字Lv5U3','死神單字Lv5U4','死神單字Lv5U5']);
 assert.equal(data.getPublicLessonName('死神單字Lv5 a'),'死神單字Lv5U1');
 assert.equal(data.getPublicLessonName('晟景Lv5U6'),'晟景Lv5U6');
 assert.equal(data.getPublicLessonName('constructor'),'constructor');
 const ids=data.getPublicLessonIds([{lessonIds:['死神單字Lv5 a','晟景Lv5U6']}]);ids.push('rogue');
 assert.deepEqual(data.getPublicLessonIds([]),['死神單字Lv5 a','死神單字Lv5U2','死神單字Lv5U3','死神單字Lv5U4','死神單字Lv5U5']);
});
test('opaque identity survives English, grouped meanings and lesson edits',()=>{const m=model();m.updateWordOverride('w_000001',{english:'changed',meanings:M('個人')});m.setWordLessons('w_000001',['U8']);assert.equal(m.getEffectiveWord('w_000001').id,'w_000001');assert.equal(data.normalizeCatalog([{...catalog()[0],english:'other',lessonIds:[]}])[0].id,'w_000001');assert.throws(()=>data.normalizeCatalog([{...catalog()[0],id:'U6::penetrate'}]),/ID/);});
test('canonical catalog forbids duplicate case-insensitive English and standalone meaning/POS',()=>{assert.throws(()=>data.normalizeCatalog([...catalog(),{...catalog()[0],id:'w_000003',english:'PENETRATE'}]),/Duplicate/);assert.throws(()=>data.normalizeCatalog([...catalog(),catalog()[0]]),/Duplicate/);for(const field of ['meaning','partOfSpeech','tags','folderId','folderIds','source','defaultId'])assert.throws(()=>data.normalizeCatalog([{...catalog()[0],[field]:[]}]),/Unknown/);});
test('noun and verb have separate definitions inside one word entity',()=>{const m=model(),w=m.getEffectiveWord('w_000002');assert.equal(m.deriveEffectiveWords().length,2);assert.deepEqual(w.meanings,[...M('紀錄',['noun']),...M('記錄；錄製')]);assert.equal(Object.hasOwn(w,'partOfSpeech'),false);assert.equal(Object.hasOwn(w,'meaning'),false);});
test('group validation rejects duplicates and malformed definitions; normalizes order without sharing references',()=>{assert.throws(()=>data.normalizeMeanings([...M('一'),...M('二')]),/Duplicate/);assert.throws(()=>data.normalizeMeanings([{partOfSpeech:'noun',definitions:'錯誤'}]),/array/);assert.throws(()=>data.normalizeMeanings([{partOfSpeech:'invalid',definitions:[]}]),/Unknown/);assert.deepEqual(data.normalizeMeanings([...M('動'),...M('名',['noun'])]),[...M('名',['noun']),...M('動')]);});
test('A and B personal grouped meanings cannot mutate each other or public catalog',()=>{const base=catalog(),original=JSON.stringify(base),a=data.createUserWordState(base),b=data.createUserWordState(base),visitor=data.createUserWordState(base);a.updateWordOverride('w_000001',{meanings:M('A')});b.updateWordOverride('w_000001',{meanings:M('B')});assert.deepEqual(a.getEffectiveWord('w_000001').meanings,M('A'));assert.deepEqual(b.getEffectiveWord('w_000001').meanings,M('B'));assert.deepEqual(visitor.getEffectiveWord('w_000001').meanings,M('穿透；滲透'));a.getEffectiveWord('w_000001').meanings[0].definitions.push('rogue');assert.deepEqual(a.getWordOverride('w_000001').meanings,M('A'));assert.equal(JSON.stringify(base),original);});
test('only grouped differences are stored; restoring equality removes the empty override',()=>{const m=model();m.updateWordOverride('w_000001',{meanings:M('私人')});assert.deepEqual(m.exportState().userOverrides,{w_000001:{meanings:M('私人')}});m.updateWordOverride('w_000001',{meanings:M('穿透；滲透')});assert.deepEqual(m.exportState().userOverrides,{});});
test('empty groups and false are explicit personal values; clearing meanings inherits latest public',()=>{const m=data.createUserWordState([{...catalog()[0],isWrong:true}]);m.updateWordOverride('w_000001',{meanings:[],isWrong:false});m.setPublicCatalog([{...catalog()[0],meanings:M('新版'),isWrong:true}]);assert.deepEqual(m.getEffectiveWord('w_000001').meanings,[]);m.clearWordOverrideField('w_000001','meanings');assert.deepEqual(m.getEffectiveWord('w_000001').meanings,M('新版'));assert.deepEqual(m.getWordOverride('w_000001'),{isWrong:false});});
test('public group updates inherit unless personally overridden and restore follows latest base',()=>{const a=model(),b=model();a.updateWordOverride('w_000001',{meanings:M('custom')});const next=catalog();next[0].meanings=M('v2');a.setPublicCatalog(next);b.setPublicCatalog(next);assert.deepEqual(a.getEffectiveWord('w_000001').meanings,M('custom'));assert.deepEqual(b.getEffectiveWord('w_000001').meanings,M('v2'));a.clearWordOverride('w_000001');assert.deepEqual(a.getEffectiveWord('w_000001').meanings,M('v2'));});
test('unrelated updates preserve explicit meanings even when public catches up',()=>{const m=model({userOverrides:{w_000001:{meanings:M('穿透；滲透'),removedLessonIds:['future']}}});m.updateWordOverride('w_000001',{isWrong:true});m.setWordFolders('w_000001',['f']);assert.deepEqual(m.getWordOverride('w_000001').meanings,M('穿透；滲透'));assert.deepEqual(m.getWordOverride('w_000001').removedLessonIds,['future']);});
test('lesson deltas remain separate from same-named private folders and other accounts',()=>{const a=model({userOverrides:{w_000001:{addedLessonIds:['U8'],removedLessonIds:['U6'],folderIds:['U6']}}});assert.deepEqual(a.getEffectiveWord('w_000001').lessonIds,['U8']);assert.deepEqual(a.getEffectiveWord('w_000001').folderIds,['U6']);assert.deepEqual(model().getEffectiveWord('w_000001').lessonIds,['U6']);a.setWordLessons('w_000001',[]);a.clearLessonChange('w_000001','U6');assert.deepEqual(a.getEffectiveWord('w_000001').lessonIds,['U6']);});
test('dormant lesson removals survive future public changes',()=>{const m=model({userOverrides:{w_000001:{removedLessonIds:['future']}}});m.setWordLessons('w_000001',['U6','extra']);const next=catalog();next[0].lessonIds=['U6','future','new'];m.setPublicCatalog(next);assert.deepEqual(m.getEffectiveWord('w_000001').lessonIds,['U6','new','extra']);});
test('hide/restore retain meanings and custom deletion never deletes public words',()=>{const m=model();m.updateWordOverride('w_000001',{meanings:M('mine')});m.hidePublicWord('w_000001');assert.equal(m.deriveEffectiveWords().length,1);m.restorePublicWord('w_000001');assert.deepEqual(m.getEffectiveWord('w_000001').meanings,M('mine'));m.createCustomWord('c',{english:'custom',meanings:M('mine',['noun'])});m.deleteCustomWord('c');assert.equal(m.deriveEffectiveWords().length,2);assert.throws(()=>m.deleteCustomWord('w_000001'),/Reserved/);});
test('new and renamed English cannot collide including hidden words',()=>{const m=model();m.hidePublicWord('w_000001');assert.throws(()=>m.createCustomWord('c',{english:'PENETRATE'}),/Duplicate/);m.createCustomWord('c',{english:'mine'});assert.throws(()=>m.updateCustomWord('c',{english:'Record'}),/Duplicate/);assert.throws(()=>m.updateWordOverride('w_000002',{english:'Penetrate'}),/Duplicate/);assert.throws(()=>model({customWords:{c:{english:'record'}}}),/Duplicate/);});
test('folder rename keeps ID; delete removes only private membership including hidden words',()=>{const m=model();m.setFolder('f',{name:'U6'});m.setWordFolders('w_000001',['f']);m.setFolder('f',{name:'new'});assert.deepEqual(m.getEffectiveWord('w_000001').folderIds,['f']);m.hidePublicWord('w_000001');m.deleteFolder('f');assert.deepEqual(m.getEffectiveWord('w_000001').folderIds,[]);assert.deepEqual(m.getEffectiveWord('w_000001').lessonIds,['U6']);});
test('reset clears all private state and canonical APIs reject old or prototype fields',()=>{const m=model();m.updateWordOverride('w_000001',{meanings:M('mine')});m.hidePublicWord('w_000001');m.setFolder('f',{name:'mine'});m.createCustomWord('c',{english:'custom'});m.setSettings({bgmEnabled:false});m.reset();assert.deepEqual(m.exportState(),{userOverrides:{},customWords:{},hiddenWordIds:[],userFolders:{},settings:{}});for(const key of ['meaning','partOfSpeech','tags','folderId','defaultId','lessonIds'])assert.throws(()=>m.updateWordOverride('w_000001',{[key]:[]}));assert.throws(()=>m.setSettings(JSON.parse('{"__proto__":{"bad":true}}')),/Unsafe/);});
