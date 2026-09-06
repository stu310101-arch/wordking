const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

function element(id) {
    const classes = new Set();
    const attributes = new Map();
    return {
        id, hidden: false, inert: false, dataset: {}, value: '', textContent: '', children: [],
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
        querySelectorAll: () => [], querySelector: () => null,
        replaceChildren(...children) { this.children = children; this.textContent = ''; },
        addEventListener() {}, removeEventListener() {}, focus() {}, pause() {},
        appendChild(child) { this.children.push(child); },
        getClientRects: () => [1], getBoundingClientRect: () => ({ width: 390, top: 0, left: 0 })
    };
}

function createAppHarness({ firebase = {} } = {}) {
    const elements = new Map();
    const getElement = id => {
        if (!elements.has(id)) elements.set(id, element(id));
        return elements.get(id);
    };
    const events = { views: [], alerts: [], errors: [], authCallback: null };
    const auth = { currentUser: null };
    const syncTimeouts = new Map();
    let nextTimer = 1;
    const emptySnapshot = { exists: () => false, data: () => ({}) };
    const context = vm.createContext({
        console: { log() {}, warn() {}, error: (...args) => events.errors.push(args) },
        URL, Date, Promise, setTimeout(callback, delay) {
            if (delay === 15000) { const id = nextTimer++; syncTimeouts.set(id, callback); return id; }
            const timer = setTimeout(callback, delay); timer.unref(); return timer;
        },
        clearTimeout(id) { if (syncTimeouts.has(id)) syncTimeouts.delete(id); else clearTimeout(id); },
        alert: message => events.alerts.push(message), confirm: () => true,
        requestAnimationFrame: callback => callback(),
        history: { replaceState() {}, pushState() {} },
        document: {
            body: getElement('body'), getElementById: getElement,
            querySelectorAll: () => [], querySelector: () => null,
            addEventListener() {}, createElement: tag => element(tag)
        },
        window: {
            location: 'https://example.test/?page=library', scrollTo() {},
            crypto: { randomUUID: () => 'test-uuid' }, speechSynthesis: { cancel() {} },
            addEventListener() {}
        },
        initializeApp: () => ({}), getAuth: () => auth, getFirestore: () => ({}),
        GoogleAuthProvider: function GoogleAuthProvider() {},
        onAuthStateChanged: (_auth, callback, error) => { events.authCallback = callback; events.authError = error; },
        signInWithPopup: async () => ({}), signOut: async () => {},
        collection: (_db, ...parts) => ({ path: parts.join('/') }),
        doc: (_db, ...parts) => ({ path: parts.join('/') }),
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
    vm.runInContext(fs.readFileSync(path.join(root, 'assets/word-data.js'), 'utf8'), context);
    const source = fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8').replace(/^import[\s\S]*?from\s+"[^"]+";\s*/gm, '');
    vm.runInContext(source, context, { filename: 'assets/app.js' });
    run(`
        refreshFolders = () => {};
        refreshSearchSuggestionsForCurrentData = () => {};
        closeSearchSuggestions = () => { searchSuggestions = []; };
        updateAuthUI = () => {};
        applyBgmSettingsToElement = () => {};
        rerenderVisibleView = () => {};
        showView = page => __events.views.push({page, words: JSON.parse(JSON.stringify(state.words))});
        initializeModalAccessibility = () => {};
        setupAudioSystem = () => {};
        setupBgmAutoplayUnlock = () => {};
        startUserRevisionListener = () => {};
    `);
    return {
        context, run, elements, auth, events,
        fireSyncTimeouts() {
            const callbacks = [...syncTimeouts.values()]; syncTimeouts.clear(); callbacks.forEach(callback => callback());
        },
        async flush() { for (let step = 0; step < 25; step += 1) await Promise.resolve(); }
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    return { promise, resolve, reject };
}

module.exports = { createAppHarness, deferred };
