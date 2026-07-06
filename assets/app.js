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
    doc,
    getDoc,
    setDoc
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

const LESSON_MANIFEST_URL = './data/lessons/manifest.json';
const WRONG_FOLDER = '錯題區';

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
    selectedBgmId: 'bgm_new_dora'
};

const bgmDucking = {
    isDucking: false,
    ratio: 0.3
};

let defaultWordDatabase = [];
let currentUser = null;
let authReady = false;
let isCloudLoading = false;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

const state = {
    words: [],
    categories: "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(''),
    unitTags: [WRONG_FOLDER],
    folders: [WRONG_FOLDER],
    lessonTags: [],
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
    pendingDeleteType: null,
    pendingResultFolder: false
};

window.state = state;

function cloneWords(words) {
    return (words || []).map(w => ({
        english: w.english || '',
        meaning: w.meaning || '',
        tags: Array.isArray(w.tags) ? [...w.tags] : []
    }));
}

function clamp01(value) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

function hydrateSettings(saved) {
    const base = { ...DEFAULT_SETTINGS };
    if (saved && typeof saved === 'object') {
        if (typeof saved.bgmEnabled === 'boolean') base.bgmEnabled = saved.bgmEnabled;
        if (typeof saved.bgmVolume === 'number') base.bgmVolume = clamp01(saved.bgmVolume);
        if (typeof saved.speechVolume === 'number') base.speechVolume = clamp01(saved.speechVolume);
        if (typeof saved.selectedBgmId === 'string') base.selectedBgmId = saved.selectedBgmId;
    }
    return base;
}

function getCurrentBgmTrack() {
    return BGM_TRACKS.find(t => t.id === state.settings.selectedBgmId) || BGM_TRACKS[0] || null;
}

async function loadDefaultWordDatabase() {
    const manifestRes = await fetch(LESSON_MANIFEST_URL, { cache: 'no-cache' });
    if (!manifestRes.ok) throw new Error('無法載入單字課程清單');
    const manifest = await manifestRes.json();
    const lessonFiles = Array.isArray(manifest.lessons) ? manifest.lessons : [];
    const lessons = await Promise.all(lessonFiles.map(async lesson => {
        const res = await fetch(`./data/lessons/${lesson.file}`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`無法載入 ${lesson.file}`);
        const data = await res.json();
        return {
            id: data.id || lesson.id,
            words: Array.isArray(data.words) ? data.words : []
        };
    }));

    state.lessonTags = lessons.map(l => l.id).filter(Boolean);
    defaultWordDatabase = lessons.flatMap(l => cloneWords(l.words));
    window.defaultWordDatabase = defaultWordDatabase;
}

function resetToDefaultState() {
    state.words = cloneWords(defaultWordDatabase);
    state.folders = Array.from(new Set([WRONG_FOLDER, ...state.lessonTags]));
    state.settings = { ...DEFAULT_SETTINGS };
    refreshTags();
}

function splitTagForSeries(tag) {
    const m = String(tag).match(/^(\D+)(.*)$/);
    if (!m) return { prefix: tag, numbers: [] };
    const prefix = m[1].trim();
    const rest = m[2];
    const nums = rest ? rest.match(/\d+/g) : null;
    return { prefix, numbers: nums ? nums.map(n => parseInt(n, 10)) : [] };
}

function compareTagsBySeries(a, b) {
    if (a === WRONG_FOLDER && b !== WRONG_FOLDER) return 1;
    if (b === WRONG_FOLDER && a !== WRONG_FOLDER) return -1;

    const sa = splitTagForSeries(a);
    const sb = splitTagForSeries(b);
    if (sa.prefix !== sb.prefix) return sa.prefix.localeCompare(sb.prefix, 'zh-Hant');

    const len = Math.max(sa.numbers.length, sb.numbers.length);
    for (let i = 0; i < len; i++) {
        const na = sa.numbers[i] ?? 0;
        const nb = sb.numbers[i] ?? 0;
        if (na !== nb) return na - nb;
    }
    return a.localeCompare(b, 'zh-Hant');
}

function refreshTags() {
    const tagsSet = new Set(state.folders || []);
    state.words.forEach(w => {
        if (Array.isArray(w.tags)) w.tags.forEach(t => tagsSet.add(t));
    });
    if (!tagsSet.has(WRONG_FOLDER)) tagsSet.add(WRONG_FOLDER);
    state.unitTags = Array.from(tagsSet).sort(compareTagsBySeries);

    const datalist = document.getElementById('folder-list');
    if (datalist) {
        datalist.replaceChildren();
        state.unitTags.forEach(tag => {
            const option = document.createElement('option');
            option.value = tag;
            datalist.appendChild(option);
        });
    }
}

function mergeMeaningStrings(oldMeaning, newMeaning) {
    const splitParts = str =>
        (str || '')
            .split('/')
            .map(s => s.trim())
            .filter(Boolean);

    const seen = new Set();
    const merged = [];
    splitParts(oldMeaning).concat(splitParts(newMeaning)).forEach(part => {
        if (!seen.has(part)) {
            seen.add(part);
            merged.push(part);
        }
    });
    return merged.join(' / ');
}

