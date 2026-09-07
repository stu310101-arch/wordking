const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');

// Unsigned emulator tokens are accepted only by Firebase emulators. This test
// additionally refuses production project IDs or any non-loopback endpoint.
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-wordking-rules';
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;
assert.match(PROJECT_ID, /^demo-[a-z0-9-]+$/, 'Use a demo project, never production');
assert.ok(EMULATOR_HOST, 'Run node config/test-firestore-rules.cjs to start the emulator');
assert.match(EMULATOR_HOST, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, 'Emulator must use loopback');
const BASE = `http://${EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const nonce = randomUUID();
const owner = `owner-${nonce}`;
const other = `other-${nonce}`;
const COLLECTIONS = ['customWords', 'wordOverrides', 'hiddenWords', 'deletedDefaults', 'folders', 'settings', 'migrationBackups'];
const paths = [
    `users/${owner}`,
    ...COLLECTIONS.map(name => `users/${owner}/${name}/rules-test`),
    `users/${owner}/migrationBackups/rules-test/entries/nested`,
    `users/${owner}/migrationBackups/rules-test/chunks/000001`
];

function token(uid) {
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
        iss: `https://securetoken.google.com/${PROJECT_ID}`,
        aud: PROJECT_ID, sub: uid, user_id: uid,
        iat: now, exp: now + 3600, auth_time: now,
        firebase: { sign_in_provider: 'custom', identities: {} }
    })}.`;
}

function body(value) {
    return { fields: {
        meaning: { stringValue: value },
        schemaVersion: { integerValue: '5' },
        addedLessonIds: { arrayValue: { values: [{ stringValue: 'unit-1' }] } },
        removedLessonIds: { arrayValue: {} },
        folderIds: { arrayValue: { values: [{ stringValue: 'f_personal' }] } },
        partOfSpeech: { arrayValue: {} },
        isWrong: { booleanValue: false }
    } };
}

async function request(path, { method = 'GET', uid, data } = {}) {
    const response = await fetch(`${BASE}/${path.split('/').map(encodeURIComponent).join('/')}`, {
        method,
        headers: {
            ...(uid ? { Authorization: `Bearer ${token(uid)}` } : {}),
            ...(data ? { 'Content-Type': 'application/json' } : {})
        },
        body: data ? JSON.stringify(data) : undefined,
        signal: AbortSignal.timeout(10000)
    });
    return { status: response.status, body: await response.text() };
}

function expectStatus(result, allowed, label) {
    assert.ok(allowed.includes(result.status), `${label}: expected ${allowed.join('/')}; got ${result.status}: ${result.body}`);
}

test('v6 grouped words are owner-only and fence out v5 fields, writes and account downgrade',async()=>{
 const uid=`grouped-${nonce}`,path=`users/${uid}`;
 const root={fields:{schemaVersion:{integerValue:'6'},revision:{integerValue:'1'},migrationV6:{mapValue:{fields:{status:{stringValue:'complete'}}}}}};
 const grouped={fields:{schemaVersion:{integerValue:'6'},meanings:{arrayValue:{values:[{mapValue:{fields:{
  partOfSpeech:{stringValue:'noun'},definitions:{arrayValue:{values:[{stringValue:'紀錄'}]}}
 }}}]}}}};
 expectStatus(await request(path,{method:'PATCH',uid,data:root}),[200],'v6 root');
 for(const collection of ['wordOverrides','customWords','hiddenWords','folders','settings']) {
  const target=`${path}/${collection}/w_000001`;
  const value=collection==='customWords'?{fields:{...grouped.fields,english:{stringValue:'record'},lessonIds:{arrayValue:{}},folderIds:{arrayValue:{}},isWrong:{booleanValue:false}}}:
   collection==='wordOverrides'?grouped:{fields:{schemaVersion:{integerValue:'6'}}};
  expectStatus(await request(target,{method:'PATCH',uid,data:value}),[200],'v6 create');
  expectStatus(await request(target,{uid}),[200],'v6 owner read');
  expectStatus(await request(target,{method:'PATCH',uid,data:value}),[200],'v6 owner update');
  for(const foreign of [other,undefined]) for(const method of ['GET','PATCH','DELETE']) {
   expectStatus(await request(target,{method,uid:foreign,...(method==='PATCH'?{data:value}:{})}),[401,403],'v6 account isolation');
  }
  expectStatus(await request(target,{method:'PATCH',uid,data:body('old client')}),[403],'v5 write into v6 account denied');
  if(collection==='customWords'||collection==='wordOverrides') for(const field of ['meaning','partOfSpeech','tags','folderId']) {
   expectStatus(await request(target,{method:'PATCH',uid,data:{fields:{...value.fields,[field]:{stringValue:'legacy'}}}}),[403],'legacy field rejected');
  }
  expectStatus(await request(target,{method:'DELETE',uid}),[200],'v6 owner delete');
 }
 expectStatus(await request(path,{method:'PATCH',uid,data:{fields:{schemaVersion:{integerValue:'5'}}}}),[403],'v5 root downgrade denied');
 expectStatus(await request(`${path}/deletedDefaults/old`,{method:'PATCH',uid,data:grouped}),[403],'legacy hide write denied');
 expectStatus(await request(path,{method:'DELETE',uid}),[200],'v6 cleanup');
});

test('owner can create, read, update and delete root, personal differences, backups and nested data', async () => {
    for (const path of paths) {
        expectStatus(await request(path, { method: 'PATCH', uid: owner, data: body('created') }), [200], `${path}: create`);
        const read = await request(path, { uid: owner });
        expectStatus(read, [200], `${path}: read`);
        assert.equal(JSON.parse(read.body).fields.meaning.stringValue, 'created');
        expectStatus(await request(path, { method: 'PATCH', uid: owner, data: body('') }), [200], `${path}: update empty field`);
        expectStatus(await request(path, { method: 'DELETE', uid: owner }), [200], `${path}: delete`);
    }
});

test('another user and signed-out clients cannot read, overwrite or delete personal data', async () => {
    for (const path of paths) {
        expectStatus(await request(path, { method: 'PATCH', uid: owner, data: body('private') }), [200], `${path}: fixture`);
        try {
            for (const uid of [other, undefined]) {
                const label = uid ? 'cross-user' : 'signed-out';
                expectStatus(await request(path, { uid }), [401, 403], `${path}: ${label} read`);
                expectStatus(await request(path, { method: 'PATCH', uid, data: body('forbidden') }), [401, 403], `${path}: ${label} update`);
                expectStatus(await request(path, { method: 'DELETE', uid }), [401, 403], `${path}: ${label} delete`);
            }
            const preserved = await request(path, { uid: owner });
            expectStatus(preserved, [200], `${path}: remains readable by owner`);
            assert.equal(JSON.parse(preserved.body).fields.meaning.stringValue, 'private');
        } finally {
            expectStatus(await request(path, { method: 'DELETE', uid: owner }), [200], `${path}: cleanup`);
        }
    }
});

test('another user and signed-out clients cannot create documents in another account', async () => {
    for (const path of paths) {
        for (const uid of [other, undefined]) {
            expectStatus(await request(path, { method: 'PATCH', uid, data: body('forbidden') }), [401, 403], `${path}: foreign create`);
        }
    }
});

test('collection listing is limited to the owner, and user enumeration is denied', async () => {
    for (const name of COLLECTIONS) {
        const path = `users/${owner}/${name}`;
        expectStatus(await request(path, { uid: owner }), [200], `${path}: owner list`);
        for (const uid of [other, undefined]) {
            expectStatus(await request(path, { uid }), [401, 403], `${path}: foreign list`);
        }
    }
    for (const name of ['entries', 'chunks']) {
        const path = `users/${owner}/migrationBackups/rules-test/${name}`;
        expectStatus(await request(path, { uid: owner }), [200], `${path}: owner checkpoint list`);
        for (const uid of [other, undefined]) {
            expectStatus(await request(path, { uid }), [401, 403], `${path}: foreign checkpoint list`);
        }
    }
    for (const uid of [owner, undefined]) {
        expectStatus(await request('users', { uid }), [401, 403], 'cannot enumerate other accounts');
    }
});

test('migration completion, sync lease checkpoints and hidden-word markers remain private', async () => {
    const rootPath = `users/${owner}`;
    const checkpoint = { fields: {
        schemaVersion: { integerValue: '5' }, revision: { integerValue: '7' }, syncFence: { integerValue: '2' },
        migrationV5: { mapValue: { fields: { status: { stringValue: 'complete' }, backupId: { stringValue: 'rules-test' } } } },
        syncLock: { mapValue: { fields: {
            protocol: { integerValue: '5' }, id: { stringValue: 'test-lease' }, owner: { stringValue: owner },
            kind: { stringValue: 'migration' }, fence: { integerValue: '2' }, cursor: { integerValue: '1' },
            total: { integerValue: '3' }, expiresAt: { integerValue: String(Date.now() + 60000) }
        } } }
    } };
    const hiddenPath = `users/${owner}/hiddenWords/w_000001`;
    try {
        expectStatus(await request(rootPath, { method: 'PATCH', uid: owner, data: checkpoint }), [200], 'owner saves migration checkpoint');
        expectStatus(await request(hiddenPath, { method: 'PATCH', uid: owner, data: { fields: { schemaVersion: { integerValue: '5' } } } }), [200], 'owner hides public word');
        for (const path of [rootPath, hiddenPath]) {
            for (const uid of [other, undefined]) {
                expectStatus(await request(path, { uid }), [401, 403], 'foreign checkpoint read');
                expectStatus(await request(path, { method: 'PATCH', uid, data: checkpoint }), [401, 403], 'foreign checkpoint overwrite');
                expectStatus(await request(path, { method: 'DELETE', uid }), [401, 403], 'foreign checkpoint delete');
            }
        }
        const read = await request(rootPath, { uid: owner });
        expectStatus(read, [200], 'owner reads preserved checkpoint');
        assert.deepEqual(JSON.parse(read.body).fields, checkpoint.fields);
    } finally {
        for (const path of [hiddenPath, rootPath]) expectStatus(await request(path, { method: 'DELETE', uid: owner }), [200], 'checkpoint cleanup');
    }
});

test('no client can read or write a shared cloud catalog outside users/{uid}', async () => {
    for (const path of ['words/public', 'wordOverrides/public', 'hiddenWords/w_000001', 'migrationBackups/shared', 'public/words', 'settings/main']) {
        for (const uid of [owner, undefined]) {
            expectStatus(await request(path, { uid }), [401, 403], `${path}: shared read denied`);
            expectStatus(await request(path, { method: 'PATCH', uid, data: body('forbidden') }), [401, 403], `${path}: shared write denied`);
            expectStatus(await request(path, { method: 'DELETE', uid }), [401, 403], `${path}: shared delete denied`);
        }
    }
});

test('v5 migration fences old clients while canonical changes and atomic batches remain usable', async () => {
 const uid=`v5-${nonce}`,path=`users/${uid}`;
 const marker={schemaVersion:{integerValue:'5'},revision:{integerValue:'0'},migrationV5:{mapValue:{fields:{status:{stringValue:'complete'}}}}};
 expectStatus(await request(path,{method:'PATCH',uid,data:{fields:marker}}),[200],'v5 marker');
 expectStatus(await request(path,{method:'PATCH',uid,data:{fields:{...marker,schemaVersion:{integerValue:'4'}}}}),[403],'old root downgrade denied');
 expectStatus(await request(`${path}/wordOverrides/old`,{method:'PATCH',uid,data:{fields:{meaning:{stringValue:'old'},schemaVersion:{integerValue:'2'},tags:{arrayValue:{}}}}}),[403],'old override denied');
 expectStatus(await request(`${path}/deletedDefaults/old`,{method:'PATCH',uid,data:{fields:{deleted:{booleanValue:true}}}}),[403],'old hide path denied');
 expectStatus(await request(path,{method:'PATCH',uid,data:{fields:{...marker,syncRecoveredAt:{stringValue:'old protocol'}}}}),[403],'old lease recovery denied');
 expectStatus(await request(path,{method:'PATCH',uid,data:{fields:{...marker,syncLock:{mapValue:{fields:{id:{stringValue:'old-lease'},targetRevision:{integerValue:'1'}}}}}}}),[403],'old lease acquisition denied');
 const name=relative=>`projects/${PROJECT_ID}/databases/(default)/documents/${relative}`;
 const writes=[{update:{name:name(`${path}/wordOverrides/w_000001`),fields:body('canonical').fields}},
  {update:{name:name(`${path}/hiddenWords/w_000002`),fields:{schemaVersion:{integerValue:'5'}}}},
  {update:{name:name(path),fields:{...marker,revision:{integerValue:'1'}}}}];
 const response=await fetch(`${BASE}:commit`,{method:'POST',headers:{Authorization:`Bearer ${token(uid)}`,'Content-Type':'application/json'},body:JSON.stringify({writes})});
 assert.equal(response.status,200,await response.text());
 expectStatus(await request(`${path}/wordOverrides/w_000001`,{uid}),[200],'canonical transaction persisted');
 expectStatus(await request(`${path}/wordOverrides/w_000001`,{method:'DELETE',uid}),[200],'empty override deletion permitted');
 for(const item of [`${path}/hiddenWords/w_000002`,path]) expectStatus(await request(item,{method:'DELETE',uid}),[200],'cleanup');
});
