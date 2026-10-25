/**
 * Drive Embedder - Upload Modal
 * Multi-file picker, queue list, per-file & global size selector UI
 */

import { Modal, App, Notice, Setting } from 'obsidian';
import { ContentCategory, SizeOption, UploadProgress, DriveUploadResult, EmbedOptions } from './types';
import { getFileTypeInfo, getSizePresets, getRecommendedSize, SUPPORTED_EXTENSIONS } from './size-presets';
import { GoogleDriveUploader } from './uploader';

export interface UploadModalResult {
    file: File;
    uploadResult: DriveUploadResult;
    embedOptions: EmbedOptions;
}

interface QueuedUploadItem {
    id: string;
    file: File;
    category: ContentCategory;
    icon: string;
    label: string;
    selectedSize: SizeOption;
    status: 'pending' | 'uploading' | 'done' | 'error';
    errorMessage?: string;
}

export class UploadModal extends Modal {
    private uploader: GoogleDriveUploader;
    private driveFolder: string;
    private onComplete: (results: UploadModalResult[]) => void;

    private queuedItems: QueuedUploadItem[] = [];
    private showTitle: boolean = true;
    private isUploading: boolean = false;

    // UI Elements
    private fileInputEl: HTMLInputElement | null = null;
    private fileInfoEl: HTMLElement | null = null;
    private sizeOptionsEl: HTMLElement | null = null;
    private progressEl: HTMLElement | null = null;
    private uploadBtn: HTMLButtonElement | null = null;

    // Progress UI Elements
    private progressFillEl: HTMLElement | null = null;
    private progressStatusEl: HTMLElement | null = null;
    private progressPercentEl: HTMLElement | null = null;

    constructor(
        app: App,
        uploader: GoogleDriveUploader,
        driveFolder: string,
        defaultShowTitle: boolean,
        onComplete: (results: UploadModalResult[]) => void
    ) {
        super(app);
        this.uploader = uploader;
        this.driveFolder = driveFolder;
        this.showTitle = defaultShowTitle;
        this.onComplete = onComplete;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('drive-embedder-modal');

        // Modal Header
        contentEl.createEl('h2', {
            text: '📁 upload files',
            cls: 'drive-embedder-title'
        });

        contentEl.createEl('p', {
            text: 'upload one or multiple files to Google Drive and insert embeds.',
            cls: 'drive-embedder-subtitle'
        });

        // File Selection Section
        this.createFileSection(contentEl);

        // File Queue Info Display (hidden initially)
        this.fileInfoEl = contentEl.createDiv({ cls: 'drive-embedder-file-info hidden' });

        // Size Options Section (hidden initially)
        this.sizeOptionsEl = contentEl.createDiv({ cls: 'drive-embedder-size-options hidden' });

        // Title Toggle
        this.createTitleToggle(contentEl);

        // Progress Section (hidden initially)
        this.progressEl = contentEl.createDiv({ cls: 'drive-embedder-progress hidden' });

        // Action Buttons
        this.createActionButtons(contentEl);

        // Supported formats info
        this.createSupportedFormatsInfo(contentEl);
    }

