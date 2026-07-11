import { initializeApp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import {
    getAuth,
    onAuthStateChanged,
    GoogleAuthProvider,
    signInWithPopup,
    signOut
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import {
    getFirestore,
    collection,
    doc,
    getDoc,
    getDocs,
    onSnapshot,
    runTransaction,
    writeBatch,
    deleteField
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

const LESSON_MANIFEST_URL = './data/lessons/manifest.json';
const WRONG_FOLDER = '錯題區';
const REVIEW_FOLDER_LABEL = '待複習';
const UNFILED_FOLDER = '未分類';
const SYNC_TIMEOUT_MS = 15000;
const ATOMIC_OPERATION_LIMIT = 440;
const BATCH_CHUNK_SIZE = 440;
const BATCH_RETRY_LIMIT = 3;
const SYNC_LOCK_STALE_MS = 2 * 60 * 1000;

const PART_OF_SPEECH_OPTIONS = {
    noun: { label: '名詞', short: '(n.)' },
    verb: { label: '動詞', short: '(v.)' },
    adjective: { label: '形容詞', short: '(a.)' },
    adverb: { label: '副詞', short: '(adv.)' },
    pronoun: { label: '代名詞', short: '(pron.)' },
    preposition: { label: '介系詞', short: '(prep.)' },
    conjunction: { label: '連接詞', short: '(conj.)' },
    interjection: { label: '感嘆詞', short: '(interj.)' },
    other: { label: '其他', short: '(其他)' }
};

const firebaseConfig = {
    apiKey: "AIzaSyB2Q10x0JxoAGQt4IiwGr9rwyIm7M1xjbA",
    authDomain: "wordking-434f7.firebaseapp.com",
    projectId: "wordking-434f7",
    storageBucket: "wordking-434f7.firebasestorage.app",
    messagingSenderId: "340952543206",
    appId: "1:340952543206:web:5388cff593ebee0d61b027"
};

const BGM_TRACKS = [
    { id: 'bgm_new_dora', name: '新哆啦A夢主題曲', url: './background music/新哆啦A夢主題曲.mp3' },
    { id: 'bgm_old_dora', name: '舊版哆啦A夢主題曲', url: './background music/舊版哆啦A夢主題曲.mp3' },
    { id: 'bgm_summer', name: "On Summer's Day", url: "./background music/On Summer's Day.mp3" },
    { id: 'bgm_columbina', name: 'Genshin Impact - Columbina To Where She Flies', url: './background music/Genshin Impact - Columbina To Where She Flies.mp3' },
    { id: 'bgm_demo', name: '線上測試音樂', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' }
];

const DEFAULT_SETTINGS = {
    bgmEnabled: true,
    bgmVolume: 0.5,
    speechVolume: 1.0,
    selectedBgmId: 'bgm_new_dora',
    lessonFolderNames: {},
    deletedLessonIds: []
};

const bgmDucking = {
    isDucking: false,
    ratio: 0.3
};

let defaultWordDatabase = [];
let defaultWordMap = new Map();
let defaultWordEnglishMap = new Map();
let currentUser = null;
let authReady = false;
let isCloudLoading = false;
let cloudLoadGeneration = 0;
let isSyncing = false;
let isLoggingIn = false;
let isLoggingOut = false;
let isFolderDeleting = false;
let cloudRevision = 0;
let pendingRemoteRevision = 0;
let activeCloudWrites = 0;
let unsubscribeUserRevision = null;

const modalReturnFocus = new WeakMap();

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
let createWriteBatch = database => writeBatch(database);
let executeTransaction = (database, updateFunction) => runTransaction(database, updateFunction);
let subscribeToSnapshot = (reference, onNext, onError) => onSnapshot(reference, onNext, onError);
let waitBeforeRetry = delay => new Promise(resolve => setTimeout(resolve, delay));

class CloudRevisionConflictError extends Error {
    constructor(expectedRevision, actualRevision) {
        super(`雲端資料版本已更新（本機 ${expectedRevision}、雲端 ${actualRevision}）。`);
        this.name = 'CloudRevisionConflictError';
        this.code = 'cloud-revision-conflict';
        this.expectedRevision = expectedRevision;
        this.actualRevision = actualRevision;
    }
}

class CloudSyncInProgressError extends Error {
    constructor() {
        super('另一個裝置正在同步大量資料，請稍後重新載入。');
        this.name = 'CloudSyncInProgressError';
        this.code = 'cloud-sync-in-progress';
    }
}

class CloudPartialCommitError extends Error {
    constructor(message, { committedChunks = 0, totalChunks = 0, cause = null } = {}) {
        super(message, cause ? { cause } : undefined);
        this.name = 'CloudPartialCommitError';
        this.code = 'cloud-partial-commit';
        this.committedChunks = committedChunks;
        this.totalChunks = totalChunks;
    }
}

const state = {
    words: [],
    categories: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(''),
    folderIds: [WRONG_FOLDER],
    folders: [WRONG_FOLDER],
    lessonFolderIds: [],
    settings: { ...DEFAULT_SETTINGS },
    audio: {
        bgmElement: null
    },
    game: {
        mode: '',
        currentWords: [],
        index: 0,
        wrongWords: new Set(),
        reviewSelection: [],
        answeredHistory: [],
        viewingHistoryIndex: null,
        currentChoiceOptions: [],
        currentHadMistake: false,
        spellingDrafts: {}
    },
    isEditing: false,
    editingWordIndex: -1,
    targetFolderAction: '',
    pendingDeleteType: null
};

window.state = state;

function safeDocId(value) {
    const raw = String(value || '').trim();
    return encodeURIComponent(raw || `id-${Date.now()}`).replace(/\./g, '%2E');
}

function createDefaultWordId(lessonId, english) {
    return safeDocId(`${lessonId}::${String(english || '').trim().toLowerCase()}`);
}

function createCustomWordId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return `custom_${window.crypto.randomUUID()}`;
    }
    return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeLegacyTags(tags) {
    return Array.from(new Set(
        (Array.isArray(tags) ? tags : [])
            .filter(tag => typeof tag === 'string' && tag.trim())
            .map(tag => tag.trim())
    ));
}

function normalizePartOfSpeech(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PART_OF_SPEECH_OPTIONS, value)
        ? value
        : '';
}

function getPartOfSpeechShort(value) {
    const normalized = normalizePartOfSpeech(value);
    return normalized ? PART_OF_SPEECH_OPTIONS[normalized].short : '';
}

function normalizeFolderId(value) {
    const folderId = typeof value === 'string' ? value.trim() : '';
    if (!folderId || folderId === WRONG_FOLDER || folderId === UNFILED_FOLDER) return '';
    if (/^[A-Z]$/i.test(folderId)) return '';
    return folderId;
}

function getLegacyFolderData(word = {}) {
    const tags = normalizeLegacyTags(word.tags);
    const legacyFolderIds = Array.isArray(word.folderIds) ? word.folderIds : [];
    const explicitFolderId = typeof word.folderId === 'string' ? word.folderId.trim() : '';
    const folderId = [explicitFolderId, ...legacyFolderIds, ...tags]
        .map(normalizeFolderId)
        .find(Boolean) || '';
    const isWrong = typeof word.isWrong === 'boolean'
        ? word.isWrong
        : explicitFolderId === WRONG_FOLDER || tags.includes(WRONG_FOLDER) || legacyFolderIds.includes(WRONG_FOLDER);
    return { folderId, isWrong };
}

function cloneWord(word = {}) {
    const folderData = getLegacyFolderData(word);
    const cloned = {
        english: word.english || '',
        meaning: word.meaning || '',
        partOfSpeech: normalizePartOfSpeech(word.partOfSpeech),
        folderId: folderData.folderId,
        isWrong: folderData.isWrong
    };
    if (word.id) cloned.id = word.id;
    if (word.defaultId) cloned.defaultId = word.defaultId;
    if (word.source === 'custom' || word.source === 'default') cloned.source = word.source;
    if (word.createdAt) cloned.createdAt = word.createdAt;
    if (word.updatedAt) cloned.updatedAt = word.updatedAt;
    return cloned;
}

function cloneWords(words) {
    return (words || []).map(cloneWord);
}

function clamp01(value) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function cloneSettings(settings = {}) {
    const hydrated = hydrateSettings(settings);
    return {
        ...hydrated,
        lessonFolderNames: { ...(hydrated.lessonFolderNames || {}) },
        deletedLessonIds: Array.isArray(hydrated.deletedLessonIds) ? [...hydrated.deletedLessonIds] : []
    };
}

function snapshotUserState(source = state) {
    return {
        words: cloneWords(source.words),
        folders: Array.isArray(source.folders) ? [...source.folders] : [],
        settings: cloneSettings(source.settings)
    };
}

function restoreUserState(snapshot) {
    state.words = cloneWords(snapshot.words);
    state.folders = Array.isArray(snapshot.folders) ? [...snapshot.folders] : [];
    state.settings = cloneSettings(snapshot.settings);
}

function applyUserData(data) {
    state.words = cloneWords(data.words);
    state.settings = cloneSettings(data.settings);
    state.folders = normalizeFolders(data.folders || [], state.words, state.settings);
    clearPracticeSession();
    refreshFolders();
}

function hydrateSettings(saved) {
    const base = {
        ...DEFAULT_SETTINGS,
        lessonFolderNames: {},
        deletedLessonIds: []
    };
    if (saved && typeof saved === 'object') {
        if (typeof saved.bgmEnabled === 'boolean') base.bgmEnabled = saved.bgmEnabled;
        if (typeof saved.bgmVolume === 'number') base.bgmVolume = clamp01(saved.bgmVolume);
        if (typeof saved.speechVolume === 'number') base.speechVolume = clamp01(saved.speechVolume);
        if (typeof saved.selectedBgmId === 'string') base.selectedBgmId = saved.selectedBgmId;
        if (saved.lessonFolderNames && typeof saved.lessonFolderNames === 'object' && !Array.isArray(saved.lessonFolderNames)) {
            Object.entries(saved.lessonFolderNames).forEach(([lessonId, displayName]) => {
                if (typeof lessonId === 'string' && typeof displayName === 'string' && displayName.trim()) {
                    base.lessonFolderNames[lessonId] = displayName.trim();
                }
            });
        }
        if (Array.isArray(saved.deletedLessonIds)) {
            base.deletedLessonIds = Array.from(new Set(saved.deletedLessonIds.filter(id => typeof id === 'string' && id.trim())));
        }
    }
    return base;
}

function isLessonFolder(folderId) {
    return state.lessonFolderIds.includes(folderId);
}

function getActiveLessonFolderIds(settings = state.settings) {
    const deleted = new Set((settings && settings.deletedLessonIds) || []);
    return state.lessonFolderIds.filter(folderId => !deleted.has(folderId));
}

function getFolderDisplayName(folderId, settings = state.settings) {
    if (folderId === WRONG_FOLDER) return REVIEW_FOLDER_LABEL;
    if (folderId === UNFILED_FOLDER) return UNFILED_FOLDER;
    return (settings && settings.lessonFolderNames && settings.lessonFolderNames[folderId]) || folderId;
}

function folderNameExists(name, exceptFolderId = '') {
    if (!name) return false;
    if (state.categories.includes(name.toUpperCase())) return true;
    return (state.folders || []).some(folderId => {
        if (folderId === exceptFolderId) return false;
        return folderId === name || getFolderDisplayName(folderId) === name;
    });
}

function validateFolderName(value, exceptFolderId = '') {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) return { valid: false, message: '請輸入資料夾名稱。' };
    if (state.categories.includes(name.toUpperCase())) {
        return { valid: false, message: '資料夾名稱不能使用 A–Z 字母索引。' };
    }
    if (name === WRONG_FOLDER || name === UNFILED_FOLDER) {
        return { valid: false, message: '這是系統保留名稱，請改用其他資料夾名稱。' };
    }
    if (folderNameExists(name, exceptFolderId)) {
        return { valid: false, message: '這個資料夾名稱已存在。' };
    }
    return { valid: true, name };
}

function getDefaultWords() {
    return cloneWords(defaultWordDatabase);
}

function getCurrentBgmTrack() {
    return BGM_TRACKS.find(t => t.id === state.settings.selectedBgmId) || BGM_TRACKS[0] || null;
}

function validateLessonWord(rawWord, lessonId, index, fileName) {
    if (!rawWord || typeof rawWord !== 'object') {
        console.warn(`Skipped invalid word object in ${fileName} at index ${index}`);
        return null;
    }

    const english = typeof rawWord.english === 'string' ? rawWord.english.trim() : '';
    if (!english) {
        console.warn(`Skipped word with empty english in ${fileName} at index ${index}`);
        return null;
    }

    const meaning = typeof rawWord.meaning === 'string' ? rawWord.meaning : '';
    const partOfSpeech = normalizePartOfSpeech(rawWord.partOfSpeech);
    const rawTags = Array.isArray(rawWord.tags) ? rawWord.tags : [lessonId];
    const folderId = normalizeLegacyTags(rawTags).find(tag => tag !== WRONG_FOLDER) || lessonId;

    const defaultId = createDefaultWordId(lessonId, english);
    return {
        id: defaultId,
        defaultId,
        source: 'default',
        english,
        meaning,
        partOfSpeech,
        folderId,
        isWrong: false
    };
}

function validateLessonData(rawLesson, manifestItem) {
    const fileName = manifestItem && manifestItem.file ? manifestItem.file : 'unknown lesson file';
    if (!rawLesson || typeof rawLesson !== 'object') {
        throw new Error(`${fileName} is not a lesson object`);
    }

    const id = typeof rawLesson.id === 'string' && rawLesson.id.trim()
        ? rawLesson.id.trim()
        : (typeof manifestItem.id === 'string' ? manifestItem.id.trim() : '');
    if (!id) throw new Error(`${fileName} has no lesson id`);
    if (!Array.isArray(rawLesson.words)) throw new Error(`${fileName} words must be an array`);

    const words = rawLesson.words
        .map((word, index) => validateLessonWord(word, id, index, fileName))
        .filter(Boolean);
    return { id, words };
}

async function loadDefaultWordDatabase() {
    const manifestRes = await fetch(LESSON_MANIFEST_URL, { cache: 'no-cache' });
    if (!manifestRes.ok) throw new Error('無法載入單字課程清單');
    const manifest = await manifestRes.json();
    const lessonFiles = Array.isArray(manifest.lessons) ? manifest.lessons : [];
    const results = await Promise.allSettled(lessonFiles.map(async lesson => {
        if (!lesson || typeof lesson.file !== 'string' || !lesson.file.trim()) {
            throw new Error('Lesson manifest entry is missing file');
        }
        const res = await fetch(`./data/lessons/${encodeURIComponent(lesson.file)}`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`Failed to fetch ${lesson.file}: ${res.status}`);
        const data = await res.json();
        return validateLessonData(data, lesson);
    }));

    const lessons = [];
    results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            lessons.push(result.value);
        } else {
            const file = lessonFiles[index] && lessonFiles[index].file ? lessonFiles[index].file : `lesson #${index + 1}`;
            console.warn(`Skipped lesson ${file}:`, result.reason);
        }
    });

    state.lessonFolderIds = lessons.map(l => l.id).filter(Boolean);
    defaultWordDatabase = lessons.flatMap(l => cloneWords(l.words));
    defaultWordMap = new Map(defaultWordDatabase.map(word => [word.defaultId, cloneWord(word)]));
    defaultWordEnglishMap = new Map(defaultWordDatabase.map(word => [word.english.toLowerCase(), cloneWord(word)]));
    window.defaultWordDatabase = defaultWordDatabase;
}

