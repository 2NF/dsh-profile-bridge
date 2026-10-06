/**
 * Helper-script generation and detached launch.
 *
 * The app locks its own profile directory, so the switch cannot happen inside the
 * Harness process. The plugin therefore renders a small platform script, starts it
 * detached, and the script performs the surgery once the app has exited — including
 * the relaunch, so a user only clicks once.
 *
 * @module dsh-profile-bridge/helper
 */
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WINDOWS_TEMPLATE = fileURLToPath(new URL('./switch.windows.ps1.txt', import.meta.url))
const POSIX_TEMPLATE = fileURLToPath(new URL('./switch.posix.sh.txt', import.meta.url))

/** Milliseconds the Windows helper waits before stopping the app. */
export const GRACE_MS = 1500
/** Seconds the POSIX helper waits before stopping the app. */
export const GRACE_SECONDS = 2

/**
 * Quote one value for a single-quoted script literal.
 * @param {string} value - raw value.
 * @param {NodeJS.Platform} platform - target platform.
 * @returns {string} quoted value without the surrounding quotes.
 */
function quoteValue(value, platform) {
  const text = String(value)
  return platform === 'win32' ? text.replaceAll("'", "''") : text.replaceAll("'", "'\\''")
}

/**
 * Best-effort process name for the app, used to wait for it and to stop it.
 * @param {string | undefined} appExe - detected executable path.
 * @returns {string} process name pattern.
 */
export function appProcessName(appExe) {
  if (typeof appExe === 'string' && appExe !== '') {
    const name = basename(appExe).replace(/\.(exe|app)$/iu, '')
    if (name !== '') return name
  }
  return 'DeepSeek Harness'
}

/**
 * Render the helper script for one operation.
 * @param {object} request - operation facts.
 * @param {'link' | 'unlink'} request.mode - operation to perform.
 * @param {string} request.profilesRoot - `<DSH_HOME>/profiles`.
 * @param {string} request.liveDir - the app's profile directory.
 * @param {string} request.activeName - the app profile's directory name.
 * @param {string} [request.targetDir] - link target (required for `link`).
 * @param {string} [request.appExe] - the app executable, used to derive the process name.
 * @param {string} request.logPath - log file the helper appends to.
 * @param {string} request.stamp - timestamp used for backups.
 * @param {boolean} [request.skipAppStop] - test hook: do not touch the app.
 * @param {NodeJS.Platform} [request.platform] - target platform (defaults to the host).
 * @returns {{ scriptPath: string, wrapperPath?: string, text: string, wrapper?: string, command: string, args: string[] }} rendered helper and its launcher.
 */
export function renderHelper(request) {
  const platform = request.platform ?? process.platform
  const templatePath = platform === 'win32' ? WINDOWS_TEMPLATE : POSIX_TEMPLATE
  const replacements = {
    __MODE__: request.mode,
    __PROFILES__: request.profilesRoot,
    __LIVE__: request.liveDir,
    __TARGET__: request.targetDir ?? '',
    __ACTIVENAME__: request.activeName,
    __APPNAME__: appProcessName(request.appExe),
    __LOG__: request.logPath,
    __STAMP__: request.stamp,
    __SKIPAPPSTOP__: platform === 'win32' ? (request.skipAppStop === true ? '$true' : '$false') : request.skipAppStop === true ? 'true' : 'false',
    __GRACE__: platform === 'win32' ? String(GRACE_MS) : String(GRACE_SECONDS),
  }
  let text = readFileSync(templatePath, 'utf8')
  for (const [token, value] of Object.entries(replacements)) {
    if (token === '__SKIPAPPSTOP__' || token === '__GRACE__' || token === '__MODE__') {
      text = text.replaceAll(token, value)
      continue
    }
    text = text.replaceAll(token, quoteValue(value, platform))
  }

  if (platform !== 'win32') {
    return {
      scriptPath: join(request.stateDir, 'switch.sh'),
      text,
      command: '/bin/sh',
      args: [join(request.stateDir, 'switch.sh')],
    }
  }

  // Windows: the plugin launches `cmd.exe` (detached), which in turn runs
  // PowerShell with its output redirected.
  //
  // Three measurements shape this. First, `spawn('powershell.exe', …, { detached: true })`
  // can silently never start on Windows — the process appears, does nothing and
  // writes no log — while a detached `cmd.exe` starts reliably and survives its
  // parent's death. Second, a detached console-less PowerShell needs its streams
  // redirected to a file, which the wrapper below does; that file is also where a
  // PowerShell startup or parse failure shows up. Third, the Desktop app starts its
  // Host with `cwd` set to the profile directory, so a launched helper inherits that
  // working directory and then blocks renaming it — the wrapper leaves it first.
  const scriptPath = join(request.stateDir, 'switch.ps1')
  const wrapperPath = join(request.stateDir, 'run.cmd')
  const transcriptPath = `${request.logPath}.out`
  const wrapper = [
    '@echo off',
    'cd /d "%~dp0"',
    `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" > "${transcriptPath}" 2>&1`,
    '',
  ].join('\r\n')
  return { scriptPath, wrapperPath, text, wrapper, command: 'cmd.exe', args: ['/c', wrapperPath] }
}

/**
 * Write the rendered helper to disk.
 *
 * The Windows script is written with a UTF-8 BOM: `powershell.exe` (5.1) reads a
 * BOM-less file as ANSI, which mangles any non-ASCII path a profile may contain.
 * @param {ReturnType<typeof renderHelper>} helper - rendered helper.
 * @returns {string} the written script path.
 */
export function writeHelper(helper) {
  mkdirSync(dirname(helper.scriptPath), { recursive: true })
  const windows = helper.wrapper !== undefined
  writeFileSync(helper.scriptPath, windows ? `\uFEFF${helper.text}` : helper.text, 'utf8')
  if (helper.wrapper !== undefined && helper.wrapperPath !== undefined) {
    writeFileSync(helper.wrapperPath, helper.wrapper, 'utf8')
  }
  if (!windows) chmodSync(helper.scriptPath, 0o755)
  return helper.scriptPath
}

/**
 * Start the helper in its own process so it outlives the app it is about to stop.
 *
 * `cwd` is set to the helper's own directory on purpose: the Desktop app starts its
 * Host with the profile directory as its working directory, and a helper that
 * inherited it would hold a handle on the very directory it has to rename.
 * @param {{ command: string, args: string[], scriptPath: string }} helper - rendered helper launcher.
 * @returns {number | undefined} the child pid when the platform reports one.
 */
export function launchHelper(helper) {
  const child = spawn(helper.command, helper.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: dirname(helper.scriptPath),
  })
  // A failed launch must never take the Host down; the transcript file is where
  // the reason shows up.
  child.on('error', () => {})
  child.unref()
  return child.pid
}
