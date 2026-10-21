/**
 * Google OAuth Flow - Browser-based authentication
 * Handles token acquisition and refresh for Google Drive API
 */
import { Notice, requestUrl } from 'obsidian';
import type * as httpTypes from 'http';
import { OAuthTokens } from './types';

export interface OAuthConfig {
    clientId: string;
    clientSecret: string;
    redirectPort: number;
}

export class GoogleOAuthFlow {
    private readonly AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
    private readonly TOKEN_URL = 'https://oauth2.googleapis.com/token';
    private readonly SCOPES = [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/userinfo.email'
    ];

    private config: OAuthConfig;
    private server: httpTypes.Server | null = null;

    constructor(config: OAuthConfig) {
        this.config = config;
    }

    /**
     * Cancel any running OAuth callback server
     */
    cancel(): void {
        this.cleanup();
    }

    /**
     * Start the OAuth flow - opens browser and waits for callback
     */
    async startOAuthFlow(): Promise<OAuthTokens> {
        // Ensure any previous server is closed first
        this.cleanup();

        let shell: typeof import('electron').shell;
        let http: typeof import('http');
        let url: typeof import('url');
        try {
            // Lazy-load desktop modules so the plugin can load on Android/mobile
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            shell = (require('electron') as typeof import('electron')).shell;
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            http = require('http') as typeof import('http');
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            url = require('url') as typeof import('url');
        } catch (e) {
            throw new Error('Initial OAuth login must be done on Desktop (macOS/Windows/Linux). Once connected, synced tokens work on Android too.');
        }

        // Generate PKCE code verifier and challenge for security
        const codeVerifier = this.generateCodeVerifier();
        const codeChallenge = await this.generateCodeChallenge(codeVerifier);

        // Start local server to receive callback
        const redirectUri = `http://localhost:${this.config.redirectPort}/callback`;

        return new Promise((resolve, reject) => {
            let settled = false;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;

            const finishCleanup = (srv: httpTypes.Server | null) => {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
                this.cleanupServer(srv);
            };

            try {
                const server = http.createServer(async (req, res) => {
                    try {
                        const parsedUrl = url.parse(req.url || '', true);

                        if (parsedUrl.pathname !== '/callback') {
                            res.writeHead(404, {
                                'Content-Type': 'text/plain; charset=utf-8',
                                'Connection': 'close'
                            });
                            res.end('Not found');
                            return;
                        }

                        const code = parsedUrl.query.code as string;
                        const error = parsedUrl.query.error as string;

                        if (error) {
                            res.writeHead(200, {
                                'Content-Type': 'text/html; charset=utf-8',
                                'Connection': 'close'
                            });
                            res.end(this.getErrorHtml(error));
                            finishCleanup(server);
                            if (!settled) {
                                settled = true;
                                reject(new Error(`OAuth error: ${error}`));
                            }
                            return;
                        }

                        if (code) {
                            try {
                                // Exchange code for tokens
                                const tokens = await this.exchangeCodeForTokens(code, codeVerifier, redirectUri);

                                res.writeHead(200, {
                                    'Content-Type': 'text/html; charset=utf-8',
                                    'Connection': 'close'
                                });
                                res.end(this.getSuccessHtml());
                                finishCleanup(server);
                                if (!settled) {
                                    settled = true;
                                    resolve(tokens);
                                }
                            } catch (tokenError) {
                                const errorMessage = tokenError instanceof Error ? tokenError.message : String(tokenError);
                                res.writeHead(200, {
                                    'Content-Type': 'text/html; charset=utf-8',
                                    'Connection': 'close'
                                });
                                res.end(this.getErrorHtml(errorMessage));
                                finishCleanup(server);
                                if (!settled) {
                                    settled = true;
                                    reject(tokenError instanceof Error ? tokenError : new Error(errorMessage));
                                }
                            }
                        }
                    } catch (err) {
                        finishCleanup(server);
                        if (!settled) {
                            settled = true;
                            reject(err instanceof Error ? err : new Error(String(err)));
                        }
                    }
                });

                this.server = server;

                // Handle server errors before or during listen
                server.on('error', (err: NodeJS.ErrnoException) => {
                    finishCleanup(server);
                    if (!settled) {
                        settled = true;
                        if (err.code === 'EADDRINUSE') {
                            reject(new Error(`Port ${this.config.redirectPort} is already in use. Please reload Obsidian (Cmd+R) and try again.`));
                        } else {
                            reject(err instanceof Error ? err : new Error(String(err)));
                        }
                    }
                });

                // Only open the browser AFTER the server is actually listening
                server.listen(this.config.redirectPort, '127.0.0.1', () => {
                    console.debug(`OAuth callback server listening on 127.0.0.1:${this.config.redirectPort}`);

                    const authUrl = this.buildAuthUrl(redirectUri, codeChallenge);
                    new Notice('please log in with Google in your browser...', 3000);
                    void shell.openExternal(authUrl);
                });

                // Set timeout (2 minutes)
                timeoutId = setTimeout(() => {
                    finishCleanup(server);
                    if (!settled) {
                        settled = true;
                        reject(new Error('OAuth flow timed out. Please try again.'));
                    }
                }, 120000);

            } catch (error) {
                finishCleanup(this.server);
                if (!settled) {
                    settled = true;
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            }
        });
    }

    /**
     * Refresh access token using refresh token
     */
    async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
        try {
            const response = await requestUrl({
                url: this.TOKEN_URL,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    client_id: this.config.clientId,
                    client_secret: this.config.clientSecret,
                    refresh_token: refreshToken,
                    grant_type: 'refresh_token'
                }).toString()
            });