function clearPracticeSession() {
    state.game.mode = '';
    state.game.currentWords = [];
    state.game.index = 0;
    state.game.wrongWords = new Set();
    state.game.reviewSelection = [];
    state.game.answeredHistory = [];
    state.game.viewingHistoryIndex = null;
    state.game.currentChoiceOptions = [];
    state.game.currentHadMistake = false;
    state.game.spellingDrafts = {};
}

function resetToDefaultState() {
    state.settings = cloneSettings(DEFAULT_SETTINGS);
    state.words = getDefaultWords();
    state.folders = normalizeFolders([], state.words, state.settings);
    clearPracticeSession();
    refreshFolders();
}

function splitFolderNameForSeries(folderName) {
    const m = String(folderName).match(/^(\D+)(.*)$/);
    if (!m) return { prefix: folderName, numbers: [] };
    const prefix = m[1].trim();
    const rest = m[2];
    const nums = rest ? rest.match(/\d+/g) : null;
    return { prefix, numbers: nums ? nums.map(n => parseInt(n, 10)) : [] };
}

function compareFoldersBySeries(a, b) {
    if (a === WRONG_FOLDER && b !== WRONG_FOLDER) return 1;
    if (b === WRONG_FOLDER && a !== WRONG_FOLDER) return -1;

    const sa = splitFolderNameForSeries(a);
    const sb = splitFolderNameForSeries(b);
    if (sa.prefix !== sb.prefix) return sa.prefix.localeCompare(sb.prefix, 'zh-Hant');

    const len = Math.max(sa.numbers.length, sb.numbers.length);
    for (let i = 0; i < len; i++) {
        const na = sa.numbers[i] ?? 0;
        const nb = sb.numbers[i] ?? 0;
        if (na !== nb) return na - nb;
    }
    return a.localeCompare(b, 'zh-Hant');
}

function refreshFolders() {
    const deleted = new Set((state.settings && state.settings.deletedLessonIds) || []);
    const folderSet = new Set((state.folders || []).filter(folderId =>
        folderId && folderId !== UNFILED_FOLDER && !deleted.has(folderId)
    ));
    let hasUnfiledWords = false;
    state.words.forEach(w => {
        if (w.folderId && !deleted.has(w.folderId)) folderSet.add(w.folderId);
        else if (!w.folderId) hasUnfiledWords = true;
    });
    if (hasUnfiledWords) folderSet.add(UNFILED_FOLDER);
    folderSet.add(WRONG_FOLDER);
    state.folderIds = Array.from(folderSet).sort(compareFoldersBySeries);

    const datalist = document.getElementById('folder-list');
    if (datalist) {
        datalist.replaceChildren();
        state.folderIds.forEach(folderId => {
            const option = document.createElement('option');
            option.value = folderId;
            datalist.appendChild(option);
        });
    }
}

function sameSettings(a, b) {
    return JSON.stringify(cloneSettings(a)) === JSON.stringify(cloneSettings(b));
}

function sameCustomWordData(a, b) {
    return !!a && !!b &&
        (a.english || '') === (b.english || '') &&
        (a.meaning || '') === (b.meaning || '') &&
        normalizePartOfSpeech(a.partOfSpeech) === normalizePartOfSpeech(b.partOfSpeech) &&
        (a.folderId || '') === (b.folderId || '') &&
        !!a.isWrong === !!b.isWrong;
}

function getDefaultOverrideFields(word, baseWord) {
    if (!word || !baseWord) return {};
    const override = {};
    if ((word.english || '') !== (baseWord.english || '')) override.english = word.english || '';
    if ((word.meaning || '') !== (baseWord.meaning || '')) override.meaning = word.meaning || '';
    if (normalizePartOfSpeech(word.partOfSpeech) !== normalizePartOfSpeech(baseWord.partOfSpeech)) {
        override.partOfSpeech = normalizePartOfSpeech(word.partOfSpeech);
    }
    if ((word.folderId || '') !== (baseWord.folderId || '')) override.folderId = word.folderId || '';
    if (!!word.isWrong !== !!baseWord.isWrong) override.isWrong = !!word.isWrong;
    return override;
}

function sameOverride(a = {}, b = {}) {
    const aKeys = Object.keys(a).filter(key => key !== 'updatedAt').sort();
    const bKeys = Object.keys(b).filter(key => key !== 'updatedAt').sort();
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(key => a[key] === b[key]);
}

function ensureWordIdentities(words) {
    return cloneWords(words).map(word => {
        if (word.defaultId && defaultWordMap.has(word.defaultId)) {
            return { ...word, id: word.defaultId, source: 'default' };
        }
        if (word.source === 'default' && word.id && defaultWordMap.has(word.id)) {
            return { ...word, defaultId: word.id, source: 'default' };
        }
        if (word.source === 'custom' || word.id) {
            return { ...word, id: word.id || createCustomWordId(), source: 'custom' };
        }
        const defaultMatch = defaultWordEnglishMap.get((word.english || '').toLowerCase());
        if (defaultMatch && sameCustomWordData(word, defaultMatch)) {
            return { ...word, id: defaultMatch.defaultId, defaultId: defaultMatch.defaultId, source: 'default' };
        }
        return { ...word, id: createCustomWordId(), source: 'custom' };
    });
}

function getCustomFolderNames(folders = []) {
    return Array.from(new Set(
        (folders || [])
            .map(normalizeFolderId)
            .filter(name =>
                name &&
                !state.lessonFolderIds.includes(name)
            )
    ));
}

function mapWordsForStorage(words = []) {
    const custom = new Map();
    const defaults = new Map();
    ensureWordIdentities(words).forEach(word => {
        if (word.source === 'default' && word.defaultId) {
            defaults.set(word.defaultId, word);
        } else if (word.source === 'custom' && word.id) {
            custom.set(word.id, word);
        }
    });
    return { custom, defaults };
}

function normalizeFolders(folders, words, settings = state.settings) {
    const folderIds = new Set([WRONG_FOLDER, ...getActiveLessonFolderIds(settings)]);
    (folders || []).forEach(f => {
        const normalizedFolderId = normalizeFolderId(f);
        if (normalizedFolderId) folderIds.add(normalizedFolderId);
    });
    let hasUnfiledWords = false;
    (words || []).forEach(w => {
        if (w.folderId) folderIds.add(w.folderId);
        else hasUnfiledWords = true;
    });
    const deleted = new Set((settings && settings.deletedLessonIds) || []);
    deleted.forEach(folderId => folderIds.delete(folderId));
    if (hasUnfiledWords) folderIds.add(UNFILED_FOLDER);
    folderIds.add(WRONG_FOLDER);
    return Array.from(folderIds);
}

function applyFolderDeletion(words, folderName, deleteWords) {
    return cloneWords(words).reduce((kept, word) => {
        if (word.folderId !== folderName) {
            kept.push(word);
            return kept;
        }
        if (deleteWords) return kept;
        kept.push({ ...word, folderId: '' });
        return kept;
    }, []);
}

function renameFolderInWords(words, oldName, newName) {
    return cloneWords(words).map(word => ({
        ...word,
        folderId: word.folderId === oldName ? newName : word.folderId
    }));
}

function getUserRef(user = currentUser) {
    if (!user) return null;
    return doc(db, 'users', user.uid);
}

function getUserSubDocRef(user, collectionName, docId) {
    return doc(db, 'users', user.uid, collectionName, docId);
}

function getSettingsRef(user) {
    return doc(db, 'users', user.uid, 'settings', 'main');
}

