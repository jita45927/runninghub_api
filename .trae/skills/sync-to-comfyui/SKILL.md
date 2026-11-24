---
name: sync-to-comfyui
description: Sync UI changes from runninghub_api to COMFYUI_api. Use when the user asks to sync modifications to the ComfyUI project, port changes, or keep the two projects consistent. Do not use for ComfyUI-only changes.
---

# Sync runninghub_api → COMFYUI_api

> **Independence first.** runninghub_api and COMFYUI_api are two **separate, independent applications**. Each owns its own complete set of files and folders. They do **NOT** share any files, folders, symlinks, or directories. "Synchronization" here means **replicating UI/feature changes** by copying the updated files from runninghub_api into COMFYUI_api as independent copies — never by referencing, linking, or mounting the other project's files.

Both projects implement the same UI design but with different backends:
- **runninghub_api** calls the RunningHub website API (Bearer key, v2 endpoints).
- **COMFYUI_api** calls an intranet-tunneled ComfyUI API (`/prompt`, `/history`, `/upload/image`, `/view`).

All UI design and frontend logic must stay identical. Only the API-call layer and its immediate adapters differ. Treat each project as self-contained; the source of truth for shared UI is runninghub_api, and COMFYUI_api receives verbatim copies.

## 1. File classification

### 1.1 Shared core — copy verbatim from runninghub to COMFYUI
Maintain these only in runninghub_api. Overwrite the ComfyUI copies unchanged.

```
css/style.css
js/store.js
js/ui/form.js
js/ui/toollist.js
js/ui/results.js
js/ui/lightbox.js
js/ui/maskeditor.js
js/ui/modal.js
js/ui/home.js
js/covers.js
```

`sync-core.ps1` at the repo root covers the first 8; `home.js` and `covers.js` must be copied manually (the script does not list them yet). Always back up the ComfyUI originals into `.core_backup_<timestamp>/` first.

> **⚠ 不同步：系统工具隐藏 / 复制（仅 RunningHub）**
> `toollist.js` 中的 `toolSourceOf` / `setToolTombstone` / `copyToolToUser` 调用、「系统 / 我的」来源徽标、回收站墓碑隐藏、永久移出与「重置系统工具」相关逻辑只属于 runninghub_api，**严禁同步到 COMFYUI_api**。同步 `toollist.js` 时只移植通用 UI 行为（如运行中/排队中/最近完成状态高亮），保留 ComfyUI 现有的回收站实现；否则会因 ComfyUI 的 `tools.js` 缺少上述导出而运行报错。`style.css` 中对应的 `.tool-source`、`.tool-copy` 样式同样无需同步。

### 1.2 Project-specific — adapt, do NOT copy verbatim
```
server.py
js/api.js
js/config.js
js/tools.js
js/main.js
js/runner.js
js/ui/panels.js
js/ui/fieldtypes.js
index.html
启动工具.bat
README.md
ICO/
```

## 2. Adaptation rules

### 2.1 Tool config format (`tools.js`, server endpoints)
- File extension: `.rhtool.json` → `.tool.json`
- JSON `type`: `runninghub-tool-config` → `comfyui-tool-config`
- Replace `webappId` / `instanceType` with `workflow` (the ComfyUI API-format workflow object).
- Dedup key: RunningHub dedups by `webappId`; ComfyUI has no webappId, so dedup by `name`.
- Config must carry `id`; if missing, auto-generate.
- Recycle-bin state is persisted via `"deleted": true` in the JSON.

### 2.2 `server.py` endpoints
Endpoints that must exist in **both** projects (same request/response shape):
- `POST /save-tool` body `{file, oldFile, content}` — writes config; delete old file on rename; clean duplicate configs of the same tool.
- `POST /delete-tool` body `{file}` — removes config file AND its cover.
- `POST /save-cover?name=<base>` body = image bytes — saves cover, removes opposite extension.
- `POST /rename-cover` body `{old, new}`.
- `POST /save-image` body `{url, filename}` — server downloads result into the configured download dir.
- `POST /shutdown`.
- `POST /open-url?u=` — open in the system default browser and bring its window to the foreground.
- `GET /appinfo` — returns `{tools, download, session}`.
- `GET /open-dir`, `GET /pick-download-dir`.

ComfyUI-only endpoint: `/* /comfy-proxy/*` — reverse proxy to ComfyUI; target from `X-Comfy-Base` header, auth from `X-Comfy-Auth`.

RunningHub v2 API calls (`/openapi/v2/run/ai-app/{appId}`, `/openapi/v2/query`, `/openapi/v2/media/upload/binary`) live in `js/api.js`, never in `server.py`.

