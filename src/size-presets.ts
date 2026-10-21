/**
 * Drive Embedder - Size Presets
 * Intuitive size options for all content types
 */

import { ContentCategory, SizeOption, SupportedFileType } from './types';

/**
 * Size presets per content category
 * Designed for non-developers with intuitive labels
 */
export const SIZE_PRESETS: Record<ContentCategory, SizeOption[]> = {
    video: [
        {
            id: 'compact',
            label: 'Compact',
            icon: '🔹',
            description: 'good for inline content',
            width: '60%',
            height: '280px'
        },
        {
            id: 'medium',
            label: 'Medium',
            icon: '🔸',
            description: 'recommended for most use cases',
            width: '80%',
            height: '400px',
            recommended: true
        },
        {
            id: 'large',
            label: 'Large',
            icon: '🔶',
            description: 'for detailed viewing',
            width: '100%',
            height: '500px'
        },
        {
            id: 'fullwidth',
            label: 'Full width',
            icon: '🟠',
            description: 'immersive viewing experience',
            width: '100%',
            height: '600px'
        }
    ],
    document: [
        {
            id: 'compact',
            label: 'Compact',
            icon: '🔹',
            description: 'quick preview',
            width: '70%',
            height: '400px'
        },
        {
            id: 'medium',
            label: 'Medium',
            icon: '🔸',
            description: 'good for reading documents',
            width: '100%',
            height: '500px',
            recommended: true
        },
        {
            id: 'large',
            label: 'Large',
            icon: '🔶',
            description: 'comfortable reading',
            width: '100%',
            height: '650px'
        },
        {
            id: 'fullwidth',
            label: 'Full screen',
            icon: '🟠',
            description: 'full-screen document viewer',
            width: '100%',
            height: '800px'
        }
    ],
    image: [
        {
            id: 'thumbnail',
            label: 'Thumbnail',
            icon: '🔹',
            description: 'small preview image',
            width: '200px',
            height: 'auto'
        },
        {
            id: 'compact',
            label: 'Compact',
            icon: '🔸',
            description: 'suitable for body content',
            width: '400px',
            height: 'auto'
        },
        {
            id: 'medium',
            label: 'Medium',
            icon: '🔶',
            description: 'good for viewing images',
            width: '600px',
            height: 'auto',
            recommended: true
        },
        {
            id: 'large',
            label: 'Large',
            icon: '🟠',
            description: 'for detailed viewing',
            width: '100%',
            height: 'auto'
        }
    ],
    audio: [
        {
            id: 'slim',
            label: 'Slim',
            icon: '🎵',
            description: 'minimal space',
            width: '100%',
            height: '100px',
            recommended: true
        },
        {
            id: 'standard',
            label: 'Standard',
            icon: '🎶',
            description: 'with some padding',
            width: '100%',
            height: '120px'
        }
    ]
};

/**
 * Supported file types with their categories and metadata
 */
export const SUPPORTED_FILE_TYPES: SupportedFileType[] = [
    // Video
    { extension: '.mp4', mimeType: 'video/mp4', category: 'video', icon: '🎬', label: 'MP4 video' },
    { extension: '.webm', mimeType: 'video/webm', category: 'video', icon: '🎬', label: 'WebM video' },
    { extension: '.mov', mimeType: 'video/quicktime', category: 'video', icon: '🎬', label: 'QuickTime video' },
    { extension: '.avi', mimeType: 'video/x-msvideo', category: 'video', icon: '🎬', label: 'AVI video' },

    // Audio
    { extension: '.mp3', mimeType: 'audio/mpeg', category: 'audio', icon: '🎵', label: 'MP3 audio' },
    { extension: '.wav', mimeType: 'audio/wav', category: 'audio', icon: '🎵', label: 'WAV audio' },
    { extension: '.ogg', mimeType: 'audio/ogg', category: 'audio', icon: '🎵', label: 'OGG audio' },
    { extension: '.m4a', mimeType: 'audio/mp4', category: 'audio', icon: '🎵', label: 'M4A audio' },

    // Document
    { extension: '.pdf', mimeType: 'application/pdf', category: 'document', icon: '📄', label: 'PDF document' },

    // Image
    { extension: '.jpg', mimeType: 'image/jpeg', category: 'image', icon: '🖼️', label: 'JPEG image' },
    { extension: '.jpeg', mimeType: 'image/jpeg', category: 'image', icon: '🖼️', label: 'JPEG image' },
    { extension: '.png', mimeType: 'image/png', category: 'image', icon: '🖼️', label: 'PNG image' },
    { extension: '.gif', mimeType: 'image/gif', category: 'image', icon: '🖼️', label: 'GIF image' },
    { extension: '.webp', mimeType: 'image/webp', category: 'image', icon: '🖼️', label: 'WebP image' },
    { extension: '.svg', mimeType: 'image/svg+xml', category: 'image', icon: '🖼️', label: 'SVG image' }
];

/**
 * Get file type info from filename or MIME type
 */
export function getFileTypeInfo(fileName: string, mimeType?: string): SupportedFileType | null {
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex !== -1) {
        const ext = fileName.toLowerCase().substring(dotIndex);
        const byExt = SUPPORTED_FILE_TYPES.find(ft => ft.extension === ext);
        if (byExt) {
            return byExt;
        }
    }
    if (mimeType) {
        const normalizedMime = mimeType.toLowerCase().split(';')[0].trim();
        return SUPPORTED_FILE_TYPES.find(ft => ft.mimeType === normalizedMime) || null;
    }
    return null;
}

/**
 * Get size presets for a category
 */
export function getSizePresets(category: ContentCategory): SizeOption[] {
    return SIZE_PRESETS[category] || SIZE_PRESETS.document;
}

/**
 * Get recommended size for a category
 */
export function getRecommendedSize(category: ContentCategory): SizeOption {
    const presets = getSizePresets(category);
    return presets.find(p => p.recommended) || presets[0];
}

/**
 * Get size by ID for a category
 */
export function getSizeById(category: ContentCategory, sizeId: string): SizeOption {
    const presets = getSizePresets(category);
    return presets.find(p => p.id === sizeId) || getRecommendedSize(category);
}

/**
 * Check if file is supported
 */
export function isFileSupported(fileName: string, mimeType?: string): boolean {
    return getFileTypeInfo(fileName, mimeType) !== null;
}

/**
 * Get supported extensions as string for file input
 */
export function getSupportedExtensions(): string {
    return SUPPORTED_EXTENSIONS.join(',');
}

/**
 * Supported extensions and MIME types array for file input accept attribute (includes MIME wildcards for Android picker)
 */
export const SUPPORTED_EXTENSIONS: string[] = [
    ...SUPPORTED_FILE_TYPES.map(ft => ft.extension),
    'image/*',
    'video/*',
    'audio/*',
    'application/pdf'
];

/**
 * Get category icon
 */
export function getCategoryIcon(category: ContentCategory): string {
    const icons: Record<ContentCategory, string> = {
        video: '🎬',
        audio: '🎵',
        document: '📄',
        image: '🖼️'
    };
    return icons[category];
}

/**
 * Get category label
 */
export function getCategoryLabel(category: ContentCategory): string {
    const labels: Record<ContentCategory, string> = {
        video: 'Video',
        audio: 'Audio',
        document: 'Document',
        image: 'Image'
    };
    return labels[category];
}
