// TEST-ONLY stand-in for umbreld. It reproduces the tRPC v11 wire format and the
// auth rules of umbrelOS 2.0 (native access tokens that expire, device-token
// refresh, owner-only procedures) so the server can be tested without a real
// Umbrel. It is never shipped or used by the app itself.

import http from 'node:http'
import {readFile} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {WebSocketServer} from 'ws'

export function startFakeUmbreld({
	port = 0,
	accessTtlMs = 60 * 60 * 1000,
	legacy = false,
	password = 'correct horse',
	wallpaperDir = process.env.FAKE_WALLPAPER_DIR,
} = {}) {
	const wallpaper = {id: process.env.FAKE_WALLPAPER_ID ?? '23', brandColorHsl: process.env.FAKE_BRAND ?? '24 90% 50%'}
	let baseUrl = ''
	const tokens = new Map() // access token -> {expiresAt, sessionId}
	const devices = new Map() // device token -> sessionId
	const calls = []
	const browser = new Map() // dashboard token -> browser-session cookie value
	const tickets = new Set()
	const keys = [] // keysyms typed into the fake VM console
	const gb = 1024 ** 3
	const apps = [
		{id: 'nextcloud', name: 'Nextcloud', version: '30.0.2', port: 8081, path: '', state: 'ready'},
		{id: 'immich', name: 'Immich', version: '1.120.0', port: 2283, path: '', state: 'ready'},
		{id: 'jellyfin', name: 'Jellyfin', version: '10.10.3', port: 8096, path: '', state: 'stopped'},
		{id: 'home-assistant', name: 'Home Assistant', version: '2024.12.1', port: 8123, path: '', state: 'ready'},
	].map((a) => ({
		...a,
		icon: `https://getumbrel.github.io/umbrel-apps-gallery/${a.id}/icon.svg`,
		progress: 0,
		autoStart: true,
		credentials: {defaultUsername: '', defaultPassword: '', hideBeforeOpen: false, showBeforeOpen: false},
		hiddenService: '',
		widgets: [],
		dependencies: [],
		selectedDependencies: {},
		implements: [],
		torOnly: false,
		requiresHttps: false,
	}))
	const machines = [
		{id: 'ubuntu-1', name: 'Ubuntu Desktop', osId: 'ubuntu', cores: 4, memoryGb: 8, diskSizeGb: 64, state: process.env.FAKE_VM_RUNNING ? 'running' : 'stopped', ipAddress: '10.21.0.2'},
	]
	let notifications = ['update-available']

	const newToken = () => randomBytes(24).toString('base64url')
	const issueAccess = (sessionId) => {
		const accessToken = newToken()
		const accessExpiresAt = Date.now() + accessTtlMs
		tokens.set(accessToken, {expiresAt: accessExpiresAt, sessionId})
		return {accessToken, accessExpiresAt}
	}

	const procedures = {
		'system.version': {kind: 'query', public: true, run: () => ({version: '2.0.0', name: 'umbrelOS 2.0'})},
		'system.discoveryInfo': {kind: 'query', public: true, run: () => ({id: 'abc', device: 'Linux VM', version: '2.0.0', onboarded: true})},
		'user.listAccounts': {kind: 'query', public: true, run: () => [{userId: 'owner', name: 'Chris', language: 'en', wallpaper}]},
		'user.loginNative': {
			kind: 'mutation',
			public: true,
			run: (input) => {
				if (legacy) return {notFound: true}
				if (input?.password !== password) return {error: ['UNAUTHORIZED', 'Incorrect password']}
				if (!input?.client?.id) return {error: ['BAD_REQUEST', 'Missing client']}
				const sessionId = newToken()
				const deviceToken = newToken()
				devices.set(deviceToken, sessionId)
				return {accountId: 'owner', ...issueAccess(sessionId), deviceToken}
			},
		},
		'user.refreshNativeAccess': {
			kind: 'mutation',
			public: true,
			run: (input) => {
				const sessionId = devices.get(input?.deviceToken)
				if (!sessionId) return {error: ['UNAUTHORIZED', 'Invalid native session']}
				return issueAccess(sessionId)
			},
		},
		'user.login': {
			kind: 'mutation',
			public: true,
			run: (input, _auth, res) => {
				if (input?.password !== password) return {error: ['UNAUTHORIZED', 'Incorrect password']}
				const {accessToken} = issueAccess(legacy ? 'legacy' : newToken())
				tokens.get(accessToken).expiresAt = Infinity
				const cookie = newToken()
				browser.set(accessToken, cookie)
				res.setHeader('set-cookie', [`UMBREL_APP_SESSION=${newToken()}; Path=/; HttpOnly`, `UMBREL_BROWSER_SESSION=${cookie}; Path=/; HttpOnly; SameSite=Lax`])
				return accessToken
			},
		},
		// Like umbreld: tickets are only issued to browser sessions (dashboard token + cookie), never native ones.
		'user.createWebSocketTicket': {
			kind: 'mutation',
			run: (input, auth, _res, req) => {
				const token = req.headers.authorization?.split(' ')[1]
				const cookie = browser.get(token)
				if (!cookie || legacy) return {error: ['FORBIDDEN', 'Browser session required']}
				if (!String(req.headers.cookie ?? '').includes(`UMBREL_BROWSER_SESSION=${cookie}`)) return {error: ['UNAUTHORIZED', 'Invalid token']}
				const ticket = `${input.target}:${newToken()}`
				tickets.add(ticket)
				return ticket
			},
		},
		'user.renewToken': {kind: 'mutation', run: () => 'renewed'},
		'user.logout': {
			kind: 'mutation',
			run: (_, auth) => {
				for (const [t, v] of tokens) if (v.sessionId === auth.sessionId) tokens.delete(t)
				for (const [d, s] of devices) if (s === auth.sessionId) devices.delete(d)
				return true
			},
		},
		'user.get': {kind: 'query', run: () => ({userId: 'owner', name: 'Chris', role: 'owner', wallpaper})},
		'apps.recentlyOpened': {kind: 'query', run: () => ['immich', 'home-assistant']},
		'system.uptime': {kind: 'query', run: () => 1_234_567},
		'system.cpuTemperature': {kind: 'query', run: () => ({warning: 'normal', temperature: 52})},
		'system.cpuUsage': {
			kind: 'query',
			run: () => ({threads: 16, totalUsed: 18.4, system: 9.1, apps: [{id: 'immich', used: 6.2}, {id: 'nextcloud', used: 3.1}], machines: []}),
		},
		'system.memoryUsage': {
			kind: 'query',
			run: () => ({size: 16 * gb, totalUsed: 6.2 * gb, system: 2 * gb, apps: [{id: 'immich', used: 2.1 * gb}], machines: []}),
		},
		'system.diskUsage': {
			kind: 'query',
			run: () => ({size: 1000 * gb, totalUsed: 720 * gb, available: 280 * gb, system: 40 * gb, files: 300 * gb, apps: [{id: 'immich', used: 210 * gb}], machines: []}),
		},
		'apps.list': {kind: 'query', run: () => apps},
		'apps.state': {kind: 'query', run: ({appId}) => apps.find((a) => a.id === appId) ?? {state: 'not-installed', progress: 0}},
		'apps.updates': {kind: 'query', run: () => [{id: 'nextcloud', version: '30.0.4'}]},
		'apps.logs': {kind: 'query', run: ({appId}) => `${appId}_server_1  | ready\n`},
		'apps.start': {kind: 'mutation', run: ({appId}) => ((apps.find((a) => a.id === appId).state = 'ready'), true)},
		'apps.stop': {kind: 'mutation', run: ({appId}) => ((apps.find((a) => a.id === appId).state = 'stopped'), true)},
		'apps.restart': {kind: 'mutation', run: () => true},
		'appStore.registry': {
			kind: 'query',
			run: () => {
				const shot = (n) => `${baseUrl}/assets/wallpapers/${n}.jpg`
				const app = (id, name, category, tagline, gallery = [], extra = {}) => ({
					id, name, category, tagline, version: '1.0.0', icon: '', developer: `${name} team`, gallery, dependencies: [],
					description: `${name} on your Umbrel. ${tagline}.`, installSize: 250e6, compatible: true, ...extra,
				})
				return [{meta: {id: 'umbrel-app-store', name: 'Umbrel App Store'}, apps: [
					app('immich', 'Immich', 'files', 'Your photos and videos, on your terms', [shot(5), shot(9)]),
					app('nextcloud', 'Nextcloud', 'files', 'Productivity platform that keeps you in control', [shot(12)]),
					app('vaultwarden', 'Vaultwarden', 'files', 'Unofficial Bitwarden-compatible password manager'),
					app('home-assistant', 'Home Assistant', 'automation', 'Home automation that puts local control first', [shot(17)]),
					app('jellyfin', 'Jellyfin', 'media', 'The free software media system', [shot(20)]),
					app('plex', 'Plex', 'media', 'Stream movies and TV shows'),
					app('navidrome', 'Navidrome', 'media', 'Your music collection, everywhere'),
					app('ollama', 'Ollama', 'ai', 'Run large language models locally', [shot(1)]),
					app('open-webui', 'Open WebUI', 'ai', 'Chat with local models in your browser', [], {dependencies: ['ollama']}),
					app('bitcoin', 'Bitcoin Node', 'bitcoin', 'Run your own Bitcoin node', [shot(3)]),
					app('pi-hole', 'Pi-hole', 'networking', 'Block ads across your whole network'),
					app('tailscale', 'Tailscale', 'networking', 'Zero-config VPN for your devices'),
				]}]
			},
		},
		'apps.installReview': {kind: 'query', run: () => ({requiredFolders: [], gpuAccess: false})},
		'apps.install': {
			kind: 'mutation',
			run: ({appId}) => {
				if (!apps.some((a) => a.id === appId)) apps.push({...apps[0], id: appId, name: appId.replace(/(^|-)\w/g, (c) => c.replace('-', ' ').toUpperCase()), state: 'ready', port: 8200})
				return true
			},
		},
		'machines.list': {kind: 'query', run: () => machines},
		'system.checkUpdate': {kind: 'query', run: () => ({available: false, version: '2.0.0', name: 'umbrelOS 2.0'})},
		'apps.uninstall': {kind: 'mutation', run: ({appId}) => (apps.splice(apps.findIndex((a) => a.id === appId), 1), true)},
		'machines.start': {kind: 'mutation', run: ({id}) => ((machines.find((m) => m.id === id).state = 'running'), true)},
		'notifications.get': {kind: 'query', run: () => notifications},
		'notifications.clear': {kind: 'mutation', run: (id) => ((notifications = notifications.filter((n) => n !== id)), true)},
		'system.factoryReset': {kind: 'mutation', run: () => true},
	}

	const server = http.createServer(async (req, res) => {
		const send = (status, body) => {
			res.writeHead(status, {'content-type': 'application/json'})
			res.end(JSON.stringify(body))
		}
		const fail = (code, message) => {
			const httpStatus = {UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, BAD_REQUEST: 400}[code] ?? 500
			send(httpStatus, {error: {message, code: -32000, data: {code, httpStatus, path: ''}}})
		}
		const url = new URL(req.url, 'http://x')
		const wp = url.pathname.match(/^\/assets\/wallpapers\/(\d+)\.jpg$/)
		if (wp) {
			try {
				const data = await readFile(`${wallpaperDir ?? '/nonexistent'}/${wp[1]}.jpg`)
				res.writeHead(200, {'content-type': 'image/jpeg'})
				return res.end(data)
			} catch {
				res.writeHead(404)
				return res.end()
			}
		}
		const path = url.pathname.replace(/^\/trpc\//, '')
		const proc = procedures[path]
		if (!url.pathname.startsWith('/trpc/') || !proc) return fail('NOT_FOUND', `No procedure found on path "${path}"`)
		if ((proc.kind === 'query') !== (req.method === 'GET')) return fail('METHOD_NOT_SUPPORTED', 'Wrong method')
		let input
		if (req.method === 'GET') {
			const raw = url.searchParams.get('input')
			input = raw === null ? undefined : JSON.parse(raw)
		} else {
			let body = ''
			for await (const chunk of req) body += chunk
			input = body ? JSON.parse(body) : undefined
		}
		calls.push({path, input, authorization: req.headers.authorization, userAgent: req.headers['user-agent']})
		let auth = null
		if (!proc.public) {
			const [scheme, token] = req.headers.authorization?.split(' ') ?? []
			const record = scheme === 'Bearer' && tokens.get(token)
			if (!record || record.expiresAt <= Date.now()) return fail('UNAUTHORIZED', 'Invalid token')
			auth = record
		}
		const out = proc.run(input, auth, res, req)
		if (out?.notFound) return fail('NOT_FOUND', `No procedure found on path "${path}"`)
		if (out?.error) return fail(...out.error)
		send(200, {result: {data: out}})
	})

	// /machines/console: single-use ticket in the query, then a raw VNC (RFB 3.8) stream,
	// as umbreld bridges from QEMU. This minimal server draws one test frame and records keys.
	const wss = new WebSocketServer({noServer: true})
	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url, 'http://x')
		const ticket = url.searchParams.get('ticket')
		if (url.pathname !== '/machines/console' || !ticket?.startsWith('machines:') || !tickets.delete(ticket) || !url.searchParams.get('machineId') || !url.searchParams.get('sessionId')) {
			return socket.destroy()
		}
		wss.handleUpgrade(req, socket, head, (ws) => rfbServer(ws, keys))
	})

	return new Promise((resolve) => {
		server.listen(port, '127.0.0.1', () => {
			baseUrl = `http://127.0.0.1:${server.address().port}`
			resolve({
				url: `http://127.0.0.1:${server.address().port}`,
				calls,
				keys,
				apps,
				expireAllAccessTokens: () => {
					for (const v of tokens.values()) v.expiresAt = 0
				},
				revokeAllDevices: () => {
					devices.clear()
					tokens.clear()
				},
				close: () => new Promise((r) => server.close(r)),
			})
		})
	})
}

