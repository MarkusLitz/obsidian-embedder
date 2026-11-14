# Drive Embedder

An Obsidian plugin (`0` runtime dependencies, Desktop & Android) for uploading private files to Google Drive, rendering authenticated media and PDF.js embeds locally, managing Drive attachments across your vault, and formatting Google Drive/Docs URLs as Smart Chips.

- **Plugin ID:** `mlitz-drive-embedder`
- **Version:** `2.0.0` (Obsidian `1.5.0+`)

## Features

- **Strictly private Google Drive uploads:** Uploaded files stay private in your Google Drive account (`drive.file`); no public `anyone with link` permissions are set.
- **Multi-file binary resumable uploads:** Select or drag & drop one or multiple files at once with per-file and global size presets, batch progress tracking, partial-failure retry, and Google Drive Resumable Uploads (`uploadType=resumable`, no 5 MB multipart ceiling or Base64 encoding overhead).
- **Authenticated local rendering (Desktop & Android):**
  - **Images** (`JPG`, `JPEG`, `PNG`, `GIF`, `WebP`, `SVG`): Hydrated via authenticated Drive API downloads into cached local `blob:` URLs.
  - **Video** (`MP4`, `WebM`, `MOV`, `AVI`) & **Audio** (`MP3`, `WAV`, `OGG`, `M4A`): Rendered as native HTML5 `<video controls>` and `<audio controls>` players.
  - **PDF documents** (`PDF`): Rendered via Obsidian's built-in PDF.js `<canvas>` viewer (`loadPdfJs()`) with HiDPI scaling, zoom controls (`−` / `100%` / `+`), page count, and automatic re-rendering across CodeMirror 6 viewport virtualization on both Desktop and Android.
- **Google Smart Chips:** Automatically converts pasted Google Drive, Docs, Sheets, Slides, Forms, Drawings, and Folder URLs into named Markdown links (`[Document Title](url)`) and renders them with inline SVG icons in Reading View and CodeMirror 6 Live Preview.
- **Drive File Manager sidebar:** Dockable `Drive files` sidebar view (`hard-drive` ribbon icon) with two tabs:
  - **Current note:** Inspect all Drive embeds and links in the active note, change embed size presets live in place, jump to lines, or remove embeds and move files to the Google Drive trash.
  - **All Drive files:** List non-trashed files inside your configured Drive upload folder cross-referenced against all vault notes, filter `Used` vs. `Unused` (orphaned) files, re-embed existing files without re-uploading, or bulk-trash unused files.
- **Desktop hover delete:** Hover action on embedded media (disabled on mobile/touch devices) to remove the Markdown link + HTML embed block and optionally move the Drive file to trash.
- **In-place OAuth session recovery:** Detects expired or revoked refresh tokens and provides a direct **Reconnect & upload** action in the Upload Modal, File Manager sidebar, and Settings.

## Installation

### Via BRAT
1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Open **Settings → BRAT → Add Beta plugin** and enter `MarkusLitz/obsidian-embedder`.
3. Enable **Drive Embedder** under **Settings → Community plugins**.

### Manual / Git Clone
Place `main.js`, `manifest.json`, and `styles.css` in:
```text
<Vault>/.obsidian/plugins/mlitz-drive-embedder/
```
Reload Obsidian and enable **Drive Embedder** in **Settings → Community plugins**.

## Google OAuth Setup

