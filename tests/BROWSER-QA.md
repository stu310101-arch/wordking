# Schema 6 瀏覽器實測紀錄

## 2026-09-07 詞性分組與直接新增資料夾

真實 Codex in-app Chromium，桌面 1366×900、手機 390×844。使用這次分支的原始資產與隔離 fixture；下面的單字修改與新增只發生在測試帳號的 sessionStorage。沒有增加公用 entity。

| 操作 | 實際結果 |
| --- | --- |
| 訪客、A 舊帳號載入 | 完整載入公用與個人資料，舊的私人內容可顯示 |
| 桌面 abuse 搜尋／卡片翻面 | 顯示英文與名詞、動詞各自的中文；翻面功能保留 |
| 編輯名詞、保留動詞 | 只修改名詞框，動詞的原始中文保留；重開編輯視窗結果一致 |
| 直接連續新增兩個私人資料夾 | 「分組複習」「考前整理」立即勾選；原課程、中文草稿、待複習勾選保留；儲存後兩夾各有該字 |
| A → B → visitor → A | B 與 visitor 顯示公用中文，不含 A 的資料夾；回到 A 保留個人分組 |
| 390px 手機搜尋 | 候選框寬 352px，document scrollWidth 不超過 clientWidth |
| 手機編輯與資料夾區塊 | 可垂直捲動到完整內容、新增及儲存按鈕，沒有橫向溢出 |
| 新增／移除第三個詞性組 | 新組使用未使用詞性，移除後原有名詞、動詞內容保留 |
| 新增資料夾後取消 | 「取消測試」草稿未出現在重新開啟的編輯視窗或單字庫 |
| 恢復公用各詞性中文意思 | 回復名詞／動詞公用內容，保留兩個私人資料夾、原課程及待複習 |
| 手機拼字 | 選「分組複習」中的 abuse，兩組中文提示正常；回答 abuse 判對，結算 0 錯誤 |
| 手機英選中 | gut 題目與多詞性完整選項排版正常；選「名詞：內臟；膽量／動詞：取出內臟；毀損；拆除內部」判對 |
| 手機新增 custom word 與 folder | groupfixture 使用不同名詞／動詞內容；動詞換行輸入轉成兩個 definitions；「手機新資料夾」儲存後可開啟 |
| 刪除該 custom word | 該測試字消失，資料夾保留並顯示空狀態 |
| 原始 Firebase 前端訪客（4173） | 保留真實 SDK imports，未登入即可搜尋 compact，分別顯示名詞、動詞、形容詞中文 |
| 瀏覽器錯誤 | 原始前端與 fixture 均未出現 console error / warning |

本次自動測試為 89 項 Node 測試、8 項實際 Firestore Emulator 測試，全部通過。新增驗證 v5 完成後升級、不復活舊資料、v5 journal 接續、v6 staging 故障重試、已完成 v6 再次規劃、分組轉換與資料夾草稿交易。資料驗證另確認 429 個原始 ID、英文、446 個課程歸屬與 isWrong 基底均維持一致。

## Schema 5 階段的既有實測紀錄

日期：2026-09-06 至 2026-09-07（Asia/Taipei）。使用真實 Chromium / Codex in-app browser，桌面 1366×900、手機 390×844。驗證的是此次分支的原始網站資產；個人操作透過隔離 Firebase fixture，沒有登入或改寫正式帳號。

## 已完成操作

| 操作 | 觀察結果 |
| --- | --- |
| 原始前端訪客載入（4173，保留實際 Firebase SDK import） | 首頁與搜尋正常，penetrate 顯示公用「穿透；滲透」，無 console error / warning |
| A 舊帳號首次登入 | 載入完成後顯示「A 的私人解釋：穿透」與私人資料夾，舊課程移除、alias 修改與 custom word 保留 |
| 桌面編輯公用字 | 個人中文、noun + verb、U8 與待複習可儲存，再開表單狀態一致 |
| 恢復單一中文欄位 | 中文回到公用值，其他詞性、課程與待複習修改保留 |
| 恢復整筆公用內容 | 中文、課程及私人 folder membership 回到公用基底 |
| 個人隱藏與設定恢復 | 隱藏字移出顯示；恢復後重新出現在 U6 與搜尋 |
| 手機表單 | 詞性複選、課程選擇、儲存按鈕可操作，彈窗可垂直捲動，沒有橫向溢出 |
| 手機修改 penetrate | 儲存「手機測試：只屬於 A」、noun + verb、U6 + U8、待複習 |
| A → B → A → visitor | B / visitor 顯示公用意思與 U6；A 保留個人意思與 U6 + U8，舊帳號資料不閃回 |
| 手機搜尋候選 | 英文、中文與課程名稱正常，候選框在 390px 視窗內 |
| 手機拼字 | 單選 abolish，回答 abolish 顯示答對，結算 0 錯題 |
| 手機英選中 | destination 的「目的地 (n.)」可選，正確判分、按鈕與回饋正常排版 |
| 模擬讀取故障 | 私人頁面被載入錯誤畫面取代，不留可操作的私人資料；提供重試 |
| 恢復網路後重試 | 恢復 A 完整資料與待複習；fixture 控制列可在載入遮罩上操作 |
| 手機新增 custom word / folder | mobilefixture、名詞、「手機私人資料夾」可儲存與重新開啟 |
| 刪除 custom word | 新單字消失，私人資料夾保留且顯示空狀態 |
| 公開預覽重置 A、重新整理 | penetrate 重新繼承公用意思與 U6，舊 alias / root 不復活 |
| 重置後 recovery | 設定仍顯示「下載我的遷移備份」；按鈕觸發匯出，無 console error |
| 公開網址資產与範圍 | index、三個資料模組、catalog、mapping 可載入；.git、config、tests 回傳 404 |

## 自動測試與實測的分工

79 項 Node 測試涵蓋純模型、所有 legacy fixture、app 資料 API 接線、Auth 切換、revision 衝突、staging 失敗、批次中斷、lost acknowledgement、lease takeover、Unicode 備份 round-trip、重複遷移與重置。7 項實際 Firestore Emulator 測試涵蓋本人 CRUD、跨帳號／匿名拒絕、查詢隔離、備份子路徑、禁止公用 cloud 寫入、舊 client fence 及真正 atomic commit。

瀏覽器 fixture 不模擬 Google OAuth 安全提示，也不代表正式帳號已經遷移。真實登入及正式環境端到端驗證仍需在發布後使用獲授權的測試帳號進行。手機驗證為響應式 viewport，非實體 iOS / Android 鍵盤或語音引擎測試。

## 預覽方式

- 本機隔離 demo：`npm run preview:demo`（在 config 執行），http://127.0.0.1:4175 。工具列 A / B / 訪客都只使用該分頁的 sessionStorage。
- 原始前端訪客：`npm run preview`，http://127.0.0.1:4173 。此版本包含真正 Firebase 設定，驗證時只使用未登入訪客。
- 本次交付暫時預覽：https://dee-washing-pavilion-criterion.trycloudflare.com 。網址透過本機 demo 的暫時通道提供，電腦／網路與通道需持續運作；失效時重新建立通道即可，不影響 Git 或 Firestore 資料。先前 quality-architects-autumn-supplemental 與 pet-doug-jewelry-installed 網址已失效。

目前未推送 GitHub、未部署正式 Firebase rules，也未對真實使用者執行 migration。