            if (response.status !== 200) {
                throw new Error(`Token refresh failed: ${response.status}`);
            }

            const data = response.json;
            const expiresAt = Date.now() + (data.expires_in * 1000);

            return {
                accessToken: data.access_token,
                refreshToken: refreshToken, // Refresh token doesn't change
                expiresIn: data.expires_in,
                expiresAt: expiresAt
            };
        } catch (error) {
            console.error('Token refresh error:', error);
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to refresh token: ${message}`);
        }
    }

    /**
     * Check if token is expired or about to expire (within 5 minutes)
     */
    isTokenExpired(expiresAt: number): boolean {
        const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
        return Date.now() >= (expiresAt - bufferTime);
    }

    /**
     * Exchange authorization code for tokens
     */
    private async exchangeCodeForTokens(
        code: string,
        codeVerifier: string,
        redirectUri: string
    ): Promise<OAuthTokens> {
        const response = await requestUrl({
            url: this.TOKEN_URL,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                code: code,
                client_id: this.config.clientId,
                client_secret: this.config.clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
                code_verifier: codeVerifier
            }).toString()
        });

        if (response.status !== 200) {
            throw new Error(`Token exchange failed: ${response.status}`);
        }

        const data = response.json;
        const expiresAt = Date.now() + (data.expires_in * 1000);

        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresIn: data.expires_in,
            expiresAt: expiresAt
        };
    }

    /**
     * Build OAuth authorization URL
     */
    private buildAuthUrl(redirectUri: string, codeChallenge: string): string {
        const params = new URLSearchParams({
            client_id: this.config.clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: this.SCOPES.join(' '),
            access_type: 'offline',
            prompt: 'consent',
            code_challenge: codeChallenge,
            code_challenge_method: 'S256'
        });

        return `${this.AUTH_URL}?${params.toString()}`;
    }

    /**
     * Generate random code verifier for PKCE
     */
    private generateCodeVerifier(): string {
        const array = new Uint8Array(32);
        crypto.getRandomValues(array);
        return this.base64UrlEncode(array);
    }

    /**
     * Generate code challenge from verifier
     */
    private async generateCodeChallenge(verifier: string): Promise<string> {
        const encoder = new TextEncoder();
        const data = encoder.encode(verifier);
        const hash = await crypto.subtle.digest('SHA-256', data);
        return this.base64UrlEncode(new Uint8Array(hash));
    }

    /**
     * Base64 URL encode
     */
    private base64UrlEncode(buffer: Uint8Array): string {
        let binary = '';
        for (let i = 0; i < buffer.length; i++) {
            binary += String.fromCharCode(buffer[i]);
        }
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');
    }

    /**
     * Cleanup a specific server instance
     */
    private cleanupServer(srv: (httpTypes.Server & { closeAllConnections?: () => void }) | null): void {
        if (!srv) return;
        try {
            if (typeof srv.closeAllConnections === 'function') {
                srv.closeAllConnections();
            }
            srv.close();
        } catch {
            // Ignore errors during close
        }
        if (this.server === srv) {
            this.server = null;
        }
    }

    /**
     * Cleanup current server
     */
    private cleanup(): void {
        this.cleanupServer(this.server);
    }

    private escapeHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Success HTML page
     */
    private getSuccessHtml(): string {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Google Drive connection complete</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #4285f4 0%, #34a853 100%);
        }
        .container {
            background: white;
            padding: 40px 60px;
            border-radius: 16px;
            text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }
        .success-icon {
            font-size: 64px;
            margin-bottom: 20px;
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
        }
        p {
            color: #666;
            margin-bottom: 20px;
        }
        .close-hint {
            font-size: 14px;
            color: #999;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="success-icon">✅</div>
        <h1>Connection complete!</h1>
        <p>Google Drive has been connected to Drive Embedder.</p>
        <p class="close-hint">You can close this window and return to Obsidian.</p>
    </div>
</body>
</html>
        `;
    }

    /**
     * Error HTML page
     */
    private getErrorHtml(error: string): string {
        const safeError = this.escapeHtml(error);
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Connection failed</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #ea4335 0%, #fbbc05 100%);
        }
        .container {
            background: white;
            padding: 40px 60px;
            border-radius: 16px;
            text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
        }
        .error-icon {
            font-size: 64px;
            margin-bottom: 20px;
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
        }
        p {
            color: #666;
            margin-bottom: 20px;
        }
        .error-detail {
            background: #fff3f3;
            border: 1px solid #ffcccc;
            padding: 10px 20px;
            border-radius: 8px;
            color: #cc0000;
            font-family: monospace;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-icon">❌</div>
        <h1>Connection failed</h1>
        <p>Failed to connect to Google Drive.</p>
        <div class="error-detail">${safeError}</div>
        <p>Please try again in Obsidian.</p>
    </div>
</body>
</html>
        `;
    }
}
