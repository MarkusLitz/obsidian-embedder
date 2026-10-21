/**
 * Drive Embedder - Vault & Note Embed Scanner
 * Scans Markdown notes for Google Drive embeds, and provides safe removal and resizing
 */

import { App, TFile } from 'obsidian';
import { ContentCategory, NoteEmbedOccurrence, SizeOption } from './types';
import { getFileTypeInfo, getSizePresets } from './size-presets';

/**
 * Extract Google Drive file ID from a URL or snippet safely
 */
export function extractDriveIdFromText(text: string): string | null {
    if (!text || !text.includes('drive.google.com')) {
        return null;
    }
    const pathMatch = text.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (pathMatch && pathMatch[1]) {
        return pathMatch[1];
    }
    const idQueryMatch = text.match(/drive\.google\.com\/[^\s"'<>]*[?&]id=([a-zA-Z0-9_-]+)/);
    if (idQueryMatch && idQueryMatch[1]) {
        return idQueryMatch[1];
    }
    return null;
}

function unescapeHtmlEntities(str: string): string {
    return str
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function unescapeMarkdownTitle(str: string): string {
    return str.replace(/\\([[\]])/g, '$1').trim();
}

function countLinesBefore(content: string, index: number): number {
    let line = 0;
    for (let i = 0; i < index && i < content.length; i++) {
        if (content.charCodeAt(i) === 10) {
            line++;
        }
    }
    return line;
}

/**
 * Scan a Markdown note's text content for all Drive Embedder blocks
 */
export function scanNoteContent(
    content: string,
    notePath: string,
    noteName: string
): NoteEmbedOccurrence[] {
    const occurrences: NoteEmbedOccurrence[] = [];
    if (!content || !content.includes('drive.google.com')) {
        return occurrences;
    }

    // 1. Match <div ...>...</div> blocks containing drive.google.com
    const divRegex = /<div\b[^>]*>[\s\S]*?<\/div>/gi;
    let match: RegExpExecArray | null;

    while ((match = divRegex.exec(content)) !== null) {
        const divHtml = match[0];
        const fileId = extractDriveIdFromText(divHtml);
        if (!fileId) {
            continue;
        }

        const divStart = match.index;
        const divEnd = divStart + divHtml.length;

        let charStart = divStart;
        const charEnd = divEnd;
        let fileName = '';
        let showTitle = false;

        // Check immediately preceding lines for the associated [📁 filename](...) or **📁 filename** title
        const beforeSlice = content.slice(Math.max(0, divStart - 600), divStart);
        const titleRegex = /(?:^|\r?\n)([ \t]*(?:\*\*\[📁\s*([^\n]+?)\]\([^)\r\n]+\)\*\*|\[📁\s*([^\n]+?)\]\([^)\r\n]+\)|\*\*📁\s*([^\n*]+?)\*\*)[ \t]*\r?\n(?:\r?\n)?)$/;
        const titleMatch = beforeSlice.match(titleRegex);

        if (titleMatch && titleMatch[1]) {
            charStart = divStart - titleMatch[1].length;
            const rawName = titleMatch[2] || titleMatch[3] || titleMatch[4] || '';
            fileName = unescapeMarkdownTitle(rawName);
            showTitle = Boolean(titleMatch[2] || titleMatch[4]);
        }

        // Fallback: extract filename from <img alt="..."> if not found in title
        if (!fileName) {
            const altMatch = divHtml.match(/\balt="([^"]*)"/i);
            if (altMatch && altMatch[1]) {
                fileName = unescapeHtmlEntities(altMatch[1]);
            }
        }

        if (!fileName) {
            fileName = fileId;
        }

        // Determine category
        let category: ContentCategory = 'document';
        const isImg = /<img\b/i.test(divHtml) || divHtml.includes('drive.google.com/thumbnail');
        if (isImg) {
            category = 'image';
        } else {
            const typeInfo = getFileTypeInfo(fileName);
            if (typeInfo) {
                category = typeInfo.category;
            } else if (/allowfullscreen/i.test(divHtml)) {
                category = 'video';
            } else if (/autoplay;\s*encrypted-media/i.test(divHtml)) {
                category = 'audio';
            } else {
                category = 'document';
            }
        }

        // Extract width and height
        const divWidthMatch = divHtml.match(/<div\b[^>]*style="[^"]*?\bwidth:\s*([^;"]+)/i);
        const currentWidth = divWidthMatch ? divWidthMatch[1].trim() : undefined;

        let currentHeight: string | undefined;
        if (isImg) {
            const imgHeightMatch = divHtml.match(/<img\b[^>]*style="[^"]*?\bheight:\s*([^;"]+)/i);
            currentHeight = imgHeightMatch ? imgHeightMatch[1].trim() : 'auto';
        } else {
            const iframeHeightMatch = divHtml.match(/<iframe\b[^>]*\bheight="([^"]+)"/i);
            currentHeight = iframeHeightMatch ? iframeHeightMatch[1].trim() : undefined;
        }

        // Match size preset ID
        const presets = getSizePresets(category);
        let matchedSizeId: string | undefined;
        for (const preset of presets) {
            if (category === 'image') {
                if (currentWidth && preset.width.toLowerCase() === currentWidth.toLowerCase()) {
                    matchedSizeId = preset.id;
                    break;
                }
            } else if (category === 'audio') {
                if (currentHeight && preset.height.toLowerCase() === currentHeight.toLowerCase()) {
                    matchedSizeId = preset.id;
                    break;
                }
            } else {
                if (
                    currentWidth &&
                    currentHeight &&
                    preset.width.toLowerCase() === currentWidth.toLowerCase() &&
                    preset.height.toLowerCase() === currentHeight.toLowerCase()
                ) {
                    matchedSizeId = preset.id;
                    break;
                }
            }
        }

        const lineStart = countLinesBefore(content, charStart);
        const lineEnd = countLinesBefore(content, charEnd);

        occurrences.push({
            fileId,
            fileName,
            notePath,
            noteName,
            lineStart,
            lineEnd,
            charStart,
            charEnd,
            category,
            currentWidth,
            currentHeight,
            matchedSizeId,
            showTitle
        });
    }

    // 2. Also detect standalone [📁 filename](https://drive.google.com/...) links not followed by a <div>
    const standaloneLinkRegex = /^[ \t]*(?:\*\*\[📁\s*([^\n]+?)\]\((https:\/\/drive\.google\.com\/[^)\r\n]+)\)\*\*|\[📁\s*([^\n]+?)\]\((https:\/\/drive\.google\.com\/[^)\r\n]+)\))[ \t]*$/gm;
    let linkMatch: RegExpExecArray | null;

    while ((linkMatch = standaloneLinkRegex.exec(content)) !== null) {
        const matchStart = linkMatch.index;
        const matchEnd = matchStart + linkMatch[0].length;

        // Skip if already part of a <div> embed occurrence
        const alreadyCovered = occurrences.some(
            occ => matchStart >= occ.charStart && matchEnd <= occ.charEnd
        );
        if (alreadyCovered) {
            continue;
        }

        const rawName = linkMatch[1] || linkMatch[3] || '';
        const rawUrl = linkMatch[2] || linkMatch[4] || '';
        const fileId = extractDriveIdFromText(rawUrl);
        if (!fileId) {
            continue;
        }

        const fileName = unescapeMarkdownTitle(rawName) || fileId;
        const typeInfo = getFileTypeInfo(fileName);
        const category: ContentCategory = typeInfo ? typeInfo.category : 'document';
        const lineStart = countLinesBefore(content, matchStart);

        occurrences.push({
            fileId,
            fileName,
            notePath,
            noteName,
            lineStart,
            lineEnd: lineStart,
            charStart: matchStart,
            charEnd: matchEnd,
            category,
            showTitle: Boolean(linkMatch[1])
        });
    }

    occurrences.sort((a, b) => a.charStart - b.charStart);
    return occurrences;
}

/**
 * Scan all Markdown files in the vault and group occurrences by Google Drive fileId
 */
export async function scanVaultForEmbeds(app: App): Promise<Map<string, NoteEmbedOccurrence[]>> {
    const map = new Map<string, NoteEmbedOccurrence[]>();
    const markdownFiles = app.vault.getMarkdownFiles();

    for (const file of markdownFiles) {
        try {
            const content = await app.vault.cachedRead(file);
            if (!content.includes('drive.google.com')) {
                continue;
            }
            const noteOccurrences = scanNoteContent(content, file.path, file.basename);
            for (const occ of noteOccurrences) {
                const list = map.get(occ.fileId) || [];
                list.push(occ);
                map.set(occ.fileId, list);
            }
        } catch (err) {
            console.debug(`Could not scan note ${file.path}:`, err);
        }
    }

    return map;
}

/**
 * Remove a specific embed occurrence (or all occurrences of a fileId) from a Markdown note cleanly
 */
export async function removeEmbedFromNote(
    app: App,
    file: TFile,
    target: { fileId: string; charStart?: number; lineStart?: number; removeAllForFileId?: boolean }
): Promise<number> {
    let removedCount = 0;

    await app.vault.process(file, (content) => {
        const occurrences = scanNoteContent(content, file.path, file.basename);
        const matching = occurrences.filter(occ => {
            if (occ.fileId !== target.fileId) {
                return false;
            }
            if (target.removeAllForFileId) {
                return true;
            }
            if (target.charStart !== undefined && occ.charStart === target.charStart) {
                return true;
            }
            if (target.lineStart !== undefined && occ.lineStart === target.lineStart) {
                return true;
            }
            return target.charStart === undefined && target.lineStart === undefined;
        });

        if (matching.length === 0) {
            return content;
        }

        // Remove from back to front so character offsets stay valid
        const sortedDesc = [...matching].sort((a, b) => b.charStart - a.charStart);
        let updated = content;

        for (const occ of sortedDesc) {
            let start = occ.charStart;
            let end = occ.charEnd;

            // Consume trailing newline(s) up to one blank line so no orphan empty lines remain
            if (updated.slice(end, end + 2) === '\r\n') {
                end += 2;
                if (updated.slice(end, end + 2) === '\r\n') {
                    end += 2;
                }
            } else if (updated[end] === '\n') {
                end += 1;
                if (updated[end] === '\n') {
                    end += 1;
                }
            } else if (start > 0 && updated[start - 1] === '\n') {
                start -= 1;
                if (start > 0 && updated[start - 1] === '\r') {
                    start -= 1;
                }
            }

            updated = updated.slice(0, start) + updated.slice(end);
            removedCount++;
        }

        return updated;
    });

    return removedCount;
}

/**
 * Resize a specific embed occurrence in a Markdown note
 */
export async function resizeEmbedInNote(
    app: App,
    file: TFile,
    target: { fileId: string; charStart: number; lineStart: number },
    newSize: SizeOption
): Promise<boolean> {
    let resized = false;

    await app.vault.process(file, (content) => {
        const occurrences = scanNoteContent(content, file.path, file.basename);
        const occ = occurrences.find(
            o => o.fileId === target.fileId && (o.charStart === target.charStart || o.lineStart === target.lineStart)
        );
        if (!occ) {
            return content;
        }

        const block = content.slice(occ.charStart, occ.charEnd);

        // Update <div style="width: ...">
        let updatedBlock = block.replace(
            /(<div\b[^>]*style="[^"]*?\bwidth:\s*)([^;"]+)/i,
            `$1${newSize.width}`
        );

        if (occ.category === 'image') {
            updatedBlock = updatedBlock.replace(
                /(<img\b[^>]*style="[^"]*?\bheight:\s*)([^;"]+)/i,
                `$1${newSize.height}`
            );
        } else {
            updatedBlock = updatedBlock.replace(
                /(<iframe\b[^>]*\bheight=")([^"]+)(")/i,
                `$1${newSize.height}$3`
            );
        }

        if (updatedBlock !== block) {
            resized = true;
            return content.slice(0, occ.charStart) + updatedBlock + content.slice(occ.charEnd);
        }
        return content;
    });

    return resized;
}
