const {M}=require('./helpers/grouped-fixtures.cjs');
'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {randomUUID}=require('node:crypto');
const {createPersistence,diffOperations}=require('../assets/persistence.js');const migration=require('../assets/migration.js');const data=require('../assets/word-data.js');
const {createMemoryFirestore,deferred}=require('./helpers/app-harness.cjs');
const user={uid:'owner'},rootPath='users/owner';const root=(revision=0)=>({schemaVersion:6,revision,migrationV6:{status:'complete'}});
const catalog=[{id:'w_000001',english:'penetrate',meanings:M('穿透',['verb']),lessonIds:['U6']},{id:'w_000002',english:'record',meanings:M('紀錄',['noun']),lessonIds:['U8']}];
const inputs={idMap:{aliases:{old:'w_000001',alias:'w_000001'},previousAliases:{alias:'old'}},tagBaseline:{legacyTagsById:{old:['U6'],alias:['U6']}},legacyCatalog:[{id:'old',english:'penetrate',meaning:'穿透 (v.)',partOfSpeech:'',tags:['U6']}]};
function harness(documents={},options={}){
 const memory=createMemoryFirestore(documents);const control={beforeCommit:null,afterCommit:null};let time=1000000;
 const deps={db:{},doc:(_db,...parts)=>({path:parts.join('/')}),collection:(_db,...parts)=>({path:parts.join('/')}),...memory.firebase,
  deleteField:()=>({__deleteField:true}),onSnapshot:()=>()=>{},getCatalog:()=>catalog,createId:randomUUID,now:()=>time,wait:async()=>{},migrationInputs:inputs,...options};
 const actual=deps.runTransaction;
 deps.runTransaction=async(db,callback)=>{
  let changes=[];
  const result=await actual(db,async tx=>{
   let hasWrite=false;const value=await callback({
    get:async ref=>{assert.equal(hasWrite,false,'all reads precede writes in a real Firestore transaction');return tx.get(ref);},
    set:(ref,value,opts)=>{hasWrite=true;changes.push({path:ref.path,value});return tx.set(ref,value,opts);},
    delete:ref=>{hasWrite=true;changes.push({path:ref.path,delete:true});return tx.delete(ref);}
   });
   if(control.beforeCommit)await control.beforeCommit(changes);return value;
  });
  if(control.afterCommit)await control.afterCommit(changes);return result;
 };
 return {...memory,control,deps,api:createPersistence(deps),advance(ms){time+=ms;}};
}
const createModel=(state={})=>data.createUserWordState(catalog,state);
test('v5 upgrade staging failure can retry without resurrecting pre-v5 data',async()=>{
 const priorRoot={schemaVersion:5,revision:8,migrationV5:{status:'complete',backupId:'previous'},words:[{english:'deleted custom',meaning:'stale'}]};
 const priorWord={schemaVersion:5,meaning:'my definition',partOfSpeech:['verb'],folderIds:['f']};
 const h=harness({[rootPath]:priorRoot,[`${rootPath}/wordOverrides/w_000001`]:priorWord,
  [`${rootPath}/wordOverrides/alias`]:{meaning:'stale alias'},[`${rootPath}/deletedDefaults/old`]:{deleted:true},
  [`${rootPath}/folders/f`]:{name:'my folder',schemaVersion:5}});
 let failed=false;h.control.beforeCommit=changes=>{if(!failed&&changes.some(c=>c.path.includes('/entries/'))){failed=true;throw new Error('offline during v6 staging');}};
 await assert.rejects(h.api.load(user),e=>e.code==='cloud-partial-commit');assert.deepEqual(h.documents.get(`${rootPath}/wordOverrides/w_000001`),priorWord);
 h.control.beforeCommit=null;const result=await h.api.load(user);
 assert.equal(result.revision,9);assert.deepEqual(result.snapshot.hiddenWordIds,[]);assert.deepEqual(result.snapshot.customWords,{});
 assert.deepEqual(result.snapshot.userOverrides.w_000001,{meanings:M('my definition'),folderIds:['f']});
 assert.equal(h.documents.get(`${rootPath}/wordOverrides/w_000001`).schemaVersion,6);
 assert.equal(Object.hasOwn(h.documents.get(`${rootPath}/wordOverrides/w_000001`),'meaning'),false);
 assert.deepEqual(h.documents.get(rootPath).migrationV5,priorRoot.migrationV5);
 assert.deepEqual((await h.api.exportRecovery(user)).sources.wordOverrides.find(r=>r.id==='w_000001').data,priorWord);
 const writes=h.writes.length;await h.api.load(user);assert.equal(h.writes.length,writes);
});
test('an interrupted v5 journal finishes its frozen batches before upgrading to v6',async()=>{
 const id='v5-journal',original={wordOverrides:[{id:'old',data:{meaning:'original source'}}]};
 const h=harness({[rootPath]:{schemaVersion:5,revision:3,syncFence:1,migrationV5:{status:'applying',backupId:id},
  syncLock:{protocol:5,id,kind:'migration',fence:1,baseRevision:3,targetRevision:4,expiresAt:0}},
  [`${rootPath}/migrationBackups/${id}`]:{schemaVersion:5,kind:'migration',status:'ready',baseRevision:3,targetRevision:4,cursor:0,chunks:1,backupParts:1,conflictCount:0},
  [`${rootPath}/migrationBackups/${id}/entries/0`]:{json:JSON.stringify({sources:original,conflicts:[]})},
  [`${rootPath}/migrationBackups/${id}/chunks/0`]:{operations:[{type:'set',path:'wordOverrides/w_000001',data:{meaning:'journal value',partOfSpeech:['verb']}}]}});
 const result=await h.api.load(user);assert.equal(result.revision,5);assert.deepEqual(result.snapshot.userOverrides.w_000001.meanings,M('journal value'));
 assert.equal(h.documents.get(rootPath).migrationV5.status,'complete');assert.equal(h.documents.get(rootPath).migrationV6.status,'complete');
 assert.equal(h.documents.get(`${rootPath}/migrationBackups/${id}`).status,'complete');
 assert.deepEqual(JSON.parse(h.documents.get(`${rootPath}/migrationBackups/${id}/entries/0`).json).sources,original);
 const writes=h.writes.filter(w=>w.path===`${rootPath}/wordOverrides/w_000001`);assert.deepEqual(writes.map(w=>w.data.schemaVersion),[5,6]);
});
test('an empty account writes only a v6 completion marker, never copies catalog or downloads history',async()=>{
 const h=harness({}, {migrationInputs:()=>{throw new Error('history not needed');}});const loaded=await h.api.load(user);
 assert.deepEqual(loaded.snapshot,migration.emptySnapshot());assert.equal(loaded.revision,1);assert.deepEqual([...h.documents.keys()],[rootPath]);
 const count=h.writes.length;await h.api.load(user);assert.equal(h.writes.length,count);assert.equal(h.reads.some(path=>path.includes('migrationBackups')),false);
});
test('one field writes one sparse override; restoring equality deletes entire empty document',async()=>{
 const h=harness({[rootPath]:root()});const m=createModel(),before=m.exportState();m.updateWordOverride('w_000001',{meanings:M('')});
 await h.api.save(before,m.exportState(),user,{expectedRevision:0});
 assert.deepEqual(Object.keys(h.documents.get(`${rootPath}/wordOverrides/w_000001`)).sort(),['meanings','schemaVersion','updatedAt']);
 const next=m.exportState();m.clearWordOverrideField('w_000001','meanings');await h.api.save(next,m.exportState(),user,{expectedRevision:1});
 assert.equal(h.documents.has(`${rootPath}/wordOverrides/w_000001`),false);assert.equal((await h.api.load(user)).revision,2);
});
test('normal load reads canonical collections only and ignores retained legacy aliases after reset',async()=>{
 const h=harness({[rootPath]:root(),[`${rootPath}/wordOverrides/alias`]:{meaning:'stale'},[`${rootPath}/deletedDefaults/old`]:{deleted:true}},
  {migrationInputs:()=>{throw new Error('history not needed');}});
 const loaded=await h.api.load(user);assert.deepEqual(loaded.snapshot.userOverrides,{});assert.deepEqual(loaded.snapshot.hiddenWordIds,[]);
 assert.equal(h.reads.some(path=>path.endsWith('deletedDefaults')),false);
});
test('legacy roots and source documents are retained and backed up before canonical replacements',async()=>{
 const originalRoot={revision:0,words:[{english:'penetrate',meaning:'root edit',tags:['U6']}],deletedDefaults:['old']};
 const original={english:'custom',meaning:'私人 (n.)',tags:['複習'],unknown:{draft:true}};
 const h=harness({[rootPath]:originalRoot,[`${rootPath}/wordOverrides/alias`]:{meaning:'latest',folderIds:[]},[`${rootPath}/customWords/c_one`]:original});
 const loaded=await h.api.load(user);assert.equal(loaded.snapshot.userOverrides.w_000001.meanings[0].definitions.join('；'),'latest');assert.deepEqual(loaded.snapshot.hiddenWordIds,['w_000001']);
 assert.deepEqual(h.documents.get(rootPath).words,originalRoot.words);assert.deepEqual(h.documents.get(`${rootPath}/wordOverrides/alias`),{meaning:'latest',folderIds:[]});
 const backup=await h.api.exportRecovery(user);assert.deepEqual(backup.sources.customWords[0].data,original);assert.deepEqual(backup.sources.root,originalRoot);
 const firstCanonical=h.writes.findIndex(w=>w.path===`${rootPath}/customWords/c_one`);const ready=h.writes.findIndex(w=>w.path.includes('migrationBackups/')&&w.data?.status==='ready');assert.ok(ready<firstCanonical);
 const count=h.writes.length;assert.deepEqual((await h.api.load(user)).snapshot,loaded.snapshot);assert.equal(h.writes.length,count);
});
test('migration failure during staging changes no canonical records and retry retains complete original input',async()=>{
 const originals={[rootPath]:{revision:0},[`${rootPath}/customWords/c`]:{english:'custom',meaning:'original',folderIds:[]}};
 const h=harness(originals);let failed=false;
 h.control.beforeCommit=changes=>{if(!failed&&changes.some(c=>c.path.includes('/entries/'))){failed=true;throw new Error('offline');}};
 await assert.rejects(h.api.load(user),error=>error.code==='cloud-partial-commit');assert.deepEqual(h.documents.get(`${rootPath}/customWords/c`),originals[`${rootPath}/customWords/c`]);
 assert.notEqual(h.documents.get(rootPath).migrationV6.status,'complete');h.control.beforeCommit=null;
 const loaded=await h.api.load(user);assert.equal(loaded.snapshot.customWords.c.meanings[0].definitions.join('；'),'original');
 assert.equal((await h.api.exportRecovery(user)).sources.customWords[0].data.meaning,'original');
});
test('failure after a migration batch is durable resumes frozen plan and never exposes partial data',async()=>{
 const documents={[rootPath]:{revision:0}};for(let i=0;i<7;i++)documents[`${rootPath}/customWords/c${i}`]={english:`custom${i}`,meaning:`original${i}`,tags:[]};
 const h=harness(documents,{atomicLimit:2});let failed=false;
 h.control.afterCommit=changes=>{if(!failed&&changes.some(c=>c.path===`${rootPath}/customWords/c0`)){failed=true;throw new Error('lost acknowledgement');}};
 await assert.rejects(h.api.load(user),error=>error.code==='cloud-partial-commit');assert.notEqual(h.documents.get(rootPath).migrationV6.status,'complete');
 const backupId=h.documents.get(rootPath).migrationV6.backupId;assert.equal(h.documents.get(`${rootPath}/migrationBackups/${backupId}`).cursor,1);
 h.control.afterCommit=null;const loaded=await h.api.load(user);assert.equal(Object.keys(loaded.snapshot.customWords).length,7);
 assert.equal(h.documents.get(rootPath).migrationV6.backupId,backupId);assert.equal(loaded.revision,1);
 assert.deepEqual((await h.api.exportRecovery(user)).sources.customWords.find(c=>c.id==='c0').data,documents[`${rootPath}/customWords/c0`]);
});
test('lost acknowledgement of final migration commit does not repeat migration or resurrect edits',async()=>{
 const h=harness({[rootPath]:{},[`${rootPath}/wordOverrides/old`]:{meaning:'mine'}});let failed=false;
 h.control.afterCommit=changes=>{if(!failed&&changes.some(c=>c.path===rootPath&&c.value?.migrationV6?.status==='complete')){failed=true;throw new Error('lost ack');}};
 await assert.rejects(h.api.load(user),error=>error.code==='cloud-partial-commit');const count=h.writes.length;h.control.afterCommit=null;
 const loaded=await h.api.load(user);assert.equal(loaded.revision,1);assert.equal(h.writes.length,count);
 const m=createModel(loaded.snapshot);m.clearWordOverride('w_000001');await h.api.save(loaded.snapshot,m.exportState(),user,{expectedRevision:1});
 assert.deepEqual((await h.api.load(user)).snapshot.userOverrides,{});
});
test('all batches are lease fenced and a stale client cannot continue after takeover',async()=>{
 const h=harness({[rootPath]:root()},{atomicLimit:2});const m=createModel();for(let i=0;i<5;i++)m.createCustomWord(`c${i}`,{english:`custom${i}`});let hijacked=false;
 h.control.afterCommit=changes=>{if(!hijacked&&changes.some(c=>c.path===`${rootPath}/customWords/c0`)){
  hijacked=true;const current=h.documents.get(rootPath);h.documents.set(rootPath,{...current,syncFence:current.syncFence+1,syncLock:{...current.syncLock,fence:current.syncFence+1,expiresAt:99999999}});
 }};
 await assert.rejects(h.api.save(migration.emptySnapshot(),m.exportState(),user,{expectedRevision:0}),error=>error.code==='cloud-partial-commit');
 assert.equal(h.documents.has(`${rootPath}/customWords/c4`),false);assert.equal(h.documents.get(rootPath).revision,0);
});
test('cross-device revision mismatch rejects the whole write without overwriting another device',async()=>{
 const h=harness({[rootPath]:root()});const a=createModel(),b=createModel();a.updateWordOverride('w_000001',{meanings:M('A')});b.updateWordOverride('w_000001',{meanings:M('B')});
 await h.api.save(migration.emptySnapshot(),a.exportState(),user,{expectedRevision:0});
 await assert.rejects(h.api.save(migration.emptySnapshot(),b.exportState(),user,{expectedRevision:0}),error=>error.code==='cloud-revision-conflict');
 assert.equal((await h.api.load(user)).snapshot.userOverrides.w_000001.meanings[0].definitions.join('；'),'A');
});
test('session switches during transaction reads and later batches abort without stale writes or cleanup',async()=>{
 const h=harness({[rootPath]:root()},{atomicLimit:2});let current=true;const guard=()=>{if(!current)throw Object.assign(new Error('old session'),{code:'stale-user-session'});};
 const m=createModel();for(let i=0;i<5;i++)m.createCustomWord(`c${i}`,{english:`custom${i}`});
 h.control.afterCommit=changes=>{if(changes.some(c=>c.path===`${rootPath}/customWords/c0`))current=false;};
 await assert.rejects(h.api.save(migration.emptySnapshot(),m.exportState(),user,{expectedRevision:0,assertCurrent:guard}),error=>error.code==='stale-user-session');
 assert.equal(h.documents.has(`${rootPath}/customWords/c4`),false);assert.notEqual(h.documents.get(rootPath).syncLock.expiresAt,0);
 h.advance(120001);h.control.afterCommit=null;assert.equal(Object.keys((await h.api.load(user)).snapshot.customWords).length,5);
});
test('hidden restore/custom deletion/reset use new collections while retaining recovery and root snapshots',async()=>{
 const h=harness({[rootPath]:{words:[{english:'penetrate',meaning:'mine',tags:[]}]}});let loaded=await h.api.load(user);const m=createModel(loaded.snapshot);
 m.hidePublicWord('w_000001');m.createCustomWord('c',{english:'custom'});m.setFolder('f',{name:'私人'});m.setSettings({bgmEnabled:false});
 await h.api.save(loaded.snapshot,m.exportState(),user,{expectedRevision:loaded.revision});loaded=await h.api.load(user);m.reset();
 await h.api.save(loaded.snapshot,m.exportState(),user,{expectedRevision:loaded.revision});const reset=await h.api.load(user);
 assert.deepEqual(reset.snapshot,migration.emptySnapshot());assert.ok(h.documents.get(rootPath).words);assert.ok(await h.api.exportRecovery(user));
 assert.equal(h.writes.some(w=>w.path.includes('/deletedDefaults/')),false);
});
test('accounts have isolated storage paths and active locks/future schemas fail closed',async()=>{
 const h=harness({[rootPath]:root(),'users/other':root()});const m=createModel();m.updateWordOverride('w_000001',{meanings:M('owner only')});
 await h.api.save(migration.emptySnapshot(),m.exportState(),user,{expectedRevision:0});assert.deepEqual((await h.api.load({uid:'other'})).snapshot.userOverrides,{});
 h.documents.set(rootPath,{...root(1),syncLock:{id:'active',expiresAt:99999999}});await assert.rejects(h.api.load(user),error=>error.code==='cloud-sync-in-progress');
 h.documents.set(rootPath,{schemaVersion:7});await assert.rejects(h.api.load(user),error=>error.code==='unsupported-schema-version');
});
test('backup splitting round trips Unicode and near-limit source documents losslessly',async()=>{
 const original={english:'custom',meaning:'a'.repeat(99900)+'🌏'.repeat(3000),extra:{nested:'recover'}};
 const h=harness({[rootPath]:{},[`${rootPath}/customWords/c`]:original});await h.api.load(user);const exported=await h.api.exportRecovery(user);assert.deepEqual(exported.sources.customWords[0].data,original);
});
test('persistence accepts only canonical write models, no UI words or legacy aliases',()=>{
 assert.throws(()=>diffOperations({words:[]},{}),/canonical snapshot/);
 assert.throws(()=>diffOperations({}, {userOverrides:{w_000001:{tags:[]}}}),/Unknown/);
});

test('invalid canonical migration plan never acquires a lease or writes a completion marker',async()=>{
 const original={lessonIds:[' invalid ']};
 const h=harness({[rootPath]:{},[`${rootPath}/wordOverrides/old`]:original});
 await assert.rejects(h.api.load(user),/Invalid/);assert.equal(h.writes.length,0);
 assert.deepEqual(h.documents.get(`${rootPath}/wordOverrides/old`),original);
});
