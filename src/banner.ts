import * as vscode from 'vscode'
import { execFile } from 'child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import * as path from 'path'
import { promisify } from 'util'

const run = promisify(execFile)

/**
 * Native macOS banners are posted by a small helper app generated at first use,
 * not by `osascript` directly.
 *
 * macOS credits a notification to the process that posts it, and there is no way
 * to hand that credit to another app: `tell application id "…" to display
 * notification` does *not* run inside the target — since 10.14 Standard
 * Additions are no longer injected into other processes, so the command
 * silently executes in the script host anyway. Posting through `osascript`
 * therefore shows up as **Script Editor**, with its icon and a click that wakes
 * Script Editor rather than the editor you were trying to get back to.
 *
 * The only way to change that is for a real app bundle to do the posting. The
 * helper is that bundle: an AppleScript droplet with its own bundle id, its own
 * name, and the host editor's icon copied in, whose own script calls `display
 * notification`. Clicking one of its banners launches it, and its `reopen`
 * handler brings the editor forward.
 *
 * Two sharp edges this depends on, both found the hard way:
 *  - `osacompile` emits a bundle with no `CFBundleIdentifier`, and a notification
 *    from a bundle-less process is dropped without an error.
 *  - macOS registers the helper with notifications turned **off**, so the first
 *    build has to tell the user to allow them (see `promptForPermission`).
 */
const BUNDLE_ID = 'com.tule.hero-code.notifier'

/** Shown as the app name in System Settings → Notifications. */
const APP_NAME = 'Hero Code'

/** Bump to force a rebuild of an already-generated helper after a script change. */
const SCRIPT_REV = 1

const PROMPTED_KEY = 'heroCode.notifier.permissionPrompted'

type Host = { appPath: string; bundleId: string; iconPath: string }
type Helper = { appPath: string; payloadDir: string }

let storageDir: string | undefined
let globalState: vscode.Memento | undefined
let helper: Promise<Helper | undefined> | undefined
let seq = 0

/** Wires up the storage the helper is generated into. Call once, from `activate`. */
export function initBanners(context: vscode.ExtensionContext): void {
  storageDir = context.globalStorageUri.fsPath
  globalState = context.globalState
}

/**
 * Posts a native banner. Fire and forget: a banner that fails must never
 * surface an error of its own, so every failure path falls through to the plain
 * `osascript` banner, which still reaches the user — just under Script Editor's
 * name.
 */
export function postBanner(title: string, body: string, sound: boolean): void {
  void (async () => {
    try {
      const h = await resolveHelper()
      if (h) {
        await post(h, title, body, sound)
        return
      }
    } catch {
      // Fall through.
    }
    fallbackBanner(title, body, sound)
  })()
}

async function post(h: Helper, title: string, body: string, sound: boolean): Promise<void> {
  // The text reaches the helper through a file it reads at runtime, never
  // through the script source. Session titles are arbitrary user prompt text,
  // so compiling them in would be both a breakage bug (any quote or backslash)
  // and an injection vector. `clean()` in notify.ts has already collapsed
  // newlines, which is what keeps the line-per-field format unambiguous.
  const payload = path.join(h.payloadDir, `${process.pid}-${seq++}.txt`)
  await writeFile(payload, `${title}\n${body}\n${sound ? '1' : '0'}\n`, 'utf8')
  await run('/usr/bin/open', ['-a', h.appPath, payload], { timeout: 10_000 })
}

function fallbackBanner(title: string, body: string, sound: boolean): void {
  const script = sound
    ? 'display notification (item 1 of argv) with title (item 2 of argv) sound name "Ping"'
    : 'display notification (item 1 of argv) with title (item 2 of argv)'
  execFile(
    'osascript',
    ['-e', 'on run argv', '-e', script, '-e', 'end run', body, title],
    { timeout: 5000 },
    () => {},
  )
}

function resolveHelper(): Promise<Helper | undefined> {
  helper ??= build().catch(() => undefined)
  return helper
}

