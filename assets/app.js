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
    deleteField
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

const WORD_DATABASE_URL = './data/words.json';
const wordData = globalThis.WordKingData;
const WRONG_FOLDER = '錯題區';
const REVIEW_FOLDER_LABEL = '待複習';
const UNFILED_FOLDER = '未分類';
const SYNC_TIMEOUT_MS = 15000;
const USER_LOAD_TIMEOUT_MS = 120000;
const SEARCH_SUGGESTION_VISIBLE_COUNT = 5;
const SEARCH_SUGGESTION_ROW_HEIGHT = 64;
const MAX_SEARCH_SUGGESTIONS = 200;

const PART_OF_SPEECH_OPTIONS = {
    noun: { label: '名詞', short: '(n.)' },
    verb: { label: '動詞', short: '(v.)' },
    adjective: { label: '形容詞', short: '(a.)' },
    adverb: { label: '副詞', short: '(adv.)' },
    pronoun: { label: '代名詞', short: '(pron.)' },
    preposition: { label: '介系詞', short: '(prep.)' },
    conjunction: { label: '連接詞', short: '(conj.)' },
    interjection: { label: '感嘆詞', short: '(interj.)' },
    other: { label: '其他', short: '(其他)' },
    determiner: { label: '限定詞', short: '(det.)' },
    article: { label: '冠詞', short: '(art.)' },
    numeral: { label: '數詞', short: '(num.)' },
    auxiliary: { label: '助動詞', short: '(aux.)' },
    phrase: { label: '片語', short: '(phr.)' }
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
    hiddenLessonIds: []
};

const bgmDucking = {
    isDucking: false,
    ratio: 0.3
};

let publicCatalog = [];
let userWordState = null;
let persistence = null;
let catalogLoadGeneration = 0;
let currentUser = null;
let authReady = false;
let authSessionGeneration = 0;
let isUserDataReady = false;
let publicDataPromise = null;
let publicDataReady = false;
let hasDisplayedSession = false;
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
let searchSuggestions = [];
let activeSearchSuggestionIndex = -1;
let isSearchComposing = false;
let searchSuggestionRenderId = 0;
let gameGeneration = 0;