### 2.3 `js/api.js` — completely different, never sync
- RunningHub: `Authorization: Bearer <key>`, v2 task submit/query, binary media upload.
- ComfyUI: `/prompt`, `/history/{id}`, `/upload/image`, `/view`, `/interrupt`, `/queue`, all through `/comfy-proxy/`.

### 2.4 `js/config.js`
- Keep `FIELD_TYPES`, `ICON_OPTIONS`, `LS.*` keys structurally aligned.
- ComfyUI registers `model`/`combo` field types via `js/ui/fieldtypes.js`.

### 2.5 `js/tools.js`
- `toolToConfigJSON`: emit ComfyUI format (`type`, `name`, `icon`, `desc`, `sourceUrl`, `tags`, `workflow`, `fields`, `deleted`).
- `toolFileName`: extension `.tool.json`.
- `persistTool` / `removeToolFile`: prefer server endpoints; fall back to File System Access API.
- Keep ComfyUI helpers: `isApiWorkflow`, `isUiWorkflow`.

### 2.6 `js/main.js`
- Import `./ui/fieldtypes.js`.
- Use `refreshServerBtn` (ComfyUI) instead of RunningHub key/settings button.
- Keep `initExternalLinks`, `initQuitButton`, setup-wizard flow, single-step download-dir selection.
- No repo-copy button (RunningHub-only).

### 2.7 `js/runner.js` — adapt execution, preserve UI behaviors
- RunningHub: submit task → poll query → fetch media.
- ComfyUI: upload images → queue prompt → poll history → fetch view.
- Shared UI behaviors that must survive:
  - Recycle-bin guard (`if (tool.deleted) return`).
  - Result batch history: `appendResultBatch`, `showResultNotice`, `restoreResultsSession`/`saveResultsSession` keyed on server `session`.
  - Auto-download via `/save-image` in server mode; fall back to dir handle then `<a download>`.
  - Run/cancel button states; only re-enable run button when current tool is not in trash.

### 2.8 `js/ui/panels.js` — keep app-specific panels
- RunningHub: RunningHub key management, app-specific fields.
- ComfyUI: server-address management, workflow import, model/combo settings.
- Both must expose an `appPanel` with: `openTool`, `validateTool`, `afterToolSave`, `toolData`, `initToolPanel`, `initSettings`, and a `refresh*Btn`.

### 2.9 `index.html`
- Logo: RunningHub `ICO/RAPI.ico`; ComfyUI `ICO/COMFYAPI.ico`.
- RunningHub has `keyBtn`; ComfyUI has `serverBtn`.
- Keep shared markup: `bootWarn`, `quitBtn`, setup-wizard IDs (`setupStepToolsDir`, `setupToolsDirStatus`, `setupStepDownloadDir`, `setupDownloadDirStatus`, `grantToolsDirBtn`, `grantDownloadDirBtn`, `toolsDirPathHint`, `dlAuthHint`), `tSourceUrl`, tool modal fields.

### 2.10 `启动工具.bat`
- `Add-Type -AssemblyName System.Windows.Forms` before `FolderBrowserDialog`.
- Kill old server process on the port before starting (Windows SO_REUSEADDR lets two servers coexist).
- Write `appinfo.txt` as UTF-8 without BOM: line 1 = tools dir, line 2 = download dir.

## 3. Sync procedure

1. Identify changed files in runninghub_api (`git status` / `git diff`) since the last sync.
2. For each changed **shared-core** file: back up the ComfyUI original, then copy verbatim.
3. For each changed **project-specific** file: port the equivalent change applying §2 rules. Never paste RunningHub-specific code verbatim.
4. Verify before reporting done:
   - `python -m py_compile server.py`
   - JS syntax: `Get-Content <file> -Raw | node --input-type=module --check`
   - Static consistency: every `getElementById` ID exists in `index.html`; every named import has a matching export.
   - Endpoint smoke test: start the ComfyUI server, hit `/appinfo`, `/save-tool`, `/delete-tool`, `/save-cover`, `/rename-cover`, `/shutdown`.
5. Leave ComfyUI-only features untouched: `fieldtypes.js`, workflow import, `/comfy-proxy`, model/combo handling.

## 4. Gotchas

- Never write API keys or server addresses into project files; both store them in the browser.
- COMFYUI `tools/` may contain a stale nested `tools/tools/` dir from old migrations — do not delete without asking.
- COMFYUI may have uncommitted partial-sync work; run `git status` there before overwriting.
- `server.py` sends `Cache-Control: no-store`; still expect stale JS if the browser cached aggressively.
