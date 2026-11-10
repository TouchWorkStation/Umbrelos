// UmbrelOS Touch server: a same-origin backend for the PWA.
//
// Why it exists: umbreld's browser login binds its token to an HttpOnly cookie on
// umbreld's own origin and sends no CORS headers, so a separately hosted page
// cannot call it from the browser. umbreld's *native* login (user.loginNative,
// the path Umbrel's own iOS/macOS apps use) returns bearer credentials instead.
// This server performs that login, keeps the credentials server-side, refreshes
// the 1-hour access token, and forwards only an explicit allowlist of calls.
// The phone only ever holds an opaque HttpOnly cookie for this server.

import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {join} from 'node:path'
import express from 'express'
import WebSocket, {WebSocketServer} from 'ws'

import {createUmbrelClient, UmbrelError} from './umbrel.mjs'
import {newSessionId} from './store.mjs'

export const VERSION = '0.3.0'
const COOKIE = 'umbrel_touch_sid'
const SESSION_MAX_AGE_S = 60 * 60 * 24 * 365
const REFRESH_MARGIN_MS = 2 * 60 * 1000

// Every umbreld procedure the UI may reach, with its tRPC kind. Anything else
// (factory reset, password changes, repositories, network config…) is refused.
export const ALLOWED = {
	'system.version': 'query',
	'system.status': 'query',
	'system.uptime': 'query',
	'system.deviceName': 'query',
	'system.cpuTemperature': 'query',
	'system.cpuUsage': 'query',
	'system.memoryUsage': 'query',
	'system.diskUsage': 'query',
	'system.getIpAddresses': 'query',
	'system.checkUpdate': 'query',
	'user.get': 'query',
	'apps.list': 'query',
	'apps.state': 'query',
	'apps.details': 'query',
	'apps.updates': 'query',
	'apps.recentlyOpened': 'query',
	'apps.logs': 'query',
	'apps.installReview': 'query',
	'appStore.registry': 'query',
	'machines.list': 'query',
	'notifications.get': 'query',
	'apps.start': 'mutation',
	'apps.stop': 'mutation',
	'apps.restart': 'mutation',
	'apps.update': 'mutation',
	'apps.install': 'mutation',
	'apps.uninstall': 'mutation',
	'apps.trackOpen': 'mutation',
	'machines.start': 'mutation',
	'machines.stop': 'mutation',
	'machines.restart': 'mutation',
	'machines.forceStop': 'mutation',
	'notifications.clear': 'mutation',
	'system.restart': 'mutation',
	'system.shutdown': 'mutation',
}

// Long-running mutations: umbreld answers when the operation finishes.
const SLOW = new Set(['apps.install', 'apps.update', 'apps.uninstall', 'appStore.registry', 'apps.logs'])

function parseCookies(header = '') {
	const out = {}
	for (const part of header.split(';')) {
		const i = part.indexOf('=')
		if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
	}
	return out
}

function nativeClientFor(userAgent = '') {
	const ua = userAgent.toLowerCase()
	const deviceClass = /ipad|tablet/.test(ua) ? 'tablet' : /iphone|android|mobile/.test(ua) ? 'phone' : 'desktop'
	const platform = /iphone|ipad|ios/.test(ua)
		? 'ios'
		: /android/.test(ua)
			? 'android'
			: /windows/.test(ua)
				? 'windows'
				: /mac os/.test(ua)
					? 'macos'
					: 'web'
	return {id: 'umbrel-touch', platform, deviceClass, appVersion: VERSION, appBuild: '1', osVersion: 'web'}
}

// umbreld returns {id, brandColorHsl} (e.g. "259 100% 59%"); pass through only safe values.
export function wallpaperOf(w) {
	if (!w || typeof w !== 'object') return null
	const id = /^\d{1,3}$/.test(String(w.id)) ? String(w.id) : null
	const brand = /^\d{1,3}(\.\d+)? \d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/.test(String(w.brandColorHsl)) ? String(w.brandColorHsl) : null
	return id ? {id, brandColorHsl: brand} : null
}

const isLoopback = (hostname) => hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname)

