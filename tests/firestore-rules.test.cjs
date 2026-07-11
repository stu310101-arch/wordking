const assert = require('node:assert/strict');

const PROJECT_ID = 'wordking-434f7';
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const FIRESTORE_BASE = `http://${FIRESTORE_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

const USER_PATHS = [
    ['customWords', 'security-test-word'],
    ['wordOverrides', 'security-test-override'],
    ['deletedDefaults', 'security-test-deleted'],
    ['folders', 'security-test-folder'],
    ['settings', 'main']
];

function documentUrl(uid, collectionName, documentId) {
    const segments = ['users', uid, collectionName, documentId].map(encodeURIComponent);
    return `${FIRESTORE_BASE}/${segments.join('/')}`;
}

function rootUserUrl(uid) {
    return `${FIRESTORE_BASE}/users/${encodeURIComponent(uid)}`;
}

function firestoreBody(value) {
    return {
        fields: {
            testValue: { stringValue: value },
            updatedAt: { timestampValue: new Date().toISOString() }
        }
    };
}

async function request(url, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
}

async function expectStatus(response, expected, label) {
    if (!expected.includes(response.status)) {
        const detail = await response.text();
        assert.fail(`${label}: expected ${expected.join('/')}, received ${response.status}: ${detail}`);
    }
}

async function createUser(label) {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await fetch(
        `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: `rules-${label}-${nonce}@example.test`,
                password: 'Rules-test-password-1!',
                returnSecureToken: true
            })
        }
    );
    assert.equal(response.status, 200, `${label} account should be created in Auth emulator`);
    const data = await response.json();
    assert.ok(data.localId && data.idToken, `${label} account should include uid and ID token`);
    return { uid: data.localId, token: data.idToken };
}

async function testOwnerCrud(user) {
    const paths = [
        ['users/{uid}', rootUserUrl(user.uid)],
        ...USER_PATHS.map(([collectionName, documentId]) => [
            `users/{uid}/${collectionName}/{document}`,
            documentUrl(user.uid, collectionName, documentId)
        ])
    ];

    for (const [label, url] of paths) {
        await expectStatus(await request(url, {
            method: 'PATCH',
            token: user.token,
            body: firestoreBody('created')
        }), [200], `${label} owner create`);
        await expectStatus(await request(url, { token: user.token }), [200], `${label} owner read`);
        await expectStatus(await request(url, {
            method: 'PATCH',
            token: user.token,
            body: firestoreBody('updated')
        }), [200], `${label} owner update`);
        await expectStatus(await request(url, {
            method: 'DELETE',
            token: user.token
        }), [200], `${label} owner delete`);
    }
}

async function testCrossUserDenial(userA, userB) {
    for (const [collectionName, documentId] of USER_PATHS) {
        const url = documentUrl(userB.uid, collectionName, documentId);
        await expectStatus(await request(url, {
            method: 'PATCH',
            token: userB.token,
            body: firestoreBody('owned-by-b')
        }), [200], `${collectionName} fixture create`);
        await expectStatus(await request(url, { token: userA.token }), [403], `${collectionName} cross-user read`);
        await expectStatus(await request(url, {
            method: 'PATCH',
            token: userA.token,
            body: firestoreBody('forbidden-write')
        }), [403], `${collectionName} cross-user write`);
        await expectStatus(await request(url, {
            method: 'DELETE',
            token: userB.token
        }), [200], `${collectionName} fixture cleanup`);
    }
}

async function testUnauthenticatedDenial(user) {
    for (const [collectionName, documentId] of USER_PATHS) {
        const url = documentUrl(user.uid, collectionName, documentId);
        await expectStatus(await request(url, {
            method: 'PATCH',
            token: user.token,
            body: firestoreBody('owner-fixture')
        }), [200], `${collectionName} unauth fixture create`);
        await expectStatus(await request(url), [401, 403], `${collectionName} unauthenticated read`);
        await expectStatus(await request(url, {
            method: 'PATCH',
            body: firestoreBody('forbidden-write')
        }), [401, 403], `${collectionName} unauthenticated write`);
        await expectStatus(await request(url, {
            method: 'DELETE',
            token: user.token
        }), [200], `${collectionName} unauth fixture cleanup`);
    }
}

async function main() {
    const userA = await createUser('a');
    const userB = await createUser('b');

    await testOwnerCrud(userA);
    await testCrossUserDenial(userA, userB);
    await testUnauthenticatedDenial(userA);

    console.log(JSON.stringify({
        ownerAccess: 'PASS (root user document plus 5 subcollections; create/read/update/delete)',
        crossUserDenial: 'PASS (5 subcollections; read/write denied)',
        unauthenticatedDenial: 'PASS (5 subcollections; read/write denied)'
    }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
