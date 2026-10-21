# Drive Embedder — Security Audit, Data Leak Analysis & Roadmap

**Date:** 2026-10-21  
**Plugin Version:** `1.0.14` (Custom Fork / Patched Build)  
**Target Directory:** `.obsidian/plugins/drive-embedder`

---

## 1. Summary of Recent Customizations (2026-10-21)

### 1.1 Mobile / Android Compatibility
- **`manifest.json`**: Changed `"isDesktopOnly"` from `true` to `false` so Obsidian permits loading the plugin on mobile devices (Android/iOS).
- **`GoogleOAuthFlow.startOAuthFlow()` (`main.js:L81-L92`)**: Moved desktop-only Node/Electron imports (`require("electron")`, `require("http")`, `require("url")`) out of the top-level module scope into a lazy `try/catch` block inside `startOAuthFlow()`. This prevents module initialization crashes on mobile while allowing token refresh and authenticated Drive API requests (via Obsidian's cross-platform `requestUrl`) to work on Android once `data.json` is synced from Desktop.

### 1.2 Private Google Drive Files & Authenticated Local Blob Hydration
- **Private Uploads (`GoogleDriveUploader.uploadFile`, `main.js:L571-L649`)**:
  - Uploaded files remain private in Google Drive (no public `anyone with link` permission changes).
  - Immediately after upload, the file's `ArrayBuffer` is pre-cached as a local `Blob` URL in `this.blobCache` (`main.js:L616-L624`) for instant rendering without re-downloading.
- **Authenticated Download & Blob Cache (`GoogleDriveUploader.downloadFileAsBlobUrl`, `main.js:L493-L531`)**:
  - Fetches private files via Google Drive API v3 (`GET /drive/v3/files/{fileId}?alt=media`) using `Authorization: Bearer <accessToken>`.
  - Deduplicates concurrent downloads via `this.inflightDownloads` and caches `{ blobUrl, mimeType }` in `this.blobCache`.
  - Cleans up object URLs via `revokeAllBlobUrls()` (`main.js:L535-L541`) on plugin unload and disconnect.
- **DOM Hydration (`DriveEmbedderPlugin.setupPrivateEmbedHydration` & `hydrateDriveEmbeds`, `main.js:L1459-L1570`)**:
  - Hooks into `registerMarkdownPostProcessor`, workspace layout events (`onLayoutReady`, `layout-change`, `active-leaf-change`), and a `MutationObserver` on `document.body`.
  - Detects `<img>` and `<iframe>` elements pointing to `drive.google.com`, extracts the Drive `fileId`, downloads the file as a local `blob:` URL, and updates the DOM:
    - `<img>`: Replaces `img.src` with the authenticated `blob:` URL.
    - `<iframe>` (`video/*`): Replaces the `<iframe>` with a native HTML5 `<video controls>` element.
    - `<iframe>` (`audio/*`): Replaces the `<iframe>` with a native HTML5 `<audio controls>` element.
    - `<iframe>` (`application/pdf`): Updates `iframe.src` to the `blob:` URL.

### 1.3 Always-Clickable Drive Link & Editor Resolution
- **Clickable Filename Link (`EmbedGenerator.generateEmbed`, `main.js:L1262-L1276`)**:
  - Always prepends a clickable Markdown link `[📁 <filename>](https://drive.google.com/file/d/<id>/view)` above the embed (bolded when `showTitle` is enabled, regular link otherwise).
- **Robust Active Editor Lookup (`getActiveMarkdownEditor` & `openUploadModal`, `main.js:L1604-L1656`)**:
  - Resolves the target Markdown editor across ribbon clicks and modal closures (`preferredEditor` → `getActiveViewOfType(MarkdownView)` → `workspace.activeEditor` → first `markdown` leaf), inserts the generated snippet, and triggers `hydrateDriveEmbeds` after `100ms`.

---

## 2. Telemetry & Third-Party Network Audit

**Status: Clean (No hidden telemetry or third-party data exfiltration)**  
A full inspection of `main.js` (1,825 lines) confirms that the plugin only communicates with official Google endpoints and a temporary local loopback listener during OAuth login:
- `https://accounts.google.com/o/oauth2/v2/auth` (`main.js:L66`)
- `https://oauth2.googleapis.com/token` (`main.js:L67`)
- `https://www.googleapis.com/drive/v3` & `https://www.googleapis.com/upload/drive/v3` (`main.js:L466-L467`)
- `https://drive.google.com/...` (within generated embed HTML/Markdown)
- `http://127.0.0.1:8586/callback` (local OAuth callback server, active for max 120 seconds during login)

---

## 3. Security Vulnerabilities, Data Leaks & Architectural Risks

### 3.1 Data Leaks & Credential Security

#### 🔴 [HIGH] Plaintext Storage of OAuth Client Secret & Refresh Token in `data.json`
- **Location:** `DEFAULT_SETTINGS` (`main.js:L43-L60`), `saveSettings` (`main.js:L1426-L1429`)
- **Description:** `googleClientId`, `googleClientSecret`, `googleAccessToken`, and `googleRefreshToken` are stored in plaintext inside `.obsidian/plugins/drive-embedder/data.json`.
- **Impact / Leak Vector:**
  - Because `data.json` resides inside the vault and is synced to mobile devices, any sync provider (Obsidian Sync, iCloud, Google Drive, Syncthing, Git repositories, or unencrypted backups) receives a plaintext copy of `googleClientSecret` and `googleRefreshToken`.
  - Any other installed Obsidian plugin or local process with read access to the vault directory can read `data.json` and mint indefinite access tokens.
- **Trade-offs & Recommended Solution (Hybrid Encryption):**
  - *Option 1 (Device-local storage only via Keychain / `localStorage`):* Removes secrets from `data.json`, but breaks automatic token sync to Android.
  - *Option 2 (Master Password encryption in `data.json` only):* Preserves sync, but requires entering the password on every Obsidian startup.
  - *Option 3 (Recommended — Encrypted `data.json` + Device-Local Key Cache):* Encrypt `clientSecret`, `accessToken`, and `refreshToken` in `data.json` using Web Crypto API (`AES-256-GCM` with a `PBKDF2`-derived key). Store the decryption key/passphrase in each device's local `window.localStorage` (which is never synced across the vault). This keeps `data.json` safe in cloud sync and backups while requiring password entry only **once per device** (once on Desktop, once on Android) with zero daily UX friction.

#### 🟠 [MEDIUM] "Disconnect" Does Not Revoke Tokens on Google's Servers
- **Location:** `disconnectGoogleDrive` (`main.js:L1591-L1600`), `GoogleDriveUploader.disconnect` (`main.js:L779-L783`)
- **Description:** Clicking "Disconnect" only clears the token strings in local settings (`data.json`), without calling Google's token revocation endpoint (`POST https://oauth2.googleapis.com/revoke?token=...`).
- **Impact:** Previously synced or backed-up copies of `refreshToken` remain valid indefinitely on Google's servers even after disconnecting.
- **Remediation:** Call `https://oauth2.googleapis.com/revoke` for the refresh/access token before clearing local settings.

#### 🟡 [LOW] `Client Secret` Displayed in Plaintext in Settings UI
- **Location:** `createOAuthSection` (`main.js:L1710-L1715`)
- **Description:** The `Client secret` input field uses a standard text input (`type="text"`) instead of masking the value (`type="password"`).
- **Impact:** Exposes the OAuth client secret during screen sharing, recording, or shoulder surfing.
- **Remediation:** Set `text.inputEl.type = "password"` on the Client Secret setting control.

#### 🟡 [LOW] Unnecessary OAuth Scope (`userinfo.email`)
- **Location:** `GoogleOAuthFlow` constructor (`main.js:L68-L71`)
- **Description:** The plugin requests `https://www.googleapis.com/auth/userinfo.email` in addition to `https://www.googleapis.com/auth/drive.file`, even though `getUserInfo()` (`main.js:L754-L775`) is unused dead code.
- **Remediation:** Remove `https://www.googleapis.com/auth/userinfo.email` from `this.SCOPES` to follow the principle of least privilege.

---

### 3.2 Code Vulnerabilities (OAuth, Injection, DOM/XSS)

#### 🟠 [MEDIUM] Missing OAuth `state` Parameter (CSRF) & `localhost` vs. `127.0.0.1` Loopback Mismatch
- **Location:** `startOAuthFlow` (`main.js:L93-L185`), `buildAuthUrl` (`main.js:L279-L291`)
- **Description:**
  1. **No `state` parameter:** While PKCE (`code_challenge` / `code_verifier`) is implemented, the OAuth authorization request does not generate or verify a cryptographic `state` parameter on `/callback`.
  2. **IPv4 vs. IPv6 loopback mismatch:** The callback server binds exclusively to IPv4 `127.0.0.1:8586` (`main.js:L180`), whereas `redirectUri` uses `http://localhost:8586/callback` (`main.js:L95`). On systems where `localhost` resolves to IPv6 `::1`, an unprivileged local process can bind `[::1]:8586` and intercept the OAuth redirect request.
- **Remediation:** Generate a random `state` token, validate it in `/callback` before exchanging `code`, and use `http://127.0.0.1:8586/callback` (or verify `state` strictly).

#### 🟠 [MEDIUM] Google Drive API Query Injection in `findFolder`
- **Location:** `GoogleDriveUploader.findFolder` (`main.js:L687-L708`)
- **Vulnerable Code:**
  ```js
  const query = `name='${name}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  ```
- **Description:** Folder names from `this.settings.driveFolder` are interpolated directly into the Google Drive `q` parameter without escaping single quotes (`'`) or backslashes (`\`).
- **Impact:** A folder name containing a single quote (e.g., `User's Files`) breaks the query syntax (`400 Bad Request`) or allows query predicate injection. Because `findFolder` catches the error and returns `null`, `ensureFolder` creates a duplicate folder on every upload.
- **Remediation:** Escape backslashes and single quotes in `name` (`name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")`).

#### 🟠 [MEDIUM] Weak URL Validation in `extractDriveFileId` & Unauthenticated Pre-Hydration Requests
- **Location:** `extractDriveFileId` (`main.js:L1491-L1504`), `hydrateDriveEmbeds` (`main.js:L1505-L1570`)
- **Description:**
  1. `extractDriveFileId` checks `!rawUrl.includes("drive.google.com")` instead of parsing the URL hostname. Any third-party URL containing `drive.google.com` in its query string or path alongside `id=...` triggers an authenticated Google Drive API download attempt.
  2. `setupPrivateEmbedHydration` observes the entire `document.body` rather than scoping hydration to Markdown views.
  3. Because generated embeds use live `https://drive.google.com/thumbnail?id=...` and `https://drive.google.com/file/d/.../preview` URLs in `src`, Obsidian's webview fires unauthenticated HTTP requests to `drive.google.com` (which fail with 403/401 for private files) before `hydrateDriveEmbeds` finishes downloading and swapping in the `blob:` URL.
- **Remediation:** Validate hostname via `new URL(rawUrl)` (`hostname === "drive.google.com"`), and consider storing the URL in `data-drive-src` or using a safe placeholder until hydrated.

#### 🟡 [MEDIUM] Insufficient Escaping in `EmbedGenerator` & Unsandboxed PDF `blob:` Iframes
- **Location:** `generateEmbed` (`main.js:L1262-L1297`), `generateImageEmbed` (`main.js:L1352-L1364`), `hydrateDriveEmbeds` (`main.js:L1565-L1567`)
- **Description:**
  - `safeMarkdownName` (`main.js:L1265`) only escapes `[` and `]`, allowing filenames containing `<`, `>`, parentheses, or newlines to inject raw HTML or break Markdown link syntax when inserted into a note.
  - `generateImageEmbed` (`main.js:L1356`) interpolates `viewUrl` into `<a href="${viewUrl}" target="_blank">` without `escapeHtmlAttr(viewUrl)` or `rel="noopener noreferrer"`.
  - When `hydrateDriveEmbeds` sets `iframe.src = entry.blobUrl` for PDFs (`main.js:L1566`), the `blob:` URL executes inside an `<iframe>` without a `sandbox` attribute under Obsidian's privileged `app://obsidian.md` origin.
- **Remediation:** Escape HTML characters in `safeMarkdownName` and `viewUrl`, add `rel="noopener noreferrer"`, and enforce strict MIME/header validation or iframe sandboxing where supported.

---

### 3.3 Memory & Stability Risks

#### 🟠 [MEDIUM] Unbounded In-Memory `blobCache` & Base64 Upload Memory Spike
- **Location:** `downloadFileAsBlobUrl` (`main.js:L493-L531`), `uploadFile` (`main.js:L580-L624`), `arrayBufferToBase64` (`main.js:L787-L794`)
- **Description:**
  1. **Unbounded `blobCache`:** Every uploaded or viewed file (including large videos and PDFs) is held in RAM as a `Blob` inside `this.blobCache` for the entire session with no LRU eviction, size cap, or TTL. On mobile (Android) or during long desktop sessions, this can cause high memory consumption or out-of-memory crashes.
  2. **Re-hydration after Disconnect/Reconnect:** If `revokeAllBlobUrls()` is called, existing `<img>` elements retain `src="blob:..."` (now revoked/broken) and are skipped by `hydrateDriveEmbeds` because of `rawSrc.startsWith("blob:")` (`main.js:L1518`).
  3. **Base64 Multipart String Concatenation:** `arrayBufferToBase64` builds a single string byte-by-byte (`binary += String.fromCharCode(bytes[i])`) and constructs the entire multipart request body in memory (~3–4× file size in RAM).
- **Remediation:**
  - Implement a bounded cache (e.g., max total byte size / LRU eviction calling `URL.revokeObjectURL` when evicted) or skip permanent blob caching for large video files beyond a threshold.
  - Track active `blobUrl` validity in `hydrateDriveEmbeds` so revoked blobs are re-hydrated after reconnecting.
  - Optimize `arrayBufferToBase64` using chunked `String.fromCharCode.apply` or binary multipart `ArrayBuffer` assembly.

---

## 4. Prioritized Action Plan (Roadmap)

| Priority | Item | Target Location |
| :--- | :--- | :--- |
| **P1 (High)** | Implement hybrid credential protection (AES-256-GCM encrypted tokens in `data.json` + device-local key in `localStorage`) | `settings.ts` / `main.ts` (`loadSettings`, `saveSettings`) |
| **P2 (Medium)** | Escape single quotes & backslashes in Google Drive folder query (`findFolder`) | `uploader.ts` (`main.js:L690`) |
| **P2 (Medium)** | Revoke OAuth tokens via `https://oauth2.googleapis.com/revoke` on Disconnect | `uploader.ts` / `main.ts` (`main.js:L1591-L1600`) |
| **P2 (Medium)** | Add OAuth `state` parameter validation & align loopback redirect host (`127.0.0.1`) | `google-oauth-flow.ts` (`main.js:L93-L185`, `L279`) |
| **P2 (Medium)** | Strict URL parsing in `extractDriveFileId` (`new URL(rawUrl).hostname === "drive.google.com"`) | `main.ts` (`main.js:L1491-L1504`) |
| **P2 (Medium)** | Add memory cap / LRU eviction to `blobCache` & chunked encoding in `arrayBufferToBase64` | `uploader.ts` (`main.js:L469`, `L493-L541`, `L787-L794`) |
| **P3 (Low)** | Mask Client Secret input (`type="password"`), remove unused `userinfo.email` scope, and escape HTML/URLs in `EmbedGenerator` | `main.ts` (`L1710`), `google-oauth-flow.ts` (`L70`), `embed-generator.ts` (`L1265`, `L1356`) |
