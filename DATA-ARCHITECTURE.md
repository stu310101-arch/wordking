# 單字王資料架構：schema 5

本文件描述這次重構後的程式與 migration 協定。正式網站目前由 GitHub Pages 的 `main:/` 發布（https://stu310101-arch.github.io/wordking/），Firebase project 為 `wordking-434f7`。本次驗證使用隔離 fixture 與 Emulator；尚未執行正式帳號 migration，也未部署正式網站或 rules。

## 改動前的資料流

```mermaid
flowchart LR
    C[公用 words.json + tags] --> M[合併 state.words]
    A[舊 ID / alias / 凍結 tags baseline] --> L[app.js 相容與遷移]
    F[Firestore 私人文件 / root snapshot] --> L
    L --> M
    M --> U[UI / 搜尋 / 練習]
    U --> E[直接修改完整 state.words]
    E --> D[比對 before / after 與 public base]
    D --> W[反推 override 與 tags diff]
    W --> F
```

原本的 public + per-user override 方向保留。此次移除的是合併單字作為唯一寫入模型、runtime `tags` / `folderId` / `defaultId` 相容別名、UI 中的舊 ID 解析與 Firestore 文件組裝，以及從 meaning 猜詞性的練習邏輯。

## 新資料流與檔案邊界

```mermaid
flowchart TD
    C[data/words.json] --> P[PublicCatalog]
    F[Persistence.load] --> S[UserWordState]
    H[migration/ 凍結來源：僅舊帳號需要] --> M[Migration.createMigrationPlan]
    M --> F
    P --> V[DerivedView / deriveEffectiveWords]
    S --> V
    V --> U[UI / 搜尋 / 拼字 / 選擇題]
    U --> A[明確操作：updateWordOverride / setWordLessons 等]
    A --> S
    S --> W[Persistence.save：canonical snapshot 差異]
    W --> DB[users/uid 私人文件]
    DB --> F
```

| 邊界 | 實作 | 責任 |
| --- | --- | --- |
| PublicCatalog | `assets/word-data.js`、`data/words.json` | 驗證唯一英文與 opaque ID、提供不共享可變引用的公用基底 |
| UserWordState | `assets/word-data.js` | 每個帳號一個 instance，直接操作 sparse overrides、custom words、hidden IDs、folders、settings |
| Migration | `assets/migration.js`、`migration/` | 集中解讀所有 legacy 欄位、ID 與凍結基準；pure planner 無 I/O |
| Persistence | `assets/persistence.js` | 唯一知道 collection 路徑、讀寫、revision、lease、journal、backup 的邊界 |
| DerivedView | `deriveEffectiveWords()`、`app.js` 的 `refreshDerivedView()` | 產生完整單字、資料夾檢視鍵與顯示名稱 |
| UI | `assets/app.js`、`index.html` | 使用模型 API；維持原有頁面、搜尋、練習及 Google Auth 流程 |
| 檢查 | `config/validate-words.cjs`、`tests/` | 靜態資料、凍結檔案、隔離、遷移失敗點、同步及 rules 驗證 |

三個資料模組都可以直接被 Node 測試載入，無須 Firebase 或 DOM。Persistence 使用 Migration 匯出的純 canonical snapshot validator；只有缺少 v5 完成標記且存在舊資料時才執行 legacy planner 或下載歷史 JSON。

`state.words` 與 `state.hiddenWords` 僅是 derived view。`commitUserMutation(model => …)` 保存模型 snapshot 供交易差異與錯誤 rollback 使用，不從完整公用單字反推 override。Firestore collection 名稱與 legacy mapping 不出現在 UI 操作程式。

## Canonical word

公用庫現在有 **429 筆唯一英文、446 個課程歸屬**。同一英文的大小寫變體視為同一 entity；`english.trim().toLowerCase()` 重複會被驗證拒絕。修改英文、中文或課程都不改 ID。

```json
{
  "id": "w_000001",
  "english": "penetrate",
  "meaning": "穿透；滲透",
  "partOfSpeech": ["verb"],
  "lessonIds": ["晟景Lv5U6"]
}
```

公用 JSON 不含 `source`、`tags`、`folderId`、`folderIds` 或 `defaultId`。公用資料的 `isWrong` 為 false，省略時模型同樣提供預設 false。有效單字的 `source: public/custom` 只在 view 存在。

採用 `meaning: string` + `partOfSpeech: string[]`，讓現有卡片與練習維持簡單資料介面。多義以 `；` 分隔，多詞性仍屬於同一 word。已把歷史 `(v.)`、`(n.)`、`(a.)` 等詞性註記轉為結構化欄位；一般解釋括號不移除。UI 詞性改為複選，練習只讀 structured POS，不再從 meaning 推論。

