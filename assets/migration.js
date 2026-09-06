/* Schema 5 migration planner. Pure: never fetches, writes, or compares against
 * today's effective words. All uncertain inputs remain in the caller's backup.
 * sources: {root, wordOverrides/customWords/folders/deletedDefaults/hiddenWords:
 * [{id,data}], settings}. Document-path IDs always outrank payload IDs.
 * inputs: {idMap, tagBaseline, legacyCatalog, catalog}; the first three accept
 * the frozen JSON files in migration/ without reshaping their contents. */
(function (root, factory) {
    const api = factory(typeof module === 'object' && module.exports ? require('./word-data.js') : root.WordKingData);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.WordKingMigration = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (wordData) {
    'use strict';

    const SCHEMA_VERSION = 5;
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const copy = value => Array.isArray(value) ? value.map(copy) : object(value)
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) : value;
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const put = (target, key, value) => Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    const unique = values => [...new Set(values)];
    const POS = new Set(['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction',
        'interjection', 'other', 'determiner', 'article', 'numeral', 'auxiliary', 'phrase']);
    const POS_ALIASES = { n: 'noun', v: 'verb', vi: 'verb', vt: 'verb', a: 'adjective', adj: 'adjective', adv: 'adverb',
        pron: 'pronoun', prep: 'preposition', conj: 'conjunction', interj: 'interjection', det: 'determiner',
        art: 'article', num: 'numeral', aux: 'auxiliary', phr: 'phrase' };

    function error(code, message) { return Object.assign(new Error(message), { code }); }
    function validId(id) {
        return typeof id === 'string' && !!id && id === id.trim() && id !== '.' && id !== '..' &&
            !['__proto__', 'prototype', 'constructor'].includes(id) && !/[\/\u0000-\u001f\u007f]/.test(id) &&
            !/^__.*__$/.test(id) && encodeURIComponent(id).replace(/%[0-9A-F]{2}/g, 'x').length <= 1500;
    }
    function strings(value, label) {
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) {
            throw error('invalid-canonical-snapshot', `${label} must be an array of nonempty strings`);
        }
        return unique(value);
    }
    function plain(value, label) {
        if (!object(value) || (Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(Object.getPrototypeOf(value)) !== null)) {
            throw error('invalid-canonical-snapshot', `${label} must be a plain object`);
        }
    }
    function json(value, label) {
        if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))) return value;
        if (Array.isArray(value)) return value.map(item => json(item, label));
        plain(value, label);
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, label)]));
    }
    function fields(raw, custom = false) {
        plain(raw, 'word');
        const allowed = ['english', 'meaning', 'partOfSpeech', 'isWrong', 'folderIds',
            ...(custom ? ['lessonIds'] : ['addedLessonIds', 'removedLessonIds'])];
        if (Object.keys(raw).some(key => !allowed.includes(key))) throw error('invalid-canonical-snapshot', 'Unknown word field');
        const result = {};
        for (const key of ['english', 'meaning']) if (own(raw, key)) {
            if (typeof raw[key] !== 'string') throw error('invalid-canonical-snapshot', `${key} must be a string`);
            if (key === 'english' && !raw[key].trim()) throw error('invalid-canonical-snapshot', 'English must not be empty');
            result[key] = raw[key];
        }
        if (own(raw, 'isWrong')) {
            if (typeof raw.isWrong !== 'boolean') throw error('invalid-canonical-snapshot', 'isWrong must be boolean');
            result.isWrong = raw.isWrong;
        }
        for (const key of allowed.filter(key => key.endsWith('Ids') || key === 'partOfSpeech')) if (own(raw, key)) {
            const values = strings(raw[key], key);
            if (key === 'partOfSpeech' && values.some(value => !POS.has(value))) throw error('invalid-canonical-snapshot', 'Unknown part of speech');
            if (values.length || !['addedLessonIds', 'removedLessonIds', 'folderIds'].includes(key) || custom) result[key] = values;
        }
        if (!custom) {
            const removed = new Set(result.removedLessonIds || []);
            if (result.addedLessonIds) {
                result.addedLessonIds = result.addedLessonIds.filter(id => !removed.has(id));
                if (!result.addedLessonIds.length) delete result.addedLessonIds;
            }
        } else {
            for (const key of allowed) if (!own(result, key)) throw error('invalid-canonical-snapshot', `Custom word missing ${key}`);
        }
        return result;
    }
    function emptySnapshot() { return { userOverrides: {}, customWords: {}, hiddenWordIds: [], userFolders: {}, settings: {} }; }
    function normalizeSnapshot(raw) {
        plain(raw, 'snapshot');
        const result = emptySnapshot();
        if (Object.keys(raw).some(key => !own(result, key))) throw error('invalid-canonical-snapshot', 'Expected canonical snapshot, not effective words');
        for (const key of ['userOverrides', 'customWords', 'userFolders']) {
            const records = raw[key] === undefined ? {} : raw[key];
            plain(records, key);
            for (const [id, value] of Object.entries(records).sort(([a], [b]) => a.localeCompare(b))) {
                if (!validId(id)) throw error('invalid-canonical-snapshot', `Invalid document ID: ${id}`);
                let normalized;
                if (key === 'userFolders') {
                    plain(value, 'folder');
                    if (typeof value.name !== 'string' || !value.name || Object.keys(value).some(field => field !== 'name')) {
                        throw error('invalid-canonical-snapshot', 'Folder requires only a name');
                    }
                    normalized = { name: value.name };
                } else normalized = fields(value, key === 'customWords');
                if (Object.keys(normalized).length) put(result[key], id, normalized);
            }
        }
        result.hiddenWordIds = strings(raw.hiddenWordIds || [], 'hiddenWordIds').sort();
        if (result.hiddenWordIds.some(id => !validId(id))) throw error('invalid-canonical-snapshot', 'Invalid hidden word ID');
        plain(raw.settings || {}, 'settings');
        result.settings = json(raw.settings || {}, 'settings');
        return result;
    }

    function createMigrationPlan(sources = {}, inputs = {}) {
        const root = sources.root || {};
        if (Number(root.schemaVersion) > 5) throw error('unsupported-schema-version', 'A newer client schema is required');
        for (const name of ['wordOverrides', 'customWords', 'folders', 'hiddenWords', 'deletedDefaults']) {
            for (const row of sources[name] || []) if (Number((row.data || row).schemaVersion) > 5) {
                throw error('unsupported-schema-version', `Newer ${name} schema`);
            }
        }
        if (Number(sources.settings?.schemaVersion) > 5) throw error('unsupported-schema-version', 'Newer settings schema');
        const snapshot = emptySnapshot();
        const conflicts = [];
        const report = (source, reason, details = {}) => conflicts.push({ source, reason, ...copy(details) });
        const mapping = inputs.idMap || inputs.mapping || {};
        const aliases = mapping.aliases || mapping;
        const previousAliases = { ...(mapping.previousAliases || {}) };
        // Older clients stored both URL-encoded and decoded document IDs. Alias
        // supersession must recognize both spellings, including empty resets.
        for (const [alias, target] of Object.entries(previousAliases)) {
            try { put(previousAliases, decodeURIComponent(alias), target); } catch {}
        }
        const baseline = inputs.tagBaseline || inputs.baseline || {};
        const tagsById = baseline.legacyTagsById || baseline;
        const catalog = Array.isArray(inputs.catalog) ? inputs.catalog : [];
        const oldCatalog = Array.isArray(inputs.legacyCatalog) ? inputs.legacyCatalog : [];
        const oldById = new Map(oldCatalog.map(word => [word.id, word]));
        const oldByEnglish = new Map(oldCatalog.map(word => [word.english.trim().toLowerCase(), word]));
        for (const [alias, target] of Object.entries(previousAliases)) if (oldById.has(target)) oldById.set(alias, oldById.get(target));
        for (const word of oldCatalog) { try { oldById.set(decodeURIComponent(word.id), word); } catch {} }
        const newIds = new Set([...catalog.map(word => word.id), ...Object.values(aliases).filter(id => typeof id === 'string')]);
        const lessonIds = new Set([...catalog.flatMap(word => word.lessonIds || []), ...Object.values(tagsById).flatMap(value => Array.isArray(value) ? value : [])]);
        const importRoot = !root.migratedToDiffStorageAt;
        function resolve(id) {
            if (typeof id !== 'string') return null;
            if (newIds.has(id) && /^w_[0-9]{6}$/.test(id)) return id;
            const value = own(aliases, id) ? aliases[id] : undefined;
            return typeof value === 'string' && validId(value) ? value : null;
        }
        function rows(name) {
            return (sources[name] || []).map(row => ({ id: row.id, raw: own(row, 'data') ? row.data : row, source: `${name}/${row.id}`, priority: 2 }));
        }
        function safe(source, operation) {
            try { return operation(); } catch (cause) {
                if (cause.code === 'unsupported-schema-version') throw cause;
                report(source, 'invalid-or-unsupported-data', { message: cause.message });
                return undefined;
            }
        }
        function pos(value) {
            const values = typeof value === 'string' ? value.split(/[\s,;/、]+/).filter(Boolean) : value;
            if (!Array.isArray(values) || values.some(item => typeof item !== 'string')) throw new Error('Unrecognized legacy partOfSpeech');
            const normalized = unique(values.map(item => item.toLowerCase().replace(/[().]/g, '')).filter(Boolean)
                .map(item => POS_ALIASES[item] || item));
            if (normalized.some(item => !POS.has(item))) throw new Error('Unrecognized legacy partOfSpeech');
            return normalized;
        }
        const folderNames = new Map();
        function addFolder(id, name, source) {
            if (!validId(id) || typeof name !== 'string' || !name) { report(source, 'invalid-folder'); return; }
            if (own(snapshot.userFolders, id) && snapshot.userFolders[id].name !== name) {
                report(source, 'folder-id-conflict', { id }); return;
            }
            put(snapshot.userFolders, id, { name });
            folderNames.set(name, unique([...(folderNames.get(name) || []), id]));
        }
        for (const row of rows('folders')) safe(row.source, () => addFolder(row.id, row.raw.name || row.id, row.source));
        function folder(name, source) {
            if (own(snapshot.userFolders, name)) return [name];
            if (folderNames.has(name)) {
                const matches = folderNames.get(name);
                if (matches.length > 1) report(source, 'ambiguous-folder-name', { name, folderIds: matches });
                return matches;
            }
            const id = `f_legacy_${encodeURIComponent(name)}`;
            if (!validId(id)) { report(source, 'unrepresentable-folder-name', { name }); return []; }
            if (own(snapshot.userFolders, id) && snapshot.userFolders[id].name !== name) {
                report(source, 'generated-folder-id-conflict', { name, id }); return [];
            }
            addFolder(id, name, source);
            return [id];
        }
        if (importRoot && Array.isArray(root.folders)) root.folders.forEach((value, i) => {
            const name = typeof value === 'string' ? value : value && value.name;
            if (typeof name !== 'string' || !name) report(`root/folders/${i}`, 'invalid-folder');
            else if (!lessonIds.has(name)) folder(name, `root/folders/${i}`);
        });
        function memberships(values, source) {
            const lessons = [], folders = [];
            for (const name of strings(values, 'legacy memberships')) {
                if (['錯題區', '未分類'].includes(name)) continue;
                if (lessonIds.has(name)) {
                    lessons.push(name);
                    if (folderNames.has(name)) {
                        report(source, 'lesson-folder-name-collision', { name });
                        folders.push(...folderNames.get(name));
                    }
                } else folders.push(...folder(name, source));
            }
            return { lessonIds: unique(lessons), folderIds: unique(folders) };
        }
        function parseLegacyMeaning(meaning) {
            const extracted = [];
            const text = meaning.replace(/[（(]([^()（）]+)[）)]/g, (match, label) => {
                try {
                    const values = pos(label);
                    if (!values.length) return match;
                    extracted.push(...values); return '';
                } catch { return match; }
            }).replace(/\s+([;；])/g, '$1').replace(/\s*\/\s*/g, '；').trim();
            return { meaning: text, partOfSpeech: unique(extracted) };
        }
        function oldTags(raw) {
            if (own(raw, 'folderIds')) return raw.folderIds;
            if (own(raw, 'folderId')) return raw.folderId === '' ? [] : [raw.folderId];
            return raw.tags;
        }
        function migrateFields(row, custom) {
            const raw = row.raw;
            if (!object(raw)) throw new Error('Expected a word record');
            if (Number(raw.schemaVersion) > 5) throw error('unsupported-schema-version', 'Newer word schema');
            if (raw.schemaVersion === 5) {
                const clean = Object.fromEntries(Object.entries(raw).filter(([key]) => !['id', 'schemaVersion', 'updatedAt', 'createdAt'].includes(key)));
                return fields(clean, custom);
            }
            const result = {};
            const oldId = own(previousAliases, row.id) ? previousAliases[row.id] : row.id;
            const original = oldById.get(oldId) || oldById.get(row.id);
            for (const key of ['english', 'meaning', 'partOfSpeech', 'isWrong']) if (own(raw, key)) {
                // Only full ROOT words require a frozen-baseline comparison. Existing
                // sparse overrides retain explicit intent, even when public catches up.
                if (!custom && row.priority === 1 && original && own(original, key) && equal(raw[key], original[key])) continue;
                if (key === 'partOfSpeech') result[key] = pos(raw[key]);
                else result[key] = copy(raw[key]);
            }
            if (own(result, 'meaning') && typeof result.meaning === 'string') {
                const parsed = parseLegacyMeaning(result.meaning);
                result.meaning = parsed.meaning;
                // Empty legacy POS fields coexisted with suffix annotations in old UI.
                if (parsed.partOfSpeech.length && (!own(result, 'partOfSpeech') || result.partOfSpeech.length === 0)) {
                    result.partOfSpeech = parsed.partOfSpeech;
                }
            }
            const modern = raw.tagDiffVersion === 2 || raw.schemaVersion === 2 || own(raw, 'addedTags') || own(raw, 'removedTags');
            const legacy = oldTags(raw);
            if (custom) {
                const split = memberships(legacy === undefined ? [] : legacy, row.source);
                const retained = { ...result };
                Object.assign(result, { english: '', meaning: '', partOfSpeech: [], isWrong: false }, retained, split);
                if (own(raw, 'lessonIds')) result.lessonIds = unique([...result.lessonIds, ...strings(raw.lessonIds, 'lessonIds')]);
                if (!own(raw, 'isWrong') && Array.isArray(legacy) && legacy.includes('錯題區')) result.isWrong = true;
            } else if (modern) {
                const added = memberships(raw.addedTags || [], row.source);
                const removed = memberships(raw.removedTags || [], row.source);
                result.addedLessonIds = added.lessonIds;
                result.removedLessonIds = removed.lessonIds;
                result.folderIds = added.folderIds.filter(id => !removed.folderIds.includes(id));
                if (removed.folderIds.length) report(row.source, 'legacy-personal-folder-removals', { folderIds: removed.folderIds });
            } else if (legacy !== undefined) {
                const split = memberships(legacy, row.source);
                result.folderIds = split.folderIds;
                const frozen = own(tagsById, row.id) ? tagsById[row.id] : undefined;
                if (Array.isArray(frozen)) {
                    result.addedLessonIds = split.lessonIds.filter(id => !frozen.includes(id));
                    result.removedLessonIds = frozen.filter(id => lessonIds.has(id) && !split.lessonIds.includes(id));
                } else {
                    report(row.source, 'missing-frozen-tag-baseline', { legacyTags: legacy });
                    result.addedLessonIds = split.lessonIds;
                }
                if (!own(raw, 'isWrong') && legacy.includes('錯題區')) result.isWrong = true;
            }
            if (!custom && own(raw, 'lessonIds') && legacy === undefined && !modern) {
                const desired = strings(raw.lessonIds, 'lessonIds');
                const frozen = tagsById[row.id] || [];
                result.addedLessonIds = desired.filter(id => !frozen.includes(id));
                result.removedLessonIds = frozen.filter(id => !desired.includes(id));
            }
            return fields(result, custom);
        }
        const overrideRows = rows('wordOverrides');
        const customRows = rows('customWords');
        if (importRoot && Array.isArray(root.words)) root.words.forEach((raw, i) => {
            const source = `root/words/${i}`;
            if (!object(raw)) { report(source, 'invalid-word'); return; }
            const id = raw.defaultId || raw.id || oldByEnglish.get(String(raw.english || '').trim().toLowerCase())?.id;
            if (raw.source === 'custom') customRows.push({ id: raw.id || `c_legacy_root_${i}`, raw, source, priority: 1 });
            else if (resolve(id)) overrideRows.push({ id, raw, source, priority: 1 });
            else if (typeof raw.english === 'string' && raw.english.trim()) {
                customRows.push({ id: `c_legacy_root_${i}`, raw, source, priority: 1 });
                if (id) report(source, 'unknown-id-preserved-as-custom', { legacyId: id });
            } else report(source, 'unknown-or-ambiguous-public-id', { legacyId: id || null });
        });
        const groups = new Map();
        for (const row of overrideRows) {
            const id = resolve(row.id);
            if (!id) { report(row.source, 'unknown-or-ambiguous-public-id', { legacyId: row.id }); continue; }
            groups.set(id, [...(groups.get(id) || []), row]);
        }
        function time(raw) {
            const value = raw.updatedAt;
            if (typeof value === 'number') return value;
            if (value && typeof value.toMillis === 'function') return value.toMillis();
            if (value && typeof value.seconds === 'number') return value.seconds * 1000 + (value.nanoseconds || 0) / 1e6;
            const parsed = Date.parse(value);
            return Number.isFinite(parsed) ? parsed : 0;
        }
        for (const [id, all] of groups) {
            const authoritative = all.filter(row => row.raw.schemaVersion === 5 ||
                (row.raw.supersedesLegacyAliases === true && !own(previousAliases, row.id)));
            const candidates = authoritative.length ? authoritative : all;
            const values = candidates.map(row => ({ ...row, value: safe(row.source, () => migrateFields(row, false)) }))
                .filter(row => row.value).sort((a, b) => a.priority - b.priority || time(a.raw) - time(b.raw) || a.source.localeCompare(b.source));
            const result = {};
            const owners = new Map();
            const added = new Set(), removed = new Set(), personalFolders = new Set();
            for (const row of values) {
                const full = !row.raw.tagDiffVersion && row.raw.schemaVersion !== 2 && oldTags(row.raw) !== undefined;
                if (full) {
                    const frozen = tagsById[row.id] || [];
                    const desired = memberships(oldTags(row.raw), row.source).lessonIds;
                    frozen.filter(id => desired.includes(id)).forEach(id => { added.delete(id); removed.delete(id); });
                    // A newer full snapshot replaces personal memberships; sparse diffs combine.
                    personalFolders.clear();
                }
                (row.value.addedLessonIds || []).forEach(id => { removed.delete(id); added.add(id); });
                (row.value.removedLessonIds || []).forEach(id => { added.delete(id); removed.add(id); });
                (row.value.folderIds || []).forEach(id => personalFolders.add(id));
                for (const [key, value] of Object.entries(row.value)) {
                    if (['addedLessonIds','removedLessonIds','folderIds'].includes(key)) continue;
                    const prior = owners.get(key);
                    if (prior && !equal(result[key], value)) report(row.source, 'override-field-conflict', { publicId: id, field: key, otherSource: prior.source });
                    put(result, key, copy(value)); owners.set(key, row);
                }
            }
            if (added.size) result.addedLessonIds = [...added];
            if (removed.size) result.removedLessonIds = [...removed];
            if (personalFolders.size) result.folderIds = [...personalFolders];
            if (authoritative.length && all.length > candidates.length) report(`wordOverrides/${id}`, 'legacy-aliases-superseded', { sources: all.map(row => row.source) });
            if (Object.keys(result).length) put(snapshot.userOverrides, id, fields(result));
        }
        for (const row of customRows.sort((a, b) => a.priority - b.priority || a.source.localeCompare(b.source))) {
            if (!validId(row.id)) { report(row.source, 'invalid-custom-id'); continue; }
            if (row.id.startsWith('w_')) { report(row.source, 'reserved-custom-id-remapped', { oldId: row.id }); row.id = `c_migrated_${row.id}`; }
            const value = safe(row.source, () => migrateFields(row, true));
            if (!value) continue;
            if (own(snapshot.customWords, row.id)) report(row.source, 'custom-id-conflict', { id: row.id });
            put(snapshot.customWords, row.id, value);
        }
        const hidden = new Map();
        if (importRoot && Array.isArray(root.deletedDefaults)) root.deletedDefaults.forEach((id, i) => {
            const resolved = resolve(id);
            if (resolved) hidden.set(resolved, true);
            else report(`root/deletedDefaults/${i}`, 'unknown-hidden-id', { legacyId: id });
        });
        const deleted = new Map();
        for (const row of rows('deletedDefaults')) {
            const id = resolve(row.id);
            if (!id) { report(row.source, 'unknown-hidden-id', { legacyId: row.id }); continue; }
            deleted.set(id, [...(deleted.get(id) || []), row]);
        }
        for (const [id, all] of deleted) {
            const visible = all.some(row => row.raw.deleted === false);
            if (visible && all.some(row => row.raw.deleted !== false)) report(`deletedDefaults/${id}`, 'hidden-alias-conflict-visible-wins', { sources: all.map(row => row.source) });
            hidden.set(id, !visible);
        }
        for (const row of rows('hiddenWords')) {
            const id = resolve(row.id);
            if (id) hidden.set(id, true);
            else report(row.source, 'unknown-hidden-id', { legacyId: row.id });
        }
        snapshot.hiddenWordIds = [...hidden].filter(([, value]) => value).map(([id]) => id);
        const settings = { ...(importRoot && object(root.settings) ? root.settings : {}), ...(sources.settings || {}) };
        delete settings.schemaVersion; delete settings.updatedAt; delete settings.createdAt;
        if (own(settings, 'deletedLessonIds')) {
            if (Array.isArray(settings.deletedLessonIds)) settings.hiddenLessonIds = unique([...(settings.hiddenLessonIds || []), ...settings.deletedLessonIds]);
            else report('settings/main', 'invalid-deleted-lesson-ids');
            delete settings.deletedLessonIds;
        }
        snapshot.settings = safe('settings/main', () => json(settings, 'settings')) || {};
        // Conflicting public renames cannot create two entities with one spelling.
        // Retain the disputed spelling in recovery; keep all other personal fields.
        for (let pass = 0; pass < catalog.length; pass += 1) {
            const seen = new Map(); let changed = false;
            for (const word of catalog) {
                const key = (snapshot.userOverrides[word.id]?.english ?? word.english).trim().toLowerCase();
                if (seen.has(key)) {
                    for (const id of [seen.get(key), word.id]) if (own(snapshot.userOverrides[id] || {}, 'english')) {
                        report(`wordOverrides/${id}`, 'conflicting-english-retained-in-backup', { english: snapshot.userOverrides[id].english });
                        delete snapshot.userOverrides[id].english; changed = true;
                    }
                } else seen.set(key, word.id);
            }
            if (!changed) break;
        }
        const byEnglish = new Map();
        const mergeText = (...texts) => unique(texts.filter(Boolean).flatMap(text => text.split(/[;；]/).map(part => part.trim()).filter(Boolean))).join('；');
        for (const word of catalog) {
            const over = snapshot.userOverrides[word.id] || {};
            byEnglish.set((over.english ?? word.english).trim().toLowerCase(), { id: word.id, public: true, word: {
                ...word, ...Object.fromEntries(Object.entries(over).filter(([key]) => ['english','meaning','partOfSpeech','isWrong'].includes(key))),
                lessonIds: unique([...word.lessonIds, ...(over.addedLessonIds || [])]).filter(id => !(over.removedLessonIds || []).includes(id)),
                folderIds: over.folderIds || []
            } });
        }
        for (const [id, word] of Object.entries(snapshot.customWords)) {
            const key = word.english.trim().toLowerCase();
            const existing = byEnglish.get(key);
            if (!existing) { byEnglish.set(key, { id, word, public: false }); continue; }
            const merged = { ...existing.word, meaning: mergeText(existing.word.meaning, word.meaning),
                partOfSpeech: unique([...(existing.word.partOfSpeech || []), ...word.partOfSpeech]),
                lessonIds: unique([...existing.word.lessonIds, ...word.lessonIds]), folderIds: unique([...existing.word.folderIds, ...word.folderIds]),
                isWrong: !!existing.word.isWrong || word.isWrong };
            if (existing.public) {
                const base = catalog.find(item => item.id === existing.id);
                const override = { ...(snapshot.userOverrides[existing.id] || {}) };
                for (const field of ['meaning','partOfSpeech','isWrong']) if (!equal(merged[field], base[field])) override[field] = merged[field];
                override.addedLessonIds = unique([...(override.addedLessonIds || []), ...merged.lessonIds.filter(id => !base.lessonIds.includes(id))]);
                override.removedLessonIds = (override.removedLessonIds || []).filter(id => !word.lessonIds.includes(id));
                override.folderIds = merged.folderIds;
                snapshot.userOverrides[existing.id] = fields(override);
                // A previously visible custom word must remain visible after its identity is coalesced.
                snapshot.hiddenWordIds = snapshot.hiddenWordIds.filter(id => id !== existing.id);
            } else snapshot.customWords[existing.id] = merged;
            delete snapshot.customWords[id]; existing.word = merged;
            report(`customWords/${id}`, 'same-english-merged', { targetId: existing.id, englishKey: key });
        }
        // Validate the complete result using the same model that the UI will
        // instantiate, before Persistence can acquire a lease or write anything.
        const canonical = wordData.createUserWordState(catalog, normalizeSnapshot(snapshot)).exportState();
        return { snapshot: normalizeSnapshot(canonical), conflicts };
    }

    return Object.freeze({ SCHEMA_VERSION, emptySnapshot, normalizeSnapshot, createMigrationPlan, validId });
});
