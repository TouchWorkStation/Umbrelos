import assert from 'node:assert/strict'
import {mkdtemp, readFile, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

import WebSocket from 'ws'

import {createApp} from '../server/app.mjs'
import {createStore} from '../server/store.mjs'
import {startFakeUmbreld} from './fake-umbreld.mjs'

async function startTouch({umbrelUrl} = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'touch-'))
	const store = await createStore(dir)
	if (umbrelUrl) await store.setConfig({umbrelUrl})
	const app = createApp({store})
	const server = await new Promise((r) => {
		const s = app.listen(0, '127.0.0.1', () => r(s))
	})
	app.attachConsole(server)
	const base = `http://127.0.0.1:${server.address().port}`
	let cookie = ''
	const req = async (method, path, body, headers = {}) => {
		const res = await fetch(base + path, {
			method,
			headers: {
				...(body !== undefined ? {'content-type': 'application/json'} : {}),
				...(method !== 'GET' ? {'x-umbrel-touch': '1'} : {}),
				...(cookie ? {cookie} : {}),
				...headers,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		})
		const set = res.headers.get('set-cookie')
		if (set) cookie = set.split(';')[0]
		return {status: res.status, body: await res.json().catch(() => null), setCookie: set}
	}
	return {dir, store, base, req, getCookie: () => cookie, close: () => new Promise((r) => server.close(r))}
}