const modalReturnFocus = new WeakMap();

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
const state = {
    words: [],
    hiddenWords: [],
    recovery: null,
    categories: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(''),
    folderIds: [WRONG_FOLDER],
    folders: [WRONG_FOLDER],
    lessonFolderIds: [],
    folderNames: {},
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

function createCustomWordId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return `c_${window.crypto.randomUUID()}`;
    }
    return `c_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// DerivedView group keys distinguish a lesson from a private folder with the same name.
function groupKey(kind, id) { return `${kind}:${id}`; }
function groupInfo(key) {
    const separator = String(key).indexOf(':');
    return separator < 0 ? { kind: 'system', id: key }
        : { kind: key.slice(0, separator), id: key.slice(separator + 1) };
}
function normalizePartOfSpeech(value) { return wordData.normalizePartOfSpeech(value); }
function getPartOfSpeechShort(value) {
    return normalizePartOfSpeech(value).map(pos => PART_OF_SPEECH_OPTIONS[pos]?.short || '').filter(Boolean).join(' / ');
}
function normalizeFolderId(value) {
    const id = typeof value === 'string' ? value.trim() : '';
    return !id || [WRONG_FOLDER, UNFILED_FOLDER].includes(id) || /^[A-Z]$/i.test(id) ? '' : id;
}
function normalizeFolderIds(values = []) {
    return Array.from(new Set((Array.isArray(values) ? values : [values]).map(normalizeFolderId).filter(Boolean)));
}
function getWordGroupIds(word = {}) {
    return [...(word.lessonIds || []).map(id => groupKey('lesson', id)),
        ...(word.folderIds || []).map(id => groupKey('folder', id))];
}
function cloneWord(word) { return JSON.parse(JSON.stringify(word)); }
function cloneWords(words = []) { return words.map(cloneWord); }
function setWordGroups(model, id, keys) {
    const groups = keys.map(groupInfo);
    model.setWordLessons(id, groups.filter(item => item.kind === 'lesson').map(item => item.id));
    model.setWordFolders(id, groups.filter(item => item.kind === 'folder').map(item => item.id));
}
function updatePersonalWord(model, id, patch) {
    if (model.getPublicWord(id)) model.updateWordOverride(id, patch);
    else model.updateCustomWord(id, patch);
}
function createPersonalFolder(model, name) {
    const id = `f_${window.crypto.randomUUID()}`;
    model.setFolder(id, { name });
    return groupKey('folder', id);
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
        hiddenLessonIds: Array.isArray(hydrated.hiddenLessonIds) ? [...hydrated.hiddenLessonIds] : []
    };
}

function snapshotUserState() { return userWordState ? userWordState.exportState() : { userOverrides: {}, customWords: {}, hiddenWordIds: [], userFolders: {}, settings: {} }; }

function refreshDerivedView() {
    if (!userWordState) return;
    const snapshot = userWordState.exportState();
    state.words = userWordState.deriveEffectiveWords();
    state.hiddenWords = snapshot.hiddenWordIds.map(id => userWordState.getEffectiveWord(id, { includeHidden: true })).filter(Boolean);
    state.settings = cloneSettings(snapshot.settings);
    state.lessonFolderIds = normalizeFolderIds([...publicCatalog, ...state.words, ...state.hiddenWords]
        .flatMap(word => (word.lessonIds || []).map(id => groupKey('lesson', id))));
    state.folderNames = Object.fromEntries(Object.entries(snapshot.userFolders).map(([id, folder]) => [id, folder.name]));
    const personal = Object.keys(snapshot.userFolders).map(id => groupKey('folder', id));
    state.folders = normalizeFolders(personal, state.words, state.settings);
}

function restoreUserState(snapshot) {
    userWordState = wordData.createUserWordState(publicCatalog, snapshot);
    refreshDerivedView();
}

function applyUserData(data) {
    restoreUserState(data.snapshot);
    state.recovery = data.recovery || null;
    clearPracticeSession();
    refreshFolders();
    refreshSearchSuggestionsForCurrentData();
}

function hydrateSettings(saved) {
    const base = {
        ...DEFAULT_SETTINGS,
        lessonFolderNames: {},
        hiddenLessonIds: []
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
        if (Array.isArray(saved.hiddenLessonIds)) {
            base.hiddenLessonIds = Array.from(new Set(saved.hiddenLessonIds.filter(id => typeof id === 'string' && id.trim())));
        }
    }
    return base;
}

function isLessonFolder(folderId) {
    return state.lessonFolderIds.includes(folderId);
}

function getActiveLessonFolderIds(settings = state.settings) {
    const deleted = new Set((settings && settings.hiddenLessonIds) || []);
    return state.lessonFolderIds.filter(folderId => !deleted.has(groupInfo(folderId).id));
}

function getFolderDisplayName(folderId, settings = state.settings) {
    if (folderId === WRONG_FOLDER) return REVIEW_FOLDER_LABEL;
    if (folderId === UNFILED_FOLDER) return UNFILED_FOLDER;
    const group = groupInfo(folderId);
    if (group.kind === 'lesson') return settings?.lessonFolderNames?.[group.id] || group.id;
    if (group.kind === 'folder') return state.folderNames[group.id] || group.id;
    return folderId;
}

function getWordSourceFolderIds(word = {}, settings = state.settings) {
    const hiddenLessonIds = new Set((settings && settings.hiddenLessonIds) || []);
    const storedFolderIds = getWordGroupIds(word)
        .filter(folderId => groupInfo(folderId).kind !== 'lesson' || !hiddenLessonIds.has(groupInfo(folderId).id));
    return normalizeFolderIds(storedFolderIds);
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

function getCurrentBgmTrack(trackId = state.settings.selectedBgmId) {
    return BGM_TRACKS.find(t => t.id === trackId) || BGM_TRACKS[0] || null;
}

async function loadDefaultWordDatabase() {
    const generation = ++catalogLoadGeneration;
    const response = await fetch(WORD_DATABASE_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error('無法載入公用單字庫，請重試。');
    const catalog = wordData.normalizeCatalog(await response.json());
    if (!catalog.length) throw new Error('公用單字庫是空的，請稍後重試。');
    if (generation !== catalogLoadGeneration) throw new Error('公用單字載入已由新的請求取代。');
    publicCatalog = catalog;
    state.lessonFolderIds = normalizeFolderIds(catalog.flatMap(word => word.lessonIds.map(id => groupKey('lesson', id))));
}

function clearPracticeSession() {
    gameGeneration += 1;
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
    restoreUserState({ settings: cloneSettings(DEFAULT_SETTINGS) });
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

    const sa = splitFolderNameForSeries(getFolderDisplayName(a));
    const sb = splitFolderNameForSeries(getFolderDisplayName(b));
    if (sa.prefix !== sb.prefix) return sa.prefix.localeCompare(sb.prefix, 'zh-Hant');

    const len = Math.max(sa.numbers.length, sb.numbers.length);
    for (let i = 0; i < len; i++) {
        const na = sa.numbers[i] ?? 0;
        const nb = sb.numbers[i] ?? 0;
        if (na !== nb) return na - nb;
    }
    return getFolderDisplayName(a).localeCompare(getFolderDisplayName(b), 'zh-Hant');
}

function refreshFolders() {
    const deleted = new Set((state.settings && state.settings.hiddenLessonIds) || []);
    const folderSet = new Set((state.folders || []).filter(folderId =>
        folderId && folderId !== UNFILED_FOLDER && !(groupInfo(folderId).kind === 'lesson' && deleted.has(groupInfo(folderId).id))
    ));
    let hasUnfiledWords = false;
    state.words.forEach(w => {
        const sourceFolderIds = getWordSourceFolderIds(w, state.settings);
        sourceFolderIds.forEach(folderId => folderSet.add(folderId));
        if (!sourceFolderIds.length) hasUnfiledWords = true;
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

function normalizeFolders(folders, words, settings = state.settings) {
    const folderIds = new Set([WRONG_FOLDER, ...getActiveLessonFolderIds(settings)]);
    (folders || []).forEach(f => {
        const normalizedFolderId = normalizeFolderId(f);
        if (normalizedFolderId) folderIds.add(normalizedFolderId);
    });
    let hasUnfiledWords = false;
    (words || []).forEach(w => {
        const sourceFolderIds = getWordSourceFolderIds(w, settings);
        sourceFolderIds.forEach(folderId => folderIds.add(folderId));
        if (!sourceFolderIds.length) hasUnfiledWords = true;
    });
    const deleted = new Set((settings && settings.hiddenLessonIds) || []);
    deleted.forEach(id => folderIds.delete(groupKey('lesson', id)));
    if (hasUnfiledWords) folderIds.add(UNFILED_FOLDER);
    folderIds.add(WRONG_FOLDER);
    return Array.from(folderIds);
}

function getPersistence() {
    if (!persistence) persistence = globalThis.WordKingPersistence.createPersistence({
        db, doc, collection, getDoc, getDocs, onSnapshot, runTransaction, deleteField,
        fetch: (...args) => fetch(...args), getCatalog: () => publicCatalog
    });
    return persistence;
}

function acknowledgeCloudRevision(revision) {
    cloudRevision = revision;
    if (pendingRemoteRevision <= cloudRevision) pendingRemoteRevision = 0;
    updateAuthUI(currentUser);
}

async function saveDiffChangesToCloud(previous, next, user = currentUser, options = {}) {
    const generation = authSessionGeneration;
    assertCurrentUserSession(user, generation);
    activeCloudWrites += 1;
    updateAuthUI(currentUser);
    try {
        const result = await getPersistence().save(previous, next, user, {
            expectedRevision: options.expectedRevision ?? cloudRevision,
            assertCurrent: () => assertCurrentUserSession(user, generation)
        });
        if (isCurrentUserSession(user, generation)) acknowledgeCloudRevision(result.revision);
        return result;
    } finally {
        if (isCurrentUserSession(user, generation)) {
            activeCloudWrites = Math.max(0, activeCloudWrites - 1);
            updateAuthUI(currentUser);
        }
    }
}

async function loadUserDiffData(user, context = {}) {
    const assertCurrent = () => {
        if (context.sessionGeneration !== undefined) assertCurrentUserSession(user, context.sessionGeneration);
        if (context.loadGeneration !== undefined && context.loadGeneration !== cloudLoadGeneration) {
            const error = new Error('這次載入已由新的同步取代。');
            error.code = 'stale-user-session';
            throw error;
        }
    };
    assertCurrent();
    return getPersistence().load(user, { assertCurrent });
}

function requireLoginForChange() {
    if (currentUser && authReady && isUserDataReady && !isCloudLoading) return true;
    if (currentUser) {
        alert('個人資料尚未載入完成，請等待或使用畫面上的「重試載入」。');
        return false;
    }
    alert('請先登入 Google 帳號，才能新增、編輯、管理資料夾、儲存待複習狀態或同步個人資料。');
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
    if (!authReady || !isUserDataReady || isCloudLoading || activeCloudWrites > 0) {
        alert('資料尚未載入或儲存完成，請稍候再試；載入失敗時請使用「重試載入」。');
        return false;
    }
    if (!currentUser) {
        if (requireAuth) {
            requireLoginForChange();
            return false;
        }
        mutator(userWordState);
        refreshDerivedView();
        refreshFolders();
        refreshSearchSuggestionsForCurrentData();
        return true;
    }

    const previous = snapshotUserState();
    const mutationUser = currentUser;
    const sessionGeneration = authSessionGeneration;
    try {
        mutator(userWordState);
        refreshDerivedView();
        refreshFolders();
        await saveDiffChangesToCloud(previous, snapshotUserState(), mutationUser, {
            expectedRevision: cloudRevision
        });
        if (!isCurrentUserSession(mutationUser, sessionGeneration)) return false;
        refreshSearchSuggestionsForCurrentData();
        return true;
    } catch (err) {
        if (!isCurrentUserSession(mutationUser, sessionGeneration)) return false;
        let reloaded = false;
        if (isCloudConsistencyError(err) && currentUser && currentUser.uid === mutationUser.uid) {
            try {
                reloaded = await loadFromCloud(mutationUser);
            } catch (reloadError) {
                console.error('重新載入雲端狀態失敗', reloadError);
            }
        }
        if (!isCurrentUserSession(mutationUser, sessionGeneration)) return false;
        if (!reloaded && isUserDataReady) restoreUserState(previous);
        refreshFolders();
        refreshSearchSuggestionsForCurrentData();
        console.error('使用者資料儲存失敗', err);
        if (isCloudConsistencyError(err)) {
            alert(getCloudRecoveryMessage(err, reloaded));
        } else {
            alert('資料儲存失敗，已還原剛剛的變更：' + (err.message || err));
        }
        if (typeof afterRollback === 'function') afterRollback();
        rerenderVisibleView();
        if (isUserDataReady) finishAppLoading();
        return false;
    }
}

async function loadFromCloud(user, generation = ++cloudLoadGeneration) {
    const sessionGeneration = authSessionGeneration;
    if (!isCurrentUserSession(user, sessionGeneration)) return false;
    isCloudLoading = true;
    isUserDataReady = false;
    beginAppLoading('正在載入個人修改與設定，請稍等。');
    updateAuthUI(currentUser);
    try {
        const data = await withTimeout(
            loadUserDiffData(user, { sessionGeneration, loadGeneration: generation }),
            USER_LOAD_TIMEOUT_MS,
            '個人資料載入逾時，請確認網路後重試。'
        );
        if (generation !== cloudLoadGeneration || !isCurrentUserSession(user, sessionGeneration)) return false;
        acknowledgeCloudRevision(data.revision);
        applyUserData(data);
        isUserDataReady = true;
        return true;
    } catch (error) {
        if (generation !== cloudLoadGeneration || !isCurrentUserSession(user, sessionGeneration)) return false;
        // Invalidate the request even when its network work completes after a timeout.
        cloudLoadGeneration += 1;
        isCloudLoading = false;
        clearPersonalSessionData();
        failAppLoading('個人資料未能載入，尚未完成同步。' + (error.message || '請確認網路後重試。'));
        updateAuthUI(currentUser);
        throw error;
    } finally {
        if (isCurrentUserSession(user, sessionGeneration) && generation === cloudLoadGeneration) {
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
    const generation = authSessionGeneration;
    unsubscribeUserRevision = getPersistence().subscribe(user, observedRevision => {
        if (!isCurrentUserSession(user, generation)) return;
        if (observedRevision > cloudRevision) {
            pendingRemoteRevision = Math.max(pendingRemoteRevision, observedRevision);
            updateAuthUI(currentUser);
        }
    }, error => console.error('監聽雲端資料版本失敗', error));
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

function applyBgmSettingsToElement(settings = state.settings) {
    const audio = state.audio && state.audio.bgmElement;
    if (!audio) return;
    if (!isUserDataReady) {
        audio.pause();
        return;
    }
    const track = getCurrentBgmTrack(settings.selectedBgmId);
    if (track && audio.getAttribute('src') !== track.url) audio.src = track.url;
    audio.volume = clamp01(settings.bgmVolume);
    if (settings.bgmEnabled) {
        audio.play().catch(() => {});
    } else {
        audio.pause();
    }
}

function setupBgmAutoplayUnlock() {
    const audio = state.audio && state.audio.bgmElement;
    if (!audio) return;
    const tryPlay = () => {
        if (!isUserDataReady || !state.settings || !state.settings.bgmEnabled) return;
        audio.play().catch(() => {});
        window.removeEventListener('click', tryPlay);
        window.removeEventListener('touchstart', tryPlay);
        window.removeEventListener('keydown', tryPlay);
    };
    window.addEventListener('click', tryPlay);
    window.addEventListener('touchstart', tryPlay);
    window.addEventListener('keydown', tryPlay);
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
    return word.id;
}

function wordIsInFolder(word, folderId) {
    if (folderId === WRONG_FOLDER) return !!word.isWrong;
    const sourceFolderIds = getWordSourceFolderIds(word);
    if (folderId === UNFILED_FOLDER) return sourceFolderIds.length === 0;
    return sourceFolderIds.includes(folderId);
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

function isCurrentUserSession(user, generation) {
    return generation === authSessionGeneration && (currentUser?.uid || null) === (user?.uid || null);
}

function assertCurrentUserSession(user, generation) {
    if (isCurrentUserSession(user, generation)) return;
    const error = new Error('登入帳號已變更，已取消舊帳號的操作。');
    error.code = 'stale-user-session';
    throw error;
}

function clearPersonalSessionData() {
    isUserDataReady = false;
    userWordState = null;
    state.recovery = null;
    state.words = [];
    state.hiddenWords = [];
    state.folders = [];
    state.folderNames = {};
    state.settings = cloneSettings(DEFAULT_SETTINGS);
    state.folderIds = [];
    clearPracticeSession();
    state.isEditing = false;
    state.editingWordIndex = -1;
    state.targetFolderAction = '';
    state.pendingDeleteType = null;
    closeSearchSuggestions({ clearResults: true });
    if (state.audio.bgmElement) state.audio.bgmElement.pause();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    document.querySelectorAll('[role="dialog"]').forEach(modal => {
        delete modal.dataset.busy;
        setElementVisible(modal, false);
        modal.querySelectorAll('input, textarea').forEach(input => {
            if (input.type === 'checkbox' || input.type === 'radio') input.checked = false;
            else input.value = '';
        });
    });
    ['search-input', 'spelling-input', 'result-new-folder-name'].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.value = '';
    });
    ['category-grid', 'words-container', 'practice-scope', 'practice-word-selection', 'spelling-definition-area',
        'spelling-hint', 'spelling-feedback', 'spelling-review-answer', 'choice-feedback',
        'choice-options', 'choice-question', 'result-skipped-items', 'result-folder-select',
        'action-folder-name', 'confirm-desc', 'folder-selection-container'].forEach(id => {
        document.getElementById(id)?.replaceChildren();
    });
    const listTitle = document.getElementById('list-title');
    if (listTitle) {
        listTitle.textContent = '單字';
        delete listTitle.dataset.folderId;
    }
    document.querySelectorAll('main > div').forEach(view => setElementVisible(view, false));
}

function setAppContentBlocked(blocked) {
    document.querySelectorAll('body > nav, body > main, body > [role="dialog"]').forEach(element => {
        element.toggleAttribute('inert', blocked || element.hidden);
        if ('inert' in element) element.inert = blocked || element.hidden;
    });
}

function beginAppLoading(message) {
    const loading = document.getElementById('app-loading');
    const title = document.getElementById('app-loading-title');
    document.body.setAttribute('aria-busy', 'true');
    setAppContentBlocked(true);
    if (loading) {
        loading.hidden = false;
        loading.classList.remove('is-ready', 'is-error');
        loading.setAttribute('role', 'status');
        loading.setAttribute('aria-hidden', 'false');
    }
    if (title) title.textContent = '單字王載入中';
    const retry = document.getElementById('app-loading-retry');
    if (retry) retry.hidden = true;
    updateAppLoading(message);
}

function updateAppLoading(message) {
    const loadingMessage = document.getElementById('app-loading-message');
    if (loadingMessage) loadingMessage.textContent = message;
}

function finishAppLoading() {
    const loading = document.getElementById('app-loading');
    document.body.setAttribute('aria-busy', 'false');
    setAppContentBlocked(false);
    if (!loading) return;
    loading.classList.add('is-ready');
    loading.setAttribute('aria-hidden', 'true');
    // Keep the overlay available for account changes and retryable sync failures.
    loading.hidden = true;
}

function failAppLoading(message) {
    const loading = document.getElementById('app-loading');
    const title = document.getElementById('app-loading-title');
    document.body.setAttribute('aria-busy', 'false');
    setAppContentBlocked(true);
    if (!loading) {
        const fallback = document.createElement('main');
        fallback.className = 'p-6 text-center text-red-600 font-bold';
        fallback.textContent = message;
        document.body.replaceChildren(fallback);
        return;
    }
    loading.classList.add('is-error');
    loading.classList.remove('is-ready');
    loading.hidden = false;
    loading.setAttribute('aria-hidden', 'false');
    loading.setAttribute('role', 'alert');
    if (title) title.textContent = '載入失敗';
    updateAppLoading(message);
    const retry = document.getElementById('app-loading-retry');
    if (retry) retry.hidden = false;
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

function normalizeSearchQuery(query) {
    return String(query ?? '').trim().normalize('NFKC');
}

function normalizeEnglishSearchText(text) {
    return String(text ?? '').normalize('NFKC').toLocaleLowerCase('en');
}

function isChineseSearchQuery(query) {
    return /\p{Script=Han}/u.test(String(query ?? ''));
}

function findOrderedMatchIndexes(text, query) {
    const textChars = Array.from(String(text ?? '').normalize('NFKC'));
    const queryChars = Array.from(String(query ?? '').normalize('NFKC'));
    if (!queryChars.length) return null;

    const indexes = [];
    let searchFrom = 0;
    for (const queryChar of queryChars) {
        let matchedIndex = -1;
        for (let index = searchFrom; index < textChars.length; index += 1) {
            if (textChars[index] === queryChar) {
                matchedIndex = index;
                break;
            }
        }
        if (matchedIndex === -1) return null;
        indexes.push(matchedIndex);
        searchFrom = matchedIndex + 1;
    }
    return indexes;
}

function getChineseMatchScore(text, query, indexes) {
    const normalizedText = String(text ?? '').normalize('NFKC');
    const normalizedQuery = String(query ?? '').normalize('NFKC');
    const totalGap = indexes.reduce((sum, index, position) => {
        if (position === 0) return sum;
        return sum + index - indexes[position - 1] - 1;
    }, 0);
    return {
        exact: normalizedText === normalizedQuery ? 0 : 1,
        contiguous: normalizedText.includes(normalizedQuery) ? 0 : 1,
        startIndex: indexes[0] ?? Number.MAX_SAFE_INTEGER,
        totalGap,
        length: Array.from(normalizedText).length
    };
}

function compareSearchText(a, b, locale) {
    return String(a ?? '').localeCompare(String(b ?? ''), locale, {
        sensitivity: 'base',
        numeric: true
    });
}

function compareEnglishSearchCandidates(a, b) {
    return compareSearchText(a.word.english, b.word.english, 'en') ||
        compareSearchText(a.word.meaning, b.word.meaning, 'zh-Hant') ||
        compareSearchText(a.folderName, b.folderName, 'zh-Hant') ||
        compareSearchText(a.key, b.key, 'en');
}

function compareChineseSearchCandidates(a, b) {
    const scoreFields = ['exact', 'contiguous', 'startIndex', 'totalGap', 'length'];
    for (const field of scoreFields) {
        const difference = a.chineseScore[field] - b.chineseScore[field];
        if (difference) return difference;
    }
    return compareSearchText(a.word.meaning, b.word.meaning, 'zh-Hant') ||
        compareSearchText(a.word.english, b.word.english, 'en') ||
        compareSearchText(a.folderName, b.folderName, 'zh-Hant') ||
        compareSearchText(a.key, b.key, 'en');
}

function findSearchMatches(query, words = state.words) {
    const normalizedQuery = normalizeSearchQuery(query);
    if (!normalizedQuery) return [];
    const chineseQuery = isChineseSearchQuery(normalizedQuery);
    const normalizedEnglishQuery = normalizeEnglishSearchText(normalizedQuery);
    const matches = [];
    const matchedKeys = new Set();
    const sourceFolderIdsByEnglish = new Map();

    (words || []).forEach(word => {
        const normalizedEnglish = normalizeEnglishSearchText(word.english);
        if (!normalizedEnglish) return;
        const sourceFolderIds = sourceFolderIdsByEnglish.get(normalizedEnglish) || [];
        getWordSourceFolderIds(word).forEach(folderId => {
            if (!sourceFolderIds.includes(folderId)) sourceFolderIds.push(folderId);
        });
        sourceFolderIdsByEnglish.set(normalizedEnglish, sourceFolderIds);
    });

    (words || []).forEach(word => {
        const key = getWordKey(word);
        if (matchedKeys.has(key)) return;

        let englishMatchStart = -1;
        let englishMatchLength = 0;
        let chineseMatchIndexes = null;
        let chineseScore = null;
        const normalizedEnglish = normalizeEnglishSearchText(word.english);
        const matchIndex = normalizedEnglish.indexOf(normalizedEnglishQuery);
        if (matchIndex !== -1) {
            englishMatchStart = Array.from(normalizedEnglish.slice(0, matchIndex)).length;
            englishMatchLength = Array.from(normalizedEnglishQuery).length;
        }

        if (chineseQuery) {
            chineseMatchIndexes = findOrderedMatchIndexes(word.meaning, normalizedQuery);
            if (!chineseMatchIndexes && englishMatchStart === -1) return;
            chineseScore = chineseMatchIndexes
                ? getChineseMatchScore(word.meaning, normalizedQuery, chineseMatchIndexes)
                : {
                    exact: 2,
                    contiguous: 2,
                    startIndex: Number.MAX_SAFE_INTEGER,
                    totalGap: Number.MAX_SAFE_INTEGER,
                    length: Number.MAX_SAFE_INTEGER
                };
        } else {
            if (englishMatchStart === -1) return;
        }

        const sourceFolderIds = sourceFolderIdsByEnglish.get(normalizedEnglish) || getWordSourceFolderIds(word);
        const folderId = getWordSourceFolderIds(word)[0] || UNFILED_FOLDER;
        const folderName = sourceFolderIds.length
            ? sourceFolderIds
            .map(sourceFolderId => getFolderDisplayName(sourceFolderId))
                .join(', ')
            : UNFILED_FOLDER;
        matches.push({
            key,
            word,
            folderId,
            folderName,
            englishMatchStart,
            englishMatchLength,
            chineseMatchIndexes,
            chineseScore
        });
        matchedKeys.add(key);
    });

    matches.sort(chineseQuery ? compareChineseSearchCandidates : compareEnglishSearchCandidates);
    return matches;
}

function appendHighlightedSubstring(container, originalText, matchStart, matchLength) {
    const chars = Array.from(String(originalText ?? ''));
    if (matchStart < 0 || matchLength <= 0 || matchStart >= chars.length) {
        container.appendChild(document.createTextNode(chars.join('')));
        return;
    }
    const before = chars.slice(0, matchStart).join('');
    const matched = chars.slice(matchStart, matchStart + matchLength).join('');
    const after = chars.slice(matchStart + matchLength).join('');
    if (before) container.appendChild(document.createTextNode(before));
    const mark = document.createElement('mark');
    mark.className = 'rounded bg-yellow-200 px-0.5 text-inherit';
    mark.textContent = matched;
    container.appendChild(mark);
    if (after) container.appendChild(document.createTextNode(after));
}

function appendHighlightedIndexes(container, text, matchedIndexes) {
    const chars = Array.from(String(text ?? ''));
    const matchedSet = new Set(matchedIndexes || []);
    chars.forEach((char, index) => {
        if (!matchedSet.has(index)) {
            container.appendChild(document.createTextNode(char));
            return;
        }
        const mark = document.createElement('mark');
        mark.className = 'rounded bg-yellow-200 px-0.5 text-inherit';
        mark.textContent = char;
        container.appendChild(mark);
    });
}

function getSearchSuggestionElements() {
    return {
        control: document.getElementById('search-control'),
        input: document.getElementById('search-input'),
        listbox: document.getElementById('search-suggestions')
    };
}

function positionSearchSuggestions() {
    const { control, input, listbox } = getSearchSuggestionElements();
    if (!control || !input || !listbox || typeof control.getBoundingClientRect !== 'function') return;
    const controlRect = control.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const viewportWidth = document.documentElement?.clientWidth || window.innerWidth || inputRect.right;
    const viewportPadding = 8;
    const availableWidth = Math.max(0, viewportWidth - viewportPadding * 2);
    const desiredWidth = Math.min(availableWidth, Math.max(inputRect.width, 352));
    const absoluteLeft = Math.min(
        Math.max(inputRect.left, viewportPadding),
        Math.max(viewportPadding, viewportWidth - viewportPadding - desiredWidth)
    );
    listbox.style.width = `${desiredWidth}px`;
    listbox.style.left = `${absoluteLeft - controlRect.left}px`;
    listbox.style.right = 'auto';
    listbox.style.maxHeight = `${SEARCH_SUGGESTION_VISIBLE_COUNT * SEARCH_SUGGESTION_ROW_HEIGHT}px`;
    listbox.style.overflowY = 'auto';
}

function closeSearchSuggestions({ clearResults = false } = {}) {
    const { input, listbox } = getSearchSuggestionElements();
    activeSearchSuggestionIndex = -1;
    if (input) {
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }
    if (listbox) {
        setElementVisible(listbox, false);
        listbox.scrollTop = 0;
        if (clearResults) listbox.replaceChildren();
    }
    if (clearResults) searchSuggestions = [];
}

function scrollSearchSuggestionIntoView(option, listbox) {
    if (!option || !listbox) return;
    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    const visibleTop = listbox.scrollTop;
    const visibleBottom = visibleTop + listbox.clientHeight;
    if (optionTop < visibleTop) listbox.scrollTop = optionTop;
    else if (optionBottom > visibleBottom) listbox.scrollTop = optionBottom - listbox.clientHeight;
}

function updateActiveSearchSuggestion(index, { scroll = true } = {}) {
    const { input, listbox } = getSearchSuggestionElements();
    if (!input || !listbox || !searchSuggestions.length) {
        activeSearchSuggestionIndex = -1;
        if (input) input.removeAttribute('aria-activedescendant');
        return;
    }
    activeSearchSuggestionIndex = Math.max(0, Math.min(index, searchSuggestions.length - 1));
    const options = Array.from(listbox.querySelectorAll('[role="option"]'));
    options.forEach((option, optionIndex) => {
        option.setAttribute('aria-selected', String(optionIndex === activeSearchSuggestionIndex));
    });
    const activeOption = options[activeSearchSuggestionIndex];
    if (!activeOption) return;
    input.setAttribute('aria-activedescendant', activeOption.id);
    if (scroll) scrollSearchSuggestionIntoView(activeOption, listbox);
}

function navigateToWord(word) {
    if (!word) return false;
    closeSearchSuggestions({ clearResults: true });
    const targetFolderId = getWordSourceFolderIds(word)[0] || UNFILED_FOLDER;
    const targetWordId = getWordKey(word);
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
    return true;
}

function selectSearchSuggestion(index) {
    const candidate = searchSuggestions[index];
    if (!candidate) return false;
    return navigateToWord(candidate.word);
}

function createSearchSuggestionOption(candidate, index, renderId) {
    const option = document.createElement('button');
    option.type = 'button';
    option.id = `search-suggestion-${renderId}-${index}`;
    option.className = 'search-suggestion-option flex w-full items-center gap-3 border-b border-gray-100 px-3 py-2 text-left last:border-b-0 hover:bg-indigo-50 focus:outline-none';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.dataset.searchSuggestionIndex = String(index);

    const textWrap = document.createElement('span');
    textWrap.className = 'min-w-0 flex-1';
    const english = document.createElement('span');
    english.className = 'block truncate text-sm font-bold text-gray-900';
    if (candidate.englishMatchStart >= 0) {
        appendHighlightedSubstring(
            english,
            candidate.word.english,
            candidate.englishMatchStart,
            candidate.englishMatchLength
        );
    } else {
        english.textContent = candidate.word.english || '';
    }
    const meaning = document.createElement('span');
    meaning.className = 'block truncate text-xs text-gray-600';
    if (candidate.chineseMatchIndexes) {
        appendHighlightedIndexes(meaning, candidate.word.meaning, candidate.chineseMatchIndexes);
    } else {
        meaning.textContent = candidate.word.meaning || '';
    }
    textWrap.append(english, meaning);

    const folder = document.createElement('span');
    folder.className = 'flex-none text-xs text-gray-400';
    folder.style.maxWidth = '52%';
    folder.style.overflowWrap = 'anywhere';
    folder.style.textAlign = 'right';
    folder.style.lineHeight = '1.25';
    folder.textContent = candidate.folderName;
    folder.title = candidate.folderName;
    option.append(textWrap, folder);
    option.addEventListener('mouseenter', () => updateActiveSearchSuggestion(index, { scroll: false }));
    option.addEventListener('click', () => selectSearchSuggestion(index));
    return option;
}

function updateSearchSuggestions() {
    if (isSearchComposing) return;
    const { input, listbox } = getSearchSuggestionElements();
    if (!input || !listbox) return;
    const query = normalizeSearchQuery(input.value);
    if (!query || !state.words.length) {
        closeSearchSuggestions({ clearResults: true });
        return;
    }

    const allMatches = findSearchMatches(query);
    searchSuggestions = allMatches.slice(0, MAX_SEARCH_SUGGESTIONS);
    activeSearchSuggestionIndex = -1;
    searchSuggestionRenderId += 1;
    listbox.replaceChildren();
    listbox.scrollTop = 0;

    if (!searchSuggestions.length) {
        const empty = document.createElement('div');
        empty.className = 'px-4 py-4 text-center text-sm text-gray-500';
        empty.setAttribute('role', 'status');
        empty.textContent = '找不到符合的單字';
        listbox.appendChild(empty);
    } else {
        searchSuggestions.forEach((candidate, index) => {
            listbox.appendChild(createSearchSuggestionOption(candidate, index, searchSuggestionRenderId));
        });
        if (allMatches.length > MAX_SEARCH_SUGGESTIONS) {
            const more = document.createElement('div');
            more.className = 'border-t border-gray-100 px-3 py-2 text-center text-xs text-gray-500';
            more.setAttribute('role', 'status');
            more.textContent = '另有更多符合結果，請繼續輸入以縮小範圍';
            listbox.appendChild(more);
        }
    }

    positionSearchSuggestions();
    setElementVisible(listbox, true);
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
}

function refreshSearchSuggestionsForCurrentData() {
    const { input } = getSearchSuggestionElements();
    if (!input || !normalizeSearchQuery(input.value) || !state.words.length) {
        closeSearchSuggestions({ clearResults: true });
        return;
    }
    updateSearchSuggestions();
}

function handleSearchInput() {
    if (!isSearchComposing) updateSearchSuggestions();
}

function handleSearchFocus() {
    const { input } = getSearchSuggestionElements();
    if (input && normalizeSearchQuery(input.value)) updateSearchSuggestions();
}

function handleSearchCompositionStart() {
    isSearchComposing = true;
}

function handleSearchCompositionEnd() {
    isSearchComposing = false;
    updateSearchSuggestions();
}

function handleSearchOutsidePointerDown(event) {
    const { control } = getSearchSuggestionElements();
    if (control && !control.contains(event.target)) closeSearchSuggestions();
}

function handleSearchKeydown(event) {
    if (isSearchComposing || event.isComposing) return;
    const { input, listbox } = getSearchSuggestionElements();
    if (!input || !listbox) return;
    const isOpen = !listbox.hidden && !listbox.classList.contains('hidden');

    if (event.key === 'Escape') {
        if (isOpen) event.preventDefault();
        closeSearchSuggestions();
        return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!isOpen) updateSearchSuggestions();
        if (!searchSuggestions.length) return;
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = activeSearchSuggestionIndex === -1
            ? (direction > 0 ? 0 : searchSuggestions.length - 1)
            : activeSearchSuggestionIndex + direction;
        updateActiveSearchSuggestion(nextIndex);
        return;
    }
    if (event.key === 'Enter') {
        if (isOpen && searchSuggestions.length) {
            event.preventDefault();
            selectSearchSuggestion(activeSearchSuggestionIndex >= 0 ? activeSearchSuggestionIndex : 0);
            return;
        }
        searchWord();
    }
}

function searchWord() {
    const input = document.getElementById('search-input');
    const query = normalizeSearchQuery(input?.value);
    if (!query) {
        closeSearchSuggestions({ clearResults: true });
        return false;
    }
    const normalizedEnglishQuery = normalizeEnglishSearchText(query);
    const exactEnglish = state.words.find(word =>
        normalizeEnglishSearchText(word.english) === normalizedEnglishQuery
    );
    const foundWord = exactEnglish || findSearchMatches(query)[0]?.word;
    if (!foundWord) {
        alert('找不到這個單字。');
        return false;
    }
    return navigateToWord(foundWord);
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

    const ok = await commitUserMutation(model => createPersonalFolder(model, name));
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
    const ok = await commitUserMutation(model => {
        const group = groupInfo(oldName);
        if (isDefaultLesson) {
            model.setSettings({ lessonFolderNames: { ...state.settings.lessonFolderNames, [group.id]: validatedName } });
        } else {
            model.setFolder(group.id, { name: validatedName });
        }
    });
    if (!ok) return;
    renderLibrary();
    closeModal('rename-modal');
    state.targetFolderAction = '';
}

function getFolderDeleteConfirmation(folderId, deleteAll) {
    const folderWords = state.words.filter(word => getWordSourceFolderIds(word).includes(folderId));
    const sharedCount = folderWords.filter(word => (
        getWordSourceFolderIds(word).some(sourceFolderId => sourceFolderId !== folderId)
    )).length;
    const wordCount = folderWords.length;
    const exclusiveCount = wordCount - sharedCount;
    const folderDisplayName = getFolderDisplayName(folderId);
    if (deleteAll) {
        return {
            title: `刪除「${folderDisplayName}」與專屬單字？`,
            description: `此資料夾共有 ${wordCount} 個單字：\n• ${exclusiveCount} 個僅屬於此資料夾，公用單字只對你隱藏，個人新增單字會刪除\n• ${sharedCount} 個同時屬於其他資料夾，會保留在那些資料夾中\n\n移除的單字也會從待複習與目前練習資料中移除。\n\n隱藏的公用單字可在設定中恢復。`,
            submitLabel: exclusiveCount
                ? `刪除資料夾與 ${exclusiveCount} 個專屬單字`
                : '刪除資料夾（保留共享單字）',
            wordCount,
            sharedCount,
            exclusiveCount
        };
    }
    return {
        title: `刪除「${folderDisplayName}」資料夾？`,
        description: `此資料夾共有 ${wordCount} 個單字，全部都會保留：\n• ${sharedCount} 個同時屬於其他資料夾，會留在那些資料夾中\n• ${exclusiveCount} 個僅屬於此資料夾，將移至「${UNFILED_FOLDER}」。`,
        submitLabel: '刪除資料夾',
        wordCount,
        sharedCount,
        exclusiveCount
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
    const deletedWordKeys = new Set(state.words.filter(word => deleteWords &&
        getWordSourceFolderIds(word).includes(oldName) && getWordSourceFolderIds(word).length === 1).map(getWordKey));
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
        const ok = await commitUserMutation(model => {
            [...state.words, ...state.hiddenWords].forEach(word => {
                if (!getWordGroupIds(word).includes(oldName)) return;
                if (deletedWordKeys.has(word.id)) {
                    if (word.source === 'public') model.hidePublicWord(word.id);
                    else { model.deleteCustomWord(word.id); return; }
                }
                setWordGroups(model, word.id, getWordGroupIds(word).filter(key => key !== oldName));
            });
            const group = groupInfo(oldName);
            if (isDefaultLesson) {
                const names = { ...state.settings.lessonFolderNames };
                delete names[group.id];
                model.setSettings({ hiddenLessonIds: [...new Set([...state.settings.hiddenLessonIds, group.id])], lessonFolderNames: names });
            } else model.deleteFolder(group.id);
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
    closeSearchSuggestions({ clearResults: true });
    state.editingWordIndex = idx;
    const modal = document.getElementById('add-modal');
    const tagInput = document.getElementById('new-folder-name');
    const partOfSpeechInput = document.getElementById('new-part-of-speech');
    document.getElementById('modal-title').innerText = idx >= 0 ? '編輯單字' : '新增單字';

    if (idx >= 0) {
        const w = state.words[idx];
        document.getElementById('new-word').value = w.english;
        document.getElementById('new-meaning').value = w.meaning;
        if (partOfSpeechInput) partOfSpeechInput.querySelectorAll('input').forEach(input => { input.checked = w.partOfSpeech.includes(input.value); });
        renderFolderSelection(
            getWordSourceFolderIds(w),
            !!w.isWrong
        );
    } else {
        document.getElementById('new-word').value = '';
        document.getElementById('new-meaning').value = '';
        if (partOfSpeechInput) partOfSpeechInput.querySelectorAll('input').forEach(input => { input.checked = false; });
        let preSelectedFolderId = '';
        const wordListView = document.getElementById('view-word-list');
        const currentTitle = document.getElementById('list-title');
        const current = currentTitle?.dataset.folderId || currentTitle?.innerText;
        const isWordListVisible = wordListView && !wordListView.classList.contains('hidden');
        if (isWordListVisible && current && !state.categories.includes(current) && current !== '全部' && current !== WRONG_FOLDER && current !== UNFILED_FOLDER) {
            preSelectedFolderId = current;
        }
        renderFolderSelection(preSelectedFolderId ? [preSelectedFolderId] : [], current === WRONG_FOLDER);
    }
    if (tagInput) tagInput.value = '';
    renderPersonalWordActions(idx >= 0 ? state.words[idx] : null);
    openModal(modal, '#new-word');
}

function renderPersonalWordActions(word) {
    document.getElementById('personal-word-actions')?.remove();
    if (!word) return;
    const panel = document.createElement('div');
    panel.id = 'personal-word-actions';
    panel.className = 'space-y-2 border-t pt-3 text-sm';
    const addAction = (label, action, danger = false) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = danger ? 'w-full p-2 rounded-lg bg-red-50 text-red-600 font-bold' : 'w-full p-2 rounded-lg bg-indigo-50 text-indigo-700 font-bold';
        button.textContent = label;
        button.addEventListener('click', action);
        panel.appendChild(button);
    };
    if (word.source === 'public') {
        const override = userWordState.getWordOverride(word.id) || {};
        const names = { english: '英文', meaning: '中文意思', partOfSpeech: '詞性', isWrong: '待複習狀態' };
        Object.keys(names).filter(field => Object.hasOwn(override, field)).forEach(field => {
            addAction(`恢復公用${names[field]}`, () => changeWordOverride(word.id, model => model.clearWordOverrideField(word.id, field)));
        });
        [...(override.addedLessonIds || []), ...(override.removedLessonIds || [])].forEach(id => {
            addAction(`取消${(override.removedLessonIds || []).includes(id) ? '移除' : '新增'}「${getFolderDisplayName(groupKey('lesson', id))}」`,
                () => changeWordOverride(word.id, model => model.clearLessonChange(word.id, id)));
        });
        if (Object.keys(override).length) {
            addAction('恢復此字全部公用內容', () => changeWordOverride(word.id, model => model.clearWordOverride(word.id)));
        }
        addAction('只對我隱藏此單字', () => deletePersonalWord(word.id), true);
    } else {
        addAction('刪除我的新增單字', () => deletePersonalWord(word.id), true);
    }
    document.querySelector('#add-modal .space-y-4').appendChild(panel);
}

async function changeWordOverride(id, action) {
    const ok = await commitUserMutation(model => action(model));
    if (!ok) return;
    openAddModal(state.words.findIndex(word => word.id === id));
    rerenderVisibleView();
}

async function deletePersonalWord(id) {
    const word = state.words.find(item => item.id === id);
    if (!word || !requireLoginForChange()) return;
    const message = word.source === 'public' ? '只對你隱藏這個公用單字？可在設定中恢復。' : '刪除你新增的這個單字？';
    if (!confirm(message)) return;
    const ok = await commitUserMutation(model => {
        if (word.source === 'public') model.hidePublicWord(id);
        else model.deleteCustomWord(id);
    });
    if (!ok) return;
    purgeDeletedWordReferences(new Set([id]));
    closeAddModal();
    rerenderVisibleView();
}

async function restoreHiddenWords() {
    if (!requireLoginForChange()) return;
    if (!state.hiddenWords.length) { alert('目前沒有隱藏的公用單字。'); return; }
    const ok = await commitUserMutation(model => model.restoreAllHidden());
    if (!ok) return;
    closeSettingsModal();
    rerenderVisibleView();
    alert('已恢復隱藏的公用單字，保留原有個人修改。');
}

function closeAddModal() {
    closeModal('add-modal');
    state.editingWordIndex = -1;
}

function renderFolderSelection(selectedFolderIds = [], isWrong = false) {
    const container = document.getElementById('folder-selection-container');
    if (!container) return;
    container.replaceChildren();

    const selected = new Set(normalizeFolderIds(selectedFolderIds));
    const normalFolderIds = state.folderIds.filter(folderId => (
        folderId !== WRONG_FOLDER && folderId !== UNFILED_FOLDER
    ));
    if (!normalFolderIds.length) {
        const empty = document.createElement('div');
        empty.className = 'text-xs text-gray-400';
        empty.textContent = '目前沒有可選資料夾；儲存後會列入未分類。';
        container.appendChild(empty);
    }

    normalFolderIds.forEach((folderId, index) => {
        const label = document.createElement('label');
        label.className = 'flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-white';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'word-folders';
        checkbox.className = 'folder-checkbox w-4 h-4 text-indigo-600 rounded flex-none';
        checkbox.value = folderId;
        checkbox.id = `folder-checkbox-${index}`;
        checkbox.checked = selected.has(folderId);

        const span = document.createElement('span');
        span.className = 'text-sm text-gray-700 min-w-0 break-all';
        span.textContent = `${isLessonFolder(folderId) ? '課程' : '資料夾'}：${getFolderDisplayName(folderId)}`;

        label.append(checkbox, span);
        container.appendChild(label);
    });

    if (normalFolderIds.length) {
        const unfiledHint = document.createElement('p');
        unfiledHint.className = 'text-xs text-gray-400 px-2 pt-1';
        unfiledHint.textContent = '未勾選任何資料夾時，單字會列入未分類。';
        container.appendChild(unfiledHint);
    }

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
    const partOfSpeech = Array.from(document.querySelectorAll('#new-part-of-speech input:checked')).map(input => input.value);
    const folderInputEl = document.getElementById('new-folder-name');
    if (!eng) {
        alert('請輸入英文；中文意思可以留空。');
        return;
    }

    const selectedFolderIds = Array.from(document.querySelectorAll('.folder-checkbox:checked'))
        .map(checkbox => checkbox.value);
    const newFolderName = folderInputEl ? folderInputEl.value.trim() : '';
    if (/[,，]/.test(newFolderName)) {
        alert('一次只能建立一個新資料夾，請勿輸入逗號。');
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
    const isWrong = !!document.getElementById('wrong-checkbox')?.checked;

    const editingIndex = state.editingWordIndex;
    const previousWord = editingIndex >= 0 ? cloneWord(state.words[editingIndex]) : null;
    const ok = await commitUserMutation(model => {
        const newFolder = validatedNewFolderName ? createPersonalFolder(model, validatedNewFolderName) : '';
        // Hidden course groups are not editable in this view and must survive an unrelated edit.
        const unseenGroups = previousWord ? getWordGroupIds(previousWord).filter(key => !state.folderIds.includes(key)) : [];
        const groups = normalizeFolderIds([...unseenGroups, ...selectedFolderIds, newFolder]);
        const fields = { english: eng, meaning: mean, partOfSpeech, isWrong };
        if (previousWord) {
            const patch = Object.fromEntries(Object.entries(fields).filter(([key, value]) =>
                JSON.stringify(value) !== JSON.stringify(previousWord[key])));
            if (Object.keys(patch).length) updatePersonalWord(model, previousWord.id, patch);
            if (JSON.stringify([...groups].sort()) !== JSON.stringify(getWordGroupIds(previousWord).sort())) {
                setWordGroups(model, previousWord.id, groups);
            }
        } else {
            const id = createCustomWordId();
            model.createCustomWord({ id, ...fields, lessonIds: [], folderIds: [] });
            setWordGroups(model, id, groups);
        }
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
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${cls} folder-card relative min-h-[80px] rounded-2xl flex items-center justify-center shadow-sm cursor-pointer active:scale-95 transition-all text-lg text-center px-2 break-all leading-tight`;

    const span = document.createElement('span');
    span.textContent = name;
    button.appendChild(span);

    if (state.isEditing && editable) {
        const edit = document.createElement('span');
        edit.className = 'absolute top-1 right-1 text-xs bg-white text-red-500 rounded-full w-5 h-5 flex items-center justify-center';
        edit.textContent = '✎';
        edit.setAttribute('aria-hidden', 'true');
        button.appendChild(edit);
    }

    const activateFolder = () => handleFolderClick(oriName || name.split(' ')[0]);
    button.addEventListener('click', activateFolder);
    button.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activateFolder();
    });
    return button;
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
    card.className = 'word-card w-full relative';
    card.dataset.wordId = getWordKey(w);
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', `${w.english} 單字卡`);

    const inner = document.createElement('div');
    inner.className = 'word-card-inner';

    const front = document.createElement('div');
    front.className = 'word-card-front bg-white border-2 border-indigo-50 p-6 relative flex flex-col justify-center items-center rounded-2xl';
    front.setAttribute('aria-hidden', 'false');

    const editBtn = document.createElement('button');
    editBtn.className = 'absolute top-3 left-3 text-gray-400 hover:text-indigo-600 bg-white rounded-full p-1 shadow-sm z-20';
    editBtn.type = 'button';
    editBtn.textContent = '✎';
    editBtn.setAttribute('aria-label', `編輯 ${w.english}`);
    editBtn.addEventListener('click', event => {
        event.stopPropagation();
        openAddModal(w.idx);
    });
    front.appendChild(editBtn);

    if (w.isWrong) {
        const badge = document.createElement('span');
        badge.className = 'absolute top-3 right-12 text-xs bg-red-100 text-red-500 px-2 py-1 rounded-full font-bold';
        badge.textContent = REVIEW_FOLDER_LABEL;
        front.appendChild(badge);
    }

    const english = document.createElement('span');
    english.className = 'text-3xl font-black text-indigo-900 break-all text-center cursor-pointer';
    english.title = '發音';
    english.tabIndex = 0;
    english.setAttribute('role', 'button');
    english.setAttribute('aria-label', `發音：${w.english}`);
    english.textContent = w.english;
    english.addEventListener('click', event => {
        event.stopPropagation();
        speakWord(w.english);
    });
    english.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        speakWord(w.english);
    });
    front.appendChild(english);

    const back = document.createElement('div');
    back.className = 'word-card-back p-6 bg-indigo-50 border-2 border-indigo-200 flex flex-col rounded-2xl';
    back.setAttribute('aria-hidden', 'true');
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

    const flipButton = document.createElement('button');
    flipButton.type = 'button';
    flipButton.className = 'absolute top-3 right-3 text-indigo-500 hover:text-indigo-600 bg-white rounded-full p-1 shadow-sm z-20';
    flipButton.textContent = '↻';
    flipButton.setAttribute('aria-pressed', 'false');
    flipButton.setAttribute('aria-label', `翻看 ${w.english} 的字義`);
    card.appendChild(flipButton);

    const toggleCard = () => {
        const isFlipped = card.classList.toggle('is-flipped');
        front.inert = isFlipped;
        front.setAttribute('aria-hidden', String(isFlipped));
        back.setAttribute('aria-hidden', String(!isFlipped));
        flipButton.setAttribute('aria-pressed', String(isFlipped));
        flipButton.setAttribute(
            'aria-label',
            isFlipped
                ? `翻回 ${w.english}，字義：${getMeaningWithPartOfSpeech(w)}`
                : `翻看 ${w.english} 的字義`
        );
    };
    card.addEventListener('click', toggleCard);
    flipButton.addEventListener('click', event => {
        event.stopPropagation();
        toggleCard();
    });
    flipButton.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        toggleCard();
    });
    return card;
}

