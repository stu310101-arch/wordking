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
            : '目前僅使用公用單字。確認網路恢復後，可重新載入以使用登入與同步。';
        element('pwa-reconnect').hidden = disconnected || !publicMode;
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
        const result = await new Promise(resolve => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 3000);
            channel.port1.onmessage = event => {
                if (event.data?.type !== 'OFFLINE_STATUS') return;
                clearTimeout(timer);
                channel.port1.close();
                resolve(event.data.ready === true);
            };
            try { worker.postMessage({ type: 'GET_OFFLINE_STATUS' }, [channel.port2]); }
            catch { clearTimeout(timer); channel.port1.close(); resolve(false); }
        });
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
                    if (worker.state === 'activated') void refreshReadiness();
                    if (worker.state === 'redundant' && !registration.active) {
                        registrationFailed = true;
                        renderConnection();
                    }
                });
            };
            registration.addEventListener('updatefound', observeInstalling);
            observeInstalling();
            await refreshReadiness();
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
            void refreshReadiness();
        });
        const connectionChanged = () => {
            renderConnection();
            void refreshReadiness();
        };
        window.addEventListener('online', connectionChanged);
        window.addEventListener('offline', connectionChanged);
        window.addEventListener('wordking-offline-mode', renderConnection);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            renderWaitingUpdate();
            void refreshReadiness();
            if (registration && navigator.onLine !== false && Date.now() - lastUpdateCheck > 60000) {
                lastUpdateCheck = Date.now();
                void registration.update().catch(() => {});
            }
        });
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
