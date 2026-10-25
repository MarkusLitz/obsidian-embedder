/**
 * Drive Embedder - Google Smart Chips
 * Converts pasted Google Drive / Docs / Sheets / Slides / Forms URLs into
 * named Markdown links and renders them as Google Docs-style Smart Chips
 * in both Reading View and CodeMirror 6 Live Preview.
 */

import { App, Editor, MarkdownView, Notice, requestUrl } from 'obsidian';
import {
    Decoration,
    DecorationSet,
    EditorView,
    ViewPlugin,
    ViewUpdate
} from '@codemirror/view';
import { Extension, RangeSetBuilder } from '@codemirror/state';
import { GoogleDriveUploader } from './uploader';
import { scanVaultForEmbeds } from './embed-scanner';

export type GoogleChipType =
    | 'docs'
    | 'sheets'
    | 'slides'
    | 'forms'
    | 'drawings'
    | 'folder'
    | 'pdf'
    | 'drive';

export interface ParsedGoogleSmartLink {
    url: string;
    fileId: string | null;
    chipType: GoogleChipType;
    defaultLabel: string;
    hasLeadingEmoji: boolean;
}

const LEADING_ICON_EMOJI_REGEX = /^(?:📁|📄|📊|📽️|📝|🎨|📎|⏳)\s*/u;

/**
 * Classify a Google Drive / Docs / Sheets / Slides / Forms URL
 */
export function parseGoogleSmartLink(
    rawUrl: string,
    linkTitle?: string
): ParsedGoogleSmartLink | null {
    if (!rawUrl) {
        return null;
    }
    const trimmed = rawUrl.trim();
    if (!/^https?:\/\/(?:docs\.google\.com|drive\.google\.com|forms\.gle)\//i.test(trimmed)) {
        return null;
    }

    let chipType: GoogleChipType = 'drive';
    let defaultLabel = 'Google Drive';

    const lowerUrl = trimmed.toLowerCase();
    if (lowerUrl.includes('docs.google.com/document/')) {
        chipType = 'docs';
        defaultLabel = 'Google Doc';
    } else if (lowerUrl.includes('docs.google.com/spreadsheets/')) {
        chipType = 'sheets';
        defaultLabel = 'Google Sheet';
    } else if (lowerUrl.includes('docs.google.com/presentation/')) {
        chipType = 'slides';
        defaultLabel = 'Google Slides';
    } else if (lowerUrl.includes('docs.google.com/forms/') || lowerUrl.includes('forms.gle/')) {
        chipType = 'forms';
        defaultLabel = 'Google Form';
    } else if (lowerUrl.includes('docs.google.com/drawings/')) {
        chipType = 'drawings';
        defaultLabel = 'Google Drawing';
    } else if (lowerUrl.includes('drive.google.com') && lowerUrl.includes('/folders/')) {
        chipType = 'folder';
        defaultLabel = 'Drive Ordner';
    } else if (linkTitle && /\.pdf$/i.test(linkTitle.trim())) {
        chipType = 'pdf';
        defaultLabel = 'Drive PDF';
    }

    const fileId = extractGoogleResourceId(trimmed);
    const hasLeadingEmoji = linkTitle ? LEADING_ICON_EMOJI_REGEX.test(linkTitle.trim()) : false;

    return {
        url: trimmed,
        fileId,
        chipType,
        defaultLabel,
        hasLeadingEmoji
    };
}

/**
 * Extract the Drive file or folder ID from a Google Drive / Docs URL
 */
