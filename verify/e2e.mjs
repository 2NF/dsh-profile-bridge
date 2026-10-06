#!/usr/bin/env node
/**
 * Real end-to-end switch on a live machine.
 *
 * `verify/precheck.mjs` proves the logic in a throwaway sandbox, but several bugs so
 * far only appeared on a real machine (a detached PowerShell that never starts, the
 * profile directory locking itself, the Node-mode environment, a port still held by
 * the previous Host). This script runs exactly the production path — render, write,
 * launch detached — against the real profiles, which means **it closes and relaunches
 * the Desktop app**.
 *
 *   node verify/e2e.mjs unlink --yes        # link  -> standalone profile
 *   node verify/e2e.mjs link web --yes      # standalone -> profile "web"
 *
 * Without `--yes` it only prints the plan and exits.
 */
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolvePath(fileURLToPath(new URL('..', import.meta.url)))
const { resolvePaths, statusPayload } = await import(pathToFileURL(join(root, 'lib/state.mjs')).href)
const { renderHelper, writeHelper, launchHelper } = await import(pathToFileURL(join(root, 'lib/helper.mjs')).href)

const args = process.argv.slice(2)
const mode = args[0]
const targetName = args[1] !== undefined && !args[1].startsWith('--') ? args[1] : undefined
const confirmed = args.includes('--yes')

if (mode !== 'link' && mode !== 'unlink') {
  console.error('usage: node verify/e2e.mjs <link|unlink> [target profile] [--yes]')
  process.exit(2)
}
if (mode === 'link' && targetName === undefined) {
  console.error('link needs a target profile name, for example: node verify/e2e.mjs link web --yes')
  process.exit(2)
}

const paths = resolvePaths()
const status = statusPayload(paths)
const targetDir = targetName === undefined ? undefined : join(paths.profilesDir, targetName)
const logPath = join(paths.stateDir, 'last-run.log')
const now = new Date()
const pad = (value) => String(value).padStart(2, '0')
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

const plan = {
  mode,
  target: targetName ?? null,
  targetDir: targetDir ?? null,
  liveDir: paths.activeDir,
  activeIsLink: status.activeIsLink,
  linkTarget: status.linkTarget ?? null,
  appExe: status.appExe,
  appRunning: status.appRunning ?? null,
  helper: join(paths.stateDir, process.platform === 'win32' ? 'switch.ps1' : 'switch.sh'),
  launcher: join(paths.stateDir, process.platform === 'win32' ? 'run.cmd' : 'switch.sh'),
  log: logPath,
  transcript: `${logPath}.out`,
}
console.log(JSON.stringify(plan, null, 2))

if (!confirmed) {
  console.log('\nadd --yes to really stop the app, switch the profile and relaunch it')
  process.exit(0)
}

const rendered = renderHelper({
  mode,
  profilesRoot: paths.profilesDir,
  liveDir: paths.activeDir,
  activeName: paths.activeName,
  targetDir,
  appExe: status.appExe,
  logPath,
  stamp,
  stateDir: paths.stateDir,
})
writeHelper(rendered)
const pid = launchHelper(rendered)
console.log(`helper launched (pid ${pid ?? 'unknown'}) — the app is about to close and come back`)
