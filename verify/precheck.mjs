/**
 * Offline precheck for dsh-profile-bridge.
 *
 * It proves three things without touching a real Harness installation:
 *   1. the bundle manifest, patch, locales and icon agree with each other;
 *   2. the Host state module discovers profiles, validates targets and reports
 *      status correctly on a throwaway profiles tree;
 *   3. the generated helper really performs the switch — rename, junction,
 *      patch merge — and really reverts it.
 *
 * The helper runs with `skipAppStop` and `noRelaunch`, so no running application
 * is ever stopped or started by this test.
 *
 * Run: node verify/precheck.mjs
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// ---------------------------------------------------------------- manifest --
assert.equal(pkg.dsh.client.platform, 'web', 'the browser half must declare platform web')
assert.ok(existsSync(join(root, pkg.exports['./client'])), 'the ./client export must exist')
assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)), 'the bundle patch must exist')
assert.ok(existsSync(join(root, pkg.icon)), 'the declared icon must exist')
const patch = readFileSync(join(root, pkg.dsh.bundle.patch), 'utf8')
assert.ok(patch.includes(`name: '${pkg.name}'`), 'the patch must insert the package by its own name')
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')
assert.ok(clientSource.includes(`id: '${pkg.name}'`), 'the browser registration id must equal the package name')
for (const file of ['locale/zh.json', 'locale/en.json']) {
  const dictionary = JSON.parse(readFileSync(join(root, file), 'utf8'))
  assert.equal(typeof dictionary.title, 'string', `${file} needs a title`)
  assert.equal(typeof dictionary.description, 'string', `${file} needs a description`)
}
execFileSync(process.execPath, ['--check', join(root, 'index.js')], { stdio: 'inherit' })
execFileSync(process.execPath, ['--check', join(root, 'client.js')], { stdio: 'inherit' })
console.log('manifest: ok')

// ------------------------------------------------------------- state module --
const sandbox = mkdtempSync(join(tmpdir(), 'profile-bridge-'))
const profilesDir = join(sandbox, 'profiles')
const liveDir = join(profilesDir, 'desktop')
const targetDir = join(profilesDir, 'web')
const altDir = join(profilesDir, 'alt')
for (const dir of [liveDir, targetDir, altDir]) mkdirSync(dir, { recursive: true })
mkdirSync(join(targetDir, 'node_modules'), { recursive: true })
mkdirSync(join(altDir, 'node_modules'), { recursive: true })
const manifest = (name, dependencies, bundles) => JSON.stringify({ name, private: true, dependencies, dsh: { profile: { bundles } } }, null, 2)
writeFileSync(join(liveDir, 'package.json'), manifest('dsh-profile-desktop', {}, ['@deepseek-ai/dsh-base']))
writeFileSync(join(liveDir, 'cordis.patch.yml'), '# fresh desktop patch\n')
writeFileSync(join(targetDir, 'package.json'), manifest('dsh-profile-web', { 'dsh-pocket': '^2.10.6' }, ['@deepseek-ai/dsh-base', 'dsh-pocket']))
writeFileSync(join(targetDir, 'cordis.patch.yml'), '# target patch\n')
writeFileSync(join(altDir, 'package.json'), manifest('dsh-profile-alt', { 'dsh-context': '^0.64.0' }, ['@deepseek-ai/dsh-base', 'dsh-context']))

const { readLinkTarget, resolvePaths, statusPayload, validateTarget } = await import(pathToFileURL(join(root, 'lib/state.mjs')).href)
const env = { DSH_HOME: sandbox, DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: liveDir }
const paths = resolvePaths(env)
assert.equal(paths.home, sandbox)
assert.equal(paths.activeDir, liveDir)
assert.equal(paths.activeName, 'desktop')

const before = statusPayload(paths)
assert.equal(before.appKind, 'desktop', 'a profile directory named desktop is the Desktop app case')
assert.equal(before.activeIsLink, false)
assert.equal(before.profiles.length, 3)
assert.equal(before.profiles.find((profile) => profile.name === 'web').dependencyCount, 1)

assert.equal(validateTarget(paths, 'web').name, 'web')
assert.throws(() => validateTarget(paths, 'desktop'), /already using/)
assert.throws(() => validateTarget(paths, 'missing'), (error) => error.code === 'missing-profile')
assert.throws(() => validateTarget(paths, '../escape'), (error) => error.code === 'bad-target')
console.log('state: ok')

// ------------------------------------------------------------------ helper --
const { renderHelper, writeHelper } = await import(pathToFileURL(join(root, 'lib/helper.mjs')).href)
const stateDir = join(sandbox, 'profile-bridge')
const logPath = join(stateDir, 'last-run.log')
const runHelper = (request) => {
  const rendered = renderHelper({
    profilesRoot: profilesDir,
    liveDir,
    activeName: 'desktop',
    appExe: '',
    logPath,
    stateDir,
    skipAppStop: true,
    noRelaunch: true,
    ...request,
  })
  writeHelper(rendered)
  const isWindows = process.platform === 'win32'
  const script = rendered.scriptPath
  // Behaviour of the generated script, run directly (the wrapper only adds the
  // detached launch and the transcript redirect, which is checked below).
  execFileSync(isWindows ? 'powershell.exe' : '/bin/sh',
    isWindows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] : [script],
    { stdio: 'inherit' })
}

/**
 * Run the real launcher (the cmd wrapper on Windows) from a deliberately hostile
 * working directory — the profile directory itself, which is exactly what the
 * Desktop app hands its Host. The helper must leave that directory before renaming
 * it, or it locks its own target and the switch fails with "still locked".
 */