function rfbServer(ws, keys) {
	const W = 640
	const H = 400
	let buf = Buffer.alloc(0)
	let stage = 'version'
	let sent = false
	ws.send(Buffer.from('RFB 003.008\n'))
	const frame = () => {
		const head = Buffer.alloc(16)
		head.writeUInt8(0, 0) // FramebufferUpdate
		head.writeUInt16BE(1, 2) // one rectangle
		head.writeUInt16BE(0, 4)
		head.writeUInt16BE(0, 6)
		head.writeUInt16BE(W, 8)
		head.writeUInt16BE(H, 10)
		head.writeInt32BE(0, 12) // raw
		const px = Buffer.alloc(W * H * 4)
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const i = (y * W + x) * 4
				const bar = y < 28
				px[i] = bar ? 48 : 119 - Math.round((y / H) * 60)
				px[i + 1] = bar ? 10 : 33 + Math.round((x / W) * 30)
				px[i + 2] = bar ? 36 : 111 - Math.round((y / H) * 40)
				px[i + 3] = 255
			}
		ws.send(Buffer.concat([head, px]))
	}
	ws.on('message', (data) => {
		buf = Buffer.concat([buf, data])
		for (;;) {
			if (stage === 'version') {
				if (buf.length < 12) return
				buf = buf.subarray(12)
				ws.send(Buffer.from([1, 1])) // one security type: None
				stage = 'security'
			} else if (stage === 'security') {
				if (buf.length < 1) return
				buf = buf.subarray(1)
				ws.send(Buffer.from([0, 0, 0, 0])) // SecurityResult OK
				stage = 'init'
			} else if (stage === 'init') {
				if (buf.length < 1) return
				buf = buf.subarray(1)
				const name = Buffer.from('Ubuntu Desktop (test)')
				const init = Buffer.alloc(24)
				init.writeUInt16BE(W, 0)
				init.writeUInt16BE(H, 2)
				Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4)
				init.writeUInt32BE(name.length, 20)
				ws.send(Buffer.concat([init, name]))
				stage = 'run'
			} else {
				if (buf.length < 1) return
				const type = buf[0]
				let len
				if (type === 0) len = 20
				else if (type === 2) len = buf.length >= 4 ? 4 + 4 * buf.readUInt16BE(2) : Infinity
				else if (type === 3) len = 10
				else if (type === 4) len = 8
				else if (type === 5) len = 6
				else if (type === 6) len = buf.length >= 8 ? 8 + buf.readUInt32BE(4) : Infinity
				else return ws.close()
				if (buf.length < len) return
				if (type === 4 && buf[1] === 1) keys.push(buf.readUInt32BE(4))
				if (type === 3 && !sent) {
					sent = true
					frame()
				}
				buf = buf.subarray(len)
			}
		}
	})
}

// `node test/fake-umbreld.mjs 7781` runs it standalone for UI development.
if (import.meta.url === `file://${process.argv[1]}`) {
	const fake = await startFakeUmbreld({port: Number(process.argv[2] ?? 7781)})
	console.log(`fake umbreld (TEST ONLY) at ${fake.url}, password "correct horse"`)
	// Lets a browser test read which keys reached the fake VM.
	process.on('SIGUSR2', () => console.log('KEYS ' + JSON.stringify(fake.keys)))
}
