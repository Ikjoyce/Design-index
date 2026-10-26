/** Browser-safe contracts and utilities; no model client, credentials, or validation runtime. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const SUPPORTED_IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const;
export const ITEM_STATUSES = ['queued', 'analyzing', 'writing_prompt', 'ready', 'needs_review'] as const;
export const PALETTE_ROLES = ['background', 'surface', 'text', 'muted-text', 'accent', 'border'] as const;
export type PaletteRole = typeof PALETTE_ROLES[number];

export interface PaletteColor {
  hex: string;
  oklab: [number, number, number];
  weight: number;
  source: 'pixels' | 'css';
  role: PaletteRole | null;
}

export interface LibraryItem {
  id: string;
  type: 'image' | 'url' | 'element';
  title: string;
  note: string;
  status: typeof ITEM_STATUSES[number];
  capturedAt: string;
  width: number;
  height: number;
  previewUrl: string;
  originalUrl: string;
  palette: PaletteColor[];
}

export interface LibraryPage {
  items: LibraryItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface CaptureResult {
  item: LibraryItem;
  deduplicated: boolean;
}

export function paletteToCss(palette: readonly PaletteColor[]): string {
  const declarations = palette.map((color, index) => {
    const name = color.role ?? `color-${index + 1}`;
    return `  --${name}: ${color.hex};`;
  });
  return `:root {\n${declarations.join('\n')}\n}\n`;
}