function normalizeCloudRevision(value) {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function getCloudMetadata(snapshot) {
    const data = snapshot && typeof snapshot.exists === 'function' && snapshot.exists()
        ? (snapshot.data() || {})
        : {};
    const syncLock = data.syncLock && typeof data.syncLock === 'object'
        ? data.syncLock
        : null;
    return {
        data,
        revision: normalizeCloudRevision(data.revision),
        syncLock
    };
}

function getObservedCloudRevision(metadata) {
    const lockRevision = metadata.syncLock
        ? normalizeCloudRevision(metadata.syncLock.targetRevision)
        : 0;
    return Math.max(metadata.revision, lockRevision);
}

function isSyncLockStale(syncLock) {
    if (!syncLock) return false;
    const updatedAt = Date.parse(syncLock.updatedAt || syncLock.startedAt || '');
    return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= SYNC_LOCK_STALE_MS;
}

function createSyncOperationId() {
    const randomId = window.crypto && typeof window.crypto.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    return `${Date.now()}-${randomId}`;
}

function acknowledgeCloudRevision(revision) {
    cloudRevision = normalizeCloudRevision(revision);
    if (pendingRemoteRevision <= cloudRevision) pendingRemoteRevision = 0;
    updateAuthUI(currentUser);
}

function getLegacyCleanupPatch(now) {
    return {
        words: deleteField(),
        folders: deleteField(),
        settings: deleteField(),
        schemaVersion: 2,
        migratedToDiffStorageAt: now
    };
}

async function readUserCollection(user, collectionName) {
    const snap = await getDocs(collection(db, 'users', user.uid, collectionName));
    return snap.docs.map(item => ({ id: item.id, ...(item.data() || {}) }));
}

function normalizeUserData(data = {}) {
    const settings = hydrateSettings(data.settings || null);
    const deleted = new Set(settings.deletedLessonIds || []);
    const baseWords = new Map(getDefaultWords().map(word => [word.defaultId, {
        ...cloneWord(word),
        folderId: deleted.has(word.folderId) ? '' : word.folderId
    }]));
    const customWords = [];

    cloneWords(data.words || []).forEach(word => {
        if (deleted.has(word.folderId)) word.folderId = '';
        const matchedDefault = defaultWordEnglishMap.get((word.english || '').toLowerCase());
        if (matchedDefault && baseWords.has(matchedDefault.defaultId)) {
            baseWords.set(matchedDefault.defaultId, {
                ...matchedDefault,
                ...word,
                id: matchedDefault.defaultId,
                defaultId: matchedDefault.defaultId,
                source: 'default'
            });
        } else {
            customWords.push({
                ...word,
                id: word.id || createCustomWordId(),
                source: 'custom'
            });
        }
    });

    const words = [...baseWords.values(), ...customWords];
    const folders = normalizeFolders(data.folders || [], words, settings);
    return { words, folders, settings };
}

function buildUserDataFromDiffs(diffData = {}) {
    const settings = cloneSettings(diffData.settings || DEFAULT_SETTINGS);
    const deletedLessonIds = new Set(settings.deletedLessonIds || []);
    const deletedDefaults = new Set(diffData.deletedDefaultIds || []);
    const overrides = new Map((diffData.wordOverrides || []).map(item => [item.id, item]));
    const defaultWords = getDefaultWords()
        .filter(word => !deletedDefaults.has(word.defaultId))
        .map(word => {
            const override = overrides.get(word.defaultId) || {};
            const hasLegacyTags = Object.prototype.hasOwnProperty.call(override, 'tags');
            const legacyData = hasLegacyTags ? getLegacyFolderData(override) : null;
            const folderId = Object.prototype.hasOwnProperty.call(override, 'folderId')
                ? String(override.folderId || '')
                : (legacyData ? legacyData.folderId : (deletedLessonIds.has(word.folderId) ? '' : word.folderId));
            const isWrong = Object.prototype.hasOwnProperty.call(override, 'isWrong')
                ? !!override.isWrong
                : (legacyData ? legacyData.isWrong : !!word.isWrong);
            const partOfSpeech = Object.prototype.hasOwnProperty.call(override, 'partOfSpeech')
                ? normalizePartOfSpeech(override.partOfSpeech)
                : normalizePartOfSpeech(word.partOfSpeech);
            return cloneWord({
                ...word,
                english: Object.prototype.hasOwnProperty.call(override, 'english') ? override.english : word.english,
                meaning: Object.prototype.hasOwnProperty.call(override, 'meaning') ? override.meaning : word.meaning,
                partOfSpeech,
                folderId,
                isWrong,
                id: word.defaultId,
                defaultId: word.defaultId,
                source: 'default'
            });
        });
    const customWords = (diffData.customWords || []).map(word => cloneWord({
        ...word,
        id: word.id,
        source: 'custom'
    }));
    const folderNames = (diffData.folders || [])
        .map(folder => typeof folder.name === 'string' ? folder.name : folder.id)
        .filter(Boolean);
    const words = [...defaultWords, ...customWords];
    const folders = normalizeFolders(folderNames, words, settings);
    return { words, folders, settings };
}

function createDefaultUserData(settings = DEFAULT_SETTINGS) {
    const nextSettings = cloneSettings(settings);
    const words = getDefaultWords();
    const folders = normalizeFolders([], words, nextSettings);
    return { words, folders, settings: nextSettings };
}

function collectDiffOperations(previous, next, user) {
    const operations = [];
    const now = new Date().toISOString();
    const before = {
        ...previous,
        words: ensureWordIdentities(previous.words || []),
        folders: normalizeFolders(previous.folders || [], previous.words || [], previous.settings)
    };
    const after = {
        ...next,
        words: ensureWordIdentities(next.words || []),
        folders: normalizeFolders(next.folders || [], next.words || [], next.settings)
    };

    if (!sameSettings(before.settings, after.settings)) {
        operations.push(batch => batch.set(getSettingsRef(user), {
            ...cloneSettings(after.settings),
            updatedAt: now
        }, { merge: true }));
    }

    const beforeFolders = new Set(getCustomFolderNames(before.folders));
    const afterFolders = new Set(getCustomFolderNames(after.folders));
    beforeFolders.forEach(folderName => {
        if (!afterFolders.has(folderName)) {
            operations.push(batch => batch.delete(getUserSubDocRef(user, 'folders', safeDocId(folderName))));
        }
    });
    afterFolders.forEach(folderName => {
        if (!beforeFolders.has(folderName)) {
            operations.push(batch => batch.set(getUserSubDocRef(user, 'folders', safeDocId(folderName)), {
                name: folderName,
                createdAt: now,
                updatedAt: now
            }, { merge: true }));
        }
    });

    const beforeWords = mapWordsForStorage(before.words);
    const afterWords = mapWordsForStorage(after.words);

    beforeWords.custom.forEach((word, wordId) => {
        if (!afterWords.custom.has(wordId)) {
            operations.push(batch => batch.delete(getUserSubDocRef(user, 'customWords', wordId)));
        }
    });
    afterWords.custom.forEach((word, wordId) => {
        const previousWord = beforeWords.custom.get(wordId);
        if (!sameCustomWordData(previousWord, word)) {
            operations.push(batch => batch.set(getUserSubDocRef(user, 'customWords', wordId), {
                english: word.english || '',
                meaning: word.meaning || '',
                partOfSpeech: normalizePartOfSpeech(word.partOfSpeech),
                folderId: word.folderId || '',
                isWrong: !!word.isWrong,
                createdAt: word.createdAt || now,
                updatedAt: now
            }));
        }
    });

    defaultWordMap.forEach((baseWord, defaultId) => {
        const previousWord = beforeWords.defaults.get(defaultId);
        const nextWord = afterWords.defaults.get(defaultId);

        if (previousWord && !nextWord) {
            operations.push(batch => batch.set(getUserSubDocRef(user, 'deletedDefaults', defaultId), {
                deleted: true,
                updatedAt: now
            }, { merge: true }));
            operations.push(batch => batch.delete(getUserSubDocRef(user, 'wordOverrides', defaultId)));
        } else if (!previousWord && nextWord) {
            operations.push(batch => batch.delete(getUserSubDocRef(user, 'deletedDefaults', defaultId)));
        }

        if (!nextWord) return;
        const previousOverride = previousWord ? getDefaultOverrideFields(previousWord, baseWord) : {};
        const nextOverride = getDefaultOverrideFields(nextWord, baseWord);
        if (sameOverride(previousOverride, nextOverride)) return;

        if (!Object.keys(nextOverride).length) {
            operations.push(batch => batch.delete(getUserSubDocRef(user, 'wordOverrides', defaultId)));
        } else {
            operations.push(batch => batch.set(getUserSubDocRef(user, 'wordOverrides', defaultId), {
                ...nextOverride,
                updatedAt: now
            }));
        }
    });

    return operations;
}

async function commitAtomicOperations(operations, user, expectedRevision, rootPatch = {}) {
    const rootRef = getUserRef(user);
    return executeTransaction(db, async transaction => {
        const rootSnapshot = await transaction.get(rootRef);
        const metadata = getCloudMetadata(rootSnapshot);
        if (metadata.syncLock) throw new CloudSyncInProgressError();
        if (metadata.revision !== expectedRevision) {
            throw new CloudRevisionConflictError(expectedRevision, metadata.revision);
        }

        operations.forEach(apply => apply(transaction));
        const revision = expectedRevision + 1;
        transaction.set(rootRef, {
            ...rootPatch,
            revision,
            schemaVersion: 2,
            updatedAt: new Date().toISOString()
        }, { merge: true });
        return { revision, committedChunks: 1, totalChunks: 1 };
    });
}

async function beginLargeSync(user, expectedRevision, totalChunks) {
    const rootRef = getUserRef(user);
    const now = new Date().toISOString();
    const syncLock = {
        id: createSyncOperationId(),
        baseRevision: expectedRevision,
        targetRevision: expectedRevision + 1,
        totalChunks,
        completedChunks: 0,
        startedAt: now,
        updatedAt: now
    };

    return executeTransaction(db, async transaction => {
        const rootSnapshot = await transaction.get(rootRef);
        const metadata = getCloudMetadata(rootSnapshot);
        if (metadata.syncLock) throw new CloudSyncInProgressError();
        if (metadata.revision !== expectedRevision) {
            throw new CloudRevisionConflictError(expectedRevision, metadata.revision);
        }
        transaction.set(rootRef, { syncLock, updatedAt: now }, { merge: true });
        return syncLock;
    });
}

async function commitLargeSyncChunk(operations, user, syncLock, completedChunks) {
    const rootRef = getUserRef(user);
    let lastError = null;
    for (let attempt = 0; attempt < BATCH_RETRY_LIMIT; attempt += 1) {
        const now = new Date().toISOString();
        const batch = createWriteBatch(db);
        operations.forEach(apply => apply(batch));
        batch.set(rootRef, {
            syncLock: {
                ...syncLock,
                completedChunks,
                updatedAt: now
            },
            updatedAt: now
        }, { merge: true });
        try {
            await batch.commit();
            return;
        } catch (error) {
            lastError = error;
            if (attempt + 1 < BATCH_RETRY_LIMIT) {
                await waitBeforeRetry(150 * (2 ** attempt));
            }
        }
    }
    throw lastError || new Error('大型同步批次寫入失敗。');
}

async function finishLargeSync(user, syncLock, rootPatch = {}) {
    const rootRef = getUserRef(user);
    return executeTransaction(db, async transaction => {
        const rootSnapshot = await transaction.get(rootRef);
        const metadata = getCloudMetadata(rootSnapshot);
        if (!metadata.syncLock) {
            if (metadata.revision === syncLock.targetRevision) return metadata.revision;
            throw new CloudRevisionConflictError(syncLock.baseRevision, metadata.revision);
        }
        if (metadata.syncLock.id !== syncLock.id) throw new CloudSyncInProgressError();

        transaction.set(rootRef, {
            ...rootPatch,
            revision: syncLock.targetRevision,
            schemaVersion: 2,
            syncLock: deleteField(),
            updatedAt: new Date().toISOString()
        }, { merge: true });
        return syncLock.targetRevision;
    });
}

async function closeInterruptedLargeSync(user, syncLock) {
    const rootRef = getUserRef(user);
    let lastError = null;
    for (let attempt = 0; attempt < BATCH_RETRY_LIMIT; attempt += 1) {
        try {
            return await executeTransaction(db, async transaction => {
                const rootSnapshot = await transaction.get(rootRef);
                const metadata = getCloudMetadata(rootSnapshot);
                if (!metadata.syncLock || metadata.syncLock.id !== syncLock.id) {
                    return metadata.revision;
                }
                const revision = Math.max(metadata.revision, syncLock.targetRevision);
                transaction.set(rootRef, {
                    revision,
                    syncLock: deleteField(),
                    syncInterruptedAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                }, { merge: true });
                return revision;
            });
        } catch (error) {
            lastError = error;
            if (attempt + 1 < BATCH_RETRY_LIMIT) {
                await waitBeforeRetry(150 * (2 ** attempt));
            }
        }
    }
    throw lastError || new Error('無法結束中斷的同步作業。');
}

async function commitBatchOperations(operations, user, expectedRevision, { rootPatch = {} } = {}) {
    if (!operations.length && !Object.keys(rootPatch).length) {
        return { revision: expectedRevision, committedChunks: 0, totalChunks: 0 };
    }
    if (operations.length <= ATOMIC_OPERATION_LIMIT) {
        return commitAtomicOperations(operations, user, expectedRevision, rootPatch);
    }

    const chunks = [];
    for (let index = 0; index < operations.length; index += BATCH_CHUNK_SIZE) {
        chunks.push(operations.slice(index, index + BATCH_CHUNK_SIZE));
    }
    const syncLock = await beginLargeSync(user, expectedRevision, chunks.length);
    let committedChunks = 0;
    try {
        for (let index = 0; index < chunks.length; index += 1) {
            await commitLargeSyncChunk(chunks[index], user, syncLock, index + 1);
            committedChunks = index + 1;
        }
        const revision = await finishLargeSync(user, syncLock, rootPatch);
        return { revision, committedChunks, totalChunks: chunks.length };
    } catch (error) {
        try {
            await closeInterruptedLargeSync(user, syncLock);
        } catch (cleanupError) {
            console.error('無法清除中斷的雲端同步鎖。', cleanupError);
        }
        throw new CloudPartialCommitError('部分資料可能已同步，必須重新載入雲端狀態。', {
            committedChunks,
            totalChunks: chunks.length,
            cause: error
        });
    }
}

async function saveDiffChangesToCloud(previous, next, user = currentUser, options = {}) {
    if (!user) return { revision: cloudRevision, committedChunks: 0, totalChunks: 0 };
    const operations = collectDiffOperations(previous, next, user);
    const now = new Date().toISOString();
    const rootPatch = options.cleanupLegacy ? getLegacyCleanupPatch(now) : {};
    const expectedRevision = Number.isSafeInteger(options.expectedRevision)
        ? options.expectedRevision
        : cloudRevision;
    activeCloudWrites += 1;
    updateAuthUI(currentUser);
    try {
        const result = await commitBatchOperations(operations, user, expectedRevision, { rootPatch });
        acknowledgeCloudRevision(result.revision);
        return result;
    } finally {
        activeCloudWrites = Math.max(0, activeCloudWrites - 1);
        updateAuthUI(currentUser);
    }
}

async function recoverStaleSyncLock(user) {
    const rootRef = getUserRef(user);
    return executeTransaction(db, async transaction => {
        const rootSnapshot = await transaction.get(rootRef);
        const metadata = getCloudMetadata(rootSnapshot);
        if (!metadata.syncLock) return metadata.revision;
        if (!isSyncLockStale(metadata.syncLock)) throw new CloudSyncInProgressError();

        const revision = Math.max(
            metadata.revision,
            normalizeCloudRevision(metadata.syncLock.targetRevision)
        );
        transaction.set(rootRef, {
            revision,
            syncLock: deleteField(),
            syncRecoveredAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        }, { merge: true });
        return revision;
    });
}

async function getStableUserRootSnapshot(user) {
    const rootRef = getUserRef(user);
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const snapshot = await getDoc(rootRef);
        const metadata = getCloudMetadata(snapshot);
        if (!metadata.syncLock) return snapshot;
        if (isSyncLockStale(metadata.syncLock)) {
            await recoverStaleSyncLock(user);
            return getDoc(rootRef);
        }
        await waitBeforeRetry(250);
    }
    throw new CloudSyncInProgressError();
}

async function loadUserDiffData(user) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const rootBefore = await getStableUserRootSnapshot(user);
        const beforeMetadata = getCloudMetadata(rootBefore);
        const [settingsSnap, customWords, wordOverrides, deletedDefaults, folders] = await Promise.all([
            getDoc(getSettingsRef(user)),
            readUserCollection(user, 'customWords'),
            readUserCollection(user, 'wordOverrides'),
            readUserCollection(user, 'deletedDefaults'),
            readUserCollection(user, 'folders')
        ]);
        const rootAfter = await getDoc(getUserRef(user));
        const afterMetadata = getCloudMetadata(rootAfter);

        if (afterMetadata.syncLock || afterMetadata.revision !== beforeMetadata.revision) {
            await waitBeforeRetry(100 * (attempt + 1));
            continue;
        }

        if (rootAfter.exists()) {
            const legacyData = afterMetadata.data;
            const hasLegacyData = Array.isArray(legacyData.words) ||
                Array.isArray(legacyData.folders) ||
                !!legacyData.settings;
            if (hasLegacyData && !legacyData.migratedToDiffStorageAt) {
                const migratedData = normalizeUserData(legacyData);
                const result = await saveDiffChangesToCloud(
                    createDefaultUserData(),
                    migratedData,
                    user,
                    { cleanupLegacy: true, expectedRevision: afterMetadata.revision }
                );
                return { ...migratedData, revision: result.revision };
            }
        }

        return {
            ...buildUserDataFromDiffs({
                settings: settingsSnap.exists() ? settingsSnap.data() : null,
                customWords,
                wordOverrides,
                deletedDefaultIds: deletedDefaults
                    .filter(item => item.deleted !== false)
                    .map(item => item.id),
                folders
            }),
            revision: afterMetadata.revision
        };
    }
    throw new Error('雲端資料在載入期間持續更新，請稍後再試。');
}

function requireLoginForChange() {
    if (currentUser) return true;
    alert('請先登入 Google 帳號，才能新增、編輯、儲存待複習狀態或同步個人資料。');
    return false;
}

function isCloudConsistencyError(error) {
    return error && [
        'cloud-partial-commit',
        'cloud-revision-conflict',
        'cloud-sync-in-progress'
    ].includes(error.code);
}

function getCloudRecoveryMessage(error, reloaded) {
    if (!reloaded) {
        return '雲端狀態可能已變更，但重新載入失敗。請重新整理頁面後再操作。';
    }
    if (error.code === 'cloud-partial-commit') {
        return '部分資料可能已同步，已重新載入雲端狀態。';
    }
    if (error.code === 'cloud-revision-conflict') {
        return '偵測到其他分頁或裝置的更新，已重新載入雲端最新資料。請重新執行剛才的操作。';
    }
    return '另一個分頁或裝置正在同步，已重新載入雲端狀態。請稍後再試。';
}

