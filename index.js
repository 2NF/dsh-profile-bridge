/**
 * dsh-profile-bridge — Host half.
 *
 * The DeepSeek Harness Desktop app resolves its profile directory as
 * `<DSH_HOME>/profiles/desktop` and provides no way to choose another one, so every
 * plugin installed in a `dsh web` profile (or any other profile) is invisible to it.
 * This plugin exposes that fact as a settings page and performs the one operation
 * that fixes it: pointing the app's profile directory at the profile you already
 * use, through a directory link, with a reversible backup.
 *
 * The switch cannot run inside this process because the app holds its own profile
 * directory; the plugin renders a helper script, starts it detached, and the script
 * completes the switch after the app exits and then relaunches it.
 *
 * The browser half talks to this half over the Harness RPC envelope
 * (`client-request` / `server-response`) on the `/profile-bridge` channel. The
 * official `connection.rpc.handle()` is used when it works; on Harness versions
 * where that call cannot reach the transport it throws, and the plugin serves the
 * same protocol from its own Web route instead.
 *
 * @module dsh-profile-bridge
 */
import { basename } from 'node:path'
import { launchHelper, renderHelper, writeHelper } from './lib/helper.mjs'
import { fail, resolvePaths, statusPayload, validateTarget } from './lib/state.mjs'

/** Shared RPC channel owned by this plugin; the browser half calls it by name. */
const CHANNEL = '/profile-bridge'

/** Control requests are tiny; anything larger is refused instead of buffered. */
const BODY_LIMIT_BYTES = 64 * 1024

/** Host services this plugin needs. */
export const inject = ['connection', 'webServer']

/**
 * Format a local timestamp for backup directory names.
 * @returns {string} `yyyyMMdd-HHmmss`.
 */
function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Prepare and launch one switch operation.
 * @param {'link' | 'unlink'} mode - operation to perform.
 * @param {ReturnType<typeof resolvePaths>} paths - resolved plugin paths.
 * @param {unknown} payload - browser request payload.
 * @returns {object} JSON-safe receipt for the UI.
 */
function runSwitch(mode, paths, payload) {
  const request = typeof payload === 'object' && payload !== null ? payload : {}
  if (mode === 'link' && basename(paths.activeDir) !== 'desktop') {
    fail(
      'not-desktop',
      `This Harness is running profile "${paths.activeName}" (${paths.activeDir}), which you already chose by hand. `
      + 'The profile link exists only for the Desktop app, which hardcodes profiles/desktop; start the app, or run `dsh --profile <name>` instead.',
    )
  }
  const target = mode === 'link' ? validateTarget(paths, request.target) : undefined
  const appExe = statusPayload(paths).appExe
  const logPath = `${paths.stateDir}/last-run.log`
  const rendered = renderHelper({
    mode,
    profilesRoot: paths.profilesDir,
    liveDir: paths.activeDir,
    activeName: paths.activeName,
    targetDir: target?.dir,
    appExe,
    logPath,
    stamp: stamp(),
    stateDir: paths.stateDir,
    skipAppStop: request.skipAppStop === true,
    noRelaunch: request.noRelaunch === true,
  })
  writeHelper(rendered)
  const pid = launchHelper(rendered)
  return {
    mode,
    target: target?.name,
    warnings: target?.warnings ?? [],
    helperPath: rendered.scriptPath,
    launcherPath: rendered.wrapperPath,
    transcriptPath: `${logPath}.out`,
    logPath,
    appExe,
    pid,
    closesApp: request.skipAppStop !== true,
    note: request.skipAppStop === true
      ? 'Helper started without stopping the app (test mode).'
      : 'The app closes by itself in a moment and reopens with the chosen profile.',
  }
}

/**
 * Route one decoded endpoint call.
 * @param {string} endpoint - endpoint name on this channel.
 * @param {unknown} payload - decoded request payload.
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: object }>} RPC result.
 */
async function handleCall(endpoint, payload) {
  try {
    if (endpoint === 'status') return { ok: true, value: statusPayload(resolvePaths()) }
    if (endpoint === 'link') return { ok: true, value: runSwitch('link', resolvePaths(), payload) }
    if (endpoint === 'unlink') return { ok: true, value: runSwitch('unlink', resolvePaths(), payload) }
    fail('not-found', `Unknown endpoint ${JSON.stringify(endpoint)}.`)
  } catch (error) {
    return {
      ok: false,
      error: {
        code: typeof error?.code === 'string' ? error.code : 'bridge-error',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Decide whether one request may reach this channel.
 *
 * The Harness Connection service owns the browser-trust fence (loopback or a
 * configured trusted host, plus the signed session cookie). Where that service is
 * not reachable from this plugin's context, an equivalent loopback-only rule keeps
 * profile surgery a local operation.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {401 | 403 | undefined} rejection status, or undefined to proceed.
 */
function rejectRequest(ctx, req) {
  try {
    const rejection = ctx.connection?.requestRejection?.({ headers: req.headers })
    if (rejection !== undefined) return rejection
    if (typeof ctx.connection?.requestRejection === 'function') return undefined
  } catch {
    /* fall through to the local rule */
  }
  const host = String(req.headers.host ?? '').replace(/:\d+$/u, '').replace(/^\[|\]$/gu, '')
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' ? undefined : 403
}

/**
 * Read a bounded JSON body.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {Promise<unknown>} parsed body.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) fail('payload-too-large', 'Request body is too large for this channel.')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    fail('bad-request', 'Request body must be JSON.')
  }
}

/**
 * Answer one request with a `server-response` envelope.
 * @param {import('node:http').ServerResponse} res - response owner.
 * @param {number} status - HTTP status.
 * @param {object} body - envelope to send.
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Install the `/profile-bridge` channel for as long as this plugin is loaded.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context carrying `connection` and `webServer`.
 */
export function apply(ctx) {
  // Preferred: the Connection service's own channel registry (it also applies the
  // browser-trust fence and session authentication).
  try {
    const disposer = ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload) => handleCall(endpoint, payload))
    ctx.effect(() => disposer, 'profile-bridge: shared rpc channel')
    return
  } catch (error) {
    ctx.logger?.debug?.(`profile-bridge: connection.rpc.handle unavailable (${String(error?.message ?? error)}); serving the channel directly`)
  }

  // Fallback: the same envelope on our own Web route, guarded by the same fence.
  const route = {
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      try {
        const rejection = rejectRequest(ctx, req)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed')
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
        const endpoint = decodeURIComponent(pathname.slice(CHANNEL.length).replace(/^\/+/u, ''))
        const message = await readJsonBody(req)
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
        if (message?.type !== 'client-request' || typeof message.method !== 'string' || message.method !== endpoint) {
          sendJson(res, 400, {
            type: 'server-response',
            rpcId,
            result: { ok: false, error: { code: 'bad-request', message: 'the client-request envelope must name this endpoint' } },
          })
          return
        }
        sendJson(res, 200, { type: 'server-response', rpcId, result: await handleCall(endpoint, message.payload) })
      } catch (error) {
        ctx.logger?.warn?.(`profile-bridge: ${String(error?.message ?? error)}`)
        if (!res.headersSent) {
          sendJson(res, 500, {
            type: 'server-response',
            rpcId: 'invalid-request',
            result: { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } },
          })
        } else {
          res.destroy()
        }
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'profile-bridge: rpc route')
}
