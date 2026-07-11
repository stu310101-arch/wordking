const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadWordKing() {
    const appPath = path.join(__dirname, '..', 'assets', 'app.js');
    let source = fs.readFileSync(appPath, 'utf8');
    source = source.slice(source.indexOf("const LESSON_MANIFEST_URL"));
    source += `
        globalThis.__wordKingTest = {
            state,
            WRONG_FOLDER,
            UNFILED_FOLDER,
            cloneWord,
            applyFolderDeletion,
            wordIsInFolder,
            validateFolderName,
            findWordCardById,
            confirmNewFolder,
            saveNewWord,
            executeRename,
            collectDiffOperations,
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
            disableNavigation() {
                navigateTo = () => {};
                showView = () => {};
            },
            reset() {
                currentUser = null;
                isCloudLoading = false;
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
            querySelectorAll() { return []; }
        },
        window: {
            crypto: { randomUUID: () => 'test-uuid' },
            speechSynthesis: {},
            location: 'http://127.0.0.1:8000/?page=home',
            scrollTo() {}
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

    process.stdout.write(`${JSON.stringify({ passed: results.length, results }, null, 2)}\n`);
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