export function normalizeUmbrelUrl(input) {
	let value = String(input ?? '').trim()
	if (!value) throw new Error('Enter your Umbrel’s address')
	if (!/^https?:\/\//i.test(value)) value = `http://${value}`
	const url = new URL(value)
	if (url.username || url.password) throw new Error('The address must not contain a username or password')
	return `${url.protocol}//${url.host}`
}

export function createApp({store, staticDir, fetchImpl = fetch, secureCookies = false}) {
	const app = express()
	app.disable('x-powered-by')
	app.set('trust proxy', 'loopback')

	let client = null
	const getClient = () => {
		const {umbrelUrl} = store.getConfig()
		if (!umbrelUrl) return null
		if (!client || client.baseUrl !== umbrelUrl) client = createUmbrelClient({baseUrl: umbrelUrl, fetchImpl})
		return client
	}

	app.use((req, res, next) => {
		res.set({
			'Content-Security-Policy':
				"default-src 'self'; img-src * data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
		})
		next()
	})

	const api = express.Router()
	api.use(express.json({limit: '64kb'}))
	api.use((req, res, next) => {
		res.set('Cache-Control', 'no-store')
		req.sid = parseCookies(req.headers.cookie)[COOKIE]
		// CSRF: state-changing calls must come from our own page.
		if (req.method !== 'GET') {
			const origin = req.headers.origin
			if (req.headers['x-umbrel-touch'] !== '1' || (origin && new URL(origin).host !== req.headers.host)) {
				return res.status(403).json({error: {code: 'FORBIDDEN', message: 'Cross-site request refused'}})
			}
		}
		next()
	})

	const sendError = (res, error) => {
		if (error instanceof UmbrelError) {
			return res.status(error.status >= 400 ? error.status : 502).json({error: {code: error.code, message: error.message}})
		}
		console.error('[umbrel-touch]', error)
		return res.status(500).json({error: {code: 'INTERNAL', message: 'Something went wrong in UmbrelOS Touch'}})
	}

	const setCookie = (res, value, maxAge) =>
		res.append(
			'Set-Cookie',
			`${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`,
		)

	// ---- Credentials -------------------------------------------------------
	const refreshing = new Map()
	async function accessTokenFor(sid, session, {force = false} = {}) {
		if (session.mode === 'legacy') return session.accessToken
		if (!force && session.accessExpiresAt - Date.now() > REFRESH_MARGIN_MS) return session.accessToken
		if (!refreshing.has(sid)) {
			const run = (async () => {
				const result = await getClient().mutation('user.refreshNativeAccess', {
					deviceToken: session.deviceToken,
					client: session.client,
				})
				await store.updateSession(sid, {
					accessToken: result.accessToken,
					accessExpiresAt: result.accessExpiresAt,
					lastSeenAt: Date.now(),
				})
				return result.accessToken
			})().finally(() => refreshing.delete(sid))
			refreshing.set(sid, run)
		}
		return refreshing.get(sid)
	}

	async function authedCall(req, path, kind, input) {
		const umbrel = getClient()
		if (!umbrel) throw new UmbrelError('UmbrelOS Touch is not connected to an Umbrel yet', {code: 'NOT_CONFIGURED', status: 409})
		const session = store.getSession(req.sid)
		if (!session) throw new UmbrelError('Signed out', {code: 'UNAUTHORIZED', status: 401})
		const timeout = SLOW.has(path) ? 30 * 60 * 1000 : 20_000
		const run = async (token) =>
			kind === 'mutation' ? umbrel.mutation(path, input, {token, timeout}) : umbrel.query(path, input, {token, timeout})
		try {
			return await run(await accessTokenFor(req.sid, session))
		} catch (error) {
			if (!(error instanceof UmbrelError) || error.code !== 'UNAUTHORIZED') throw error
			if (session.mode === 'legacy') {
				await store.deleteSession(req.sid)
				throw error
			}
			// The access token may have been revoked or expired early: refresh once and retry.
			let token
			try {
				token = await accessTokenFor(req.sid, store.getSession(req.sid) ?? session, {force: true})
			} catch (refreshError) {
				if (refreshError instanceof UmbrelError && refreshError.code === 'UNAUTHORIZED') {
					await store.deleteSession(req.sid) // session revoked in umbrelOS Settings
				}
				throw refreshError
			}
			return run(token)
		}
	}

	// ---- Bootstrap / setup ---------------------------------------------------
	api.get('/bootstrap', async (req, res) => {
		const umbrel = getClient()
		const session = store.getSession(req.sid)
		const out = {
			touch: {version: VERSION},
			configured: !!umbrel,
			umbrel: null,
			accounts: [],
			session: session ? {accountId: session.accountId, mode: session.mode, console: !!session.console} : null,
		}
		if (!umbrel) return res.json(out)
		// When Touch runs on the Umbrel itself it talks to 127.0.0.1; the phone must
		// use the address it reached us on instead.
		const upstream = new URL(umbrel.baseUrl)
		const local = isLoopback(upstream.hostname)
		const host = local ? req.hostname : upstream.hostname
		const publicUrl = local ? `http://${req.hostname}` : umbrel.baseUrl
		try {
			const [version, discovery, accounts] = await Promise.all([
				umbrel.query('system.version'),
				umbrel.query('system.discoveryInfo').catch(() => null),
				umbrel.query('user.listAccounts').catch(() => []),
			])
			out.umbrel = {
				url: publicUrl,
				host,
				reachable: true,
				version: version?.version,
				name: version?.name,
				device: discovery?.device ?? null,
				onboarded: discovery?.onboarded ?? true,
			}
			out.accounts = (accounts ?? []).map((a) => ({
				userId: a.userId,
				name: a.name,
				avatar: a.avatarUrl?.startsWith('/api/accounts/') ? `/api/umbrel-avatar?path=${encodeURIComponent(a.avatarUrl)}` : null,
				wallpaper: wallpaperOf(a.wallpaper),
			}))
		} catch (error) {
			out.umbrel = {url: publicUrl, host, reachable: false, error: error.message}
		}
		res.json(out)
	})

	api.post('/setup', async (req, res) => {
		const configured = !!store.getConfig().umbrelUrl
		// Repointing an already-configured server needs a signed-in session, so nobody
		// on the network can aim it at a look-alike to collect passwords.
		if (configured && !store.getSession(req.sid)) {
			return res.status(403).json({error: {code: 'FORBIDDEN', message: 'Sign in first to change the Umbrel address'}})
		}
		let url
		try {
			url = normalizeUmbrelUrl(req.body?.url)
		} catch (error) {
			return res.status(400).json({error: {code: 'BAD_REQUEST', message: error.message}})
		}
		try {
			const probe = createUmbrelClient({baseUrl: url, fetchImpl, timeoutMs: 8000})
			const version = await probe.query('system.version')
			if (!version?.version) throw new UmbrelError('That address answered, but not like umbrelOS', {status: 502})
			if (configured && url !== store.getConfig().umbrelUrl) await store.clearSessions()
			await store.setConfig({umbrelUrl: url})
			res.json({ok: true, url, version: version.version, name: version.name})
		} catch (error) {
			sendError(res, error)
		}
	})

	// The account's own umbrelOS wallpaper, served from the user's Umbrel. umbrelOS
	// ships an AVIF and a JPEG of each; the id is validated so only those can be read.
	api.get('/umbrel-wallpaper/:id', async (req, res) => {
		const umbrel = getClient()
		const id = req.params.id
		if (!umbrel || !/^\d{1,3}$/.test(id)) return res.status(404).end()
		for (const [path, type] of [
			[`/assets/wallpapers/generated-avif/medium/${id}.avif`, 'image/avif'],
			[`/assets/wallpapers/${id}.jpg`, 'image/jpeg'],
		]) {
			try {
				const upstream = await fetchImpl(`${umbrel.baseUrl}${path}`, {signal: AbortSignal.timeout(10_000)})
				if (!upstream.ok || !(upstream.headers.get('content-type') ?? '').startsWith('image/')) continue
				res.set({'Content-Type': type, 'Cache-Control': 'public, max-age=604800, immutable'})
				return res.send(Buffer.from(await upstream.arrayBuffer()))
			} catch {
				/* try the next format */
			}
		}
		res.status(404).end()
	})

	api.get('/umbrel-avatar', async (req, res) => {
		const umbrel = getClient()
		const path = String(req.query.path ?? '')
		if (!umbrel || !/^\/api\/accounts\/[\w.\-/]+$/.test(path) || path.includes('..')) return res.status(404).end()
		try {
			const upstream = await fetchImpl(`${umbrel.baseUrl}${path}`, {signal: AbortSignal.timeout(8000)})
			if (!upstream.ok) return res.status(404).end()
			const type = upstream.headers.get('content-type') ?? ''
			if (!type.startsWith('image/')) return res.status(404).end()
			res.set({'Content-Type': type, 'Cache-Control': 'private, max-age=86400'})
			res.send(Buffer.from(await upstream.arrayBuffer()))
		} catch {
			res.status(404).end()
		}
	})

	// ---- Auth ----------------------------------------------------------------
	const attempts = new Map()
	api.post('/auth/login', async (req, res) => {
		const umbrel = getClient()
		if (!umbrel) return res.status(409).json({error: {code: 'NOT_CONFIGURED', message: 'Connect to your Umbrel first'}})
		const ip = req.ip ?? 'unknown'
		const now = Date.now()
		const recent = (attempts.get(ip) ?? []).filter((t) => now - t < 5 * 60 * 1000)
		if (recent.length >= 10) {
			return res.status(429).json({error: {code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Wait a few minutes.'}})
		}
		attempts.set(ip, [...recent, now])

		const {password, totpToken, userId} = req.body ?? {}
		if (typeof password !== 'string' || !password) {
			return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Enter your password'}})
		}
		const userAgent = req.headers['user-agent']
		const nativeClient = nativeClientFor(userAgent)
		const credentials = {password, ...(totpToken ? {totpToken: String(totpToken)} : {}), ...(userId ? {userId} : {})}
		let session
		try {
			const result = await umbrel.mutation('user.loginNative', {...credentials, client: nativeClient}, {userAgent})
			session = {
				mode: 'native',
				accountId: result.accountId,
				accessToken: result.accessToken,
				accessExpiresAt: result.accessExpiresAt,
				deviceToken: result.deviceToken,
				client: nativeClient,
			}
		} catch (error) {
			// umbrelOS before 2.0 has no native login; its user.login returns a bearer JWT.
			if (!(error instanceof UmbrelError) || error.code !== 'NOT_FOUND') return sendError(res, error)
			try {
				const token = await umbrel.mutation('user.login', credentials, {userAgent})
				if (typeof token !== 'string') throw new UmbrelError('Unsupported umbrelOS version', {status: 502})
				session = {mode: 'legacy', accountId: userId ?? 'owner', accessToken: token}
			} catch (legacyError) {
				return sendError(res, legacyError)
			}
		}
		// The VM console needs a WebSocket ticket, which umbreld only issues to browser
		// sessions (not native ones). Hold a second, browser-style session server-side
		// for that single purpose. Failing to get one only disables the console.
		if (session.mode === 'native') {
			session.console = await openConsoleSession(umbrel, credentials, userAgent).catch(() => null)
		}
		attempts.delete(ip)
		const sid = newSessionId()
		await store.putSession(sid, {...session, createdAt: now, lastSeenAt: now, userAgent: String(userAgent ?? '').slice(0, 200)})
		setCookie(res, sid, SESSION_MAX_AGE_S)
		res.json({ok: true, accountId: session.accountId, mode: session.mode})
	})

	api.post('/auth/logout', async (req, res) => {
		const session = store.getSession(req.sid)
		if (session?.console) {
			await getClient()
				?.mutation('user.logout', undefined, {token: session.console.token, cookie: session.console.cookie})
				.catch(() => {})
		}
		if (session) {
			// Revoke the umbrelOS session too, so it disappears from Settings › Devices.
			await authedCall(req, 'user.logout', 'mutation').catch(() => {})
			await store.deleteSession(req.sid)
		}
		setCookie(res, '', 0)
		res.json({ok: true})
	})

	// ---- VM console ------------------------------------------------------------
	async function openConsoleSession(umbrel, credentials, userAgent) {
		const {data: token, cookies} = await umbrel.mutation('user.login', credentials, {userAgent, withCookies: true})
		const cookie = cookies.filter((c) => /BROWSER_SESSION/.test(c)).join('; ')
		if (typeof token !== 'string' || !cookie) return null
		return {token, cookie, renewedAt: Date.now()}
	}

	async function consoleTicket(sid) {
		const umbrel = getClient()
		const session = store.getSession(sid)
		if (!umbrel || !session) throw new UmbrelError('Signed out', {code: 'UNAUTHORIZED', status: 401})
		if (!session.console) {
			throw new UmbrelError('Sign out and back in to use the console', {code: 'CONSOLE_SESSION_REQUIRED', status: 409})
		}
		const auth = {token: session.console.token, cookie: session.console.cookie}
		try {
			// Browser sessions last 7 days from their last renewal; keep ours fresh.
			if (Date.now() - session.console.renewedAt > 24 * 60 * 60 * 1000) {
				await umbrel.mutation('user.renewToken', undefined, auth)
				await store.updateSession(sid, {console: {...session.console, renewedAt: Date.now()}})
			}
			return await umbrel.mutation('user.createWebSocketTicket', {target: 'machines'}, auth)
		} catch (error) {
			if (error instanceof UmbrelError && error.code === 'UNAUTHORIZED') {
				await store.updateSession(sid, {console: null})
				throw new UmbrelError('Sign out and back in to use the console', {code: 'CONSOLE_SESSION_REQUIRED', status: 409})
			}
			throw error
		}
	}

	// Asked before the socket opens so the app can show a clear reason when it can't.
	api.get('/console/check', async (req, res) => {
		try {
			await consoleTicket(req.sid) // tickets are single-use and expire in 30s; this one is simply discarded
			res.json({ok: true})
		} catch (error) {
			sendError(res, error)
		}
	})

	// WebSocket bridge: phone <-> this server <-> umbreld /machines/console (raw VNC).
	app.attachConsole = (server) => {
		const wss = new WebSocketServer({noServer: true, maxPayload: 16 * 1024 * 1024})
		server.on('upgrade', async (req, socket, head) => {
			const refuse = (status) => {
				socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
				socket.destroy()
			}
			try {
				const url = new URL(req.url, 'http://x')
				if (url.pathname !== '/api/console') return refuse('404 Not Found')
				// Browsers always send Origin on WebSocket handshakes: refuse other sites.
				const origin = req.headers.origin
				if (!origin || new URL(origin).host !== req.headers.host) return refuse('403 Forbidden')
				const sid = parseCookies(req.headers.cookie)[COOKIE]
				const machineId = url.searchParams.get('machineId') ?? ''
				if (!store.getSession(sid)) return refuse('401 Unauthorized')
				if (!/^[A-Za-z0-9_-]{1,64}$/.test(machineId)) return refuse('400 Bad Request')
				const ticket = await consoleTicket(sid)
				const target = new URL(getClient().baseUrl)
				target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
				target.pathname = '/machines/console'
				target.search = new URLSearchParams({machineId, sessionId: randomUUID(), ticket}).toString()
				const upstream = new WebSocket(target, ['binary'], {handshakeTimeout: 10_000})
				upstream.once('error', () => refuse('502 Bad Gateway'))
				upstream.once('open', () => {
					upstream.removeAllListeners('error')
					wss.handleUpgrade(req, socket, head, (client) => {
						const closeBoth = (code, reason) => {
							const safe = typeof code === 'number' && (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1000
							for (const ws of [client, upstream]) if (ws.readyState === WebSocket.OPEN) ws.close(safe, reason)
						}
						upstream.on('message', (data) => client.readyState === WebSocket.OPEN && client.send(data, {binary: true}))
						client.on('message', (data) => upstream.readyState === WebSocket.OPEN && upstream.send(data, {binary: true}))
						upstream.on('close', (code, reason) => closeBoth(code, reason))
						client.on('close', () => closeBoth(1000))
						upstream.on('error', () => client.terminate())
						client.on('error', () => upstream.terminate())
					})
				})
			} catch {
				refuse('502 Bad Gateway')
			}
		})
		return wss
	}

	// ---- Allowlisted proxy ---------------------------------------------------
	const proxy = async (req, res) => {
		const path = req.params.path
		const kind = ALLOWED[path]
		if (!kind) return res.status(404).json({error: {code: 'NOT_FOUND', message: `${path} is not available in UmbrelOS Touch`}})
		if ((kind === 'query') !== (req.method === 'GET')) {
			return res.status(405).json({error: {code: 'METHOD_NOT_SUPPORTED', message: 'Wrong method'}})
		}
		let input
		try {
			input = kind === 'query' ? (req.query.input === undefined ? undefined : JSON.parse(String(req.query.input))) : req.body?.input
		} catch {
			return res.status(400).json({error: {code: 'BAD_REQUEST', message: 'Malformed input'}})
		}
		try {
			const data = await authedCall(req, path, kind, input)
			res.json({data: data ?? null})
		} catch (error) {
			if (error instanceof UmbrelError && error.code === 'UNAUTHORIZED' && !store.getSession(req.sid)) setCookie(res, '', 0)
			sendError(res, error)
		}
	}
	api.get('/rpc/:path', proxy)
	api.post('/rpc/:path', proxy)

	api.get('/health', (req, res) => res.json({ok: true, version: VERSION}))
	api.use((req, res) => res.status(404).json({error: {code: 'NOT_FOUND', message: 'Not found'}}))
	app.use('/api', api)

	// ---- PWA -----------------------------------------------------------------
	if (staticDir && existsSync(staticDir)) {
		app.use('/assets', express.static(join(staticDir, 'assets'), {immutable: true, maxAge: '1y'}))
		app.use(express.static(staticDir, {index: false, maxAge: 0}))
		app.get('*', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(join(staticDir, 'index.html')))
	}
	return app
}
