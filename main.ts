/**
 * Drive Embedder - Main Plugin
 * Upload local files to Google Drive and embed them in Obsidian notes
 */

import { Plugin, PluginSettingTab, App, Setting, Notice, Editor, MarkdownView, Platform, TFile, loadPdfJs } from 'obsidian';
import { DriveEmbedderSettings } from './src/types';
import { DEFAULT_SETTINGS } from './src/settings';
import { GoogleOAuthFlow } from './src/google-oauth-flow';
import { GoogleDriveUploader } from './src/uploader';
import { UploadModal, UploadModalResult } from './src/upload-modal';
import { EmbedGenerator } from './src/embed-generator';
import {
    ConfirmDeleteModal,
    DriveFileManagerView,
    DriveManagerPluginHost,
    VIEW_TYPE_DRIVE_MANAGER
} from './src/file-manager-view';
import { removeEmbedFromNote, scanVaultForEmbeds } from './src/embed-scanner';

export default class DriveEmbedderPlugin extends Plugin implements DriveManagerPluginHost {
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

        // Register sidebar file manager view
        this.registerView(
            VIEW_TYPE_DRIVE_MANAGER,
            (leaf) => new DriveFileManagerView(leaf, this)
        );

        // Add ribbon icon for uploading
        this.addRibbonIcon('cloud-upload', 'Drive Embedder: upload file', () => {
            this.openUploadModal(this.getActiveMarkdownEditor());
        });

        // Add ribbon icon for file manager sidebar
        this.addRibbonIcon('hard-drive', 'Drive Embedder: manage files', () => {
            void this.activateManagerView();
        });

