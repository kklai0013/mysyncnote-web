# MySyncNote

MySyncNote 是一個直接編輯本機 Markdown 資料夾的離線優先 PWA。筆記保持為一般的 `.md`、附件與相容 JSON Canvas 的 `.canvas` 檔案；Google Drive 同步交給 FolderSync 或其他資料夾同步工具。

正式網址：<https://kklai0013.github.io/mysyncnote-web/>

## 第一次使用

1. 使用最新版 Chrome 或 Edge 開啟正式網址。
2. 按「開啟筆記庫」。
3. 選擇存放 Markdown 筆記的資料夾並允許讀寫。
4. 手機若重新開啟後顯示「重新連線」，只需點一次並重新允許該資料夾；不必重新尋找資料夾。

## FolderSync

MySyncNote 不登入 Google 帳號，也不使用 Google API。請在 FolderSync 建立資料夾配對，將 Google Drive 上的筆記資料夾同步到手機本機，再讓 MySyncNote 開啟同一個本機資料夾。

MySyncNote 回到前景時會重新掃描筆記庫。若正在編輯的檔案被 FolderSync 改動，會要求選擇保留目前版本、載入外部版本或保留兩份。

## 主要功能

- 巢狀資料夾、筆記、Canvas 的新增、改名、移動、刪除與垃圾桶
- 自動儲存、外部修改偵測、分頁、搜尋、命令面板
- Markdown 編輯、閱讀與並排預覽、圖片貼上、附件拖放、YAML 屬性
- Wiki Link、自動完成、嵌入、反向連結、未連結提及、標籤與大綱
- 全筆記庫與局部關聯圖譜、資料夾／標籤篩選、孤立及缺失筆記
- 相容 JSON Canvas 的文字卡片、筆記卡片、群組、連線、平移與縮放
- 桌面和手機自適應介面、PWA 安裝與離線程式介面

## 快捷鍵

- `Ctrl+S`：立即儲存
- `Ctrl+P`：命令面板
- `Ctrl+K`：搜尋筆記庫
- `Ctrl+N`：新增筆記
- `Ctrl+G`：關聯圖譜
- `F2`：重新命名目前選取的檔案或資料夾
