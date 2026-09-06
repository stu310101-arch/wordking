// Runs the checked-in rules against the real Firestore emulator without SDK
// dependencies. Prerequisites: Java 21+ and `firebase setup:emulators:firestore`.
// Optional overrides: WORDKING_JAVA_BIN, FIRESTORE_EMULATOR_JAR.
const { spawn } = require('node:child_process');
const { existsSync, readdirSync, mkdtempSync, createWriteStream } = require('node:fs');
const { once } = require('node:events');
const { homedir, tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');

async function main() {
    const cache = process.env.FIREBASE_EMULATORS_PATH || path.join(homedir(), '.cache', 'firebase', 'emulators');
    const jars = existsSync(cache) ? readdirSync(cache).filter(name => /^cloud-firestore-emulator-v[\d.]+\.jar$/.test(name)) : [];
    jars.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    const jar = process.env.FIRESTORE_EMULATOR_JAR || (jars[0] && path.join(cache, jars[0]));
    if (!jar || !existsSync(jar)) throw new Error('Firestore emulator missing. Run firebase setup:emulators:firestore or set FIRESTORE_EMULATOR_JAR.');
    const java = process.env.WORDKING_JAVA_BIN || (process.env.JAVA_HOME
        ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java');
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const logDirectory = mkdtempSync(path.join(tmpdir(), 'wordking-firestore-rules-'));
    const logFile = path.join(logDirectory, 'firestore.log');
    const log = createWriteStream(logFile);
    const projectId = 'demo-wordking-rules';
    const emulator = spawn(java, [
        '-Duser.language=en', '-jar', jar, '--host', '127.0.0.1', '--port', String(port),
        '--rules', path.join(__dirname, 'firestore.rules'), '--project_id', projectId,
        '--single_project_mode', 'true'
    ], { cwd: logDirectory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let launchError;
    emulator.on('error', error => { launchError = error; });
    emulator.stdout.pipe(log);
    emulator.stderr.pipe(log);
    const emulatorExit = new Promise(resolve => emulator.once('close', resolve));
    try {
        const deadline = Date.now() + 45000;
        let ready = false;
        while (Date.now() < deadline) {
            if (launchError) throw launchError;
            if (emulator.exitCode !== null) throw new Error(`Emulator exited with code ${emulator.exitCode}. Log: ${logFile}`);
            try {
                const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
                await response.text();
                ready = true;
                break;
            } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
        }
        if (!ready) throw new Error(`Firestore emulator did not start. Log: ${logFile}`);
        console.log(`Firestore rules emulator: ${path.basename(jar)}; log: ${logFile}`);
        const child = spawn(process.execPath, ['--test', path.join(__dirname, '..', 'tests', 'firestore-rules.test.cjs')], {
            cwd: path.join(__dirname, '..'), windowsHide: true, stdio: 'inherit',
            env: { ...process.env, GCLOUD_PROJECT: projectId, FIRESTORE_EMULATOR_HOST: `127.0.0.1:${port}` }
        });
        child.on('error', error => { console.error(error); });
        const [code] = await once(child, 'close');
        process.exitCode = code === 0 ? 0 : 1;
    } finally {
        if (emulator.exitCode === null) emulator.kill();
        await emulatorExit;
        log.end();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
