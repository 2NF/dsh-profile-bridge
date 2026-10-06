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
 * @param {string} [request.appExe] - executable used to relaunch the app.
 * @param {string} request.logPath - log file the helper appends to.
 * @param {string} request.stamp - timestamp used for backups.
 * @param {boolean} [request.skipAppStop] - test hook: do not touch the app.
 * @param {boolean} [request.noRelaunch] - test hook: do not relaunch the app.
 * @param {NodeJS.Platform} [request.platform] - target platform (defaults to the host).
 * @returns {{ path: string, text: string, command: string, args: string[] }} rendered helper and its launcher.
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
    __APPEXE__: request.appExe ?? '',
    __APPNAME__: appProcessName(request.appExe),
    __LOG__: request.logPath,
    __STAMP__: request.stamp,
    __SKIPAPPSTOP__: platform === 'win32' ? (request.skipAppStop === true ? '$true' : '$false') : request.skipAppStop === true ? 'true' : 'false',
    __NORELAUNCH__: platform === 'win32' ? (request.noRelaunch === true ? '$true' : '$false') : request.noRelaunch === true ? 'true' : 'false',
    __GRACE__: platform === 'win32' ? String(GRACE_MS) : String(GRACE_SECONDS),
  }
  let text = readFileSync(templatePath, 'utf8')
  for (const [token, value] of Object.entries(replacements)) {
    if (token === '__SKIPAPPSTOP__' || token === '__NORELAUNCH__' || token === '__GRACE__' || token === '__MODE__') {
      text = text.replaceAll(token, value)
      continue
    }
    text = text.replaceAll(token, quoteValue(value, platform))
  }
  const path = platform === 'win32' ? join(request.stateDir, 'switch.ps1') : join(request.stateDir, 'switch.sh')
  const command = platform === 'win32' ? 'powershell.exe' : '/bin/sh'
  const args = platform === 'win32'
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path]
    : [path]
  return { path, text, command, args }
}

/**
 * Write the rendered helper to disk.
 * @param {{ path: string, text: string }} helper - rendered helper.
 * @returns {string} the written path.
 */
export function writeHelper(helper) {
  mkdirSync(dirname(helper.path), { recursive: true })
  writeFileSync(helper.path, helper.text, 'utf8')
  if (process.platform !== 'win32') chmodSync(helper.path, 0o755)
  return helper.path
}

/**
 * Start the helper in its own process so it outlives the app it is about to stop.
 * @param {{ command: string, args: string[] }} helper - rendered helper launcher.
 * @returns {number | undefined} the child pid when the platform reports one.
 */
export function launchHelper(helper) {
  const child = spawn(helper.command, helper.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return child.pid
}
