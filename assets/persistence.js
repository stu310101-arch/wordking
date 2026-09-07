/* Private storage boundary. Every write is owner-scoped and revision guarded.
 * Large changes stage a durable journal before touching canonical documents.
 * Recovery resumes that journal; readers never expose a partial migration. */
(function (root, factory) {
    const api = factory(typeof module === 'object' && module.exports ? require('./migration.js') : root.WordKingMigration);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WordKingPersistence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (migration) {
    'use strict';
    const VERSION = 6;
    const COLLECTIONS = ['wordOverrides', 'customWords', 'hiddenWords', 'folders'];
    const copy = value => JSON.parse(JSON.stringify(value));
    const error = (code, message) => Object.assign(new Error(message), { code });
    const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
    const equal = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
    const revision = root => Number.isSafeInteger(root.revision) && root.revision >= 0 ? root.revision : 0;
    const marker = version => `migrationV${version}`;
    const complete = (root, version = VERSION) => root.schemaVersion === version && root[marker(version)]?.status === 'complete';
    const clean = data => Object.fromEntries(Object.entries(data).filter(([key]) => !['schemaVersion', 'updatedAt', 'createdAt', 'id'].includes(key)));

    function documentsFor(snapshot) {
        const data = migration.normalizeSnapshot(snapshot);
        const docs = new Map();
        for (const [id, value] of Object.entries(data.userOverrides)) docs.set(`wordOverrides/${id}`, value);
        for (const [id, value] of Object.entries(data.customWords)) docs.set(`customWords/${id}`, value);
        for (const id of data.hiddenWordIds) docs.set(`hiddenWords/${id}`, {});
        for (const [id, value] of Object.entries(data.userFolders)) docs.set(`folders/${id}`, value);
        if (Object.keys(data.settings).length) docs.set('settings/main', data.settings);
        return docs;
    }
    function diffOperations(previous, next) {
        const before = documentsFor(previous), after = documentsFor(next), operations = [];
        for (const path of before.keys()) if (!after.has(path)) operations.push({ type: 'delete', path });
        for (const [path, data] of after) if (!before.has(path) || !equal(before.get(path), data)) operations.push({ type: 'set', path, data });
        return operations;
    }
    // Bound both document count and serialized bytes, well below Firestore limits.
    function chunks(items, maxCount = 180, maxBytes = 600000) {
        const result = []; let current = [], bytes = 0;
        for (const item of items) {
            const size = new TextEncoder().encode(JSON.stringify(item)).length;
            if (size > maxBytes) throw error('document-too-large', '個人資料過大，原始資料已保留，請先匯出檢查。');
            if (current.length && (current.length >= maxCount || bytes + size > maxBytes)) { result.push(current); current = []; bytes = 0; }
            current.push(item); bytes += size;
        }
        if (current.length) result.push(current);
        return result;
    }

    function createPersistence(dependencies) {
        const { db, doc, collection, getDoc, getDocs, runTransaction, deleteField, onSnapshot } = dependencies;
        const now = dependencies.now || (() => Date.now());
        const createId = dependencies.createId || (() => globalThis.crypto.randomUUID());
        const wait = dependencies.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        const leaseMs = dependencies.leaseMs || 120000;
        const atomicLimit = dependencies.atomicLimit || 180;
        const catalog = () => dependencies.getCatalog ? dependencies.getCatalog() : (dependencies.catalog || []);
        const ref = (user, relative = '') => {
            if (!user || !migration.validId(user.uid)) throw error('unauthenticated', '請先登入。');
            return doc(db, 'users', user.uid, ...(relative ? relative.split('/') : []));
        };
        const dataOf = snap => snap.exists() ? (snap.data() || {}) : {};
        const readRoot = async user => dataOf(await getDoc(ref(user)));
        function checkVersion(root) {
            if (Number(root.schemaVersion) > VERSION) throw error('unsupported-schema-version', '資料由更新版本建立，請重新整理網站。');
        }
        function checkRevision(root, expected) {
            checkVersion(root);
            if (revision(root) !== expected) throw error('cloud-revision-conflict', '雲端資料已由其他裝置更新。');
        }
        function expired(lock) {
            const expires = lock.expiresAt ?? (Date.parse(lock.updatedAt || lock.startedAt || '') + leaseMs);
            return !Number.isFinite(expires) || now() >= expires;
        }
        function assertLease(root, lease) {
            checkRevision(root, lease.baseRevision);
            if (!root.syncLock || root.syncLock.id !== lease.id || root.syncLock.fence !== lease.fence) {
                throw error('cloud-sync-in-progress', '同步已由另一個裝置接手，請重新載入。');
            }
        }
        const stamp = () => new Date(now()).toISOString();
        function apply(tx, user, operations, version = VERSION) {
            for (const op of operations) {
                if (!/^(wordOverrides|customWords|hiddenWords|folders)\/[^/]+$/.test(op.path) && op.path !== 'settings/main') {
                    throw error('invalid-journal', '無效的同步文件路徑。');
                }
                if (op.type === 'delete') tx.delete(ref(user, op.path));
                else if (op.type === 'set') tx.set(ref(user, op.path), { ...op.data, schemaVersion: version, updatedAt: stamp() });
                else throw error('invalid-journal', '無效的同步操作。');
            }
        }
        async function transaction(user, guard, fn) {
            guard();
            return runTransaction(db, async tx => {
                const root = dataOf(await tx.get(ref(user)));
                guard(); checkVersion(root);
                return fn(tx, root);
            });
        }
        async function readCollections(user, legacy) {
            const names = legacy ? [...COLLECTIONS, 'deletedDefaults'] : COLLECTIONS;
            const values = await Promise.all(names.map(async name => {
                const snap = await getDocs(collection(db, 'users', user.uid, name));
                return [name, snap.docs.map(row => ({ id: row.id, data: row.data() || {} }))];
            }));
            const settingsSnap = await getDoc(ref(user, 'settings/main'));
            return { ...Object.fromEntries(values), settings: settingsSnap.exists() ? settingsSnap.data() : null };
        }
        function canonical(collections) {
            const modern = name => (collections[name] || []).filter(row => row.data.schemaVersion === VERSION);
            for (const name of COLLECTIONS) for (const row of collections[name] || []) checkVersion(row.data);
            if (collections.settings) checkVersion(collections.settings);
            return migration.normalizeSnapshot({
                userOverrides: Object.fromEntries(modern('wordOverrides').map(row => [row.id, clean(row.data)])),
                customWords: Object.fromEntries(modern('customWords').map(row => [row.id, clean(row.data)])),
                hiddenWordIds: modern('hiddenWords').map(row => row.id),
                userFolders: Object.fromEntries(modern('folders').map(row => [row.id, clean(row.data)])),
                settings: collections.settings?.schemaVersion === VERSION ? clean(collections.settings) : {}
            });
        }
        async function migrationInputs() {
            if (dependencies.migrationInputs) return typeof dependencies.migrationInputs === 'function'
                ? dependencies.migrationInputs() : dependencies.migrationInputs;
            const fetcher = dependencies.fetch || globalThis.fetch;
            const files = ['legacy-word-id-map.json', 'legacy-tag-baseline.json', 'legacy-catalog.json', 'schema-v5-catalog.json'];
            const [idMap, tagBaseline, legacyCatalog, v5Catalog] = await Promise.all(files.map(async file => {
                const response = await fetcher(`./migration/${file}`, { cache: 'no-cache' });
                if (!response.ok) throw error('migration-input-unavailable', '無法讀取舊資料對照表，尚未更改你的資料。');
                return response.json();
            }));
            return { idMap, tagBaseline, legacyCatalog, v5Catalog };
        }
        async function acquire(user, expected, kind, guard, runId = createId(), protocol = VERSION) {
            return transaction(user, guard, (tx, root) => {
                checkRevision(root, expected);
                if (Number(root.schemaVersion) > protocol) throw error('invalid-journal', 'Journal protocol cannot downgrade an account.');
                if (kind === 'mutation' && !complete(root, protocol)) throw error('migration-required', '個人資料尚未完成遷移。');
                if (root.syncLock && !expired(root.syncLock)) throw error('cloud-sync-in-progress', '另一個裝置正在同步，請稍後重試。');
                const lease = { protocol, id: runId, kind, fence: (root.syncFence || 0) + 1,
                    baseRevision: expected, targetRevision: expected + 1, expiresAt: now() + leaseMs };
                tx.set(ref(user), { schemaVersion: protocol, syncFence: lease.fence, syncLock: lease,
                    ...(kind === 'migration' ? { [marker(protocol)]: { status: 'preparing', backupId: runId } } : {}), updatedAt: stamp() }, { merge: true });
                return lease;
            });
        }
        async function stage(user, lease, operations, sources, conflicts, guard) {
            const batches = chunks(operations, atomicLimit);
            const backupJson = JSON.stringify({ sources, conflicts });
            // JSON strings preserve unknown fields without nesting or per-source document-size overflow.
            const backupParts = []; let part = '';
            for (const char of backupJson) {
                if (part.length + char.length > 100000) { backupParts.push(part); part = ''; }
                part += char;
            }
            backupParts.push(part);
            const records = [...backupParts.map((json, i) => ({ path: `entries/${i}`, data: { json } })),
                ...batches.map((operations, i) => ({ path: `chunks/${i}`, data: { operations } }))];
            for (const group of chunks(records, atomicLimit)) {
                await transaction(user, guard, (tx, root) => {
                    assertLease(root, lease);
                    for (const item of group) tx.set(ref(user, `migrationBackups/${lease.id}/${item.path}`), item.data);
                    tx.set(ref(user), { syncLock: { ...lease, expiresAt: now() + leaseMs }, updatedAt: stamp() }, { merge: true });
                });
            }
            await transaction(user, guard, (tx, root) => {
                assertLease(root, lease);
                tx.set(ref(user, `migrationBackups/${lease.id}`), { schemaVersion: VERSION, kind: lease.kind, status: 'ready',
                    baseRevision: lease.baseRevision, targetRevision: lease.targetRevision, cursor: 0, chunks: batches.length,
                    backupParts: backupParts.length, conflictCount: conflicts.length, createdAt: stamp() });
                tx.set(ref(user), { syncLock: { ...lease, expiresAt: now() + leaseMs },
                    ...(lease.kind === 'migration' ? { [marker(lease.protocol)]: { status: 'applying', backupId: lease.id } } : {}) }, { merge: true });
            });
        }
        async function runJournal(user, lease, guard) {
            for (;;) {
                const done = await transaction(user, guard, async (tx, root) => {
                    // A lost acknowledgement after cutover is safe to retry.
                    if (root.lastOperationId === lease.id && revision(root) === lease.targetRevision) return true;
                    assertLease(root, lease);
                    const journalRef = ref(user, `migrationBackups/${lease.id}`);
                    const journal = dataOf(await tx.get(journalRef));
                    guard();
                    if (!['ready', 'applying'].includes(journal.status) || !Number.isInteger(journal.cursor) ||
                        journal.baseRevision !== lease.baseRevision) throw error('invalid-journal', '同步紀錄不完整，原始資料仍保留。');
                    if (journal.cursor === journal.chunks) {
                        tx.set(journalRef, { status: 'complete', completedAt: stamp() }, { merge: true });
                        tx.set(ref(user), { schemaVersion: lease.protocol, revision: lease.targetRevision, lastOperationId: lease.id,
                            syncLock: deleteField(), updatedAt: stamp(),
                            ...(lease.kind === 'migration' ? { [marker(lease.protocol)]: { status: 'complete', backupId: lease.id,
                                conflictCount: journal.conflictCount, completedAt: stamp() } } : {}) }, { merge: true });
                        return true;
                    }
                    const batch = dataOf(await tx.get(ref(user, `migrationBackups/${lease.id}/chunks/${journal.cursor}`)));
                    guard();
                    if (!Array.isArray(batch.operations)) throw error('invalid-journal', '找不到同步批次，原始資料仍保留。');
                    apply(tx, user, batch.operations, lease.protocol);
                    tx.set(journalRef, { status: 'applying', cursor: journal.cursor + 1 }, { merge: true });
                    tx.set(ref(user), { syncLock: { ...lease, expiresAt: now() + leaseMs }, updatedAt: stamp() }, { merge: true });
                    return false;
                });
                if (done) return { revision: lease.targetRevision };
            }
        }
        async function releaseFailedLease(user, lease, guard) {
            try { await transaction(user, guard, (tx, root) => {
                if (root.syncLock?.id === lease.id && root.syncLock.fence === lease.fence) {
                    tx.set(ref(user), { syncLock: { ...root.syncLock, expiresAt: 0 } }, { merge: true });
                }
            }); } catch { /* An invalidated session must not issue cleanup writes. The lease will expire. */ }
        }
        async function largeWrite(user, expected, kind, operations, sources, conflicts, guard) {
            const lease = await acquire(user, expected, kind, guard);
            try {
                await stage(user, lease, operations, sources, conflicts, guard);
                return await runJournal(user, lease, guard);
            } catch (cause) {
                if (cause.code === 'stale-user-session') throw cause;
                await releaseFailedLease(user, lease, guard);
                throw Object.assign(error('cloud-partial-commit', '同步未完成；重新載入會從保留紀錄接續。'), { cause });
            }
        }
        async function recover(user, root, guard) {
            const lock = root.syncLock;
            if (!expired(lock)) throw error('cloud-sync-in-progress', '另一個裝置正在同步，請稍後重試。');
            if ([5, VERSION].includes(lock.protocol)) {
                const journal = dataOf(await getDoc(ref(user, `migrationBackups/${lock.id}`)));
                guard();
                if (['ready', 'applying'].includes(journal.status)) {
                    const lease = await acquire(user, journal.baseRevision, lock.kind, guard, lock.id, lock.protocol);
                    try { await runJournal(user, lease, guard); }
                    catch (cause) { if (cause.code !== 'stale-user-session') await releaseFailedLease(user, lease, guard); throw cause; }
                    return;
                }
            }
            // No journal became ready: no new canonical writes were made. Retain staged backup fragments.
            await transaction(user, guard, (tx, fresh) => {
                if (fresh.syncLock?.id !== lock.id || !expired(fresh.syncLock)) throw error('cloud-sync-in-progress', '同步已由其他裝置接手。');
                tx.set(ref(user), { syncLock: deleteField(), updatedAt: stamp(),
                    ...(![5, VERSION].includes(lock.protocol) ? { revision: Math.max(revision(fresh), Number(lock.targetRevision) || 0) } : {}) }, { merge: true });
            });
        }
        async function load(user, { assertCurrent = () => {} } = {}) {
            for (let attempt = 0; attempt < 6; attempt += 1) {
                assertCurrent();
                const before = await readRoot(user);
                assertCurrent(); checkVersion(before);
                if (before.syncLock) { await recover(user, before, assertCurrent); continue; }
                if (before[marker(before.schemaVersion)]?.status === 'applying') {
                    // Lost lease is an integrity failure, not permission to reimport changed source data.
                    throw error('migration-recovery-required', '遷移鎖已變更，請保留備份並檢查同步紀錄。');
                }
                const rows = await readCollections(user, !complete(before));
                const after = await readRoot(user);
                assertCurrent(); checkVersion(after);
                if (after.syncLock || revision(after) !== revision(before) || !equal(after.migrationV6, before.migrationV6)) {
                    await wait(50); continue;
                }
                if (complete(after)) return { snapshot: canonical(rows), revision: revision(after), recovery: after.migrationV6?.backupId ? after.migrationV6 : (after.migrationV5 || after.migrationV6) };
                const sources = { root: after, ...rows, settings: rows.settings || {} };
                const hasLegacy = ['words', 'folders', 'settings', 'deletedDefaults'].some(key => Object.hasOwn(after, key)) ||
                    COLLECTIONS.some(name => rows[name].length) || rows.deletedDefaults.length || !!rows.settings;
                const inputs = hasLegacy ? await migrationInputs() : {};
                assertCurrent();
                const plan = hasLegacy ? migration.createMigrationPlan(sources, { ...inputs, catalog: catalog() })
                    : { snapshot: migration.emptySnapshot(), conflicts: [] };
                const operations = [...documentsFor(plan.snapshot)].map(([path, data]) => ({ type: 'set', path, data }));
                if (!hasLegacy) {
                    await transaction(user, assertCurrent, (tx, fresh) => {
                        checkRevision(fresh, revision(after));
                        if (fresh.syncLock) throw error('cloud-sync-in-progress', '另一個裝置正在同步。');
                        tx.set(ref(user), { schemaVersion: VERSION, revision: revision(after) + 1,
                            migrationV6: { status: 'complete', conflictCount: 0, completedAt: stamp() }, updatedAt: stamp() }, { merge: true });
                    });
                } else await largeWrite(user, revision(after), 'migration', operations, sources, plan.conflicts, assertCurrent);
            }
            throw error('cloud-revision-conflict', '雲端資料持續變更，請稍後重新載入。');
        }
        async function save(previous, next, user, { expectedRevision, assertCurrent = () => {} } = {}) {
            assertCurrent();
            const operations = diffOperations(previous, next);
            if (!operations.length) return { revision: expectedRevision };
            if (operations.length > atomicLimit || chunks(operations, atomicLimit).length > 1) {
                return largeWrite(user, expectedRevision, 'mutation', operations, { previous }, [], assertCurrent);
            }
            const operationId = createId();
            try {
                return await transaction(user, assertCurrent, (tx, root) => {
                    if (root.lastOperationId === operationId && revision(root) === expectedRevision + 1) return { revision: expectedRevision + 1 };
                    checkRevision(root, expectedRevision);
                    if (root.syncLock) throw error('cloud-sync-in-progress', '另一個裝置正在同步。');
                    if (!complete(root)) throw error('migration-required', '個人資料尚未完成遷移。');
                    apply(tx, user, operations);
                    tx.set(ref(user), { schemaVersion: VERSION, revision: expectedRevision + 1, lastOperationId: operationId, updatedAt: stamp() }, { merge: true });
                    return { revision: expectedRevision + 1 };
                });
            } catch (cause) {
                if (['stale-user-session', 'cloud-revision-conflict', 'cloud-sync-in-progress', 'migration-required'].includes(cause.code)) throw cause;
                throw Object.assign(error('cloud-partial-commit', '尚未確認雲端寫入結果，請重新載入。'), { cause });
            }
        }
        function subscribe(user, onRevision, onError) {
            return onSnapshot(ref(user), snap => { const root = dataOf(snap); onRevision(Math.max(revision(root), root.syncLock?.targetRevision || 0)); }, onError);
        }
        async function exportRecovery(user, { assertCurrent = () => {} } = {}) {
            const root = await readRoot(user); assertCurrent();
            const id = root.migrationV6?.backupId || root.migrationV5?.backupId;
            if (!id) return null;
            const journal = dataOf(await getDoc(ref(user, `migrationBackups/${id}`))); assertCurrent();
            const parts = await Promise.all(Array.from({ length: journal.backupParts || 0 }, async (_, i) => {
                const part = dataOf(await getDoc(ref(user, `migrationBackups/${id}/entries/${i}`))); assertCurrent(); return part.json;
            }));
            return { schemaVersion: VERSION, backupId: id, ...JSON.parse(parts.join('')) };
        }
        return Object.freeze({ load, save, subscribe, exportRecovery });
    }
    return Object.freeze({ createPersistence, diffOperations });
});
