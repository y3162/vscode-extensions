import type { ExtensionContext } from 'vscode'
import { Uri, window, workspace } from 'vscode'
import { themeFlavors } from '~/constants/themes'
import { getConfig } from '~/hooks/configuration'
import { getIconDefinitions } from '~/hooks/iconDefinitions'
import { readFile, writeFile, writeJsonFile } from '~/hooks/interactions'
import { getThemePaths, getUnflavoredPath } from '~/hooks/paths'
import { compileIcon, hashedSvgPath, iconHash } from '~/utils/icons'
import { compileTheme } from '~/utils/themes'

/**
 * Update themes and icons according to configuration
 * @param context current extension context
 * @param icons should icon files be regenerated
 */
export async function updateThemes(context: ExtensionContext, icons = false) {
  const iconDefinitions = await getIconDefinitions(context)
  const paths = getThemePaths(context)
  const config = getConfig()
  const hash = iconHash(config)
  const themes = Object.keys(themeFlavors) as Array<keyof typeof themeFlavors>

  if (icons) {
    const unflavored = getUnflavoredPath(context)
    const unflavoredIcons = await workspace.fs.readDirectory(unflavored)

    await Promise.all(themes.map(async (themeName) => {
      // delete flavored icons
      await workspace.fs.delete(paths[themeName].icons, { recursive: true })
      // recreate flavored icon folder
      await workspace.fs.createDirectory(paths[themeName].icons)
      // recreate flavored icons with hashed paths
      await Promise.all(unflavoredIcons.map(async ([i]) => {
        const icon = await readFile(Uri.joinPath(unflavored, i))
        await writeFile(
          Uri.joinPath(paths[themeName].icons, hashedSvgPath(i, hash)),
          compileIcon(icon, themeFlavors[themeName], { monochrome: config.monochrome }),
        )
      }))
    })).catch((e: Error) => {
      window.showErrorMessage(`Failed to save re-compiled icons: \n${e.message}`)
    })
  }

  // add hashed paths to iconDefs
  for (const i in iconDefinitions)
    iconDefinitions[i].iconPath = hashedSvgPath(iconDefinitions[i].iconPath, hash)

  // create and write `theme.json` files
  const theme = compileTheme(config, iconDefinitions)
  await Promise.all(themes.map(async (themeName) => {
    await writeJsonFile(paths[themeName].theme, theme)
  })).catch((e: Error) => {
    window.showErrorMessage(`Failed to save re-compiled theme: \n${e.message}`)
  })
}