async function commitUserMutation(mutator, { requireAuth = true, afterRollback = null } = {}) {
    if (isCloudLoading) {
        alert('雲端資料仍在載入，請稍候再試。');
        return false;
    }
    if (!currentUser) {
        if (requireAuth) {
            requireLoginForChange();
            return false;
        }
        mutator(state);
        state.words = ensureWordIdentities(state.words);
        state.folders = normalizeFolders(state.folders, state.words, state.settings);
        refreshFolders();
        return true;
    }

    const previous = snapshotUserState();
    const mutationUser = currentUser;
    try {
        mutator(state);
        state.words = ensureWordIdentities(state.words);
        state.folders = normalizeFolders(state.folders, state.words, state.settings);
        refreshFolders();
        await saveDiffChangesToCloud(previous, snapshotUserState(), mutationUser, {
            expectedRevision: cloudRevision
        });
        return true;
    } catch (err) {
        let reloaded = false;
        if (isCloudConsistencyError(err) && currentUser && currentUser.uid === mutationUser.uid) {
            try {
                reloaded = await loadFromCloud(mutationUser);
            } catch (reloadError) {
                console.error('重新載入雲端狀態失敗', reloadError);
            }
        }
        if (!reloaded) restoreUserState(previous);
        refreshFolders();
        console.error('使用者資料儲存失敗', err);
        if (isCloudConsistencyError(err)) {
            alert(getCloudRecoveryMessage(err, reloaded));
        } else {
            alert('資料儲存失敗，已還原剛剛的變更：' + (err.message || err));
        }
        if (typeof afterRollback === 'function') afterRollback();
        rerenderVisibleView();
        return false;
    }
}

async function loadFromCloud(user, generation = ++cloudLoadGeneration) {
    isCloudLoading = true;
    updateAuthUI(currentUser);
    try {
        const data = await loadUserDiffData(user);
        if (generation !== cloudLoadGeneration || !currentUser || currentUser.uid !== user.uid) return false;
        acknowledgeCloudRevision(data.revision);
        applyUserData(data);
        return true;
    } finally {
        if (generation === cloudLoadGeneration) {
            isCloudLoading = false;
            updateAuthUI(currentUser);
        }
    }
}

function stopUserRevisionListener() {
    if (typeof unsubscribeUserRevision === 'function') unsubscribeUserRevision();
    unsubscribeUserRevision = null;
}

function startUserRevisionListener(user) {
    stopUserRevisionListener();
    unsubscribeUserRevision = subscribeToSnapshot(getUserRef(user), snapshot => {
        if (!currentUser || currentUser.uid !== user.uid) return;
        const observedRevision = getObservedCloudRevision(getCloudMetadata(snapshot));
        if (observedRevision > cloudRevision) {
            pendingRemoteRevision = Math.max(pendingRemoteRevision, observedRevision);
            updateAuthUI(currentUser);
        }
    }, error => {
        console.error('監聽雲端資料版本失敗', error);
    });
}

function setupAudioSystem() {
    let audio = document.getElementById('bgm-audio');
    if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'bgm-audio';
        audio.className = 'hidden';
        document.body.appendChild(audio);
    }
    audio.loop = true;
    audio.preload = 'auto';
    const track = getCurrentBgmTrack();
    if (track) audio.src = track.url;
    audio.onerror = () => {
        console.error('背景音樂載入失敗', {
            src: audio.currentSrc || audio.src,
            error: audio.error
        });
    };
    state.audio.bgmElement = audio;
    applyBgmSettingsToElement();
}

function applyBgmSettingsToElement() {
    const audio = state.audio && state.audio.bgmElement;
    if (!audio) return;
    audio.volume = clamp01(state.settings.bgmVolume);
    if (state.settings.bgmEnabled) {
        audio.play().catch(() => {});
    } else {
        audio.pause();
    }
}

function setupBgmAutoplayUnlock() {
    const audio = state.audio && state.audio.bgmElement;
    if (!audio) return;
    const tryPlay = () => {
        if (!state.settings || !state.settings.bgmEnabled) return;
        audio.play().catch(() => {});
        window.removeEventListener('click', tryPlay);
        window.removeEventListener('touchstart', tryPlay);
        window.removeEventListener('keydown', tryPlay);
    };
    window.addEventListener('click', tryPlay, { once: true });
    window.addEventListener('touchstart', tryPlay, { once: true });
    window.addEventListener('keydown', tryPlay, { once: true });
}

function speakWord(text) {
    if (!('speechSynthesis' in window)) {
        alert('此瀏覽器不支援單字發音');
        return;
    }
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.8;
    utterance.volume = clamp01(state.settings.speechVolume);

    const bgmEl = state.audio && state.audio.bgmElement;
    const shouldDuck = bgmEl && !bgmEl.paused && state.settings.bgmEnabled;
    if (shouldDuck) {
        bgmDucking.isDucking = true;
        bgmEl.volume = clamp01(state.settings.bgmVolume * bgmDucking.ratio);
        const restore = () => {
            bgmDucking.isDucking = false;
            bgmEl.volume = clamp01(state.settings.bgmVolume);
            utterance.onend = null;
            utterance.onerror = null;
        };
        utterance.onend = restore;
        utterance.onerror = restore;
    }
    window.speechSynthesis.speak(utterance);
}

function getWordKey(word = {}) {
    return word.id || word.defaultId || `english:${String(word.english || '').toLowerCase()}`;
}

function wordIsInFolder(word, folderId) {
    if (folderId === WRONG_FOLDER) return !!word.isWrong;
    if (folderId === UNFILED_FOLDER) return !word.folderId;
    return word.folderId === folderId;
}

function setElementVisible(element, visible) {
    if (!element) return;
    element.classList.toggle('hidden', !visible);
    element.hidden = !visible;
    element.toggleAttribute('hidden', !visible);
    element.toggleAttribute('inert', !visible);
    element.setAttribute('aria-hidden', String(!visible));
    if ('inert' in element) element.inert = !visible;
}

function updateAppLoading(message) {
    const loadingMessage = document.getElementById('app-loading-message');
    if (loadingMessage) loadingMessage.textContent = message;
}

function finishAppLoading() {
    const loading = document.getElementById('app-loading');
    document.body.setAttribute('aria-busy', 'false');
    if (!loading) return;
    loading.classList.add('is-ready');
    loading.setAttribute('aria-hidden', 'true');
    setTimeout(() => loading.remove(), 200);
}

function failAppLoading(message) {
    const loading = document.getElementById('app-loading');
    const title = document.getElementById('app-loading-title');
    document.body.setAttribute('aria-busy', 'false');
    if (!loading) {
        const fallback = document.createElement('main');
        fallback.className = 'p-6 text-center text-red-600 font-bold';
        fallback.textContent = message;
        document.body.replaceChildren(fallback);
        return;
    }
    loading.classList.add('is-error');
    loading.setAttribute('role', 'alert');
    if (title) title.textContent = '載入失敗';
    updateAppLoading(message);
}

function getFocusableElements(container) {
    return Array.from(container.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )).filter(element => !element.hidden && element.getClientRects().length > 0);
}

function openModal(modalOrId, initialFocusSelector = '') {
    const modal = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
    if (!modal) return;
    const trigger = document.activeElement;
    if (trigger && trigger !== document.body && !modal.contains(trigger)) {
        modalReturnFocus.set(modal, trigger);
    }
    setElementVisible(modal, true);
    requestAnimationFrame(() => {
        const preferred = initialFocusSelector ? modal.querySelector(initialFocusSelector) : null;
        const target = preferred || getFocusableElements(modal)[0];
        if (target) target.focus();
    });
}

function closeModal(modalOrId, { restoreFocus = true } = {}) {
    const modal = typeof modalOrId === 'string' ? document.getElementById(modalOrId) : modalOrId;
    if (!modal || modal.dataset.busy === 'true') return false;
    setElementVisible(modal, false);
    if (restoreFocus) {
        const trigger = modalReturnFocus.get(modal);
        if (trigger && trigger.isConnected && typeof trigger.focus === 'function') {
            requestAnimationFrame(() => trigger.focus());
        }
    }
    modalReturnFocus.delete(modal);
    return true;
}

function closeRenameModal() {
    closeModal('rename-modal');
}

function closeConfirmModal() {
    if (!closeModal('confirm-modal')) return;
    state.pendingDeleteType = null;
}

function closeNewFolderModal() {
    closeModal('new-folder-modal');
}

function getOpenModal() {
    return Array.from(document.querySelectorAll('[role="dialog"]'))
        .reverse()
        .find(modal => !modal.hidden && !modal.classList.contains('hidden')) || null;
}

function requestCloseModal(modal) {
    if (!modal || modal.dataset.busy === 'true') return;
    if (modal.id === 'add-modal') closeAddModal();
    else if (modal.id === 'folder-action-modal') closeActionModal();
    else if (modal.id === 'rename-modal') closeRenameModal();
    else if (modal.id === 'confirm-modal') closeConfirmModal();
    else if (modal.id === 'new-folder-modal') closeNewFolderModal();
    else if (modal.id === 'settings-modal') void closeSettingsModal();
}

