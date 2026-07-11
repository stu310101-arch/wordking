const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeClassList {
    constructor(owner) {
        this.owner = owner;
    }

    values() {
        return new Set(String(this.owner.className || '').split(/\s+/).filter(Boolean));
    }

    write(values) {
        this.owner.className = Array.from(values).join(' ');
    }

    add(...tokens) {
        const values = this.values();
        tokens.forEach(token => values.add(token));
        this.write(values);
    }

    remove(...tokens) {
        const values = this.values();
        tokens.forEach(token => values.delete(token));
        this.write(values);
    }

    contains(token) {
        return this.values().has(token);
    }

    toggle(token, force) {
        const values = this.values();
        const enabled = force === undefined ? !values.has(token) : !!force;
        if (enabled) values.add(token);
        else values.delete(token);
        this.write(values);
        return enabled;
    }

    replace(oldToken, newToken) {
        const values = this.values();
        if (!values.delete(oldToken)) return false;
        values.add(newToken);
        this.write(values);
        return true;
    }
}

class FakeTextNode {
    constructor(text) {
        this.nodeType = 3;
        this.textContent = String(text ?? '');
        this.parentElement = null;
    }
}

class FakeElement {
    constructor(tagName = 'div') {
        this.nodeType = 1;
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.attributes = new Map();
        this.className = '';
        this.classList = new FakeClassList(this);
        this.dataset = {};
        this.style = {};
        this.hidden = false;
        this.inert = false;
        this.id = '';
        this.value = '';
        this.scrollTop = 0;
        this.clientHeight = 320;
        this.offsetTop = 0;
        this.offsetHeight = 64;
        this.parentElement = null;
        this.listeners = new Map();
        this._textContent = '';
        this.rect = { left: 120, right: 248, width: 128, top: 0, bottom: 32, height: 32 };
    }

    set textContent(value) {
        this._textContent = String(value ?? '');
        this.children = [];
    }

    get textContent() {
        return this._textContent + this.children.map(child => child.textContent || '').join('');
    }

    appendChild(child) {
        child.parentElement = this;
        if (this.id === 'search-suggestions' && child.getAttribute?.('role') === 'option') {
            const optionCount = this.children.filter(item => item.getAttribute?.('role') === 'option').length;
            child.offsetTop = optionCount * 64;
            child.offsetHeight = 64;
        }
        this.children.push(child);
        return child;
    }

    append(...children) {
        children.forEach(child => this.appendChild(child));
    }

    replaceChildren(...children) {
        this._textContent = '';
        this.children = [];
        this.append(...children);
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    toggleAttribute(name, force) {
        if (force) this.attributes.set(name, '');
        else this.attributes.delete(name);
    }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }

    dispatch(type, event = {}) {
        (this.listeners.get(type) || []).forEach(listener => listener({ target: this, ...event }));
    }

    click() {
        this.dispatch('click');
    }

    querySelectorAll(selector) {
        const matches = [];
        const visit = element => {
            if (!(element instanceof FakeElement)) return;
            if (selector === '[role="option"]' && element.getAttribute('role') === 'option') {
                matches.push(element);
            }
            element.children.forEach(visit);
        };
        this.children.forEach(visit);
        return matches;
    }

    contains(target) {
        if (target === this) return true;
        return this.children.some(child => child instanceof FakeElement && child.contains(target));
    }

    getBoundingClientRect() {
        return { ...this.rect };
    }
}

function createSearchDom(document, viewportWidth = 390) {
    const control = new FakeElement('div');
    control.id = 'search-control';
    control.rect = { left: 120, right: 248, width: 128, top: 0, bottom: 32, height: 32 };
    const input = new FakeElement('input');
    input.id = 'search-input';
    input.rect = { ...control.rect };
    const listbox = new FakeElement('div');
    listbox.id = 'search-suggestions';
    listbox.className = 'hidden';
    listbox.hidden = true;
    listbox.clientHeight = 320;
    control.append(input, listbox);
    const elements = new Map([
        ['search-control', control],
        ['search-input', input],
        ['search-suggestions', listbox]
    ]);
    document.getElementById = id => elements.get(id) || null;
    document.documentElement = { clientWidth: viewportWidth };
    document.createElement = tagName => new FakeElement(tagName);
    document.createTextNode = text => new FakeTextNode(text);
    return { control, input, listbox, elements };
}

function serializeFakeNode(node) {
    if (node instanceof FakeTextNode) return node.textContent;
    const content = node._textContent + node.children.map(serializeFakeNode).join('');
    if (node.tagName === 'MARK') return `<mark>${content}</mark>`;
    return content;
}

