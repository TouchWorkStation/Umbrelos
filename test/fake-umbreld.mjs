// TEST-ONLY stand-in for umbreld. It reproduces the tRPC v11 wire format and the
// auth rules of umbrelOS 2.0 (native access tokens that expire, device-token
// refresh, owner-only procedures) so the server can be tested without a real
// Umbrel. It is never shipped or used by the app itself.

import http from 'node:http'
import {randomBytes} from 'node:crypto'

export function startFakeUmbreld({port = 0, accessTtlMs = 60 * 60 * 1000, legacy = false, password = 'correct horse'} = {}) {
	const tokens = new Map() // access token -> {expiresAt, sessionId}
	const devices = new Map() // device token -> sessionId
	const calls = []
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
		{id: 'ubuntu-1', name: 'Ubuntu Desktop', osId: 'ubuntu', cores: 4, memoryGb: 8, diskSizeGb: 64, state: 'stopped', ipAddress: '10.21.0.2'},
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
		'user.listAccounts': {kind: 'query', public: true, run: () => [{userId: 'owner', name: 'Chris', language: 'en'}]},
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
			run: (input) => {
				if (input?.password !== password) return {error: ['UNAUTHORIZED', 'Incorrect password']}
				return issueAccess('legacy').accessToken
			},
		},
		'user.logout': {
			kind: 'mutation',
			run: (_, auth) => {
				for (const [t, v] of tokens) if (v.sessionId === auth.sessionId) tokens.delete(t)
				for (const [d, s] of devices) if (s === auth.sessionId) devices.delete(d)
				return true
			},
		},
		'user.get': {kind: 'query', run: () => ({userId: 'owner', name: 'Chris', role: 'owner'})},
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
			run: () => [{meta: {id: 'umbrel-app-store', name: 'Umbrel App Store'}, apps: [{id: 'vaultwarden', name: 'Vaultwarden', tagline: 'Passwords', category: 'files', version: '1.32.5', icon: '', description: '', developer: 'Vaultwarden', gallery: [], dependencies: []}]}],
		},
		'apps.installReview': {kind: 'query', run: () => ({requiredFolders: [], gpuAccess: false})},
		'apps.install': {kind: 'mutation', run: () => true},
		'machines.list': {kind: 'query', run: () => machines},
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
		const out = proc.run(input, auth)
		if (out?.notFound) return fail('NOT_FOUND', `No procedure found on path "${path}"`)
		if (out?.error) return fail(...out.error)
		send(200, {result: {data: out}})
	})

	return new Promise((resolve) => {
		server.listen(port, '127.0.0.1', () => {
			resolve({
				url: `http://127.0.0.1:${server.address().port}`,
				calls,
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

// `node test/fake-umbreld.mjs 7781` runs it standalone for UI development.
if (import.meta.url === `file://${process.argv[1]}`) {
	const fake = await startFakeUmbreld({port: Number(process.argv[2] ?? 7781)})
	console.log(`fake umbreld (TEST ONLY) at ${fake.url}, password "correct horse"`)
}