function handleModalKeydown(event) {
    const modal = getOpenModal();
    if (!modal) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        requestCloseModal(modal);
        return;
    }
    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements(modal);
    if (!focusable.length) {
        event.preventDefault();
        modal.focus();
        return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!modal.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

function initializeModalAccessibility() {
    document.querySelectorAll('[id$="-modal"]').forEach(modal => {
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.tabIndex = -1;
        if (modal.classList.contains('hidden')) setElementVisible(modal, false);
    });
    document.addEventListener('keydown', handleModalKeydown);
}

function navigateTo(viewId) {
    showView(viewId);
    try {
        const url = new URL(window.location);
        url.searchParams.set('page', viewId);
        history.pushState({ viewId }, '', url);
    } catch (e) {
        console.log('History API not available:', e);
    }
}

window.onpopstate = event => {
    const viewId =
        (event.state && event.state.viewId) ||
        new URL(window.location).searchParams.get('page') ||
        'home';
    showView(viewId);
};

function showView(viewId) {
    document.querySelectorAll('main > div').forEach(div => setElementVisible(div, false));
    const target = document.getElementById(`view-${viewId}`);
    if (target) setElementVisible(target, true);

    if (viewId === 'library') renderLibrary();
    if (viewId === 'practice') {
        renderPracticeOptions();
        setTimeout(renderPracticeWordSelection, 50);
    }
    window.scrollTo(0, 0);

    if (viewId !== 'library') {
        state.isEditing = false;
        updateEditUI();
    }

    const titleMap = {
        home: '單字王 - 首頁',
        library: '單字王 - 單字庫',
        practice: '單字王 - 練習區',
        'word-list': '單字王 - 單字列表'
    };
    document.title = titleMap[viewId] || '單字王 - 核心系統';
}

function findWordCardById(cards, wordId) {
    return Array.from(cards || []).find(card => card.dataset.wordId === wordId) || null;
}

function searchWord() {
    const input = document.getElementById('search-input');
    const query = input.value.trim().toLowerCase();
    if (!query) return;

    const foundWord = state.words.find(w =>
        w.english.toLowerCase() === query ||
        (w.meaning || '').toLowerCase().includes(query)
    );

    if (!foundWord) {
        alert('找不到這個單字。');
        return;
    }

    const targetFolderId = foundWord.folderId || UNFILED_FOLDER;
    const targetWordId = getWordKey(foundWord);

    navigateTo('library');
    showView('word-list');
    renderWordList(targetFolderId);
    setTimeout(() => {
        const targetCard = findWordCardById(document.querySelectorAll('.word-card'), targetWordId);
        if (targetCard) {
            targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetCard.classList.add('highlight-card');
            setTimeout(() => targetCard.classList.remove('highlight-card'), 1500);
        }
    }, 100);
}

function toggleEditMode() {
    state.isEditing = !state.isEditing;
    updateEditUI();
    renderLibrary();
}

function updateEditUI() {
    const hint = document.getElementById('edit-hint');
    const btn = document.getElementById('btn-edit-folders');
    if (!hint || !btn) return;
    if (state.isEditing) {
        setElementVisible(hint, true);
        btn.classList.replace('bg-orange-500', 'bg-gray-500');
        btn.innerText = '完成編輯';
    } else {
        setElementVisible(hint, false);
        btn.classList.replace('bg-gray-500', 'bg-orange-500');
        btn.innerText = '管理資料夾';
    }
}

function openNewFolderModal() {
    if (!requireLoginForChange()) return;
    document.getElementById('input-new-folder-name').value = '';
    openModal('new-folder-modal', '#input-new-folder-name');
}

async function confirmNewFolder() {
    if (!requireLoginForChange()) return;
    const validation = validateFolderName(document.getElementById('input-new-folder-name').value);
    if (!validation.valid) {
        alert(validation.message);
        return;
    }
    const name = validation.name;

    const ok = await commitUserMutation(draft => {
        if (!draft.folders.includes(name)) draft.folders.push(name);
        draft.folders = normalizeFolders(draft.folders, draft.words, draft.settings);
    });
    if (!ok) return;

    closeModal('new-folder-modal');
    renderLibrary();
}

function handleFolderClick(name) {
    if (state.isEditing) {
        if (name === WRONG_FOLDER || name === UNFILED_FOLDER || state.categories.includes(name)) {
            alert('系統資料夾不能編輯。');
            return;
        }
        openActionModal(name);
    } else {
        renderWordList(name);
        const url = new URL(window.location);
        url.searchParams.set('page', 'library');
        history.pushState({ viewId: 'library' }, '', url);
    }
}

function openActionModal(folderName) {
    state.targetFolderAction = folderName;
    document.getElementById('action-folder-name').innerText = getFolderDisplayName(folderName);
    openModal('folder-action-modal');
}

function closeActionModal(options = {}) {
    closeModal('folder-action-modal', options);
}

function prepareRenameFolder() {
    if (!requireLoginForChange()) return;
    const actionModal = document.getElementById('folder-action-modal');
    const originalTrigger = actionModal ? modalReturnFocus.get(actionModal) : null;
    closeActionModal({ restoreFocus: false });
    document.getElementById('input-rename-folder').value = getFolderDisplayName(state.targetFolderAction);
    openModal('rename-modal', '#input-rename-folder');
    if (originalTrigger) modalReturnFocus.set(document.getElementById('rename-modal'), originalTrigger);
}

async function executeRename() {
    if (!requireLoginForChange()) return;
    const oldName = state.targetFolderAction;
    const newName = document.getElementById('input-rename-folder').value.trim();

    if (newName === getFolderDisplayName(oldName)) {
        closeModal('rename-modal');
        state.targetFolderAction = '';
        return;
    }
    const validation = validateFolderName(newName, oldName);
    if (!validation.valid) {
        alert(validation.message);
        return;
    }
    const validatedName = validation.name;

    const isDefaultLesson = isLessonFolder(oldName);
    const ok = await commitUserMutation(draft => {
        draft.settings = cloneSettings(draft.settings);
        if (isDefaultLesson) {
            draft.settings.lessonFolderNames[oldName] = validatedName;
            if (!draft.folders.includes(oldName)) draft.folders.push(oldName);
        } else {
            draft.words = renameFolderInWords(draft.words, oldName, validatedName);
            draft.folders = draft.folders.map(f => f === oldName ? validatedName : f);
        }
        draft.folders = normalizeFolders(draft.folders, draft.words, draft.settings);
    });
    if (!ok) return;
    renderLibrary();
    closeModal('rename-modal');
    state.targetFolderAction = '';
}

function getFolderDeleteConfirmation(folderId, deleteAll) {
    const wordCount = state.words.filter(word => word.folderId === folderId).length;
    const folderDisplayName = getFolderDisplayName(folderId);
    if (deleteAll) {
        return {
            title: `永久刪除「${folderDisplayName}」？`,
            description: `將永久刪除：\n• 「${folderDisplayName}」資料夾\n• ${wordCount} 個單字\n\n被刪除的單字也會從待複習與目前練習資料中移除。\n\n此操作無法復原。`,
            submitLabel: `刪除資料夾與 ${wordCount} 個單字`,
            wordCount
        };
    }
    return {
        title: `刪除「${folderDisplayName}」資料夾？`,
        description: `此資料夾中的 ${wordCount} 個單字將保留，並移至「${UNFILED_FOLDER}」。`,
        submitLabel: '刪除資料夾',
        wordCount
    };
}

function prepareDeleteFolder(deleteAll) {
    if (!requireLoginForChange()) return;
    const actionModal = document.getElementById('folder-action-modal');
    const originalTrigger = actionModal ? modalReturnFocus.get(actionModal) : null;
    closeActionModal({ restoreFocus: false });
    state.pendingDeleteType = deleteAll ? 'all' : 'keep';

    const confirmation = getFolderDeleteConfirmation(state.targetFolderAction, deleteAll);
    document.getElementById('confirm-title').innerText = confirmation.title;
    document.getElementById('confirm-desc').innerText = confirmation.description;
    const submit = document.getElementById('confirm-submit');
    if (submit) submit.textContent = confirmation.submitLabel;
    openModal('confirm-modal', '#confirm-cancel');
    if (originalTrigger) modalReturnFocus.set(document.getElementById('confirm-modal'), originalTrigger);
}

function purgeDeletedWordReferences(deletedWordKeys) {
    if (!deletedWordKeys.size) return;
    const keepWord = word => word && !deletedWordKeys.has(getWordKey(word));
    state.game.currentWords = state.game.currentWords.filter(keepWord);
    state.game.wrongWords = new Set(Array.from(state.game.wrongWords).filter(keepWord));
    state.game.reviewSelection = state.game.reviewSelection.filter(keepWord);
    state.game.answeredHistory = state.game.answeredHistory.filter(entry => entry && keepWord(entry.word));
    state.game.viewingHistoryIndex = null;
    state.game.currentChoiceOptions = [];
    state.game.spellingDrafts = {};
    if (!state.game.currentWords.length) state.game.index = 0;
    else state.game.index = Math.min(state.game.index, state.game.currentWords.length - 1);
}

async function executeDelete() {
    if (isFolderDeleting || !requireLoginForChange()) return;
    const oldName = state.targetFolderAction;
    const type = state.pendingDeleteType;
    const deleteWords = type === 'all';
    if (!oldName || !type) return;
    const isDefaultLesson = isLessonFolder(oldName);
    const deletedWordKeys = new Set(
        deleteWords
            ? state.words.filter(word => word.folderId === oldName).map(getWordKey)
            : []
    );
    const modal = document.getElementById('confirm-modal');
    const cancel = document.getElementById('confirm-cancel');
    const submit = document.getElementById('confirm-submit');
    const originalSubmitText = submit ? submit.textContent : '';
    isFolderDeleting = true;
    if (modal) modal.dataset.busy = 'true';
    if (cancel) cancel.disabled = true;
    if (submit) {
        submit.disabled = true;
        submit.textContent = '刪除中...';
    }

    try {
        const ok = await commitUserMutation(draft => {
            draft.words = applyFolderDeletion(draft.words, oldName, deleteWords);
            draft.folders = draft.folders.filter(f => f !== oldName);
            draft.settings = cloneSettings(draft.settings);
            if (isDefaultLesson && !draft.settings.deletedLessonIds.includes(oldName)) {
                draft.settings.deletedLessonIds.push(oldName);
                delete draft.settings.lessonFolderNames[oldName];
            }
            draft.folders = normalizeFolders(draft.folders, draft.words, draft.settings);
        });
        if (!ok) return;
        if (deleteWords) purgeDeletedWordReferences(deletedWordKeys);
        renderLibrary();
        if (modal) modal.dataset.busy = 'false';
        closeModal(modal);
        state.targetFolderAction = '';
        state.pendingDeleteType = null;
    } finally {
        isFolderDeleting = false;
        if (modal) modal.dataset.busy = 'false';
        if (cancel) cancel.disabled = false;
        if (submit) {
            submit.disabled = false;
            submit.textContent = originalSubmitText;
        }
    }
}

function openAddModal(idx = -1) {
    if (!requireLoginForChange()) return;
    state.editingWordIndex = idx;
    const modal = document.getElementById('add-modal');
    const tagInput = document.getElementById('new-folder-name');
    const partOfSpeechInput = document.getElementById('new-part-of-speech');
    document.getElementById('modal-title').innerText = idx >= 0 ? '編輯單字' : '新增單字';

    if (idx >= 0) {
        const w = state.words[idx];
        document.getElementById('new-word').value = w.english;
        document.getElementById('new-meaning').value = w.meaning;
        if (partOfSpeechInput) partOfSpeechInput.value = normalizePartOfSpeech(w.partOfSpeech);
        renderFolderSelection(w.folderId || '', !!w.isWrong);
    } else {
        document.getElementById('new-word').value = '';
        document.getElementById('new-meaning').value = '';
        if (partOfSpeechInput) partOfSpeechInput.value = '';
        let preSelectedFolderId = '';
        const currentTitle = document.getElementById('list-title');
        const current = currentTitle?.dataset.folderId || currentTitle?.innerText;
        if (current && !state.categories.includes(current) && current !== '全部' && current !== WRONG_FOLDER && current !== UNFILED_FOLDER) {
            preSelectedFolderId = current;
        }
        renderFolderSelection(preSelectedFolderId, current === WRONG_FOLDER);
    }
    if (tagInput) tagInput.value = '';
    openModal(modal, '#new-word');
}

function closeAddModal() {
    closeModal('add-modal');
    state.editingWordIndex = -1;
}

function renderFolderSelection(selectedFolderId = '', isWrong = false) {
    const container = document.getElementById('folder-selection-container');
    if (!container) return;
    container.replaceChildren();

    const normalFolderIds = state.folderIds.filter(folderId => folderId !== WRONG_FOLDER);
    if (!normalFolderIds.length) {
        const empty = document.createElement('div');
        empty.className = 'text-xs text-gray-400';
        empty.textContent = '目前沒有資料夾，請先建立。';
        container.appendChild(empty);
    }

    normalFolderIds.forEach((folderId, index) => {
        const label = document.createElement('label');
        label.className = 'inline-flex items-center space-x-2 mr-3 mb-1';

        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'word-folder';
        radio.className = 'folder-radio w-4 h-4 text-indigo-600';
        radio.value = folderId === UNFILED_FOLDER ? '' : folderId;
        radio.id = `folder-radio-${index}`;
        radio.checked = folderId === UNFILED_FOLDER ? !selectedFolderId : selectedFolderId === folderId;

        const span = document.createElement('span');
        span.className = 'text-sm text-gray-700';
        span.textContent = getFolderDisplayName(folderId);

        label.append(radio, span);
        container.appendChild(label);
    });

    const wrongLabel = document.createElement('label');
    wrongLabel.className = 'flex items-center space-x-2 mt-2 pt-2 border-t border-gray-200';
    const wrongCheckbox = document.createElement('input');
    wrongCheckbox.type = 'checkbox';
    wrongCheckbox.id = 'wrong-checkbox';
    wrongCheckbox.className = 'w-4 h-4 text-red-500 rounded';
    wrongCheckbox.checked = isWrong;
    const wrongText = document.createElement('span');
    wrongText.className = 'text-sm text-red-500 font-bold';
    wrongText.textContent = '加入待複習';
    wrongLabel.append(wrongCheckbox, wrongText);
    container.appendChild(wrongLabel);
}

async function saveNewWord() {
    if (!requireLoginForChange()) return;
    const eng = document.getElementById('new-word').value.trim();
    const mean = document.getElementById('new-meaning').value.trim();
    const partOfSpeech = normalizePartOfSpeech(document.getElementById('new-part-of-speech')?.value);
    const tagInputEl = document.getElementById('new-folder-name');
    if (!eng || !mean) {
        alert('請輸入英文與中文意思。');
        return;
    }

    const selectedFolder = document.querySelector('.folder-radio:checked');
    const newFolderName = tagInputEl ? tagInputEl.value.trim() : '';
    if (/[,，]/.test(newFolderName)) {
        alert('一個單字只能選擇一個資料夾，請只輸入一個資料夾名稱。');
        return;
    }
    let validatedNewFolderName = '';
    if (newFolderName) {
        const validation = validateFolderName(newFolderName);
        if (!validation.valid) {
            alert(validation.message);
            return;
        }
        validatedNewFolderName = validation.name;
    }
    const folderId = validatedNewFolderName || (selectedFolder ? selectedFolder.value : '');
    const isWrong = !!document.getElementById('wrong-checkbox')?.checked;

    const editingIndex = state.editingWordIndex;
    const previousWord = editingIndex >= 0 ? cloneWord(state.words[editingIndex]) : null;
    const previousEnglish = previousWord ? previousWord.english : '';
    const data = previousWord
        ? { ...previousWord, english: eng, meaning: mean, partOfSpeech, folderId, isWrong }
        : {
            id: createCustomWordId(),
            source: 'custom',
            english: eng,
            meaning: mean,
            partOfSpeech,
            folderId,
            isWrong,
            createdAt: new Date().toISOString()
        };
    const ok = await commitUserMutation(draft => {
        if (folderId && !draft.folders.includes(folderId)) draft.folders.push(folderId);
        if (editingIndex >= 0) {
            const targetIndex = previousWord && previousWord.id
                ? draft.words.findIndex(w => w.id === previousWord.id)
                : draft.words.findIndex(w => w.english.toLowerCase() === previousEnglish.toLowerCase());
            if (targetIndex >= 0) draft.words[targetIndex] = data;
            else draft.words.push(data);
        } else {
            draft.words.push(data);
        }
        draft.folders = normalizeFolders(draft.folders, draft.words, draft.settings);
    });
    if (!ok) return;
    closeAddModal();

    if (!document.getElementById('view-word-list').classList.contains('hidden')) {
        const listTitle = document.getElementById('list-title');
        renderWordList(listTitle.dataset.folderId || listTitle.innerText);
    } else {
        renderLibrary();
    }
}

function renderLibrary() {
    refreshFolders();
    const grid = document.getElementById('category-grid');
    grid.replaceChildren();
    grid.classList.toggle('editing-mode', state.isEditing);

    if (state.words.length === 0 && state.folders.length <= 1) {
        setElementVisible(document.getElementById('empty-library-hint'), true);
        return;
    }

    setElementVisible(document.getElementById('empty-library-hint'), false);
    if (!state.isEditing) {
        state.categories.forEach(cat => {
            if (state.words.some(w => w.english.toUpperCase().startsWith(cat))) {
                grid.appendChild(createCatBtn(cat, 'bg-white text-indigo-600 border border-indigo-100', false, cat));
            }
        });
    }

    state.folderIds.forEach(folderId => {
        const isWrongFolder = folderId === WRONG_FOLDER;
        const isSystem = isWrongFolder || folderId === UNFILED_FOLDER;
        const count = state.words.filter(word => wordIsInFolder(word, folderId)).length;
        const style = isWrongFolder ? 'bg-red-500 text-white font-bold' : 'bg-indigo-600 text-white font-bold';
        grid.appendChild(createCatBtn(`${getFolderDisplayName(folderId)} (${count})`, style, !isSystem, folderId));
    });
}

function createCatBtn(name, cls, editable, oriName) {
    const div = document.createElement('div');
    div.className = `${cls} folder-card relative min-h-[80px] rounded-2xl flex items-center justify-center shadow-sm cursor-pointer active:scale-95 transition-all text-lg text-center px-2 break-all leading-tight`;

    const span = document.createElement('span');
    span.textContent = name;
    div.appendChild(span);

    if (state.isEditing && editable) {
        const edit = document.createElement('span');
        edit.className = 'absolute top-1 right-1 text-xs bg-white text-red-500 rounded-full w-5 h-5 flex items-center justify-center';
        edit.textContent = '✎';
        div.appendChild(edit);
    }

    div.addEventListener('click', () => handleFolderClick(oriName || name.split(' ')[0]));
    return div;
}

function renderWordList(name) {
    showView('word-list');
    const listTitle = document.getElementById('list-title');
    listTitle.innerText = getFolderDisplayName(name);
    listTitle.dataset.folderId = name;
    const container = document.getElementById('words-container');
    container.replaceChildren();

    let filtered = state.words.map((w, i) => ({ ...w, idx: i }));
    if (name.length === 1 && state.categories.includes(name)) {
        filtered = filtered.filter(w => w.english.toUpperCase().startsWith(name));
    } else {
        filtered = filtered.filter(w => wordIsInFolder(w, name));
    }
    filtered.sort((a, b) => a.english.localeCompare(b.english));

    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'text-center py-10 w-full';
        const title = document.createElement('p');
        title.className = 'text-lg font-bold text-gray-600';
        title.textContent = '這個資料夾還沒有單字';
        const description = document.createElement('p');
        description.className = 'text-sm text-gray-400 mt-2';
        description.textContent = '新增第一個單字，開始建立你的單字庫。';
        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'mt-4 bg-indigo-600 text-white px-4 py-2 rounded-lg font-bold shadow-md active:scale-95 transition';
        addButton.textContent = '＋ 新增單字';
        addButton.addEventListener('click', () => openAddModal());
        empty.append(title, description, addButton);
        container.appendChild(empty);
        return;
    }

    filtered.forEach(w => container.appendChild(createWordCard(w)));
}

