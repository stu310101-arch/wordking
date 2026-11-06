# 單字王：安全措施與正式環境啟用

更新日期：2026-11-06。

## 實際架構與範圍

本站為 GitHub Pages 靜態網站，使用 Firebase Web SDK、Google OAuth 與 Cloud
Firestore。個人資料位於 `users/{uid}` 下；公用詞庫為公開的 `data/words.json`。
本站沒有 Express 伺服器、自建密碼登入、密碼雜湊資料庫、密碼重設郵件服務或
自建 Session Cookie。提供的安全建議中對這些元件的假設，不代表實際發現的漏洞。
這次工作也沒有執行或聲稱通過 ZAP 掃描、密碼暴力破解或正式帳號滲透測試。

## 已實作於網站程式

### 離線資料隔離

- Service Worker 只快取列在 `sw.js` 的確切公開網址：應用程式、圖示、公用詞庫
  及固定版本的公開 Firebase SDK。忽略帶 Authorization 的請求，不快取
  Firebase Auth、Firestore、私人 API、備份、遷移資料與背景音樂。
- 每個網站路徑與版本有自己的 cache namespace，清理時不刪除其他 GitHub Pages
  專案的 cache。未列入的查詢字串、跨來源及非 GET 請求不進入快取。
- 所有必要資源下載並驗證成功後才安裝新 worker。離線導航只使用同一版本的
  HTML，不以線上新 HTML 覆蓋舊版離線頁面。
- 離線 HTML 加入固定 DOM 標記，讓應用程式即使在 `navigator.onLine` 回報有網路、
  但網站實際無法連線時，也選擇公用模式。離線啟動不還原 Auth 或開啟私人 Firestore。
- 已登入畫面斷線時，立即清除私人單字、資料夾、編輯與練習狀態，取消舊工作階段的
  後續更新。已準備好的訪客公用練習可繼續。重連後仍維持公用模式，重新載入才恢復登入流程。
- 離線不提供個人資料修改、同步、備份或儲存待複習。背景音樂不保證離線可用；
  語音取決於裝置是否已有可離線使用的語音。

### 登入、錯誤訊息與頁面來源限制

- Firebase Auth 使用 `browserSessionPersistence`；儲存空間無法使用時降級為
  `inMemoryPersistence`。不保留原本跨瀏覽器工作階段的預設 LOCAL 設定。
  這仍然是前端 SDK 的工作階段儲存，**不是**後端 HttpOnly Cookie，且不能取代防 XSS。
- 應用程式只顯示已知錯誤代碼對應的繁體中文訊息；未知錯誤使用通用訊息。
  應用程式日誌只保留操作名稱及允許的錯誤代碼，不輸出原始例外、私人文件路徑或憑證。
- 收緊 HTML CSP 的腳本、連線、frame、worker、manifest 等來源；禁止 inline script
  handler、`eval`、object 與 base URL，保留 Google 登入需要的明確來源。
  現有 UI 需要 inline style，因此 `style-src` 仍允許它。
- 設定 `Referrer-Policy` 的 HTML meta 為 `no-referrer`。嵌入 frame 時停止主程式與
  登入/私人資料初始化，提供直接開啟網站的連結。
- DOM 顯示個人文字繼續使用文字節點；資料模型拒絕危險物件鍵、繼承欄位與 class
  instance，保留合法純 JSON、null-prototype 與跨 realm JSON 物件。

### 相依程式與可重現驗證

- Firebase 固定為 12.19.0 並改為同源提供。保留上游授權；
  `config/firebase-vendor-lock.json` 記錄來源、上游/本地 SHA-256 與位元組數。
- SDK 只有同層 import 及 source-map 註解兩種可重現轉換。CI 驗證實際檔案雜湊與
  完整靜態 import graph，不在載入時依賴可變的 CDN 版本。
- 開發套件用 lockfile 安裝；修補 source-map-js 與 postcss-selector-parser 的已知問題。
  `npm audit` 的範圍是 npm lockfile，並不涵蓋所有雲端設定或手動 vendored 程式。
- GitHub Actions 使用固定 commit 的 Actions、唯讀 `contents` 權限、無正式 Firebase
  密鑰。瀏覽器測試只接受 loopback 的隔離 fixture，規則測試只使用 demo emulator。

## Firestore 規則：已寫好並驗證，須另外部署

`config/firestore.rules` 保留既有 UID 所有權與預設拒絕原則，增加 v5/v6 單字、
資料夾、隱藏標記的欄位型別與結構驗證。保留既有備份、歷史 settings 與合法長文字，
避免安全變更破壞使用者資料或 schema 升級。

