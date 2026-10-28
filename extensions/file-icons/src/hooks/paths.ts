import type { ExtensionContext } from 'vscode'
import type { ThemePaths } from '~/types'
import { Uri } from 'vscode'

/**
 * Get extension runtime root (`dist`)
 * @param context current extension context
 * @returns root uri
 */
function getRootPath(context: ExtensionContext) {
  return Uri.joinPath(context.extensionUri, 'dist')
}

/**
 * Get (fresh install) flag path
 * @param context current extension context
 * @returns flag uri
 */
export function getFlagPath(context: ExtensionContext) {
  const root = getRootPath(context)
  return Uri.joinPath(root, '.flag')
}

/**
 * Get unflavored (css-vars) icons folder path
 * @param context current extension context
 * @returns unflavored icons folder uri
 */
export function getUnflavoredPath(context: ExtensionContext) {
  const root = getRootPath(context)
  return Uri.joinPath(root, 'unflavored')
}

/**
 * Get flavored folder paths
 * @param context current extension context
 * @returns flavored icons/theme paths
 */
export function getThemePaths(context: ExtensionContext): ThemePaths {
  const root = getRootPath(context)
  return {
    light: {
      icons: Uri.joinPath(root, 'light', 'icons'),
      theme: Uri.joinPath(root, 'light', 'theme.json'),
    },
    dark: {
      icons: Uri.joinPath(root, 'dark', 'icons'),
      theme: Uri.joinPath(root, 'dark', 'theme.json'),
    },
  }
}
