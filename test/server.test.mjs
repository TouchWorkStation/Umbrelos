import assert from 'node:assert/strict'
import {mkdtemp, readFile, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {after, before, describe, test} from 'node:test'

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
		assert.equal(r.body.umbrel.host, '127.0.0.1')
		assert.equal(r.body.accounts[0].name, 'Chris')
		assert.equal(r.body.session, null)
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
		assert.deepEqual(login.input.client, {id: 'umbrel-touch', platform: 'ios', deviceClass: 'phone', appVersion: '0.1.0', appBuild: '1', osVersion: 'web'})
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

	test('non-allowlisted procedures are refused without reaching umbreld', async () => {
		const before = fake.calls.length
		const r = await touch.req('POST', '/api/rpc/system.factoryReset', {input: {password: 'x'}})
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
