# Schema 5 瀏覽器實測紀錄

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
- 本次交付暫時預覽：https://quality-architects-autumn-supplemental.trycloudflare.com 。網址透過本機 demo 的暫時通道提供，電腦／網路與通道需持續運作；失效時重新建立通道即可，不影響 Git 或 Firestore 資料。

目前未推送 GitHub、未部署正式 Firebase rules，也未對真實使用者執行 migration。