function createWordCard(w) {
    const card = document.createElement('div');
    card.className = 'word-card w-full';
    card.dataset.wordId = getWordKey(w);

    const inner = document.createElement('div');
    inner.className = 'word-card-inner';

    const front = document.createElement('div');
    front.className = 'word-card-front bg-white border-2 border-indigo-50 p-6 relative flex flex-col justify-center items-center rounded-2xl';

    const editBtn = document.createElement('button');
    editBtn.className = 'absolute top-3 left-3 text-gray-400 hover:text-indigo-600 bg-white rounded-full p-1 shadow-sm z-20';
    editBtn.type = 'button';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', event => {
        event.stopPropagation();
        openAddModal(w.idx);
    });
    front.appendChild(editBtn);

    if (w.isWrong) {
        const badge = document.createElement('span');
        badge.className = 'absolute top-3 right-3 text-xs bg-red-100 text-red-500 px-2 py-1 rounded-full font-bold';
        badge.textContent = REVIEW_FOLDER_LABEL;
        front.appendChild(badge);
    }

    const english = document.createElement('span');
    english.className = 'text-3xl font-black text-indigo-900 break-all text-center cursor-pointer';
    english.title = '發音';
    english.textContent = w.english;
    english.addEventListener('click', event => {
        event.stopPropagation();
        speakWord(w.english);
    });
    front.appendChild(english);

    const back = document.createElement('div');
    back.className = 'word-card-back p-6 bg-indigo-50 border-2 border-indigo-200 flex flex-col rounded-2xl';
    parseMeaning(w.meaning, w.partOfSpeech).forEach(part => {
        const block = document.createElement('div');
        block.className = 'mb-3 text-indigo-800 font-bold text-lg';
        block.appendChild(document.createTextNode(part.text));
        const pos = document.createElement('span');
        pos.className = 'block text-sm text-indigo-400 opacity-90 mt-1';
        pos.textContent = part.pos;
        block.appendChild(pos);
        back.appendChild(block);
    });

    inner.append(front, back);
    card.appendChild(inner);
    card.addEventListener('click', () => card.classList.toggle('is-flipped'));
    return card;
}

function parseMeaning(raw, partOfSpeech = '') {
    const results = [];
    if (!raw) return results;
    const structuredPos = getPartOfSpeechShort(partOfSpeech);

    raw.split('/').map(b => b.trim()).filter(Boolean).forEach(block => {
        const idx = block.lastIndexOf('(');
        let textPart = block;
        let posPart = '';
        if (idx !== -1) {
            textPart = block.substring(0, idx).trim();
            posPart = block.substring(idx).trim();
        }
        const subTexts = textPart.split(/[;；]/).map(s => s.trim()).filter(Boolean);
        if (!subTexts.length) {
            results.push({ text: textPart, pos: posPart || structuredPos });
        } else {
            subTexts.forEach(t => results.push({ text: t, pos: posPart || structuredPos }));
        }
    });
    return results;
}

function getMeaningWithPartOfSpeech(word) {
    const meaning = String(word && word.meaning ? word.meaning : '');
    const structuredPos = getPartOfSpeechShort(word && word.partOfSpeech);
    if (!structuredPos || /\([^)]*\)/.test(meaning)) return meaning;
    return `${meaning} ${structuredPos}`;
}

function renderPracticeOptions() {
    refreshFolders();
    const select = document.getElementById('practice-scope');
    select.replaceChildren(new Option('全部單字夾', 'all'));
    state.folderIds.forEach(folderId => select.appendChild(new Option(getFolderDisplayName(folderId), folderId)));
}

function renderPracticeWordSelection() {
    const scope = document.getElementById('practice-scope').value;
    const container = document.getElementById('practice-word-selection');
    const countLabel = document.getElementById('selection-count');
    container.replaceChildren();

    const pool = (scope === 'all')
        ? [...state.words]
        : state.words.filter(w => wordIsInFolder(w, scope));
    pool.sort((a, b) => a.english.localeCompare(b.english));

    if (!pool.length) {
        const empty = document.createElement('div');
        empty.className = 'text-gray-400 text-center py-4';
        empty.textContent = '此資料夾沒有單字';
        container.appendChild(empty);
        countLabel.innerText = '已選 0 個單字';
        updatePracticeStartButtons(0);
        return;
    }

    pool.forEach(word => {
        const div = document.createElement('div');
        div.className = 'flex items-center p-2 border-b border-gray-100 last:border-0 hover:bg-white transition';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'practice-checkbox w-5 h-5 text-indigo-600 rounded mr-3';
        checkbox.checked = true;
        checkbox.dataset.wordId = getWordKey(word);
        checkbox.addEventListener('change', updateSelectionCount);

        const info = document.createElement('div');
        info.className = 'flex-1 min-w-0';
        const en = document.createElement('div');
        en.className = 'font-bold text-gray-800 truncate';
        en.textContent = word.english;
        const mean = document.createElement('div');
        mean.className = 'text-xs text-gray-500 truncate';
        mean.textContent = getMeaningWithPartOfSpeech(word);
        info.append(en, mean);
        div.append(checkbox, info);
        container.appendChild(div);
    });
    updateSelectionCount();
}

function updateSelectionCount() {
    const checkboxes = document.querySelectorAll('.practice-checkbox:checked');
    document.getElementById('selection-count').innerText = `已選 ${checkboxes.length} 個單字`;
    updatePracticeStartButtons(checkboxes.length);
}

function updatePracticeStartButtons(selectedCount) {
    const disabled = selectedCount <= 0;
    document.querySelectorAll('#view-practice [data-start-mode]').forEach(button => {
        button.disabled = disabled;
        button.setAttribute('aria-disabled', String(disabled));
    });
}

function toggleAllPracticeWords(checked) {
    document.querySelectorAll('.practice-checkbox').forEach(cb => {
        cb.checked = checked;
    });
    updateSelectionCount();
}

function shuffleArray(items) {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function startGame(mode) {
    const selectedWordIds = new Set(
        Array.from(document.querySelectorAll('.practice-checkbox:checked')).map(cb => cb.dataset.wordId)
    );
    const pool = state.words.filter(word => selectedWordIds.has(getWordKey(word)));
    if (!pool.length) {
        return;
    }

    if (mode.startsWith('choice') && pool.length < 5) {
        if (state.words.length >= 5) alert('選擇題至少需要 5 個選項，將從全部單字補足選項。');
        else {
            alert('單字總數至少需要 5 個才能進行選擇題。');
            return;
        }
    }

    state.game.mode = mode;
    state.game.currentWords = shuffleArray(pool);
    state.game.index = 0;
    state.game.wrongWords = new Set();
    state.game.reviewSelection = [];
    state.game.answeredHistory = [];
    state.game.viewingHistoryIndex = null;
    state.game.currentChoiceOptions = [];
    state.game.currentHadMistake = false;
    state.game.spellingDrafts = {};

    showView(mode === 'spelling' ? 'game-spelling' : 'game-choice');
    if (mode === 'spelling') loadSpellingWord();
    else loadChoiceQuestion();
}

function quitGameAndSave() {
    if (!state.game.currentWords.length) {
        showView('practice');
        return;
    }
    endGame(true);
}

function isReviewingHistory() {
    return state.game.viewingHistoryIndex !== null;
}

function getCurrentWord() {
    return state.game.currentWords[state.game.index];
}

function captureCurrentSpellingDraft() {
    if (state.game.mode !== 'spelling' || isReviewingHistory()) return;
    const input = document.getElementById('spelling-input');
    if (input) state.game.spellingDrafts[state.game.index] = input.value;
}

function setGameplayInputsEnabled(enabled) {
    const spellingInput = document.getElementById('spelling-input');
    if (spellingInput) spellingInput.disabled = !enabled;
    document.querySelectorAll('#view-game-spelling .space-y-4 button').forEach(btn => {
        btn.disabled = !enabled;
    });
    document.querySelectorAll('#choice-options button').forEach(btn => {
        btn.disabled = !enabled;
    });
}

function setProgressForIndex(prefix, index, total, isReview = false) {
    if (!Number.isFinite(total) || total <= 0) return;
    const text = document.getElementById(`${prefix}-progress-text`);
    const bar = document.getElementById(`${prefix}-progress-bar`);
    if (text) text.innerText = `${index + 1} / ${total}${isReview ? '（查看）' : ''}`;
    if (bar) bar.style.width = `${((index + 1) / total) * 100}%`;
}

function updateHistoryControls() {
    const history = state.game.answeredHistory;
    const viewing = state.game.viewingHistoryIndex;
    document.querySelectorAll('[data-game-nav="prev"]').forEach(btn => {
        const target = viewing === null ? history.length - 1 : viewing - 1;
        btn.disabled = target < 0;
    });
    document.querySelectorAll('[data-game-nav="current"]').forEach(btn => {
        const isViewingHistory = viewing !== null;
        btn.disabled = !isViewingHistory;
        btn.textContent = `回到第 ${state.game.index + 1} 題`;
        btn.classList.toggle('invisible', !isViewingHistory);
        btn.toggleAttribute('inert', !isViewingHistory);
        btn.setAttribute('aria-hidden', String(!isViewingHistory));
    });
    document.querySelectorAll('[data-game-nav="next"]').forEach(btn => {
        btn.disabled = viewing === null || viewing + 1 >= history.length;
    });
}

function createAnswerRecord({ word, result, userAnswer = '', choices = [] }) {
    return {
        index: state.game.index,
        mode: state.game.mode,
        word,
        result,
        userAnswer,
        correctAnswer: word.english,
        meaning: word.meaning,
        partOfSpeech: normalizePartOfSpeech(word.partOfSpeech),
        choices: choices.map(choice => ({
            text: choice.text,
            isCorrect: !!choice.isCorrect,
            isSelected: !!choice.isSelected
        }))
    };
}

function recordAnsweredQuestion(record) {
    state.game.answeredHistory[state.game.index] = record;
}

function loadSpellingWord() {
    const word = getCurrentWord();
    const total = state.game.currentWords.length;
    if (!word || total <= 0) {
        showView('practice');
        return;
    }
    state.game.viewingHistoryIndex = null;
    state.game.currentHadMistake = false;
    setProgressForIndex('spelling', state.game.index, total);

    const defArea = document.getElementById('spelling-definition-area');
    defArea.replaceChildren();
    parseMeaning(word.meaning, word.partOfSpeech).forEach(part => {
        const wrap = document.createElement('div');
        wrap.className = 'flex flex-col items-center mb-3';
        const text = document.createElement('div');
        text.className = 'text-2xl font-extrabold text-gray-800 text-center';
        text.textContent = part.text;
        const pos = document.createElement('div');
        pos.className = 'mt-1 px-4 py-1 bg-indigo-50 text-indigo-500 rounded-full text-sm font-bold border border-indigo-100';
        pos.textContent = part.pos || '(?)';
        wrap.append(text, pos);
        defArea.appendChild(wrap);
    });

    const eng = word.english;
    const hint = eng.length > 2
        ? eng[0] + '_'.repeat(eng.length - 2) + eng[eng.length - 1]
        : eng[0] + '_'.repeat(Math.max(0, eng.length - 1));
    document.getElementById('spelling-hint').innerText = hint.split('').join(' ');
    document.getElementById('spelling-input').value = state.game.spellingDrafts[state.game.index] || '';
    document.getElementById('spelling-feedback').innerText = '';
    document.getElementById('spelling-review-answer').classList.add('hidden');
    setGameplayInputsEnabled(true);
    updateHistoryControls();
}

function checkSpellingAnswer() {
    if (isReviewingHistory()) return;
    const input = document.getElementById('spelling-input');
    const word = getCurrentWord();
    const correct = word.english.toLowerCase();
    if (input.value.trim().toLowerCase() === correct) {
        const feedback = document.getElementById('spelling-feedback');
        feedback.className = 'mt-4 text-green-500 font-bold';
        feedback.innerText = '答對了！';
        setGameplayInputsEnabled(false);
        recordAnsweredQuestion(createAnswerRecord({
            word,
            result: state.game.currentHadMistake ? 'correct-after-wrong' : 'correct',
            userAnswer: input.value.trim()
        }));
        setTimeout(nextQuestion, 600);
    } else {
        handleWrongAnswer(input.parentElement);
    }
}

function skipSpellingWord() {
    if (isReviewingHistory()) return;
    const word = getCurrentWord();
    state.game.wrongWords.add(word);
    document.getElementById('spelling-input').value = word.english;
    const feedback = document.getElementById('spelling-feedback');
    feedback.className = 'mt-4 text-orange-500 font-bold';
    feedback.innerText = `跳過：${word.english}`;
    setGameplayInputsEnabled(false);
    recordAnsweredQuestion(createAnswerRecord({
        word,
        result: 'skipped',
        userAnswer: ''
    }));
    setTimeout(nextQuestion, 1500);
}

function loadChoiceQuestion() {
    const word = getCurrentWord();
    const total = state.game.currentWords.length;
    if (!word || total <= 0) {
        showView('practice');
        return;
    }
    state.game.viewingHistoryIndex = null;
    setProgressForIndex('choice', state.game.index, total);
    document.getElementById('choice-feedback').innerText = '';

    const isEnToCh = state.game.mode === 'choice-en-ch';
    document.getElementById('choice-question').innerText = isEnToCh ? word.english : formatMeaning(word.meaning, word.partOfSpeech);

    const options = [word];
    const pool = state.game.currentWords.length >= 5 ? state.game.currentWords : state.words;
    while (options.length < 5) {
        const randomWord = pool[Math.floor(Math.random() * pool.length)];
        if (!options.includes(randomWord)) options.push(randomWord);
    }
    state.game.currentChoiceOptions = shuffleArray(options);
    renderChoiceOptions(word, state.game.currentChoiceOptions, isEnToCh);
    setGameplayInputsEnabled(true);
    updateHistoryControls();
}

function renderChoiceOptions(word, options, isEnToCh) {
    const optionsContainer = document.getElementById('choice-options');
    optionsContainer.replaceChildren();
    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = 'choice-btn w-full bg-white border-2 border-indigo-100 text-gray-700 font-bold py-4 rounded-xl text-lg shadow-sm hover:border-indigo-300';
        btn.innerText = isEnToCh ? formatMeaning(opt.meaning, opt.partOfSpeech) : opt.english;
        btn.addEventListener('click', () => {
            const allBtns = document.querySelectorAll('.choice-btn');
            allBtns.forEach(b => {
                b.disabled = true;
            });

            if (opt === word) {
                btn.classList.add('choice-correct');
                const feedback = document.getElementById('choice-feedback');
                feedback.className = 'mt-4 text-green-500 font-bold';
                feedback.innerText = '答對了！';
                recordAnsweredQuestion(createAnswerRecord({
                    word,
                    result: 'correct',
                    userAnswer: btn.innerText,
                    choices: options.map(choice => ({
                        text: isEnToCh ? formatMeaning(choice.meaning, choice.partOfSpeech) : choice.english,
                        isCorrect: choice === word,
                        isSelected: choice === opt
                    }))
                }));
                setTimeout(nextQuestion, 800);
            } else {
                btn.classList.add('choice-wrong');
                allBtns.forEach(b => {
                    if ((isEnToCh && b.innerText === formatMeaning(word.meaning, word.partOfSpeech)) ||
                        (!isEnToCh && b.innerText === word.english)) {
                        b.classList.add('choice-correct');
                    }
                });
                state.game.wrongWords.add(word);
                const feedback = document.getElementById('choice-feedback');
                feedback.className = 'mt-4 text-red-500 font-bold';
                feedback.innerText = '答錯了';
                recordAnsweredQuestion(createAnswerRecord({
                    word,
                    result: 'wrong',
                    userAnswer: btn.innerText,
                    choices: options.map(choice => ({
                        text: isEnToCh ? formatMeaning(choice.meaning, choice.partOfSpeech) : choice.english,
                        isCorrect: choice === word,
                        isSelected: choice === opt
                    }))
                }));
                setTimeout(nextQuestion, 1500);
            }
        });
        optionsContainer.appendChild(btn);
    });
}

