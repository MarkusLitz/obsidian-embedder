# Drive Embedder

Upload private files to Google Drive, render authenticated media and PDF.js embeds on Desktop & Android, manage uploaded Drive files across your vault, and turn Google Drive/Docs links into interactive Smart Chips.

- **Plugin ID:** `mlitz-drive-embedder`
- **Version:** `2.0.0` (Obsidian `1.5.0+`, Desktop & Mobile/Android)

---

## Features

- 🔒 **Strictly Private Google Drive Uploads**: Uploaded files remain private in your own Google Drive — no `anyone with link` sharing permissions are ever added.
- 🚀 **Multi-File Binary Resumable Uploads**: Drag & drop or pick single or multiple files at once with per-file and global size presets, batch progress tracking, partial-failure retry, and Google Drive **Resumable Uploads** (`uploadType=resumable`, no 5 MB multipart ceiling or Base64 memory overhead).
- 🖼️ **Authenticated Live Rendering (Desktop & Android)**:
  - **Images** (`JPG`, `JPEG`, `PNG`, `GIF`, `WebP`, `SVG`) → hydrated via authenticated local `blob:` URLs.
  - **Video** (`MP4`, `WebM`, `MOV`, `AVI`) → rendered as native HTML5 `<video controls>` players.
  - **Audio** (`MP3`, `WAV`, `OGG`, `M4A`) → rendered as native HTML5 `<audio controls>` players.
  - **PDF Documents** (`PDF`) → rendered via Obsidian's built-in **PDF.js `<canvas>` viewer** (`loadPdfJs()`) with HiDPI scaling, zoom controls (`−` / `100%` / `+`), page counter, and viewport-virtualization recovery so any number of private PDFs render reliably in Reading View and Live Preview on both Desktop and Android.
- ✨ **Google Smart Chips**: Automatically transforms pasted Google Drive, Docs, Sheets, Slides, Forms, Drawings, and Folder URLs into named Markdown links (`[Document Title](url)`) and renders them with Google-style icons in both Reading View and CodeMirror 6 Live Preview.
- 🗂️ **Drive File Manager Sidebar**: Dockable `Drive files` view (`hard-drive` ribbon icon) with:
  - **📄 Current note tab**: Inspect embeds in the active note, live-resize embeds in place, jump to lines, or delete embeds & move files to Google Drive trash.
  - **🌍 All Drive files tab**: Browse files in your Drive upload folder cross-referenced against all vault notes, filter `Used` vs. `⚠️ Unused` (orphaned) files, re-embed existing files in one click, or bulk-trash unused files.
- 🗑️ **Desktop Hover Delete**: Hover over any embedded Drive media on Desktop to cleanly remove the link + embed block from the note and optionally move the file to Google Drive trash (automatically hidden on mobile/touch devices).
- 🔑 **One-Click OAuth Session Recovery**: Detects expired/revoked refresh tokens and provides a direct **`🔑 Reconnect & upload`** action inside the Upload Modal, File Manager sidebar, and Settings.

---

## Installation

### Option 1: Via BRAT
1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin in Obsidian.
2. Open **Settings → BRAT → Add Beta plugin**.
3. Enter repository: `MarkusLitz/obsidian-embedder`.
4. Click **Add Plugin**, then enable **Drive Embedder** under **Settings → Community plugins**.

### Option 2: Manual / Git Clone
Clone or copy `main.js`, `manifest.json`, and `styles.css` into your vault under:
```text
<Vault>/.obsidian/plugins/mlitz-drive-embedder/
```
Then reload Obsidian and enable **Drive Embedder** in **Settings → Community plugins**.

---

## Google OAuth Setup