規則檢查最多 14 組合法詞性及每組 definition list 的型別。Firestore Rules 不能
泛型遍歷任意長度清單；definition/membership 內的每個字串與重複詞性仍由資料模型
檢查。不要把客戶端驗證描述為伺服器端完整驗證。UID 隔離在本次修改前已存在；
沒有證據顯示原網站曾發生跨帳號資料外洩。

**GitHub Pages 發布不會部署 Firebase Rules。** 本次執行環境沒有正式 Firebase
部署憑證，因此新規則在部署前不應被宣稱已生效。授權管理者可以使用 Firebase CLI：

```bash
firebase login
firebase deploy --only firestore:rules --project wordking-434f7 --config config/firebase.json
```

或在 [Firestore Rules](https://console.firebase.google.com/project/wordking-434f7/firestore/rules)
審閱並發布 `config/firestore.rules` 的完整內容。發布前應確認專案名稱與目前正式規則，
保留可回復版本。部署後再以隔離測試帳號確認正常存取、跨帳號拒絕與舊資料載入。

## 仍需要專案管理者啟用的保護

1. **App Check**：先註冊 reCAPTCHA Enterprise 網站金鑰與允許網域，將真實 site key
   整合到應用程式，觀察 metrics，再逐一啟用支援服務的 enforcement。只加入前端
   初始化程式不會啟用後端強制驗證；不要填假金鑰或直接強制啟用而中斷現有使用者。
2. **API 限制與額度**：在 Google Cloud 核對 browser key 僅允許需要的 Firebase API，
   審查 Firebase/Identity Platform 額度、計費與異常使用。Firebase 公開設定中的 API key
   是專案識別資訊，不是伺服器私鑰；把它移到前端環境變數不會保護資料。
3. **帳號多因素驗證**：管理者 Google 帳號應啟用 MFA。若要對所有使用者強制額外
   因素，需先確認 Identity Platform、登入提供者與使用者流程；此次未假裝建立自有
   密碼/MFA 系統。
4. **HTTP 安全標頭**：2026-11-06 的正式頁面回應已有 HSTS。GitHub Pages 上 HTML
   meta CSP 可控制多數資源載入，但 `frame-ancestors` 與 X-Frame-Options 不能透過
   meta 生效。程式的 frame guard 只屬額外保護。若需強制防嵌入、Permissions-Policy
   與更多回應標頭，需要支援它們的主機或受控代理；此次未改主機或聲稱已加入這些標頭。

公開 HTML 回應的 `Access-Control-Allow-Origin: *` 不等於私人 Firestore 資料公開。
私人資料保護由 Firebase 身分驗證與已部署的 Security Rules 執行。

## 驗證方式

```bash
npm ci --prefix config --ignore-scripts
npm run verify:runtime --prefix config
npm audit --prefix config --audit-level=moderate
npm run validate:data --prefix config
npm test --prefix config
npm run build:css --prefix config
git diff --exit-code -- assets/tailwind.css
```

規則測試使用 Java 21+ 與官方 Firestore emulator 1.22.0；下載網址、SHA-256 及大小
已固定於 `.github/workflows/verify.yml`。設定 `FIRESTORE_EMULATOR_JAR` 後執行：

```bash
npm run test:rules --prefix config
```

瀏覽器測試啟動 `tests/helpers/ui-fixture-server.cjs` 後執行
`npm run test:browser --prefix config`。它使用桌面與 390px 手機尺寸，分別測試 `/` 與
`/wordking/` 的真實 Service Worker、公開快取、私人帳號→離線重開隔離、樹狀選字、
拼字提交及三種跳過流程。fixture 不連正式 Firebase，也不能證明正式 Google OAuth
彈出視窗或實體 iPhone/Android 安裝已測試。

最新測試結果與截圖以 GitHub Actions `Verify WordKing` 該次 commit 的結果為準。
PWA 維護程序及實機驗收清單見 `config/PWA.md`。

## 官方參考

- [Auth persistence](https://firebase.google.com/docs/auth/web/auth-state-persistence)
- [Firebase SDK release notes](https://firebase.google.com/support/release-notes/js)
- [Firestore field rules](https://firebase.google.com/docs/firestore/security/rules-fields)
- [Deploy Security Rules](https://firebase.google.com/docs/rules/manage-deploy)
- [Firebase API keys](https://firebase.google.com/docs/projects/api-keys)
- [App Check with reCAPTCHA Enterprise](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider)
- [CSP frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors)