export function extractGoogleResourceId(rawUrl: string): string | null {
    const docOrFileMatch = rawUrl.match(
        /\/(?:document|spreadsheets|presentation|drawings|file)\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{10,})/i
    );
    if (docOrFileMatch && docOrFileMatch[1]) {
        return docOrFileMatch[1];
    }

    const formEditMatch = rawUrl.match(
        /\/forms\/(?:u\/\d+\/)?d\/(?!e\/)([a-zA-Z0-9_-]{10,})/i
    );
    if (formEditMatch && formEditMatch[1]) {
        return formEditMatch[1];
    }

    const folderMatch = rawUrl.match(
        /\/folders\/([a-zA-Z0-9_-]{10,})/i
    );
    if (folderMatch && folderMatch[1]) {
        return folderMatch[1];
    }

    const queryIdMatch = rawUrl.match(/[?&]id=([a-zA-Z0-9_-]{10,})/i);
    if (queryIdMatch && queryIdMatch[1]) {
        return queryIdMatch[1];
    }

    return null;
}

/**
 * Sanitize a resolved title so it is safe inside Markdown [title](url)
 */
export function sanitizeMarkdownLinkTitle(rawTitle: string): string {
    return rawTitle
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\[/g, '(')
        .replace(/\]/g, ')')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Check if a candidate title is just a raw URL or generic Google sign-in/error page title
 */
function isInvalidOrGenericTitle(candidate: string): boolean {
    const t = candidate.trim();
    if (!t) {
        return true;
    }
    if (/^https?:\/\//i.test(t) || /^(?:docs|drive)\.google\.com/i.test(t)) {
        return true;
    }
    if (
        /^(?:google\s*(?:docs|drive|sheets|tabellen|slides|präsentationen|forms|formulare|drawings|zeichnungen|accounts|konten)?|sign\s*in|anmelden|error|fehler|page\s+not\s+found|seite\s+nicht\s+gefunden|zugriff\s+verweigert|access\s+denied)$/i.test(
            t
        )
    ) {
        return true;
    }
    if (/sign[- ]?in|anmelden\s*[-–—]\s*google|google\s+accounts|google-konten/i.test(t)) {
        return true;
    }
    return false;
}

/**
 * Strip "- Google Docs", "- Google Drive", etc. from page titles
 */
function cleanGooglePageTitle(rawTitle: string): string {
    return rawTitle
        .replace(
            /\s*[-–—]\s*Google\s+(?:Docs|Drive|Sheets|Tabellen|Slides|Präsentationen|Forms|Formulare|Drawings|Zeichnungen)\s*$/i,
            ''
        )
        .trim();
}

/**
 * Extract link text from clipboard HTML if the user copied a Smart Chip or rich link
 */
export function extractTitleFromClipboardHtml(clipboardHtml: string, targetUrl: string): string | null {
    if (!clipboardHtml || !clipboardHtml.includes('<a')) {
        return null;
    }
    try {
        const doc = new DOMParser().parseFromString(clipboardHtml, 'text/html');
        const anchors = Array.from(doc.querySelectorAll('a[href]'));
        for (const a of anchors) {
            const text = cleanGooglePageTitle(a.textContent || '');
            if (text && !isInvalidOrGenericTitle(text)) {
                return text;
            }
        }
    } catch {
        // Ignore clipboard HTML parse errors
    }
    return null;
}

/**
 * CodeMirror 6 Live Preview extension that decorates [Title](https://docs.google.com/...)
 * and [Title](https://drive.google.com/...) links as Google Smart Chips when the cursor
 * is not actively editing the link.
 */
