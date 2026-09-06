'use strict';
// Disposable loopback-only UI fixture. The repository and real Firebase are untouched.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = path.resolve(__dirname, '../..');
const words = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/words.json'), 'utf8'));
const find = english => words.find(word => word.english === english);
const records = {};
const put = (uid, collection, id, value) => { records[`users/${uid}/${collection}/${id}`] = value; };
records['users/fixture-account-a'] = { revision: 0, schemaVersion: 4 };
records['users/fixture-account-b'] = { revision: 0, schemaVersion: 4 };
const modern = values => ({ schemaVersion: 2, tagDiffVersion: 2, supersedesLegacyAliases: true, addedTags: [], removedTags: [], ...values });
put('fixture-account-a', 'wordOverrides', find('penetrate').id, modern({ meaning: 'A 的私人解釋：穿透', addedTags: ['Fixture A 私人課程'], removedTags: ['晟景Lv5U6'], updatedAt: '2026-09-05T00:00:00Z' }));
put('fixture-account-a', 'wordOverrides', find('penetration').id, modern({ meaning: '', updatedAt: '2026-09-05T00:00:00Z' }));
put('fixture-account-a', 'deletedDefaults', find('penetrating').id, { deleted: true, updatedAt: '2026-09-05T00:00:00Z' });
put('fixture-account-a', 'wordOverrides', find('exclaim').id, { meaning: 'A 舊版個人解釋', folderIds: ['Fixture A 舊課程'], legacyNote: 'keep this recovery value', updatedAt: '2026-09-04T00:00:00Z' });
put('fixture-account-a', 'wordOverrides', encodeURIComponent('死神單字Lv5 a::absurd').replace(/\./g, '%2E'), { meaning: 'A 別名遷移解釋', tags: ['死神單字Lv5 a', 'Fixture A 舊課程'], updatedAt: '2026-09-04T00:00:00Z' });
put('fixture-account-a', 'customWords', 'fixture-custom-a', { english: 'fixtureword', meaning: 'A 自己新增的單字', folderIds: ['Fixture A 私人課程'], partOfSpeech: 'noun', isWrong: false, source: 'custom' });
put('fixture-account-a', 'settings', 'main', { bgmEnabled: false, speechVolume: 0, bgmVolume: 0 });
put('fixture-account-b', 'settings', 'main', { bgmEnabled: false, speechVolume: 0, bgmVolume: 0 });
put('fixture-account-a', 'folders', 'fixture-folder-a', { name: 'Fixture A 私人課程' });
put('fixture-account-a', 'folders', 'fixture-folder-legacy', { name: 'Fixture A 舊課程' });

