/**
 * Drive Embedder - Main Plugin
 * Upload local files to Google Drive and embed them in Obsidian notes
 */

import { Plugin, PluginSettingTab, App, Setting, Notice, Editor, MarkdownView } from 'obsidian';
import { DriveEmbedderSettings } from './src/types';
import { DEFAULT_SETTINGS } from './src/settings';
import { GoogleOAuthFlow } from './src/google-oauth-flow';
import { GoogleDriveUploader } from './src/uploader';
import { UploadModal, UploadModalResult } from './src/upload-modal';
import { EmbedGenerator } from './src/embed-generator';

export default class DriveEmbedderPlugin extends Plugin {
    settings: DriveEmbedderSettings;
    private oauthFlow: GoogleOAuthFlow | null = null;
    private uploader: GoogleDriveUploader | null = null;
    private embedGenerator: EmbedGenerator;
    private domObserver: MutationObserver | null = null;

    async onload() {
        await this.loadSettings();

        this.embedGenerator = new EmbedGenerator();

        // Initialize OAuth and uploader if credentials exist
        this.initializeServices();

        // Add ribbon icon
        this.addRibbonIcon('cloud-upload', 'Drive Embedder: upload file', () => {
            this.openUploadModal(this.getActiveMarkdownEditor());
        });

        // Add command
        this.addCommand({
            id: 'upload-and-embed',
            name: 'upload file and embed',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.openUploadModal(editor);
            }
        });

        // Add settings tab
        this.addSettingTab(new DriveEmbedderSettingTab(this.app, this));

        // Hydrate private Google Drive embeds in Reading View and Live Preview
        this.setupPrivateEmbedHydration();