### 1. Create a Google Cloud Project & Enable API
1. Open [Google Cloud Console](https://console.cloud.google.com).
2. Create a new project (or select an existing one).
3. Go to **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.

### 2. Configure the OAuth Consent Screen
1. Go to **APIs & Services → OAuth consent screen** (or **Google Auth Platform → Branding / Audience**).
2. Choose **External** user type and fill in the required app name (`Drive Embedder`) and your email address.
3. Add the following scopes under **Data Access / Scopes**:
   - `https://www.googleapis.com/auth/drive.file` *(upload, read, and trash files created by the plugin)*
   - `https://www.googleapis.com/auth/drive.metadata.readonly` *(resolve titles of private Google Docs/Sheets/Slides/Drive files for Smart Chips)*
   - `https://www.googleapis.com/auth/userinfo.email`
4. **Important — Prevent 7-Day Token Expiration:**
   - If your app's Publishing status is left in **Testing**, Google automatically expires OAuth refresh tokens every **7 days**.
   - Switch Publishing status to **In production** (for personal use with your own Google account, you do **not** need to submit the app for Google verification — simply click *Advanced → Go to Drive Embedder (unsafe)* once during browser login). Your refresh token will then remain valid permanently.

### 3. Create Desktop OAuth Credentials
1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Select Application type: **Desktop app**.
3. Copy the generated **Client ID** and **Client secret**.

### 4. Connect in Obsidian
1. Open **Obsidian Settings → Drive Embedder**.
2. Paste your **Client ID** and **Client secret**.
3. Click **Connect** (or **Reconnect** to grant updated scopes).
4. Complete the Google sign-in in your browser (uses PKCE `S256` with a temporary local callback listener on `127.0.0.1:8586` / `http://localhost:8586/callback`).

> **Android / Mobile Note:** Perform the initial OAuth login on Desktop (`macOS`, `Windows`, or `Linux`). Once connected, your synced tokens in `.obsidian/plugins/mlitz-drive-embedder/data.json` work seamlessly on Android as well.

---

## Usage

### 1. Upload & Embed Files (Single or Batch)
1. Click the cloud upload ribbon icon (**`Drive Embedder: upload file`**) or run **`Drive Embedder: upload file and embed`** from the Command Palette.
2. Drag & drop one or multiple files into the modal, or click **select files**.
3. Adjust embed sizes per file in the queue or apply a global preset across all queued files, and toggle **Show filename** if desired.
4. Click **📤 upload and embed**.
5. For each file, a clickable Markdown link (`[📁 filename](https://drive.google.com/file/d/<id>/view)`) and the responsive HTML embed block are inserted at your cursor position in a single undoable step (or copied to your clipboard if no Markdown note is open).

### 2. Google Smart Chips
- **Paste raw URLs:** Paste any `https://docs.google.com/...`, `https://drive.google.com/...`, or `https://forms.gle/...` URL into a Markdown note. Drive Embedder inserts an instant `⏳` placeholder chip, resolves the document's real title (via Clipboard HTML → Drive API v3 → Vault scan → page `<title>`), and formats it as `[Document Title](url)`.
- **Paste over selected text:** Select text in the editor and paste a Google URL to turn your selection directly into a Smart Chip.
- **Convert existing URLs in a note:** Run **`Drive Embedder: convert Google Drive/Docs URLs in note to smart chips`** from the Command Palette.
- **Supported chip icons:** Google Docs, Sheets, Slides, Forms, Drawings, Drive Folders, PDFs, and generic Drive files. Moving your cursor into a chip in Live Preview automatically unfolds the underlying Markdown syntax for editing.

### 3. Manage Files & Resize/Delete Embeds
Click the hard-drive ribbon icon (**`Drive Embedder: manage files`**) or run **`Drive Embedder: manage uploaded Drive files`**:
- **📄 Current note tab:**
  - View all Google Drive embeds and inline Drive links in the active note with line numbers, file sizes, cached image thumbnails, and vault-wide usage counts (`🔗 N× in vault`).
  - Change an embed's size preset via the **`📐 Size`** dropdown to update the note's Markdown and live DOM immediately.
  - Click **`📍 Jump`** to scroll to the embed, **`🌐 Drive`** to open it in Google Drive, or **`🗑️ Delete`** to remove the embed block and optionally move the file to your Google Drive trash (recoverable for 30 days).
- **🌍 All Drive files tab:**
  - Lists all non-trashed files inside your configured Drive upload folder (`Obsidian/DriveEmbedder`) and cross-references them against every Markdown note in your vault.
  - Filter by **`All`**, **`Used`**, or **`⚠️ Unused`**, filter by media category, search by filename or note name, click **`➕ Embed`** to insert an existing Drive file into the active note without re-uploading, or click **`🧹 Trash unused`** to clean up orphaned Drive files in bulk.

---

## Size Presets & Supported Formats

| Category | Formats | Presets (`Width × Height`) |
| :--- | :--- | :--- |
| 🎬 **Video** | `MP4`, `WebM`, `MOV`, `AVI` | **Compact** (`60% × 280px`), **Medium** (`80% × 400px` ★), **Large** (`100% × 500px`), **Full width** (`100% × 600px`) |
| 📄 **Document** | `PDF` | **Compact** (`70% × 400px`), **Medium** (`100% × 500px` ★), **Large** (`100% × 650px`), **Full screen** (`100% × 800px`) |
| 🎵 **Audio** | `MP3`, `WAV`, `OGG`, `M4A` | **Slim** (`100% × 100px` ★), **Standard** (`100% × 120px`) |
| 🖼️ **Image** | `JPG`, `JPEG`, `PNG`, `GIF`, `WebP`, `SVG` | **Thumbnail** (`200px`), **Compact** (`400px`), **Medium** (`600px` ★), **Large** (`100%`) |

*(★ = default recommended preset)*

---

## Settings Overview

- **Connection status**: Connect, Reconnect (to refresh expired sessions or grant updated scopes), or Disconnect.
- **Google OAuth**: OAuth `Client ID` and `Client secret`.
- **Upload folder**: Target folder path on Google Drive (default: `Obsidian/DriveEmbedder`). Also scopes the **All Drive files** tab in the sidebar manager.
- **Show filename by default**: Bold the clickable `[📁 filename](...)` link above generated embeds by default.
- **Google smart chips on paste**: Toggle automatic conversion of pasted Google Drive/Docs URLs into named Smart Chips.
- **Default theme & Default embed size**: Configure appearance and default size preferences.

---

## Security & Privacy

- **Zero Third-Party Servers**: Communicates exclusively with official Google OAuth2 / Google Drive v3 endpoints (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com/drive/v3`, `www.googleapis.com/upload/drive/v3`, and `docs.google.com`/`drive.google.com` for link metadata) plus a temporary `127.0.0.1:8586` loopback listener for max 120 seconds during desktop OAuth login.
- **Private by Design**: Uploaded files are never shared publicly; media is hydrated in-memory via authenticated `Bearer` requests into session-local `blob:` URLs (revoked automatically on plugin unload or disconnect) and rendered safely (`isEvalSupported: false` in PDF.js).
- **Git Protection**: `data.json` is excluded via `.gitignore` so OAuth credentials and tokens are not committed to Git. See [roadmap.md](roadmap.md) for the security audit and planned Obsidian Keychain (`SecretStorage`) integration.

---

## Troubleshooting

- **"Google Drive session expired" / Refresh Token Expired after 7 Days**:
  - Click **`🔑 Reconnect & upload`** in the Upload Modal (or **Reconnect** in Settings). To stop tokens from expiring every 7 days, change your Google Cloud OAuth Consent Screen publishing status from *Testing* to **In production**.
- **Private Google Docs Titles Show Default Labels (`Google Doc`, `Google Sheet`) on Paste**:
  - Click **Reconnect** once in **Settings → Drive Embedder** so your OAuth token includes the `drive.metadata.readonly` scope.
- **Port `8586` Already in Use**:
  - Reload Obsidian (`Ctrl+R` / `Cmd+R`) and click **Connect** / **Reconnect** again.

---

## Development

```bash
# Install dependencies
npm ci

# Typecheck and build production bundle (main.js)
npm run build

# Watch mode for development
npm run dev
```

See [CHANGELOG.md](CHANGELOG.md) for detailed release notes across `v2.0.0` and earlier versions.

---

## Credits & License

Originally created by [reallygood83](https://github.com/reallygood83), forked and expanded by [Markus Litz](https://github.com/MarkusLitz/obsidian-embedder).

Released under the [MIT License](LICENSE).
