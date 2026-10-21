# Drive Embedder

Upload local files to Google Drive and embed them directly in your Obsidian notes with intuitive size options and full privacy.

## Features

- 🚀 **One-Click Upload**: Upload files directly to Google Drive from Obsidian (via ribbon icon or command palette)
- 🔒 **Strictly Private Uploads**: Uploaded files stay private in your Google Drive (no public link sharing required)
- 🖼️ **Authenticated Live Rendering**: Private Google Drive images, videos, audio files, and PDFs are automatically fetched via authenticated API calls and rendered in Reading View and Live Preview using local Blob URLs
- 🔗 **Auto Link & Embed Generation**: Always inserts a clickable Markdown link (`[📁 filename](...)`) alongside the media embed at your cursor position (or copies to clipboard if no note is active)
- 📱 **Desktop & Android Support**: Works on Desktop (macOS, Windows, Linux) and Android/mobile
- 📐 **Intuitive Size Options**: Clear size presets tailored for Video, Documents, Audio, and Images
- 📂 **Multi-Format Support**: Video (MP4, WebM, MOV, AVI), Audio (MP3, WAV, OGG, M4A), PDF, Images (JPG, JPEG, PNG, GIF, WebP, SVG)
- 🔄 **Real-Time Progress**: Visual upload progress tracking

## Installation via BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Open Obsidian Settings → BRAT → Add Beta plugin
3. Enter this repository URL: `MarkusLitz/obsidian-embedder` (or upstream `reallygood83/obsidian-embedder`)
4. Click "Add Plugin"
5. Enable "Drive Embedder" in Settings → Community plugins

## Google OAuth Setup

Before using the plugin, you need to set up Google OAuth credentials:

### 1. Create Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select an existing one
3. Enable **Google Drive API**:
   - Navigate to "APIs & Services" → "Library"
   - Search for "Google Drive API"
   - Click "Enable"

### 2. Configure OAuth Consent Screen

1. Go to "APIs & Services" → "OAuth consent screen"
2. Select "External" user type
3. Fill in required fields:
   - App name: "Drive Embedder"
   - User support email: Your email
   - Developer contact: Your email
4. Add scopes:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/userinfo.email`
5. Save and continue

### 3. Create OAuth Credentials

1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth Client ID"
3. Application type: **Desktop app**
4. Name: "Drive Embedder"
5. Click "Create"
6. Copy the **Client ID** and **Client Secret**

### 4. Configure Plugin

1. Open Obsidian Settings → Drive Embedder
2. Paste your **Client ID**
3. Paste your **Client secret**
4. Click **Connect**
5. Complete the browser authorization flow (uses PKCE and local callback on `http://127.0.0.1:8586/callback`)
6. Grant permissions to your Google Drive

> **Note for Android / Mobile:** Perform the initial OAuth login on Desktop (macOS/Windows/Linux). Once connected, your synced tokens in `data.json` work seamlessly on Android as well.

## Usage

### Upload and Embed Files

1. Click the cloud upload icon in the ribbon (`Drive Embedder: upload file`), or
2. Use the command palette: `Drive Embedder: upload file and embed`
3. Drag & drop a file or click **select file**
4. Choose your preferred embed size and whether to highlight the filename
5. Click **upload and embed**
6. A clickable Google Drive link and the embed code are automatically inserted at your cursor position (or copied to your clipboard if no Markdown editor is open)

### Size Options

#### Video
- 🔹 **Compact**: `60%` width × `280px` height (good for inline content)
- 🔸 **Medium**: `80%` width × `400px` height *(recommended)*
- 🔶 **Large**: `100%` width × `500px` height
- 🟠 **Full width**: `100%` width × `600px` height

#### Documents (PDF)
- 🔹 **Compact**: `70%` width × `400px` height (quick preview)
- 🔸 **Medium**: `100%` width × `500px` height *(recommended)*
- 🔶 **Large**: `100%` width × `650px` height
- 🟠 **Full screen**: `100%` width × `800px` height

#### Audio
- 🎵 **Slim**: `100%` width × `100px` height *(recommended)*
- 🎶 **Standard**: `100%` width × `120px` height