function mergeDuplicateWords(words) {
    const map = new Map();
    (words || []).forEach(w => {
        if (!w || !w.english) return;
        const key = w.english.toLowerCase();
        const incomingTags = Array.isArray(w.tags) ? w.tags : [];
        if (!map.has(key)) {
            map.set(key, {
                english: w.english,
                meaning: w.meaning || '',
                tags: Array.from(new Set(incomingTags))
            });
        } else {
            const exists = map.get(key);
            exists.meaning = mergeMeaningStrings(exists.meaning, w.meaning);
            exists.tags = Array.from(new Set([...(exists.tags || []), ...incomingTags]));
            map.set(key, exists);
        }
    });
    return Array.from(map.values());
}

function mergeDefaultAndCloudWords(defaultWords, cloudWords) {
    const map = new Map();
    cloneWords(defaultWords).forEach(w => map.set(w.english.toLowerCase(), w));
    cloneWords(cloudWords).forEach(w => {
        if (!w.english) return;
        const key = w.english.toLowerCase();
        const base = map.get(key) || {};
        map.set(key, {
            english: w.english || base.english || '',
            meaning: w.meaning || base.meaning || '',
            tags: Array.isArray(w.tags) ? [...w.tags] : (Array.isArray(base.tags) ? [...base.tags] : [])
        });
    });
    return mergeDuplicateWords(Array.from(map.values()));
}

function normalizeFolders(folders, words) {
    const tags = new Set([WRONG_FOLDER, ...state.lessonTags]);
    (folders || []).forEach(f => {
        if (f) tags.add(f);
    });
    (words || []).forEach(w => {
        if (Array.isArray(w.tags)) w.tags.forEach(t => tags.add(t));
    });
    return Array.from(tags);
}

function getUserRef(user = currentUser) {
    if (!user) return null;
    return doc(db, 'users', user.uid);
}

function getCloudPayload() {
    state.words = mergeDuplicateWords(state.words);
    return {
        words: cloneWords(state.words),
        folders: Array.from(new Set(state.folders || [])),
        settings: state.settings || undefined,
        updatedAt: new Date().toISOString()
    };
}

async function saveToCloud(user = currentUser) {
    const ref = getUserRef(user);
    if (!ref) return false;
    await setDoc(ref, getCloudPayload(), { merge: true });
    return true;
}

function requireLoginForChange() {
    if (currentUser) return true;
    alert('請先登入 Google 帳號，才能新增、編輯、儲存錯題或同步個人資料。');
    return false;
}

async function persistUserData({ requireAuth = true } = {}) {
    if (isCloudLoading) return true;
    if (!currentUser) {
        if (requireAuth) requireLoginForChange();
        return false;
    }
    try {
        await saveToCloud(currentUser);
        return true;
    } catch (err) {
        console.error('雲端儲存失敗', err);
        alert('雲端儲存失敗：' + (err.message || err));
        return false;
    }
}

async function loadFromCloud(user) {
    isCloudLoading = true;
    try {
        const ref = getUserRef(user);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
            resetToDefaultState();
            await saveToCloud(user);
            return;
        }

        const data = snap.data() || {};
        state.words = mergeDefaultAndCloudWords(defaultWordDatabase, data.words || []);
        state.folders = normalizeFolders(data.folders || [], state.words);
        state.settings = hydrateSettings(data.settings || null);
        refreshTags();
    } finally {
        isCloudLoading = false;
    }
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
    document.querySelectorAll('main > div').forEach(div => div.classList.add('hidden'));
    const target = document.getElementById(`view-${viewId}`);
    if (target) target.classList.remove('hidden');

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

    const targetTag =
        (foundWord.tags && foundWord.tags.find(t => !state.categories.includes(t))) ||
        (foundWord.tags && foundWord.tags[0]);
    if (!targetTag) {
        alert('找到單字，但它目前沒有資料夾標籤。');
        return;
    }

    navigateTo('library');
    showView('word-list');
    renderWordList(targetTag);
    setTimeout(() => {
        const cards = document.querySelectorAll('.word-card');
        let targetCard = null;
        cards.forEach(card => {
            if (card.innerText.toLowerCase().includes(query)) targetCard = card;
        });
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
        hint.classList.remove('hidden');
        btn.classList.replace('bg-orange-500', 'bg-gray-500');
        btn.innerText = '完成編輯';
    } else {
        hint.classList.add('hidden');
        btn.classList.replace('bg-gray-500', 'bg-orange-500');
        btn.innerText = '管理資料夾';
    }
}

function openNewFolderModal() {
    if (!requireLoginForChange()) return;
    document.getElementById('input-new-folder-name').value = '';
    document.getElementById('new-folder-modal').classList.remove('hidden');
}

