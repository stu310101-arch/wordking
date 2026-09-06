/* Shared catalog + private differences. No Firebase, DOM, or generated identity. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.WordKingData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const FIELD_NAMES = Object.freeze(['english', 'meaning', 'partOfSpeech', 'isWrong']);
    const LEGACY_TAG_FIELDS = ['folderIds', 'folderId', 'tags'];
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
    const copy = value => Array.isArray(value)
        ? value.map(copy)
        : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]))
            : value;
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    function normalizeTags(values) {
        return Array.from(new Set((Array.isArray(values) ? values : [])
            .filter(value => typeof value === 'string')
            .map(value => value.trim())
            .filter(value => value && value !== '錯題區' && value !== '未分類' && !/^[a-z]$/i.test(value))));
    }

    function baseTags(word) {
        return normalizeTags(Array.isArray(word.tags) ? word.tags : word.folderIds);
    }

    function legacyTags(word) {
        if (own(word, 'folderIds')) return normalizeTags(word.folderIds);
        if (own(word, 'folderId')) return normalizeTags([word.folderId]);
        return normalizeTags(word.tags);
    }

    function normalizeCatalog(rawWords) {
        if (!Array.isArray(rawWords)) throw new Error('公用單字庫必須是單字陣列。');
        const ids = new Set();
        const englishKeys = new Set();
        return rawWords.map((raw, index) => {
            if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id.trim()) {
                throw new Error(`公用單字第 ${index + 1} 筆缺少固定 ID。`);
            }
            if (raw.id.includes('/') || raw.id === '.' || raw.id === '..') throw new Error(`公用單字 ID 不合法：${raw.id}`);
            if (ids.has(raw.id)) throw new Error(`公用單字 ID 重複：${raw.id}`);
            if (typeof raw.english !== 'string' || !raw.english.trim()) throw new Error(`公用單字 ${raw.id} 缺少英文。`);
            const englishKey = raw.english.trim().toLowerCase();
            if (englishKeys.has(englishKey)) throw new Error(`公用單字英文重複：${raw.english}`);
            if (typeof raw.meaning !== 'string' || !Array.isArray(raw.tags)) throw new Error(`公用單字 ${raw.id} 的解釋或標籤格式不正確。`);
            const tags = normalizeTags(raw.tags);
            if (tags.length !== raw.tags.length || tags.some((tag, i) => tag !== raw.tags[i])) throw new Error(`公用單字 ${raw.id} 包含重複或無效標籤。`);
            ids.add(raw.id);
            englishKeys.add(englishKey);
            return {
                ...copy(raw),
                id: raw.id,
                defaultId: raw.id,
                source: 'default',
                tags,
                folderIds: [...tags],
                folderId: tags[0] || '',
                lessonIds: [...tags],
                partOfSpeech: own(raw, 'partOfSpeech') ? raw.partOfSpeech : '',
                isWrong: own(raw, 'isWrong') ? raw.isWrong : false
            };
        });
    }

    function resolveId(id, aliasData = {}) {
        const aliases = aliasData.aliases || aliasData;
        let resolved = id;
        const seen = new Set();
        while (own(aliases, resolved)) {
            if (seen.has(resolved)) throw new Error(`單字 ID 別名形成循環：${id}`);
            seen.add(resolved);
            resolved = aliases[resolved];
        }
        return resolved;
    }

    // A malformed overlap always resolves to removal; writing helpers prevent it.
    function normalizeTagChanges(override = {}) {
        const removedTags = normalizeTags(override.removedTags);
        const removed = new Set(removedTags);
        return { addedTags: normalizeTags(override.addedTags).filter(tag => !removed.has(tag)), removedTags };
    }

    function mergeTags(publicTags, addedTags = [], removedTags = []) {
        const removed = new Set(normalizeTags(removedTags));
        return normalizeTags([...normalizeTags(publicTags), ...normalizeTags(addedTags)])
            .filter(tag => !removed.has(tag));
    }

    function migrateOverride(base, rawOverride = {}, options = {}) {
        const override = copy(rawOverride);
        const modern = override.tagDiffVersion === 2 || override.schemaVersion === 2 ||
            own(override, 'addedTags') || own(override, 'removedTags');
        if (!modern && LEGACY_TAG_FIELDS.some(field => own(override, field))) {
            // This frozen baseline makes the conversion repeatable after catalog updates.
            // Old full snapshots cannot prove whether an absent tag was intentionally removed.
            const baseline = normalizeTags(options.legacyBaseTags || baseTags(base));
            const desired = legacyTags(override);
            const desiredSet = new Set(desired);
            const baselineSet = new Set(baseline);
            override.addedTags = desired.filter(tag => !baselineSet.has(tag));
            override.removedTags = baseline.filter(tag => !desiredSet.has(tag));
            override.legacyTagBackup = {
                ...(override.legacyTagBackup || {}),
                original: Object.fromEntries(LEGACY_TAG_FIELDS.filter(field => own(rawOverride, field))
                    .map(field => [field, copy(rawOverride[field])])),
                baseTagsAtMigration: baseline,
                policy: 'preserve-snapshot-against-frozen-baseline',
                intentUncertain: true
            };
        }
        if (!modern && !own(override, 'isWrong')) {
            const legacyValues = [override.folderId, ...(Array.isArray(override.folderIds) ? override.folderIds : []),
                ...(Array.isArray(override.tags) ? override.tags : [])];
            if (legacyValues.includes('錯題區')) override.isWrong = true;
        }
        return { ...override, ...normalizeTagChanges(override), schemaVersion: 2, tagDiffVersion: 2 };
    }

    function applyOverride(base, rawOverride = {}) {
        const override = migrateOverride(base, rawOverride);
        const result = copy(base);
        FIELD_NAMES.forEach(field => {
            if (own(override, field)) result[field] = copy(override[field]);
        });
        const tags = mergeTags(baseTags(base), override.addedTags, override.removedTags);
        return {
            ...result,
            id: base.defaultId || base.id,
            defaultId: base.defaultId || base.id,
            source: 'default',
            tags,
            folderIds: [...tags],
            folderId: tags[0] || '',
            lessonIds: [...baseTags(base)]
        };
    }

    function updateOverride(base, rawOverride = {}, editedWord = {}, previousWord) {
        const override = migrateOverride(base, rawOverride);
        const before = previousWord || applyOverride(base, override);
        const result = copy(override);
        FIELD_NAMES.forEach(field => {
            if (!own(editedWord, field) || equal(editedWord[field], before[field])) return;
            if (equal(editedWord[field], base[field])) delete result[field];
            else result[field] = copy(editedWord[field]);
        });
        const beforeTags = normalizeTags(own(before, 'folderIds') ? before.folderIds : before.tags);
        const afterTags = own(editedWord, 'folderIds') ? normalizeTags(editedWord.folderIds)
            : own(editedWord, 'tags') ? normalizeTags(editedWord.tags) : beforeTags;
        const previousSet = new Set(beforeTags);
        const nextSet = new Set(afterTags);
        const publicSet = new Set(baseTags(base));
        const added = new Set(override.addedTags);
        const removed = new Set(override.removedTags);
        beforeTags.filter(tag => !nextSet.has(tag)).forEach(tag => {
            added.delete(tag);
            if (publicSet.has(tag)) removed.add(tag);
        });
        afterTags.filter(tag => !previousSet.has(tag)).forEach(tag => {
            removed.delete(tag);
            if (!publicSet.has(tag)) added.add(tag);
        });
        return { ...result, ...normalizeTagChanges({ addedTags: [...added], removedTags: [...removed] }) };
    }

    function clearOverrideField(rawOverride, field) {
        const result = copy(rawOverride || {});
        if (FIELD_NAMES.includes(field)) delete result[field];
        return result;
    }

    function clearTagChange(rawOverride, tag) {
        const result = { ...copy(rawOverride || {}), ...normalizeTagChanges(rawOverride) };
        result.addedTags = result.addedTags.filter(value => value !== tag);
        result.removedTags = result.removedTags.filter(value => value !== tag);
        return result;
    }

    function timestampValue(value) {
        if (typeof value === 'number') return value;
        if (value && typeof value.toMillis === 'function') return value.toMillis();
        if (value && typeof value === 'object') return (value.seconds || value._seconds || 0) * 1000 + (value.nanoseconds || value._nanoseconds || 0) / 1e6;
        const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function coalesceOverrides(base, rawOverrides = [], aliasData = {}) {
        const id = base.defaultId || base.id;
        const records = rawOverrides.filter(record => record && resolveId(record.id, aliasData) === id);
        // Retained legacy documents must never resurrect an override after reset.
        const authoritative = records.find(record => record.id === id && record.schemaVersion === 2 && record.supersedesLegacyAliases === true);
        if (authoritative) return migrateOverride(base, authoritative);
        const sorted = [...records].sort((a, b) => timestampValue(a.updatedAt) - timestampValue(b.updatedAt) ||
            Number(a.id === id) - Number(b.id === id) || String(a.id).localeCompare(String(b.id)));
        let result = migrateOverride(base, {});
        const backups = [];
        sorted.forEach(record => {
            const migrated = migrateOverride(base, record, {
                legacyBaseTags: aliasData.legacyTagsById && aliasData.legacyTagsById[record.id]
            });
            FIELD_NAMES.forEach(field => { if (own(migrated, field)) result[field] = copy(migrated[field]); });
            const added = new Set(result.addedTags);
            const removed = new Set(result.removedTags);
            if (migrated.legacyTagBackup && record.tagDiffVersion !== 2 && record.schemaVersion !== 2 &&
                LEGACY_TAG_FIELDS.some(field => own(record, field))) {
                // A newer full snapshot explicitly includes its present tags, so it can
                // cancel an older alias record's removal of the same historical tag.
                const desired = new Set(legacyTags(record));
                migrated.legacyTagBackup.baseTagsAtMigration.forEach(tag => {
                    if (desired.has(tag)) { removed.delete(tag); added.delete(tag); }
                });
            }
            migrated.addedTags.forEach(tag => { removed.delete(tag); added.add(tag); });
            migrated.removedTags.forEach(tag => { added.delete(tag); removed.add(tag); });
            result = { ...result, addedTags: [...added], removedTags: [...removed] };
            if (migrated.legacyTagBackup) result.legacyTagBackup = copy(migrated.legacyTagBackup);
            if (record.id !== id || records.length > 1) backups.push(copy(record));
            else LEGACY_TAG_FIELDS.forEach(field => { if (own(record, field)) result[field] = copy(record[field]); });
        });
        if (backups.length) result.aliasMigrationBackup = backups;
        if (records.length === 1) result.migrationBackup = copy(records[0].migrationBackup || records[0]);
        return { ...result, id, supersedesLegacyAliases: true };
    }

    function hasPersonalChanges(override = {}) {
        return FIELD_NAMES.some(field => own(override, field)) ||
            normalizeTags(override.addedTags).length > 0 || normalizeTags(override.removedTags).length > 0;
    }

    return Object.freeze({ FIELD_NAMES, own, normalizeTags, normalizeCatalog, resolveId, normalizeTagChanges,
        mergeTags, migrateOverride, applyOverride, updateOverride, clearOverrideField, clearTagChange,
        coalesceOverrides, hasPersonalChanges });
});
