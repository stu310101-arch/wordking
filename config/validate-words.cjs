'use strict';

const fs = require('node:fs');
const path = require('node:path');
const data = require('../assets/word-data.js');

function validateCatalogFiles(root = path.resolve(__dirname, '..')) {
    const words = data.normalizeCatalog(JSON.parse(fs.readFileSync(path.join(root, 'data/words.json'), 'utf8')));
    const compatibility = JSON.parse(fs.readFileSync(path.join(root, 'data/word-id-aliases.json'), 'utf8'));
    const ids = new Set(words.map(word => word.id));
    if (compatibility.schemaVersion !== 1 || !compatibility.aliases || !compatibility.legacyTagsById) {
        throw new Error('The frozen ID compatibility manifest is invalid.');
    }
    for (const [alias, target] of Object.entries(compatibility.aliases)) {
        if (ids.has(alias)) throw new Error(`Alias collides with public ID: ${alias}`);
        if (typeof target !== 'string' || !ids.has(data.resolveId(alias, compatibility))) throw new Error(`Unresolved alias: ${alias}`);
    }
    for (const [oldId, tags] of Object.entries(compatibility.legacyTagsById)) {
        if (!ids.has(data.resolveId(oldId, compatibility))) throw new Error(`Historical ID lost its public word: ${oldId}`);
        if (!Array.isArray(tags) || JSON.stringify(tags) !== JSON.stringify(data.normalizeTags(tags))) {
            throw new Error(`Invalid historical migration baseline: ${oldId}`);
        }
    }
    return { words: words.length, memberships: words.reduce((count, word) => count + word.tags.length, 0),
        aliases: Object.keys(compatibility.aliases).length, legacyIds: Object.keys(compatibility.legacyTagsById).length };
}

if (require.main === module) {
    try { console.log(`Public catalog validated: ${JSON.stringify(validateCatalogFiles())}`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { validateCatalogFiles };