async function confirmNewFolder() {
    if (!requireLoginForChange()) return;
    const name = document.getElementById('input-new-folder-name').value.trim();
    if (!name) return;
    if (state.folders.includes(name) || state.categories.includes(name)) {
        alert('這個資料夾名稱已存在。');
        return;
    }

    state.folders.push(name);
    document.getElementById('new-folder-modal').classList.add('hidden');

    if (state.pendingResultFolder) {
        state.pendingResultFolder = false;
        const saveSelect = document.getElementById('save-target-folder');
        if (saveSelect) {
            const opt = new Option(name, name);
            saveSelect.appendChild(opt);
            saveSelect.value = name;
        }
        await persistUserData();
        return;
    }

    refreshTags();
    await persistUserData();
    renderLibrary();
}

function handleFolderClick(name) {
    if (state.isEditing) {
        if (name === WRONG_FOLDER || state.categories.includes(name)) {
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
    document.getElementById('action-folder-name').innerText = folderName;
    document.getElementById('folder-action-modal').classList.remove('hidden');
}

function closeActionModal() {
    document.getElementById('folder-action-modal').classList.add('hidden');
}

function prepareRenameFolder() {
    if (!requireLoginForChange()) return;
    closeActionModal();
    document.getElementById('input-rename-folder').value = state.targetFolderAction;
    document.getElementById('rename-modal').classList.remove('hidden');
}

async function executeRename() {
    if (!requireLoginForChange()) return;
    const oldName = state.targetFolderAction;
    const newName = document.getElementById('input-rename-folder').value.trim();

    if (newName && newName !== oldName) {
        if (state.folders.includes(newName) || state.categories.includes(newName)) {
            alert('這個名稱已存在。');
            return;
        }
        state.words.forEach(w => {
            if (Array.isArray(w.tags) && w.tags.includes(oldName)) {
                w.tags = w.tags.map(t => t === oldName ? newName : t);
            }
        });
        state.folders = state.folders.map(f => f === oldName ? newName : f);
        refreshTags();
        await persistUserData();
        renderLibrary();
    }
    document.getElementById('rename-modal').classList.add('hidden');
    state.targetFolderAction = '';
}

function prepareDeleteFolder(deleteAll) {
    if (!requireLoginForChange()) return;
    closeActionModal();
    state.pendingDeleteType = deleteAll ? 'all' : 'keep';

    const title = document.getElementById('confirm-title');
    const desc = document.getElementById('confirm-desc');
    if (deleteAll) {
        title.innerText = '刪除資料夾與單字？';
        desc.innerText = '這會刪除這個資料夾，以及只存在於此資料夾中的單字。';
    } else {
        title.innerText = '刪除資料夾？';
        desc.innerText = '單字會保留，但會移除這個資料夾標籤。';
    }
    document.getElementById('confirm-modal').classList.remove('hidden');
}

async function executeDelete() {
    if (!requireLoginForChange()) return;
    const oldName = state.targetFolderAction;
    const type = state.pendingDeleteType;

    if (type === 'keep') {
        state.words.forEach(w => {
            if (Array.isArray(w.tags)) w.tags = w.tags.filter(t => t !== oldName);
        });
    } else if (type === 'all') {
        state.words = state.words.filter(w => !Array.isArray(w.tags) || !w.tags.includes(oldName));
    }

    state.folders = state.folders.filter(f => f !== oldName);
    refreshTags();
    await persistUserData();
    renderLibrary();

    document.getElementById('confirm-modal').classList.add('hidden');
    state.targetFolderAction = '';
    state.pendingDeleteType = null;
}

function openAddModal(idx = -1) {
    if (!requireLoginForChange()) return;
    state.editingWordIndex = idx;
    const modal = document.getElementById('add-modal');
    const tagInput = document.getElementById('new-tag');
    document.getElementById('modal-title').innerText = idx >= 0 ? '編輯單字' : '新增單字';

    if (idx >= 0) {
        const w = state.words[idx];
        document.getElementById('new-word').value = w.english;
        document.getElementById('new-meaning').value = w.meaning;
        renderTagCheckboxes(Array.isArray(w.tags) ? w.tags : []);
    } else {
        document.getElementById('new-word').value = '';
        document.getElementById('new-meaning').value = '';
        let preSelected = [];
        const current = document.getElementById('list-title')?.innerText;
        if (current && !state.categories.includes(current) && current !== '全部') {
            preSelected = [current];
        }
        renderTagCheckboxes(preSelected);
    }
    if (tagInput) tagInput.value = '';
    modal.classList.remove('hidden');
}

function closeAddModal() {
    document.getElementById('add-modal').classList.add('hidden');
    state.editingWordIndex = -1;
}

function renderTagCheckboxes(selectedTags = []) {
    const container = document.getElementById('tag-checkbox-container');
    if (!container) return;
    container.replaceChildren();

    if (!state.unitTags.length) {
        const empty = document.createElement('div');
        empty.className = 'text-xs text-gray-400';
        empty.textContent = '目前沒有資料夾，請先建立。';
        container.appendChild(empty);
        return;
    }

    state.unitTags.forEach(tag => {
        const label = document.createElement('label');
        label.className = 'inline-flex items-center space-x-2 mr-3 mb-1';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'tag-checkbox w-4 h-4 text-indigo-600 rounded';
        checkbox.value = tag;
        checkbox.id = 'tag-chk-' + tag.replace(/\s+/g, '_');
        checkbox.checked = selectedTags.includes(tag);

        const span = document.createElement('span');
        span.className = 'text-sm text-gray-700';
        span.textContent = tag;

        label.append(checkbox, span);
        container.appendChild(label);
    });
}

async function saveNewWord() {
    if (!requireLoginForChange()) return;
    const eng = document.getElementById('new-word').value.trim();
    const mean = document.getElementById('new-meaning').value.trim();
    const tagInputEl = document.getElementById('new-tag');
    if (!eng || !mean) {
        alert('請輸入英文與中文意思。');
        return;
    }

    const selectedFromCheckbox = Array.from(document.querySelectorAll('.tag-checkbox:checked')).map(cb => cb.value);
    const extraTags = tagInputEl && tagInputEl.value.trim()
        ? tagInputEl.value.trim().split(/[,，]/).map(t => t.trim()).filter(Boolean)
        : [];
    const tags = Array.from(new Set([...selectedFromCheckbox, ...extraTags]));
    tags.forEach(t => {
        if (!state.folders.includes(t)) state.folders.push(t);
    });

    const data = { english: eng, meaning: mean, tags };
    if (state.editingWordIndex >= 0) {
        state.words[state.editingWordIndex] = data;
    } else {
        state.words.push(data);
    }

    refreshTags();
    await persistUserData();
    closeAddModal();

    if (!document.getElementById('view-word-list').classList.contains('hidden')) {
        renderWordList(document.getElementById('list-title').innerText);
    } else {
        renderLibrary();
    }
}

function renderLibrary() {
    refreshTags();
    const grid = document.getElementById('category-grid');
    grid.replaceChildren();
    grid.classList.toggle('editing-mode', state.isEditing);

    if (state.words.length === 0 && state.folders.length <= 1) {
        document.getElementById('empty-library-hint').classList.remove('hidden');
        return;
    }

    document.getElementById('empty-library-hint').classList.add('hidden');
    if (!state.isEditing) {
        state.categories.forEach(cat => {
            if (state.words.some(w => w.english.toUpperCase().startsWith(cat))) {
                grid.appendChild(createCatBtn(cat, 'bg-white text-indigo-600 border border-indigo-100', false, cat));
            }
        });
    }

    state.unitTags.forEach(tag => {
        const isSystem = tag === WRONG_FOLDER;
        const count = state.words.filter(w => Array.isArray(w.tags) && w.tags.includes(tag)).length;
        const style = isSystem ? 'bg-red-500 text-white font-bold' : 'bg-indigo-600 text-white font-bold';
        grid.appendChild(createCatBtn(`${tag} (${count})`, style, !isSystem, tag));
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
    document.getElementById('list-title').innerText = name;
    const container = document.getElementById('words-container');
    container.replaceChildren();

    let filtered = state.words.map((w, i) => ({ ...w, idx: i }));
    if (name.length === 1 && state.categories.includes(name)) {
        filtered = filtered.filter(w => w.english.toUpperCase().startsWith(name));
    } else {
        filtered = filtered.filter(w => Array.isArray(w.tags) && w.tags.includes(name));
    }
    filtered.sort((a, b) => a.english.localeCompare(b.english));

    if (!filtered.length) {
        const empty = document.createElement('div');
        empty.className = 'text-center text-gray-400 py-10 w-full';
        empty.textContent = '無單字';
        container.appendChild(empty);
        return;
    }

    filtered.forEach(w => container.appendChild(createWordCard(w)));
}

function createWordCard(w) {
    const card = document.createElement('div');
    card.className = 'word-card w-full';

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

    if (Array.isArray(w.tags) && w.tags.includes(WRONG_FOLDER)) {
        const badge = document.createElement('span');
        badge.className = 'absolute top-3 right-3 text-xs bg-red-100 text-red-500 px-2 py-1 rounded-full font-bold';
        badge.textContent = '錯題';
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
    parseMeaning(w.meaning).forEach(part => {
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

function parseMeaning(raw) {
    const results = [];
    if (!raw) return results;

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
            results.push({ text: textPart, pos: posPart });
        } else {
            subTexts.forEach(t => results.push({ text: t, pos: posPart }));
        }
    });
    return results;
}

function renderPracticeOptions() {
    refreshTags();
    const select = document.getElementById('practice-scope');
    select.replaceChildren(new Option('全部單字夾', 'all'));
    state.unitTags.forEach(tag => select.appendChild(new Option(tag, tag)));
}

function renderPracticeWordSelection() {
    const scope = document.getElementById('practice-scope').value;
    const container = document.getElementById('practice-word-selection');
    const countLabel = document.getElementById('selection-count');
    container.replaceChildren();

    const pool = (scope === 'all')
        ? [...state.words]
        : state.words.filter(w => Array.isArray(w.tags) && w.tags.includes(scope));
    pool.sort((a, b) => a.english.localeCompare(b.english));

    if (!pool.length) {
        const empty = document.createElement('div');
        empty.className = 'text-gray-400 text-center py-4';
        empty.textContent = '此資料夾沒有單字';
        container.appendChild(empty);
        countLabel.innerText = '已選 0 個單字';
        return;
    }

    pool.forEach(word => {
        const div = document.createElement('div');
        div.className = 'flex items-center p-2 border-b border-gray-100 last:border-0 hover:bg-white transition';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'practice-checkbox w-5 h-5 text-indigo-600 rounded mr-3';
        checkbox.checked = true;
        checkbox.dataset.english = word.english;
        checkbox.addEventListener('change', updateSelectionCount);

        const info = document.createElement('div');
        info.className = 'flex-1 min-w-0';
        const en = document.createElement('div');
        en.className = 'font-bold text-gray-800 truncate';
        en.textContent = word.english;
        const mean = document.createElement('div');
        mean.className = 'text-xs text-gray-500 truncate';
        mean.textContent = word.meaning;
        info.append(en, mean);
        div.append(checkbox, info);
        container.appendChild(div);
    });
    updateSelectionCount();
}

function updateSelectionCount() {
    const checkboxes = document.querySelectorAll('.practice-checkbox:checked');
    document.getElementById('selection-count').innerText = `已選 ${checkboxes.length} 個單字`;
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
    const selectedEnglishes = new Set(Array.from(document.querySelectorAll('.practice-checkbox:checked')).map(cb => cb.dataset.english));
    const pool = state.words.filter(w => selectedEnglishes.has(w.english));
    if (!pool.length) {
        alert('請至少選擇一個單字。');
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
        btn.disabled = viewing === null;
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
    state.game.viewingHistoryIndex = null;
    state.game.currentHadMistake = false;
    setProgressForIndex('spelling', state.game.index, total);

    const defArea = document.getElementById('spelling-definition-area');
    defArea.replaceChildren();
    parseMeaning(word.meaning).forEach(part => {
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
    state.game.viewingHistoryIndex = null;
    setProgressForIndex('choice', state.game.index, total);
    document.getElementById('choice-feedback').innerText = '';

    const isEnToCh = state.game.mode === 'choice-en-ch';
    document.getElementById('choice-question').innerText = isEnToCh ? word.english : formatMeaning(word.meaning);

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
        btn.innerText = isEnToCh ? formatMeaning(opt.meaning) : opt.english;
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
                        text: isEnToCh ? formatMeaning(choice.meaning) : choice.english,
                        isCorrect: choice === word,
                        isSelected: choice === opt
                    }))
                }));
                setTimeout(nextQuestion, 800);
            } else {
                btn.classList.add('choice-wrong');
                allBtns.forEach(b => {
                    if ((isEnToCh && b.innerText === formatMeaning(word.meaning)) ||
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
                        text: isEnToCh ? formatMeaning(choice.meaning) : choice.english,
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
        parseMeaning(entry.meaning).forEach(part => {
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
        document.getElementById('choice-question').innerText = isEnToCh ? entry.word.english : formatMeaning(entry.word.meaning);
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
        : formatMeaning(word.meaning);
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

function formatMeaning(raw) {
    const firstBlock = String(raw || '').split('/')[0].trim();
    const idx = firstBlock.lastIndexOf('(');
    let text = firstBlock;
    let pos = '';
    if (idx !== -1) {
        text = firstBlock.substring(0, idx).trim();
        pos = firstBlock.substring(idx).trim();
    }
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
    document.getElementById('view-game-spelling').classList.add('hidden');
    document.getElementById('view-game-choice').classList.add('hidden');
    document.getElementById('view-game-result').classList.remove('hidden');

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

    const saveSelect = document.getElementById('save-target-folder');
    saveSelect.replaceChildren(new Option('+ 新增資料夾...', 'NEW_FOLDER_OPTION'));
    state.unitTags.forEach(tag => {
        const option = new Option(tag, tag);
        if (tag === WRONG_FOLDER) option.selected = true;
        saveSelect.appendChild(option);
    });
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

    if (Array.isArray(w.tags) && w.tags.includes(WRONG_FOLDER)) {
        const badge = document.createElement('span');
        badge.dataset.reviewFolderBadge = 'wrong';
        badge.className = 'text-xs bg-red-100 text-red-500 px-1 rounded flex-none';
        badge.textContent = '已在錯題區';
        row.appendChild(badge);
    }

    const mean = document.createElement('span');
    mean.className = 'text-gray-500 text-sm truncate';
    mean.textContent = w.meaning;
    wrap.append(row, mean);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'w-8 h-8 rounded-full bg-red-50 text-red-500 font-black flex-none border border-red-100';
    removeBtn.textContent = '×';
    configureReviewFolderButton(removeBtn, w);

    const folderPanel = document.createElement('div');
    folderPanel.className = 'hidden mt-3 border-t border-gray-100 pt-3';
    folderPanel.dataset.folderPanel = String(idx);

    removeBtn.addEventListener('click', () => {
        if (removeBtn.disabled) return;
        renderReviewFolderPanel(folderPanel, w, removeBtn, row);
        folderPanel.classList.toggle('hidden');
    });

    rowWrap.append(checkbox, wrap, removeBtn);
    li.append(rowWrap, folderPanel);
    return li;
}

function configureReviewFolderButton(button, word) {
    const tags = Array.isArray(word.tags) ? word.tags : [];
    const hasWrongFolder = tags.includes(WRONG_FOLDER);
    button.disabled = !hasWrongFolder;
    button.classList.toggle('opacity-30', tags.length === 0);
    button.classList.toggle('opacity-40', tags.length > 0 && !hasWrongFolder);
    button.classList.toggle('cursor-not-allowed', !hasWrongFolder);
    button.title = tags.length === 0
        ? '這個單字目前沒有任何資料夾'
        : (hasWrongFolder ? '查看並移除這個單字所在資料夾' : '只有已在錯題區的單字可從這裡移除資料夾');
}

function findWordByEnglish(english) {
    return state.words.find(word => word.english.toLowerCase() === english.toLowerCase());
}

function renderReviewFolderPanel(panel, reviewWord, button, badgeRow) {
    const word = findWordByEnglish(reviewWord.english) || reviewWord;
    const tags = Array.isArray(word.tags) ? [...word.tags] : [];
    panel.replaceChildren();

    const title = document.createElement('div');
    title.className = 'text-xs font-bold text-gray-500 mb-2';
    title.textContent = '這個單字目前所在資料夾';
    panel.appendChild(title);

    if (!tags.length) {
        const empty = document.createElement('div');
        empty.className = 'text-sm text-gray-400';
        empty.textContent = '目前沒有任何資料夾。';
        panel.appendChild(empty);
        configureReviewFolderButton(button, word);
        return;
    }

    tags.forEach(tag => {
        const label = document.createElement('label');
        label.className = 'flex items-center justify-between gap-3 py-2 text-sm text-gray-700';

        const span = document.createElement('span');
        span.className = 'font-bold break-all';
        span.textContent = tag;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.className = 'w-5 h-5 text-red-500 rounded flex-none';
        checkbox.addEventListener('change', async () => {
            if (checkbox.checked) return;
            const folderName = tag === WRONG_FOLDER ? '錯題區' : `「${tag}」資料夾`;
            const ok = confirm(`是否將「${word.english}」移除${folderName}？`);
            if (!ok) {
                checkbox.checked = true;
                return;
            }
            if (!requireLoginForChange()) {
                checkbox.checked = true;
                return;
            }
            word.tags = (word.tags || []).filter(t => t !== tag);
            reviewWord.tags = Array.isArray(reviewWord.tags) ? reviewWord.tags.filter(t => t !== tag) : [];
            refreshTags();
            await persistUserData();
            refreshReviewFolderBadge(badgeRow, word);
            configureReviewFolderButton(button, word);
            renderReviewFolderPanel(panel, word, button, badgeRow);
        });

        label.append(span, checkbox);
        panel.appendChild(label);
    });
}

function refreshReviewFolderBadge(row, word) {
    row.querySelectorAll('[data-review-folder-badge]').forEach(el => el.remove());
    if (Array.isArray(word.tags) && word.tags.includes(WRONG_FOLDER)) {
        const badge = document.createElement('span');
        badge.dataset.reviewFolderBadge = 'wrong';
        badge.className = 'text-xs bg-red-100 text-red-500 px-1 rounded flex-none';
        badge.textContent = '已在錯題區';
        row.appendChild(badge);
    }
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

function onSaveTargetFolderChange(selectEl) {
    if (selectEl.value !== 'NEW_FOLDER_OPTION') return;
    if (!requireLoginForChange()) {
        selectEl.value = WRONG_FOLDER;
        return;
    }
    selectEl.value = selectEl.querySelector(`option[value="${WRONG_FOLDER}"]`)
        ? WRONG_FOLDER
        : (selectEl.options[1] ? selectEl.options[1].value : selectEl.options[0].value);
    state.pendingResultFolder = true;
    document.getElementById('input-new-folder-name').value = '';
    document.getElementById('new-folder-modal').classList.remove('hidden');
}

async function saveWrongWords() {
    if (!requireLoginForChange()) return;
    if (!state.game.reviewSelection.length) {
        alert('請至少選擇一個單字。');
        return;
    }

    const targetFolder = document.getElementById('save-target-folder').value;
    if (!targetFolder || targetFolder === 'NEW_FOLDER_OPTION') {
        alert('請選擇要儲存的資料夾。');
        return;
    }

    const englishSet = new Set(state.game.reviewSelection.map(w => w.english.toLowerCase()));
    let count = 0;
    state.words.forEach(word => {
        if (!englishSet.has(word.english.toLowerCase())) return;
        if (!Array.isArray(word.tags)) word.tags = [];
        if (!word.tags.includes(targetFolder)) {
            word.tags.push(targetFolder);
            count++;
        }
    });

    refreshTags();
    await persistUserData();
    alert(`已將 ${count} 個單字加入「${targetFolder}」。`);
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
    modal.classList.remove('hidden');
}

async function closeSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.classList.add('hidden');
    await saveSettingsFromUI();
}

async function saveSettingsFromUI() {
    const bgmEnabledEl = document.getElementById('settings-bgm-enabled');
    const bgmVolumeEl = document.getElementById('settings-bgm-volume');
    const speechVolumeEl = document.getElementById('settings-speech-volume');
    const bgmSelectEl = document.getElementById('settings-bgm-select');

    if (bgmEnabledEl) state.settings.bgmEnabled = !!bgmEnabledEl.checked;
    if (bgmVolumeEl) state.settings.bgmVolume = clamp01((parseInt(bgmVolumeEl.value, 10) || 0) / 100);
    if (speechVolumeEl) state.settings.speechVolume = clamp01((parseInt(speechVolumeEl.value, 10) || 0) / 100);
    if (bgmSelectEl && bgmSelectEl.value) state.settings.selectedBgmId = bgmSelectEl.value;

    applyBgmSettingsToElement();
    await persistUserData({ requireAuth: false });
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
    state.settings.bgmEnabled = !!checked;
    applyBgmSettingsToElement();
    await persistUserData({ requireAuth: false });
}

async function changeBgmTrackFromSelect(trackId) {
    state.settings.selectedBgmId = trackId;
    const audio = state.audio && state.audio.bgmElement;
    const track = getCurrentBgmTrack();
    if (audio && track) {
        const wasPlaying = !audio.paused;
        audio.src = track.url;
        if (state.settings.bgmEnabled && wasPlaying) audio.play().catch(() => {});
    }
    await persistUserData({ requireAuth: false });
}

async function confirmReset() {
    if (!requireLoginForChange()) return;
    if (!confirm('確定要重置全部雲端個人資料？這會清除新增單字、錯題標籤、資料夾與設定。')) return;
    resetToDefaultState();
    await persistUserData();
    applyBgmSettingsToElement();
    showView(new URL(window.location).searchParams.get('page') || 'home');
}

function updateAuthUI(user) {
    const loginBtn = document.getElementById('btn-login');
    const logoutBtn = document.getElementById('btn-logout');
    const syncBtn = document.getElementById('btn-sync');
    const userSpan = document.getElementById('user-email');
    if (!loginBtn || !logoutBtn || !syncBtn || !userSpan) return;

    if (user) {
        loginBtn.classList.add('hidden');
        logoutBtn.classList.remove('hidden');
        syncBtn.classList.remove('hidden');
        userSpan.classList.remove('hidden');
        userSpan.textContent = user.email || user.displayName || '已登入';
    } else {
        loginBtn.classList.remove('hidden');
        logoutBtn.classList.add('hidden');
        syncBtn.classList.add('hidden');
        userSpan.classList.add('hidden');
        userSpan.textContent = '';
    }
}

async function firebaseLogin() {
    try {
        await signInWithPopup(auth, provider);
    } catch (err) {
        console.error(err);
        alert('登入失敗：' + (err.message || err));
    }
}

async function firebaseLogout() {
    try {
        await signOut(auth);
    } catch (err) {
        console.error(err);
        alert('登出失敗：' + (err.message || err));
    }
}

async function syncCloudNow() {
    if (!requireLoginForChange()) return;
    const ok = await persistUserData();
    if (ok) alert('已同步到雲端。');
}

function rerenderVisibleView() {
    const visible = Array.from(document.querySelectorAll('main > div')).find(div => !div.classList.contains('hidden'));
    if (!visible) return;
    if (visible.id === 'view-library') renderLibrary();
    if (visible.id === 'view-word-list') renderWordList(document.getElementById('list-title').innerText);
    if (visible.id === 'view-practice') {
        renderPracticeOptions();
        renderPracticeWordSelection();
    }
}

function bindStaticEvents() {
    document.querySelector('nav h1')?.addEventListener('click', () => navigateTo('home'));
    document.querySelector('button[title="設定"]')?.addEventListener('click', openSettingsModal);
    document.getElementById('search-input')?.addEventListener('keydown', event => {
        if (event.key === 'Enter') searchWord();
    });
    document.querySelector('#search-input + button')?.addEventListener('click', searchWord);

    document.getElementById('btn-login')?.addEventListener('click', firebaseLogin);
    document.getElementById('btn-logout')?.addEventListener('click', firebaseLogout);
    document.getElementById('btn-sync')?.addEventListener('click', syncCloudNow);

    const navButtons = document.querySelectorAll('nav .grid button');
    navButtons[0]?.addEventListener('click', () => navigateTo('home'));
    navButtons[1]?.addEventListener('click', () => navigateTo('library'));
    navButtons[2]?.addEventListener('click', () => navigateTo('practice'));

    const resetBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent.includes('重置全部資料'));
    resetBtn?.addEventListener('click', confirmReset);

    const homeCards = document.querySelectorAll('#view-home .cursor-pointer');
    homeCards[0]?.addEventListener('click', () => navigateTo('library'));
    homeCards[1]?.addEventListener('click', () => navigateTo('practice'));

    document.querySelectorAll('button').forEach(btn => {
        if (btn.textContent.includes('返回')) btn.addEventListener('click', () => history.back());
    });

    document.getElementById('btn-edit-folders')?.addEventListener('click', toggleEditMode);
    document.querySelector('#view-library button.bg-indigo-600.w-10')?.addEventListener('click', () => openAddModal());

    const editHintButtons = document.querySelectorAll('#edit-hint button');
    editHintButtons[0]?.addEventListener('click', openNewFolderModal);
    editHintButtons[1]?.addEventListener('click', toggleEditMode);

    document.getElementById('practice-scope')?.addEventListener('change', renderPracticeWordSelection);
    const selectionButtons = document.querySelectorAll('#view-practice .space-x-2 button');
    selectionButtons[0]?.addEventListener('click', () => toggleAllPracticeWords(true));
    selectionButtons[1]?.addEventListener('click', () => toggleAllPracticeWords(false));

    const startButtons = document.querySelectorAll('#view-practice .border-t button');
    startButtons[0]?.addEventListener('click', () => startGame('spelling'));
    startButtons[1]?.addEventListener('click', () => startGame('choice-en-ch'));
    startButtons[2]?.addEventListener('click', () => startGame('choice-ch-en'));

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

    document.getElementById('save-target-folder')?.addEventListener('change', event => onSaveTargetFolderChange(event.currentTarget));
    document.querySelector('#save-target-folder + button')?.addEventListener('click', saveWrongWords);
    document.querySelector('#view-game-result > div > button:last-child')?.addEventListener('click', () => navigateTo('practice'));

    const addButtons = document.querySelectorAll('#add-modal .grid button');
    addButtons[0]?.addEventListener('click', closeAddModal);
    addButtons[1]?.addEventListener('click', saveNewWord);

    const actionButtons = document.querySelectorAll('#folder-action-modal button');
    actionButtons[0]?.addEventListener('click', prepareRenameFolder);
    actionButtons[1]?.addEventListener('click', () => prepareDeleteFolder(false));
    actionButtons[2]?.addEventListener('click', () => prepareDeleteFolder(true));
    actionButtons[3]?.addEventListener('click', closeActionModal);

    const renameButtons = document.querySelectorAll('#rename-modal .grid button');
    renameButtons[0]?.addEventListener('click', () => document.getElementById('rename-modal').classList.add('hidden'));
    renameButtons[1]?.addEventListener('click', executeRename);

    const confirmButtons = document.querySelectorAll('#confirm-modal .grid button');
    confirmButtons[0]?.addEventListener('click', () => document.getElementById('confirm-modal').classList.add('hidden'));
    confirmButtons[1]?.addEventListener('click', executeDelete);

    const newFolderButtons = document.querySelectorAll('#new-folder-modal .grid button');
    newFolderButtons[0]?.addEventListener('click', () => document.getElementById('new-folder-modal').classList.add('hidden'));
    newFolderButtons[1]?.addEventListener('click', confirmNewFolder);

    document.getElementById('settings-bgm-enabled')?.addEventListener('change', event => toggleBgmEnabledFromCheckbox(event.currentTarget.checked));
    document.getElementById('settings-bgm-select')?.addEventListener('change', event => changeBgmTrackFromSelect(event.currentTarget.value));
    document.getElementById('settings-bgm-volume')?.addEventListener('input', event => updateBgmVolumeFromSlider(event.currentTarget.value));
    document.getElementById('settings-speech-volume')?.addEventListener('input', event => updateSpeechVolumeFromSlider(event.currentTarget.value));
    document.querySelector('#settings-modal button')?.addEventListener('click', closeSettingsModal);
}

async function bootstrap() {
    try {
        await loadDefaultWordDatabase();
        resetToDefaultState();
        bindStaticEvents();
        setupAudioSystem();
        setupBgmAutoplayUnlock();

        const page = new URL(window.location).searchParams.get('page') || 'home';
        showView(page);
        history.replaceState({ viewId: page }, '', window.location);

        onAuthStateChanged(auth, async user => {
            authReady = true;
            currentUser = user;
            updateAuthUI(user);
            if (user) {
                try {
                    await loadFromCloud(user);
                    applyBgmSettingsToElement();
                } catch (err) {
                    console.error('載入雲端資料失敗', err);
                    alert('載入雲端資料失敗：' + (err.message || err));
                }
            } else {
                resetToDefaultState();
            }
            rerenderVisibleView();
        });
    } catch (err) {
        console.error(err);
        document.body.innerHTML = '<main class="p-6 text-center text-red-600 font-bold">單字資料載入失敗，請確認 data/lessons JSON 檔案存在。</main>';
    }
}

document.addEventListener('DOMContentLoaded', bootstrap);
