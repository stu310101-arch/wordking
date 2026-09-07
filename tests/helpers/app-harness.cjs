const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {M} = require('./grouped-fixtures.cjs');
const root = path.resolve(__dirname, '../..');

function element(id) {
    const classes = new Set();
    const attributes = new Map();
    return {
        id, className: '', hidden: false, inert: false, dataset: {}, value: '', textContent: '', children: [], checked: false,
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name),
            toggle(name, force = !classes.has(name)) { if (force) classes.add(name); else classes.delete(name); }
        },
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name); },
        toggleAttribute(name, force = !attributes.has(name)) { if (force) attributes.set(name, ''); else attributes.delete(name); },
        removeAttribute(name) { attributes.delete(name); },
        querySelectorAll(selector) {
            const [query] = selector.split(':');
            return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => {
                const matches = query === '*' || (query.startsWith('.') ? child.className.split(' ').includes(query.slice(1)) : child.id === query);
                return matches && (!selector.includes(':checked') || child.checked);
            });
        },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; this.textContent = ''; },
        addEventListener() {}, removeEventListener() {}, focus() {}, pause() {},
        appendChild(child) { this.children.push(child); },
        getClientRects: () => [1], getBoundingClientRect: () => ({ width: 390, top: 0, left: 0 })
    };
}

