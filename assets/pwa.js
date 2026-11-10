(() => {
    'use strict';
    const scriptURL = document.currentScript?.src || new URL('assets/pwa.js', document.baseURI).href;
    const appBase = new URL('../', scriptURL);
    let registration = null;
    let installPrompt = null;
    let offlineReady = false;
    let readinessChecked = false;
    let registrationFailed = false;
    let unsupported = false;
    let installed = false;
    let updateDismissed = false;
    let reloadRequested = false;
    let reloadStarted = false;
    let lastUpdateCheck = 0;
    let supportsPublicSync = false;
    let readinessGeneration = 0;
    let syncPromise = null;
    let lastSuccessfulSync = 0;
    let retryTimer = null;
    let retryCount = 0;
    let syncState = 'idle';
    let syncedWordCount = 0;
    const displayMode = window.matchMedia('(display-mode: standalone)');
    const element = id => document.getElementById(id);
    const standalone = () => installed || displayMode.matches || navigator.standalone === true;

    function renderInstall() {
        const button = element('pwa-install');
        const help = element('pwa-install-help');
        if (!button || !help) return;
        button.hidden = standalone() || !installPrompt;
        help.hidden = standalone();
        element('pwa-install-title').textContent = standalone() ? '隨時開啟單字王' : '把單字王加入主畫面';
    }

    function renderConnection() {
        const status = element('pwa-status');
        if (!status) return;
        status.textContent = unsupported
            ? '這個瀏覽器目前無法提供離線練習，仍可連網使用。'
            : offlineReady
                ? '公用單字已備妥，可離線開啟與練習。'
                : readinessChecked || registrationFailed || navigator.onLine === false
                    ? '離線版本尚未備妥，請保持連線使用，稍後重新開啟網站重試。'
                    : '正在準備公用單字的離線版本…';
        const publicMode = window.WordKingOffline === true;
        const disconnected = navigator.onLine === false;
        const banner = element('pwa-offline-banner');
        banner.hidden = !disconnected && !publicMode;
        element('pwa-network-title').textContent = disconnected ? '目前離線' : '公用單字模式';
        element('pwa-offline-message').textContent = disconnected
            ? '可練習已載入的公用單字。登入、個人資料與同步需要連線。'
            : '公用字庫會自動下載更新；登入與個人同步可按「重新連線」恢復。';
        element('pwa-reconnect').hidden = disconnected || !publicMode;
        renderPublicSync();
    }

    function renderPublicSync() {
        const status = element('pwa-sync-status');
        if (!status) return;
        const applicationStatus = window.WordKingPublicCatalogStatus;
        status.textContent = unsupported
            ? '公用字庫自動下載需要支援 PWA 的瀏覽器。'
            : navigator.onLine === false
            ? '恢復連線後會自動檢查並下載新版公用字庫。'
            : syncState === 'syncing'
                ? '正在檢查並下載公用字庫更新…'
                : syncState === 'failed'
                    ? '暫時無法更新公用字庫，已保留上次下載；連線穩定後會自動重試。'
                    : syncState === 'saved'
                        ? applicationStatus === 'pending'
                            ? `已保存 ${syncedWordCount} 個公用單字；目前的練習、編輯或載入結束後會自動套用。`
                            : applicationStatus === 'conflict'
                                ? '新版公用字庫已下載；與個人單字有衝突，目前保留你的原有內容。'
                                : applicationStatus === 'invalid'
                                    ? '公用字庫格式暫時不相容，目前保留已載入的內容。'
                                    : offlineReady
                                        ? `已同步 ${syncedWordCount} 個公用單字，下次離線也能使用。`
                                        : `已保存 ${syncedWordCount} 個公用單字，網站的離線準備尚未完成。`
                        : readinessChecked && !supportsPublicSync && registration?.active
                            ? '請套用新版單字王，啟用公用字庫自動下載。'
                            : '開啟或回到單字王並連網時，會自動下載最新公用字庫。';
    }

    function cancelSyncRetry() {
        if (retryTimer !== null) clearTimeout(retryTimer);
        retryTimer = null;
    }

    function scheduleSyncRetry() {
        cancelSyncRetry();
        if (navigator.onLine === false || document.visibilityState === 'hidden') return;
        const delay = Math.min(15000 * 2 ** retryCount, 300000);
        retryCount = Math.min(retryCount + 1, 5);
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void syncPublicWords({ force: true });
        }, delay);
    }

    async function syncPublicWords({ force = false } = {}) {
        if (syncPromise) return syncPromise;
        if (!registration?.active || !supportsPublicSync || navigator.onLine === false
            || !('MessageChannel' in window)) return;
        if (!force && lastSuccessfulSync && Date.now() - lastSuccessfulSync < 60000
            && syncState !== 'failed') return;
        cancelSyncRetry();
        syncState = 'syncing';
        renderPublicSync();
        const worker = registration.active;
        syncPromise = (async () => {
            const result = await new Promise(resolve => {
                const channel = new MessageChannel();
                const timer = setTimeout(() => { channel.port1.close(); resolve(null); }, 15000);
                channel.port1.onmessage = event => {
                    if (event.data?.type !== 'PUBLIC_WORDS_SYNC') return;
                    clearTimeout(timer);
                    channel.port1.close();
                    resolve(event.data);
                };
                try { worker.postMessage({ type: 'SYNC_PUBLIC_WORDS' }, [channel.port2]); }
                catch { clearTimeout(timer); channel.port1.close(); resolve(null); }
            });
            if (result?.ok && Array.isArray(result.words) && result.words.length) {
                syncState = 'saved';
                lastSuccessfulSync = Date.now();
                syncedWordCount = result.words.length;
                retryCount = 0;
                // Keep the snapshot if app.js is still loading its module graph.
                window.WordKingPendingPublicCatalog = result.words;
                window.dispatchEvent(new CustomEvent('wordking-public-catalog'));
            } else {
                syncState = 'failed';
                scheduleSyncRetry();
            }
            renderPublicSync();
            void refreshReadiness();
        })().finally(() => { syncPromise = null; });
        return syncPromise;
    }

    function renderWaitingUpdate() {
        const banner = element('pwa-update-banner');
        if (!banner) return;
        // The first install briefly waits before becoming active; it is not an
        // update. Reconcile both directions because another tab can activate it.
        const hasUpdate = registration?.active && registration.waiting
            && registration.waiting !== registration.active;
        banner.hidden = !hasUpdate || updateDismissed;
    }

    async function refreshReadiness() {
        if (!registration?.active || !('MessageChannel' in window)) return;
        const worker = registration.active;
        const generation = ++readinessGeneration;
        const result = await new Promise(resolve => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 3000);
            channel.port1.onmessage = event => {
                if (event.data?.type !== 'OFFLINE_STATUS') return;
                clearTimeout(timer);
                channel.port1.close();
                if (registration.active === worker && generation === readinessGeneration) {
                    supportsPublicSync = event.data.publicSync === true;
                }
                resolve(event.data.ready === true);
            };
            try { worker.postMessage({ type: 'GET_OFFLINE_STATUS' }, [channel.port2]); }
            catch { clearTimeout(timer); channel.port1.close(); resolve(false); }
        });
        if (registration.active !== worker || generation !== readinessGeneration) return;
        offlineReady = result;
        readinessChecked = true;
        renderConnection();
    }

    function confirmReload() {
        // A deliberate update/reconnect must not silently discard an active quiz or editor.
        const activeGame = window.state?.game?.isFinished === false;
        const openEditor = Array.from(document.querySelectorAll('[role="dialog"]')).some(dialog => !dialog.hidden);
        return (!activeGame && !openEditor) || window.confirm('重新載入會結束目前的練習，並放棄尚未儲存的編輯。確定現在重新載入嗎？');
    }

    async function registerWorker() {
        if (!('serviceWorker' in navigator) || !window.isSecureContext) {
            unsupported = true;
            renderConnection();
            return;
        }
        try {
            registration = await navigator.serviceWorker.register(new URL('sw.js', appBase).href, {
                scope: appBase.href, updateViaCache: 'none'
            });
            lastUpdateCheck = Date.now();
            renderWaitingUpdate();
            const observeInstalling = () => {
                const worker = registration.installing || registration.waiting;
                if (!worker) return;
                worker.addEventListener('statechange', () => {
                    renderWaitingUpdate();
                    if (worker.state === 'activated') {
                        void refreshReadiness().then(() => syncPublicWords({ force: true }));
                    }
                    if (worker.state === 'redundant' && !registration.active) {
                        registrationFailed = true;
                        renderConnection();
                    }
                });
            };
            registration.addEventListener('updatefound', observeInstalling);
            observeInstalling();
            await refreshReadiness();
            void syncPublicWords();
        } catch {
            registrationFailed = true;
            renderConnection();
        }
    }

    function init() {
        renderInstall();
        renderConnection();
        element('pwa-install').addEventListener('click', async () => {
            const prompt = installPrompt;
            if (!prompt) return;
            installPrompt = null;
            renderInstall();
            try {
                await prompt.prompt();
                await prompt.userChoice;
            } catch {
                element('pwa-install-help').open = true;
            }
        });
        element('pwa-update-button').addEventListener('click', () => {
            const worker = registration?.waiting;
            if (!worker || !registration.active) {
                renderWaitingUpdate();
                return;
            }
            if (!confirmReload()) return;
            reloadRequested = true;
            element('pwa-update-button').disabled = true;
            worker.postMessage({ type: 'SKIP_WAITING' });
        });
        element('pwa-update-later').addEventListener('click', () => {
            updateDismissed = true;
            element('pwa-update-banner').hidden = true;
        });
        element('pwa-reconnect').addEventListener('click', () => {
            if (navigator.onLine !== false && confirmReload()) window.location.reload();
        });
        if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('controllerchange', () => {
            renderWaitingUpdate();
            if (reloadRequested && !reloadStarted) {
                reloadStarted = true;
                window.location.reload();
                return;
            }
            // The first installation claims the page without resetting its state.
            void refreshReadiness().then(() => syncPublicWords({ force: true }));
        });
        window.addEventListener('online', () => {
            retryCount = 0;
            renderConnection();
            void refreshReadiness().then(() => syncPublicWords({ force: true }));
        });
        window.addEventListener('offline', () => {
            cancelSyncRetry();
            renderConnection();
            void refreshReadiness();
        });
        window.addEventListener('wordking-offline-mode', renderConnection);
        window.addEventListener('wordking-public-catalog-status', renderPublicSync);
        const resume = () => {
            if (document.visibilityState !== 'visible') return;
            renderWaitingUpdate();
            void refreshReadiness().then(() => syncPublicWords());
            if (registration && navigator.onLine !== false && Date.now() - lastUpdateCheck > 60000) {
                lastUpdateCheck = Date.now();
                void registration.update().catch(() => {});
            }
        };
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') cancelSyncRetry();
            else resume();
        });
        window.addEventListener('pageshow', resume);
        if (displayMode.addEventListener) displayMode.addEventListener('change', renderInstall);
        else if (displayMode.addListener) displayMode.addListener(renderInstall);
        void registerWorker();
    }

    window.addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        installPrompt = event;
        renderInstall();
    });
    window.addEventListener('appinstalled', () => {
        installed = true;
        installPrompt = null;
        renderInstall();
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