        // Add command: upload and embed
        this.addCommand({
            id: 'upload-and-embed',
            name: 'upload file and embed',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                this.openUploadModal(editor);
            }
        });

        // Add command: open file manager sidebar
        this.addCommand({
            id: 'open-drive-file-manager',
            name: 'manage uploaded Drive files',
            callback: () => {
                void this.activateManagerView();
            }
        });

        // Add settings tab
        this.addSettingTab(new DriveEmbedderSettingTab(this.app, this));

        // Hydrate private Google Drive embeds in Reading View and Live Preview
        this.setupPrivateEmbedHydration();

        // Keep sidebar manager view updated on vault modifications
        this.registerEvent(
            this.app.vault.on('modify', () => {
                this.refreshManagerViews(false);
            })
        );
        this.registerEvent(
            this.app.vault.on('delete', () => {
                this.refreshManagerViews(true);
            })
        );
        this.registerEvent(
            this.app.vault.on('rename', () => {
                this.refreshManagerViews(true);
            })
        );

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

    getUploader(): GoogleDriveUploader | null {
        return this.uploader;
    }

    getEmbedGenerator(): EmbedGenerator {
        return this.embedGenerator;
    }

    getShowTitleByDefault(): boolean {
        return this.settings.showTitleByDefault;
    }

    openUploadModalFromManager(): void {
        this.openUploadModal(this.getActiveMarkdownEditor());
    }

    triggerHydration(): void {
        this.hydrateDriveEmbeds(document.body);
    }

    async activateManagerView(): Promise<void> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_DRIVE_MANAGER)[0];

        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                leaf = rightLeaf;
                await leaf.setViewState({
                    type: VIEW_TYPE_DRIVE_MANAGER,
                    active: true
                });
            }
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
            if (leaf.view instanceof DriveFileManagerView) {
                leaf.view.scheduleRefresh(false);
            }
        }
    }

    private refreshManagerViews(fullVaultScan = false, refreshDrive = false) {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_DRIVE_MANAGER);
        for (const leaf of leaves) {
            if (leaf.view instanceof DriveFileManagerView) {
                if (refreshDrive) {
                    void leaf.view.refreshAll();
                } else {
                    leaf.view.scheduleRefresh(fullVaultScan);
                }
            }
        }
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
                this.refreshManagerViews(true, true);
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
                this.refreshManagerViews(false);
            })
        );

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', () => {
                this.hydrateDriveEmbeds(document.body);
                this.refreshManagerViews(false);
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
            if (img.closest('.drive-manager-view')) {
                continue;
            }
            const rawSrc = img.getAttribute('src') || '';
            const fileId = img.dataset.driveFileId || this.extractDriveFileId(rawSrc);
            if (!fileId) {
                continue;
            }
            this.attachEmbedHoverButton(img, fileId);
            if (rawSrc.startsWith('blob:') || img.dataset.driveHydrating === 'true') {
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
            if (!fileId) {
                continue;
            }
            this.attachEmbedHoverButton(iframe, fileId);
            if (iframe.dataset.driveHydrating === 'true' || iframe.dataset.driveHydrated === 'true') {
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
                    video.dataset.driveFileId = fileId;
                    video.style.width = iframe.getAttribute('width') || '100%';
                    video.style.height = iframe.getAttribute('height') || 'auto';
                    video.style.borderRadius = '8px';
                    video.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
                    video.style.backgroundColor = '#000';
                    iframe.replaceWith(video);
                    this.attachEmbedHoverButton(video, fileId);
                } else if (entry.mimeType.startsWith('audio/')) {
                    const audio = document.createElement('audio');
                    audio.controls = true;
                    audio.src = entry.blobUrl;
                    audio.dataset.driveFileId = fileId;
                    audio.style.width = '100%';
                    iframe.replaceWith(audio);
                    this.attachEmbedHoverButton(audio, fileId);
                } else if (entry.mimeType === 'application/pdf') {
                    iframe.dataset.driveHydrated = 'true';
                    void this.renderPdfWithPdfJs(iframe, fileId, entry);
                }
            });
        }
    }

    /**
     * Render a private PDF file onto HTML5 canvas elements using Obsidian's built-in PDF.js (loadPdfJs).
     * Works identically on Desktop (app://obsidian.md) and Mobile (Android/iOS WebView).
     */
    private async renderPdfWithPdfJs(
        iframe: HTMLIFrameElement,
        fileId: string,
        entry: { blobUrl: string; mimeType: string; arrayBuffer?: ArrayBuffer }
    ) {
        const heightAttr = iframe.getAttribute('height') || '450px';
        const normalizedHeight = /^\d+$/.test(heightAttr) ? `${heightAttr}px` : heightAttr;

        const viewerEl = document.createElement('div');
        viewerEl.className = 'drive-pdf-viewer';
        viewerEl.dataset.driveFileId = fileId;

        const stopBubble = (e: Event) => {
            e.stopPropagation();
        };
        viewerEl.addEventListener('mousedown', stopBubble);
        viewerEl.addEventListener('pointerdown', stopBubble);
        viewerEl.addEventListener('click', stopBubble);

        // Top toolbar
        const toolbarEl = document.createElement('div');
        toolbarEl.className = 'drive-pdf-toolbar';

        const leftControls = document.createElement('div');
        leftControls.className = 'drive-pdf-toolbar-left';

        const statusSpan = document.createElement('span');
        statusSpan.className = 'drive-pdf-status';
        statusSpan.textContent = '📄 Loading PDF...';
        leftControls.appendChild(statusSpan);

        const zoomGroup = document.createElement('div');
        zoomGroup.className = 'drive-pdf-zoom-group';

        const zoomOutBtn = document.createElement('button');
        zoomOutBtn.type = 'button';
        zoomOutBtn.className = 'drive-pdf-zoom-btn';
        zoomOutBtn.title = 'Zoom out';
        zoomOutBtn.textContent = '−';

        const zoomLabel = document.createElement('span');
        zoomLabel.className = 'drive-pdf-zoom-label';
        zoomLabel.textContent = '100%';

        const zoomInBtn = document.createElement('button');
        zoomInBtn.type = 'button';
        zoomInBtn.className = 'drive-pdf-zoom-btn';
        zoomInBtn.title = 'Zoom in';
        zoomInBtn.textContent = '+';

        const openLink = document.createElement('a');
        openLink.className = 'drive-pdf-open-link';
        openLink.href = `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
        openLink.target = '_blank';
        openLink.rel = 'noopener noreferrer';
        openLink.textContent = '↗ Drive';
        openLink.title = 'Open PDF in Google Drive';

        zoomGroup.appendChild(zoomOutBtn);
        zoomGroup.appendChild(zoomLabel);
        zoomGroup.appendChild(zoomInBtn);
        zoomGroup.appendChild(openLink);
        leftControls.appendChild(zoomGroup);

        toolbarEl.appendChild(leftControls);
        viewerEl.appendChild(toolbarEl);

        // Scrollable pages viewport
        const pagesContainer = document.createElement('div');
        pagesContainer.className = 'drive-pdf-pages';
        pagesContainer.style.height = normalizedHeight;
        viewerEl.appendChild(pagesContainer);

        iframe.replaceWith(viewerEl);
        this.attachEmbedHoverButton(viewerEl, fileId);

        try {
            const pdfjsLib = await loadPdfJs();
            let rawBuffer = entry.arrayBuffer;
            if (!rawBuffer) {
                const resp = await fetch(entry.blobUrl);
                rawBuffer = await resp.arrayBuffer();
                entry.arrayBuffer = rawBuffer;
            }

            // Copy buffer so PDF.js worker transfer does not detach the cached ArrayBuffer
            const pdfBytes = new Uint8Array(rawBuffer.slice(0));
            const loadingTask = pdfjsLib.getDocument({
                data: pdfBytes,
                isEvalSupported: false
            });
            const pdfDoc = await loadingTask.promise;
            const numPages: number = pdfDoc.numPages || 0;
            statusSpan.textContent = `📄 ${numPages} ${numPages === 1 ? 'page' : 'pages'}`;

            let currentZoom = 1.0;
            let renderGeneration = 0;

            const renderAllPages = async (zoom: number) => {
                const gen = ++renderGeneration;
                zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
                pagesContainer.replaceChildren();

                let containerWidth = pagesContainer.clientWidth;
                if (containerWidth < 100) {
                    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                    containerWidth = pagesContainer.clientWidth;
                }
                const targetWidth = Math.max(220, (containerWidth || 560) - 28);
                const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

                for (let pageNum = 1; pageNum <= numPages; pageNum++) {
                    if (gen !== renderGeneration || !viewerEl.isConnected) {
                        return;
                    }
                    const page = await pdfDoc.getPage(pageNum);
                    if (gen !== renderGeneration || !viewerEl.isConnected) {
                        return;
                    }
                    const unscaledViewport = page.getViewport({ scale: 1 });
                    const baseScale = targetWidth / Math.max(1, unscaledViewport.width);
                    const cssScale = baseScale * zoom;
                    const hiDpiViewport = page.getViewport({ scale: cssScale * dpr });

                    const pageWrapper = document.createElement('div');
                    pageWrapper.className = 'drive-pdf-page-wrapper';

                    const canvas = document.createElement('canvas');
                    canvas.className = 'drive-pdf-page-canvas';
                    canvas.width = Math.floor(hiDpiViewport.width);
                    canvas.height = Math.floor(hiDpiViewport.height);
                    canvas.style.width = `${Math.floor(unscaledViewport.width * cssScale)}px`;
                    canvas.style.height = `${Math.floor(unscaledViewport.height * cssScale)}px`;

                    pageWrapper.appendChild(canvas);
                    pagesContainer.appendChild(pageWrapper);

                    const ctx = canvas.getContext('2d');
                    if (ctx) {
                        await page.render({
                            canvasContext: ctx,
                            viewport: hiDpiViewport
                        }).promise;
                    }
                }
            };

            zoomOutBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                currentZoom = Math.max(0.5, Math.round((currentZoom - 0.25) * 100) / 100);
                void renderAllPages(currentZoom);
            });

            zoomInBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                currentZoom = Math.min(2.5, Math.round((currentZoom + 0.25) * 100) / 100);
                void renderAllPages(currentZoom);
            });

            zoomLabel.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                currentZoom = 1.0;
                void renderAllPages(currentZoom);
            });
            zoomLabel.title = 'Click to reset zoom to 100%';

            await renderAllPages(currentZoom);
        } catch (err) {
            console.error(`Failed to render PDF with PDF.js (${fileId}):`, err);
            statusSpan.textContent = '⚠️ Could not render PDF preview';
        }
    }

    /**
     * Attach a desktop-only hover delete button to the top-right corner of an embed container
     */
    private attachEmbedHoverButton(mediaEl: HTMLElement, fileId: string) {
        if (Platform.isMobile) {
            return;
        }
        const parent = mediaEl.parentElement;
        if (!parent) {
            return;
        }
        const container = parent.tagName === 'A' ? parent.parentElement : parent;
        if (!(container instanceof HTMLElement) || container.tagName !== 'DIV') {
            return;
        }
        if (
            container.classList.contains('markdown-preview-view') ||
            container.classList.contains('markdown-preview-sizer') ||
            container.classList.contains('cm-content')
        ) {
            return;
        }

        container.classList.add('drive-embed-container');
        if (container.querySelector('.drive-embed-hover-bar')) {
            return;
        }

        const hoverBar = document.createElement('div');
        hoverBar.className = 'drive-embed-hover-bar';

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'drive-embed-hover-btn danger';
        deleteBtn.title = 'Delete Google Drive file...';
        deleteBtn.textContent = '🗑️ Delete';

        const stopEditorUnfold = (e: Event) => {
            e.preventDefault();
            e.stopPropagation();
        };
        deleteBtn.addEventListener('mousedown', stopEditorUnfold);
        deleteBtn.addEventListener('pointerdown', stopEditorUnfold);
        deleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            void this.openHoverDeleteModal(fileId, mediaEl);
        });

        hoverBar.appendChild(deleteBtn);
        container.appendChild(hoverBar);
    }

    /**
     * Open confirmation modal when clicking the hover delete button on an embed
     */
    private async openHoverDeleteModal(fileId: string, mediaEl: HTMLElement) {
        // Resolve the Markdown file where this embed was clicked
        let noteFile: TFile | null = null;
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
            if (leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(mediaEl) && leaf.view.file) {
                noteFile = leaf.view.file;
                break;
            }
        }
        if (!noteFile) {
            const active = this.app.workspace.getActiveFile();
            if (active && active.extension === 'md') {
                noteFile = active;
            }
        }

        const vaultMap = await scanVaultForEmbeds(this.app);
        const allOccurrences = vaultMap.get(fileId) || [];
        const matchingInNote = noteFile
            ? allOccurrences.find(o => o.notePath === noteFile?.path)
            : undefined;

        const altName = mediaEl.getAttribute('alt') || '';
        const displayName = matchingInNote?.fileName || allOccurrences[0]?.fileName || altName || fileId;

        new ConfirmDeleteModal(this.app, {
            fileName: displayName,
            fileId,
            mode: noteFile ? 'note' : 'global',
            currentNoteFile: noteFile || undefined,
            allOccurrences,
            onConfirm: async ({ removeFromCurrentNote, removeFromAllNotes, trashOnDrive }) => {
                if (removeFromAllNotes && allOccurrences.length > 0) {
                    const uniquePaths = Array.from(new Set(allOccurrences.map(o => o.notePath)));
                    for (const p of uniquePaths) {
                        const af = this.app.vault.getAbstractFileByPath(p);
                        if (af instanceof TFile) {
                            await removeEmbedFromNote(this.app, af, {
                                fileId,
                                removeAllForFileId: true
                            });
                        }
                    }
                } else if (removeFromCurrentNote && noteFile) {
                    await removeEmbedFromNote(this.app, noteFile, {
                        fileId,
                        charStart: matchingInNote?.charStart,
                        lineStart: matchingInNote?.lineStart
                    });
                }

                if (trashOnDrive && this.uploader) {
                    const ok = await this.uploader.trashFile(fileId);
                    if (ok) {
                        new Notice(`🗑️ Removed from note & moved "${displayName}" to Google Drive trash.`);
                    } else {
                        new Notice(`⚠️ Removed from note, but could not move "${displayName}" to Drive trash.`);
                    }
                } else {
                    new Notice(`✅ Removed "${displayName}" embed from note.`);
                }

                this.refreshManagerViews(true, true);
            }
        }).open();
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
        this.refreshManagerViews(false, false);
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
                        setTimeout(() => {
                            this.hydrateDriveEmbeds(document.body);
                            this.refreshManagerViews(true, true);
                        }, 100);
                        new Notice('✅ Link & embed inserted into note!');
                    } else {
                        // Fallback: copy to clipboard if no Markdown note is open
                        await navigator.clipboard.writeText(embedCode);
                        this.refreshManagerViews(true, true);
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