const runHelperViaLauncher = (request, cwd) => {
  const rendered = renderHelper({
    profilesRoot: profilesDir,
    liveDir,
    activeName: 'desktop',
    appExe: '',
    logPath,
    stateDir,
    skipAppStop: true,
    noRelaunch: true,
    ...request,
  })
  writeHelper(rendered)
  if (process.platform === 'win32') execFileSync('cmd.exe', ['/c', rendered.wrapperPath], { stdio: 'inherit', cwd })
  else execFileSync('/bin/sh', [rendered.scriptPath], { stdio: 'inherit', cwd })
}

// Launcher shape: on Windows the plugin must run the helper through a detached
// `cmd.exe` (a detached powershell.exe never starts here), and the generated
// script must carry a UTF-8 BOM so Windows PowerShell reads non-ASCII paths.
const windowsRender = renderHelper({
  profilesRoot: profilesDir, liveDir, activeName: 'desktop', targetDir, appExe: '',
  logPath, stateDir, stamp: 'shape', platform: 'win32',
})
assert.equal(windowsRender.command, 'cmd.exe', 'the Windows launcher must be cmd.exe')
assert.ok(windowsRender.wrapperPath?.endsWith('run.cmd'), 'the Windows launcher needs a cmd wrapper')
assert.ok(windowsRender.wrapper.includes('-File'), 'the wrapper must run the script with -File')
assert.ok(windowsRender.wrapper.includes('switch.ps1'), 'the wrapper must name the generated script')
assert.ok(windowsRender.wrapper.includes('2>&1'), 'the wrapper must capture PowerShell startup errors')
// The Host runs the Electron binary in Node mode, so a relaunch must not inherit that
// environment: with ELECTRON_RUN_AS_NODE set, starting the app executable produces a
// window-less Node process and the app never comes back.
assert.ok(windowsRender.text.includes('ELECTRON_RUN_AS_NODE'), 'the helper must clear the Node-mode environment before relaunching the app')
assert.ok(windowsRender.text.includes('-UseNewEnvironment'), 'the relaunch must start the app with a fresh environment')
// A Host that cannot bind the port its predecessor served dies during startup, so the
// helper waits for the socket and verifies the relaunch actually came up.
assert.ok(windowsRender.text.includes('Wait-PortFree'), 'the helper must wait for the app port to be released')
assert.ok(windowsRender.text.includes('Test-AppHealthy'), 'the relaunch must check the window and the port, not just a process')
assert.ok(windowsRender.text.includes('did not come up healthy; clearing it'), 'a failed attempt must be cleared before the next one')
assert.ok(windowsRender.text.includes('which is not the app; leaving it alone'), 'the helper must never kill a process that merely holds a port')
assert.equal(renderHelper({
  profilesRoot: profilesDir, liveDir, activeName: 'desktop', targetDir, appExe: '',
  logPath, stateDir, stamp: 'shape', platform: 'linux',
}).command, '/bin/sh', 'POSIX keeps the /bin/sh launcher')
console.log('launcher shape: ok')

