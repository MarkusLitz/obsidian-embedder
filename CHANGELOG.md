# Changelog

All notable changes to **Drive Embedder** are documented in this file.

---

## [Unreleased] — 2026-10-21

### Added
- **Sidebar File Manager (`src/file-manager-view.ts`, `src/embed-scanner.ts`, `main.ts`, `styles.css`)**:
  - New dockable sidebar view (`Drive files`) accessible via the `hard-drive` ribbon icon or Command Palette (`Drive Embedder: manage uploaded Drive files`).
  - **📄 Current Note Tab**:
    - Lists all Google Drive embeds in the active Markdown note with line numbers, file sizes, thumbnail previews for cached images, and multi-note usage indicators (`🔗 N× in vault`).
    - **Live Embed Resizing**: Size preset dropdown (`Compact`, `Medium`, `Large`, `Full width`, etc.) per embed that updates both the Markdown source and the live rendered DOM element in place.
    - **Jump to Embed (`📍 Jump`)**: Scrolls the editor directly to the embed block and highlights it.
    - **Safe Deletion (`🗑️ Delete`)**: Confirmation modal (`ConfirmDeleteModal`) that cleanly removes the entire Markdown link + HTML embed block from the note and moves the file to the Google Drive trash (`trashed: true`), with smart warnings when the file is still embedded in other notes.
  - **Desktop Hover Delete Button on Embeds (`main.ts`, `styles.css`)**:
    - Displays a `🗑️ Delete` action overlay in the top-right corner when hovering over any embedded Drive image, video, audio, or PDF on Desktop (automatically disabled on Android/mobile via `Platform.isMobile` and `@media (hover: none)`), opening the confirmation dialog before removing the embed and moving the file to the Google Drive trash.
  - **🌍 All Drive Files Tab**:
    - Lists all non-trashed files uploaded by the plugin via `GoogleDriveUploader.listUploadedFiles()` and cross-references them against all Markdown notes in the vault (`scanVaultForEmbeds`).
    - Search bar (by filename or note name), usage filter pills (`All`, `Used`, `⚠️ Unused`), and category filter (`Image`, `Video`, `Audio`, `Document`).
    - Clickable note usage badges (`📄 Note :Line`) to jump directly to any note where a file is embedded.
    - **One-Click Re-Embedding (`➕ Embed`)**: Embeds an already uploaded Drive file into the active note without re-uploading.
    - **Orphaned File Cleanup (`🧹 Trash unused`)**: Bulk confirmation modal (`ConfirmBulkTrashModal`) to move all unused Drive files (not referenced in any vault note) to the Google Drive trash at once.
- **Private Google Drive Uploads & Authenticated Local Blob Hydration (`4ad9017`)**:
  - Uploaded files now remain **strictly private** in Google Drive (removed `makeFilePublic` / `anyone` permission sharing and the `setting-permission` upload stage).
  - Added `GoogleDriveUploader.downloadFileAsBlobUrl(fileId)` (`GET /drive/v3/files/{fileId}?alt=media` with `Bearer` token), in-memory `blobCache`, `inflightDownloads` deduplication, immediate post-upload Blob pre-caching, and `revokeAllBlobUrls()` / `revokeBlobUrl()`.
  - Added `setupPrivateEmbedHydration()` and `hydrateDriveEmbeds()` in `main.ts` (using `registerMarkdownPostProcessor`, workspace layout events, and a `MutationObserver`) to automatically hydrate private Drive embeds into local `blob:` URLs across Reading View and Live Preview:
    - Replaces `<img>` `src` with the authenticated `blob:` URL.
    - Replaces video `<iframe>` elements with native HTML5 `<video controls>` players.
    - Replaces audio `<iframe>` elements with native HTML5 `<audio controls>` players.
    - Replaces PDF `<iframe>` elements with an interactive **PDF.js `<canvas>` viewer** (`loadPdfJs()` with `isEvalSupported: false`, HiDPI scaling, zoom controls, and `%PDF-` magic-byte detection) so private PDFs render reliably under Obsidian's `app://obsidian.md` scheme on Desktop as well as on Android/iOS WebViews.