function loadWordKing() {
    const appPath = path.join(__dirname, '..', 'assets', 'app.js');
    let source = fs.readFileSync(appPath, 'utf8');
    source = source.slice(source.indexOf("const LESSON_MANIFEST_URL"));
    source += `
        const __originalSaveDiffChangesToCloud = saveDiffChangesToCloud;
        const __originalLoadUserDiffData = loadUserDiffData;
        const __originalNavigateToWord = navigateToWord;
        const __originalUpdateSearchSuggestions = updateSearchSuggestions;
        globalThis.__wordKingTest = {
            state,
            WRONG_FOLDER,
            UNFILED_FOLDER,
            cloneWord,
            applyFolderDeletion,
            wordIsInFolder,
            validateFolderName,
            findWordCardById,
            normalizeSearchQuery,
            normalizeEnglishSearchText,
            findOrderedMatchIndexes,
            getChineseMatchScore,
            findSearchMatches,
            appendHighlightedSubstring,
            appendHighlightedIndexes,
            createSearchSuggestionOption,
            updateSearchSuggestions,
            refreshSearchSuggestionsForCurrentData,
            closeSearchSuggestions,
            updateActiveSearchSuggestion,
            selectSearchSuggestion,
            handleSearchInput,
            handleSearchCompositionStart,
            handleSearchCompositionEnd,
            handleSearchOutsidePointerDown,
            handleSearchKeydown,
            applyUserData,
            confirmNewFolder,
            saveNewWord,
            executeRename,
            collectDiffOperations,
            commitBatchOperations,
            buildUserDataFromDiffs,
            createDefaultUserData,
            commitUserMutation,
            getFolderDisplayName,
            normalizePartOfSpeech,
            parseMeaning,
            getMeaningWithPartOfSpeech,
            saveReviewWords,
            confirmReset,
            clearPracticeSession,
            getFolderDeleteConfirmation,
            normalizeFolders,
            startUserRevisionListener,
            stopUserRevisionListener,
            setDefaults(words, lessonFolderIds) {
                defaultWordDatabase = cloneWords(words);
                defaultWordMap = new Map(defaultWordDatabase.map(word => [word.defaultId, cloneWord(word)]));
                defaultWordEnglishMap = new Map(defaultWordDatabase.map(word => [word.english.toLowerCase(), cloneWord(word)]));
                state.lessonFolderIds = [...lessonFolderIds];
            },
            setUser(user) {
                currentUser = user;
            },
            setSaver(saver) {
                saveDiffChangesToCloud = saver;
            },
            setWordNavigator(navigator) {
                navigateToWord = navigator;
            },
            setSearchUpdater(updater) {
                updateSearchSuggestions = updater;
            },
            restoreSearchDependencies() {
                navigateToWord = __originalNavigateToWord;
                updateSearchSuggestions = __originalUpdateSearchSuggestions;
            },
            getSearchState() {
                return {
                    suggestions: [...searchSuggestions],
                    activeIndex: activeSearchSuggestionIndex,
                    isComposing: isSearchComposing
                };
            },
            setCloudLoader(loader) {
                loadUserDiffData = loader;
            },
            setBatchFactory(factory) {
                createWriteBatch = factory;
            },
            setTransactionExecutor(executor) {
                executeTransaction = executor;
            },
            setRetryWaiter(waiter) {
                waitBeforeRetry = waiter;
            },
            setSnapshotSubscriber(subscriber) {
                subscribeToSnapshot = subscriber;
            },
            setCloudRevision(revision) {
                cloudRevision = revision;
                pendingRemoteRevision = 0;
            },
            getCloudSyncState() {
                return { cloudRevision, pendingRemoteRevision, activeCloudWrites };
            },
            disableNavigation() {
                navigateTo = () => {};
                showView = () => {};
            },
            reset() {
                stopUserRevisionListener();
                currentUser = null;
                isCloudLoading = false;
                cloudRevision = 0;
                pendingRemoteRevision = 0;
                activeCloudWrites = 0;
                saveDiffChangesToCloud = __originalSaveDiffChangesToCloud;
                loadUserDiffData = __originalLoadUserDiffData;
                createWriteBatch = database => writeBatch(database);
                executeTransaction = (database, updateFunction) => runTransaction(database, updateFunction);
                subscribeToSnapshot = (reference, onNext, onError) => onSnapshot(reference, onNext, onError);
                waitBeforeRetry = delay => new Promise(resolve => setTimeout(resolve, delay));
                navigateToWord = __originalNavigateToWord;
                updateSearchSuggestions = __originalUpdateSearchSuggestions;
                searchSuggestions = [];
                activeSearchSuggestionIndex = -1;
                isSearchComposing = false;
                searchSuggestionRenderId = 0;
                state.words = [];
                state.folders = [WRONG_FOLDER];
                state.folderIds = [WRONG_FOLDER];
                state.lessonFolderIds = [];
                state.settings = cloneSettings(DEFAULT_SETTINGS);
                clearPracticeSession();
            }
        };
    `;

    const alerts = [];
    const sandbox = {
        console: {
            log() {},
            warn() {},
            error() {}
        },
        document: {
            body: {},
            activeElement: null,
            addEventListener() {},
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            createElement: tagName => new FakeElement(tagName),
            createTextNode: text => new FakeTextNode(text),
            documentElement: { clientWidth: 390 }
        },
        window: {
            crypto: { randomUUID: () => 'test-uuid' },
            speechSynthesis: {},
            location: 'http://127.0.0.1:8000/?page=home',
            scrollTo() {},
            addEventListener() {},
            innerWidth: 390
        },
        history: { pushState() {} },
        location: {},
        navigator: {},
        alert(message) { alerts.push(String(message)); },
        confirm: () => true,
        requestAnimationFrame(callback) { callback(); },
        setTimeout,
        clearTimeout,
        URL,
        Option: function Option(text, value) {
            this.text = text;
            this.value = value;
        },
        initializeApp: () => ({}),
        getAuth: () => ({ currentUser: null }),
        getFirestore: () => ({}),
        GoogleAuthProvider: function GoogleAuthProvider() {},
        onAuthStateChanged() {},
        signInWithPopup: async () => {},
        signOut: async () => {},
        collection: (...parts) => ({ path: parts.slice(1).join('/') }),
        doc: (...parts) => ({ path: parts.slice(1).join('/') }),
        getDoc: async () => ({ exists: () => false }),
        getDocs: async () => ({ docs: [] }),
        onSnapshot: () => () => {},
        runTransaction: async (database, updateFunction) => updateFunction({
            get: async () => ({ exists: () => false, data: () => ({}) }),
            set() {},
            delete() {}
        }),
        writeBatch: () => ({
            set() {},
            delete() {},
            commit: async () => {}
        }),
        deleteField: () => '__DELETE_FIELD__',
        fetch: async () => ({ ok: true, json: async () => ({ lessons: [] }) })
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    return { api: sandbox.__wordKingTest, alerts, document: sandbox.document };
}

function applyOperations(operations) {
    const calls = [];
    const batch = {
        set(ref, data, options) {
            calls.push({ type: 'set', path: ref.path, data, options });
        },
        delete(ref) {
            calls.push({ type: 'delete', path: ref.path });
        }
    };
    operations.forEach(operation => operation(batch));
    return calls;
}

async function run() {
    const { api, alerts, document } = loadWordKing();
    const results = [];
    const recordSearch = (number, label, assertion) => {
        assertion();
        results.push(`SEARCH ${number} - ${label}`);
    };

    // BUG 1: the current product contract is one normal folder per word.
    {
        const legacy = api.cloneWord({
            id: 'apple',
            source: 'custom',
            english: 'apple',
            tags: ['A-folder', 'B-folder']
        });
        assert.equal(legacy.folderId, 'A-folder');
        assert.equal(Object.hasOwn(legacy, 'tags'), false);

        const moved = { ...legacy, folderId: 'B-folder' };
        const afterDeleteA = api.applyFolderDeletion([moved], 'A-folder', true);
        assert.equal(afterDeleteA.length, 1);
        assert.equal(afterDeleteA[0].folderId, 'B-folder');
        results.push('BUG 1 - single-folder invariant');
    }

    // BUG 2: keeping a word after folder deletion exposes it through Unfiled.
    {
        const word = {
            id: 'apple',
            source: 'custom',
            english: 'apple',
            meaning: 'fruit',
            folderId: 'A-folder',
            isWrong: false
        };
        const kept = api.applyFolderDeletion([word], 'A-folder', false);
        assert.equal(kept.length, 1);
        assert.equal(kept[0].folderId, '');
        assert.equal(api.wordIsInFolder(kept[0], api.UNFILED_FOLDER), true);
        results.push('BUG 2 - unfiled navigation');
    }

    // BUG 3: deleting a default word writes a tombstone and blocks resurrection.
    {
        const defaults = [{
            id: 'default-apple',
            defaultId: 'default-apple',
            source: 'default',
            english: 'apple',
            meaning: 'fruit',
            folderId: 'Lesson-1',
            isWrong: false
        }];
        api.setDefaults(defaults, ['Lesson-1']);
        const before = api.createDefaultUserData();
        const after = { ...before, words: [] };
        const calls = applyOperations(api.collectDiffOperations(before, after, { uid: 'user-1' }));
        assert.equal(calls.some(call => call.type === 'set' && call.path.endsWith('deletedDefaults/default-apple')), true);

        const reloaded = api.buildUserDataFromDiffs({
            deletedDefaultIds: ['default-apple']
        });
        assert.equal(reloaded.words.some(word => word.id === 'default-apple'), false);
        results.push('BUG 3 - default deletion tombstone');
    }

    // BUG 4: DOM lookup follows the word selected by data logic, not query text.
    {
        const appleCard = { dataset: { wordId: 'word-apple' }, innerText: 'apple fruit' };
        const bananaCard = { dataset: { wordId: 'word-banana' }, innerText: 'banana yellow fruit' };
        const found = api.findWordCardById([appleCard, bananaCard], 'word-apple');
        assert.equal(found, appleCard);
        results.push('BUG 4 - exact search card');
    }

    // BUG 5: every folder entry point shares the same reserved-name rules.
    {
        api.reset();
        api.state.folders = [api.WRONG_FOLDER, 'Existing'];
        ['A', 'z', 'F', 'H'].forEach(name => {
            assert.equal(api.validateFolderName(name).valid, false);
        });
        assert.equal(api.validateFolderName(api.WRONG_FOLDER).valid, false);
        assert.equal(api.validateFolderName(api.UNFILED_FOLDER).valid, false);
        assert.equal(api.validateFolderName('Existing').valid, false);
        ['TOEIC', 'Lesson 1', '旅遊', 'F words'].forEach(name => {
            const validFolder = api.validateFolderName(name);
            assert.equal(validFolder.valid, true);
            assert.equal(validFolder.name, name);
        });

        const migrated = api.cloneWord({
            id: 'legacy',
            english: 'legacy',
            tags: ['F']
        });
        assert.equal(migrated.folderId, '');

        const elements = new Map([
            ['input-new-folder-name', { value: 'F' }],
            ['new-word', { value: 'apple' }],
            ['new-meaning', { value: 'fruit' }],
            ['new-folder-name', { value: 'F' }],
            ['wrong-checkbox', { checked: false }],
            ['input-rename-folder', { value: 'F' }]
        ]);
        document.getElementById = id => elements.get(id) || null;
        document.querySelector = () => null;
        api.setUser({ uid: 'user-1' });
        api.setSaver(async () => true);

        await api.confirmNewFolder();
        assert.equal(api.state.folders.includes('F'), false);

        await api.saveNewWord();
        assert.equal(api.state.words.some(word => word.english === 'apple'), false);

        api.state.words = [{
            id: 'custom-apple',
            source: 'custom',
            english: 'apple',
            meaning: 'fruit',
            folderId: 'Existing',
            isWrong: false
        }];
        api.state.isEditing = true;
        api.state.editingWordIndex = 0;
        await api.saveNewWord();
        assert.equal(api.state.words[0].folderId, 'Existing');

        api.state.folders.push('Existing');
        api.state.targetFolderAction = 'Existing';
        await api.executeRename();
        assert.equal(api.state.folders.includes('F'), false);
        assert.equal(api.state.folders.includes('Existing'), true);

        document.getElementById = () => null;
        document.querySelector = () => null;
        results.push('BUG 5 - shared folder validation');
    }

    // BUG 6: a rejected cloud write restores state and reports failure.
    {
        api.reset();
        api.state.words = [{
            id: 'apple',
            source: 'custom',
            english: 'apple',
            meaning: 'fruit',
            folderId: 'A-folder',
            isWrong: false
        }];
        api.state.folders = [api.WRONG_FOLDER, 'A-folder'];
        api.setUser({ uid: 'user-1' });
        api.setSaver(async () => {
            throw new Error('forced failure');
        });

        const saved = await api.commitUserMutation(draft => {
            draft.words = [];
            draft.folders = [api.WRONG_FOLDER];
        });
        assert.equal(saved, false);
        assert.equal(api.state.words.length, 1);
        assert.equal(api.state.words[0].english, 'apple');
        assert.equal(api.state.folders.includes('A-folder'), true);
        assert.equal(alerts.some(message => message.includes('forced failure')), true);
        results.push('BUG 6 - mutation rollback');
    }

    // BUG 7: built-in lessons keep a stable ID and load only the display override.
    {
        const defaults = [{
            id: 'lesson-apple',
            defaultId: 'lesson-apple',
            source: 'default',
            english: 'apple',
            meaning: 'fruit',
            folderId: 'Lesson-1',
            isWrong: false
        }];
        api.setDefaults(defaults, ['Lesson-1']);
        const settings = {
            bgmEnabled: true,
            bgmVolume: 0.5,
            speechVolume: 1,
            selectedBgmId: 'bgm_new_dora',
            lessonFolderNames: { 'Lesson-1': 'Renamed' },
            deletedLessonIds: []
        };
        const reloaded = api.buildUserDataFromDiffs({ settings });
        assert.equal(api.getFolderDisplayName('Lesson-1', settings), 'Renamed');
        assert.equal(reloaded.folders.filter(folder => folder === 'Lesson-1').length, 1);
        assert.equal(reloaded.folders.includes('Renamed'), false);
        assert.equal(reloaded.words[0].folderId, 'Lesson-1');
        results.push('BUG 7 - lesson display override');
    }

    // UX 5: marking a word for review changes only isWrong, never its folder.
    {
        api.reset();
        api.disableNavigation();
        const word = {
            id: 'custom-apple',
            source: 'custom',
            english: 'apple',
            meaning: '蘋果',
            folderId: 'Fruit',
            isWrong: false
        };
        api.state.words = [word];
        api.state.folders = [api.WRONG_FOLDER, 'Fruit'];
        api.state.game.reviewSelection = [word];
        api.setUser({ uid: 'user-1' });
        api.setSaver(async () => true);

        await api.saveReviewWords();
        assert.equal(api.state.words[0].isWrong, true);
        assert.equal(api.state.words[0].folderId, 'Fruit');
        results.push('UX 5 - review preserves folder');
    }

    // UX 6: optional structured POS coexists with the legacy combined meaning.
    {
        assert.equal(api.normalizePartOfSpeech('noun'), 'noun');
        assert.equal(api.normalizePartOfSpeech('n.'), '');

        const legacy = api.parseMeaning('蘋果 (n.)');
        assert.equal(legacy.length, 1);
        assert.equal(legacy[0].text, '蘋果');
        assert.equal(legacy[0].pos, '(n.)');

        const structured = api.parseMeaning('蘋果', 'noun');
        assert.equal(structured.length, 1);
        assert.equal(structured[0].text, '蘋果');
        assert.equal(structured[0].pos, '(n.)');
        assert.equal(api.getMeaningWithPartOfSpeech({ meaning: '蘋果', partOfSpeech: 'noun' }), '蘋果 (n.)');
        assert.equal(api.getMeaningWithPartOfSpeech({ meaning: '蘋果 (n.)', partOfSpeech: 'noun' }), '蘋果 (n.)');

        api.setDefaults([], []);
        const before = api.createDefaultUserData();
        const after = {
            ...before,
            words: [{
                id: 'custom-apple',
                source: 'custom',
                english: 'apple',
                meaning: '蘋果',
                partOfSpeech: 'noun',
                folderId: '',
                isWrong: false
            }]
        };
        const calls = applyOperations(api.collectDiffOperations(before, after, { uid: 'user-1' }));
        const customWrite = calls.find(call => call.type === 'set' && call.path.endsWith('customWords/custom-apple'));
        assert.ok(customWrite);
        assert.equal(customWrite.data.partOfSpeech, 'noun');

        const defaultWord = {
            id: 'default-apple',
            defaultId: 'default-apple',
            source: 'default',
            english: 'apple',
            meaning: '蘋果',
            partOfSpeech: '',
            folderId: 'Lesson-1',
            isWrong: false
        };
        api.setDefaults([defaultWord], ['Lesson-1']);
        const defaultBefore = api.createDefaultUserData();
        const defaultAfter = {
            ...defaultBefore,
            words: defaultBefore.words.map(word => ({ ...word, partOfSpeech: 'noun' }))
        };
        const overrideCalls = applyOperations(api.collectDiffOperations(defaultBefore, defaultAfter, { uid: 'user-1' }));
        const overrideWrite = overrideCalls.find(call => call.type === 'set' && call.path.endsWith('wordOverrides/default-apple'));
        assert.ok(overrideWrite);
        assert.equal(overrideWrite.data.partOfSpeech, 'noun');
        assert.equal(Object.hasOwn(overrideWrite.data, 'english'), false);
        assert.equal(Object.hasOwn(overrideWrite.data, 'meaning'), false);
        results.push('UX 6 - optional POS compatibility');
    }

    // VERIFY 3: resetting user data also clears every active practice-session field.
    {
        const defaults = [{
            id: 'default-apple',
            defaultId: 'default-apple',
            source: 'default',
            english: 'apple',
            meaning: '蘋果 (n.)',
            folderId: 'Lesson-1',
            isWrong: false
        }];
        api.setDefaults(defaults, ['Lesson-1']);
        api.reset();
        api.state.words = [{
            id: 'custom-banana',
            source: 'custom',
            english: 'banana',
            meaning: '香蕉 (n.)',
            folderId: 'Fruit',
            isWrong: true
        }];
        api.state.folders = [api.WRONG_FOLDER, 'Fruit'];
        api.state.game.mode = 'spelling';
        api.state.game.currentWords = [...api.state.words];
        api.state.game.index = 3;
        api.state.game.wrongWords = new Set(api.state.words);
        api.state.game.reviewSelection = [...api.state.words];
        api.state.game.answeredHistory = [{ word: api.state.words[0] }];
        api.state.game.viewingHistoryIndex = 0;
        api.state.game.currentChoiceOptions = [...api.state.words];
        api.state.game.currentHadMistake = true;
        api.state.game.spellingDrafts = { 0: 'ban' };
        api.setUser({ uid: 'user-1' });
        api.setSaver(async () => true);

        await api.confirmReset();
        assert.equal(api.state.words.length, 1);
        assert.equal(api.state.words[0].source, 'default');
        assert.equal(api.state.game.mode, '');
        assert.equal(api.state.game.currentWords.length, 0);
        assert.equal(api.state.game.index, 0);
        assert.equal(api.state.game.wrongWords.size, 0);
        assert.equal(api.state.game.reviewSelection.length, 0);
        assert.equal(api.state.game.answeredHistory.length, 0);
        assert.equal(api.state.game.viewingHistoryIndex, null);
        assert.equal(api.state.game.currentChoiceOptions.length, 0);
        assert.equal(api.state.game.currentHadMistake, false);
        assert.equal(Object.keys(api.state.game.spellingDrafts).length, 0);
        results.push('VERIFY 3 - reset clears practice');
    }

    // UX 7: folder deletion copy uses the real folder name and affected count.
    {
        api.reset();
        api.state.words = [
            { id: 'one', source: 'custom', english: 'one', meaning: '一', folderId: 'TOEIC', isWrong: false },
            { id: 'two', source: 'custom', english: 'two', meaning: '二', folderId: 'TOEIC', isWrong: true },
            { id: 'three', source: 'custom', english: 'three', meaning: '三', folderId: 'Other', isWrong: false }
        ];
        api.state.folders = [api.WRONG_FOLDER, 'TOEIC', 'Other'];

        const keep = api.getFolderDeleteConfirmation('TOEIC', false);
        assert.equal(keep.title.includes('TOEIC'), true);
        assert.equal(keep.description.includes('2'), true);
        assert.equal(keep.description.includes(api.UNFILED_FOLDER), true);

        const remove = api.getFolderDeleteConfirmation('TOEIC', true);
        assert.equal(remove.title.includes('TOEIC'), true);
        assert.equal(remove.description.includes('2'), true);
        assert.equal(remove.description.includes('無法復原'), true);
        assert.equal(remove.submitLabel.includes('2'), true);
        results.push('UX 7 - dynamic delete copy');
    }

    // BUG 8: diff-storage subcollections remain accessible to their owning user.
    {
        const repoRoot = path.join(__dirname, '..');
        const firebaseConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'firebase.json'), 'utf8'));
        const firestoreRules = fs.readFileSync(path.join(repoRoot, 'firestore.rules'), 'utf8');

        assert.equal(firebaseConfig.firestore.rules, 'firestore.rules');
        assert.match(firestoreRules, /match \/users\/\{userId\}/);
        assert.match(firestoreRules, /match \/\{document=\*\*\}/);
        assert.match(firestoreRules, /request\.auth != null && request\.auth\.uid == userId/);
        results.push('BUG 8 - Firestore diff subcollection access');
    }

    // BUG 9: a later large-write chunk failure is reported as a partial commit.
    {
        api.reset();
        const rootData = { revision: 0 };
        const successfulOperationWrites = [];
        let batchCount = 0;
        const makeSnapshot = () => ({
            exists: () => true,
            data: () => ({ ...rootData })
        });
        const applyRootPatch = data => {
            Object.entries(data).forEach(([key, value]) => {
                if (value === '__DELETE_FIELD__') delete rootData[key];
                else rootData[key] = value;
            });
        };

        api.setTransactionExecutor(async (database, updateFunction) => updateFunction({
            get: async () => makeSnapshot(),
            set(ref, data) {
                if (ref.path === 'users/user-1') applyRootPatch(data);
            },
            delete() {}
        }));
        api.setBatchFactory(() => {
            batchCount += 1;
            const currentBatch = batchCount;
            const writes = [];
            return {
                set(ref, data, options) { writes.push({ ref, data, options }); },
                delete(ref) { writes.push({ ref, deleted: true }); },
                async commit() {
                    if (currentBatch > 1) throw new Error('forced second chunk failure');
                    writes.forEach(write => {
                        if (write.ref.path === 'users/user-1') applyRootPatch(write.data);
                        else successfulOperationWrites.push(write.ref.path);
                    });
                }
            };
        });
        api.setRetryWaiter(async () => {});

        const operations = Array.from({ length: 441 }, (_, index) => batch => {
            batch.set({ path: `items/${index}` }, { index });
        });
        let failure = null;
        try {
            await api.commitBatchOperations(operations, { uid: 'user-1' }, 0);
        } catch (error) {
            failure = error;
        }

        assert.ok(failure);
        assert.equal(failure.code, 'cloud-partial-commit');
        assert.equal(failure.committedChunks, 1);
        assert.equal(failure.totalChunks, 2);
        assert.equal(batchCount, 4);
        assert.equal(successfulOperationWrites.length, 440);
        assert.equal(rootData.revision, 1);
        assert.equal(Object.hasOwn(rootData, 'syncLock'), false);
        results.push('BUG 9 - partial multi-batch failure');
    }

    // BUG 10: after a partial commit, UI state reloads cloud truth instead of rolling back everything.
    {
        api.reset();
        const previousWord = {
            id: 'custom-before',
            source: 'custom',
            english: 'before',
            meaning: '舊資料',
            folderId: 'Old',
            isWrong: false
        };
        const cloudWord = {
            id: 'custom-cloud',
            source: 'custom',
            english: 'cloud',
            meaning: '雲端實況',
            folderId: 'Cloud',
            isWrong: false
        };
        api.state.words = [previousWord];
        api.state.folders = [api.WRONG_FOLDER, 'Old'];
        api.setUser({ uid: 'user-1' });
        api.setCloudRevision(7);
        api.setCloudLoader(async () => ({
            words: [cloudWord],
            folders: [api.WRONG_FOLDER, 'Cloud'],
            settings: api.state.settings,
            revision: 8
        }));
        api.setSaver(async () => {
            const error = new Error('forced partial commit');
            error.code = 'cloud-partial-commit';
            throw error;
        });

        const saved = await api.commitUserMutation(draft => {
            draft.words = [];
            draft.folders = [api.WRONG_FOLDER];
        });
        assert.equal(saved, false);
        assert.equal(api.state.words.length, 1);
        assert.equal(api.state.words[0].english, 'cloud');
        assert.equal(api.state.folders.includes('Cloud'), true);
        assert.equal(api.getCloudSyncState().cloudRevision, 8);
        assert.equal(alerts.some(message => message.includes('部分資料可能已同步，已重新載入雲端狀態')), true);
        results.push('BUG 10 - partial commit reloads cloud truth');
    }

    // BUG 11: stale tabs cannot write over a newer revision and receive remote-version notice.
    {
        api.reset();
        let transactionWrites = 0;
        api.setTransactionExecutor(async (database, updateFunction) => updateFunction({
            get: async () => ({ exists: () => true, data: () => ({ revision: 4 }) }),
            set() { transactionWrites += 1; },
            delete() { transactionWrites += 1; }
        }));
        let conflict = null;
        try {
            await api.commitBatchOperations([
                transaction => transaction.set({ path: 'items/stale' }, { stale: true })
            ], { uid: 'user-1' }, 3);
        } catch (error) {
            conflict = error;
        }
        assert.ok(conflict);
        assert.equal(conflict.code, 'cloud-revision-conflict');
        assert.equal(transactionWrites, 0);

        let snapshotHandler = null;
        let unsubscribed = false;
        api.setUser({ uid: 'user-1' });
        api.setCloudRevision(4);
        api.setSnapshotSubscriber((reference, onNext) => {
            snapshotHandler = onNext;
            return () => { unsubscribed = true; };
        });
        api.startUserRevisionListener({ uid: 'user-1' });
        snapshotHandler({ exists: () => true, data: () => ({ revision: 5 }) });
        assert.equal(api.getCloudSyncState().pendingRemoteRevision, 5);
        api.stopUserRevisionListener();
        assert.equal(unsubscribed, true);
        results.push('BUG 11 - revision conflict and remote notice');
    }

    // BUG 12: the manual cloud action reloads current cloud data instead of uploading from defaults.
    {
        const appSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app.js'), 'utf8');
        const syncStart = appSource.indexOf('async function syncCloudNow()');
        const syncEnd = appSource.indexOf('function rerenderVisibleView()', syncStart);
        const syncSource = appSource.slice(syncStart, syncEnd);
        assert.match(syncSource, /loadFromCloud\(currentUser\)/);
        assert.doesNotMatch(syncSource, /saveDiffChangesToCloud|createDefaultUserData/);
        results.push('BUG 12 - manual action reloads cloud');
    }

    // A11Y / production CSS: zoom remains available and Tailwind is served as a built asset.
    {
        const repoRoot = path.join(__dirname, '..');
        const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
        const tailwindCss = fs.readFileSync(path.join(repoRoot, 'assets', 'tailwind.css'), 'utf8');
        assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1\.0/);
        assert.doesNotMatch(html, /cdn\.tailwindcss\.com/);
        assert.match(html, /<link rel="stylesheet" href="\.\/assets\/tailwind\.css">/);
        assert.match(html, /id="btn-search"[^>]*aria-label="搜尋單字"/);
        assert.match(html, /id="btn-home-brand"[^>]*type="button"/);
        assert.match(html, /id="search-input"[\s\S]{0,300}role="combobox"/);
        assert.match(html, /aria-controls="search-suggestions"/);
        assert.match(html, /id="search-suggestions"[\s\S]{0,200}role="listbox"/);
        assert.match(tailwindCss, /\.bg-indigo-600/);
        results.push('A11Y - semantic controls and compiled Tailwind');
    }

    // SEARCH 1-53: live matching, highlighting, listbox behavior, IME, and refresh hooks.
    {
        const makeWord = (id, english, meaning, folderId = 'Search') => ({
            id,
            source: 'custom',
            english,
            meaning,
            folderId,
            isWrong: false
        });
        const englishWords = [
            makeWord('adorable', 'adorable', '可愛的'),
            makeWord('adore', 'adore', '喜愛'),
            makeWord('apoint', 'apoint', '指定'),
            makeWord('apple', 'apple', '蘋果'),
            makeWord('asset', 'asset', '資產')
        ];
        const chineseWords = [
            makeWord('science', 'science', '科學'),
            makeWord('science-fair', 'science fair', '科展'),
            makeWord('technology', 'technology', '科技'),
            makeWord('science-exhibition', 'science exhibition', '科學展'),
            makeWord('apple-company', 'apple company', '蘋果公司'),
            makeWord('company', 'company', '公司')
        ];
        const englishResults = query => Array.from(
            api.findSearchMatches(query, englishWords),
            candidate => candidate.word.english
        );
        const chineseResults = query => Array.from(
            api.findSearchMatches(query, chineseWords),
            candidate => candidate.word.meaning
        );

        recordSearch(1, 'ador matches adorable and adore', () => {
            assert.deepEqual(englishResults('ador'), ['adorable', 'adore']);
        });
        recordSearch(2, 'or matches adorable and adore', () => {
            assert.deepEqual(englishResults('or'), ['adorable', 'adore']);
        });
        recordSearch(3, 'ore matches adore', () => {
            assert.deepEqual(englishResults('ore'), ['adore']);
        });
        recordSearch(4, 'ble matches adorable', () => {
            assert.deepEqual(englishResults('ble'), ['adorable']);
        });
        recordSearch(5, 'aor does not use skip matching', () => {
            assert.deepEqual(englishResults('aor'), []);
        });
        recordSearch(6, 'ae does not match adore', () => {
            assert.deepEqual(englishResults('ae'), []);
        });
        recordSearch(7, 'English matching is case insensitive', () => {
            assert.deepEqual(englishResults('ADOR'), ['adorable', 'adore']);
        });
        recordSearch(8, 'OR and or return the same results', () => {
            assert.deepEqual(englishResults('OR'), englishResults('or'));
        });
        recordSearch(9, 'English results use A-Z ordering', () => {
            assert.deepEqual(englishResults('a'), ['adorable', 'adore', 'apoint', 'apple', 'asset']);
        });
        recordSearch(10, 'Second English character narrows immediately', () => {
            assert.equal(englishResults('a').length, 5);
            assert.deepEqual(englishResults('ap'), ['apoint', 'apple']);
        });

        recordSearch(11, 'Single Chinese character matches every ordered result', () => {
            assert.deepEqual(
                new Set(chineseResults('科')),
                new Set(['科學', '科展', '科技', '科學展'])
            );
        });
        recordSearch(12, '科展 narrows to 科展 and 科學展', () => {
            assert.deepEqual(chineseResults('科展'), ['科展', '科學展']);
        });
        recordSearch(13, 'Reversed Chinese order does not match', () => {
            assert.deepEqual(chineseResults('展科'), []);
        });
        recordSearch(14, 'Chinese ordered indexes are exact', () => {
            assert.deepEqual(Array.from(api.findOrderedMatchIndexes('科學展', '科展')), [0, 2]);
        });
        recordSearch(15, '蘋司 matches 蘋果公司', () => {
            assert.deepEqual(chineseResults('蘋司'), ['蘋果公司']);
        });
        recordSearch(16, '公司 matches exact and embedded meanings', () => {
            assert.deepEqual(chineseResults('公司'), ['公司', '蘋果公司']);
        });
        recordSearch(17, 'Exact Chinese result sorts before skipped result', () => {
            assert.deepEqual(chineseResults('科展'), ['科展', '科學展']);
        });
        recordSearch(18, 'Second Chinese character narrows immediately', () => {
            assert.equal(chineseResults('科').length, 4);
            assert.deepEqual(chineseResults('科展'), ['科展', '科學展']);
        });

        createSearchDom(document);
        const englishHighlight = new FakeElement('span');
        api.appendHighlightedSubstring(englishHighlight, 'adorable', 2, 2);
        recordSearch(19, 'English highlight creates one mark for the real substring', () => {
            assert.equal(englishHighlight.children.filter(child => child.tagName === 'MARK').length, 1);
        });
        recordSearch(20, 'English highlight output is ad<mark>or</mark>able', () => {
            assert.equal(serializeFakeNode(englishHighlight), 'ad<mark>or</mark>able');
        });
        const chineseHighlight = new FakeElement('span');
        api.appendHighlightedIndexes(chineseHighlight, '科學展', [0, 2]);
        recordSearch(21, 'Chinese highlight creates separate marks', () => {
            assert.equal(chineseHighlight.children.filter(child => child.tagName === 'MARK').length, 2);
        });
        recordSearch(22, 'Skipped Chinese character is not highlighted', () => {
            assert.equal(serializeFakeNode(chineseHighlight), '<mark>科</mark>學<mark>展</mark>');
        });
        const companyHighlight = new FakeElement('span');
        api.appendHighlightedIndexes(companyHighlight, '蘋果公司', [0, 3]);
        recordSearch(23, '蘋司 highlights only 蘋 and 司', () => {
            assert.equal(serializeFakeNode(companyHighlight), '<mark>蘋</mark>果公<mark>司</mark>');
        });

        const unsafeWord = makeWord(
            'unsafe',
            '<script>alert(1)</script>',
            '<img src=x onerror=alert(1)>',
            '<b>folder</b>'
        );
        const unsafeOption = api.createSearchSuggestionOption({
            key: 'unsafe',
            word: unsafeWord,
            folderName: unsafeWord.folderId,
            englishMatchStart: 1,
            englishMatchLength: 6,
            chineseMatchIndexes: null
        }, 0, 1);
        const collectElementTags = root => {
            const tags = [];
            const visit = node => {
                if (!(node instanceof FakeElement)) return;
                tags.push(node.tagName);
                node.children.forEach(visit);
            };
            visit(root);
            return tags;
        };
        recordSearch(24, 'Script-like user text stays visible as text', () => {
            assert.equal(unsafeOption.textContent.includes('<script>alert(1)</script>'), true);
        });
        recordSearch(25, 'User HTML is never parsed into elements', () => {
            const tags = collectElementTags(unsafeOption);
            assert.equal(tags.includes('SCRIPT'), false);
            assert.equal(tags.includes('IMG'), false);
            assert.equal(tags.includes('B'), false);
        });
        recordSearch(26, 'Suggestion renderer does not use innerHTML', () => {
            assert.doesNotMatch(String(api.createSearchSuggestionOption), /innerHTML/);
        });

        const prepareSearch = (words, query, viewportWidth = 390) => {
            api.reset();
            api.setDefaults([], []);
            api.state.words = words.map(word => ({ ...word }));
            api.state.folders = [api.WRONG_FOLDER, 'Search'];
            const dom = createSearchDom(document, viewportWidth);
            dom.input.value = query;
            api.updateSearchSuggestions();
            return dom;
        };
        const shortDom = prepareSearch(englishWords.slice(0, 3), 'a');
        recordSearch(27, 'Five or fewer results all render completely', () => {
            assert.equal(shortDom.listbox.querySelectorAll('[role="option"]').length, 3);
        });

        const manyWords = [
            makeWord('alpha', 'alpha', '一'),
            makeWord('bravo', 'bravo', '二'),
            makeWord('charlie', 'charlie', '三'),
            makeWord('delta', 'delta', '四'),
            makeWord('gamma', 'gamma', '五'),
            makeWord('kappa', 'kappa', '六'),
            makeWord('lambda', 'lambda', '七'),
            makeWord('zeta', 'zeta', '八')
        ];
        let manyDom = prepareSearch(manyWords, 'a');
        recordSearch(28, 'More than five results remain in the DOM', () => {
            assert.equal(manyDom.listbox.querySelectorAll('[role="option"]').length, 8);
            assert.equal(api.getSearchState().suggestions.length, 8);
        });
        recordSearch(29, 'No five-result slicing is present', () => {
            const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app.js'), 'utf8');
            assert.doesNotMatch(source, /slice\(0,\s*5\)/);
        });
        recordSearch(30, 'Long result lists scroll vertically', () => {
            assert.equal(manyDom.listbox.style.overflowY, 'auto');
        });
        recordSearch(31, 'Listbox visual height is exactly five rows', () => {
            assert.equal(manyDom.listbox.style.maxHeight, '320px');
        });
        for (let index = 0; index < 6; index += 1) {
            api.handleSearchKeydown({ key: 'ArrowDown', isComposing: false, preventDefault() {} });
        }
        recordSearch(32, 'ArrowDown to the sixth result scrolls the listbox', () => {
            assert.equal(api.getSearchState().activeIndex, 5);
            assert.equal(manyDom.listbox.scrollTop > 0, true);
        });
        const manyOptions = manyDom.listbox.querySelectorAll('[role="option"]');
        recordSearch(33, 'The sixth result remains a clickable button', () => {
            assert.equal(manyOptions[5].tagName, 'BUTTON');
            assert.equal(typeof manyOptions[5].click, 'function');
        });
        let navigatedWord = null;
        let navigateCalls = 0;
        const expectedSixthId = api.getSearchState().suggestions[5].word.id;
        api.setWordNavigator(word => {
            navigatedWord = word;
            navigateCalls += 1;
            return true;
        });
        manyOptions[5].click();
        recordSearch(34, 'Clicking the sixth result navigates to that word', () => {
            assert.equal(navigatedWord.id, expectedSixthId);
        });
        api.selectSearchSuggestion(0);
        recordSearch(35, 'Candidate selection reuses navigateToWord', () => {
            assert.equal(navigateCalls, 2);
            assert.match(String(api.selectSearchSuggestion), /navigateToWord/);
        });
        api.restoreSearchDependencies();

        manyDom = prepareSearch(manyWords, 'a');
        api.handleSearchKeydown({ key: 'ArrowDown', isComposing: false, preventDefault() {} });
        recordSearch(36, 'ArrowDown selects the next result', () => {
            assert.equal(api.getSearchState().activeIndex, 0);
        });
        api.handleSearchKeydown({ key: 'ArrowDown', isComposing: false, preventDefault() {} });
        api.handleSearchKeydown({ key: 'ArrowUp', isComposing: false, preventDefault() {} });
        recordSearch(37, 'ArrowUp selects the previous result', () => {
            assert.equal(api.getSearchState().activeIndex, 0);
        });

        manyDom = prepareSearch(manyWords, 'a');
        let enteredId = null;
        api.setWordNavigator(word => {
            enteredId = word.id;
            return true;
        });
        api.handleSearchKeydown({ key: 'ArrowDown', isComposing: false, preventDefault() {} });
        api.handleSearchKeydown({ key: 'ArrowDown', isComposing: false, preventDefault() {} });
        const expectedSecondId = api.getSearchState().suggestions[1].word.id;
        api.handleSearchKeydown({ key: 'Enter', isComposing: false, preventDefault() {} });
        recordSearch(38, 'Enter selects the active result', () => {
            assert.equal(enteredId, expectedSecondId);
        });
        api.restoreSearchDependencies();

        manyDom = prepareSearch(manyWords, 'a');
        let firstEnteredId = null;
        api.setWordNavigator(word => {
            firstEnteredId = word.id;
            return true;
        });
        const expectedFirstId = api.getSearchState().suggestions[0].word.id;
        api.handleSearchKeydown({ key: 'Enter', isComposing: false, preventDefault() {} });
        recordSearch(39, 'Enter without an active result selects the first result', () => {
            assert.equal(firstEnteredId, expectedFirstId);
        });
        api.restoreSearchDependencies();

        manyDom = prepareSearch(manyWords, 'a');
        api.handleSearchKeydown({ key: 'Escape', isComposing: false, preventDefault() {} });
        recordSearch(40, 'Escape closes the listbox', () => {
            assert.equal(manyDom.listbox.hidden, true);
        });
        manyDom = prepareSearch(manyWords, 'a');
        api.handleSearchOutsidePointerDown({ target: new FakeElement('div') });
        recordSearch(41, 'Pointer down outside closes the listbox', () => {
            assert.equal(manyDom.listbox.hidden, true);
        });
        manyDom = prepareSearch(manyWords, 'a');
        manyDom.input.value = '';
        api.updateSearchSuggestions();
        recordSearch(42, 'Empty query closes and clears suggestions', () => {
            assert.equal(manyDom.listbox.hidden, true);
            assert.equal(api.getSearchState().suggestions.length, 0);
        });
        recordSearch(43, 'Auth state changes close suggestions before loading', () => {
            const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app.js'), 'utf8');
            const authStart = source.indexOf('onAuthStateChanged(auth');
            const authLoad = source.indexOf('authReady = true', authStart);
            assert.match(source.slice(authStart, authLoad), /closeSearchSuggestions\(\{ clearResults: true \}\)/);
        });

        manyDom = prepareSearch(manyWords, 'a');
        recordSearch(44, 'aria-expanded follows listbox visibility', () => {
            assert.equal(manyDom.input.getAttribute('aria-expanded'), 'true');
            api.closeSearchSuggestions();
            assert.equal(manyDom.input.getAttribute('aria-expanded'), 'false');
        });
        manyDom = prepareSearch(manyWords, 'a');
        api.updateActiveSearchSuggestion(1);
        recordSearch(45, 'aria-activedescendant follows the active option', () => {
            assert.equal(
                manyDom.input.getAttribute('aria-activedescendant'),
                manyDom.listbox.querySelectorAll('[role="option"]')[1].id
            );
        });
        recordSearch(46, 'aria-selected is maintained on every option', () => {
            const options = manyDom.listbox.querySelectorAll('[role="option"]');
            assert.equal(options[1].getAttribute('aria-selected'), 'true');
            assert.equal(options[0].getAttribute('aria-selected'), 'false');
        });

        api.reset();
        createSearchDom(document);
        let compositionUpdates = 0;
        api.setSearchUpdater(() => { compositionUpdates += 1; });
        api.handleSearchCompositionStart();
        api.handleSearchInput();
        recordSearch(47, 'Composition suppresses suggestion updates', () => {
            assert.equal(compositionUpdates, 0);
            assert.equal(api.getSearchState().isComposing, true);
        });
        api.handleSearchCompositionEnd();
        recordSearch(48, 'Composition end refreshes once', () => {
            assert.equal(compositionUpdates, 1);
            assert.equal(api.getSearchState().isComposing, false);
        });
        api.restoreSearchDependencies();

        const dataDom = prepareSearch([makeWord('alpha', 'alpha', '一')], 'a');
        await api.commitUserMutation(draft => {
            draft.words.push(makeWord('beta', 'beta', '二'));
        }, { requireAuth: false });
        recordSearch(49, 'Adding a word refreshes suggestions', () => {
            assert.equal(dataDom.listbox.querySelectorAll('[role="option"]').length, 2);
        });
        await api.commitUserMutation(draft => {
            const alpha = draft.words.find(word => word.id === 'alpha');
            alpha.english = 'echo';
        }, { requireAuth: false });
        recordSearch(50, 'Editing a word refreshes suggestions', () => {
            assert.equal(dataDom.listbox.querySelectorAll('[role="option"]').length, 1);
            assert.equal(api.getSearchState().suggestions[0].word.english, 'beta');
        });
        await api.commitUserMutation(draft => {
            draft.words = draft.words.filter(word => word.id !== 'beta');
        }, { requireAuth: false });
        recordSearch(51, 'Deleting a word refreshes suggestions', () => {
            assert.equal(dataDom.listbox.querySelectorAll('[role="option"]').length, 0);
            assert.equal(dataDom.listbox.textContent.includes('找不到符合的單字'), true);
        });

        const cloudDom = prepareSearch([], '科');
        api.applyUserData({
            words: [makeWord('cloud-science', 'science', '科學')],
            folders: [api.WRONG_FOLDER, 'Search'],
            settings: api.state.settings
        });
        recordSearch(52, 'Cloud reload refreshes suggestions', () => {
            assert.equal(cloudDom.listbox.querySelectorAll('[role="option"]').length, 1);
            assert.equal(api.getSearchState().suggestions[0].word.id, 'cloud-science');
        });
        recordSearch(53, 'A word matching both fields is rendered once', () => {
            const duplicateMatches = api.findSearchMatches('科展', [
                makeWord('both-fields', '科展', '科展')
            ]);
            assert.equal(duplicateMatches.length, 1);
            assert.equal(duplicateMatches[0].englishMatchStart, 0);
            assert.deepEqual(Array.from(duplicateMatches[0].chineseMatchIndexes), [0, 1]);
        });
    }

    process.stdout.write(`${JSON.stringify({ passed: results.length, results }, null, 2)}\n`);
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