// The POSIX template is never executed on Windows, so at least parse it with a real
// shell whenever one is available. A shell that cannot run at all (Windows ships a
// `bash` that is only a WSL relay, for example) means "not checked", not "broken";
// only an actual parse failure fails this suite.
{
  const posix = renderHelper({
    profilesRoot: '/tmp/p/profiles', liveDir: '/tmp/p/profiles/desktop', activeName: 'desktop',
    targetDir: '/tmp/p/profiles/web', appExe: '/Applications/DeepSeek Harness.app',
    logPath: '/tmp/p/profile-bridge/last-run.log', stamp: 'syntax', stateDir: '/tmp/p/profile-bridge',
    platform: 'linux',
  })
  const posixPath = join(sandbox, 'posix-syntax-check.sh')
  writeFileSync(posixPath, posix.text, 'utf8')
  // Git for Windows ships a real bash next to git itself; prefer it over a `bash`
  // that may only be a WSL relay.
  const candidates = []
  try {
    const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
    for (const relative of [['..', '..', '..', 'bin', 'bash.exe'], ['..', '..', 'bin', 'bash.exe'], ['..', '..', 'usr', 'bin', 'bash.exe']]) {
      candidates.push(join(execPath, ...relative))
    }
  } catch { /* git is optional here */ }
  candidates.push('bash', 'sh')
  let checked = false
  let attempted = false
  for (const shell of candidates) {
    try {
      execFileSync(shell, ['-n', posixPath], { stdio: 'pipe' })
      console.log(`posix syntax: ok (${shell})`)
      checked = true
      break
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      attempted = true
      const detail = String(error?.stderr ?? error?.message ?? '')
      if (/syntax error|unexpected (token|EOF)|parse error/iu.test(detail)) {
        console.error(detail.trim())
        throw new Error(`the POSIX helper script does not parse: ${detail.split('\n')[0]}`)
      }
      console.log(`posix syntax: skipped (${shell} unusable: ${detail.trim().split('\n')[0].slice(0, 90)})`)
      break
    }
  }
  if (!checked && !attempted) console.log('posix syntax: skipped (no usable POSIX shell)')
}

if (process.platform === 'win32') {
  // The generated script's own self-test: it opens a listener and checks that the port
  // helpers report it as busy and then free. Without this, "the app could not bind its
  // port" would only ever show up on a real machine.
  const selfTest = renderHelper({
    profilesRoot: profilesDir, liveDir, activeName: 'desktop', targetDir, appExe: '',
    logPath, stateDir, stamp: 'selftest', skipAppStop: true, noRelaunch: true,
  })
  writeHelper(selfTest)
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', selfTest.scriptPath],
    { stdio: 'inherit', env: { ...process.env, PROFILE_BRIDGE_SELFTEST: '1' } })
  assert.ok(readFileSync(logPath, 'utf8').includes('selftest ok'), 'the generated script must pass its own port self-test')
  console.log('helper selftest: ok')

  // link, launched by the real wrapper from inside the profile directory — the
  // hostile working directory that used to make this fail with "still locked".
  runHelperViaLauncher({ mode: 'link', targetDir, stamp: 'precheck1' }, liveDir)
  const written = readFileSync(join(stateDir, 'switch.ps1'))
  assert.deepEqual([...written.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the Windows script must start with a UTF-8 BOM')
  assert.ok(existsSync(`${logPath}.out`), 'the launcher must write its transcript next to the log')
  const transcript = readFileSync(logPath, 'utf8')
  assert.ok(transcript.includes('cwd='), 'the log must record the working directory it started from')
  assert.equal(lstatSync(liveDir).isSymbolicLink(), true, 'the app profile must become a link')
  assert.equal(readLinkTarget(liveDir), resolve(targetDir), 'the link must point at the chosen profile')
  assert.ok(existsSync(join(profilesDir, 'desktop.fresh-precheck1')), 'the previous directory must be kept as a backup')
  assert.ok(existsSync(join(liveDir, 'package.json')), 'the link must expose the target manifest')
  const mergedPatch = readFileSync(join(targetDir, 'cordis.patch.yml'), 'utf8')
  assert.ok(mergedPatch.includes('ui-settings-account'), 'the desktop UI settings must be merged into the target patch')
  assert.ok(existsSync(join(targetDir, 'cordis.patch.yml.bak-precheck1')), 'the merged patch must be backed up')
  const linked = statusPayload(paths)
  assert.equal(linked.activeIsLink, true)
  assert.equal(linked.linkTargetName, 'web')
  assert.equal(linked.profiles.find((profile) => profile.name === 'web').isActive, true, 'the link target must read as active')
  console.log('helper link: ok')

  // re-point an existing link at a different profile
  runHelper({ mode: 'link', targetDir: altDir, stamp: 'precheck2' })
  assert.equal(readLinkTarget(liveDir), resolve(altDir), 're-pointing must replace the link')
  console.log('helper re-point: ok')

  // unlink restores the newest backup
  runHelper({ mode: 'unlink', stamp: 'precheck3' })
  assert.equal(lstatSync(liveDir).isSymbolicLink(), false, 'revert must restore a real directory')
  assert.ok(existsSync(join(liveDir, 'cordis.patch.yml')), 'the restored directory must be the original app profile')
  const log = readFileSync(logPath, 'utf8')
  assert.ok(log.includes('done'), 'the helper must log completion')
  assert.ok(existsSync(join(altDir, 'package.json')), 'revert must not touch the linked profile')
  console.log('helper unlink: ok')
} else {
  console.log('helper: skipped (the end-to-end helper test runs on Windows)')
}

// --------------------------------------------------------- host transport --
const { apply } = await import(pathToFileURL(join(root, 'index.js')).href)
process.env.DSH_HOME = sandbox
process.env.DSH_PROFILE = 'desktop'
process.env.DSH_PROFILE_DIR = liveDir

/** Collect the route the plugin registers when the native channel is unavailable. */
let registeredRoute
const stubCtx = (connection) => ({
  connection,
  webServer: { register: (route) => { registeredRoute = route; return () => {} } },
  effect: (callback) => { callback(); return () => {} },
  logger: { debug() {}, warn() {}, error() {} },
})

/** Drive the registered route with a fake request/response pair. */
async function request(route, { method = 'POST', url = '/profile-bridge/status', host = '127.0.0.1:19387', body } = {}) {
  const response = { status: 0, headers: null, payload: '', writeHead(status, headers) { this.status = status; this.headers = headers; return this }, end(chunk) { if (chunk !== undefined) this.payload = String(chunk); return this }, destroy() {} }
  await route.handler({ method, url, headers: { host }, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body, 'utf8') } }, response)
  let parsed
  try { parsed = JSON.parse(response.payload) } catch { parsed = response.payload }
  return { status: response.status, body: parsed }
}
const envelope = (method, payload) => JSON.stringify({ type: 'client-request', rpcId: 'check-1', method, payload })