詞性可用：noun、verb、adjective、adverb、pronoun、preposition、conjunction、interjection、other、determiner、article、numeral、auxiliary、phrase。

### ID 配發與歷史保留

- 已一次性配發 `w_000001` 至 `w_000429`；初次配發基準及 SHA-256 都已凍結，不能從目前英文、課程或排序重新產生。
- 446 個歷史 ID（含 17 個課程 alias）各保留 encoded / decoded 形式，共 **892 個 mapping keys**。
- 新公用字配發下一個未用過的 ID，第一次之後永遠保留；不要回收 ID 或以另一個字覆蓋舊 identity。初始下一號為 `w_000430`，後續請根據完整 Git 配發歷史選號，不能反覆使用凍結檔的初始下一號。
- 發布後的公用字應保留 identity；驗證器禁止刪除初始 429 個映射目標。需要更正英文時改原筆。
- custom word / folder 的 UI 新增使用 `c_` / `f_` + UUID；名稱更改不影響 ID。舊 custom / folder ID 可保留；公用 `w_` namespace 不給 custom 使用。

## 個人 Firestore schema

所有 client 私人資料都位於 `users/{uid}`，不建立可寫公用 Firestore catalog。實際公用內容隨網站 Git 發布；登入者無法透過 Firestore 寫入 `data/words.json`。

| 路徑 | 內容 |
| --- | --- |
| `users/{uid}` | `schemaVersion: 5`、`revision`、`syncFence`、暫時的 `syncLock`、`migrationV5`，保留原 root snapshot |
| `wordOverrides/{publicWordId}` | 只存個人欄位與課程增減、私人 `folderIds` |
| `customWords/{customWordId}` | 完整私人內容，不含 `id`、`source`、public base |
| `hiddenWords/{publicWordId}` | 文件存在即隱藏；僅 schema 與更新時間 metadata |
| `folders/{folderId}` | `{name, schemaVersion, updatedAt}` |
| `settings/main` | 個人設定，含 `hiddenLessonIds`、課程顯示名稱及音效 |
| `migrationBackups/{runId}` | migration / 大量寫入 journal 的狀態、cursor、批次數及備份段數 |
| `migrationBackups/{runId}/entries/{n}` | 分段 JSON 原始私人來源與衝突報告 |
| `migrationBackups/{runId}/chunks/{n}` | 可重複接續的 canonical 文件操作 |

一般 canonical 文件由 Persistence 加入 `schemaVersion: 5`、ISO `updatedAt`。時間僅供診斷；衝突判定使用 Firestore transaction、revision 與 fence，不依賴各裝置時鐘排序。

```json
{
  "meaning": "我的解釋",
  "addedLessonIds": ["晟景Lv5U8"],
  "removedLessonIds": ["晟景Lv5U6"],
  "folderIds": ["f_個人資料夾ID"],
  "isWrong": true,
  "schemaVersion": 5,
  "updatedAt": "2026-09-06T00:00:00.000Z"
}
```

`lessonIds` 是教材／課程 identity。`folderIds` 是私人 folder document ID，顯示名稱可重複，也可以和某課程同名。view 使用 `lesson:<id>` / `folder:<id>` 區分，不把這些 view keys 存進 canonical word。使用者自訂的新資料夾歸入 folder，不會偷偷建立公用課程。

課程計算：`(public.lessonIds ∪ addedLessonIds) − removedLessonIds`。曾移除、目前暫不在公用庫的課程 ID 仍保留於 diff；未來公用庫重新加入時維持使用者意圖。私人 folder membership 獨立計算。

未修改欄位繼承最新公用值。明確的空 meaning、空 POS 或 `false` 都有效。使用者明確設回公用值時刪除該 override 欄位；最後一個差異消失就刪掉文件。若公用更新剛好追上既存的個人值，不能自動推定使用者已放棄個人意圖，因此不在一般載入時清除該 scalar override。

custom word 存完整 `english`、`meaning`、`partOfSpeech`、`lessonIds`、`folderIds`、`isWrong`。新增與更名都拒絕和有效公用字、隱藏公用字或其他 custom word 產生相同英文。

## 資料 API 與恢復行為

```js
const account = WordKingData.createUserWordState(publicCatalog, snapshot);
account.getPublicWord(id);
account.getWordOverride(id);
account.getEffectiveWord(id); // 預設可供隱藏字的編輯／恢復使用
account.deriveEffectiveWords(); // 預設排除隱藏字
account.updateWordOverride(id, { meaning: '新的個人解釋' });
account.clearWordOverrideField(id, 'meaning');
account.clearWordOverride(id);
account.setWordLessons(id, ['晟景Lv5U8']);
account.setWordFolders(id, ['f_example']);
account.hidePublicWord(id);
account.restorePublicWord(id);
account.createCustomWord('c_example', { english: 'example', meaning: '例子', partOfSpeech: ['noun'] });
account.updateCustomWord('c_example', { meaning: '我的例子' });
account.deleteCustomWord('c_example');
account.setFolder('f_example', { name: '考前複習' });
account.exportState();
```