async function build(): Promise<Helper | undefined> {
  const storage = storageDir
  if (!storage || process.platform !== 'darwin') {
    return undefined
  }
  const host = await resolveHost()
  if (!host) {
    return undefined
  }

  const appPath = path.join(storage, `${APP_NAME}.app`)
  const payloadDir = path.join(storage, 'banners')
  const stampPath = path.join(storage, 'notifier.stamp')
  const stamp = `${SCRIPT_REV}|${host.appPath}|${host.bundleId}`

  await mkdir(payloadDir, { recursive: true })

  // A rebuild is only needed when the host editor changes (a different install,
  // or Insiders vs stable) or the helper's script does.
  if (await readFile(stampPath, 'utf8').then((s) => s === stamp, () => false)) {
    return { appPath, payloadDir }
  }

  const source = path.join(storage, 'notifier.applescript')
  await rm(appPath, { recursive: true, force: true })
  await writeFile(source, appleScript(host.bundleId), 'utf8')
  await run('/usr/bin/osacompile', ['-o', appPath, source], { timeout: 30_000 })

  // The editor's own icon, so the banner is indistinguishable from one the
  // editor posted itself. `Assets.car` ships with the compiled droplet and wins
  // over `CFBundleIconFile`, so it has to go.
  const res = path.join(appPath, 'Contents', 'Resources')
  await copyFile(host.iconPath, path.join(res, 'droplet.icns'))
  await rm(path.join(res, 'Assets.car'), { force: true })

  const plist = path.join(appPath, 'Contents', 'Info.plist')
  // `-replace` inserts keys that are absent, which `CFBundleIdentifier` always
  // is on an osacompile bundle.
  await run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', BUNDLE_ID, plist])
  await run('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', APP_NAME, plist])
  await run('/usr/bin/plutil', ['-replace', 'CFBundleIconFile', '-string', 'droplet', plist])
  // No Dock icon or menu bar when a banner is posted or clicked.
  await run('/usr/bin/plutil', ['-replace', 'LSUIElement', '-bool', 'true', plist])

  // Editing the bundle invalidated the signature osacompile applied.
  await run('/usr/bin/codesign', ['--force', '--deep', '-s', '-', appPath], { timeout: 60_000 })
  await run(
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
    ['-f', appPath],
    { timeout: 30_000 },
  )

  await writeFile(stampPath, stamp, 'utf8')
  promptForPermission()
  return { appPath, payloadDir }
}

/**
 * The helper is a brand new app as far as macOS is concerned, and new apps are
 * registered with notifications **off**. Without this the upgrade looks like
 * notifications simply stopped working.
 */
function promptForPermission(): void {
  if (globalState?.get<string>(PROMPTED_KEY) === BUNDLE_ID) {
    return
  }
  void globalState?.update(PROMPTED_KEY, BUNDLE_ID)
  const open = 'Open Notification Settings'
  void vscode.window
    .showInformationMessage(
      `Hero Code posts notifications through a helper app so they carry the editor's icon. macOS starts new apps with notifications turned off — allow them for “${APP_NAME}” or banners won't appear.`,
      open,
    )
    .then((choice) => {
      if (choice === open) {
        execFile(
          '/usr/bin/open',
          ['x-apple.systempreferences:com.apple.Notifications-Settings.extension'],
          () => {},
        )
      }
    })
}

/**
 * The app bundle hosting the extension — VS Code, Insiders, VSCodium or a fork —
 * so the helper borrows its identity and icon.
 *
 * Derived from `env.appRoot` rather than `process.execPath`: the extension host
 * runs out of a nested `Code Helper (Plugin).app`, which is not the app the user
 * thinks of as the editor.
 */
async function resolveHost(): Promise<Host | undefined> {
  const at = vscode.env.appRoot.indexOf('.app/Contents/')
  if (at < 0) {
    return undefined
  }
  const appPath = vscode.env.appRoot.slice(0, at + 4)
  const plist = path.join(appPath, 'Contents', 'Info.plist')

  const bundleId = (await extract('CFBundleIdentifier', plist))?.trim()
  // Interpolated into the helper's script source, so it must be inert.
  if (!bundleId || !/^[A-Za-z0-9.-]+$/.test(bundleId)) {
    return undefined
  }

  const icon = (await extract('CFBundleIconFile', plist))?.trim()
  if (!icon) {
    return undefined
  }
  const iconPath = path.join(appPath, 'Contents', 'Resources', icon.endsWith('.icns') ? icon : `${icon}.icns`)

  return { appPath, bundleId, iconPath }
}

async function extract(key: string, plist: string): Promise<string | undefined> {
  return run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], { timeout: 5000 }).then(
    ({ stdout }) => stdout,
    () => undefined,
  )
}

/**
 * `theFiles` is the payload queue: macOS coalesces a burst of `open` calls into
 * one launch carrying several files, so the handler loops rather than assuming
 * one. Each payload is deleted as it is read.
 *
 * `reopen` is what a click on a banner reaches, and `run` covers the launch when
 * the helper is not already running.
 */
function appleScript(hostBundleId: string): string {
  return `on open theFiles
	repeat with f in theFiles
		try
			set ff to contents of f
			set p to POSIX path of (ff as text)
			set txt to read ff as «class utf8»
			do shell script "/bin/rm -f " & quoted form of p
			set ps to paragraphs of txt
			set t to item 1 of ps
			set b to item 2 of ps
			if (item 3 of ps) is "1" then
				display notification b with title t sound name "Ping"
			else
				display notification b with title t
			end if
		end try
	end repeat
end open

on run
	focusHost()
end run

on reopen
	focusHost()
end reopen

on focusHost()
	try
		do shell script "/usr/bin/open -b ${hostBundleId}"
	end try
end focusHost
`
}
