# 單字王 PWA 維護說明

## 安裝與離線範圍

`manifest.webmanifest` 使用相對 `id`、`scope`、`start_url` 與捷徑，因此可部署在 `/wordking/` 等子路徑。瀏覽器須透過 HTTPS（本機 localhost 除外）開啟。Android 支援原生安裝提示時，首頁才會顯示「安裝單字王」；iPhone / iPad 可展開首頁的安裝說明，使用瀏覽器「分享 → 加入主畫面」。獨立視窗開啟後會隱藏安裝提示。

離線版本只包含網站介面、固定版本的 Firebase 程式碼，以及 `data/words.json` 的公用單字。Firebase 程式碼是公開的應用依賴，與使用者的登入資訊和雲端資料不同。Service Worker 不攔截 Auth / Firestore API、個人資料、舊資料遷移檔案、音樂、其他 GitHub Pages 專案，或未列在允許清單內的 URL。

首頁只有在目前啟用的 Service Worker 確認整份允許清單皆已快取後，才會顯示「公用單字已備妥」。尚未準備完成、瀏覽器不支援，或快取被移除時，畫面不會宣稱可離線使用。瀏覽器仍可能因儲存空間不足而移除快取。

## 與主程式的介面

- `window.WordKingOffline === true` 表示目前只能練習公用單字；`assets/pwa.js` 依此顯示狀態與重新連線按鈕。
- 主程式切換模式時送出 `wordking-offline-mode` 自訂事件；PWA 控制器重新讀取上面的旗標。
- 網路失敗時，Service Worker 從已安裝版本取得 `index.html`，在回應中加入固定 `data-wordking-offline="true"` HTML 屬性。主程式應在建立 Auth / Firestore 連線前檢查這個屬性，以及 `navigator.onLine`。
- 離線後切回線上會自動下載公用字庫，不會自動重新載入。使用者可以按「重新連線」，完成目前練習後恢復登入與雲端同步。
- PWA 更新與重新連線會檢查 `window.state.game.isFinished` 及可見的 `role="dialog"`；進行中的練習或編輯須先確認才會重新載入。

## 公用字庫自動更新

公用 JSON 儲存在瀏覽器的 Cache Storage，以部署路徑隔離的 `wordking-pwa:<已編碼部署路徑>:public-words-v1` 保存，與每一版網站介面的快取分開。這份本機資料可在下次無網路時直接讀取；不另外建立內容相同的 IndexedDB，也不將公用內容寫入任何使用者的 Firestore。

- 啟動、Service Worker 啟用或控制權切換、`online`、回到前景的 `visibilitychange` 與 `pageshow` 都會檢查字庫。前景／返回檢查在上次成功後節流 60 秒，恢復連線會立即檢查。暫時失敗時，前景頁面從 15 秒開始逐步重試，最長間隔 5 分鐘。
- 頁面只向自己的 active Worker 傳送 `SYNC_PUBLIC_WORDS`；Worker 固定下載 `data/words.json`，不接受用戶端指定的下載網址。請求不帶登入憑證、繞過 HTTP 快取、禁止重新導向並有逾時限制。同 Worker 的同時請求共用一次下載。
- 下載通過回應類型及 `WordKingData.normalizeCatalog` 驗證後，才原子替換完整字庫。空字庫、缺少義項、格式錯誤、重複英文／ID、錯誤詞性、伺服器失敗及儲存空間錯誤，都不能把最後成功的版本刪掉或回報同步成功。
- `PUBLIC_WORDS_SYNC` 成功回覆包含 `words`、`updated`、`checkedAt`。首頁只在本機保存成功後顯示已同步；整個網站介面尚未備妥時，仍會明確顯示離線準備未完成。
- `app.js` 先暫存收到的完整版本；初始載入、個人資料同步、練習、編輯、復原或對話框未結束時，每秒檢查是否可安全套用。套用走 `setPublicCatalog`，保留私人單字、稀疏修改、資料夾、待複習狀態、題目、答案草稿與歷史；不觸發雲端寫入。若新英文與私人單字衝突，畫面保留目前內容並提示，已下載的公共版本仍供離線使用。
- 新課程由字庫內的 `lessonIds` 自動加入，既有 `死神單字L5Uxx` 會依命名規則顯示為 `死神單字Lv5Uxx` 並放入相同系列。不需要只為新字庫強制重新載入介面。