export function createGoogleSmartChipEditorExtension(): Extension {
    return ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;

            constructor(view: EditorView) {
                this.decorations = this.buildDecorations(view);
            }

            update(update: ViewUpdate) {
                if (update.docChanged || update.viewportChanged || update.selectionSet) {
                    this.decorations = this.buildDecorations(update.view);
                }
            }

            buildDecorations(view: EditorView): DecorationSet {
                const builder = new RangeSetBuilder<Decoration>();
                const selections = view.state.selection.ranges;
                const linkRegex = /\[([^\[\]\r\n]+)\]\((https?:\/\/(?:docs\.google\.com|drive\.google\.com|forms\.gle)\/[^\s)]+)\)/g;

                for (const { from, to } of view.visibleRanges) {
                    const text = view.state.doc.sliceString(from, to);
                    linkRegex.lastIndex = 0;
                    let match: RegExpExecArray | null;

                    while ((match = linkRegex.exec(text)) !== null) {
                        const fullStart = from + match.index;
                        const fullEnd = fullStart + match[0].length;
                        const titleText = match[1];
                        const url = match[2];

                        // Unfold normally when cursor or selection is inside the Markdown link
                        const cursorInside = selections.some(
                            (sel) => sel.from <= fullEnd && sel.to >= fullStart
                        );
                        if (cursorInside) {
                            continue;
                        }

                        const parsed = parseGoogleSmartLink(url, titleText);
                        if (!parsed) {
                            continue;
                        }

                        const titleStart = fullStart + 1;
                        const titleEnd = titleStart + titleText.length;
                        if (titleStart >= titleEnd) {
                            continue;
                        }

                        const classes = [
                            'google-smart-chip',
                            'google-smart-chip-cm',
                            `google-chip-${parsed.chipType}`
                        ];
                        if (parsed.hasLeadingEmoji) {
                            classes.push('google-chip-has-leading-emoji');
                        }

                        builder.add(
                            titleStart,
                            titleEnd,
                            Decoration.mark({
                                class: classes.join(' '),
                                attributes: {
                                    'data-google-chip': parsed.chipType
                                }
                            })
                        );
                    }
                }

                return builder.finish();
            }
        },
        {
            decorations: (v) => v.decorations
        }
    );
}

/**
 * Decorate external <a> links in Reading View / DOM containers with Smart Chip classes
 */
export function decorateGoogleSmartChipLinksInDom(root: ParentNode): void {
    const anchors: HTMLAnchorElement[] = [];
    if (root instanceof HTMLAnchorElement) {
        anchors.push(root);
    } else if (root.querySelectorAll) {
        root.querySelectorAll('a[href]').forEach((el) => {
            if (el instanceof HTMLAnchorElement) {
                anchors.push(el);
            }
        });
    }

    for (const a of anchors) {
        // Skip links inside the Drive Manager sidebar or PDF toolbar
        if (
            a.closest('.drive-manager-view') ||
            a.closest('.drive-pdf-toolbar') ||
            a.classList.contains('drive-pdf-open-link')
        ) {
            continue;
        }
        // Skip image wrapper links (<a href="..."><img ...></a>)
        if (a.querySelector('img, video, iframe, canvas')) {
            continue;
        }
        // Skip CodeMirror's internal <a> if outer span already has .google-smart-chip
        if (a.closest('.google-smart-chip-cm')) {
            continue;
        }

        const href = a.getAttribute('href') || '';
        const text = a.textContent || '';
        const parsed = parseGoogleSmartLink(href, text);
        if (!parsed) {
            continue;
        }

        a.classList.add('google-smart-chip', `google-chip-${parsed.chipType}`);
        if (parsed.hasLeadingEmoji) {
            a.classList.add('google-chip-has-leading-emoji');
        } else {
            a.classList.remove('google-chip-has-leading-emoji');
        }
        a.dataset.googleChip = parsed.chipType;
    }
}

/**
 * Manages title resolution and paste interception for Google Smart Chips
 */
export class GoogleSmartChipManager {
    private app: App;
    private getUploader: () => GoogleDriveUploader | null;
    private titleCache: Map<string, string> = new Map();
    private shownScopeHint = false;

    constructor(app: App, getUploader: () => GoogleDriveUploader | null) {
        this.app = app;
        this.getUploader = getUploader;
    }

