/**
 * Google Drive Uploader with Progress Tracking
 * Handles file upload, permission setting, and token management
 */
import { requestUrl, Notice } from 'obsidian';
import { GoogleOAuthFlow } from './google-oauth-flow';
import { OAuthTokens, DriveUploadResult, UploadProgress, DriveFileMetadata } from './types';

export interface GoogleDriveConfig {
    clientId: string;
    clientSecret: string;
    accessToken: string;
    refreshToken: string;
    tokenExpiresAt: number;
    driveFolder?: string;
    onTokenRefresh?: (tokens: OAuthTokens) => Promise<void>;
}

export class GoogleDriveUploader {
    private readonly API_URL = 'https://www.googleapis.com/drive/v3';
    private readonly UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3';
    private readonly REDIRECT_PORT = 8586;

    private config: GoogleDriveConfig;
    private oauthFlow: GoogleOAuthFlow;
    private blobCache: Map<string, { blobUrl: string; mimeType: string; arrayBuffer?: ArrayBuffer }> = new Map();
    private inflightDownloads: Map<string, Promise<{ blobUrl: string; mimeType: string; arrayBuffer?: ArrayBuffer } | null>> = new Map();

    constructor(config: GoogleDriveConfig) {
        this.config = config;
        this.oauthFlow = new GoogleOAuthFlow({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectPort: this.REDIRECT_PORT
        });
    }

    /**
     * Start OAuth flow to connect Google Drive
     */
    async connectGoogleDrive(): Promise<OAuthTokens> {
        return this.oauthFlow.startOAuthFlow();
    }

    /**
     * Check if connected to Google Drive
     */
    isConnected(): boolean {
        return !!(this.config.accessToken && this.config.refreshToken);
    }

    /**
     * Get cached local Blob URL if available
     */
    getCachedBlobUrl(fileId: string): { blobUrl: string; mimeType: string; arrayBuffer?: ArrayBuffer } | undefined {
        return this.blobCache.get(fileId);
    }

    /**
     * Revoke and remove a single cached Blob URL
     */
    revokeBlobUrl(fileId: string): void {
        const entry = this.blobCache.get(fileId);
        if (entry) {
            URL.revokeObjectURL(entry.blobUrl);
            this.blobCache.delete(fileId);
        }
        this.inflightDownloads.delete(fileId);
    }

    /**
     * Download a private file from Google Drive via authenticated API and return a local Blob URL
     */
    async downloadFileAsBlobUrl(fileId: string): Promise<{ blobUrl: string; mimeType: string; arrayBuffer?: ArrayBuffer } | null> {
        if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
            return null;
        }
        const cached = this.blobCache.get(fileId);
        if (cached) {
            return cached;
        }

        const inflight = this.inflightDownloads.get(fileId);
        if (inflight) {
            return inflight;
        }