        console.debug('Drive Embedder loaded');
    }

    onunload() {
        this.oauthFlow?.cancel();
        this.domObserver?.disconnect();
        this.domObserver = null;
        this.uploader?.revokeAllBlobUrls();
        console.debug('Drive Embedder unloaded');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.initializeServices();
    }

    private initializeServices() {
        this.oauthFlow?.cancel();
        const clientId = this.settings.googleClientId.trim();
        const clientSecret = this.settings.googleClientSecret.trim();

        if (clientId && clientSecret) {
            this.oauthFlow = new GoogleOAuthFlow({
                clientId,
                clientSecret,
                redirectPort: 8586
            });

            if (this.settings.googleAccessToken) {
                this.uploader = new GoogleDriveUploader({
                    clientId,
                    clientSecret,
                    accessToken: this.settings.googleAccessToken,
                    refreshToken: this.settings.googleRefreshToken,
                    tokenExpiresAt: this.settings.tokenExpiresAt,
                    onTokenRefresh: async (tokens) => {
                        this.settings.googleAccessToken = tokens.accessToken;
                        this.settings.googleRefreshToken = tokens.refreshToken;
                        this.settings.tokenExpiresAt = tokens.expiresAt;
                        await this.saveSettings();
                    }
                });
                this.hydrateDriveEmbeds(document.body);
            }
        }
    }

    private setupPrivateEmbedHydration() {
        this.registerMarkdownPostProcessor((el) => {
            this.hydrateDriveEmbeds(el);
        });

        this.app.workspace.onLayoutReady(() => {
            this.hydrateDriveEmbeds(document.body);
        });

        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.hydrateDriveEmbeds(document.body);
            })
        );

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.hydrateDriveEmbeds(document.body);
            })
        );

        this.domObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (let i = 0; i < mutation.addedNodes.length; i++) {
                    const node = mutation.addedNodes[i];
                    if (node instanceof HTMLElement) {
                        this.hydrateDriveEmbeds(node);
                    }
                }
            }
        });

        this.domObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    private extractDriveFileId(rawUrl: string): string | null {
        if (!rawUrl || !rawUrl.includes('drive.google.com')) {
            return null;
        }
        const idQueryMatch = rawUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
        if (idQueryMatch && idQueryMatch[1]) {
            return idQueryMatch[1];
        }
        const pathMatch = rawUrl.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
        if (pathMatch && pathMatch[1]) {
            return pathMatch[1];
        }
        return null;
    }

    private hydrateDriveEmbeds(root: ParentNode) {
        if (!this.uploader || !this.isConnected()) {
            return;
        }

        const images: HTMLImageElement[] = [];
        if (root instanceof HTMLImageElement) {
            images.push(root);
        } else if (root.querySelectorAll) {
            root.querySelectorAll('img').forEach((img) => images.push(img));
        }

        for (const img of images) {
            const rawSrc = img.getAttribute('src') || '';
            const fileId = img.dataset.driveFileId || this.extractDriveFileId(rawSrc);
            if (!fileId || rawSrc.startsWith('blob:') || img.dataset.driveHydrating === 'true') {
                continue;
            }
            img.dataset.driveFileId = fileId;
            img.dataset.driveHydrating = 'true';
            void this.uploader.downloadFileAsBlobUrl(fileId).then((entry) => {
                img.dataset.driveHydrating = 'false';
                if (entry && entry.blobUrl) {
                    img.src = entry.blobUrl;
                }
            });
        }

        const iframes: HTMLIFrameElement[] = [];
        if (root instanceof HTMLIFrameElement) {
            iframes.push(root);
        } else if (root.querySelectorAll) {
            root.querySelectorAll('iframe').forEach((iframe) => iframes.push(iframe));
        }

        for (const iframe of iframes) {
            const rawSrc = iframe.getAttribute('src') || '';
            const fileId = iframe.dataset.driveFileId || this.extractDriveFileId(rawSrc);
            if (!fileId || rawSrc.startsWith('blob:') || iframe.dataset.driveHydrating === 'true') {
                continue;
            }
            iframe.dataset.driveFileId = fileId;
            iframe.dataset.driveHydrating = 'true';
            void this.uploader.downloadFileAsBlobUrl(fileId).then((entry) => {
                iframe.dataset.driveHydrating = 'false';
                if (!entry || !entry.blobUrl) {
                    return;
                }
                if (entry.mimeType.startsWith('video/')) {
                    const video = document.createElement('video');
                    video.controls = true;
                    video.src = entry.blobUrl;
                    video.style.width = iframe.getAttribute('width') || '100%';
                    video.style.height = iframe.getAttribute('height') || 'auto';
                    video.style.borderRadius = '8px';
                    video.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
                    video.style.backgroundColor = '#000';
                    iframe.replaceWith(video);
                } else if (entry.mimeType.startsWith('audio/')) {
                    const audio = document.createElement('audio');
                    audio.controls = true;
                    audio.src = entry.blobUrl;
                    audio.style.width = '100%';
                    iframe.replaceWith(audio);
                } else if (entry.mimeType === 'application/pdf') {
                    iframe.src = entry.blobUrl;
                }
            });
        }
    }

    async startOAuthFlow(): Promise<boolean> {
        if (!this.oauthFlow) {
            new Notice('please enter Google OAuth settings first.');
            return false;
        }

        try {
            const tokens = await this.oauthFlow.startOAuthFlow();

            this.settings.googleAccessToken = tokens.accessToken;
            this.settings.googleRefreshToken = tokens.refreshToken;
            this.settings.tokenExpiresAt = tokens.expiresAt;
            await this.saveSettings();

            new Notice('✅ connected to Google Drive successfully!');
            return true;
        } catch (error) {
            console.error('OAuth flow failed:', error);
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`❌ connection failed: ${message}`);
            return false;
        }
    }

    async disconnectGoogleDrive() {
        this.uploader?.revokeAllBlobUrls();
        this.settings.googleAccessToken = '';
        this.settings.googleRefreshToken = '';
        this.settings.tokenExpiresAt = 0;
        this.uploader = null;
        await this.saveSettings();
        new Notice('disconnected from Google Drive.');
    }

    isConnected(): boolean {
        return !!this.settings.googleAccessToken && !!this.uploader;
    }

    private getActiveMarkdownEditor(preferredEditor?: Editor): Editor | undefined {
        if (preferredEditor) {
            return preferredEditor;
        }
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView?.editor) {
            return activeView.editor;
        }
        if (this.app.workspace.activeEditor?.editor) {
            return this.app.workspace.activeEditor.editor;
        }
        const markdownLeaf = this.app.workspace.getLeavesOfType('markdown')[0];
        if (markdownLeaf?.view instanceof MarkdownView) {
            return markdownLeaf.view.editor;
        }
        return undefined;
    }

    private openUploadModal(editor?: Editor) {
        if (!this.isConnected()) {
            new Notice('please connect to Google Drive first (in settings).');
            return;
        }

        if (!this.uploader) {
            new Notice('uploader initialization failed. please check settings.');
            return;
        }

        const initialEditor = this.getActiveMarkdownEditor(editor);

        new UploadModal(
            this.app,
            this.uploader,
            this.settings.driveFolder,
            this.settings.showTitleByDefault,
            (result: UploadModalResult) => {
                void (async () => {
                    const embedCode = this.embedGenerator.generateEmbed(
                        result.file.name,
                        result.uploadResult,
                        result.embedOptions
                    );

                    const targetEditor = this.getActiveMarkdownEditor(initialEditor);
                    if (targetEditor) {
                        // Insert at cursor position in the active note
                        targetEditor.replaceSelection(embedCode);
                        setTimeout(() => this.hydrateDriveEmbeds(document.body), 100);
                        new Notice('✅ Link & embed inserted into note!');
                    } else {
                        // Fallback: copy to clipboard if no Markdown note is open
                        await navigator.clipboard.writeText(embedCode);
                        new Notice('📋 embed code copied to clipboard!');
                    }
                })();
            }
        ).open();
    }
}