function showHistoryEntry(entryIndex) {
    const entry = state.game.answeredHistory[entryIndex];
    if (!entry) return;
    captureCurrentSpellingDraft();
    state.game.viewingHistoryIndex = entryIndex;

    if (entry.mode === 'spelling') {
        showView('game-spelling');
        setProgressForIndex('spelling', entry.index, state.game.currentWords.length, true);
        const defArea = document.getElementById('spelling-definition-area');
        defArea.replaceChildren();
        parseMeaning(entry.meaning, entry.partOfSpeech).forEach(part => {
            const wrap = document.createElement('div');
            wrap.className = 'flex flex-col items-center mb-3';
            const text = document.createElement('div');
            text.className = 'text-2xl font-extrabold text-gray-800 text-center';
            text.textContent = part.text;
            const pos = document.createElement('div');
            pos.className = 'mt-1 px-4 py-1 bg-indigo-50 text-indigo-500 rounded-full text-sm font-bold border border-indigo-100';
            pos.textContent = part.pos || '(?)';
            wrap.append(text, pos);
            defArea.appendChild(wrap);
        });
        document.getElementById('spelling-hint').innerText = entry.correctAnswer.split('').join(' ');
        document.getElementById('spelling-input').value = entry.userAnswer || '';
        document.getElementById('spelling-feedback').className = 'mt-4 text-gray-500 font-bold';
        document.getElementById('spelling-feedback').innerText = describeAnswerResult(entry.result);
        const answer = document.getElementById('spelling-review-answer');
        answer.textContent = `答案：${entry.correctAnswer}`;
        answer.classList.remove('hidden');
        setGameplayInputsEnabled(false);
    } else {
        showView('game-choice');
        setProgressForIndex('choice', entry.index, state.game.currentWords.length, true);
        const isEnToCh = entry.mode === 'choice-en-ch';
        document.getElementById('choice-question').innerText = isEnToCh
            ? entry.word.english
            : formatMeaning(entry.word.meaning, entry.word.partOfSpeech);
        const container = document.getElementById('choice-options');
        container.replaceChildren();
        entry.choices.forEach(choice => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.disabled = true;
            btn.className = 'choice-btn w-full bg-white border-2 border-indigo-100 text-gray-700 font-bold py-4 rounded-xl text-lg shadow-sm';
            btn.innerText = choice.text;
            if (choice.isCorrect) btn.classList.add('choice-correct');
            if (choice.isSelected && !choice.isCorrect) btn.classList.add('choice-wrong');
            container.appendChild(btn);
        });
        document.getElementById('choice-feedback').className = 'mt-4 text-gray-500 font-bold';
        document.getElementById('choice-feedback').innerText = `${describeAnswerResult(entry.result)}，答案：${entry.correctAnswer}`;
    }
    updateHistoryControls();
}

function describeAnswerResult(result) {
    if (result === 'correct') return '這題答對';
    if (result === 'correct-after-wrong') return '這題曾答錯，最後答對';
    if (result === 'skipped') return '這題跳過';
    return '這題答錯';
}

function showCurrentQuestion() {
    state.game.viewingHistoryIndex = null;
    if (state.game.index >= state.game.currentWords.length) {
        endGame(false);
        return;
    }
    if (state.game.mode === 'spelling') {
        showView('game-spelling');
        loadSpellingWord();
        return;
    }
    showView('game-choice');
    const word = getCurrentWord();
    if (!state.game.currentChoiceOptions.length) {
        loadChoiceQuestion();
        return;
    }
    setProgressForIndex('choice', state.game.index, state.game.currentWords.length);
    document.getElementById('choice-question').innerText = state.game.mode === 'choice-en-ch'
        ? word.english
        : formatMeaning(word.meaning, word.partOfSpeech);
    document.getElementById('choice-feedback').innerText = '';
    renderChoiceOptions(word, state.game.currentChoiceOptions, state.game.mode === 'choice-en-ch');
    setGameplayInputsEnabled(true);
    updateHistoryControls();
}

function navigateHistory(direction) {
    if (direction === 'current') {
        showCurrentQuestion();
        return;
    }
    const history = state.game.answeredHistory;
    const current = state.game.viewingHistoryIndex;
    const target = direction === 'prev'
        ? (current === null ? history.length - 1 : current - 1)
        : (current === null ? null : current + 1);
    if (target === null || target < 0 || target >= history.length || !history[target]) return;
    showHistoryEntry(target);
}

function formatMeaning(raw, partOfSpeech = '') {
    const firstBlock = String(raw || '').split('/')[0].trim();
    const idx = firstBlock.lastIndexOf('(');
    let text = firstBlock;
    let pos = '';
    if (idx !== -1) {
        text = firstBlock.substring(0, idx).trim();
        pos = firstBlock.substring(idx).trim();
    }
    if (!pos) pos = getPartOfSpeechShort(partOfSpeech);
    const shortText = text.length > 15 ? text.substring(0, 15) + '...' : text;
    return pos ? `${shortText} ${pos}` : shortText;
}

function handleWrongAnswer(element) {
    const fbId = state.game.mode.startsWith('choice') ? 'choice-feedback' : 'spelling-feedback';
    const feedback = document.getElementById(fbId);
    feedback.className = 'mt-4 text-red-500 font-bold';
    feedback.innerText = '答錯了';
    element.classList.add('shake');
    setTimeout(() => element.classList.remove('shake'), 400);
    state.game.currentHadMistake = true;
    state.game.wrongWords.add(state.game.currentWords[state.game.index]);
}

function nextQuestion() {
    state.game.viewingHistoryIndex = null;
    state.game.currentChoiceOptions = [];
    state.game.index++;
    if (state.game.index < state.game.currentWords.length) {
        if (state.game.mode === 'spelling') loadSpellingWord();
        else loadChoiceQuestion();
    } else {
        endGame(false);
    }
}

function endGame(isAborted = false) {
    if (!state.game.currentWords.length) {
        showView('practice');
        return;
    }
    setElementVisible(document.getElementById('view-game-spelling'), false);
    setElementVisible(document.getElementById('view-game-choice'), false);
    setElementVisible(document.getElementById('view-game-result'), true);

    document.getElementById('result-title').innerText = isAborted ? '練習已結算' : '練習完成！';
    document.getElementById('result-icon').innerText = isAborted ? '📌' : '🎉';

    const wrongs = Array.from(state.game.wrongWords);
    document.getElementById('result-stat').innerText = `錯誤/跳過：${wrongs.length} 個`;
    state.game.reviewSelection = [];

    const list = document.getElementById('result-skipped-items');
    list.replaceChildren();
    if (!wrongs.length) {
        const li = document.createElement('li');
        li.className = 'p-4 text-center text-green-600 font-bold bg-green-50 rounded-xl';
        li.textContent = '👏 完美！沒有錯誤單字。';
        list.appendChild(li);
    } else {
        wrongs.forEach((w, idx) => {
            state.game.reviewSelection.push(w);
            list.appendChild(createReviewItem(w, idx));
        });
    }
    const saveReviewButton = document.getElementById('btn-save-review');
    if (saveReviewButton) saveReviewButton.disabled = wrongs.length === 0;
}

function createReviewItem(w, idx) {
    const li = document.createElement('li');
    li.className = 'bg-white p-3 rounded-xl border border-gray-100 shadow-sm';

    const rowWrap = document.createElement('div');
    rowWrap.className = 'flex items-center gap-3';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `review-chk-${idx}`;
    checkbox.className = 'w-6 h-6 text-indigo-600 rounded flex-none';
    checkbox.checked = true;
    checkbox.addEventListener('change', () => toggleReviewItem(idx));

    const wrap = document.createElement('div');
    wrap.className = 'flex flex-col flex-1 min-w-0';
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 flex-wrap';
    const en = document.createElement('span');
    en.className = 'text-indigo-600 font-black text-lg break-all';
    en.textContent = w.english;
    row.appendChild(en);

    if (w.isWrong) {
        const badge = document.createElement('span');
        badge.dataset.reviewFolderBadge = 'wrong';
        badge.className = 'text-xs bg-red-100 text-red-500 px-1 rounded flex-none';
        badge.textContent = '已在待複習';
        row.appendChild(badge);
    }

    const mean = document.createElement('span');
    mean.className = 'text-gray-500 text-sm truncate';
    mean.textContent = getMeaningWithPartOfSpeech(w);
    wrap.append(row, mean);

    rowWrap.append(checkbox, wrap);
    li.append(rowWrap);
    return li;
}

function toggleReviewItem(idx) {
    const wrongs = Array.from(state.game.wrongWords);
    const word = wrongs[idx];
    const checkbox = document.getElementById(`review-chk-${idx}`);
    if (!checkbox || !word) return;

    if (checkbox.checked) {
        if (!state.game.reviewSelection.includes(word)) state.game.reviewSelection.push(word);
    } else {
        state.game.reviewSelection = state.game.reviewSelection.filter(w => w !== word);
    }
}

async function saveReviewWords() {
    if (!requireLoginForChange()) return;
    if (!state.game.reviewSelection.length) {
        alert('請至少選擇一個單字。');
        return;
    }

    const selectedWordIds = new Set(state.game.reviewSelection.map(getWordKey));
    const alreadyApplied = new Set(state.words
        .filter(word => selectedWordIds.has(getWordKey(word)) && word.isWrong)
        .map(getWordKey));
    const ok = await commitUserMutation(draft => {
        draft.words.forEach(word => {
            if (!selectedWordIds.has(getWordKey(word))) return;
            word.isWrong = true;
        });
        draft.folders = normalizeFolders(draft.folders, draft.words, draft.settings);
    });
    if (!ok) return;
    const count = state.words.filter(word =>
        selectedWordIds.has(getWordKey(word)) &&
        word.isWrong &&
        !alreadyApplied.has(getWordKey(word))
    ).length;

    alert(count > 0
        ? `已將 ${count} 個單字加入待複習。`
        : '所選單字已在待複習中。');
    navigateTo('practice');
}

function openSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;

    const bgmEnabledEl = document.getElementById('settings-bgm-enabled');
    const bgmVolumeEl = document.getElementById('settings-bgm-volume');
    const bgmVolumeLabel = document.getElementById('settings-bgm-volume-value');
    const speechVolumeEl = document.getElementById('settings-speech-volume');
    const speechVolumeLabel = document.getElementById('settings-speech-volume-value');
    const bgmSelectEl = document.getElementById('settings-bgm-select');

    if (bgmSelectEl && !bgmSelectEl.options.length) {
        BGM_TRACKS.forEach(track => bgmSelectEl.appendChild(new Option(track.name, track.id)));
    }
    if (bgmEnabledEl) bgmEnabledEl.checked = !!state.settings.bgmEnabled;
    if (bgmVolumeEl) {
        const v = Math.round(clamp01(state.settings.bgmVolume) * 100);
        bgmVolumeEl.value = v;
        if (bgmVolumeLabel) bgmVolumeLabel.textContent = v + '%';
    }
    if (speechVolumeEl) {
        const v = Math.round(clamp01(state.settings.speechVolume) * 100);
        speechVolumeEl.value = v;
        if (speechVolumeLabel) speechVolumeLabel.textContent = v + '%';
    }
    if (bgmSelectEl) bgmSelectEl.value = state.settings.selectedBgmId;
    openModal(modal, '#settings-bgm-enabled');
}

async function closeSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (!modal || modal.dataset.busy === 'true') return;
    modal.dataset.busy = 'true';
    try {
        await saveSettingsFromUI();
    } finally {
        modal.dataset.busy = 'false';
        closeModal(modal);
    }
}