function mockFirebase() {
    return `
const seed = ${JSON.stringify(records)};
const KEY = 'wordking-ui-fixture-cloud-v1';
const USER_KEY = 'wordking-ui-fixture-user-v1';
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
let documents;
try { documents = JSON.parse(sessionStorage.getItem(KEY)) || copy(seed); } catch { documents = copy(seed); }
const users = {
 a: { uid: 'fixture-account-a', displayName: '測試帳號 A', email: 'fixture-a@example.test', photoURL: null },
 b: { uid: 'fixture-account-b', displayName: '測試帳號 B', email: 'fixture-b@example.test', photoURL: null }
};
let savedUser = sessionStorage.getItem(USER_KEY);
const auth = { currentUser: users[savedUser] || null };
const authListeners = new Set(), documentListeners = new Map(), events = [];
const fixture = { failReads: false, delayMs: 80, events, get documents() { return copy(documents); },
 get account() { return auth.currentUser?.uid || 'guest'; },
 async setAccount(name) { auth.currentUser = users[name] || null; sessionStorage.setItem(USER_KEY, name || 'guest');
  log('auth', { uid: auth.currentUser?.uid || null }); updateToolbar();
  for (const next of authListeners) next(auth.currentUser); return auth.currentUser; },
 reset() { documents = copy(seed); persist(); fixture.failReads = false; return fixture.setAccount('guest'); }
};
window.__wordkingFixture = fixture;
function log(type, value = {}) { events.push({ type, ...copy(value), at: Date.now() }); if(events.length > 600) events.shift(); }
function persist() { sessionStorage.setItem(KEY, JSON.stringify(documents)); }
function updateToolbar() { const status = document.getElementById('fixture-status'); if(status) status.textContent = '本機測試資料・' + (auth.currentUser?.displayName || '訪客') + (fixture.failReads ? '・網路故障' : ''); }
function toast(message) { let box = document.getElementById('fixture-toast'); if(!box) { box = document.createElement('div'); box.id = 'fixture-toast'; box.setAttribute('role','status'); document.body.append(box); }
 box.textContent = message; box.style.display = 'block'; clearTimeout(toast.timer); toast.timer = setTimeout(() => { box.style.display = 'none'; }, 5000); log('dialog', { message: String(message) }); }
window.alert = message => toast(message);
window.confirm = message => { toast('測試環境已確認：' + message); return true; };
function toolbar() {
 const style = document.createElement('style');
 style.textContent = '#fixture-toolbar{position:relative;z-index:5000;background:#152b45;color:#fff;padding:6px 8px;font:11px/1.25 sans-serif;display:flex;gap:4px;flex-wrap:wrap;align-items:center}#fixture-toolbar button{background:#fff;color:#152b45;border:0;border-radius:4px;padding:5px 7px;font:11px/1 sans-serif}#fixture-status{flex:1 0 120px}#fixture-toast{position:fixed;bottom:12px;left:10px;right:10px;z-index:9000;background:#102b3f;color:#fff;padding:12px;border-radius:8px;font:14px/1.4 sans-serif;box-shadow:0 2px 10px #0005}';
 document.head.append(style); const bar = document.createElement('div'); bar.id = 'fixture-toolbar'; bar.setAttribute('aria-label','本機測試控制');
 bar.innerHTML = '<span id="fixture-status"></span><button id="fixture-a">帳號 A</button><button id="fixture-b">帳號 B</button><button id="fixture-guest">訪客</button><button id="fixture-fail">模擬故障</button><button id="fixture-recover">恢復網路</button>';
 document.body.prepend(bar);
 document.getElementById('fixture-a').onclick = () => fixture.setAccount('a');
 document.getElementById('fixture-b').onclick = () => fixture.setAccount('b');
 document.getElementById('fixture-guest').onclick = () => fixture.setAccount('guest');
 document.getElementById('fixture-fail').onclick = () => { fixture.failReads = true; updateToolbar(); fixture.setAccount(auth.currentUser?.uid === users.b.uid ? 'b' : 'a'); };
 document.getElementById('fixture-recover').onclick = () => { fixture.failReads = false; updateToolbar(); toast('測試網路已恢復；請點網站的重新載入按鈕。'); };
 updateToolbar();
}
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', toolbar, { once: true }); else toolbar();
async function network(operation, ref) { log(operation, { path: ref?.path }); await new Promise(resolve => setTimeout(resolve, fixture.delayMs));
 if(fixture.failReads) { const error = new Error('Fixture 模擬網路故障'); error.code = 'unavailable'; throw error; } }
function snapshot(ref) { const value = documents[ref.path]; return { id: ref.path.split('/').pop(), ref, exists: () => value !== undefined, data: () => copy(value) }; }
function notify(paths) { for(const changed of paths) for(const next of documentListeners.get(changed) || []) queueMicrotask(() => next(snapshot({ path: changed }))); }
function merge(target, source) { const result = copy(target || {}); for(const [key,value] of Object.entries(source)) { if(value && value.__fixtureDeleteField) delete result[key]; else if(value && typeof value === 'object' && !Array.isArray(value)) result[key] = merge(result[key], value); else result[key] = copy(value); } return result; }
function apply(operations) { const paths = new Set(); for(const operation of operations) { const { ref, value, options, type } = operation; paths.add(ref.path);
  if(type === 'delete') delete documents[ref.path]; else documents[ref.path] = options?.merge ? merge(documents[ref.path], value) : merge({}, value);
  log('write:' + type, { path: ref.path }); } persist(); notify(paths); }
function writer(operations) { return {
 set(ref, value, options) { operations.push({ type:'set', ref, value:copy(value), options }); return this; },
 delete(ref) { operations.push({ type:'delete', ref }); return this; },
 update(ref, value) { operations.push({ type:'set', ref, value:copy(value), options:{merge:true} }); return this; }
}; }
export function initializeApp(config) { log('initialize-local-fixture'); return { fixture:true }; }
export function getAuth() { return auth; }
export function onAuthStateChanged(instance, next) { authListeners.add(next); setTimeout(() => { if(authListeners.has(next)) next(auth.currentUser); }, 35); return () => authListeners.delete(next); }
export class GoogleAuthProvider {}
export async function signInWithPopup() { await fixture.setAccount('a'); return { user:auth.currentUser }; }
export async function signOut() { await fixture.setAccount('guest'); }
export function getFirestore() { return { fixture:true }; }
export function collection(database, ...segments) { return { path:[database?.path, ...segments].filter(Boolean).join('/') }; }
export function doc(database, ...segments) { return { path:[database?.path, ...segments].filter(Boolean).join('/') }; }
export async function getDoc(ref) { await network('read:doc', ref); return snapshot(ref); }
export async function getDocs(ref) { await network('read:collection', ref); const prefix = ref.path + '/';
 const docs = Object.keys(documents).filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/')).map(path => snapshot({path})); return { docs, size:docs.length, empty:docs.length === 0 }; }
export function onSnapshot(ref, next, error) { if(!documentListeners.has(ref.path)) documentListeners.set(ref.path, new Set()); const set = documentListeners.get(ref.path); set.add(next);
 setTimeout(() => { if(set.has(next)) fixture.failReads ? error?.(new Error('Fixture 模擬網路故障')) : next(snapshot(ref)); }, 30); return () => set.delete(next); }
export async function runTransaction(database, callback) { await network('transaction'); const operations = []; const transaction = { ...writer(operations), async get(ref) { await network('transaction:read', ref); return snapshot(ref); } };
 const result = await callback(transaction); if(fixture.failReads) throw new Error('Fixture 模擬寫入故障'); apply(operations); return result; }
export function writeBatch() { const operations = []; return { ...writer(operations), async commit() { await network('batch'); apply(operations); } }; }
export function deleteField() { return { __fixtureDeleteField:true }; }
`;
}

