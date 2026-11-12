/**
 * Google Drive Uploader with Progress Tracking
 * Handles file upload, permission setting, and token management
 */
import { requestUrl, Notice } from 'obsidian';
import { GoogleOAuthFlow, GoogleAuthError, isAuthExpiredError } from './google-oauth-flow';
import { OAuthTokens, DriveUploadResult, UploadProgress, DriveFileMetadata } from './types';
import { getFileTypeInfo } from './size-presets';

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
    private readonly SINGLE_PUT_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB
    private readonly RESUMABLE_CHUNK_BYTES = 8 * 1024 * 1024; // 8 MiB (multiple of 256 KiB)
    private readonly MAX_PRECACHE_BYTES = 50 * 1024 * 1024;   // 50 MiB

    private config: GoogleDriveConfig;
    private oauthFlow: GoogleOAuthFlow;
    private blobCache: Map<string, { blobUrl: string; mimeType: string; arrayBuffer?: ArrayBuffer }> = new Map();
    private inflightDownloads: Map<string, Promise<{ blobUrl: string; mimeType: string; arrayBuffer?: ArrayBuffer } | null>> = new Map();
    private inflightTokenRefresh: Promise<string> | null = null;
    private authExpired = false;
    private hasShownAuthExpiredNotice = false;

    constructor(config: GoogleDriveConfig) {
        this.config = config;
        this.oauthFlow = new GoogleOAuthFlow({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectPort: this.REDIRECT_PORT
        });
    }

    /**
     * Whether the Google OAuth refresh token is known to be expired or revoked
     */
    isAuthExpired(): boolean {
        return this.authExpired;
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
     * Read a response header case-insensitively across Desktop (Electron) and Mobile WebViews
     */
    private getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
        if (!headers) {
            return undefined;
        }
        const target = name.toLowerCase();
        for (const [key, value] of Object.entries(headers)) {
            if (key.toLowerCase() === target) {
                return value;
            }
        }
        return undefined;
    }

    /**
     * Extract a readable Google Drive API error message from a failed HTTP response
     */
    private parseGoogleApiError(status: number, responseText?: string): string {
        if (responseText) {
            try {
                const parsed = JSON.parse(responseText) as {
                    error?: { message?: string } | string;
                    error_description?: string;
                };
                const detail =
                    (typeof parsed.error === 'object' && parsed.error?.message) ||
                    parsed.error_description ||
                    (typeof parsed.error === 'string' ? parsed.error : '');
                if (detail && detail.trim()) {
                    return `Google Drive API error (${status}): ${detail.trim()}`;
                }
            } catch {
                // Ignore non-JSON error body
            }
        }
        return `Google Drive API error (HTTP ${status})`;
    }

    /**
     * Ensure we have a valid access token, refreshing if necessary (with concurrent deduplication)
     */
    private async ensureValidToken(forceRefresh = false): Promise<string> {
        const needsRefresh =
            forceRefresh ||
            (!this.config.accessToken && !!this.config.refreshToken) ||
            (!!this.config.tokenExpiresAt && this.oauthFlow.isTokenExpired(this.config.tokenExpiresAt));

        if (needsRefresh) {
            if (!this.config.refreshToken) {
                this.authExpired = true;
                throw new GoogleAuthError(
                    'Not connected to Google Drive (missing refresh token). Please reconnect in settings.',
                    'AUTH_EXPIRED'
                );
            }

            if (this.inflightTokenRefresh) {
                return this.inflightTokenRefresh;
            }

            this.inflightTokenRefresh = (async () => {
                console.debug('Access token expired or refresh requested, refreshing...');
                try {
                    const newTokens = await this.oauthFlow.refreshAccessToken(this.config.refreshToken);

                    this.config.accessToken = newTokens.accessToken;
                    this.config.refreshToken = newTokens.refreshToken;
                    this.config.tokenExpiresAt = newTokens.expiresAt;
                    this.authExpired = false;
                    this.hasShownAuthExpiredNotice = false;

                    if (this.config.onTokenRefresh) {
                        await this.config.onTokenRefresh(newTokens);
                    }

                    return this.config.accessToken;
                } catch (error) {
                    console.error('Token refresh failed:', error);
                    if (isAuthExpiredError(error)) {
                        this.authExpired = true;
                        if (!this.hasShownAuthExpiredNotice) {
                            this.hasShownAuthExpiredNotice = true;
                            new Notice(
                                '⚠️ Google Drive session expired. Please click "Reconnect" in Drive Embedder.',
                                8000
                            );
                        }
                        throw error;
                    }
                    const detail = error instanceof Error ? error.message : String(error);
                    throw new Error(`Token refresh failed (${detail}). Please check your connection or reconnect Google Drive.`);
                } finally {
                    this.inflightTokenRefresh = null;
                }
            })();

            return this.inflightTokenRefresh;
        }

        if (!this.config.accessToken) {
            throw new GoogleAuthError(
                'Not connected to Google Drive. Please connect first.',
                'AUTH_EXPIRED'
            );
        }

        return this.config.accessToken;
    }

    /**
     * Upload a file to Google Drive via binary resumable upload (no 5 MB multipart limit or Base64 overhead)
     */
    async uploadFile(
        file: File,
        folderPath: string,
        onProgress?: (progress: UploadProgress) => void
    ): Promise<DriveUploadResult> {
        try {
            // Stage 1: Preparing & validating token
            onProgress?.({
                stage: 'preparing',
                message: 'Preparing upload...',
                progress: 10
            });

            let accessToken = await this.ensureValidToken();

            // Resolve a valid MIME type (fallback if OS/mobile picker omits file.type)
            const resolvedMimeType = (
                file.type ||
                getFileTypeInfo(file.name)?.mimeType ||
                'application/octet-stream'
            ).split(';')[0].trim() || 'application/octet-stream';

            // Find or create destination folder
            const folderId = await this.ensureFolder(folderPath);

            // Stage 2: Initiate Google Drive Resumable Upload session
            onProgress?.({
                stage: 'uploading',
                message: 'Initializing upload session...',
                progress: 20
            });

            const totalBytes = file.size;
            const metadata = {
                name: file.name,
                mimeType: resolvedMimeType,
                parents: [folderId]
            };

            const initiateSession = (token: string) =>
                requestUrl({
                    url: `${this.UPLOAD_URL}/files?uploadType=resumable&fields=id,webViewLink,webContentLink,name,mimeType`,
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json; charset=UTF-8',
                        'X-Upload-Content-Type': resolvedMimeType,
                        'X-Upload-Content-Length': String(totalBytes)
                    },
                    body: JSON.stringify(metadata),
                    throw: false
                });

            let initResponse = await initiateSession(accessToken);
            if (initResponse.status === 401 && this.config.refreshToken) {
                accessToken = await this.ensureValidToken(true);
                initResponse = await initiateSession(accessToken);
            }

            if (initResponse.status !== 200) {
                throw new Error(this.parseGoogleApiError(initResponse.status, initResponse.text));
            }

            const sessionUri = this.getHeader(initResponse.headers, 'location');
            if (!sessionUri) {
                throw new Error('Google Drive did not return a resumable upload session URL.');
            }

            // Stage 3: Send binary file bytes (single PUT up to 16 MiB, 8 MiB chunked PUTs for larger files)
            let fileData: {
                id?: string;
                webViewLink?: string;
                webContentLink?: string;
                name?: string;
                mimeType?: string;
            } | null = null;
            let fullBufferForCache: ArrayBuffer | undefined;

            if (totalBytes <= this.SINGLE_PUT_MAX_BYTES) {
                const arrayBuffer = await file.arrayBuffer();
                onProgress?.({
                    stage: 'uploading',
                    message: 'Uploading to Google Drive...',
                    progress: 45
                });

                const uploadResponse = await requestUrl({
                    url: sessionUri,
                    method: 'PUT',
                    contentType: resolvedMimeType,
                    body: arrayBuffer,
                    throw: false
                });

                if (uploadResponse.status !== 200 && uploadResponse.status !== 201) {
                    throw new Error(this.parseGoogleApiError(uploadResponse.status, uploadResponse.text));
                }

                fileData = JSON.parse(uploadResponse.text);
                fullBufferForCache = arrayBuffer;
            } else {
                let offset = 0;
                while (offset < totalBytes) {
                    const end = Math.min(offset + this.RESUMABLE_CHUNK_BYTES, totalBytes);
                    const chunkBuffer = await file.slice(offset, end).arrayBuffer();
                    const pct = Math.round((offset / totalBytes) * 100);

                    onProgress?.({
                        stage: 'uploading',
                        message: `Uploading to Google Drive (${pct}%)...`,
                        progress: 25 + Math.round((offset / totalBytes) * 65)
                    });

                    const chunkResponse = await requestUrl({
                        url: sessionUri,
                        method: 'PUT',
                        contentType: resolvedMimeType,
                        headers: {
                            'Content-Range': `bytes ${offset}-${end - 1}/${totalBytes}`
                        },
                        body: chunkBuffer,
                        throw: false
                    });

                    if (end < totalBytes) {
                        if (
                            chunkResponse.status !== 308 &&
                            chunkResponse.status !== 200 &&
                            chunkResponse.status !== 201
                        ) {
                            throw new Error(this.parseGoogleApiError(chunkResponse.status, chunkResponse.text));
                        }
                        if (chunkResponse.status === 200 || chunkResponse.status === 201) {
                            fileData = JSON.parse(chunkResponse.text);
                            break;
                        }
                        const rangeHeader = this.getHeader(chunkResponse.headers, 'range');
                        const rangeMatch = rangeHeader ? rangeHeader.match(/bytes=0-(\d+)/i) : null;
                        offset = rangeMatch && rangeMatch[1] ? parseInt(rangeMatch[1], 10) + 1 : end;
                    } else {
                        if (chunkResponse.status !== 200 && chunkResponse.status !== 201) {
                            throw new Error(this.parseGoogleApiError(chunkResponse.status, chunkResponse.text));
                        }
                        fileData = JSON.parse(chunkResponse.text);
                        offset = end;
                    }
                }
            }

            const fileId = fileData?.id;
            if (!fileId) {
                throw new Error('Google Drive upload completed without returning a file ID.');
            }

            // Pre-cache local Blob URL so private embed renders immediately without re-downloading
            if (totalBytes <= this.MAX_PRECACHE_BYTES) {
                try {
                    const normalizedMime = resolvedMimeType.toLowerCase();
                    const localBlob = fullBufferForCache
                        ? new Blob([fullBufferForCache], { type: normalizedMime })
                        : new Blob([file], { type: normalizedMime });
                    this.blobCache.set(fileId, {
                        blobUrl: URL.createObjectURL(localBlob),
                        mimeType: normalizedMime,
                        arrayBuffer: normalizedMime === 'application/pdf' ? fullBufferForCache : undefined
                    });
                } catch (cacheErr) {
                    console.debug('Could not pre-cache blob URL:', cacheErr);
                }
            }

            // Use links returned directly from upload response, falling back to getFileInfo only if omitted
            let webViewLink = fileData?.webViewLink;
            let webContentLink = fileData?.webContentLink;
            if (!webViewLink) {
                const fileInfo = await this.getFileInfo(fileId);
                webViewLink = fileInfo.webViewLink;
                webContentLink = webContentLink || fileInfo.webContentLink;
            }

            // Stage 4: Complete
            onProgress?.({
                stage: 'complete',
                message: 'Upload complete!',
                progress: 100
            });

            return {
                fileId: fileId,
                webViewLink: webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
                webContentLink: webContentLink || `https://drive.google.com/uc?export=view&id=${fileId}`,
                fileName: file.name,
                mimeType: resolvedMimeType
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
            throw error instanceof Error ? error : new Error(message);
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
        let accessToken = await this.ensureValidToken();
        const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const safeParentId = parentId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const query = `name='${safeName}' and '${safeParentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
        const url = `${this.API_URL}/files?q=${encodeURIComponent(query)}&fields=files(id)`;

        let response = await requestUrl({
            url,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            },
            throw: false
        });

        if (response.status === 401 && this.config.refreshToken) {
            accessToken = await this.ensureValidToken(true);
            response = await requestUrl({
                url,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                },
                throw: false
            });
        }

        if (response.status !== 200) {
            throw new Error(this.parseGoogleApiError(response.status, response.text));
        }

        const data = JSON.parse(response.text);
        if (data.files && data.files.length > 0) {
            return data.files[0].id;
        }
        return null;
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
            body: JSON.stringify(metadata),
            throw: false
        });

        if (response.status !== 200) {
            throw new Error(this.parseGoogleApiError(response.status, response.text));
        }

        return JSON.parse(response.text).id;
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
        this.authExpired = false;
        this.hasShownAuthExpiredNotice = false;
    }
}