    /**
     * Handle editor-paste event to automatically transform raw Google Drive / Docs URLs
     * into named Markdown links (`[Document Name](https://docs.google.com/...)`).
     */
    handleEditorPaste(evt: ClipboardEvent, editor: Editor, _view: MarkdownView): void {
        if (evt.defaultPrevented || !evt.clipboardData) {
            return;
        }

        const plainText = evt.clipboardData.getData('text/plain').trim();
        if (!plainText || /[\r\n\s]/.test(plainText)) {
            return;
        }

        const parsed = parseGoogleSmartLink(plainText);
        if (!parsed) {
            return;
        }

        // Check if cursor is already inside a Markdown link destination `](|)` or HTML attribute
        const cursor = editor.getCursor('from');
        const lineText = editor.getLine(cursor.line);
        const beforeCursor = lineText.slice(0, cursor.ch);
        if (/\]\([^)]*$/.test(beforeCursor) || /href=["'][^"']*$/i.test(beforeCursor) || /<$/.test(beforeCursor)) {
            return;
        }

        // If user selected non-URL text and pastes a Google URL over it, turn selected text into the chip title
        const selectedText = editor.getSelection().trim();
        if (selectedText && !/^https?:\/\//i.test(selectedText) && !selectedText.includes('\n')) {
            evt.preventDefault();
            const safeSelected = sanitizeMarkdownLinkTitle(selectedText);
            editor.replaceSelection(`[${safeSelected}](${parsed.url}) `);
            return;
        }

        evt.preventDefault();

        // 1. Check synchronous sources first (HTML clipboard or in-memory cache)
        const clipboardHtml = evt.clipboardData.getData('text/html') || '';
        const htmlTitle = extractTitleFromClipboardHtml(clipboardHtml, parsed.url);
        const cacheKey = parsed.fileId || parsed.url;
        const cachedTitle = htmlTitle || this.titleCache.get(cacheKey);

        if (cachedTitle) {
            this.titleCache.set(cacheKey, cachedTitle);
            const safeTitle = sanitizeMarkdownLinkTitle(cachedTitle);
            editor.replaceSelection(`[${safeTitle}](${parsed.url}) `);
            return;
        }

        // 2. Insert instant loading chip placeholder (with trailing space so Live Preview folds it immediately)
        const placeholderText = `⏳ ${parsed.defaultLabel}…`;
        const placeholderMd = `[${placeholderText}](${parsed.url})`;
        editor.replaceSelection(`${placeholderMd} `);

        void this.resolveTitle(parsed).then((resolvedTitle) => {
            const finalTitle = sanitizeMarkdownLinkTitle(resolvedTitle || parsed.defaultLabel);
            if (resolvedTitle) {
                this.titleCache.set(cacheKey, resolvedTitle);
            }
            const finalMd = `[${finalTitle}](${parsed.url})`;

            const currentDoc = editor.getValue();
            const idx = currentDoc.indexOf(placeholderMd);
            if (idx !== -1) {
                const fromPos = editor.offsetToPos(idx);
                const toPos = editor.offsetToPos(idx + placeholderMd.length);
                editor.replaceRange(finalMd, fromPos, toPos);
            }
        });
    }

    /**
     * Resolve the human-readable title of a Google Drive / Docs / Sheets / Slides / Forms link
     */
    async resolveTitle(parsed: ParsedGoogleSmartLink): Promise<string | null> {
        const cacheKey = parsed.fileId || parsed.url;
        const cached = this.titleCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const uploader = this.getUploader();
        let apiAttemptedAndNotFound = false;

        // 1. Try authenticated Google Drive API v3 metadata lookup
        if (parsed.fileId && uploader && uploader.isConnected()) {
            const meta = await uploader.getFileMetadata(parsed.fileId);
            if (meta && meta.name && !isInvalidOrGenericTitle(meta.name)) {
                this.titleCache.set(cacheKey, meta.name);
                return meta.name;
            }
            apiAttemptedAndNotFound = true;
        }

        // 2. Try existing vault embeds if fileId is known in the vault
        if (parsed.fileId) {
            try {
                const vaultMap = await scanVaultForEmbeds(this.app);
                const occurrences = vaultMap.get(parsed.fileId);
                if (occurrences && occurrences.length > 0 && occurrences[0].fileName) {
                    const name = occurrences[0].fileName;
                    if (!isInvalidOrGenericTitle(name) && name !== parsed.fileId) {
                        this.titleCache.set(cacheKey, name);
                        return name;
                    }
                }
            } catch {
                // Ignore vault scan errors
            }
        }

        // 3. Fallback: Fetch HTML page <meta property="og:title"> or <title>
        const pageResult = await this.fetchTitleFromWebPage(parsed.url);
        if (pageResult.title) {
            this.titleCache.set(cacheKey, pageResult.title);
            return pageResult.title;
        }

        // Show a one-time helpful hint if a private Google Doc couldn't be read because OAuth needs reconnect for metadata scope
        if (apiAttemptedAndNotFound && pageResult.hitSignInPage && !this.shownScopeHint) {
            this.shownScopeHint = true;
            new Notice(
                '💡 Drive Embedder: Um auch Namen privater Google Docs/Drive-Dateien automatisch abzurufen, klicke in den Drive Embedder Einstellungen einmal auf "Reconnect".',
                8000
            );
        }

        return null;
    }

