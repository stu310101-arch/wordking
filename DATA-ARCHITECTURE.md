# 單字王資料架構與驗證（2026-09-06）

本次修改尚未 commit、push、部署正式網站或部署 Firebase rules。原未提交內容已從工作區撤下，保留於 Git stash `before wordking data architecture restart 2026-09-05`，可以復原。

## 原本已有的功能

- 公用課程檔、Google 登入、個人新增單字、`wordOverrides`、`deletedDefaults`、個人資料夾及設定。
- 多課程介面、搜尋建議、拼字／選擇題、待複習、跨裝置版本檢查與大量同步鎖。
- `config/firestore.rules` 已限制登入者只能存取 `/users/{自己的 uid}` 及其子路徑，其餘路徑拒絕讀寫。本次維持這些規則。

## 本次變更

`data/words.json` 現在是執行時唯一的公用單字內容來源，共 429 筆單字、446 個課程歸屬。每筆具有固定 `id` 及 `tags`。保留全部 429 個既有 ID；日後改英文、解釋或標籤時直接保留該 ID，不再依課程或英文重新產生。不同課程共用同一筆基礎解釋。

`data/word-id-aliases.json` 保存 17 個歷史課程別名及凍結的舊標籤基準，讓舊個人資料仍能對應公用單字。`data/lessons/` 保留作為歷史資料參照，執行時不再讀取；維護者只修改 `data/words.json` 的公用內容。不要以重新生成公用 ID 或重算舊標籤基準的方式更新單字。

個人資料仍放在 `/users/{uid}/`：

| 路徑 | 用途 |
| --- | --- |
| `wordOverrides/{固定 ID}` | 已修改欄位、`addedTags`、`removedTags` 與遷移備份 |
| `deletedDefaults/{固定 ID 或舊別名}` | `deleted: true` 代表對本人隱藏；恢復時寫入 `false` |
| `customWords/{個人 ID}` | 本人新增的完整單字，可由本人刪除 |
| `folders/{ID}` | 本人建立的資料夾 |
| `settings/main` | 音樂、音量、課程顯示名稱等個人設定 |
| 使用者根文件 | 同步版本、同步鎖，以及保留的舊資料快照 |

例如只改解釋並調整課程時，覆蓋文件只保存相關差異：

```json
{
  "meaning": "我的解釋",
  "addedTags": ["我的練習"],
  "removedTags": ["晟景Lv5U6"],
  "schemaVersion": 2,
  "tagDiffVersion": 2,
  "supersedesLegacyAliases": true
}
```

沒有覆蓋的欄位繼承最新公用值；明確的空字串或 `false` 保留。標籤使用「公用 + 新增 - 移除」並去重，同一標籤不會同時存在兩組差異。空標籤集合有效。課程篩選、搜尋、編輯與練習都使用合併後的歸屬。舊版 `deletedLessonIds` 仍作為個人隱藏整個課程的相容設定。

編輯視窗可取消課程勾選、清除各欄覆蓋、取消新增／移除標籤、恢復此字公用內容，以及只對本人隱藏公用单字。設定中的「恢復隱藏的公用單字」會保留原有個人修改；「重置全部資料」才會清除個人新增、設定與差異。

登入狀態確認、公用內容與個人差異完成後才顯示單字。載入失敗會清空個人畫面並提供重試。帳號、載入與写入各有過期檢查，舊請求不會把結果套到新帳號。

## 舊資料遷移與復原

- 相容 `folderIds`、`folderId`、`tags`、舊別名與 `deletedDefaults`。完整標籤覆蓋會依凍結的歷史標籤基準轉為增減差異。
- 遷移保留原標籤、完整來源文件及衝突來源於 `legacyTagBackup`、`migrationBackup`、`aliasMigrationBackup` 等欄位；別名文件也保留。舊根文件只加完成標記，不刪除原本 `words`、`folders`、`settings`。
- 新版標記使轉換可重複執行，不會每次載入重算、增加備份或重新導入已清除的舊覆蓋。多個舊 ID 衝突時按更新時間合併；同時保留各個原始來源，方便人工復原。
- 舊完整標籤快照无法證明「缺少標籤」是刻意移除，還是公用內容後來新增。遷移採保留舊快照相對於凍結基準的結果；基準之外的新公用標籤繼續繼承。不能宣稱完整還原當時意圖。
- 舊完整單字快照也無法區分「舊公用解釋」與「個人改寫」。不同於目前公用值的舊欄位採保守保留；使用者可用逐欄恢復取消不需要的覆蓋。
- 復原時可以使用保留的來源資料人工比較並寫回需要的個人差異。不要直接清除遷移標記或將整個根快照覆蓋回去，否則可能覆蓋遷移後的新修改。

## 驗證與預覽

本次結果：45 項資料／載入／帳號回歸測試通過，5 項真正的 Firestore Emulator 權限測試通過；資料驗證、CSS 建置、JavaScript 語法及 `git diff --check` 通過，`npm audit` 為 0 個已知漏洞。

實際瀏覽器操作已涵蓋 1366×900 桌面及 390×844 手機：搜尋與課程列表、訪客變更阻擋、個人空解釋、取消課程移除、逐欄恢復、隱藏／恢復、重新載入、A/B 帳號切換、登出及故障重試。兩個公開預覽的首頁與公用字庫回應 200，Git／設定／測試檔路徑回應 404。

在 `config/` 執行：

```text
npm test
npm run validate:data
npm run build:css
npm audit
npm run test:rules
```

一般回歸測試使用實際 app.js 與獨立的 Firebase／DOM 測試替身。Rules 測試使用真正的 Firestore Emulator，僅連本機 `demo-wordking-rules`；需要 Java 21+ 與 Firestore emulator JAR，可用 `WORDKING_JAVA_BIN` 和 `FIRESTORE_EMULATOR_JAR` 指定。它驗證本人 CRUD、跨帳號及未登入拒絕、集合查詢及公用路徑拒絕。

`npm run preview` 在 4173 提供實際網站；`npm run preview:demo` 在 4175 提供操作示範。示範讀取同一份網站程式，只替換 Firebase 為瀏覽器分頁內的測試資料；不存取真實帳號。可切換測試 A/B、模擬故障並重試。兩個預覽服務只公開網站資源，不提供 Git、設定或測試檔案下載。

瀏覽器檢查使用真實 Chromium 的桌面及 390×844 手機尺寸。實際网站以訪客狀態檢查；個人操作使用清楚標示的獨立測試帳號，搭配真實 emulator 權限測試，沒有改動真實使用者資料。Google OAuth 在暫時域名仍受 Firebase authorized domains 限制，這次沒有新增授權域名。

正式來源已確認為 GitHub Pages `stu310101-arch/wordking` 的 `main:/`，Firebase project 是 `wordking-434f7`。目前測試的是版本庫內的 rules，沒有將正式 Firebase Console 上的部署規則宣稱為已重新檢查或已部署。

已送往 Firestore 的提交無法取消；切換帳號會阻止後續交易／批次及過期結果套用。若大量同步已部分完成，沿用既有版本恢復及兩分鐘同步鎖過期機制。舊分頁若仍執行舊版程式，也應在正式發布後重新整理。
