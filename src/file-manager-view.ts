/**
 * Drive Embedder - Sidebar File Manager View & Delete Confirmation Modals
 * Provides Per-Note and Global overview of Google Drive embeds, resizing, and safe deletion
 */

import {
    App,
    ItemView,
    MarkdownView,
    Modal,
    Notice,
    Setting,
    TFile,
    WorkspaceLeaf
} from 'obsidian';
import {
    ContentCategory,
    DriveFileMetadata,
    DriveUploadResult,
    NoteEmbedOccurrence,
    SizeOption
} from './types';
import {
    getCategoryIcon,
    getFileTypeInfo,
    getRecommendedSize,
    getSizePresets
} from './size-presets';
import {
    removeEmbedFromNote,
    resizeEmbedInNote,
    scanNoteContent,
    scanVaultForEmbeds
} from './embed-scanner';
import { GoogleDriveUploader } from './uploader';
import { EmbedGenerator } from './embed-generator';

export const VIEW_TYPE_DRIVE_MANAGER = 'drive-embedder-manager-view';

export interface DriveManagerPluginHost {
    app: App;
    isConnected(): boolean;
    getUploader(): GoogleDriveUploader | null;
    getEmbedGenerator(): EmbedGenerator;
    getShowTitleByDefault(): boolean;
    openUploadModalFromManager(): void;
    triggerHydration(): void;
}

interface ConfirmDeleteOptions {
    fileName: string;
    fileId: string;
    mode: 'note' | 'global';
    currentNoteFile?: TFile;
    allOccurrences: NoteEmbedOccurrence[];
    onConfirm: (choices: {
        removeFromCurrentNote: boolean;
        removeFromAllNotes: boolean;
        trashOnDrive: boolean;
    }) => Promise<void>;
}

/**
 * Confirmation Modal before deleting an embed or moving a file to Google Drive Trash
 */
export class ConfirmDeleteModal extends Modal {
    private options: ConfirmDeleteOptions;
    private trashOnDrive: boolean;
    private removeFromAllNotes: boolean;
    private isSubmitting = false;

    constructor(app: App, options: ConfirmDeleteOptions) {
        super(app);
        this.options = options;

        const otherNotesCount = this.getOtherOccurrencesCount();
        if (options.mode === 'note') {
            // Default to trashing on Drive only if not used elsewhere
            this.trashOnDrive = otherNotesCount === 0;
            this.removeFromAllNotes = false;
        } else {
            this.trashOnDrive = true;
            this.removeFromAllNotes = options.allOccurrences.length > 0;
        }
    }