describe('UmbrelOS Touch server against an umbreld 2.0 stand-in', () => {
	let fake
	let touch
	before(async () => {
		fake = await startFakeUmbreld({accessTtlMs: 60 * 60 * 1000})
		touch = await startTouch()
	})
	after(async () => {
		await touch.close()
		await fake.close()
	})

	test('unconfigured server asks to connect, setup verifies the address is umbrelOS', async () => {
		let r = await touch.req('GET', '/api/bootstrap')
		assert.equal(r.body.configured, false)
		r = await touch.req('POST', '/api/setup', {url: 'http://127.0.0.1:1'})
		assert.equal(r.status, 502)
		r = await touch.req('POST', '/api/setup', {url: fake.url})
		assert.equal(r.status, 200)
		assert.equal(r.body.version, '2.0.0')
		r = await touch.req('GET', '/api/bootstrap')
		assert.equal(r.body.umbrel.reachable, true)
		// a loopback Umbrel address is reported as the address the phone used to reach Touch
		assert.equal(r.body.umbrel.host, '127.0.0.1')
		assert.equal(r.body.umbrel.url, 'http://127.0.0.1')
		assert.equal(r.body.accounts[0].name, 'Chris')
		assert.deepEqual(r.body.accounts[0].wallpaper, {id: '23', brandColorHsl: '24 90% 50%'})
		assert.equal(r.body.session, null)
	})

	test('wallpaper route only serves numeric umbrelOS wallpaper ids', async () => {
		const bad = await fetch(`${touch.base}/api/umbrel-wallpaper/..%2F..%2Fetc`)
		assert.equal(bad.status, 404)
		const missing = await fetch(`${touch.base}/api/umbrel-wallpaper/999`)
		assert.equal(missing.status, 404)
	})

	test('proxy refuses calls before sign-in', async () => {
		const r = await touch.req('GET', '/api/rpc/apps.list')
		assert.equal(r.status, 401)
	})

	test('wrong password surfaces umbreld’s message', async () => {
		const r = await touch.req('POST', '/api/auth/login', {password: 'nope'})
		assert.equal(r.status, 401)
		assert.equal(r.body.error.message, 'Incorrect password')
	})

	test('native login stores credentials server-side and sets only an opaque cookie', async () => {
		const r = await touch.req('POST', '/api/auth/login', {password: 'correct horse'}, {'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'})
		assert.equal(r.status, 200)
		assert.equal(r.body.mode, 'native')
		assert.match(r.setCookie, /HttpOnly/)
		assert.match(r.setCookie, /SameSite=Strict/)
		const login = fake.calls.findLast((c) => c.path === 'user.loginNative')
		assert.deepEqual(login.input.client, {id: 'umbrel-touch', platform: 'ios', deviceClass: 'phone', appVersion: '0.5.0', appBuild: '1', osVersion: 'web'})
		const saved = await readFile(join(touch.dir, 'sessions.json'), 'utf8')
		assert.ok(!saved.includes(touch.getCookie().split('=')[1]), 'cookie value must not be stored in plain form')
		assert.equal((await stat(join(touch.dir, 'sessions.json'))).mode & 0o777, 0o600)
	})

	test('queries and mutations go through with the bearer token', async () => {
		let r = await touch.req('GET', '/api/rpc/apps.list')
		assert.equal(r.status, 200)
		assert.equal(r.body.data.length, 4)
		r = await touch.req('GET', `/api/rpc/apps.state?input=${encodeURIComponent(JSON.stringify({appId: 'jellyfin'}))}`)
		assert.equal(r.body.data.state, 'stopped')
		r = await touch.req('POST', '/api/rpc/apps.start', {input: {appId: 'jellyfin'}})
		assert.equal(r.status, 200)
		assert.equal(fake.apps.find((a) => a.id === 'jellyfin').state, 'ready')
		assert.match(fake.calls.findLast((c) => c.path === 'apps.start').authorization, /^Bearer /)
	})

	const openConsole = (headers) =>
		new Promise((resolve) => {
			const ws = new WebSocket(`${touch.base.replace('http', 'ws')}/api/console?machineId=ubuntu-1`, {headers})
			ws.once('message', (data) => {
				resolve({ok: true, first: data.toString()})
				ws.close()
			})
			ws.once('unexpected-response', (_req, res) => resolve({ok: false, status: res.statusCode}))
			ws.once('error', () => resolve({ok: false}))
		})

	test('VM console: bridges VNC through a server-held browser session', async () => {
		const r = await touch.req('GET', '/api/console/check')
		assert.equal(r.status, 200)
		const ok = await openConsole({cookie: touch.getCookie(), origin: touch.base})
		assert.deepEqual(ok, {ok: true, first: 'RFB 003.008\n'})
		// the ticket was requested with the dashboard token + browser cookie, never the native token
		const ticketCall = fake.calls.findLast((c) => c.path === 'user.createWebSocketTicket')
		assert.deepEqual(ticketCall.input, {target: 'machines'})
		const native = fake.calls.findLast((c) => c.path === 'apps.list' || c.path === 'user.get')
		assert.notEqual(ticketCall.authorization, native?.authorization)
	})

	test('VM console: refuses other sites, missing sign-in and odd machine ids', async () => {
		assert.equal((await openConsole({cookie: touch.getCookie(), origin: 'http://evil.example'})).status, 403)
		assert.equal((await openConsole({cookie: touch.getCookie()})).status, 403)
		assert.equal((await openConsole({origin: touch.base})).status, 401)
		const bad = await new Promise((resolve) => {
			const ws = new WebSocket(`${touch.base.replace('http', 'ws')}/api/console?machineId=../x`, {headers: {cookie: touch.getCookie(), origin: touch.base}})
			ws.once('unexpected-response', (_q, res) => resolve(res.statusCode))
			ws.once('error', () => resolve(0))
		})
		assert.equal(bad, 400)
	})

	test('creates a machine through umbreld', async () => {
		const r = await touch.req('POST', '/api/rpc/machines.create', {input: {name: 'Dev box', osId: 'debian-server-amd64', cores: 2, memoryGb: 2, diskSizeGb: 15, arch: 'amd64', username: 'chris', password: 'pw'}})
		assert.equal(r.status, 200)
		assert.equal(r.body.data.state, 'installing')
		assert.equal(fake.lastCreate().username, 'chris')
	})

	test('settings calls go through', async () => {
		assert.equal((await touch.req('POST', '/api/rpc/system.setHostname', {input: {hostname: 'nest'}})).status, 200)
		assert.equal(fake.settings.hostname, 'nest')
		assert.equal((await touch.req('POST', '/api/rpc/apps.setTorEnabled', {input: true})).status, 200)
		assert.equal(fake.settings.tor, true)
		const wrong = await touch.req('POST', '/api/rpc/user.changePassword', {input: {oldPassword: 'nope', newPassword: 'abcdefg'}})
		assert.equal(wrong.status, 401)
		const sessions = await touch.req('GET', '/api/rpc/user.listSessions')
		assert.equal(sessions.body.data.length, 2)
	})

	test('theme settings are saved per account and validated', async () => {
		let r = await touch.req('POST', '/api/prefs', {theme: 'tokyo', accent: 'teal'})
		assert.equal(r.status, 200)
		r = await touch.req('GET', '/api/prefs')
		assert.equal(r.body.prefs.theme, 'tokyo')
		assert.equal(r.body.prefs.accent, 'teal')
		assert.equal((await touch.req('POST', '/api/prefs', {theme: '<script>'})).status, 400)
		assert.equal((await touch.req('POST', '/api/prefs', {customBrandHsl: 'red; x'})).status, 400)
		const anon = await fetch(`${touch.base}/api/prefs`)
		assert.equal(anon.status, 401)
	})

	test('custom background upload accepts JPEG only and is private', async () => {
		const send = (body) =>
			fetch(`${touch.base}/api/background`, {method: 'POST', headers: {'content-type': 'image/jpeg', 'x-umbrel-touch': '1', cookie: touch.getCookie()}, body})
		assert.equal((await send(Buffer.from('<svg onload=alert(1)>'))).status, 400)
		const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)])
		const up = await send(jpeg)
		assert.equal(up.status, 200)
		assert.ok((await up.json()).prefs.backgroundVersion)
		const got = await fetch(`${touch.base}/api/background`, {headers: {cookie: touch.getCookie()}})
		assert.equal(got.status, 200)
		assert.equal(got.headers.get('content-type'), 'image/jpeg')
		assert.equal((await fetch(`${touch.base}/api/background`)).status, 401)
		const del = await touch.req('DELETE', '/api/background')
		assert.equal(del.body.prefs.backgroundVersion, null)
	})

	test('non-allowlisted procedures are refused without reaching umbreld', async () => {
		const before = fake.calls.length
		const r = await touch.req('POST', '/api/rpc/user.deleteUser', {input: {userId: 'x'}})
		assert.equal(r.status, 404)
		assert.equal(fake.calls.length, before)
	})

	test('wrong HTTP method for a procedure kind is refused', async () => {
		const r = await touch.req('GET', '/api/rpc/apps.start')
		assert.equal(r.status, 405)
	})

	test('cross-site POSTs are refused', async () => {
		let r = await touch.req('POST', '/api/rpc/apps.stop', {input: {appId: 'jellyfin'}}, {'x-umbrel-touch': ''})
		assert.equal(r.status, 403)
		r = await touch.req('POST', '/api/rpc/apps.stop', {input: {appId: 'jellyfin'}}, {origin: 'http://evil.example'})
		assert.equal(r.status, 403)
		assert.equal(fake.apps.find((a) => a.id === 'jellyfin').state, 'ready')
	})

	test('an expired access token is refreshed with the device token and the call retried', async () => {
		fake.expireAllAccessTokens()
		const r = await touch.req('GET', '/api/rpc/system.cpuUsage')
		assert.equal(r.status, 200)
		assert.equal(r.body.data.totalUsed, 18.4)
		assert.ok(fake.calls.some((c) => c.path === 'user.refreshNativeAccess'))
	})

	test('re-pointing the server needs a signed-in session', async () => {
		const anon = await fetch(`${touch.base}/api/setup`, {
			method: 'POST',
			headers: {'content-type': 'application/json', 'x-umbrel-touch': '1'},
			body: JSON.stringify({url: 'http://192.0.2.1'}),
		})
		assert.equal(anon.status, 403)
	})

	test('revoking the device in umbrelOS signs the phone out', async () => {
		fake.revokeAllDevices()
		const r = await touch.req('GET', '/api/rpc/apps.list')
		assert.equal(r.status, 401)
		assert.equal(touch.store.sessionCount(), 0)
		const b = await touch.req('GET', '/api/bootstrap')
		assert.equal(b.body.session, null)
	})

	test('logout revokes the umbrelOS session', async () => {
		await touch.req('POST', '/api/auth/login', {password: 'correct horse'})
		const r = await touch.req('POST', '/api/auth/logout')
		assert.equal(r.status, 200)
		assert.ok(fake.calls.findLast((c) => c.path === 'user.logout'))
		assert.equal(touch.store.sessionCount(), 0)
	})
})

describe('older umbrelOS without native login', () => {
	test('falls back to user.login bearer tokens', async () => {
		const fake = await startFakeUmbreld({legacy: true})
		const touch = await startTouch({umbrelUrl: fake.url})
		try {
			const r = await touch.req('POST', '/api/auth/login', {password: 'correct horse'})
			assert.equal(r.status, 200)
			assert.equal(r.body.mode, 'legacy')
			const list = await touch.req('GET', '/api/rpc/apps.list')
			assert.equal(list.status, 200)
		} finally {
			await touch.close()
			await fake.close()
		}
	})
})