    /**
     * Fetch the document title from the HTML page (works for link-shared Docs/Sheets/Slides/Forms)
     */
    private async fetchTitleFromWebPage(
        url: string
    ): Promise<{ title: string | null; hitSignInPage: boolean }> {
        try {
            const response = await requestUrl({
                url,
                method: 'GET',
                throw: false
            });

            if (response.status < 200 || response.status >= 400 || !response.text) {
                return { title: null, hitSignInPage: false };
            }

            const doc = new DOMParser().parseFromString(response.text, 'text/html');
            const rawCandidates = [
                doc.querySelector('meta[property="og:title"]')?.getAttribute('content'),
                doc.querySelector('meta[itemprop="name"]')?.getAttribute('content'),
                doc.querySelector('title')?.textContent
            ];

            let hitSignInPage = false;
            for (const raw of rawCandidates) {
                if (!raw) {
                    continue;
                }
                if (/sign[- ]?in|anmelden|google\s+accounts|google-konten/i.test(raw)) {
                    hitSignInPage = true;
                    continue;
                }
                const cleaned = cleanGooglePageTitle(raw);
                if (cleaned && !isInvalidOrGenericTitle(cleaned)) {
                    return { title: cleaned, hitSignInPage: false };
                }
            }

            return { title: null, hitSignInPage };
        } catch {
            return { title: null, hitSignInPage: false };
        }
    }

    /**
     * Convert raw Google Drive / Docs URLs in the active editor into Smart Chips
     */
    async convertRawUrlsInEditor(editor: Editor): Promise<number> {
        const content = editor.getValue();
        // Match raw Google URLs that are NOT already inside (...), "...", or <...>
        const rawUrlRegex = /(?<![(\["'<])(https?:\/\/(?:docs\.google\.com|drive\.google\.com|forms\.gle)\/[^\s<>)\]"']+)/g;
        const matches: { url: string; parsed: ParsedGoogleSmartLink }[] = [];
        let m: RegExpExecArray | null;

        while ((m = rawUrlRegex.exec(content)) !== null) {
            const url = m[1];
            const parsed = parseGoogleSmartLink(url);
            if (parsed) {
                matches.push({ url, parsed });
            }
        }

        if (matches.length === 0) {
            return 0;
        }

        let updatedCount = 0;
        for (const item of matches) {
            const resolved = await this.resolveTitle(item.parsed);
            const finalTitle = sanitizeMarkdownLinkTitle(resolved || item.parsed.defaultLabel);
            const replacement = `[${finalTitle}](${item.url})`;

            const currentDoc = editor.getValue();
            // Find standalone occurrence of item.url not preceded by `](`
            const escapedUrl = item.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const singleRegex = new RegExp(`(?<![(\\[\\"'<])${escapedUrl}`);
            const singleMatch = singleRegex.exec(currentDoc);
            if (singleMatch && singleMatch.index !== undefined) {
                const fromPos = editor.offsetToPos(singleMatch.index);
                const toPos = editor.offsetToPos(singleMatch.index + item.url.length);
                editor.replaceRange(replacement, fromPos, toPos);
                updatedCount++;
            }
        }

        return updatedCount;
    }
}