// native channel available: no Web route is registered
let nativeHandler
apply(stubCtx({ rpc: { handle: (channel, handler) => { nativeHandler = handler; assert.equal(channel, '/profile-bridge'); return async () => {} } } }))
assert.equal(typeof nativeHandler, 'function', 'the native channel must receive the handler')
assert.equal(registeredRoute, undefined, 'no fallback route may be registered when the native channel works')
const nativeStatus = await nativeHandler('status', {})
assert.equal(nativeStatus.ok, true)
assert.equal(nativeStatus.value.activeName, 'desktop')
console.log('transport native: ok')

// native channel unavailable: the plugin serves the same envelope itself
registeredRoute = undefined
apply(stubCtx({ requestRejection: () => undefined }))
assert.equal(registeredRoute?.path, '/profile-bridge', 'the fallback route must own the channel prefix')

const statusResponse = await request(registeredRoute, { body: envelope('status', {}) })
assert.equal(statusResponse.status, 200)
assert.equal(statusResponse.body.type, 'server-response')
assert.equal(statusResponse.body.rpcId, 'check-1')
assert.equal(statusResponse.body.result.ok, true)
assert.equal(statusResponse.body.result.value.activeName, 'desktop')
assert.equal(statusResponse.body.result.value.appKind, 'desktop')
assert.equal(statusResponse.body.result.value.profiles.length, 3)

assert.equal((await request(registeredRoute, { method: 'GET' })).status, 405, 'GET must be refused')
assert.equal((await request(registeredRoute, { body: envelope('unlink', {}) })).status, 400, 'a mismatched envelope must be refused')
const notFound = await request(registeredRoute, { url: '/profile-bridge/nope', body: envelope('nope', {}) })
assert.equal(notFound.body.result.ok, false)
assert.equal(notFound.body.result.error.code, 'not-found')
// Remove the helper the earlier helper test wrote, so a refused request cannot hide behind it.
rmSync(join(stateDir, 'switch.ps1'), { force: true })
const guard = await request(registeredRoute, { url: '/profile-bridge/link', body: envelope('link', { target: 'desktop' }) })
assert.equal(guard.body.result.ok, false, 'switching to the app profile must be refused')
assert.equal(guard.body.result.error.code, 'bad-target')
assert.equal(existsSync(join(stateDir, 'switch.ps1')), false, 'a refused request must not write a helper')
const missing = await request(registeredRoute, { url: '/profile-bridge/link', body: envelope('link', { target: 'nope' }) })
assert.equal(missing.body.result.error.code, 'missing-profile')
console.log('transport fallback: ok')

// without the Connection service the local loopback rule must hold
registeredRoute = undefined
apply(stubCtx({}))
assert.equal((await request(registeredRoute, { host: '192.168.1.16:3081', body: envelope('status', {}) })).status, 403)
assert.equal((await request(registeredRoute, { host: '127.0.0.1:19387', body: envelope('status', {}) })).status, 200)
console.log('transport loopback fence: ok')

rmSync(sandbox, { recursive: true, force: true })
console.log('\nprecheck ok: manifest, state, helper behaviour and host transport verified')
