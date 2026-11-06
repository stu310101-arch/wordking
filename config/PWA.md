# 單字王 PWA 維護說明

## 安裝與離線範圍

`manifest.webmanifest` 使用相對 `id`、`scope`、`start_url` 與捷徑，因此可部署在 `/wordking/` 等子路徑。瀏覽器須透過 HTTPS（本機 localhost 除外）開啟。Android 支援原生安裝提示時，首頁才會顯示「安裝單字王」；iPhone / iPad 可展開首頁的安裝說明，使用瀏覽器「分享 → 加入主畫面」。獨立視窗開啟後會隱藏安裝提示。

離線版本只包含網站介面、固定版本的 Firebase 程式碼，以及 `data/words.json` 的公用單字。Firebase 程式碼是公開的應用依賴，與使用者的登入資訊和雲端資料不同。Service Worker 不攔截 Auth / Firestore API、個人資料、舊資料遷移檔案、音樂、其他 GitHub Pages 專案，或未列在允許清單內的 URL。

首頁只有在目前啟用的 Service Worker 確認整份允許清單皆已快取後，才會顯示「公用單字已備妥」。尚未準備完成、瀏覽器不支援，或快取被移除時，畫面不會宣稱可離線使用。瀏覽器仍可能因儲存空間不足而移除快取。

## 與主程式的介面

- `window.WordKingOffline === true` 表示目前只能練習公用單字；`assets/pwa.js` 依此顯示狀態與重新連線按鈕。
- 主程式切換模式時送出 `wordking-offline-mode` 自訂事件；PWA 控制器重新讀取上面的旗標。
- 網路失敗時，Service Worker 從已安裝版本取得 `index.html`，在回應中加入固定 `data-wordking-offline="true"` HTML 屬性。主程式應在建立 Auth / Firestore 連線前檢查這個屬性，以及 `navigator.onLine`。
- 離線後切回線上不會自動重新載入。使用者可以按「重新連線」，完成目前練習後恢復登入與雲端同步。
- PWA 更新與重新連線會檢查 `window.state.game.isFinished` 及可見的 `role="dialog"`；進行中的練習或編輯須先確認才會重新載入。

## 發佈一個新版本

1. 每次修改離線介面、腳本、樣式或圖示時，更新 `sw.js` 的 `RELEASE`，並將 `index.html` 中本機腳本與樣式的 `?v=` 一起改成相同字串。不要在已發佈的 `RELEASE` 下更新離線資產。
2. 若加入執行時必要資產，將其完整 URL 加入 `SHELL_URLS`。使用明確清單，不改成任意請求的快取。Firebase 升版須建立新的 `assets/vendor/firebase-版本/` 目錄，修改應用匯入與允許清單，再更新供應來源鎖定檔。
3. 先發佈完整資產與 `sw.js`。安裝時會先下載並驗證所有必要資產，再建立新版本快取；任一資產失敗，新 Worker 就不能啟用。
4. 新 Worker 預設等候。開著舊版本的使用者會看到更新提醒，可選「更新並重新載入」或「稍後」。不要在安裝事件無條件 `skipWaiting()`，也不要因首次 `controllerchange` 就重新載入。
5. 啟用新 Worker 時只移除 `wordking-pwa:<已編碼部署路徑>:` 命名空間下的舊版本快取，不移除同源其他專案的快取。

導覽採網路優先，但線上取得的新 HTML **不會**覆寫舊 Worker 已安裝的 HTML，以免離線時將新版 HTML 與舊版腳本混用。公用單字可更新；只接受成功、非重新導向、MIME 正確的非空 JSON 陣列，異常時保留最後一次成功的公用單字。

## 伺服器與瀏覽器驗收

伺服器須以 JavaScript MIME 提供 `sw.js`（例如 `application/javascript` 或 `text/javascript`），以 `application/manifest+json` 或 `application/json` 提供 manifest，並正確提供 HTML、CSS、JSON、SVG 和 PNG MIME。部署在子路徑時，`sw.js` 必須位於該應用目錄；目前不需要放寬 `Service-Worker-Allowed`。

執行本機行為測試：

```sh
node --test tests/pwa-worker.test.cjs tests/pwa-ui.test.cjs
```

實際瀏覽器至少確認：

- 首次線上開啟並等到「公用單字已備妥」後，切斷網路再重新開啟首頁／單字庫／練習區；公用單字可用，私人資料不顯示，雲端操作被停用。
- 檢查 Cache Storage，只有允許清單中的公開檔案；登入、讀取或編輯私人資料後不增加私人快取。
- Android 的安裝按鈕與 iOS 的加入主畫面流程；以主畫面圖示開啟時，視窗與圖示正常，瀏海及底部安全區不擋住控制項。
- 進行練習時部署下一版本；首次安裝不重設畫面，更新提醒不強制重載，「稍後」可繼續練習，明確接受更新後只重載一次。
- 使用者離線後恢復連線，畫面保留公用模式，明確按下「重新連線」才恢復雲端登入／同步流程。

單元測試以隔離的 Worker / DOM 行為模擬驗證快取界線與生命週期；原生安裝提示、實際瀏覽器儲存配額及裝置安裝流程仍須以上述實機步驟確認。
