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
const SCRIPT_REV = 2

const PROMPTED_KEY = 'heroCode.notifier.permissionPrompted'

/** File the helper reads on click to learn which session the last banner was about. */
const TARGET_FILE = 'last-banner.txt'

type Host = { appPath: string; bundleId: string; iconPath: string }
type Helper = { appPath: string; payloadDir: string }
/** Everything `focusHost` needs compiled in to turn a click into a deep link. */
type DeepLinkTarget = { file: string; scheme: string; extensionId: string }

let storageDir: string | undefined
let globalState: vscode.Memento | undefined
let deepLink: { scheme: string; extensionId: string } | undefined
let helper: Promise<Helper | undefined> | undefined
let seq = 0

/** Wires up the storage the helper is generated into. Call once, from `activate`. */
export function initBanners(context: vscode.ExtensionContext): void {
  storageDir = context.globalStorageUri.fsPath
  globalState = context.globalState
  // Captured rather than hardcoded: the scheme is `vscode-insiders` on Insiders
  // and `vscodium` on VSCodium, and a deep link on the wrong scheme silently
  // opens nothing.
  deepLink = { scheme: vscode.env.uriScheme, extensionId: context.extension.id }
}

/**
 * Posts a native banner. Fire and forget: a banner that fails must never
 * surface an error of its own, so every failure path falls through to the plain
 * `osascript` banner, which still reaches the user — just under Script Editor's
 * name.
 */
export function postBanner(title: string, body: string, sound: boolean, sessionId?: string): void {
  void (async () => {
    try {
      const h = await resolveHelper()
      if (h) {
        await rememberTarget(sessionId)
        await post(h, title, body, sound)
        return
      }
    } catch {
      // Fall through.
    }
    // The fallback banner is posted by Script Editor, not our helper, so a click
    // on it never reaches `focusHost` — no target to record.
    fallbackBanner(title, body, sound)
  })()
}

/**
 * The deep-link parameters to compile into the helper, or undefined when they
 * can't be embedded safely.
 *
 * Unlike the notification text — which reaches the helper through a file
 * precisely so it never touches the script source — these three are structural,
 * so they *are* compiled in. That makes validating them the whole defence: the
 * storage path is ours but ultimately derived from a home directory we don't
 * control, and a quote or backslash in it would break out of the AppleScript
 * string literal. Anything unexpected disables deep links rather than escaping
 * its way in; a click then just focuses the editor, as it did before.
 */
function deepLinkTarget(): DeepLinkTarget | undefined {
  if (!storageDir || !deepLink) {
    return undefined
  }
  const file = path.join(storageDir, TARGET_FILE)
  if (/["\\\n\r]/.test(file)) {
    return undefined
  }
  if (!/^[A-Za-z0-9.+-]+$/.test(deepLink.scheme) || !/^[A-Za-z0-9.-]+$/.test(deepLink.extensionId)) {
    return undefined
  }
  return { file, scheme: deepLink.scheme, extensionId: deepLink.extensionId }
}

/**
 * Record which session the banner about to be posted is about, so a click on it
 * can deep-link back to that row.
 *
 * "The most recent banner" is the best target available, and the limitation is
 * inherent: `display notification` has no per-notification click callback, so
 * the helper only ever learns that *some* banner of its own was clicked, never
 * which. Clicking a stale banner therefore selects the newest session rather
 * than the one on screen — the URI handler drops ids it can't find, so the worst
 * case is landing on the wrong row, never on a resurrected dead one. A summary
 * banner spanning several sessions clears the target and falls back to simply
 * revealing the sidebar.
 */
async function rememberTarget(sessionId: string | undefined): Promise<void> {
  if (!storageDir) {
    return
  }
  // This is interpolated into the helper's `do shell script`. It is quoted there
  // too, but a session id is a uuid and anything else has no business reaching a
  // shell — reject rather than escape.
  const id = sessionId && /^[A-Za-z0-9-]{1,64}$/.test(sessionId) ? sessionId : ''
  try {
    await writeFile(path.join(storageDir, TARGET_FILE), id, 'utf8')
  } catch {
    // A banner that can't record its target still posts; its click just falls
    // back to focusing the editor.
  }
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
  const target = deepLinkTarget()
  const stampPath = path.join(storage, 'notifier.stamp')
  // The deep-link parameters are compiled in, so they belong in the stamp
  // alongside the host: change one and the built helper is out of date.
  const stamp = [
    SCRIPT_REV,
    host.appPath,
    host.bundleId,
    target?.scheme ?? '',
    target?.extensionId ?? '',
    target?.file ?? '',
  ].join('|')

  await mkdir(payloadDir, { recursive: true })

  // A rebuild is only needed when the host editor changes (a different install,
  // or Insiders vs stable) or the helper's script does.
  if (await readFile(stampPath, 'utf8').then((s) => s === stamp, () => false)) {
    return { appPath, payloadDir }
  }

  const source = path.join(storage, 'notifier.applescript')
  await rm(appPath, { recursive: true, force: true })
  await writeFile(source, appleScript(host.bundleId, target), 'utf8')
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
 *
 * `focusHost` prefers a deep link (`<scheme>://<extension id>/session/<id>`) so
 * the click lands on the session the banner was about; that both brings the
 * editor forward and routes into the extension's URI handler. `target` is the
 * file `rememberTarget` writes. When it is missing, empty, or the path could not
 * be embedded safely, it falls back to plain bundle-id focus — the behaviour
 * before deep links existed.
 */
function appleScript(hostBundleId: string, target?: DeepLinkTarget): string {
  const focus = target
    ? `	set sid to ""
	try
		set sid to (read POSIX file "${target.file}" as «class utf8»)
	end try
	try
		if sid is not "" then
			do shell script "/usr/bin/open " & quoted form of ("${target.scheme}://${target.extensionId}/session/" & sid)
		else
			do shell script "/usr/bin/open -b ${hostBundleId}"
		end if
	end try`
    : `	try
		do shell script "/usr/bin/open -b ${hostBundleId}"
	end try`

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
${focus}
end focusHost
`
}
