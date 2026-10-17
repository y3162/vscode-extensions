export interface IconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontId?: string;
}

export interface IconFont {
  id: string;
  src: { path: string; format?: string }[];
}

export interface IconThemeDocument {
  iconDefinitions?: Record<string, IconDefinition>;
  fonts?: IconFont[];
  file?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  light?: IconThemeDocument;
  highContrast?: IconThemeDocument;
}

export type IconMatch =
  | { type: 'image'; iconPath: string }
  | { type: 'font'; iconPath?: string; fontCharacter: string; fontColor?: string; fontPath?: string; fontFamily: string; format?: string }
  | { type: 'badge' };

export function resolveThemeIcon(theme: IconThemeDocument, fileName: string, variant: 'dark' | 'light' | 'highContrast' = 'dark'): IconMatch {
  const layer = variant === 'light' ? theme.light : variant === 'highContrast' ? theme.highContrast : undefined;
  const id = iconId(layer, fileName) ?? iconId(theme, fileName);
  const definition = id ? theme.iconDefinitions?.[id] ?? layer?.iconDefinitions?.[id] : undefined;
  if (!definition) return { type: 'badge' };
  if (definition.iconPath && !definition.fontCharacter) return { type: 'image', iconPath: definition.iconPath };
  if (definition.fontCharacter) {
    const font = theme.fonts?.find((item) => item.id === (definition.fontId ?? theme.fonts?.[0]?.id)) ?? theme.fonts?.[0];
    const src = font?.src[0];
    return {
      type: 'font',
      ...(definition.iconPath ? { iconPath: definition.iconPath } : {}),
      fontCharacter: definition.fontCharacter,
      ...(definition.fontColor ? { fontColor: definition.fontColor } : {}),
      ...(src?.path ? { fontPath: src.path, format: src.format } : {}),
      fontFamily: font?.id ?? 'ai-agents-file-icons',
    };
  }
  return { type: 'badge' };
}

function iconId(theme: IconThemeDocument | undefined, fileName: string): string | undefined {
  if (!theme) return undefined;
  const pathSegments = fileName.split(/[\\/]/);
  const base = pathSegments[pathSegments.length - 1]!;
  const lower = base.toLowerCase();
  const named = theme.fileNames?.[base] ?? theme.fileNames?.[lower];
  if (named) return named;
  const parts = lower.split('.');
  for (let index = 1; index < parts.length; index += 1) {
    const extension = parts.slice(index).join('.');
    const match = theme.fileExtensions?.[extension];
    if (match) return match;
  }
  return theme.file;
}