- 「恢復公用中文意思」等操作只清除該欄位；課程、資料夾及錯題狀態保留。
- 「恢復此字全部公用內容」清除整筆 override（含私人資料夾 membership），重新繼承公用值。
- 隱藏與恢復隱藏只操作 hidden ID；恢復後仍有原個人 override。
- 刪 custom word 只刪本人的 custom document。
- 重置帳號清除現行私人 overrides、custom words、hidden words、folders 與設定差異；保留 migration 完成標记及 recovery backup，避免舊 root / alias 復活。
- 如果公用英文更新日後與已存在的個人更名／custom word 衝突，模型會拒絕套入該組資料，保存原始資料供處理，不自行刪字或靜默改名。公用解釋、POS、課程的正常更新不受此限制。

## 保守 migration 協定

### 來源與轉換

`migration/` 保留原始 `legacy-catalog.json`、`legacy-word-id-aliases.json`、`legacy-lessons/`；新增固定 `legacy-word-id-map.json`、`legacy-tag-baseline.json` 與 `frozen-sources.json`。共 14 個凍結來源檔以 SHA-256 驗證。移動歷史檔沒有刪除 recovery 內容。

`.gitattributes` 禁止 Git 對 `migration/**` 自動轉換換行，確保 Windows、Linux 與 GitHub checkout 的 recovery checksum 一致。

正常訪客只下載 `data/words.json`。已完成 v5 的帳號只讀私人 canonical collections / settings 及同步 metadata，不下載任何歷史 JSON，也不讀 `deletedDefaults`。新空帳號只寫完成標記，不複製公用字庫，也不載入歷史檔。

舊帳號缺少 v5 完成標記時，讀取 root、wordOverrides、customWords、deletedDefaults、hiddenWords、folders、settings。planner 使用固定舊基準，不拿今天的解釋／課程當成「當時使用者沒有修改」的證據。

1. 文件路徑 ID 優先於 payload 的 `id`。所有已知舊 ID / alias 轉成固定 opaque ID；encoded / decoded alias 的權威重設判定一致。
2. 最早無 ID 的 root words 只可依凍結的舊 English 找 identity；找不到但有完整英文的資料保留為 deterministic custom word。
3. root 若已有 `migratedToDiffStorageAt`，不再匯入其保留快照，避免覆蓋後來修改或復活已刪資料。
4. 舊 `folderIds` / `folderId` / `tags` 的完整集合用凍結 baseline 判定課程增減。舊 runtime 同時攜帶的 `lessonIds` 不凌駕完整 memberships；只有獨立 `lessonIds` 輸入才當成課程集合。custom 的明確 lessonIds 與拆分結果合併。
5. schema 2 的 `addedTags` / `removedTags` 拆成課程 diff 與私人 folder。未知分類保留為私人 folder；同名課程與已知私人 folder 同時保留並記錄歧義。
6. 舊 alias 的 scalar 衝突依來源優先級與歷史 timestamp 決定有效值，原值全留備份；新版 authoritative reset 可壓過陳舊 alias。舊隱藏 true / false 衝突採可見值，v5 hidden document 存在則優先隱藏。
7. 相同英文的 custom / public 或 custom / custom 合併中文、詞性、歸屬及錯題，不建立第二 entity。相互衝突的公用更名保留在 recovery，其他個人欄位照常遷移。未知 sparse override、無法解析的資料與所有未知欄位都留在原始備份並列入報告。
8. 整體結果通過真正的 UserWordState 驗證後才允許開始寫入；未支援的未來 schema 或不合法模型在寫入前失敗。

完整 memberships 中缺少某舊課程，無法百分之百分辨是當時同步殘缺還是本人移除。這是歷史資料的資訊限制。採凍結 baseline 的既有語意，保留全部來源讓使用者可復原，不使用今天公用課程倒推意圖。

### 寫入與失敗重試