    private getOtherOccurrencesCount(): number {
        const { currentNoteFile, allOccurrences } = this.options;
        if (!currentNoteFile) {
            return allOccurrences.length;
        }
        // If there are multiple occurrences even in the same note or other notes
        return Math.max(0, allOccurrences.length - 1);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('drive-embedder-modal', 'drive-delete-modal');

        contentEl.createEl('h3', {
            text: '🗑️ Delete Google Drive file',
            cls: 'drive-embedder-title'
        });

        const fileCard = contentEl.createDiv({ cls: 'drive-delete-file-box' });
        const typeInfo = getFileTypeInfo(this.options.fileName);
        fileCard.createSpan({
            text: typeInfo ? typeInfo.icon : '📁',
            cls: 'drive-delete-file-icon'
        });
        fileCard.createSpan({
            text: this.options.fileName,
            cls: 'drive-delete-file-name'
        });

        const { mode, currentNoteFile, allOccurrences } = this.options;
        const otherCount = this.getOtherOccurrencesCount();

        if (mode === 'note' && currentNoteFile) {
            contentEl.createEl('p', {
                text: `This will completely remove the link and embed block from "${currentNoteFile.basename}".`,
                cls: 'drive-delete-desc'
            });

            if (otherCount > 0) {
                const warnBox = contentEl.createDiv({ cls: 'drive-delete-warning' });
                warnBox.createSpan({
                    text: `⚠️ This file is also embedded ${otherCount} more time(s) in your vault.`
                });
            }

            const extraSettingsDiv = contentEl.createDiv({ cls: 'drive-delete-options' });

            new Setting(extraSettingsDiv)
                .setName('Move file to Google Drive trash')
                .setDesc('Moves the file to your Google Drive trash (recoverable for 30 days)')
                .addToggle(toggle =>
                    toggle.setValue(this.trashOnDrive).onChange(val => {
                        this.trashOnDrive = val;
                        if (!val) {
                            this.removeFromAllNotes = false;
                        }
                        this.onOpen();
                    })
                );

            if (this.trashOnDrive && otherCount > 0) {
                new Setting(extraSettingsDiv)
                    .setName(`Also remove from all other notes (${otherCount})`)
                    .setDesc('Cleanly removes all remaining embed blocks for this file across the vault')
                    .addToggle(toggle =>
                        toggle.setValue(this.removeFromAllNotes).onChange(val => {
                            this.removeFromAllNotes = val;
                        })
                    );
            }
        } else {
            // Global mode
            contentEl.createEl('p', {
                text: 'This will move the file to your Google Drive trash (recoverable for 30 days).',
                cls: 'drive-delete-desc'
            });

            if (allOccurrences.length > 0) {
                const warnBox = contentEl.createDiv({ cls: 'drive-delete-warning' });
                const uniqueNotes = Array.from(new Set(allOccurrences.map(o => o.noteName)));
                warnBox.createSpan({
                    text: `📄 Currently embedded in ${allOccurrences.length} place(s) (${uniqueNotes.join(', ')}).`
                });

                const extraSettingsDiv = contentEl.createDiv({ cls: 'drive-delete-options' });
                new Setting(extraSettingsDiv)
                    .setName(`Remove embed blocks from all notes (${allOccurrences.length})`)
                    .setDesc('Cleanly deletes the markdown link and HTML embed from those notes')
                    .addToggle(toggle =>
                        toggle.setValue(this.removeFromAllNotes).onChange(val => {
                            this.removeFromAllNotes = val;
                        })
                    );
            }
        }

        const btnRow = contentEl.createDiv({ cls: 'drive-embedder-buttons' });

        const cancelBtn = btnRow.createEl('button', {
            text: 'Cancel',
            cls: 'drive-embedder-btn cancel'
        });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = btnRow.createEl('button', {
            text: this.trashOnDrive ? '🗑️ Move to trash' : 'Remove from note',
            cls: 'drive-embedder-btn danger'
        });

        confirmBtn.addEventListener('click', () => {
            if (this.isSubmitting) {
                return;
            }
            this.isSubmitting = true;
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Deleting...';

            void (async () => {
                try {
                    await this.options.onConfirm({
                        removeFromCurrentNote: mode === 'note',
                        removeFromAllNotes: this.removeFromAllNotes,
                        trashOnDrive: this.trashOnDrive
                    });
                    this.close();
                } catch (err) {
                    console.error('Delete action failed:', err);
                    new Notice('❌ Failed to complete delete action.');
                    this.isSubmitting = false;
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = this.trashOnDrive ? '🗑️ Move to trash' : 'Remove from note';
                }
            })();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Confirmation Modal before bulk-trashing all unused/orphaned Drive files
 */
export class ConfirmBulkTrashModal extends Modal {
    private unusedFiles: DriveFileMetadata[];
    private onConfirm: () => Promise<void>;
    private isSubmitting = false;

    constructor(app: App, unusedFiles: DriveFileMetadata[], onConfirm: () => Promise<void>) {
        super(app);
        this.unusedFiles = unusedFiles;
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('drive-embedder-modal', 'drive-delete-modal');

        contentEl.createEl('h3', {
            text: `🧹 Move ${this.unusedFiles.length} unused file(s) to trash?`,
            cls: 'drive-embedder-title'
        });

        contentEl.createEl('p', {
            text: 'These files are not embedded in any note in your vault. They will be moved to your Google Drive trash (recoverable for 30 days):',
            cls: 'drive-delete-desc'
        });

        const listEl = contentEl.createDiv({ cls: 'drive-bulk-trash-list' });
        for (const file of this.unusedFiles) {
            const item = listEl.createDiv({ cls: 'drive-bulk-trash-item' });
            const info = getFileTypeInfo(file.name, file.mimeType);
            item.createSpan({ text: info ? info.icon : '📁', cls: 'drive-bulk-icon' });
            item.createSpan({ text: file.name, cls: 'drive-bulk-name' });
        }

        const btnRow = contentEl.createDiv({ cls: 'drive-embedder-buttons' });

        const cancelBtn = btnRow.createEl('button', {
            text: 'Cancel',
            cls: 'drive-embedder-btn cancel'
        });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = btnRow.createEl('button', {
            text: `🗑️ Trash ${this.unusedFiles.length} file(s)`,
            cls: 'drive-embedder-btn danger'
        });

        confirmBtn.addEventListener('click', () => {
            if (this.isSubmitting) {
                return;
            }
            this.isSubmitting = true;
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Moving to trash...';

            void (async () => {
                try {
                    await this.onConfirm();
                    this.close();
                } catch (err) {
                    console.error('Bulk trash failed:', err);
                    new Notice('❌ Bulk trash failed.');
                    this.isSubmitting = false;
                    confirmBtn.disabled = false;
                }
            })();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Sidebar ItemView for managing Google Drive embeds per-note and globally
 */
export class DriveFileManagerView extends ItemView {
    private host: DriveManagerPluginHost;
    private activeTab: 'note' | 'global' = 'note';
    private lastActiveMarkdownFile: TFile | null = null;

    // Cached state
    private vaultOccurrencesMap: Map<string, NoteEmbedOccurrence[]> = new Map();
    private driveFiles: DriveFileMetadata[] = [];
    private driveFilesMap: Map<string, DriveFileMetadata> = new Map();
    private isLoadingDrive = false;
    private hasLoadedDriveOnce = false;

    // Global filters
    private searchQuery = '';
    private usageFilter: 'all' | 'used' | 'unused' = 'all';
    private categoryFilter: 'all' | ContentCategory = 'all';

    // Debounce timer
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(leaf: WorkspaceLeaf, host: DriveManagerPluginHost) {
        super(leaf);
        this.host = host;
    }

    getViewType(): string {
        return VIEW_TYPE_DRIVE_MANAGER;
    }

    getDisplayText(): string {
        return 'Drive files';
    }

    getIcon(): string {
        return 'hard-drive';
    }

    async onOpen() {
        this.updateLastActiveFile();
        await this.refreshVaultScan();
        this.render();
        if (this.host.isConnected()) {
            void this.refreshDriveFiles();
        }
    }

    async onClose() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.contentEl.empty();
    }

    /**
     * Trigger a debounced refresh when active note or note content changes
     */
    scheduleRefresh(fullVaultScan = false) {
        this.updateLastActiveFile();
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            void (async () => {
                if (fullVaultScan) {
                    await this.refreshVaultScan();
                } else {
                    await this.refreshActiveNoteScan();
                }
                this.render();
            })();
        }, 200);
    }

    /**
     * Refresh both Google Drive files and full vault scan
     */
    async refreshAll() {
        this.updateLastActiveFile();
        await this.refreshVaultScan();
        await this.refreshDriveFiles();
    }

    private updateLastActiveFile() {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
            this.lastActiveMarkdownFile = activeFile;
            return;
        }
        const mdLeaf = this.app.workspace.getLeavesOfType('markdown')[0];
        if (mdLeaf && mdLeaf.view instanceof MarkdownView && mdLeaf.view.file) {
            this.lastActiveMarkdownFile = mdLeaf.view.file;
        }
    }

    private async refreshVaultScan() {
        this.vaultOccurrencesMap = await scanVaultForEmbeds(this.app);
    }

    private async refreshActiveNoteScan() {
        const file = this.lastActiveMarkdownFile;
        if (!file) {
            return;
        }
        try {
            const content = await this.app.vault.cachedRead(file);
            const noteOccs = scanNoteContent(content, file.path, file.basename);

            // Remove old occurrences for this notePath from vaultOccurrencesMap
            for (const [fileId, list] of this.vaultOccurrencesMap.entries()) {
                const filtered = list.filter(o => o.notePath !== file.path);
                if (filtered.length > 0) {
                    this.vaultOccurrencesMap.set(fileId, filtered);
                } else {
                    this.vaultOccurrencesMap.delete(fileId);
                }
            }

            // Add fresh occurrences for this notePath
            for (const occ of noteOccs) {
                const list = this.vaultOccurrencesMap.get(occ.fileId) || [];
                list.push(occ);
                this.vaultOccurrencesMap.set(occ.fileId, list);
            }
        } catch (err) {
            console.debug('Error scanning active note:', err);
        }
    }

    async refreshDriveFiles() {
        const uploader = this.host.getUploader();
        if (!uploader || !this.host.isConnected()) {
            this.driveFiles = [];
            this.driveFilesMap.clear();
            this.render();
            return;
        }

        if (this.isLoadingDrive) {
            return;
        }

        this.isLoadingDrive = true;
        this.render();

        try {
            const files = await uploader.listUploadedFiles();
            this.driveFiles = files;
            this.driveFilesMap.clear();
            for (const f of files) {
                this.driveFilesMap.set(f.id, f);
            }
            this.hasLoadedDriveOnce = true;
        } finally {
            this.isLoadingDrive = false;
            this.render();
        }
    }

    private getActiveNoteOccurrences(): NoteEmbedOccurrence[] {
        const file = this.lastActiveMarkdownFile;
        if (!file) {
            return [];
        }
        const results: NoteEmbedOccurrence[] = [];
        for (const list of this.vaultOccurrencesMap.values()) {
            for (const occ of list) {
                if (occ.notePath === file.path) {
                    results.push(occ);
                }
            }
        }
        results.sort((a, b) => a.charStart - b.charStart);
        return results;
    }

    render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('drive-manager-view');

        // 1. Header bar
        const header = contentEl.createDiv({ cls: 'drive-manager-header' });
        const titleRow = header.createDiv({ cls: 'drive-manager-title-row' });
        titleRow.createSpan({ text: '☁️ Drive files', cls: 'drive-manager-title' });

        const headerBtns = titleRow.createDiv({ cls: 'drive-manager-header-btns' });

        const uploadBtn = headerBtns.createEl('button', {
            text: '📤 Upload',
            cls: 'drive-manager-icon-btn primary',
            attr: { title: 'Upload a new file to Google Drive' }
        });
        uploadBtn.addEventListener('click', () => {
            this.host.openUploadModalFromManager();
        });

        const refreshBtn = headerBtns.createEl('button', {
            text: this.isLoadingDrive ? '⏳' : '🔄',
            cls: 'drive-manager-icon-btn',
            attr: { title: 'Refresh Drive files and vault scan' }
        });
        refreshBtn.disabled = this.isLoadingDrive;
        refreshBtn.addEventListener('click', () => {
            void this.refreshAll();
        });

        // 2. Tabs
        const noteOccs = this.getActiveNoteOccurrences();
        const totalDriveCount = this.driveFiles.length;

        const tabsRow = header.createDiv({ cls: 'drive-manager-tabs' });

        const noteTabBtn = tabsRow.createEl('button', {
            cls: `drive-manager-tab ${this.activeTab === 'note' ? 'active' : ''}`,
            text: `📄 Current note (${noteOccs.length})`
        });
        noteTabBtn.addEventListener('click', () => {
            this.activeTab = 'note';
            this.render();
        });

        const globalTabBtn = tabsRow.createEl('button', {
            cls: `drive-manager-tab ${this.activeTab === 'global' ? 'active' : ''}`,
            text: `🌍 All Drive files (${this.hasLoadedDriveOnce ? totalDriveCount : '…'})`
        });
        globalTabBtn.addEventListener('click', () => {
            this.activeTab = 'global';
            if (!this.hasLoadedDriveOnce && !this.isLoadingDrive && this.host.isConnected()) {
                void this.refreshDriveFiles();
            } else {
                this.render();
            }
        });

        // 3. Body content
        const body = contentEl.createDiv({ cls: 'drive-manager-body' });

        if (!this.host.isConnected()) {
            const disconnectedBox = body.createDiv({ cls: 'drive-manager-empty' });
            disconnectedBox.createSpan({ text: '🔌', cls: 'drive-manager-empty-icon' });
            disconnectedBox.createEl('p', {
                text: 'Not connected to Google Drive. Please connect in plugin settings.'
            });
            return;
        }

        if (this.activeTab === 'note') {
            this.renderNoteTab(body, noteOccs);
        } else {
            this.renderGlobalTab(body);
        }
    }

    private renderNoteTab(container: HTMLElement, occurrences: NoteEmbedOccurrence[]) {
        const activeFile = this.lastActiveMarkdownFile;
        if (!activeFile) {
            const empty = container.createDiv({ cls: 'drive-manager-empty' });
            empty.createSpan({ text: '📝', cls: 'drive-manager-empty-icon' });
            empty.createEl('p', { text: 'Open a Markdown note to see its embedded Google Drive files.' });
            return;
        }

        const noteBanner = container.createDiv({ cls: 'drive-manager-note-banner' });
        noteBanner.createSpan({ text: '📄 ', cls: 'drive-manager-note-icon' });
        noteBanner.createSpan({ text: activeFile.path, cls: 'drive-manager-note-path' });

        if (occurrences.length === 0) {
            const empty = container.createDiv({ cls: 'drive-manager-empty' });
            empty.createSpan({ text: '📭', cls: 'drive-manager-empty-icon' });
            empty.createEl('p', { text: 'No Google Drive files embedded in this note.' });
            const uploadCta = empty.createEl('button', {
                text: '📤 Upload and embed file',
                cls: 'drive-embedder-btn primary'
            });
            uploadCta.addEventListener('click', () => {
                this.host.openUploadModalFromManager();
            });
            return;
        }

        const listEl = container.createDiv({ cls: 'drive-manager-list' });

        for (const occ of occurrences) {
            const card = listEl.createDiv({ cls: 'drive-manager-card' });
            const driveMeta = this.driveFilesMap.get(occ.fileId);
            const allOccsForFile = this.vaultOccurrencesMap.get(occ.fileId) || [occ];

            // Card Top Row: Icon/Thumb + File Info
            const topRow = card.createDiv({ cls: 'drive-card-top' });

            const iconWrap = topRow.createDiv({ cls: 'drive-card-icon-wrap' });
            const cachedBlob = this.host.getUploader()?.getCachedBlobUrl(occ.fileId);
            if (occ.category === 'image' && cachedBlob?.blobUrl) {
                const thumbImg = iconWrap.createEl('img', {
                    cls: 'drive-card-thumb',
                    attr: { src: cachedBlob.blobUrl, alt: occ.fileName }
                });
                thumbImg.addEventListener('error', () => {
                    thumbImg.replaceWith(createSpan({ text: getCategoryIcon(occ.category), cls: 'drive-card-icon' }));
                });
            } else {
                iconWrap.createSpan({
                    text: getCategoryIcon(occ.category),
                    cls: 'drive-card-icon'
                });
            }

            const infoCol = topRow.createDiv({ cls: 'drive-card-info' });
            const displayName = driveMeta?.name || occ.fileName;
            infoCol.createDiv({
                text: displayName,
                cls: 'drive-card-name',
                attr: { title: displayName }
            });

            const metaRow = infoCol.createDiv({ cls: 'drive-card-meta' });
            metaRow.createSpan({
                text: `Line ${occ.lineStart + 1}`,
                cls: 'drive-badge line-badge'
            });

            if (driveMeta?.size !== undefined) {
                metaRow.createSpan({
                    text: this.formatFileSize(driveMeta.size),
                    cls: 'drive-card-size'
                });
            } else if (this.hasLoadedDriveOnce && !driveMeta) {
                metaRow.createSpan({
                    text: '⚠️ Missing on Drive',
                    cls: 'drive-badge warning-badge'
                });
            }

            if (allOccsForFile.length > 1) {
                metaRow.createSpan({
                    text: `🔗 ${allOccsForFile.length}× in vault`,
                    cls: 'drive-badge usage-badge',
                    attr: { title: `Used in: ${Array.from(new Set(allOccsForFile.map(o => o.noteName))).join(', ')}` }
                });
            }

            // Size Preset Selector Row
            const sizeRow = card.createDiv({ cls: 'drive-card-size-row' });
            sizeRow.createSpan({ text: '📐 Size:', cls: 'drive-card-size-label' });

            const sizeSelect = sizeRow.createEl('select', { cls: 'drive-manager-size-select' });
            const presets = getSizePresets(occ.category);

            if (!occ.matchedSizeId) {
                sizeSelect.createEl('option', {
                    value: '',
                    text: `Custom (${occ.currentWidth || 'auto'})`
                });
            }

            for (const preset of presets) {
                const opt = sizeSelect.createEl('option', {
                    value: preset.id,
                    text: `${preset.label} (${preset.width}${preset.height !== 'auto' ? ' × ' + preset.height : ''})`
                });
                if (preset.id === occ.matchedSizeId) {
                    opt.selected = true;
                }
            }

            sizeSelect.addEventListener('change', () => {
                const chosen = presets.find(p => p.id === sizeSelect.value);
                if (!chosen) {
                    return;
                }
                void (async () => {
                    const ok = await resizeEmbedInNote(this.app, activeFile, occ, chosen);
                    if (ok) {
                        this.updateLiveDomEmbedSize(occ.fileId, chosen);
                        new Notice(`📐 Updated "${displayName}" size to ${chosen.label}`);
                        await this.refreshActiveNoteScan();
                        this.render();
                    }
                })();
            });

            // Actions Row
            const actionsRow = card.createDiv({ cls: 'drive-card-actions' });

            const jumpBtn = actionsRow.createEl('button', {
                text: '📍 Jump',
                cls: 'drive-card-btn',
                attr: { title: 'Jump to this embed in the note' }
            });
            jumpBtn.addEventListener('click', () => {
                void this.jumpToOccurrence(occ);
            });

            const openDriveBtn = actionsRow.createEl('button', {
                text: '🌐 Drive',
                cls: 'drive-card-btn',
                attr: { title: 'Open file in Google Drive' }
            });
            openDriveBtn.addEventListener('click', () => {
                const url = driveMeta?.webViewLink || `https://drive.google.com/file/d/${occ.fileId}/view`;
                window.open(url, '_blank', 'noopener,noreferrer');
            });

            const deleteBtn = actionsRow.createEl('button', {
                text: '🗑️ Delete',
                cls: 'drive-card-btn danger',
                attr: { title: 'Remove embed from note and move file to Google Drive trash' }
            });
            deleteBtn.addEventListener('click', () => {
                this.openDeleteDialogForNoteOccurrence(activeFile, occ, displayName, allOccsForFile);
            });
        }
    }

    private renderGlobalTab(container: HTMLElement) {
        if (this.isLoadingDrive && !this.hasLoadedDriveOnce) {
            const loading = container.createDiv({ cls: 'drive-manager-empty' });
            loading.createSpan({ text: '⏳', cls: 'drive-manager-empty-icon' });
            loading.createEl('p', { text: 'Loading files from Google Drive...' });
            return;
        }

        // Compute unused files
        const unusedFiles = this.driveFiles.filter(f => {
            const occs = this.vaultOccurrencesMap.get(f.id);
            return !occs || occs.length === 0;
        });
        const usedFilesCount = this.driveFiles.length - unusedFiles.length;

        // Filter & Search Controls
        const controls = container.createDiv({ cls: 'drive-manager-controls' });

        const searchInput = controls.createEl('input', {
            type: 'search',
            placeholder: '🔍 Search by filename or note...',
            cls: 'drive-manager-search'
        });
        searchInput.value = this.searchQuery;
        searchInput.addEventListener('input', () => {
            this.searchQuery = searchInput.value;
            this.renderGlobalListOnly(listWrapper, unusedFiles);
        });

        // Usage filter pills
        const pillRow = controls.createDiv({ cls: 'drive-manager-pills' });
        const filters: Array<{ id: 'all' | 'used' | 'unused'; label: string }> = [
            { id: 'all', label: `All (${this.driveFiles.length})` },
            { id: 'used', label: `Used (${usedFilesCount})` },
            { id: 'unused', label: `⚠️ Unused (${unusedFiles.length})` }
        ];

        for (const f of filters) {
            const pill = pillRow.createEl('button', {
                text: f.label,
                cls: `drive-filter-pill ${this.usageFilter === f.id ? 'active' : ''}`
            });
            pill.addEventListener('click', () => {
                this.usageFilter = f.id;
                this.render();
            });
        }

        // Category dropdown filter
        const catRow = controls.createDiv({ cls: 'drive-manager-cat-row' });
        const catSelect = catRow.createEl('select', { cls: 'drive-manager-cat-select' });
        const categories: Array<{ id: 'all' | ContentCategory; label: string }> = [
            { id: 'all', label: 'All file types' },
            { id: 'image', label: '🖼️ Images' },
            { id: 'video', label: '🎬 Videos' },
            { id: 'audio', label: '🎵 Audio' },
            { id: 'document', label: '📄 Documents (PDF)' }
        ];
        for (const c of categories) {
            const opt = catSelect.createEl('option', { value: c.id, text: c.label });
            if (this.categoryFilter === c.id) {
                opt.selected = true;
            }
        }
        catSelect.addEventListener('change', () => {
            this.categoryFilter = catSelect.value as 'all' | ContentCategory;
            this.renderGlobalListOnly(listWrapper, unusedFiles);
        });

        // Bulk cleanup banner if unused files exist
        if (unusedFiles.length > 0) {
            const cleanupBar = container.createDiv({ cls: 'drive-manager-cleanup-bar' });
            cleanupBar.createSpan({
                text: `⚠️ ${unusedFiles.length} file(s) not used in any note`,
                cls: 'drive-cleanup-text'
            });
            const bulkBtn = cleanupBar.createEl('button', {
                text: '🧹 Trash unused',
                cls: 'drive-card-btn danger'
            });
            bulkBtn.addEventListener('click', () => {
                new ConfirmBulkTrashModal(this.app, unusedFiles, async () => {
                    const uploader = this.host.getUploader();
                    if (!uploader) {
                        return;
                    }
                    let trashed = 0;
                    for (const file of unusedFiles) {
                        const ok = await uploader.trashFile(file.id);
                        if (ok) {
                            trashed++;
                        }
                    }
                    new Notice(`🗑️ Moved ${trashed} unused file(s) to Google Drive trash.`);
                    await this.refreshAll();
                }).open();
            });
        }

        const listWrapper = container.createDiv({ cls: 'drive-manager-list-wrapper' });
        this.renderGlobalListOnly(listWrapper, unusedFiles);
    }

    private renderGlobalListOnly(wrapper: HTMLElement, unusedFiles: DriveFileMetadata[]) {
        wrapper.empty();

        const query = this.searchQuery.trim().toLowerCase();
        const filtered = this.driveFiles.filter(file => {
            const occs = this.vaultOccurrencesMap.get(file.id) || [];
            const isUsed = occs.length > 0;

            if (this.usageFilter === 'used' && !isUsed) {
                return false;
            }
            if (this.usageFilter === 'unused' && isUsed) {
                return false;
            }

            const info = getFileTypeInfo(file.name, file.mimeType);
            const category: ContentCategory = info ? info.category : 'document';
            if (this.categoryFilter !== 'all' && category !== this.categoryFilter) {
                return false;
            }

            if (query) {
                const nameMatch = file.name.toLowerCase().includes(query);
                const noteMatch = occs.some(o => o.noteName.toLowerCase().includes(query) || o.notePath.toLowerCase().includes(query));
                if (!nameMatch && !noteMatch) {
                    return false;
                }
            }

            return true;
        });

        if (filtered.length === 0) {
            const empty = wrapper.createDiv({ cls: 'drive-manager-empty' });
            empty.createSpan({ text: '🔍', cls: 'drive-manager-empty-icon' });
            empty.createEl('p', {
                text: this.driveFiles.length === 0
                    ? 'No uploaded files found in Google Drive.'
                    : 'No files match the current filter.'
            });
            return;
        }

        const listEl = wrapper.createDiv({ cls: 'drive-manager-list' });

        for (const file of filtered) {
            const occs = this.vaultOccurrencesMap.get(file.id) || [];
            const typeInfo = getFileTypeInfo(file.name, file.mimeType);
            const category: ContentCategory = typeInfo ? typeInfo.category : 'document';

            const card = listEl.createDiv({ cls: 'drive-manager-card' });
            const topRow = card.createDiv({ cls: 'drive-card-top' });

            const iconWrap = topRow.createDiv({ cls: 'drive-card-icon-wrap' });
            const cachedBlob = this.host.getUploader()?.getCachedBlobUrl(file.id);
            if (category === 'image' && cachedBlob?.blobUrl) {
                const thumbImg = iconWrap.createEl('img', {
                    cls: 'drive-card-thumb',
                    attr: { src: cachedBlob.blobUrl, alt: file.name }
                });
                thumbImg.addEventListener('error', () => {
                    thumbImg.replaceWith(createSpan({ text: getCategoryIcon(category), cls: 'drive-card-icon' }));
                });
            } else {
                iconWrap.createSpan({
                    text: getCategoryIcon(category),
                    cls: 'drive-card-icon'
                });
            }

            const infoCol = topRow.createDiv({ cls: 'drive-card-info' });
            infoCol.createDiv({
                text: file.name,
                cls: 'drive-card-name',
                attr: { title: file.name }
            });

            const metaRow = infoCol.createDiv({ cls: 'drive-card-meta' });
            if (file.size !== undefined) {
                metaRow.createSpan({
                    text: this.formatFileSize(file.size),
                    cls: 'drive-card-size'
                });
            }
            if (file.createdTime) {
                metaRow.createSpan({
                    text: this.formatDate(file.createdTime),
                    cls: 'drive-card-date'
                });
            }

            // Usage badges (which notes use this file)
            const usageBox = card.createDiv({ cls: 'drive-card-usage-list' });
            if (occs.length === 0) {
                usageBox.createSpan({
                    text: '⚠️ Unused (not embedded in any note)',
                    cls: 'drive-badge warning-badge'
                });
            } else {
                for (const occ of occs) {
                    const noteChip = usageBox.createEl('button', {
                        text: `📄 ${occ.noteName} :${occ.lineStart + 1}`,
                        cls: 'drive-note-chip',
                        attr: { title: `Open ${occ.notePath} at line ${occ.lineStart + 1}` }
                    });
                    noteChip.addEventListener('click', () => {
                        void this.jumpToOccurrence(occ);
                    });
                }
            }

            // Actions row
            const actionsRow = card.createDiv({ cls: 'drive-card-actions' });

            const insertBtn = actionsRow.createEl('button', {
                text: '➕ Embed',
                cls: 'drive-card-btn',
                attr: { title: 'Insert embed into the active note' }
            });
            insertBtn.addEventListener('click', () => {
                void this.embedExistingFileIntoActiveNote(file, category);
            });

            const openDriveBtn = actionsRow.createEl('button', {
                text: '🌐 Drive',
                cls: 'drive-card-btn',
                attr: { title: 'Open in Google Drive' }
            });
            openDriveBtn.addEventListener('click', () => {
                const url = file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;
                window.open(url, '_blank', 'noopener,noreferrer');
            });

            const deleteBtn = actionsRow.createEl('button', {
                text: '🗑️ Delete',
                cls: 'drive-card-btn danger',
                attr: { title: 'Move file to Google Drive trash' }
            });
            deleteBtn.addEventListener('click', () => {
                this.openDeleteDialogForGlobalFile(file, occs);
            });
        }
    }

    private openDeleteDialogForNoteOccurrence(
        noteFile: TFile,
        occurrence: NoteEmbedOccurrence,
        displayName: string,
        allOccurrences: NoteEmbedOccurrence[]
    ) {
        new ConfirmDeleteModal(this.app, {
            fileName: displayName,
            fileId: occurrence.fileId,
            mode: 'note',
            currentNoteFile: noteFile,
            allOccurrences,
            onConfirm: async ({ removeFromCurrentNote, removeFromAllNotes, trashOnDrive }) => {
                if (removeFromAllNotes) {
                    await this.removeFileFromAllVaultNotes(occurrence.fileId, allOccurrences);
                } else if (removeFromCurrentNote) {
                    await removeEmbedFromNote(this.app, noteFile, {
                        fileId: occurrence.fileId,
                        charStart: occurrence.charStart,
                        lineStart: occurrence.lineStart
                    });
                }

                if (trashOnDrive) {
                    const uploader = this.host.getUploader();
                    if (uploader) {
                        const ok = await uploader.trashFile(occurrence.fileId);
                        if (ok) {
                            this.driveFiles = this.driveFiles.filter(f => f.id !== occurrence.fileId);
                            this.driveFilesMap.delete(occurrence.fileId);
                            new Notice(`🗑️ Removed from note & moved "${displayName}" to Google Drive trash.`);
                        } else {
                            new Notice(`⚠️ Removed from note, but could not move "${displayName}" to Drive trash.`);
                        }
                    }
                } else {
                    new Notice(`✅ Removed "${displayName}" embed from note.`);
                }

                await this.refreshVaultScan();
                this.render();
            }
        }).open();
    }

    private openDeleteDialogForGlobalFile(
        file: DriveFileMetadata,
        allOccurrences: NoteEmbedOccurrence[]
    ) {
        new ConfirmDeleteModal(this.app, {
            fileName: file.name,
            fileId: file.id,
            mode: 'global',
            allOccurrences,
            onConfirm: async ({ removeFromAllNotes, trashOnDrive }) => {
                if (removeFromAllNotes && allOccurrences.length > 0) {
                    await this.removeFileFromAllVaultNotes(file.id, allOccurrences);
                }

                if (trashOnDrive) {
                    const uploader = this.host.getUploader();
                    if (uploader) {
                        const ok = await uploader.trashFile(file.id);
                        if (ok) {
                            this.driveFiles = this.driveFiles.filter(f => f.id !== file.id);
                            this.driveFilesMap.delete(file.id);
                            new Notice(`🗑️ Moved "${file.name}" to Google Drive trash.`);
                        } else {
                            new Notice(`❌ Failed to move "${file.name}" to Google Drive trash.`);
                        }
                    }
                }

                await this.refreshVaultScan();
                this.render();
            }
        }).open();
    }

    private async removeFileFromAllVaultNotes(fileId: string, occurrences: NoteEmbedOccurrence[]) {
        const uniquePaths = Array.from(new Set(occurrences.map(o => o.notePath)));
        for (const path of uniquePaths) {
            const abstractFile = this.app.vault.getAbstractFileByPath(path);
            if (abstractFile instanceof TFile) {
                await removeEmbedFromNote(this.app, abstractFile, {
                    fileId,
                    removeAllForFileId: true
                });
            }
        }
    }

    private async embedExistingFileIntoActiveNote(file: DriveFileMetadata, category: ContentCategory) {
        this.updateLastActiveFile();
        const targetFile = this.lastActiveMarkdownFile;
        if (!targetFile) {
            new Notice('Please open a Markdown note first.');
            return;
        }

        const size = getRecommendedSize(category);
        const uploadResult: DriveUploadResult = {
            fileId: file.id,
            fileName: file.name,
            mimeType: file.mimeType,
            webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
            webContentLink: `https://drive.google.com/uc?export=view&id=${file.id}`
        };

        const embedCode = this.host.getEmbedGenerator().generateEmbed(file.name, uploadResult, {
            size,
            showTitle: this.host.getShowTitleByDefault()
        });

        // Find leaf with targetFile
        const mdLeaf = this.app.workspace.getLeavesOfType('markdown').find(
            l => l.view instanceof MarkdownView && l.view.file?.path === targetFile.path
        );

        if (mdLeaf && mdLeaf.view instanceof MarkdownView) {
            this.app.workspace.setActiveLeaf(mdLeaf, { focus: true });
            mdLeaf.view.editor.replaceSelection(embedCode + '\n');
            setTimeout(() => this.host.triggerHydration(), 100);
            new Notice(`✅ Embedded "${file.name}" into ${targetFile.basename}`);
        } else {
            await this.app.vault.append(targetFile, '\n' + embedCode + '\n');
            new Notice(`✅ Appended "${file.name}" to ${targetFile.basename}`);
        }

        await this.refreshVaultScan();
        this.render();
    }

    private async jumpToOccurrence(occ: NoteEmbedOccurrence) {
        const abstractFile = this.app.vault.getAbstractFileByPath(occ.notePath);
        if (!(abstractFile instanceof TFile)) {
            new Notice('Note file not found.');
            return;
        }

        let targetLeaf = this.app.workspace.getLeavesOfType('markdown').find(
            l => l.view instanceof MarkdownView && l.view.file?.path === abstractFile.path
        );

        if (!targetLeaf) {
            targetLeaf = this.app.workspace.getLeaf(false);
            await targetLeaf.openFile(abstractFile);
        } else {
            this.app.workspace.setActiveLeaf(targetLeaf, { focus: true });
        }

        if (targetLeaf.view instanceof MarkdownView) {
            const editor = targetLeaf.view.editor;
            const pos = { line: occ.lineStart, ch: 0 };
            const endPos = { line: occ.lineEnd, ch: editor.getLine(occ.lineEnd)?.length || 0 };
            editor.setCursor(pos);
            editor.setSelection(pos, endPos);
            editor.scrollIntoView({ from: pos, to: endPos }, true);
        }
    }

    /**
     * Immediately update rendered DOM elements in Reading View / Live Preview after resizing
     */
    private updateLiveDomEmbedSize(fileId: string, newSize: SizeOption) {
        const elements = document.querySelectorAll(`[data-drive-file-id="${CSS.escape(fileId)}"]`);
        elements.forEach((el) => {
            if (el instanceof HTMLImageElement) {
                el.style.height = newSize.height;
                const parentDiv = el.closest('div');
                if (parentDiv instanceof HTMLElement) {
                    parentDiv.style.width = newSize.width;
                }
            } else if (el instanceof HTMLIFrameElement || el instanceof HTMLVideoElement) {
                el.style.height = newSize.height;
                if (el instanceof HTMLIFrameElement) {
                    el.setAttribute('height', newSize.height);
                }
                const parentDiv = el.closest('div');
                if (parentDiv instanceof HTMLElement) {
                    parentDiv.style.width = newSize.width;
                }
            }
        });
    }

    private formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    private formatDate(isoDate: string): string {
        try {
            const d = new Date(isoDate);
            return d.toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            });
        } catch {
            return '';
        }
    }
}