#### Images
- 🔹 **Thumbnail**: `200px` width
- 🔸 **Compact**: `400px` width
- 🔶 **Medium**: `600px` width *(recommended)*
- 🟠 **Large**: `100%` width

## Settings

- **Google OAuth**: Client ID and Client secret
- **Upload folder**: Upload destination path on Google Drive (default: `Obsidian/DriveEmbedder`)
- **Show filename by default**: Bold the clickable filename link above the embed by default
- **Default theme**: Auto-detect system theme (`auto`) or force `light` / `dark`
- **Default embed size**: Configure default size presets for Video, Audio, Document, and Image

## Supported File Types

| Category | Formats |
|----------|---------|
| 🎬 Video | MP4, WebM, MOV, AVI |
| 🎵 Audio | MP3, WAV, OGG, M4A |
| 📄 Document | PDF |
| 🖼️ Image | JPG, JPEG, PNG, GIF, WebP, SVG |

## Security & Privacy

- Your files are uploaded to **your own Google Drive** and remain **strictly private** (no public `anyone` permissions are set)
- Private embeds are hydrated locally in Obsidian via authenticated Drive API downloads (`alt=media`) into temporary in-memory `blob:` URLs
- OAuth tokens are stored locally in your vault's plugin configuration (`data.json`, ignored by Git) and refreshed automatically
- No third-party servers are involved

## Troubleshooting

### "not connected"
- Verify Client ID and Client secret are correct
- Ensure Google Drive API is enabled in your Google Cloud project
- Check that the OAuth consent screen is configured and your Google account is added as a test user (if the app is in Testing mode)

### Port 8586 Already in Use
- Reload Obsidian (`Cmd+R` / `Ctrl+R`) and click **Connect** again

### Upload Fails
- Check your internet connection
- Verify Google Drive has sufficient storage
- Try disconnecting and reconnecting in the plugin settings

### Token Expired
- The plugin automatically refreshes expired access tokens using your refresh token
- If issues persist, click **Disconnect** and **Connect** again

## Version History

### v1.0.14+ (Fork Enhancements – 2026-10)
- **🔒 Private Google Drive Uploads**: Removed public `anyone` permission sharing; uploaded files stay strictly private
- **🖼️ Authenticated Embed Hydration**: Automatically downloads private Drive media via authenticated API calls and renders images, `<video>`, `<audio>`, and PDFs using cached local Blob URLs in Reading View and Live Preview
- **🔗 Always Insert Clickable Link**: Always includes a clickable `[📁 filename](...)` link above the embed and supports direct insertion into the active editor from the ribbon icon
- **📱 Android / Mobile Support**: Enabled mobile compatibility (`isDesktopOnly: false`), lazy-loaded desktop-only Node/Electron modules, and added MIME wildcards for the Android file picker
- **🛠️ OAuth Callback Hardening**: Improved localhost callback server lifecycle, port binding (`127.0.0.1:8586`), and connection cleanup

### v1.0.8 – v1.0.14
- Resolved ObsidianReviewBot validation and sentence-case requirements for community plugin compliance

### v1.0.7 (2025-12-03)
- **🌍 Complete Internationalization**: All user-facing text converted to English for worldwide distribution
- **📝 Updated Interface**: Settings, modals, notices, and help documentation in English
- **🌐 Global Ready**: Prepared for official Obsidian community plugin registry

### v1.0.6 (2025-12-03)
- **Audio Player Fix**: Increased audio embed height for proper Google Drive player display (`100px` / `120px`)

### v1.0.5 (2025-12-03)
- **Major Fix**: Switched to iframe-based embed for video/audio using `/preview` URL

### v1.0.4 (2025-12-03)
- **Critical Fix**: Corrected Google Drive URL parameter order

### v1.0.3 (2025-12-03)
- **Fixed**: Improved media embed playback

### v1.0.0 (2025-01-25)
- Initial release

## Development

```bash
# Clone repository
git clone https://github.com/MarkusLitz/obsidian-embedder.git

# Install dependencies
npm install

# Build plugin
npm run build

# Development mode
npm run dev
```

## Credits

Originally developed by [reallygood83](https://github.com/reallygood83), enhanced by [MarkusLitz](https://github.com/MarkusLitz).

## License

MIT License - see the [LICENSE](LICENSE) file for details.