1. **Enable Google Drive API:** In [Google Cloud Console](https://console.cloud.google.com), create or select a project, open **APIs & Services → Library**, and enable **Google Drive API**.
2. **Configure OAuth Consent Screen:**
   - Open **APIs & Services → OAuth consent screen** (or **Google Auth Platform**), select **External**, and enter an app name and your email address.
   - Add scopes:
     - `https://www.googleapis.com/auth/drive.file` (upload, read, and trash files created by the plugin)
     - `https://www.googleapis.com/auth/drive.metadata.readonly` (resolve titles of private Google Docs/Sheets/Slides/Drive files for Smart Chips)
     - `https://www.googleapis.com/auth/userinfo.email`
   - **Prevent 7-day token expiration:** Switch Publishing status from *Testing* to **In production**. For personal use with your own Google account, no Google app verification submission is required (click *Advanced → Go to Drive Embedder (unsafe)* once during login), and refresh tokens will not expire after 7 days.
3. **Create Desktop Credentials:** Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**, choose **Desktop app**, and copy the **Client ID** and **Client secret**.
4. **Connect in Obsidian:** Open **Settings → Drive Embedder**, enter your **Client ID** and **Client secret**, click **Connect** (or **Reconnect**), and complete the browser authorization flow (uses PKCE `S256` with a local callback server on `127.0.0.1:8586` / `http://localhost:8586/callback`).

> **Android / Mobile:** Complete the initial OAuth login on Desktop (`macOS`, `Windows`, or `Linux`). Once connected, synced tokens in `.obsidian/plugins/mlitz-drive-embedder/data.json` work automatically on Android.

## Usage

### Upload and Embed Files
1. Click the `cloud-upload` ribbon icon (`Drive Embedder: upload file`) or run **`Drive Embedder: upload file and embed`** from the Command Palette.
2. Drag & drop one or more files or click **select files**.
3. Choose size presets (globally or per file) and click **upload and embed**.
4. A clickable Markdown link and the HTML embed block are inserted at your cursor position in a single undoable step (or copied to the clipboard if no Markdown note is open).

### Google Smart Chips
- **Paste raw URLs:** Paste any `docs.google.com`, `drive.google.com`, or `forms.gle` URL into a note to resolve its document title (via Clipboard HTML → Drive API v3 → Vault scan → page `<title>`) and insert `[Document Title](url)`.
- **Paste over selection:** Select text in the editor and paste a Google URL to wrap the selection as a Smart Chip.
- **Convert existing URLs:** Run **`Drive Embedder: convert Google Drive/Docs URLs in note to smart chips`** from the Command Palette.
- **Edit in Live Preview:** Placing the cursor inside a chip unfolds the underlying Markdown link automatically.

### Manage Files & Embeds
Click the `hard-drive` ribbon icon (`Drive Embedder: manage files`) or run **`Drive Embedder: manage uploaded Drive files`**:
- **Current note:** View all Drive embeds/links in the active note with line numbers, file sizes, image thumbnails, and vault-wide usage counts. Resize embeds live via the **Size** dropdown, jump to lines, open in Drive, or delete embeds.
- **All Drive files:** View all non-trashed files inside your configured Drive upload folder (`Obsidian/DriveEmbedder`) matched against every Markdown note in the vault. Search by filename or note, filter by usage (`All`, `Used`, `Unused`) or media category, re-embed existing files, or bulk-trash orphaned files.

## Supported Formats & Size Presets

| Category | Formats | Presets (`Width × Height`) |
| :--- | :--- | :--- |
| **Video** | `MP4`, `WebM`, `MOV`, `AVI` | Compact (`60% × 280px`), **Medium** (`80% × 400px`), Large (`100% × 500px`), Full width (`100% × 600px`) |
| **Document** | `PDF` | Compact (`70% × 400px`), **Medium** (`100% × 500px`), Large (`100% × 650px`), Full screen (`100% × 800px`) |
| **Audio** | `MP3`, `WAV`, `OGG`, `M4A` | **Slim** (`100% × 100px`), Standard (`100% × 120px`) |
| **Image** | `JPG`, `JPEG`, `PNG`, `GIF`, `WebP`, `SVG` | Thumbnail (`200px`), Compact (`400px`), **Medium** (`600px`), Large (`100%`) |

*(Bold preset = default recommended size)*

## Settings

- **Connection status:** Connect, Reconnect, or Disconnect Google Drive.
- **Google OAuth:** `Client ID` and `Client secret`.
- **Upload folder:** Destination path on Google Drive (default: `Obsidian/DriveEmbedder`), also used to scope the **All Drive files** tab.
- **Show filename by default:** Bold the clickable filename link above generated embeds by default.
- **Google smart chips on paste:** Automatically convert pasted Google Drive/Docs URLs into named Smart Chips.
- **Default theme & Default embed size:** Appearance and default size preferences.

## Security & Privacy

- **No third-party servers:** Communicates only with official Google endpoints (`accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com/drive/v3`, `www.googleapis.com/upload/drive/v3`, `docs.google.com`, `drive.google.com`) and a local `127.0.0.1:8586` callback listener (active for max 120 seconds during desktop login).
- **Private media hydration:** Files are downloaded via authenticated `Bearer` requests into session-local `blob:` URLs (revoked on plugin unload or disconnect) and PDFs are rendered with `isEvalSupported: false`.
- **Git protection:** `data.json` is listed in `.gitignore`. See [roadmap.md](roadmap.md) for the security audit and planned Obsidian Keychain (`SecretStorage`) integration.

## Troubleshooting

- **Session expired / refresh token invalid after 7 days:** Click **Reconnect & upload** in the Upload Modal (or **Reconnect** in Settings), and set your Google Cloud OAuth Consent Screen status to **In production**.
- **Private Google Docs titles fall back to generic labels on paste:** Click **Reconnect** once in Settings so your token includes the `drive.metadata.readonly` scope.
- **Port `8586` already in use:** Reload Obsidian (`Ctrl+R` / `Cmd+R`) and try **Connect** / **Reconnect** again.

## Development

```bash
npm ci
npm run build   # TypeScript check + production bundle (main.js)
npm run dev     # Watch mode
```

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Credits & License

Originally created by [reallygood83](https://github.com/reallygood83), forked and expanded by [Markus Litz](https://github.com/MarkusLitz/obsidian-embedder).

[MIT License](LICENSE).