    private createFileSection(container: HTMLElement) {
        const section = container.createDiv({ cls: 'drive-embedder-section' });

        // Hidden file input with multiple enabled
        this.fileInputEl = section.createEl('input', {
            type: 'file',
            cls: 'drive-embedder-file-input'
        });
        this.fileInputEl.multiple = true;
        this.fileInputEl.accept = SUPPORTED_EXTENSIONS.join(',');
        this.fileInputEl.addEventListener('change', (e) => this.handleFileSelect(e));

        // Drop zone
        const dropZone = section.createDiv({ cls: 'drive-embedder-dropzone' });
        const dropzoneContent = dropZone.createDiv({ cls: 'dropzone-content' });
        dropzoneContent.createSpan({ cls: 'dropzone-icon', text: '📂' });
        dropzoneContent.createEl('p', { cls: 'dropzone-text', text: 'drag files here or' });
        const selectBtn = dropzoneContent.createEl('button', { cls: 'dropzone-btn', text: 'select files' });

        // Click to select
        selectBtn.addEventListener('click', () => {
            if (!this.isUploading) {
                this.fileInputEl?.click();
            }
        });

        // Drag and drop handlers
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!this.isUploading) {
                dropZone.addClass('dragover');
            }
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.removeClass('dragover');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.removeClass('dragover');
            if (this.isUploading) return;
            const files = e.dataTransfer?.files;
            if (files && files.length > 0) {
                this.processFiles(Array.from(files));
            }
        });
    }

    private handleFileSelect(e: Event) {
        const input = e.target as HTMLInputElement;
        const files = input.files;
        if (files && files.length > 0) {
            this.processFiles(Array.from(files));
            // Reset input so selecting the same or more files triggers change again
            input.value = '';
        }
    }

    private processFiles(files: File[]) {
        let addedCount = 0;

        for (const file of files) {
            const fileInfo = getFileTypeInfo(file.name, file.type);
            if (!fileInfo) {
                new Notice(`unsupported file type: ${file.name}`);
                continue;
            }

            // Avoid adding exact duplicate in the current queue
            const fileKey = `${file.name}::${file.size}::${file.lastModified}`;
            if (this.queuedItems.some(item => item.id === fileKey)) {
                continue;
            }

            this.queuedItems.push({
                id: fileKey,
                file,
                category: fileInfo.category,
                icon: fileInfo.icon,
                label: fileInfo.label,
                selectedSize: getRecommendedSize(fileInfo.category),
                status: 'pending'
            });
            addedCount++;
        }

        if (addedCount > 0 || this.queuedItems.length > 0) {
            this.refreshQueueAndSizeUI();
        }
    }

    private removeQueuedItem(id: string) {
        if (this.isUploading) return;
        this.queuedItems = this.queuedItems.filter(item => item.id !== id);
        this.refreshQueueAndSizeUI();
    }

    private clearAllQueuedItems() {
        if (this.isUploading) return;
        this.queuedItems = [];
        this.refreshQueueAndSizeUI();
    }

    private refreshQueueAndSizeUI() {
        this.updateFileInfo();
        this.updateSizeOptions();
        this.updateUploadButtonState();
    }

    private updateUploadButtonState() {
        if (!this.uploadBtn) return;
        const count = this.queuedItems.length;
        if (count === 0) {
            this.uploadBtn.disabled = true;
            this.uploadBtn.textContent = '📤 upload and embed';
        } else if (count === 1) {
            this.uploadBtn.disabled = this.isUploading;
            this.uploadBtn.textContent = this.isUploading ? 'Uploading...' : '📤 upload and embed';
        } else {
            this.uploadBtn.disabled = this.isUploading;
            this.uploadBtn.textContent = this.isUploading
                ? 'Uploading...'
                : `📤 upload and embed (${count} files)`;
        }
    }

    private updateFileInfo() {
        if (!this.fileInfoEl) return;

        this.fileInfoEl.empty();

        if (this.queuedItems.length === 0) {
            this.fileInfoEl.addClass('hidden');
            return;
        }

        this.fileInfoEl.removeClass('hidden');

        // Summary header when multiple files are queued
        if (this.queuedItems.length > 1) {
            const totalBytes = this.queuedItems.reduce((sum, item) => sum + item.file.size, 0);
            const queueHeader = this.fileInfoEl.createDiv({ cls: 'drive-queue-header' });
            queueHeader.createSpan({
                cls: 'drive-queue-count',
                text: `${this.queuedItems.length} files selected (${this.formatFileSize(totalBytes)})`
            });

            if (!this.isUploading) {
                const clearBtn = queueHeader.createEl('button', {
                    type: 'button',
                    cls: 'drive-queue-clear-btn',
                    text: 'Clear all'
                });
                clearBtn.addEventListener('click', () => this.clearAllQueuedItems());
            }
        }

        const listEl = this.fileInfoEl.createDiv({ cls: 'drive-queue-list' });

        for (const item of this.queuedItems) {
            const infoCard = listEl.createDiv({
                cls: `file-info-card drive-queue-item status-${item.status}`
            });

            // Top row: icon, filename, size dropdown, status/remove button
            const fileHeader = infoCard.createDiv({ cls: 'file-header drive-queue-row' });

            const titleGroup = fileHeader.createDiv({ cls: 'drive-queue-title-group' });
            titleGroup.createSpan({ text: item.icon, cls: 'file-icon' });
            titleGroup.createSpan({ text: item.file.name, cls: 'file-name' });

            const actionsGroup = fileHeader.createDiv({ cls: 'drive-queue-actions-group' });

            // Per-file size preset dropdown
            const presets = getSizePresets(item.category);
            const sizeSelect = actionsGroup.createEl('select', {
                cls: 'drive-queue-size-select',
                attr: { 'aria-label': `Embed size for ${item.file.name}` }
            });
            sizeSelect.disabled = this.isUploading;

            for (const preset of presets) {
                const opt = sizeSelect.createEl('option', {
                    value: preset.id,
                    text: `${preset.icon} ${preset.label} (${preset.width})`
                });
                if (preset.id === item.selectedSize.id) {
                    opt.selected = true;
                }
            }

            sizeSelect.addEventListener('change', () => {
                const chosen = presets.find(p => p.id === sizeSelect.value);
                if (chosen) {
                    item.selectedSize = chosen;
                    this.updateSizeOptions();
                }
            });

            // Status indicator or remove button
            if (item.status === 'uploading') {
                actionsGroup.createSpan({ cls: 'drive-queue-status', text: '⏳' });
            } else if (item.status === 'done') {
                actionsGroup.createSpan({ cls: 'drive-queue-status', text: '✅' });
            } else if (item.status === 'error') {
                actionsGroup.createSpan({
                    cls: 'drive-queue-status',
                    text: '❌',
                    attr: { title: item.errorMessage || 'Upload failed' }
                });
            }

            if (!this.isUploading) {
                const removeBtn = actionsGroup.createEl('button', {
                    type: 'button',
                    cls: 'drive-queue-remove-btn',
                    text: '✕',
                    attr: { title: 'Remove file from queue' }
                });
                removeBtn.addEventListener('click', () => this.removeQueuedItem(item.id));
            }

            // Bottom row: file details
            const fileDetails = infoCard.createDiv({ cls: 'file-details' });
            fileDetails.createSpan({ text: `Type: ${item.label}`, cls: 'file-type' });
            fileDetails.createSpan({ text: `Size: ${this.formatFileSize(item.file.size)}`, cls: 'file-size' });
            if (item.status === 'error' && item.errorMessage) {
                fileDetails.createSpan({ text: `Error: ${item.errorMessage}`, cls: 'drive-queue-error-text' });
            }
        }
    }

    private updateSizeOptions() {
        if (!this.sizeOptionsEl) return;

        this.sizeOptionsEl.empty();

        if (this.queuedItems.length === 0) {
            this.sizeOptionsEl.addClass('hidden');
            return;
        }

        this.sizeOptionsEl.removeClass('hidden');

        const uniqueCategories = Array.from(new Set(this.queuedItems.map(item => item.category)));

        if (uniqueCategories.length === 1) {
            // All files share the same category -> show that category's exact presets
            const category = uniqueCategories[0];
            const presets = getSizePresets(category);
            const recommended = getRecommendedSize(category);

            // Check if all queued items currently share the same preset id
            const commonSizeId = this.queuedItems.every(i => i.selectedSize.id === this.queuedItems[0].selectedSize.id)
                ? this.queuedItems[0].selectedSize.id
                : null;

            this.sizeOptionsEl.createEl('h4', {
                text: this.queuedItems.length > 1 ? '📐 select embed size (applies to all)' : '📐 select embed size',
                cls: 'size-section-title'
            });

            const optionsGrid = this.sizeOptionsEl.createDiv({ cls: 'size-options-grid' });

            presets.forEach((preset) => {
                const option = optionsGrid.createDiv({
                    cls: `size-option ${preset.id === recommended?.id ? 'recommended' : ''} ${preset.id === commonSizeId ? 'selected' : ''}`
                });

                option.createSpan({ cls: 'size-icon', text: preset.icon });
                option.createSpan({ cls: 'size-label', text: preset.label });
                option.createSpan({ cls: 'size-desc', text: preset.description });
                if (preset.recommended) {
                    option.createSpan({ cls: 'recommended-badge', text: 'recommended' });
                }

                option.addEventListener('click', () => {
                    if (this.isUploading) return;
                    for (const item of this.queuedItems) {
                        item.selectedSize = preset;
                    }
                    this.updateFileInfo();
                    this.updateSizeOptions();
                });
            });
        } else {
            // Mixed categories -> show global quick-preset buttons that map to each file's category
            this.sizeOptionsEl.createEl('h4', {
                text: '📐 apply size to all files (or adjust per file above)',
                cls: 'size-section-title'
            });

            const optionsGrid = this.sizeOptionsEl.createDiv({ cls: 'size-options-grid' });
            const globalTiers: Array<{ id: 'compact' | 'recommended' | 'large' | 'max'; icon: string; label: string; desc: string; recommended?: boolean }> = [
                { id: 'compact', icon: '🔹', label: 'Compact', desc: 'smaller inline preview' },
                { id: 'recommended', icon: '🔸', label: 'Recommended', desc: 'default size per file type', recommended: true },
                { id: 'large', icon: '🔶', label: 'Large', desc: 'larger viewing size' },
                { id: 'max', icon: '🟠', label: 'Full / Max', desc: 'maximum width & height' }
            ];

            for (const tier of globalTiers) {
                const option = optionsGrid.createDiv({
                    cls: `size-option ${tier.recommended ? 'recommended' : ''}`
                });
                option.createSpan({ cls: 'size-icon', text: tier.icon });
                option.createSpan({ cls: 'size-label', text: tier.label });
                option.createSpan({ cls: 'size-desc', text: tier.desc });

                option.addEventListener('click', () => {
                    if (this.isUploading) return;
                    for (const item of this.queuedItems) {
                        const catPresets = getSizePresets(item.category);
                        if (tier.id === 'recommended') {
                            item.selectedSize = getRecommendedSize(item.category);
                        } else if (tier.id === 'compact') {
                            item.selectedSize = catPresets.find(p => p.id === 'compact') || catPresets[0];
                        } else if (tier.id === 'large') {
                            item.selectedSize = catPresets.find(p => p.id === 'large') || catPresets[catPresets.length - 1];
                        } else {
                            item.selectedSize = catPresets[catPresets.length - 1];
                        }
                    }
                    this.updateFileInfo();
                    optionsGrid.querySelectorAll('.size-option').forEach(el => el.removeClass('selected'));
                    option.addClass('selected');
                });
            }
        }
    }

    private createTitleToggle(container: HTMLElement) {
        const toggleSection = container.createDiv({ cls: 'drive-embedder-toggle-section' });

        new Setting(toggleSection)
            .setName('Show filename')
            .setDesc('display filename above the embed')
            .addToggle(toggle => toggle
                .setValue(this.showTitle)
                .onChange(value => {
                    this.showTitle = value;
                })
            );
    }

    private createActionButtons(container: HTMLElement) {
        const buttonContainer = container.createDiv({ cls: 'drive-embedder-buttons' });

        // Cancel button
        const cancelBtn = buttonContainer.createEl('button', {
            text: 'Cancel',
            cls: 'drive-embedder-btn cancel'
        });
        cancelBtn.addEventListener('click', () => this.close());

        // Upload button
        this.uploadBtn = buttonContainer.createEl('button', {
            text: '📤 upload and embed',
            cls: 'drive-embedder-btn primary'
        });
        this.uploadBtn.disabled = true;
        this.uploadBtn.addEventListener('click', () => { void this.handleUpload(); });
    }

    private createSupportedFormatsInfo(container: HTMLElement) {
        const infoSection = container.createDiv({ cls: 'drive-embedder-formats-info' });

        const details = infoSection.createEl('details');
        details.createEl('summary', { text: 'supported file formats' });
        const formatsGrid = details.createDiv({ cls: 'formats-grid' });

        const formats = [
            { icon: '🎬', label: 'Video', types: 'MP4, WebM, MOV, AVI' },
            { icon: '🎵', label: 'Audio', types: 'MP3, WAV, OGG, M4A' },
            { icon: '📄', label: 'Document', types: 'PDF' },
            { icon: '🖼️', label: 'Image', types: 'JPG, PNG, GIF, WebP, SVG' }
        ];

        formats.forEach(format => {
            const group = formatsGrid.createDiv({ cls: 'format-group' });
            group.createSpan({ cls: 'format-icon', text: format.icon });
            group.createSpan({ cls: 'format-label', text: format.label });
            group.createSpan({ cls: 'format-types', text: format.types });
        });
    }

    private async handleUpload() {
        if (this.queuedItems.length === 0 || this.isUploading) {
            new Notice('please select at least one file.');
            return;
        }

        this.isUploading = true;
        this.updateUploadButtonState();
        this.updateFileInfo();
        this.showProgress();

        const completedResults: UploadModalResult[] = [];
        const totalFiles = this.queuedItems.length;
        let finishedCount = 0;

        for (let i = 0; i < this.queuedItems.length; i++) {
            const item = this.queuedItems[i];
            item.status = 'uploading';
            item.errorMessage = undefined;
            this.updateFileInfo();

            const prefix = totalFiles > 1 ? `[${i + 1}/${totalFiles}] ${item.file.name}: ` : '';

            try {
                const result = await this.uploader.uploadFile(
                    item.file,
                    this.driveFolder,
                    (progress) => {
                        const overallProgress = ((finishedCount * 100) + progress.progress) / totalFiles;
                        this.updateProgress({
                            stage: progress.stage,
                            message: `${prefix}${progress.message}`,
                            progress: overallProgress
                        });
                    }
                );

                if (!result) {
                    throw new Error('Failed to receive upload result.');
                }

                item.status = 'done';
                finishedCount++;
                completedResults.push({
                    file: item.file,
                    uploadResult: result,
                    embedOptions: {
                        size: item.selectedSize,
                        showTitle: this.showTitle
                    }
                });
                this.updateFileInfo();
            } catch (error) {
                console.error(`Upload failed for ${item.file.name}:`, error);
                const message = error instanceof Error ? error.message : String(error);
                item.status = 'error';
                item.errorMessage = message;
                finishedCount++;
                this.updateFileInfo();
            }
        }

        this.isUploading = false;

        // Immediately pass any completed uploads to the note
        if (completedResults.length > 0) {
            this.onComplete(completedResults);
        }

        const failedItems = this.queuedItems.filter(item => item.status === 'error');
        if (failedItems.length === 0) {
            new Notice(
                completedResults.length === 1
                    ? '✅ upload complete! embed code generated.'
                    : `✅ ${completedResults.length} files uploaded and embedded!`
            );
            this.close();
        } else {
            // Keep only failed items in the modal so retry won't re-upload already inserted files
            this.queuedItems = failedItems;
            this.hideProgress();
            this.refreshQueueAndSizeUI();
            if (this.uploadBtn) {
                this.uploadBtn.textContent = `🔄 retry failed (${failedItems.length})`;
            }
            new Notice(
                completedResults.length > 0
                    ? `⚠️ ${completedResults.length} uploaded, ${failedItems.length} failed. You can retry the failed files.`
                    : `❌ upload failed for ${failedItems.length} file(s).`
            );
        }
    }

    private showProgress() {
        if (!this.progressEl) return;

        this.progressEl.empty();
        this.progressEl.removeClass('hidden');

        const container = this.progressEl.createDiv({ cls: 'progress-container' });
        const progressBar = container.createDiv({ cls: 'progress-bar' });
        this.progressFillEl = progressBar.createDiv({ cls: 'progress-fill' });
        this.progressFillEl.setCssStyles({ width: '0%' });

        const progressText = container.createDiv({ cls: 'progress-text' });
        this.progressStatusEl = progressText.createSpan({ cls: 'progress-status', text: 'preparing...' });
        this.progressPercentEl = progressText.createSpan({ cls: 'progress-percent', text: '0%' });
    }

    private updateProgress(progress: UploadProgress) {
        if (!this.progressEl) return;

        if (this.progressFillEl) {
            this.progressFillEl.setCssStyles({ width: `${progress.progress}%` });
        }

        if (this.progressStatusEl) {
            this.progressStatusEl.textContent = progress.message;
        }

        if (this.progressPercentEl) {
            this.progressPercentEl.textContent = `${Math.round(progress.progress)}%`;
        }
    }

    private hideProgress() {
        if (this.progressEl) {
            this.progressEl.addClass('hidden');
        }
    }

    private formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