- **Android & Mobile Support (`4ad9017`)**:
  - Set `"isDesktopOnly": false` in `manifest.json`.
  - Lazy-loaded desktop-only Node/Electron modules (`electron`, `http`, `url`) inside `GoogleOAuthFlow.startOAuthFlow()` so the plugin initializes cleanly on Android/iOS and uses synced OAuth tokens via Obsidian's cross-platform `requestUrl`.
  - Extended `SUPPORTED_EXTENSIONS` in `src/size-presets.ts` with MIME wildcards (`image/*`, `video/*`, `audio/*`, `application/pdf`) for the Android system file picker.
  - Added MIME-type fallback matching in `getFileTypeInfo(fileName, mimeType)` and `isFileSupported(fileName, mimeType)` (`src/size-presets.ts`, `src/upload-modal.ts`) for mobile content URIs without standard file extensions.
- **Always-Clickable Markdown Link & Editor Resolution (`4ad9017`)**:
  - `EmbedGenerator.generateEmbed()` now always prepends a clickable Markdown link `[📁 filename](https://drive.google.com/file/d/<id>/view)` above the embed (bolded when `showTitle` is enabled, regular link when disabled).
  - Added `getActiveMarkdownEditor()` fallback chain in `main.ts` so uploads triggered from the ribbon icon or command palette reliably insert the link & embed into the active note at the cursor position (falling back to clipboard copy only if no Markdown note is open).
- **Documentation & Security Audit (`d4cf722`, `eface05`)**:
  - Updated `README.md` for private Drive uploads, authenticated embeds, Android support, updated size presets, and troubleshooting (`d4cf722`).
  - Added `roadmap.md` containing a full security audit, data leak analysis, and prioritized remediation roadmap (`eface05`).

### Fixed & Security Hardening
- **OAuth Localhost Callback Server Lifecycle (`4ad9017`, `src/google-oauth-flow.ts`)**:
  - Fixed `EADDRINUSE` port conflicts on `127.0.0.1:8586` by adding `cancel()` and `cleanupServer()` with `srv.closeAllConnections()`, `srv.close()`, and `Connection: close` response headers.
  - Attached `server.on('error')` before `server.listen()` and delayed opening the external browser until the server is actively listening on `127.0.0.1`.
  - Added `settled` state guard and proper `clearTimeout(timeoutId)` cleanup on completion or error.
- **XSS & Injection Protections (`4ad9017` & current)**:
  - Escaped OAuth error messages via `escapeHtml()` before rendering in `GoogleOAuthFlow.getErrorHtml()` (`src/google-oauth-flow.ts`).
  - Escaped HTML attributes via `escapeHtmlAttr()` on `<img alt="...">` and escaped Markdown brackets `[` / `]` in `EmbedGenerator.generateEmbed()` (`src/embed-generator.ts`).
  - Escaped single quotes (`'`) and backslashes (`\`) in Google Drive folder lookup queries in `GoogleDriveUploader.findFolder()` and validated `fileId` format (`src/uploader.ts`).
- **Git Credential Protection (`4ad9017`, `.gitignore`)**:
  - Added `data.json` to `.gitignore` to prevent accidental commits of OAuth client secrets and refresh tokens.

---

## [1.0.8 – 1.0.14] — Previous Releases
- Resolved ObsidianReviewBot validation and sentence-case requirements for community plugin compliance.

## [1.0.7] — 2025-12-03
- Complete internationalization of all user-facing text into English.

## [1.0.6] — 2025-12-03
- Increased audio embed height (`100px` Slim / `120px` Standard) for proper Google Drive audio player controls display.

## [1.0.5] — 2025-12-03
- Switched video and audio embeds to `/preview` iframe URLs to support files larger than 25 MB.

## [1.0.4] — 2025-12-03
- Corrected Google Drive URL parameter order.

## [1.0.3] — 2025-12-03
- Improved media embed playback.

## [1.0.0] — 2025-01-25
- Initial release with Google Drive OAuth 2.0 upload, size presets, and multi-format embed generation.