class DriveEmbedderSettingTab extends PluginSettingTab {
    plugin: DriveEmbedderPlugin;

    constructor(app: App, plugin: DriveEmbedderPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // Main heading removed per Obsidian guidelines (no plugin name in settings)

        // Connection status
        this.createConnectionSection(containerEl);

        // OAuth Settings
        this.createOAuthSection(containerEl);

        // Drive Settings
        this.createDriveSection(containerEl);

        // Embed Settings
        this.createEmbedSection(containerEl);

        // Help section
        this.createHelpSection(containerEl);
    }

    private createConnectionSection(containerEl: HTMLElement) {
        const connectionDiv = containerEl.createDiv({ cls: 'drive-embedder-connection-section' });

        const isConnected = this.plugin.isConnected();

        new Setting(connectionDiv)
            .setName('Connection status')
            .setHeading();

        const statusDiv = connectionDiv.createDiv({ cls: 'connection-status' });
        if (isConnected) {
            statusDiv.createSpan({ cls: 'status-connected', text: '✅ connected to Google Drive' });
        } else {
            statusDiv.createSpan({ cls: 'status-disconnected', text: '❌ not connected' });
        }

        if (isConnected) {
            new Setting(connectionDiv)
                .setName('Disconnect')
                .setDesc('disconnect from Google Drive')
                .addButton(button => button
                    .setButtonText('Disconnect')
                    .setWarning()
                    .onClick(() => {
                        void this.plugin.disconnectGoogleDrive().then(() => {
                            this.display();
                        });
                    })
                );
        } else {
            new Setting(connectionDiv)
                .setName('Connect to Google Drive')
                .setDesc('enter OAuth settings below, then click Connect')
                .addButton(button => button
                    .setButtonText('Connect')
                    .setCta()
                    .onClick(() => {
                        void this.plugin.startOAuthFlow().then((success) => {
                            if (success) {
                                this.display();
                            }
                        });
                    })
                );
        }
    }

