/**
 * Drive Embedder - Upload Modal
 * File picker and size selector UI
 */

import { Modal, App, Notice, Setting } from 'obsidian';
import { ContentCategory, SizeOption, UploadProgress, DriveUploadResult, EmbedOptions } from './types';
import { getFileTypeInfo, getSizePresets, getRecommendedSize, isFileSupported, SUPPORTED_EXTENSIONS } from './size-presets';
import { GoogleDriveUploader } from './uploader';

export interface UploadModalResult {
    file: File;
    uploadResult: DriveUploadResult;
    embedOptions: EmbedOptions;
}

export class UploadModal extends Modal {
    private uploader: GoogleDriveUploader;
    private driveFolder: string;
    private onComplete: (result: UploadModalResult) => void;

    private selectedFile: File | null = null;
    private selectedSize: SizeOption | null = null;
    private fileCategory: ContentCategory | null = null;
    private showTitle: boolean = true;

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
        onComplete: (result: UploadModalResult) => void
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
            text: '📁 upload file',
            cls: 'drive-embedder-title'
        });

        contentEl.createEl('p', {
            text: 'upload files to Google Drive and generate embed code.',
            cls: 'drive-embedder-subtitle'
        });

        // File Selection Section
        this.createFileSection(contentEl);

        // File Info Display (hidden initially)
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

        // Hidden file input
        this.fileInputEl = section.createEl('input', {
            type: 'file',
            cls: 'drive-embedder-file-input'
        });
        this.fileInputEl.accept = SUPPORTED_EXTENSIONS.join(',');
        this.fileInputEl.addEventListener('change', (e) => this.handleFileSelect(e));

        // Drop zone
        const dropZone = section.createDiv({ cls: 'drive-embedder-dropzone' });
        const dropzoneContent = dropZone.createDiv({ cls: 'dropzone-content' });
        dropzoneContent.createSpan({ cls: 'dropzone-icon', text: '📂' });
        dropzoneContent.createEl('p', { cls: 'dropzone-text', text: 'drag files here or' });
        const selectBtn = dropzoneContent.createEl('button', { cls: 'dropzone-btn', text: 'select file' });

        // Click to select
        selectBtn.addEventListener('click', () => this.fileInputEl?.click());

        // Drag and drop handlers
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.addClass('dragover');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.removeClass('dragover');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.removeClass('dragover');
            const files = e.dataTransfer?.files;
            if (files && files.length > 0) {
                this.processFile(files[0]);
            }
        });
    }

    private handleFileSelect(e: Event) {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        if (file) {
            this.processFile(file);
        }
    }

    private processFile(file: File) {
        // Check if file type is supported
        const fileInfo = getFileTypeInfo(file.name, file.type);
        if (!fileInfo) {
            new Notice('unsupported file type.');
            return;
        }

        this.selectedFile = file;
        this.fileCategory = fileInfo.category;

        // Update file info display
        this.updateFileInfo(file, fileInfo);

        // Show size options
        this.updateSizeOptions(fileInfo.category);

        // Enable upload button
        if (this.uploadBtn) {
            this.uploadBtn.disabled = false;
        }
    }

    private updateFileInfo(file: File, fileInfo: { category: ContentCategory; icon: string; label: string }) {
        if (!this.fileInfoEl) return;

        this.fileInfoEl.empty();
        this.fileInfoEl.removeClass('hidden');

        const infoCard = this.fileInfoEl.createDiv({ cls: 'file-info-card' });

        // File icon and name
        const fileHeader = infoCard.createDiv({ cls: 'file-header' });
        fileHeader.createSpan({ text: fileInfo.icon, cls: 'file-icon' });
        fileHeader.createSpan({ text: file.name, cls: 'file-name' });

        // File details
        const fileDetails = infoCard.createDiv({ cls: 'file-details' });
        fileDetails.createSpan({ text: `Type: ${fileInfo.label}`, cls: 'file-type' });
        fileDetails.createSpan({ text: `Size: ${this.formatFileSize(file.size)}`, cls: 'file-size' });
    }

    private updateSizeOptions(category: ContentCategory) {
        if (!this.sizeOptionsEl) return;

        this.sizeOptionsEl.empty();
        this.sizeOptionsEl.removeClass('hidden');

        const presets = getSizePresets(category);
        const recommended = getRecommendedSize(category);

        // Section title
        this.sizeOptionsEl.createEl('h4', {
            text: '📐 select embed size',
            cls: 'size-section-title'
        });

        // Size options grid
        const optionsGrid = this.sizeOptionsEl.createDiv({ cls: 'size-options-grid' });

        presets.forEach((preset) => {
            const option = optionsGrid.createDiv({
                cls: `size-option ${preset.id === recommended?.id ? 'recommended' : ''}`
            });

            option.createSpan({ cls: 'size-icon', text: preset.icon });
            option.createSpan({ cls: 'size-label', text: preset.label });
            option.createSpan({ cls: 'size-desc', text: preset.description });
            if (preset.recommended) {
                option.createSpan({ cls: 'recommended-badge', text: 'recommended' });
            }

            // Select default (recommended)
            if (preset.id === recommended?.id) {
                option.addClass('selected');
                this.selectedSize = preset;
            }

            option.addEventListener('click', () => {
                // Remove selection from all
                optionsGrid.querySelectorAll('.size-option').forEach(el =>
                    el.removeClass('selected')
                );
                // Select this one
                option.addClass('selected');
                this.selectedSize = preset;
            });
        });
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
        const file = this.selectedFile;
        const size = this.selectedSize;

        if (!file || !size) {
            new Notice('please select a file and size.');
            return;
        }

        // Disable upload button
        if (this.uploadBtn) {
            this.uploadBtn.disabled = true;
            this.uploadBtn.textContent = 'Uploading...';
        }

        // Show progress
        this.showProgress();

        try {
            const result = await this.uploader.uploadFile(
                file,
                this.driveFolder,
                (progress) => this.updateProgress(progress)
            );

            if (!result) {
                throw new Error('Failed to receive upload result.');
            }

            // Success!
            new Notice('✅ upload complete! embed code generated.');

            this.onComplete({
                file: file,
                uploadResult: result,
                embedOptions: {
                    size: size,
                    showTitle: this.showTitle
                }
            });

            this.close();
        } catch (error) {
            console.error('Upload failed:', error);
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`❌ upload failed: ${message}`);

            // Re-enable upload button
            if (this.uploadBtn) {
                this.uploadBtn.disabled = false;
                this.uploadBtn.textContent = '📤 upload and embed';
            }

            this.hideProgress();
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