function parseMeaning(raw, partOfSpeech = []) {
    const pos = getPartOfSpeechShort(partOfSpeech);
    return String(raw || '').split(/[;；]/).map(text => text.trim()).filter(Boolean).map(text => ({ text, pos }));
}

function getMeaningWithPartOfSpeech(word) {
    return [word?.meaning || '', getPartOfSpeechShort(word?.partOfSpeech || [])].filter(Boolean).join(' ');
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
    const excludeReviewButton = document.getElementById('btn-practice-exclude-review');
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
        if (excludeReviewButton) excludeReviewButton.disabled = true;
        updatePracticeStartButtons(0);
        return;
    }

    if (excludeReviewButton) excludeReviewButton.disabled = !pool.some(word => word.isWrong);

    pool.forEach(word => {
        const div = document.createElement('div');
        div.className = 'flex items-center p-2 border-b border-gray-100 last:border-0 hover:bg-white transition';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'practice-checkbox w-5 h-5 text-indigo-600 rounded mr-3';
        checkbox.checked = true;
        checkbox.dataset.wordId = getWordKey(word);
        checkbox.dataset.inReview = String(!!word.isWrong);
        checkbox.setAttribute('aria-label', `選取 ${word.english}`);
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

function excludeReviewPracticeWords() {
    document.querySelectorAll('.practice-checkbox[data-in-review="true"]').forEach(checkbox => {
        checkbox.checked = false;
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

    gameGeneration += 1;
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
        scheduleGameAdvance( 600);
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
    scheduleGameAdvance( 1500);
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
                scheduleGameAdvance( 800);
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
                scheduleGameAdvance( 1500);
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

function formatMeaning(raw, partOfSpeech = []) {
    const text = String(raw || '').trim();
    return [(text.length > 15 ? text.substring(0, 15) + '...' : text), getPartOfSpeechShort(partOfSpeech)].filter(Boolean).join(' ');
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

// Delayed answers from an old game/account cannot advance the current game.
function scheduleGameAdvance(delay) {
    const generation = gameGeneration;
    const session = authSessionGeneration;
    setTimeout(() => {
        if (generation === gameGeneration && session === authSessionGeneration) nextQuestion();
    }, delay);
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
    const newFolderInput = document.getElementById('result-new-folder-name');
    if (newFolderInput) newFolderInput.value = '';
    renderResultFolderOptions();
    renderResultWordList();
}

function renderResultWordList(selectedWordIds = null) {
    const wrongs = Array.from(state.game.wrongWords);
    const checkedIds = selectedWordIds || new Set(wrongs.map(getWordKey));
    const list = document.getElementById('result-skipped-items');
    state.game.reviewSelection = [];
    list.replaceChildren();

    if (!wrongs.length) {
        const li = document.createElement('li');
        li.className = 'p-4 text-center text-green-600 font-bold bg-green-50 rounded-xl';
        li.textContent = '👏 完美！沒有錯誤單字。';
        list.appendChild(li);
    } else {
        wrongs.forEach((word, idx) => {
            const checked = checkedIds.has(getWordKey(word));
            if (checked) state.game.reviewSelection.push(word);
            list.appendChild(createReviewItem(word, idx, checked));
        });
    }

    updateResultActionButtons();
}

function getAssignableResultFolderIds() {
    return state.folderIds.filter(folderId => folderId !== WRONG_FOLDER && folderId !== UNFILED_FOLDER);
}

function renderResultFolderOptions(selectedFolderId = '') {
    refreshFolders();
    const select = document.getElementById('result-folder-select');
    if (!select) return;

    const folderIds = getAssignableResultFolderIds();
    const placeholder = new Option(folderIds.length ? '選擇現有資料夾' : '目前沒有可選資料夾', '');
    select.replaceChildren(placeholder);
    folderIds.forEach(folderId => {
        select.appendChild(new Option(getFolderDisplayName(folderId), folderId));
    });
    select.disabled = folderIds.length === 0;
    if (selectedFolderId && folderIds.includes(selectedFolderId)) select.value = selectedFolderId;
    updateResultActionButtons();
}

function updateResultActionButtons() {
    const hasSelection = state.game.reviewSelection.length > 0;
    const saveReviewButton = document.getElementById('btn-save-review');
    if (saveReviewButton) saveReviewButton.disabled = !hasSelection;

    const folderSelect = document.getElementById('result-folder-select');
    const newFolderInput = document.getElementById('result-new-folder-name');
    const saveFolderButton = document.getElementById('btn-save-result-folder');
    const hasDestination = !!folderSelect?.value || !!newFolderInput?.value.trim();
    if (saveFolderButton) saveFolderButton.disabled = !hasSelection || !hasDestination;
}

function handleResultFolderSelectChange() {
    const select = document.getElementById('result-folder-select');
    const input = document.getElementById('result-new-folder-name');
    if (select?.value && input) input.value = '';
    updateResultActionButtons();
}

function handleResultNewFolderInput() {
    const select = document.getElementById('result-folder-select');
    const input = document.getElementById('result-new-folder-name');
    if (input?.value.trim() && select) select.value = '';
    updateResultActionButtons();
}

function syncResultWordReferences() {
    const currentWordsById = new Map(state.words.map(word => [getWordKey(word), word]));
    state.game.wrongWords = new Set(Array.from(state.game.wrongWords)
        .map(word => currentWordsById.get(getWordKey(word)))
        .filter(Boolean));
    state.game.reviewSelection = state.game.reviewSelection
        .map(word => currentWordsById.get(getWordKey(word)))
        .filter(Boolean);
}

function createReviewItem(w, idx, checked = true) {
    const li = document.createElement('li');
    li.className = 'bg-white p-3 rounded-xl border border-gray-100 shadow-sm';
    li.dataset.wordId = getWordKey(w);

    const rowWrap = document.createElement('div');
    rowWrap.className = 'flex items-center gap-3';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `review-chk-${idx}`;
    checkbox.className = 'w-6 h-6 text-indigo-600 rounded flex-none';
    checkbox.checked = checked;
    checkbox.setAttribute('aria-label', `選取 ${w.english}`);
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
    updateResultActionButtons();
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
    const ok = await commitUserMutation(model => {
        selectedWordIds.forEach(id => updatePersonalWord(model, id, { isWrong: true }));
    });
    if (!ok) return;
    syncResultWordReferences();
    renderResultWordList(selectedWordIds);
    const count = state.words.filter(word =>
        selectedWordIds.has(getWordKey(word)) &&
        word.isWrong &&
        !alreadyApplied.has(getWordKey(word))
    ).length;

    alert(count > 0
        ? `已將 ${count} 個單字加入待複習。`
        : '所選單字已在待複習中。');
}

async function saveResultWordsToFolder() {
    if (!requireLoginForChange()) return;
    if (!state.game.reviewSelection.length) {
        alert('請至少選擇一個單字。');
        return;
    }

    const folderSelect = document.getElementById('result-folder-select');
    const newFolderInput = document.getElementById('result-new-folder-name');
    const selectedFolderId = folderSelect?.value || '';
    const newFolderName = newFolderInput?.value.trim() || '';

    if (!selectedFolderId && !newFolderName) {
        alert('請選擇現有資料夾，或輸入新資料夾名稱。');
        return;
    }
    if (selectedFolderId && newFolderName) {
        alert('請選擇現有資料夾或建立新資料夾，二選一。');
        return;
    }

    let targetFolderId = selectedFolderId;
    let createdFolder = false;
    if (newFolderName) {
        const validation = validateFolderName(newFolderName);
        if (!validation.valid) {
            alert(validation.message);
            return;
        }
        targetFolderId = validation.name;
        createdFolder = true;
    } else if (!getAssignableResultFolderIds().includes(selectedFolderId)) {
        alert('所選資料夾已不存在，請重新選擇。');
        renderResultFolderOptions();
        return;
    }

    const selectedWordIds = new Set(state.game.reviewSelection.map(getWordKey));
    const addedCount = state.words.filter(word =>
        selectedWordIds.has(getWordKey(word)) && !getWordSourceFolderIds(word).includes(targetFolderId)
    ).length;
    const ok = await commitUserMutation(model => {
        if (createdFolder) targetFolderId = createPersonalFolder(model, targetFolderId);
        selectedWordIds.forEach(id => {
            const word = model.getEffectiveWord(id);
            if (word) setWordGroups(model, id, [...getWordGroupIds(word), targetFolderId]);
        });
    });
    if (!ok) return;

    syncResultWordReferences();
    renderResultWordList(selectedWordIds);
    if (newFolderInput) newFolderInput.value = '';
    renderResultFolderOptions(targetFolderId);

    const displayName = getFolderDisplayName(targetFolderId);
    if (createdFolder) {
        alert(`已建立「${displayName}」，並將 ${addedCount} 個單字加入此資料夾。`);
    } else if (addedCount > 0) {
        alert(`已將 ${addedCount} 個單字加入「${displayName}」，原有資料夾不變。`);
    } else {
        alert(`所選單字已在「${displayName}」中。`);
    }
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
    const recovery = document.getElementById('btn-export-recovery');
    setElementVisible(recovery, !!state.recovery?.backupId);
    const recoveryNote = document.getElementById('recovery-note');
    if (recoveryNote) recoveryNote.textContent = state.recovery?.conflictCount
        ? `有 ${state.recovery.conflictCount} 項舊資料合併或不確定紀錄，原始內容已保留，可下載備份檢查。`
        : '舊資料的原始內容已保留，可下載備份。';
    setElementVisible(recoveryNote, !!state.recovery?.backupId);
    openModal(modal, '#settings-bgm-enabled');
}

async function exportMigrationRecovery() {
    if (!requireLoginForChange()) return;
    const user = currentUser, generation = authSessionGeneration;
    try {
        const backup = await getPersistence().exportRecovery(user, { assertCurrent: () => assertCurrentUserSession(user, generation) });
        assertCurrentUserSession(user, generation);
        if (!backup) { alert('目前沒有需要下載的遷移備份。'); return; }
        const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = 'wordking-personal-recovery.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        if (isCurrentUserSession(user, generation)) alert('下載備份失敗：' + error.message);
    }
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

function getSettingsDraftFromUI() {
    const bgmEnabledEl = document.getElementById('settings-bgm-enabled');
    const bgmVolumeEl = document.getElementById('settings-bgm-volume');
    const speechVolumeEl = document.getElementById('settings-speech-volume');
    const bgmSelectEl = document.getElementById('settings-bgm-select');

    const nextSettings = cloneSettings(state.settings);
    if (bgmEnabledEl) nextSettings.bgmEnabled = !!bgmEnabledEl.checked;
    if (bgmVolumeEl) nextSettings.bgmVolume = clamp01((parseInt(bgmVolumeEl.value, 10) || 0) / 100);
    if (speechVolumeEl) nextSettings.speechVolume = clamp01((parseInt(speechVolumeEl.value, 10) || 0) / 100);
    if (bgmSelectEl && bgmSelectEl.value) nextSettings.selectedBgmId = bgmSelectEl.value;
    return nextSettings;
}

async function saveSettingsFromUI() {
    const nextSettings = getSettingsDraftFromUI();
    const ok = await commitUserMutation(model => model.setSettings(nextSettings), {
        requireAuth: false,
        afterRollback: applyBgmSettingsToElement
    });
    applyBgmSettingsToElement();
    return ok;
}

function updateBgmVolumeFromSlider(value) {
    const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
    const previewVolume = clamp01(v / 100);
    const label = document.getElementById('settings-bgm-volume-value');
    if (label) label.textContent = v + '%';

    const audio = state.audio && state.audio.bgmElement;
    if (audio) {
        audio.volume = bgmDucking.isDucking
            ? clamp01(previewVolume * bgmDucking.ratio)
            : previewVolume;
    }
}

function updateSpeechVolumeFromSlider(value) {
    const v = Math.max(0, Math.min(100, parseInt(value, 10) || 0));
    const label = document.getElementById('settings-speech-volume-value');
    if (label) label.textContent = v + '%';
}

function toggleBgmEnabledFromCheckbox() {
    applyBgmSettingsToElement(getSettingsDraftFromUI());
}

function changeBgmTrackFromSelect() {
    applyBgmSettingsToElement(getSettingsDraftFromUI());
}

async function confirmReset() {
    if (!requireLoginForChange()) return;
    if (!confirm('確定要重置全部雲端個人資料？這會清除新增單字、待複習狀態、資料夾與設定。')) return;
    const ok = await commitUserMutation(model => model.reset({ settings: cloneSettings(DEFAULT_SETTINGS) }));
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
    const syncUser = currentUser;
    const sessionGeneration = authSessionGeneration;
    updateAuthUI(currentUser);
    try {
        const loaded = await loadFromCloud(syncUser);
        if (!isCurrentUserSession(syncUser, sessionGeneration)) return;
        if (loaded) {
            applyBgmSettingsToElement();
            rerenderVisibleView();
            finishAppLoading();
            alert('已重新載入雲端最新資料。');
        }
    } catch (err) {
        if (!isCurrentUserSession(syncUser, sessionGeneration)) return;
        console.error('重新載入雲端資料失敗', err);
    } finally {
        if (isCurrentUserSession(syncUser, sessionGeneration)) {
            isSyncing = false;
            updateAuthUI(currentUser);
        }
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
    document.getElementById('app-loading-retry')?.addEventListener('click', retryAppLoading);
    document.getElementById('btn-home-brand')?.addEventListener('click', () => navigateTo('home'));
    document.getElementById('btn-settings')?.addEventListener('click', openSettingsModal);
    const searchInput = document.getElementById('search-input');
    searchInput?.addEventListener('input', handleSearchInput);
    searchInput?.addEventListener('keydown', handleSearchKeydown);
    searchInput?.addEventListener('focus', handleSearchFocus);
    searchInput?.addEventListener('compositionstart', handleSearchCompositionStart);
    searchInput?.addEventListener('compositionend', handleSearchCompositionEnd);
    searchInput?.addEventListener('transitionend', positionSearchSuggestions);
    document.getElementById('btn-search')?.addEventListener('click', searchWord);
    document.addEventListener('pointerdown', handleSearchOutsidePointerDown);
    window.addEventListener('resize', positionSearchSuggestions);

    document.getElementById('btn-login')?.addEventListener('click', firebaseLogin);
    document.getElementById('btn-logout')?.addEventListener('click', firebaseLogout);
    document.getElementById('btn-sync')?.addEventListener('click', syncCloudNow);

    const navButtons = document.querySelectorAll('nav .grid button');
    navButtons[0]?.addEventListener('click', () => navigateTo('home'));
    navButtons[1]?.addEventListener('click', () => navigateTo('library'));
    navButtons[2]?.addEventListener('click', () => navigateTo('practice'));

    document.getElementById('btn-reset-all')?.addEventListener('click', confirmReset);
    document.getElementById('btn-restore-hidden')?.addEventListener('click', restoreHiddenWords);
    document.getElementById('btn-export-recovery')?.addEventListener('click', exportMigrationRecovery);

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
    document.getElementById('btn-practice-select-all')?.addEventListener('click', () => toggleAllPracticeWords(true));
    document.getElementById('btn-practice-select-none')?.addEventListener('click', () => toggleAllPracticeWords(false));
    document.getElementById('btn-practice-exclude-review')?.addEventListener('click', excludeReviewPracticeWords);

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
    document.getElementById('result-folder-select')?.addEventListener('change', handleResultFolderSelectChange);
    document.getElementById('result-new-folder-name')?.addEventListener('input', handleResultNewFolderInput);
    document.getElementById('btn-save-result-folder')?.addEventListener('click', saveResultWordsToFolder);
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
    document.querySelector('#settings-modal .space-y-6 > button:last-child')?.addEventListener('click', closeSettingsModal);
}

function ensurePublicDataLoaded() {
    if (publicDataReady) return Promise.resolve();
    if (!publicDataPromise) {
        publicDataPromise = withTimeout(
            loadDefaultWordDatabase(),
            SYNC_TIMEOUT_MS,
            '公用單字資料載入逾時，請確認網路後重試。'
        ).then(() => {
            publicDataReady = true;
        }).catch(error => {
            publicDataPromise = null;
            throw error;
        });
    }
    return publicDataPromise;
}

async function handleAuthStateChanged(user) {
    const sessionGeneration = ++authSessionGeneration;
    cloudLoadGeneration += 1;
    stopUserRevisionListener();
    authReady = true;
    currentUser = user;
    cloudRevision = 0;
    pendingRemoteRevision = 0;
    activeCloudWrites = 0;
    isCloudLoading = true;
    isSyncing = false;
    isLoggingIn = false;
    isLoggingOut = false;
    isFolderDeleting = false;
    beginAppLoading('正在確認公用單字與個人資料，請稍等。');
    clearPersonalSessionData();
    updateAuthUI(user);
    try {
        // Both requests may start early, but personal migration always waits for the catalog.
        await ensurePublicDataLoaded();
        if (!isCurrentUserSession(user, sessionGeneration)) return;
        if (user) {
            const loaded = await loadFromCloud(user);
            if (!loaded || !isCurrentUserSession(user, sessionGeneration)) return;
            startUserRevisionListener(user);
        } else {
            resetToDefaultState();
            isUserDataReady = true;
            isCloudLoading = false;
        }
        if (!isCurrentUserSession(user, sessionGeneration)) return;
        applyBgmSettingsToElement();
        const requestedPage = new URL(window.location).searchParams.get('page') || 'home';
        const page = !hasDisplayedSession && ['home', 'library', 'practice'].includes(requestedPage)
            ? requestedPage : 'home';
        hasDisplayedSession = true;
        showView(page);
        history.replaceState({ viewId: page }, '', `?page=${page}`);
        updateAuthUI(currentUser);
        finishAppLoading();
    } catch (error) {
        if (!isCurrentUserSession(user, sessionGeneration)) return;
        isCloudLoading = false;
        clearPersonalSessionData();
        updateAuthUI(currentUser);
        console.error('載入帳號資料失敗', error);
        failAppLoading((publicDataReady && user ? '個人資料未能載入，尚未完成同步。' : '公用單字資料未能載入。') +
            (error.message || '請確認網路後重試。'));
    }
}

function retryAppLoading() {
    if (!authReady) {
        window.location.reload();
        return;
    }
    if (isCloudLoading) return;
    void handleAuthStateChanged(auth.currentUser);
}

async function bootstrap() {
    try {
        initializeModalAccessibility();
        bindStaticEvents();
        setupAudioSystem();
        setupBgmAutoplayUnlock();
        beginAppLoading('正在載入公用單字並確認登入狀態，請稍等。');
        void ensurePublicDataLoaded().catch(() => {});
        onAuthStateChanged(auth, user => void handleAuthStateChanged(user), error => {
            authSessionGeneration += 1;
            cloudLoadGeneration += 1;
            stopUserRevisionListener();
            authReady = false;
            currentUser = null;
            isCloudLoading = false;
            clearPersonalSessionData();
            updateAuthUI(null);
            console.error('確認登入狀態失敗', error);
            failAppLoading('無法確認登入狀態，請確認網路後重試。');
        });
    } catch (error) {
        console.error(error);
        failAppLoading('網站初始化失敗，請重試載入。');
    }
}

document.addEventListener('DOMContentLoaded', bootstrap);
