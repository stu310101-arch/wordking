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
const COLLECTIONS = ['customWords', 'wordOverrides', 'deletedDefaults', 'folders', 'settings', 'migrationBackups'];
const paths = [
    `users/${owner}`,
    ...COLLECTIONS.map(name => `users/${owner}/${name}/rules-test`),
    `users/${owner}/migrationBackups/rules-test/entries/nested`
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
        addedTags: { arrayValue: { values: [{ stringValue: 'personal' }] } },
        removedTags: { arrayValue: {} },
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
    for (const uid of [owner, undefined]) {
        expectStatus(await request('users', { uid }), [401, 403], 'cannot enumerate other accounts');
    }
});

test('no client can read or write a shared cloud catalog outside users/{uid}', async () => {
    for (const path of ['words/public', 'wordOverrides/public', 'public/words', 'settings/main']) {
        for (const uid of [owner, undefined]) {
            expectStatus(await request(path, { uid }), [401, 403], `${path}: shared read denied`);
            expectStatus(await request(path, { method: 'PATCH', uid, data: body('forbidden') }), [401, 403], `${path}: shared write denied`);
            expectStatus(await request(path, { method: 'DELETE', uid }), [401, 403], `${path}: shared delete denied`);
        }
    }
});
