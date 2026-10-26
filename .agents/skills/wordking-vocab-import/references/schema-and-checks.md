# 單字王現有結構與檢查指引

此文為 Skill 參考，不取代 GitHub 最新的程式與架構文件。匯入前讀取現行倉庫的 `DATA-ARCHITECTURE.md`、`assets/word-data.js`、`data/words.json` 及測試。

## 公用字庫 canonical model（schema 6）

範例為已確認的詞，不代表新的 ID 配發起點：

```json
{
  "id": "w_000554",
  "english": "extension",
  "meanings": [
    {
      "partOfSpeech": "noun",
      "definitions": ["延期", "延長", "擴大"]
    }
  ],
  "lessonIds": ["死神單字L5U10"],
  "isWrong": false
}
```

- `data/words.json` 是公用 **array**，不是 map。
- 同英文字（`trim().toLowerCase()`）不可出現兩次；既有字沿用 `w_######` 而非重新新增。
- `meanings` 是依詞性分組的陣列；`partOfSpeech` 是 `noun`、`verb`、`adjective`、`adverb`、`pronoun`、`preposition`、`conjunction`、`interjection`、`other`、`determiner`、`article`、`numeral`、`auxiliary`、`phrase`；同一詞性只一組，依 `PARTS_OF_SPEECH` 排列。
- 中文意思用 `definitions: string[]`，不要新增舊欄位 `meaning`、頂層 `partOfSpeech`、`tags`、`folderId`。
- 原有 `lessonIds` 與 `isWrong` 都要保留。單一英文可以同時屬於多回。
- 新公開 ID 從最新**未配發**的值開始；對照歷史 Git commit 與現有 ID；不要單靠此範例的數字。
- 新課程向 `assets/word-data.js` 的 `PUBLIC_LESSONS` 增加登記。課程 ID 不等於可任意更名的 UI 字串；照使用者提供的精確字串新增，並避免覆蓋既有 ID。
- `migration/` 是歷史凍結來源，不能修改；也不要直接替使用者改 Firestore 個人狀態。

## 核對與回歸測試

在倉庫根目錄：

```bash
cd config
npm run validate:data
npm test
```

`npm run validate:data` 對應 `config/validate-words.cjs`，會檢查舊 schema 映射與 catalog。測試包含 `tests/word-data.test.cjs`，其中可能有「當時字庫總數、課程集合、既有單字的課程歸屬」等硬編碼。每次新增課程時，必須以真實新增／沿用數量更新測試，同時保證初始歷史凍結映射仍不變；不要只把計數改成新數字而忽略既有 ID 的 `lessonIds` 擴充。

若環境無法跑 Node 測試，明確列出「有進行靜態驗證／未執行本機測試」，不能聲稱測試通過。

## 來源辨識稽核回報模板

```text
課程：<使用者指定完整課程名稱>
照片與單字數：<頁數／欄數／英文數>
可直接入庫：<數>
待確認：<數>
- <英文>｜<頁/欄/列>｜不確定的中文或詞性｜目前看得到的筆劃｜候選解讀（僅為猜測）
沿用既有 ID：<數>
新 ID：<數>
是否已發布、提交 SHA：<結果>
```

當一筆詞條含低於 90% 的任何欄位，該詞條仍算待確認，不能當作已完整辨識。