async function saveSettingsFromUI() {
    const bgmEnabledEl = document.getElementById('settings-bgm-enabled');
    const bgmVolumeEl = document.getElementById('settings-bgm-volume');
    const speechVolumeEl = document.getElementById('settings-speech-volume');
    const bgmSelectEl = document.getElementById('settings-bgm-select');

    const nextSettings = cloneSettings(state.settings);
    if (bgmEnabledEl) nextSettings.bgmEnabled = !!bgmEnabledEl.checked;
    if (bgmVolumeEl) nextSettings.bgmVolume = clamp01((parseInt(bgmVolumeEl.value, 10) || 0) / 100);
    if (speechVolumeEl) nextSettings.speechVolume = clamp01((parseInt(speechVolumeEl.value, 10) || 0) / 100);
    if (bgmSelectEl && bgmSelectEl.value) nextSettings.selectedBgmId = bgmSelectEl.value;

    const ok = await commitUserMutation(draft => {
        draft.settings = cloneSettings(nextSettings);
        draft.folders = normalizeFolders(draft.folders, draft.words, draft.settings);
    }, {
        requireAuth: false,
        afterRollback: applyBgmSettingsToElement
    });
    if (ok) applyBgmSettingsToElement();
}

function updateBgmVolumeFromSlider(value) {
    const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
    const label = document.getElementById('settings-bgm-volume-value');
    if (label) label.textContent = v + '%';
    state.settings.bgmVolume = clamp01(v / 100);

    const audio = state.audio && state.audio.bgmElement;
    if (audio) {
        audio.volume = bgmDucking.isDucking
            ? clamp01(state.settings.bgmVolume * bgmDucking.ratio)
            : clamp01(state.settings.bgmVolume);
    }
}

function updateSpeechVolumeFromSlider(value) {
    const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
    const label = document.getElementById('settings-speech-volume-value');
    if (label) label.textContent = v + '%';
    state.settings.speechVolume = clamp01(v / 100);
}

async function toggleBgmEnabledFromCheckbox(checked) {
    const nextSettings = cloneSettings(state.settings);
    nextSettings.bgmEnabled = !!checked;
    const ok = await commitUserMutation(draft => {
        draft.settings = cloneSettings(nextSettings);
    }, {
        requireAuth: false,
        afterRollback: applyBgmSettingsToElement
    });
    applyBgmSettingsToElement();
    if (!ok) openSettingsModal();
}

async function changeBgmTrackFromSelect(trackId) {
    const nextSettings = cloneSettings(state.settings);
    nextSettings.selectedBgmId = trackId;
    const ok = await commitUserMutation(draft => {
        draft.settings = cloneSettings(nextSettings);
    }, {
        requireAuth: false,
        afterRollback: applyBgmSettingsToElement
    });
    if (!ok) {
        openSettingsModal();
        return;
    }
    const audio = state.audio && state.audio.bgmElement;
    const track = getCurrentBgmTrack();
    if (audio && track) {
        const wasPlaying = !audio.paused;
        audio.src = track.url;
        if (state.settings.bgmEnabled && wasPlaying) audio.play().catch(() => {});
    }
}

async function confirmReset() {
    if (!requireLoginForChange()) return;
    if (!confirm('確定要重置全部雲端個人資料？這會清除新增單字、待複習狀態、資料夾與設定。')) return;
    const ok = await commitUserMutation(draft => {
        const resetSettings = cloneSettings(DEFAULT_SETTINGS);
        draft.settings = resetSettings;
        draft.words = getDefaultWords();
        draft.folders = normalizeFolders([], draft.words, resetSettings);
    });
    if (!ok) return;
    clearPracticeSession();
    applyBgmSettingsToElement();
    showView(new URL(window.location).searchParams.get('page') || 'home');
}

function updateAuthUI(user) {
    const loginBtn = document.getElementById('btn-login');
    const logoutBtn = document.getElementById('btn-logout');
    const syncBtn = document.getElementById('btn-sync');
    const userSpan = document.getElementById('user-email');
    const homeSyncStatus = document.getElementById('home-sync-status');
    if (homeSyncStatus) {
        homeSyncStatus.textContent = user
            ? (pendingRemoteRevision > cloudRevision
                ? '雲端有其他分頁或裝置的新資料，請重新載入。'
                : '你的自訂單字、資料夾與待複習狀態會自動同步至雲端。')
            : '登入後即可新增單字，並同步你的資料夾與待複習狀態。';
    }
    if (!loginBtn || !logoutBtn || !syncBtn || !userSpan) return;

    if (user) {
        setElementVisible(loginBtn, false);
        setElementVisible(logoutBtn, true);
        setElementVisible(syncBtn, true);
        setElementVisible(userSpan, true);
        userSpan.textContent = user.email || user.displayName || '已登入';
        logoutBtn.disabled = isLoggingOut || isSyncing || isCloudLoading || activeCloudWrites > 0;
        logoutBtn.textContent = isLoggingOut ? '登出中...' : '登出';
        syncBtn.disabled = isSyncing || isLoggingOut || isCloudLoading || activeCloudWrites > 0;
        syncBtn.textContent = isSyncing
            ? '☁ 重新載入中...'
            : (isCloudLoading
                ? '☁ 載入中...'
                : (pendingRemoteRevision > cloudRevision ? '☁ 有新資料' : '☁ 重新載入'));
    } else {
        setElementVisible(loginBtn, true);
        setElementVisible(logoutBtn, false);
        setElementVisible(syncBtn, false);
        setElementVisible(userSpan, false);
        userSpan.textContent = '';
        loginBtn.disabled = isLoggingIn || isLoggingOut;
        loginBtn.textContent = isLoggingIn ? '登入中...' : '登入';
    }
}

async function firebaseLogin() {
    if (currentUser || auth.currentUser || isLoggingIn || isLoggingOut) return;
    isLoggingIn = true;
    updateAuthUI(null);
    let popupCompleted = false;
    try {
        await signInWithPopup(auth, provider);
        popupCompleted = true;
    } catch (err) {
        console.error(err);
        alert('登入失敗：' + (err.message || err));
    } finally {
        if (!popupCompleted) isLoggingIn = false;
        updateAuthUI(currentUser);
    }
}

async function firebaseLogout() {
    if (!currentUser || isLoggingOut || isLoggingIn || isSyncing || isCloudLoading || activeCloudWrites > 0) return;
    isLoggingOut = true;
    updateAuthUI(currentUser);
    let logoutCompleted = false;
    try {
        await signOut(auth);
        logoutCompleted = true;
    } catch (err) {
        console.error(err);
        alert('登出失敗：' + (err.message || err));
    } finally {
        if (!logoutCompleted) isLoggingOut = false;
        updateAuthUI(currentUser);
    }
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
    let timeoutId;
    const timeout = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function syncCloudNow() {
    if (isSyncing || isLoggingOut || isLoggingIn || activeCloudWrites > 0) return;
    if (!requireLoginForChange()) return;
    if (isCloudLoading) {
        alert('雲端資料仍在載入，請稍候再同步。');
        return;
    }
    isSyncing = true;
    updateAuthUI(currentUser);
    try {
        const loaded = await withTimeout(
            loadFromCloud(currentUser),
            SYNC_TIMEOUT_MS,
            '重新載入逾時，請確認網路後再試。'
        );
        if (loaded) {
            applyBgmSettingsToElement();
            rerenderVisibleView();
            alert('已重新載入雲端最新資料。');
        }
    } catch (err) {
        console.error('重新載入雲端資料失敗', err);
        alert(err.message || '重新載入失敗，請稍後再試。');
    } finally {
        isSyncing = false;
        updateAuthUI(currentUser);
    }
}

function rerenderVisibleView() {
    const visible = Array.from(document.querySelectorAll('main > div')).find(div => !div.classList.contains('hidden'));
    if (!visible) return;
    if (visible.id === 'view-library') renderLibrary();
    if (visible.id === 'view-word-list') {
        const listTitle = document.getElementById('list-title');
        renderWordList(listTitle.dataset.folderId || listTitle.innerText);
    }
    if (visible.id === 'view-practice') {
        renderPracticeOptions();
        renderPracticeWordSelection();
    }
}

function bindStaticEvents() {
    document.getElementById('btn-home-brand')?.addEventListener('click', () => navigateTo('home'));
    document.getElementById('btn-settings')?.addEventListener('click', openSettingsModal);
    document.getElementById('search-input')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') searchWord();
    });
    document.getElementById('btn-search')?.addEventListener('click', searchWord);

    document.getElementById('btn-login')?.addEventListener('click', firebaseLogin);
    document.getElementById('btn-logout')?.addEventListener('click', firebaseLogout);
    document.getElementById('btn-sync')?.addEventListener('click', syncCloudNow);

    const navButtons = document.querySelectorAll('nav .grid button');
    navButtons[0]?.addEventListener('click', () => navigateTo('home'));
    navButtons[1]?.addEventListener('click', () => navigateTo('library'));
    navButtons[2]?.addEventListener('click', () => navigateTo('practice'));

    document.getElementById('btn-reset-all')?.addEventListener('click', confirmReset);

    document.getElementById('btn-home-library')?.addEventListener('click', () => navigateTo('library'));
    document.getElementById('btn-home-practice')?.addEventListener('click', () => navigateTo('practice'));

    document.getElementById('btn-library-back')?.addEventListener('click', () => navigateTo('home'));
    document.getElementById('btn-word-list-back')?.addEventListener('click', () => navigateTo('library'));

    document.getElementById('btn-edit-folders')?.addEventListener('click', toggleEditMode);
    document.getElementById('btn-add-word')?.addEventListener('click', () => openAddModal());
    document.getElementById('btn-empty-add-word')?.addEventListener('click', () => openAddModal());

    const editHintButtons = document.querySelectorAll('#edit-hint button');
    editHintButtons[0]?.addEventListener('click', openNewFolderModal);
    editHintButtons[1]?.addEventListener('click', toggleEditMode);

    document.getElementById('practice-scope')?.addEventListener('change', renderPracticeWordSelection);
    const selectionButtons = document.querySelectorAll('#view-practice .space-x-2 button');
    selectionButtons[0]?.addEventListener('click', () => toggleAllPracticeWords(true));
    selectionButtons[1]?.addEventListener('click', () => toggleAllPracticeWords(false));

    document.querySelectorAll('#view-practice [data-start-mode]').forEach(button => {
        button.addEventListener('click', () => startGame(button.dataset.startMode));
    });

    document.querySelectorAll('#view-game-spelling button, #view-game-choice button').forEach(btn => {
        if (btn.textContent.includes('離開並結算')) btn.addEventListener('click', quitGameAndSave);
    });
    document.querySelectorAll('[data-game-nav]').forEach(btn => {
        btn.addEventListener('click', () => navigateHistory(btn.dataset.gameNav));
    });
    document.getElementById('spelling-input')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') checkSpellingAnswer();
    });
    const spellingButtons = document.querySelectorAll('#view-game-spelling .space-y-4 button');
    spellingButtons[0]?.addEventListener('click', checkSpellingAnswer);
    spellingButtons[1]?.addEventListener('click', skipSpellingWord);

    document.getElementById('btn-save-review')?.addEventListener('click', saveReviewWords);
    document.getElementById('btn-result-return')?.addEventListener('click', () => navigateTo('practice'));

    const addButtons = document.querySelectorAll('#add-modal .grid button');
    addButtons[0]?.addEventListener('click', closeAddModal);
    addButtons[1]?.addEventListener('click', saveNewWord);

    const actionButtons = document.querySelectorAll('#folder-action-modal button');
    actionButtons[0]?.addEventListener('click', prepareRenameFolder);
    actionButtons[1]?.addEventListener('click', () => prepareDeleteFolder(false));
    actionButtons[2]?.addEventListener('click', () => prepareDeleteFolder(true));
    actionButtons[3]?.addEventListener('click', closeActionModal);

    const renameButtons = document.querySelectorAll('#rename-modal .grid button');
    renameButtons[0]?.addEventListener('click', closeRenameModal);
    renameButtons[1]?.addEventListener('click', executeRename);

    const confirmButtons = document.querySelectorAll('#confirm-modal .grid button');
    confirmButtons[0]?.addEventListener('click', closeConfirmModal);
    confirmButtons[1]?.addEventListener('click', executeDelete);

    const newFolderButtons = document.querySelectorAll('#new-folder-modal .grid button');
    newFolderButtons[0]?.addEventListener('click', closeNewFolderModal);
    newFolderButtons[1]?.addEventListener('click', confirmNewFolder);

    document.getElementById('settings-bgm-enabled')?.addEventListener('change', event => toggleBgmEnabledFromCheckbox(event.currentTarget.checked));
    document.getElementById('settings-bgm-select')?.addEventListener('change', event => changeBgmTrackFromSelect(event.currentTarget.value));
    document.getElementById('settings-bgm-volume')?.addEventListener('input', event => updateBgmVolumeFromSlider(event.currentTarget.value));
    document.getElementById('settings-speech-volume')?.addEventListener('input', event => updateSpeechVolumeFromSlider(event.currentTarget.value));
    document.querySelector('#settings-modal button')?.addEventListener('click', closeSettingsModal);
}

async function bootstrap() {
    try {
        updateAppLoading('正在載入單字資料，請稍等。');
        await loadDefaultWordDatabase();
        resetToDefaultState();
        initializeModalAccessibility();
        bindStaticEvents();
        setupAudioSystem();
        setupBgmAutoplayUnlock();

        const page = new URL(window.location).searchParams.get('page') || 'home';
        showView(page);
        history.replaceState({ viewId: page }, '', window.location);
        updateAppLoading('正在確認登入與同步資料，請稍等。');

        onAuthStateChanged(auth, async user => {
            const generation = ++cloudLoadGeneration;
            stopUserRevisionListener();
            authReady = true;
            currentUser = user;
            cloudRevision = 0;
            pendingRemoteRevision = 0;
            if (user) isLoggingIn = false;
            else isLoggingOut = false;
            updateAuthUI(user);
            if (user) {
                try {
                    const loaded = await loadFromCloud(user, generation);
                    if (generation !== cloudLoadGeneration) return;
                    if (loaded) startUserRevisionListener(user);
                    applyBgmSettingsToElement();
                } catch (err) {
                    if (generation !== cloudLoadGeneration) return;
                    console.error('載入雲端資料失敗', err);
                    alert('載入雲端資料失敗：' + (err.message || err));
                }
            } else {
                isCloudLoading = false;
                resetToDefaultState();
            }
            if (generation !== cloudLoadGeneration) return;
            updateAuthUI(currentUser);
            rerenderVisibleView();
            finishAppLoading();
        });
    } catch (err) {
        console.error(err);
        failAppLoading('單字資料載入失敗，請重新整理或稍後再試。');
    }
}

document.addEventListener('DOMContentLoaded', bootstrap);