1. 同一帳號取得 root revision 與 lease，租期 120 秒，每批延長；`fence` 單調增加。root 此時升為 schema 5 / preparing，rules 開始拒絕舊協定寫入。
2. 先將所有私人原始來源、未知欄位及 conflicts 序列化備份，再寫 frozen operation chunks，最後才標記 journal ready / migration applying。
3. 每批最多 180 個操作，序列化約 600 KB 上限。每個 transaction 先讀 root、journal、chunk，完成全部 reads 才 writes；原子更新 cursor 與資料。單一過大資料會停止，原始來源不刪除。
4. 最後 transaction 才將 `migrationV5.status` 設 complete、revision +1、記錄 `lastOperationId` 並移除 lease。reader 不顯示 applying 期間的半套資料。
5. 中斷時保留 journal。lease 過期後重試接續同一 frozen plan 的 cursor；舊 worker 的 fence 不符便不能繼續寫。ready 前失敗尚未碰 canonical 文件，可重建計畫。最後提交成功但回應遺失也不會重複匯入。
6. 同一筆 custom / folder / settings 需要換格式時，只有完整備份 ready 後才覆寫；root 原始陣列、舊 alias / deletedDefaults 文件不提前刪除。v5 loader 只讀 schema 5 文件，不把保留的舊文件當成現行資料。

一般小筆修改用單一 revision-guarded transaction；大量刪除／重置使用相同 journal 流程。Firestore 交易 callback 可能重試，因此 callback 只進行可重入的資料操作。設計依據：[Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions)、[Firestore quotas](https://firebase.google.com/docs/firestore/quotas)。

### 復原與清理

設定中的「下載我的遷移備份」呼叫 owner-scoped `Persistence.exportRecovery()`，將原始來源與 conflicts 下載為 JSON。備份不含每人一份公用 catalog。

不要人工刪除 applying 狀態的 lease / chunks，也不要直接刪完成標記以重跑舊 root。若 journal 不完整或出現未知未來 schema，載入停止並保留來源，需要先檢查該帳號 recovery。程式不含自動 TTL 清理或全站批次 migration。

在有全帳號完成證據、可還原備份及另行確認清理範圍之前，保留 `migration/` 和 Firestore recovery。尚未登入的舊帳號沒有被此次本機驗證自動遷移。

## Auth、跨裝置與 rules

公用 catalog 和登入狀態確認可平行開始，但 UI 顯示必須等公用及個人資料全部完成。個人載入失敗會清除顯示內容並提供重試。切換帳號立刻清掉私有模型、設定、編輯狀態和練習；每次讀取、migration、transaction、延遲練習 callback 都有 session / load / game generation 防護。

寫入使用 expectedRevision，收到其他裝置的 revision 變更會要求重載。讀取前後比對 root revision / migration marker，避免套用混合版本。未完成寫入或回應遺失會要求重載，不擅自宣告寫入成功。

`config/firestore.rules` 限制本人 CRUD 自己 subtree、拒絕 A 讀寫 B、拒絕未登入讀 private data、拒絕 `/users` enumeration 與其外全部路徑。升級 v5 後拒絕 schema 2 / 4 canonical 寫入、舊 deletedDefaults 新寫入、舊 lease acquire / cleanup 協定及 root 降版。recovery 子路徑同樣 owner-only。

**發布順序：先部署並確認新 rules，再發布包含全部 JS / catalog / migration 資產的前端。** 新 rules 對尚未升級帳號仍相容；開始 migration 後會擋住舊分頁。不能以回退到舊 schema 4 前端作為已完成 v5 帳號的 rollback，應修正 v5 client，保留 checkpoint / backup 接續。

## 驗證與重現

```powershell
cd config
npm test
npm run validate:data
npm run build:css
npm run test:rules
npm audit
cd ..
git diff --check
```

rules runner 使用 Java 21+ 與官方 Firestore Emulator；可透過 `WORDKING_JAVA_BIN` 指定 Java executable。測試不連正式資料庫。

目前資料／UI 接線／migration／persistence／Auth 測試 79 項，Firestore Emulator 測試 7 項。涵蓋 opaque ID 穩定、同英文唯一、多 POS、A/B/visitor 隔離、不可 mutate public、public update / field reset、課程 diff / 同名資料夾、custom CRUD、hide/restore/reset、所有舊欄位與 alias/root、重複 migration、staging / 中途批次 / 最後 ack 故障、lease takeover、revision 衝突及 stale session。

`npm run preview` 在 loopback 4173 提供原始網站；`npm run preview:demo` 在 4175 使用原始網站資產，僅將 Firebase import 替換成瀏覽器內隔離 fixture。測試工具列提供 A / B / 訪客、故障與恢復網路。fixture 使用 sessionStorage，不會連真實 Google 帳號或 Firestore，頁面對外預覽也沒有私人帳號資料。伺服器白名單不公開 `.git`、設定、tests 或工作區其他檔案。

桌面 1366×900 與手機 390×844 用真實瀏覽器驗證。Google OAuth 的正式登入 popup 與正式帳號的 migration 不在 fixture 測試的證明範圍；發布後須以授權測試帳號確認。詳細實測紀錄見 `tests/BROWSER-QA.md`。