function createAppHarness({ firebase = {}, persistence: injectedPersistence } = {}) {
    const elements = new Map();
    const getElement = id => {
        for (const root of elements.values()) {
            const found = root.querySelectorAll('*').find(child => child.id === id);
            if (found) return found;
        }
        if (!elements.has(id)) elements.set(id, element(id));
        return elements.get(id);
    };
    const events = { views: [], renders: [], alerts: [], errors: [], authCallback: null };
    const auth = { currentUser: null };
    const syncTimeouts = new Map();
    let nextTimer = 1;
    const emptySnapshot = { exists: () => false, data: () => ({}) };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error: (...args) => events.errors.push(args) },
        M, Option: function(text,value){return Object.assign(element('option'),{textContent:text,value});}, URL, TextEncoder, Date, Promise, crypto: require('node:crypto').webcrypto, queueMicrotask, setTimeout(callback, delay) {
            if (delay === 15000 || delay === 120000) { const id = nextTimer++; syncTimeouts.set(id, callback); return id; }
            const timer = setTimeout(callback, delay); timer.unref(); return timer;
        },
        clearTimeout(id) { if (syncTimeouts.has(id)) syncTimeouts.delete(id); else clearTimeout(id); },
        alert: message => events.alerts.push(message), confirm: () => true,
        requestAnimationFrame: callback => callback(),
        history: { replaceState() {}, pushState() {} },
        document: {
            body: getElement('body'), getElementById: getElement,
            querySelectorAll: selector => selector.startsWith('#word-meanings ') ? getElement('word-meanings').querySelectorAll(selector.split(' ')[1]) : getElement('folder-selection-container').querySelectorAll(selector),
            querySelector: selector => getElement(selector),
            addEventListener() {}, createElement: tag => element(tag)
        },
        window: {
            location: 'https://example.test/?page=library', scrollTo() {},
            crypto: require('node:crypto').webcrypto, speechSynthesis: { cancel() {} },
            addEventListener() {}
        },
        initializeApp: () => ({}), getAuth: () => auth, getFirestore: () => ({}),
        GoogleAuthProvider: function GoogleAuthProvider() {},
        onAuthStateChanged: (_auth, callback, error) => { events.authCallback = callback; events.authError = error; },
        signInWithPopup: async () => ({}), signOut: async () => {},
        collection: (db, ...parts) => ({ path: [db?.path, ...parts].filter(Boolean).join('/') }),
        doc: (db, ...parts) => ({ path: [db?.path, ...parts].filter(Boolean).join('/') }),
        getDoc: async () => emptySnapshot, getDocs: async () => ({ docs: [] }),
        onSnapshot: () => () => {},
        runTransaction: async () => { throw new Error('Unexpected live transaction in test'); },
        writeBatch: () => { throw new Error('Unexpected live batch in test'); },
        deleteField: () => ({ __deleteField: true }),
        fetch: async () => { throw new Error('Unexpected live fetch in test'); },
        ...firebase,
        __events: events
    });
    const run = code => vm.runInContext(code, context, { filename: 'app-test-harness.js' });
    for (const filename of ['word-data.js', 'migration.js', 'persistence.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, 'assets', filename), 'utf8'), context, { filename: `assets/${filename}` });
    }
    const source = fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8').replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm, '');
    vm.runInContext(source, context, { filename: 'assets/app.js' });
    if (injectedPersistence !== undefined) {
        context.__injectedPersistence = injectedPersistence;
        run('persistence = __injectedPersistence;');
    }
    run(`
        refreshSearchSuggestionsForCurrentData = () => {};
        closeSearchSuggestions = () => { searchSuggestions = []; };
        updateAuthUI = () => {};
        applyBgmSettingsToElement = () => {};
        rerenderVisibleView = () => __events.renders.push(JSON.parse(JSON.stringify(state.words)));
        showView = page => __events.views.push({page, words: JSON.parse(JSON.stringify(state.words))});
        initializeModalAccessibility = () => {};
        setupAudioSystem = () => {};
        setupBgmAutoplayUnlock = () => {};
        startUserRevisionListener = () => {};
    `);
    return {
        context, run, elements, auth, events,
        setMeanings(groups) {
            getElement('word-meanings').replaceChildren(...groups.map(group => {
                const row = element('div'); row.className = 'meaning-group';
                row.append(Object.assign(element('select'), {className:'meaning-pos',value:group.partOfSpeech}),
                    Object.assign(element('textarea'), {className:'meaning-definitions',value:group.definitions.join('；')}));
                return row;
            }));
        },
        fireSyncTimeouts() {
            const callbacks = [...syncTimeouts.values()]; syncTimeouts.clear(); callbacks.forEach(callback => callback());
        },
        async flush() { for (let step = 0; step < 100; step += 1) await Promise.resolve(); }
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
}

// Firestore-shaped in-memory storage: no SDK credentials or network are used.
// Recursive merges and deleteField sentinels preserve real sparse-write semantics.
function createMemoryFirestore(initialDocuments = {}) {
    const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const documents = new Map(Object.entries(copy(initialDocuments)));
    const writes = [];
    const reads = [];
    const snapshot = reference => {
        const data = copy(documents.get(reference.path));
        return { id: reference.path.split('/').pop(), ref: reference, exists: () => data !== undefined, data: () => copy(data) };
    };
    const merge = (target, source) => {
        const result = copy(target || {});
        for (const [key, value] of Object.entries(source)) {
            if (value?.__deleteField) delete result[key];
            else if (value && typeof value === 'object' && !Array.isArray(value)) {
                result[key] = Object.keys(value).length ? merge(result[key], value) : {};
            } else result[key] = copy(value);
        }
        return result;
    };
    const apply = operation => {
        writes.push(copy(operation));
        if (operation.type === 'delete') documents.delete(operation.path);
        else documents.set(operation.path, merge(operation.merge ? documents.get(operation.path) : {}, operation.data));
    };
    const writer = pending => ({
        set(reference, data, options = {}) { pending.push({ type: 'set', path: reference.path, data: copy(data), merge: !!options.merge }); return this; },
        delete(reference) { pending.push({ type: 'delete', path: reference.path }); return this; },
        update(reference, data) { pending.push({ type: 'set', path: reference.path, data: copy(data), merge: true }); return this; }
    });
    const firebase = {
        getDoc: async reference => { reads.push(reference.path); return snapshot(reference); },
        getDocs: async reference => {
            reads.push(reference.path);
            const prefix = `${reference.path}/`;
            const docs = [...documents.keys()].filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
                .map(path => snapshot({ path }));
            return { docs, size: docs.length, empty: docs.length === 0 };
        },
        runTransaction: async (_db, callback) => {
            const pending = [];
            const result = await callback({ ...writer(pending), get: firebase.getDoc });
            pending.forEach(apply);
            return result;
        },
        writeBatch: () => {
            const pending = [];
            return { ...writer(pending), async commit() { pending.forEach(apply); } };
        }
    };
    return { firebase, documents, writes, reads };
}

module.exports = { createAppHarness, createMemoryFirestore, deferred };
