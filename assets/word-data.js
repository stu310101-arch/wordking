/* Schema v5. Pure catalog and per-account state; storage and migration live elsewhere. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WordKingData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const SCHEMA_VERSION = 5;
    const PARTS_OF_SPEECH = Object.freeze(['noun', 'verb', 'adjective', 'adverb', 'pronoun',
        'preposition', 'conjunction', 'interjection', 'other', 'determiner', 'article', 'numeral', 'auxiliary', 'phrase']);
    const FIELD_NAMES = Object.freeze(['english', 'meaning', 'partOfSpeech', 'isWrong']);
    const OVERRIDE_FIELDS = Object.freeze([...FIELD_NAMES, 'addedLessonIds', 'removedLessonIds', 'folderIds']);
    const CUSTOM_FIELDS = Object.freeze([...FIELD_NAMES, 'lessonIds', 'folderIds']);
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const englishKey = value => value.trim().toLowerCase();
    const unsafeKey = key => ['__proto__', 'prototype', 'constructor'].includes(key);
    function fail(message, code = 'INVALID_DATA') {
        const error = new Error(message);
        error.code = code;
        throw error;
    }
    function object(value, label) {
        if (!value || Object.prototype.toString.call(value) !== '[object Object]') fail(`${label} must be an object.`);
        return value;
    }
    // Detached JSON copies prevent both caller mutation and sharing across accounts.
    function copy(value) {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (Array.isArray(value)) return Array.from(value, copy);
        object(value, 'JSON value');
        return Object.fromEntries(Object.entries(value).map(([key, item]) => {
            if (unsafeKey(key)) fail(`Unsafe key: ${key}`);
            return [key, copy(item)];
        }));
    }
    function fields(value, allowed, label) {
        object(value, label);
        for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown ${label} field: ${key}`);
    }
    function identifier(value, label = 'ID') {
        if (typeof value !== 'string' || !value || value !== value.trim() ||
            /[\/\u0000-\u001f\u007f]/.test(value) || ['.', '..'].includes(value) || unsafeKey(value)) fail(`Invalid ${label}: ${value}`);
        return value;
    }
    function publicId(value) {
        if (typeof value !== 'string' || !/^w_\d{6}$/.test(value) || value === 'w_000000') fail(`Invalid public ID: ${value}`);
        return value;
    }
    function customId(value) {
        identifier(value, 'custom ID');
        if (value.startsWith('w_')) fail(`Reserved public ID namespace: ${value}`);
        return value;
    }
    function stringList(value, label) {
        if (!Array.isArray(value)) fail(`${label} must be an array.`);
        return [...new Set(Array.from(value, item => identifier(item, label)))];
    }
    function normalizePartOfSpeech(value) {
        const pos = stringList(value, 'partOfSpeech');
        if (pos.some(item => !PARTS_OF_SPEECH.includes(item))) fail('partOfSpeech must contain canonical values.');
        return PARTS_OF_SPEECH.filter(item => pos.includes(item));
    }
    function scalar(field, value) {
        if (field === 'english') {
            if (typeof value !== 'string' || !value.trim()) fail('English must be a nonempty string.');
            return value.trim();
        }
        if (field === 'meaning') {
            if (typeof value !== 'string') fail('Meaning must be a string.');
            return value;
        }
        if (field === 'isWrong') {
            if (typeof value !== 'boolean') fail('isWrong must be a boolean.');
            return value;
        }
        return normalizePartOfSpeech(value);
    }
    function normalizeCatalog(rawWords) {
        if (!Array.isArray(rawWords)) fail('Public catalog must be an array.');
        const ids = new Set(), englishKeys = new Set();
        return Array.from(rawWords, raw => {
            fields(raw, ['id', ...FIELD_NAMES, 'lessonIds'], 'catalog');
            const id = publicId(raw.id);
            if (ids.has(id)) fail(`Duplicate public ID: ${id}`);
            const english = scalar('english', raw.english);
            if (englishKeys.has(englishKey(english))) fail(`Duplicate public English: ${english}`);
            const partOfSpeech = normalizePartOfSpeech(raw.partOfSpeech);
            const lessonIds = stringList(raw.lessonIds, 'lessonIds');
            if (new Set(raw.partOfSpeech).size !== raw.partOfSpeech.length || !equal(lessonIds, raw.lessonIds)) {
                fail(`Duplicate catalog memberships or partOfSpeech: ${id}`);
            }
            ids.add(id);
            englishKeys.add(englishKey(english));
            return { id, english, meaning: scalar('meaning', raw.meaning), partOfSpeech, lessonIds,
                isWrong: own(raw, 'isWrong') ? scalar('isWrong', raw.isWrong) : false };
        });
    }
    function normalizeOverride(raw) {
        fields(raw, OVERRIDE_FIELDS, 'override');
        const result = {};
        for (const field of Object.keys(raw)) {
            const value = FIELD_NAMES.includes(field) ? scalar(field, raw[field]) : stringList(raw[field], field);
            if (FIELD_NAMES.includes(field) || value.length) result[field] = value;
        }
        if ((result.addedLessonIds || []).some(id => (result.removedLessonIds || []).includes(id))) {
            fail('Lesson additions and removals must not overlap.');
        }
        return result;
    }
    function normalizeCustom(raw) {
        fields(raw, CUSTOM_FIELDS, 'custom word');
        return { english: scalar('english', raw.english), meaning: scalar('meaning', own(raw, 'meaning') ? raw.meaning : ''),
            partOfSpeech: normalizePartOfSpeech(own(raw, 'partOfSpeech') ? raw.partOfSpeech : []),
            lessonIds: stringList(own(raw, 'lessonIds') ? raw.lessonIds : [], 'lessonIds'),
            folderIds: stringList(own(raw, 'folderIds') ? raw.folderIds : [], 'folderIds'),
            isWrong: scalar('isWrong', own(raw, 'isWrong') ? raw.isWrong : false) };
    }
    function normalizeFolder(raw) {
        fields(raw, ['name'], 'folder');
        if (typeof raw.name !== 'string' || !raw.name.trim()) fail('Folder name must be a nonempty string.');
        return { name: raw.name.trim() };
    }
    /**
     * One instance belongs to one account. Initial/export shape:
     * {userOverrides:{id:sparseFields}, customWords:{id:fullFields},
     *  hiddenWordIds:[], userFolders:{id:{name}}, settings:{}}
     * No IDs/source or persistence metadata inside stored word documents.
     * Orphaned public references are retained. Imports/catalog refreshes reject
     * English collisions without writing, deleting, or renaming the source data.
     */
    function createUserWordState(catalog, initial = {}) {
        let publicWords = new Map(normalizeCatalog(catalog).map(word => [word.id, word]));
        const userOverrides = new Map(), customWords = new Map(), userFolders = new Map();
        const hiddenWordIds = new Set();
        fields(initial, ['userOverrides', 'customWords', 'hiddenWordIds', 'userFolders', 'settings'], 'state');
        const initialField = (key, fallback) => own(initial, key) ? initial[key] : fallback;
        for (const [id, raw] of Object.entries(object(initialField('userOverrides', {}), 'userOverrides'))) {
            publicId(id);
            const override = normalizeOverride(raw);
            // Preserve unpatched scalar intent when the public value has caught up.
            if (Object.keys(override).length) userOverrides.set(id, override);
        }
        for (const [id, raw] of Object.entries(object(initialField('customWords', {}), 'customWords'))) {
            customWords.set(customId(id), normalizeCustom(raw));
        }
        for (const id of stringList(initialField('hiddenWordIds', []), 'hiddenWordIds')) hiddenWordIds.add(publicId(id));
        for (const [id, raw] of Object.entries(object(initialField('userFolders', {}), 'userFolders'))) {
            userFolders.set(identifier(id), normalizeFolder(raw));
        }
        let settings = copy(object(initialField('settings', {}), 'settings'));
        function requirePublic(id) {
            const word = publicWords.get(id);
            if (!word) fail(`Unknown public word: ${id}`, 'WORD_NOT_FOUND');
            return word;
        }
        function requireCustom(id) {
            if (!customWords.has(id)) fail(`Unknown custom word: ${id}`, 'WORD_NOT_FOUND');
            return customWords.get(id);
        }
        function effectivePublic(base, override = {}) {
            const result = { id: base.id, source: 'public' };
            for (const field of FIELD_NAMES) result[field] = copy(own(override, field) ? override[field] : base[field]);
            const removed = new Set(override.removedLessonIds || []);
            result.lessonIds = [...new Set([...base.lessonIds, ...(override.addedLessonIds || [])])].filter(id => !removed.has(id));
            result.folderIds = [...(override.folderIds || [])];
            return result;
        }
        function getPublicWord(id) { return publicWords.has(id) ? copy(publicWords.get(id)) : null; }
        function getWordOverride(id) { return copy(userOverrides.get(id) || {}); }
        function getEffectiveWord(id, { includeHidden = true } = {}) {
            if (publicWords.has(id)) {
                if (!includeHidden && hiddenWordIds.has(id)) return null;
                return effectivePublic(publicWords.get(id), userOverrides.get(id));
            }
            return customWords.has(id) ? { id, source: 'custom', ...copy(customWords.get(id)) } : null;
        }
        function deriveEffectiveWords({ includeHidden = false } = {}) {
            return [...publicWords.keys(), ...customWords.keys()]
                .map(id => getEffectiveWord(id, { includeHidden })).filter(Boolean);
        }
        function getEnglishConflicts() {
            const groups = new Map();
            for (const word of deriveEffectiveWords({ includeHidden: true })) {
                const key = englishKey(word.english);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(word.id);
            }
            return [...groups].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ englishKey: key, wordIds: ids }));
        }
        function checkEnglish(id, english) {
            const before = getEffectiveWord(id, { includeHidden: true });
            // Existing imported conflicts must not prevent unrelated edits.
            if (before && englishKey(before.english) === englishKey(english)) return;
            const conflict = deriveEffectiveWords({ includeHidden: true })
                .find(word => word.id !== id && englishKey(word.english) === englishKey(english));
            if (conflict) fail(`Duplicate effective English: ${english} (${conflict.id})`, 'DUPLICATE_ENGLISH');
        }
        function saveOverride(id, override) {
            if (Object.keys(override).length) userOverrides.set(id, override);
            else userOverrides.delete(id);
            return getWordOverride(id);
        }
        function updateWordOverride(id, patch) {
            const base = requirePublic(id);
            fields(patch, OVERRIDE_FIELDS, 'override');
            const next = getWordOverride(id);
            for (const field of Object.keys(patch)) {
                const value = FIELD_NAMES.includes(field) ? scalar(field, patch[field]) : stringList(patch[field], field);
                if (FIELD_NAMES.includes(field) ? equal(value, base[field]) : !value.length) delete next[field];
                else next[field] = value;
            }
            const normalized = normalizeOverride(next);
            checkEnglish(id, effectivePublic(base, normalized).english);
            return saveOverride(id, normalized);
        }
        function clearWordOverrideField(id, field) {
            const base = requirePublic(id);
            if (!OVERRIDE_FIELDS.includes(field)) fail(`Unknown override field: ${field}`);
            const next = getWordOverride(id);
            delete next[field];
            checkEnglish(id, effectivePublic(base, next).english);
            return saveOverride(id, next);
        }
        function clearWordOverride(id) {
            const base = requirePublic(id);
            checkEnglish(id, base.english);
            return saveOverride(id, {});
        }
        function setWordLessons(id, lessonIds) {
            const desired = stringList(lessonIds, 'lessonIds');
            if (customWords.has(id)) return updateCustomWord(id, { lessonIds: desired });
            const base = requirePublic(id), override = getWordOverride(id);
            const before = effectivePublic(base, override).lessonIds;
            const added = new Set(override.addedLessonIds || []), removed = new Set(override.removedLessonIds || []);
            // Keep dormant diffs unless this call explicitly changes that membership.
            for (const lesson of before.filter(value => !desired.includes(value))) {
                added.delete(lesson);
                if (base.lessonIds.includes(lesson)) removed.add(lesson);
            }
            for (const lesson of desired.filter(value => !before.includes(value))) {
                removed.delete(lesson);
                if (!base.lessonIds.includes(lesson)) added.add(lesson);
            }
            return updateWordOverride(id, { addedLessonIds: [...added], removedLessonIds: [...removed] });
        }
        function clearLessonChange(id, lessonId) {
            requirePublic(id);
            identifier(lessonId, 'lesson ID');
            const override = getWordOverride(id);
            return updateWordOverride(id, {
                addedLessonIds: (override.addedLessonIds || []).filter(value => value !== lessonId),
                removedLessonIds: (override.removedLessonIds || []).filter(value => value !== lessonId)
            });
        }
        function setWordFolders(id, folderIds) {
            return customWords.has(id) ? updateCustomWord(id, { folderIds }) : updateWordOverride(id, { folderIds });
        }
        function hidePublicWord(id) { requirePublic(id); hiddenWordIds.add(id); }
        function restorePublicWord(id) { requirePublic(id); hiddenWordIds.delete(id); }
        function restoreAllHidden() { hiddenWordIds.clear(); }
        function createCustomWord(id, fields) {
            if (id && typeof id === 'object') {
                const { id: suppliedId, ...suppliedFields } = id;
                id = suppliedId;
                fields = suppliedFields;
            }
            customId(id);
            if (customWords.has(id)) fail(`Duplicate custom ID: ${id}`, 'DUPLICATE_ID');
            const word = normalizeCustom(fields);
            checkEnglish(id, word.english);
            customWords.set(id, word);
            return getEffectiveWord(id);
        }
        function updateCustomWord(id, patch) {
            const before = requireCustom(id);
            fields(patch, CUSTOM_FIELDS, 'custom word');
            const word = normalizeCustom({ ...before, ...patch });
            checkEnglish(id, word.english);
            customWords.set(id, word);
            return getEffectiveWord(id);
        }
        function deleteCustomWord(id) { customId(id); return customWords.delete(id); }
        function getUserFolder(id) { return userFolders.has(id) ? copy(userFolders.get(id)) : null; }
        function getUserFolders() { return copy(Object.fromEntries(userFolders)); }
        function setFolder(id, folder) {
            identifier(id, 'folder ID');
            userFolders.set(id, normalizeFolder(folder));
            return getUserFolder(id);
        }
        function createUserFolder(id, folder) {
            if (userFolders.has(id)) fail(`Duplicate folder ID: ${id}`, 'DUPLICATE_ID');
            return setFolder(id, folder);
        }
        function updateUserFolder(id, patch) {
            if (!userFolders.has(id)) fail(`Unknown folder: ${id}`, 'FOLDER_NOT_FOUND');
            fields(patch, ['name'], 'folder');
            return setFolder(id, { ...userFolders.get(id), ...patch });
        }
        function deleteFolder(id) {
            identifier(id, 'folder ID');
            const existed = userFolders.delete(id);
            for (const [wordId, raw] of userOverrides) {
                if (!(raw.folderIds || []).includes(id)) continue;
                const next = copy(raw);
                next.folderIds = next.folderIds.filter(value => value !== id);
                if (!next.folderIds.length) delete next.folderIds;
                saveOverride(wordId, next);
            }
            for (const [wordId, raw] of customWords) {
                if (raw.folderIds.includes(id)) customWords.set(wordId, { ...raw, folderIds: raw.folderIds.filter(value => value !== id) });
            }
            return existed;
        }
        function getSettings() { return copy(settings); }
        function setSettings(patch) {
            settings = { ...settings, ...copy(object(patch, 'settings patch')) };
            return getSettings();
        }
        function clearSetting(key) {
            identifier(key, 'setting key');
            delete settings[key];
            return getSettings();
        }
        function setPublicCatalog(nextCatalog) {
            const next = normalizeCatalog(nextCatalog);
            const previous = publicWords;
            publicWords = new Map(next.map(word => [word.id, word]));
            if (getEnglishConflicts().length) { publicWords = previous; fail('Catalog update conflicts with personal English; preserve sources for review.', 'DUPLICATE_ENGLISH'); }
        }
        function exportState() {
            return copy({ userOverrides: Object.fromEntries(userOverrides), customWords: Object.fromEntries(customWords),
                hiddenWordIds: [...hiddenWordIds], userFolders: Object.fromEntries(userFolders), settings });
        }
        function reset(options = {}) {
            fields(options, ['settings'], 'reset options');
            const nextSettings = copy(object(own(options, 'settings') ? options.settings : {}, 'settings'));
            userOverrides.clear();
            customWords.clear();
            hiddenWordIds.clear();
            userFolders.clear();
            settings = nextSettings;
            return exportState();
        }
        if (getEnglishConflicts().length) fail('Duplicate effective English in stored account data; migration or recovery is required.', 'DUPLICATE_ENGLISH');
        return Object.freeze({ getPublicWord, getWordOverride, getEffectiveWord, deriveEffectiveWords,
            getEnglishConflicts, setPublicCatalog, updateWordOverride, clearWordOverrideField, clearWordOverride,
            setWordLessons, clearLessonChange, setWordFolders, hidePublicWord, restorePublicWord, restoreAllHidden,
            createCustomWord, updateCustomWord, deleteCustomWord, getUserFolder, getUserFolders,
            setFolder, deleteFolder, createUserFolder, updateUserFolder, deleteUserFolder: deleteFolder,
            getSettings, setSettings, updateSettings: setSettings, clearSetting, reset, exportState });
    }
    return Object.freeze({ SCHEMA_VERSION, PARTS_OF_SPEECH, FIELD_NAMES, OVERRIDE_FIELDS,
        normalizePartOfSpeech, normalizeCatalog, createUserWordState });
});