    private createOAuthSection(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Google OAuth')
            .setHeading();

        new Setting(containerEl)
            .setName('Client ID')
            .setDesc('OAuth client ID from Google Cloud Console')
            .addText(text => text
                .setPlaceholder('xxx.apps.googleusercontent.com')
                .setValue(this.plugin.settings.googleClientId)
                .onChange((value) => {
                    this.plugin.settings.googleClientId = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Client secret')
            .setDesc('OAuth client secret from Google Cloud Console')
            .addText(text => text
                .setPlaceholder('GOCSPX-...')
                .setValue(this.plugin.settings.googleClientSecret)
                .onChange((value) => {
                    this.plugin.settings.googleClientSecret = value;
                    void this.plugin.saveSettings();
                })
            );
    }

    private createDriveSection(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Google Drive')
            .setHeading();

        new Setting(containerEl)
            .setName('Upload folder')
            .setDesc('Google Drive folder path for uploaded files')
            .addText(text => text
                .setPlaceholder('Obsidian/DriveEmbedder')
                .setValue(this.plugin.settings.driveFolder)
                .onChange((value) => {
                    this.plugin.settings.driveFolder = value;
                    void this.plugin.saveSettings();
                })
            );
    }

    private createEmbedSection(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Embed defaults')
            .setHeading();

        new Setting(containerEl)
            .setName('Show filename by default')
            .setDesc('display filename in embed code by default')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showTitleByDefault)
                .onChange((value) => {
                    this.plugin.settings.showTitleByDefault = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Default theme')
            .setDesc('default embed theme (auto-detects system theme)')
            .addDropdown(dropdown => dropdown
                .addOption('auto', 'Auto (follows system)')
                .addOption('light', 'Light')
                .addOption('dark', 'Dark')
                .setValue(this.plugin.settings.defaultTheme)
                .onChange((value: 'auto' | 'light' | 'dark') => {
                    this.plugin.settings.defaultTheme = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Default embed size')
            .setHeading();

        new Setting(containerEl)
            .setName('Default video size')
            .addDropdown(dropdown => dropdown
                .addOption('compact', 'Compact')
                .addOption('medium', 'Medium')
                .addOption('large', 'Large')
                .addOption('fullwidth', 'Full width')
                .setValue(this.plugin.settings.defaultVideoSize)
                .onChange((value) => {
                    this.plugin.settings.defaultVideoSize = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Default audio size')
            .addDropdown(dropdown => dropdown
                .addOption('slim', 'Slim')
                .addOption('standard', 'Standard')
                .setValue(this.plugin.settings.defaultAudioSize)
                .onChange((value) => {
                    this.plugin.settings.defaultAudioSize = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Default document size')
            .addDropdown(dropdown => dropdown
                .addOption('compact', 'Compact')
                .addOption('medium', 'Medium')
                .addOption('large', 'Large')
                .addOption('fullheight', 'Full height')
                .setValue(this.plugin.settings.defaultDocumentSize)
                .onChange((value) => {
                    this.plugin.settings.defaultDocumentSize = value;
                    void this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Default image size')
            .addDropdown(dropdown => dropdown
                .addOption('small', 'Small')
                .addOption('medium', 'Medium')
                .addOption('large', 'Large')
                .addOption('original', 'Original size')
                .setValue(this.plugin.settings.defaultImageSize)
                .onChange((value) => {
                    this.plugin.settings.defaultImageSize = value;
                    void this.plugin.saveSettings();
                })
            );
    }

    private createHelpSection(containerEl: HTMLElement) {
        new Setting(containerEl)
            .setName('Help')
            .setHeading();

        const helpDiv = containerEl.createDiv({ cls: 'drive-embedder-help' });

        // OAuth setup guide
        const oauthDetails = helpDiv.createEl('details');
        const oauthSummary = oauthDetails.createEl('summary');
        oauthSummary.createEl('strong', { text: '📋 how to set up Google OAuth' });
        const oauthList = oauthDetails.createEl('ol');
        const oauthStep1 = oauthList.createEl('li');
        oauthStep1.appendText('go to ');
        oauthStep1.createEl('a', { text: 'Google Cloud Console', href: 'https://console.cloud.google.com', attr: { target: '_blank' } });
        oauthList.createEl('li', { text: 'create a new project or select an existing one' });
        oauthList.createEl('li', { text: 'go to APIs & services → OAuth consent screen and configure' });
        oauthList.createEl('li', { text: 'go to APIs & services → Credentials → Create credentials → OAuth client ID' });
        oauthList.createEl('li', { text: 'select application type: desktop app' });
        oauthList.createEl('li', { text: 'enter the generated client ID and client secret in the settings above' });
        oauthList.createEl('li', { text: 'enable Google Drive API' });

        // Supported formats
        const formatsDetails = helpDiv.createEl('details');
        const formatsSummary = formatsDetails.createEl('summary');
        formatsSummary.createEl('strong', { text: '🎬 supported file formats' });
        const formatsList = formatsDetails.createEl('ul');
        const videoLi = formatsList.createEl('li');
        videoLi.createEl('strong', { text: 'Video: ' });
        videoLi.appendText('MP4, WebM, MOV, AVI');
        const audioLi = formatsList.createEl('li');
        audioLi.createEl('strong', { text: 'Audio: ' });
        audioLi.appendText('MP3, WAV, OGG, M4A');
        const docLi = formatsList.createEl('li');
        docLi.createEl('strong', { text: 'Document: ' });
        docLi.appendText('PDF');
        const imageLi = formatsList.createEl('li');
        imageLi.createEl('strong', { text: 'Image: ' });
        imageLi.appendText('JPG, PNG, GIF, WebP, SVG');

        // Size guide
        const sizeDetails = helpDiv.createEl('details');
        const sizeSummary = sizeDetails.createEl('summary');
        sizeSummary.createEl('strong', { text: '📐 embed size guide' });
        const sizeList = sizeDetails.createEl('ul');
        const compactLi = sizeList.createEl('li');
        compactLi.createEl('strong', { text: 'Compact: ' });
        compactLi.appendText('good size for inline content');
        const mediumLi = sizeList.createEl('li');
        mediumLi.createEl('strong', { text: 'Medium: ' });
        mediumLi.appendText('suitable for general viewing (recommended)');
        const largeLi = sizeList.createEl('li');
        largeLi.createEl('strong', { text: 'Large: ' });
        largeLi.appendText('when detailed view is needed');
        const fullLi = sizeList.createEl('li');
        fullLi.createEl('strong', { text: 'Full width: ' });
        fullLi.appendText('immersive full-width display');

        // How to use
        const howtoDetails = helpDiv.createEl('details');
        const howtoSummary = howtoDetails.createEl('summary');
        howtoSummary.createEl('strong', { text: '🔗 how to use' });
        const howtoList = howtoDetails.createEl('ol');
        howtoList.createEl('li', { text: 'click the cloud icon in the sidebar or search "Drive Embedder" in the command palette' });
        howtoList.createEl('li', { text: 'select a file (drag & drop or use the file picker button)' });
        howtoList.createEl('li', { text: 'choose your desired embed size' });
        howtoList.createEl('li', { text: 'click the "Upload and embed" button' });
        howtoList.createEl('li', { text: 'the embed code will be automatically inserted after upload' });
    }
}