        const downloadPromise = (async () => {
            try {
                const accessToken = await this.ensureValidToken();
                const response = await requestUrl({
                    url: `${this.API_URL}/files/${encodeURIComponent(fileId)}?alt=media`,
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    }
                });

                if (response.status !== 200) {
                    return null;
                }

                const rawType = response.headers['content-type'] || response.headers['Content-Type'] || 'application/octet-stream';
                let mimeType = rawType.split(';')[0].trim().toLowerCase();

                // Inspect magic bytes (%PDF-) so PDFs are reliably detected even if Content-Type is octet-stream
                if (response.arrayBuffer && response.arrayBuffer.byteLength >= 5) {
                    const magic = new Uint8Array(response.arrayBuffer, 0, 5);
                    if (
                        magic[0] === 0x25 && // %
                        magic[1] === 0x50 && // P
                        magic[2] === 0x44 && // D
                        magic[3] === 0x46 && // F
                        magic[4] === 0x2d    // -
                    ) {
                        mimeType = 'application/pdf';
                    }
                }

                const blob = new Blob([response.arrayBuffer], { type: mimeType });
                const blobUrl = URL.createObjectURL(blob);
                const entry: { blobUrl: string; mimeType: string; arrayBuffer?: ArrayBuffer } = {
                    blobUrl,
                    mimeType,
                    arrayBuffer: mimeType === 'application/pdf' ? response.arrayBuffer : undefined
                };
                this.blobCache.set(fileId, entry);
                return entry;
            } catch (error) {
                console.error(`Failed to load private Drive file (${fileId}):`, error);
                return null;
            } finally {
                this.inflightDownloads.delete(fileId);
            }
        })();

        this.inflightDownloads.set(fileId, downloadPromise);
        return downloadPromise;
    }

    /**
     * Revoke all cached Blob URLs
     */
    revokeAllBlobUrls(): void {
        for (const entry of this.blobCache.values()) {
            URL.revokeObjectURL(entry.blobUrl);
        }
        this.blobCache.clear();
        this.inflightDownloads.clear();
    }

    /**
     * Ensure we have a valid access token, refreshing if necessary
     */
    private async ensureValidToken(): Promise<string> {
        if (this.config.tokenExpiresAt && this.config.refreshToken) {
            if (this.oauthFlow.isTokenExpired(this.config.tokenExpiresAt)) {
                console.debug('Access token expired, refreshing...');
                try {
                    const newTokens = await this.oauthFlow.refreshAccessToken(this.config.refreshToken);

                    this.config.accessToken = newTokens.accessToken;
                    this.config.tokenExpiresAt = newTokens.expiresAt;

                    if (this.config.onTokenRefresh) {
                        await this.config.onTokenRefresh(newTokens);
                    }

                    new Notice('Google Drive token automatically refreshed');
                } catch (error) {
                    console.error('Token refresh failed:', error);
                    throw new Error('Token refresh failed. Please reconnect Google Drive.');
                }
            }
        }

        if (!this.config.accessToken) {
            throw new Error('Not connected to Google Drive. Please connect first.');
        }

        return this.config.accessToken;
    }

    /**
     * Upload a file to Google Drive with progress callback
     */
    async uploadFile(
        file: File,
        folderPath: string,
        onProgress?: (progress: UploadProgress) => void
    ): Promise<DriveUploadResult | null> {
        try {
            // Stage 1: Preparing
            onProgress?.({
                stage: 'preparing',
                message: 'Preparing upload...',
                progress: 10
            });

            const accessToken = await this.ensureValidToken();

            // Find or create folder
            const folderId = await this.ensureFolder(folderPath);

            // Read file as ArrayBuffer
            const arrayBuffer = await file.arrayBuffer();
            const base64Content = this.arrayBufferToBase64(arrayBuffer);

            // Stage 2: Uploading
            onProgress?.({
                stage: 'uploading',
                message: 'Uploading to Google Drive...',
                progress: 30
            });

            // Create file metadata
            const metadata = {
                name: file.name,
                mimeType: file.type,
                parents: [folderId]
            };

            // Upload using multipart
            const boundary = '-------314159265358979323846';
            const delimiter = `\r\n--${boundary}\r\n`;
            const closeDelimiter = `\r\n--${boundary}--`;

            const multipartBody =
                delimiter +
                'Content-Type: application/json\r\n\r\n' +
                JSON.stringify(metadata) +
                delimiter +
                `Content-Type: ${file.type}\r\n` +
                'Content-Transfer-Encoding: base64\r\n\r\n' +
                base64Content +
                closeDelimiter;

            const uploadResponse = await requestUrl({
                url: `${this.UPLOAD_URL}/files?uploadType=multipart&fields=id,webViewLink,webContentLink,name,mimeType`,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': `multipart/related; boundary=${boundary}`
                },
                body: multipartBody
            });

            if (uploadResponse.status !== 200) {
                throw new Error(`Upload failed: ${uploadResponse.status}`);
            }

            const fileData = uploadResponse.json;
            const fileId = fileData.id;

            // Pre-cache local Blob URL so private embed renders immediately without extra download
            try {
                const normalizedMime = (file.type || 'application/octet-stream').toLowerCase();
                const localBlob = new Blob([arrayBuffer], { type: normalizedMime });
                this.blobCache.set(fileId, {
                    blobUrl: URL.createObjectURL(localBlob),
                    mimeType: normalizedMime,
                    arrayBuffer: normalizedMime === 'application/pdf' ? arrayBuffer : undefined
                });
            } catch (cacheErr) {
                console.debug('Could not pre-cache blob URL:', cacheErr);
            }

            // Get updated file info (file remains private to the owner's Google account)
            const fileInfo = await this.getFileInfo(fileId);

            // Stage 3: Complete
            onProgress?.({
                stage: 'complete',
                message: 'Upload complete!',
                progress: 100
            });

            return {
                fileId: fileId,
                webViewLink: fileInfo.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
                webContentLink: fileInfo.webContentLink || `https://drive.google.com/uc?export=view&id=${fileId}`,
                fileName: file.name,
                mimeType: file.type
            };

        } catch (error) {
            console.error('Error uploading to Google Drive:', error);
            const message = error instanceof Error ? error.message : String(error);
            onProgress?.({
                stage: 'error',
                message: 'Upload failed',
                progress: 0,
                error: message
            });
            return null;
        }
    }

    /**
     * List all non-trashed files uploaded by this plugin inside the configured Drive folder
     */
    async listUploadedFiles(folderPath?: string): Promise<DriveFileMetadata[]> {
        try {
            const accessToken = await this.ensureValidToken();
            const targetFolder = (folderPath ?? this.config.driveFolder ?? 'Obsidian/DriveEmbedder').trim();
            const folderId = await this.resolveFolderId(targetFolder);
            if (!folderId) {
                return [];
            }

            const safeFolderId = folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const query = `'${safeFolderId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`;
            const fields = 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,trashed)';
            const results: DriveFileMetadata[] = [];
            let pageToken = '';

            do {
                const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
                const response = await requestUrl({
                    url: `${this.API_URL}/files?q=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&orderBy=${encodeURIComponent('createdTime desc')}&pageSize=100${tokenParam}`,
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`
                    }
                });

                if (response.status !== 200) {
                    break;
                }

                const data = response.json;
                if (Array.isArray(data.files)) {
                    for (const f of data.files) {
                        results.push({
                            id: String(f.id),
                            name: String(f.name || f.id),
                            mimeType: String(f.mimeType || 'application/octet-stream'),
                            size: f.size !== undefined ? Number(f.size) : undefined,
                            createdTime: f.createdTime,
                            modifiedTime: f.modifiedTime,
                            webViewLink: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
                            trashed: Boolean(f.trashed)
                        });
                    }
                }
                pageToken = data.nextPageToken || '';
            } while (pageToken && results.length < 500);

            return results;
        } catch (error) {
            console.error('Error listing Google Drive files:', error);
            return [];
        }
    }

    /**
     * Get metadata for a single file on Google Drive
     */
    async getFileMetadata(fileId: string): Promise<DriveFileMetadata | null> {
        if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
            return null;
        }
        try {
            const accessToken = await this.ensureValidToken();
            const response = await requestUrl({
                url: `${this.API_URL}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,createdTime,modifiedTime,webViewLink,trashed&supportsAllDrives=true`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            if (response.status !== 200) {
                return null;
            }

            const f = response.json;
            return {
                id: String(f.id),
                name: String(f.name || f.id),
                mimeType: String(f.mimeType || 'application/octet-stream'),
                size: f.size !== undefined ? Number(f.size) : undefined,
                createdTime: f.createdTime,
                modifiedTime: f.modifiedTime,
                webViewLink: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
                trashed: Boolean(f.trashed)
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * Move a file to the Google Drive trash (trashed = true)
     */
    async trashFile(fileId: string): Promise<boolean> {
        if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
            return false;
        }
        try {
            const accessToken = await this.ensureValidToken();
            const response = await requestUrl({
                url: `${this.API_URL}/files/${encodeURIComponent(fileId)}`,
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ trashed: true })
            });

            if (response.status >= 200 && response.status < 300) {
                this.revokeBlobUrl(fileId);
                return true;
            }
            return false;
        } catch (error) {
            console.error(`Failed to move Drive file (${fileId}) to trash:`, error);
            return false;
        }
    }

    /**
     * Get file info from Google Drive
     */
    private async getFileInfo(fileId: string): Promise<{ webViewLink?: string; webContentLink?: string }> {
        try {
            const accessToken = await this.ensureValidToken();

            const response = await requestUrl({
                url: `${this.API_URL}/files/${encodeURIComponent(fileId)}?fields=webViewLink,webContentLink`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            return response.json as { webViewLink?: string; webContentLink?: string };
        } catch (error) {
            return {};
        }
    }

    /**
     * Resolve an existing folder path on Google Drive without creating missing folders
     */
    private async resolveFolderId(folderPath: string): Promise<string | null> {
        const parts = folderPath.split('/').map(p => p.trim()).filter(p => p.length > 0);
        let parentId = 'root';

        for (const folderName of parts) {
            const existingId = await this.findFolder(folderName, parentId);
            if (!existingId) {
                return null;
            }
            parentId = existingId;
        }

        return parentId;
    }

    /**
     * Ensure folder exists, creating if necessary
     */
    private async ensureFolder(folderPath: string): Promise<string> {
        const parts = folderPath.split('/').map(p => p.trim()).filter(p => p.length > 0);
        let parentId = 'root';

        for (const folderName of parts) {
            const existingId = await this.findFolder(folderName, parentId);

            if (existingId) {
                parentId = existingId;
            } else {
                parentId = await this.createFolder(folderName, parentId);
            }
        }

        return parentId;
    }

    /**
     * Find a folder by name
     */
    private async findFolder(name: string, parentId: string): Promise<string | null> {
        try {
            const accessToken = await this.ensureValidToken();
            const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const safeParentId = parentId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const query = `name='${safeName}' and '${safeParentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;

            const response = await requestUrl({
                url: `${this.API_URL}/files?q=${encodeURIComponent(query)}&fields=files(id)`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            if (response.status === 200) {
                const data = response.json;
                if (data.files && data.files.length > 0) {
                    return data.files[0].id;
                }
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Create a new folder
     */
    private async createFolder(name: string, parentId: string): Promise<string> {
        const accessToken = await this.ensureValidToken();

        const metadata = {
            name: name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId]
        };

        const response = await requestUrl({
            url: `${this.API_URL}/files`,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(metadata)
        });

        if (response.status !== 200) {
            throw new Error(`Folder creation failed: ${response.status}`);
        }

        return response.json.id;
    }

    /**
     * Test the connection
     */
    async testConnection(): Promise<boolean> {
        try {
            const accessToken = await this.ensureValidToken();

            const response = await requestUrl({
                url: `${this.API_URL}/about?fields=user`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            return response.status === 200;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get user info
     */
    async getUserInfo(): Promise<{ email: string; name: string } | null> {
        try {
            const accessToken = await this.ensureValidToken();

            const response = await requestUrl({
                url: `${this.API_URL}/about?fields=user`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            if (response.status === 200) {
                const data = response.json;
                return {
                    email: data.user.emailAddress,
                    name: data.user.displayName
                };
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Disconnect from Google Drive
     */
    disconnect(): void {
        this.config.accessToken = '';
        this.config.refreshToken = '';
        this.config.tokenExpiresAt = 0;
    }

    /**
     * Convert ArrayBuffer to base64
     */
    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }
}
