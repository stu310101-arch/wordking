'use strict';

// Offline, parse-only validation of the files shipped to browsers. The vendor
// lock records reviewed upstream downloads; this checks local integrity against
// that lock, not an independent upstream signature or a comprehensive secret scan.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL, fileURLToPath } = require('node:url');

const root = path.resolve(__dirname, '..');
const relative = file => path.relative(root, file).split(path.sep).join('/');
const results = [];

function check(name, run) {
    const details = run();
    results.push({ check: name, status: 'passed', ...details });
}

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name)).flatMap(entry => {
        const file = path.join(directory, entry.name);
        assert.ok(!entry.isSymbolicLink(), 'Published assets must not be symlinks: ' + relative(file));
        return entry.isDirectory() ? walk(file) : [file];
    });
}

function localDependency(specifier, importer) {
    assert.match(specifier, /^\.\.?\//, 'Dependency must be an explicit relative URL: ' + specifier);
    assert.ok(!specifier.includes('\\'), 'Backslash in dependency URL: ' + specifier);
    const url = new URL(specifier, pathToFileURL(importer));
    assert.equal(url.protocol, 'file:');
    const file = fileURLToPath(url);
    assert.ok(file.startsWith(root + path.sep), 'Dependency leaves the application: ' + specifier);
    assert.ok(fs.existsSync(file) && fs.lstatSync(file).isFile(),
        'Missing local dependency: ' + relative(file));
    return file;
}

function attributes(tag) {
    const result = {};
    const pattern = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/g;
    for (const match of tag.matchAll(pattern)) {
        result[match[1].toLowerCase()] = (match[2] ?? match[3] ?? match[4]).replace(
            /&(?:quot|apos|amp|lt|gt|#(\d+)|#x([a-f\d]+));/gi, (entity, decimal, hex) => {
                if (decimal || hex) return String.fromCodePoint(parseInt(decimal || hex, decimal ? 10 : 16));
                return { '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>' }[entity.toLowerCase()];
            });
    }
    return result;
}

function main() {
    const lock = JSON.parse(read('config/firebase-vendor-lock.json'));
    const vendorFiles = new Set();
    check('Pinned Firebase vendor SHA256, length, and provenance metadata', () => {
        assert.match(lock.version, /^\d+\.\d+\.\d+$/);
        assert.equal(lock.files.length, 3, 'The app uses exactly app, auth, and firestore bundles');
        const expected = new Set(['app', 'auth', 'firestore'].map(name =>
            'assets/vendor/firebase-' + lock.version + '/firebase-' + name + '.js'));
        for (const entry of lock.files) {
            assert.ok(expected.delete(entry.file), 'Unexpected or duplicated vendor lock path');
            assert.equal(entry.url, 'https://www.gstatic.com/firebasejs/' + lock.version + '/' + path.basename(entry.file));
            assert.match(entry.upstreamSha256, /^[a-f0-9]{64}$/);
            assert.match(entry.localSha256, /^[a-f0-9]{64}$/);
            const file = path.join(root, entry.file);
            assert.ok(fs.lstatSync(file).isFile(), 'Vendor asset must be a regular file');
            const bytes = fs.readFileSync(file);
            assert.equal(bytes.length, entry.bytes, 'Vendor length differs: ' + entry.file);
            assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.localSha256,
                'Vendor SHA256 differs: ' + entry.file);
            vendorFiles.add(file);
        }
        assert.equal(expected.size, 0);
        return { version: lock.version, files: lock.files.length };
    });

    const publicFiles = [
        path.join(root, 'index.html'), path.join(root, 'sw.js'), path.join(root, 'manifest.webmanifest'),
        ...walk(path.join(root, 'assets')), ...walk(path.join(root, 'data')),
        ...walk(path.join(root, 'migration'))
    ];
    const scripts = publicFiles.filter(file => file.endsWith('.js'));
    let parsedModules;
    check('Browser JavaScript parses and its static module graph is entirely local', () => {
        // SourceTextModule parses import/re-export syntax without evaluating a
        // single app statement. A separate process supplies the required VM flag.
        const parser = [
            "const fs = require('node:fs');",
            "const vm = require('node:vm');",
            "try { const files = JSON.parse(fs.readFileSync(0, 'utf8'));",
            "const modules = files.map(file => ({ file, imports: new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file }).dependencySpecifiers }));",
            "process.stdout.write(JSON.stringify(modules));",
            "} catch (error) { process.stderr.write(error.message); process.exitCode = 1; }"
        ].join('\n');
        const parsed = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', parser], {
            input: JSON.stringify(scripts), encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024
        });
        if (parsed.error) throw parsed.error;
        assert.equal(parsed.status, 0, 'Browser JavaScript parse failed: ' + parsed.stderr);
        parsedModules = JSON.parse(parsed.stdout);
        for (const module of parsedModules) {
            for (const specifier of module.imports) {
                const target = localDependency(specifier, module.file);
                assert.ok(scripts.includes(target), 'Import points outside the shipped JavaScript graph');
            }
            // There are currently no dynamic imports. Do not silently accept a
            // future variable/remote dependency this static gate cannot resolve.
            assert.doesNotMatch(fs.readFileSync(module.file, 'utf8'), /\bimport\s*\(/,
                'Dynamic imports need an explicit offline dependency review: ' + relative(module.file));
            if (relative(module.file).startsWith('assets/vendor/')) {
                assert.ok(vendorFiles.has(module.file), 'Unpinned vendor JavaScript: ' + relative(module.file));
                assert.deepEqual(module.imports, path.basename(module.file) === 'firebase-app.js'
                    ? [] : ['./firebase-app.js'], 'Vendor imports must close over the pinned app module');
            }
        }
        return { parsedFiles: scripts.length, importEdges: parsedModules.reduce((n, module) => n + module.imports.length, 0) };
    });

    const html = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
    check('HTML dependencies are local and executable inline code is absent', () => {
        const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
        assert.ok(scriptTags.length > 0);
        for (const match of scriptTags) {
            const tag = attributes(match[1]);
            assert.ok(tag.src, 'Inline scripts are not permitted');
            assert.equal(match[2].trim(), '', 'Executable content inside an external script tag');
            const dependency = localDependency(tag.src, path.join(root, 'index.html'));
            assert.ok(scripts.includes(dependency), 'Script tag is outside the shipped JavaScript graph');
        }
        const links = [...html.matchAll(/<link\b([^>]*)>/gi)].map(match => attributes(match[1]));
        for (const link of links.filter(link => /^(stylesheet|manifest|icon|apple-touch-icon)$/.test(link.rel || ''))) {
            localDependency(link.href, path.join(root, 'index.html'));
        }
        assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'Inline event handlers are not permitted');
        for (const match of html.matchAll(/<[a-z][^>]*>/gi)) {
            const tag = attributes(match[0]);
            for (const key of ['href', 'src', 'action', 'formaction']) {
                assert.ok(!/^\s*javascript:/i.test(tag[key] || ''), 'JavaScript URL in HTML');
            }
        }
        return { externalLocalScripts: scriptTags.length };
    });

    check('CSP constrains scripts, exact origins, workers, manifests, frames, and forms', () => {
        const metas = [...html.matchAll(/<meta\b([^>]*)>/gi)].map(match => attributes(match[1]));
        const policies = metas.filter(meta => meta['http-equiv']?.toLowerCase() === 'content-security-policy');
        assert.equal(policies.length, 1, 'Expected one enforceable CSP meta policy');
        const directives = new Map();
        for (const entry of policies[0].content.split(';').map(part => part.trim()).filter(Boolean)) {
            const [name, ...sources] = entry.split(/\s+/);
            assert.ok(!directives.has(name), 'Duplicated CSP directive: ' + name);
            directives.set(name, sources);
            for (const source of sources) {
                assert.ok(!source.includes('*'), 'Wildcard CSP source: ' + source);
                if (!source.startsWith("'") && source !== 'data:') {
                    const url = new URL(source);
                    assert.equal(url.protocol, 'https:', 'External CSP sources must be explicit HTTPS origins');
                    assert.ok(url.hostname && !url.username && !url.password);
                }
                if (source === 'data:') assert.equal(name, 'img-src', 'Data URLs are restricted to images');
                if (name === 'default-src' || name.startsWith('script-src')) {
                    assert.ok(!["'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'"].includes(source),
                        'Unsafe script execution allowed by CSP');
                }
            }
        }
        for (const [name, expected] of Object.entries({
            'default-src': ["'self'"], 'script-src-attr': ["'none'"],
            'worker-src': ["'self'"], 'manifest-src': ["'self'"],
            'object-src': ["'none'"], 'base-uri': ["'none'"], 'form-action': ["'self'"]
        })) assert.deepEqual(directives.get(name), expected, 'Unsafe or missing CSP directive: ' + name);
        assert.ok(directives.get('script-src')?.includes("'self'"));
        assert.ok(directives.get('connect-src')?.includes("'self'"));
        assert.ok(directives.has('frame-src'), 'Auth frames must have an explicit allowlist');
        assert.ok(!directives.has('frame-ancestors'), 'frame-ancestors is ineffective in meta; configure a server header');
        assert.ok(!metas.some(meta => meta['http-equiv']?.toLowerCase() === 'x-frame-options'),
            'X-Frame-Options meta does not provide clickjacking protection');
        return { directives: directives.size };
    });

    check('Published text contains no fixture payloads or known private credential markers', () => {
        let scanned = 0;
        for (const file of publicFiles.filter(file => /\.(?:html|js|json|webmanifest|css|svg|txt|map)$/.test(file))) {
            const source = fs.readFileSync(file, 'utf8');
            scanned += 1;
            assert.doesNotMatch(source,
                /__wordkingFixture|fixture-account-[ab]|mockFirebase|mock-firebase\.js|wordking-ui-fixture/i,
                'Disposable fixture code leaked into published file: ' + relative(file));
            assert.doesNotMatch(source, /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
                'Private key marker in published file: ' + relative(file));
            // SDKs legitimately contain credential field names and error text.
            // Their exact bytes were checked above. Scan actual first-party
            // values, while allowing Firebase's intentionally public API key.
            if (vendorFiles.has(file)) continue;
            assert.doesNotMatch(source, /["']type["']\s*:\s*["']service_account["']/,
                'Service-account configuration in published file: ' + relative(file));
            assert.doesNotMatch(source, /["'](?:private_key|client_secret|refresh_token)["']\s*:\s*["'][^"']{16,}["']/,
                'Private credential value in published file: ' + relative(file));
        }
        return { scannedTextFiles: scanned, firebasePublicConfigAllowed: true };
    });
    process.stdout.write(JSON.stringify({ status: 'passed', checks: results }, null, 2) + '\n');
}

try {
    main();
} catch (error) {
    process.stderr.write(JSON.stringify({ status: 'failed', checks: results, error: error.message }, null, 2) + '\n');
    process.exitCode = 1;
}