const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.ico':'image/x-icon', '.mp3':'audio/mpeg', '.woff2':'font/woff2' };
const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1:4174');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Wordking-Fixture', 'Local mock Firebase; no real account access');
    if (url.pathname === '/mock-firebase.js') { response.setHeader('Content-Type', mime['.js']); response.end(mockFirebase()); return; }
    if (url.pathname === '/__fixture-info') { response.setHeader('Content-Type', mime['.json']); response.end(JSON.stringify({ fixture: true, seededWords: ['penetrate', 'penetrating', 'penetration', 'exclaim', 'absurd', 'fixtureword'] })); return; }
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); } catch { response.writeHead(400); response.end('Bad path'); return; }
    if (decoded !== '/' && decoded !== '/index.html' && !/^\/(assets|data|background music)\//.test(decoded)) { response.writeHead(404); response.end(); return; }
    if (decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.'))) { response.writeHead(404); response.end(); return; }
    const target = path.resolve(repoRoot, '.' + (decoded === '/' ? '/index.html' : decoded));
    if (!target.toLowerCase().startsWith(path.resolve(repoRoot).toLowerCase() + path.sep)) { response.writeHead(403); response.end('Forbidden'); return; }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) { response.writeHead(404); response.end('Not found'); return; }
    response.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
    if (decoded === '/assets/app.js') {
        const actual = fs.readFileSync(target, 'utf8');
        const transformed = actual.replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[^"']+/g, '/mock-firebase.js');
        response.end(transformed); return;
    }
    fs.createReadStream(target).pipe(response);
});
server.listen(Number(process.env.PORT || 4175), '127.0.0.1', () => console.log('WordKing disposable UI fixture: http://127.0.0.1:4175 — real repo assets, local simulated Firebase only.'));