手機和平板系統可能暫停背景頁面或終止 Service Worker，所以自動更新保證的觸發範圍是「開啟／回到單字王且連網」，以及開啟期間恢復連線；不宣稱完全關閉應用程式時仍能常駐下載。既有舊 Worker 不支援新同步訊息時，先透過原本的新版提示完成這次應用程式更新，往後純字庫更新會自動下載。

## 發佈一個新版本

1. 每次修改離線介面、腳本、樣式或圖示時，更新 `sw.js` 的 `RELEASE`，並將 `index.html` 中本機腳本與樣式的 `?v=` 一起改成相同字串。不要在已發佈的 `RELEASE` 下更新離線資產。
2. 若加入執行時必要資產，將其完整 URL 加入 `SHELL_URLS`。使用明確清單，不改成任意請求的快取。Firebase 升版須建立新的 `assets/vendor/firebase-版本/` 目錄，修改應用匯入與允許清單，再更新供應來源鎖定檔。
3. 先發佈完整資產與 `sw.js`。安裝時會先下載並驗證所有必要資產，再建立新版本快取；任一資產失敗，新 Worker 就不能啟用。
4. 新 Worker 預設等候。開著舊版本的使用者會看到更新提醒，可選「更新並重新載入」或「稍後」。不要在安裝事件無條件 `skipWaiting()`，也不要因首次 `controllerchange` 就重新載入。
5. 啟用新 Worker 時只移除 `wordking-pwa:<已編碼部署路徑>:` 命名空間下的舊版本介面快取，保留獨立公用字庫，也不移除同源其他專案的快取。

導覽採網路優先，但線上取得的新 HTML **不會**覆寫舊 Worker 已安裝的 HTML，以免離線時將新版 HTML 與舊版腳本混用。公用單字獨立更新，異常時保留最後一次通過完整 schema 驗證並成功保存的版本。

## 伺服器與瀏覽器驗收

伺服器須以 JavaScript MIME 提供 `sw.js`（例如 `application/javascript` 或 `text/javascript`），以 `application/manifest+json` 或 `application/json` 提供 manifest，並正確提供 HTML、CSS、JSON、SVG 和 PNG MIME。部署在子路徑時，`sw.js` 必須位於該應用目錄；目前不需要放寬 `Service-Worker-Allowed`。

執行本機行為測試：

```sh
node --test tests/pwa-worker.test.cjs tests/pwa-ui.test.cjs tests/public-catalog-sync.test.cjs
```

實際瀏覽器至少確認：

- 首次線上開啟並等到「公用單字已備妥」後，切斷網路再重新開啟首頁／單字庫／練習區；公用單字可用，私人資料不顯示，雲端操作被停用。
- 檢查 Cache Storage，只有允許清單中的公開檔案；登入、讀取或編輯私人資料後不增加私人快取。
- Android 的安裝按鈕與 iOS 的加入主畫面流程；以主畫面圖示開啟時，視窗與圖示正常，瀏海及底部安全區不擋住控制項。
- 進行練習時部署下一版本；首次安裝不重設畫面，更新提醒不強制重載，「稍後」可繼續練習，明確接受更新後只重載一次。
- 使用者離線後恢復連線，字庫自動下載並在安全時機套用；再次離線重開可看到新版內容。畫面保留公用模式，明確按下「重新連線」才恢復雲端登入／同步流程。
- 只更換 `data/words.json`，同時加入單字／新課程並修改既有釋義，確認都會自動更新；在進行練習時下載，答案草稿與題目不重置。無效 JSON／schema 或儲存失敗仍保留上一個完整版本。

單元測試以隔離的 Worker / DOM 行為模擬驗證快取界線與生命週期；原生安裝提示、實際瀏覽器儲存配額及裝置安裝流程仍須以上述實機步驟確認。
