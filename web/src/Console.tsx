// Full-screen VM console.
//
// Picture: noVNC, over a WebSocket bridged by the Touch server to umbreld.
// Input: our own gesture layer on top of the picture (noVNC never sees touches),
// modelled on RustDesk / RDP / RealVNC mobile clients:
//
//   Touch mode   tap = click where you tap · long-press = right-click
//                long-press then drag = drag · one finger drag = pan (zoomed) / drag
//   Mouse mode   the screen is a trackpad driving a cursor · tap = click
//                double-tap and hold then drag = drag · two-finger tap = right-click
//   Both         pinch = zoom · two-finger drag = scroll · zoom buttons and Fit
import {useCallback, useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import * as RFBModule from '@novnc/novnc/lib/rfb.js'

import type {Machine} from './api'
import {Icon} from './icons'
import {haptic, useToast} from './ui'
import {useScreenLock} from './Terminal'

type RFBClass = typeof import('@novnc/novnc/lib/rfb.js').default
// noVNC ships CommonJS; depending on the bundler the class is the default or default.default.
const RFB: RFBClass = ((RFBModule as any).default?.default ?? (RFBModule as any).default) as RFBClass

const SUPERSEDED = 4001
const KEY = {Escape: 0xff1b, Tab: 0xff09, Enter: 0xff0d, Backspace: 0xff08, Up: 0xff52, Down: 0xff54, Left: 0xff51, Right: 0xff53, Ctrl: 0xffe3, Alt: 0xffe9, Super: 0xffeb, Shift: 0xffe1}
const BTN = {left: 1, middle: 2, right: 4, wheelUp: 8, wheelDown: 16, wheelLeft: 32, wheelRight: 64}
const MIN_ZOOM = 1
const MAX_ZOOM = 5
const LONG_PRESS_MS = 450
const TAP_SLOP = 9
const keysymOf = (ch: string) => {
	const cp = ch.codePointAt(0)!
	return cp < 0x100 ? cp : 0x01000000 | cp
}

type State = 'connecting' | 'connected' | 'lost' | 'superseded' | 'error'
type Mode = 'touch' | 'mouse'
type View = {z: number; x: number; y: number}
type Pt = {x: number; y: number}

const HINT: Record<Mode, string> = {
	touch: 'Touch: tap to click · hold to right-click · pinch to zoom',
	mouse: 'Mouse: drag to move · tap to click · 2-finger tap to right-click',
}

const readMode = (): Mode => {
	try {
		return localStorage.getItem('umbrel-touch:console-mode') === 'mouse' ? 'mouse' : 'touch'
	} catch {
		return 'touch'
	}
}

export function Console({machine, onClose}: {machine: Machine; onClose: () => void}) {
	const rootRef = useRef<HTMLDivElement>(null)
	const screenRef = useRef<HTMLDivElement>(null) // the visible viewport
	const stageRef = useRef<HTMLDivElement>(null) // zoomed/panned layer holding noVNC
	const canvasHost = useRef<HTMLDivElement>(null)
	const cursorRef = useRef<HTMLDivElement>(null)
	const input = useRef<HTMLTextAreaElement>(null)
	const rfbRef = useRef<InstanceType<RFBClass>>()
	useScreenLock(rootRef, false)
	const [state, setState] = useState<State>('connecting')
	const [message, setMessage] = useState('')
	const [mods, setMods] = useState({Ctrl: false, Alt: false, Shift: false})
	const [attempt, setAttempt] = useState(0)
	const [mode, setModeState] = useState<Mode>(readMode)
	const [zoomLabel, setZoomLabel] = useState(100)
	const [keyboardOpen, setKeyboardOpen] = useState(false)
	const view = useRef<View>({z: 1, x: 0, y: 0})
	const cursor = useRef<Pt>({x: -1, y: -1}) // framebuffer coordinates
	const mask = useRef(0)

	const toast = useToast()
	const setMode = (m: Mode) => {
		haptic(6)
		setModeState(m)
		toast(HINT[m])
		try {
			localStorage.setItem('umbrel-touch:console-mode', m)
		} catch {
			/* not saved */
		}
	}

	// ---- connection ---------------------------------------------------------------
	useEffect(() => {
		let disposed = false
		let retry: number | undefined
		let rfb: InstanceType<RFBClass> | undefined
		let socket: WebSocket | undefined

		const connect = async () => {
			if (disposed || !canvasHost.current) return
			setState((s) => (s === 'lost' ? s : 'connecting'))
			// Ask first so a refusal comes back with a readable reason (sockets only give a code).
			const check = await fetch('/api/console/check', {credentials: 'same-origin'}).catch(() => null)
			if (disposed) return
			if (!check?.ok) {
				const body = await check?.json().catch(() => null)
				setMessage(body?.error?.message ?? 'Can’t reach your Umbrel right now.')
				setState('error')
				return
			}
			let closeCode: number | undefined
			const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
			socket = new WebSocket(`${scheme}//${location.host}/api/console?machineId=${encodeURIComponent(machine.id)}`, ['binary'])
			socket.addEventListener('close', (e) => (closeCode = e.code))
			canvasHost.current.replaceChildren()
			const r = new RFB(canvasHost.current, socket, {shared: true})
			rfb = r
			rfbRef.current = r
			r.scaleViewport = true
			r.resizeSession = false
			r.focusOnClick = false
			r.background = '#000'
			r.addEventListener('connect', () => {
				setState('connected')
				haptic(8)
				try {
					if (!localStorage.getItem('umbrel-touch:console-hint')) {
						localStorage.setItem('umbrel-touch:console-hint', '1')
						toast(HINT[readMode()])
					}
				} catch {
					/* no storage */
				}
				window.setTimeout(() => {
					const fb = fbSize()
					if (fb && cursor.current.x < 0) cursor.current = {x: fb.w / 2, y: fb.h / 2}
					drawCursor()
				}, 300)
			})
			r.addEventListener('disconnect', (e) => {
				if (disposed) return
				if (closeCode === SUPERSEDED) return setState('superseded')
				setState('lost')
				if (!(e as CustomEvent<{clean: boolean}>).detail.clean) retry = window.setTimeout(connect, 1500)
			})
		}
		connect()

		return () => {
			disposed = true
			window.clearTimeout(retry)
			try {
				rfb?.disconnect()
			} catch {
				/* already closed */
			}
			socket?.close()
			rfbRef.current = undefined
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [machine.id, attempt])

	// ---- geometry ----------------------------------------------------------------
	const fbSize = () => {
		const r = rfbRef.current as any
		return r?._fbWidth ? {w: r._fbWidth as number, h: r._fbHeight as number} : null
	}
	const canvasRect = () => canvasHost.current?.querySelector('canvas')?.getBoundingClientRect() ?? null
	// Screen (client) point -> framebuffer pixel. Works at any zoom because the
	// canvas's on-screen box already includes our transform.
	const toFb = (p: Pt): Pt | null => {
		const fb = fbSize()
		const r = canvasRect()
		if (!fb || !r || !r.width) return null
		return {
			x: Math.round(Math.min(fb.w - 1, Math.max(0, ((p.x - r.left) / r.width) * fb.w))),
			y: Math.round(Math.min(fb.h - 1, Math.max(0, ((p.y - r.top) / r.height) * fb.h))),
		}
	}
	const toScreen = (p: Pt): Pt | null => {
		const fb = fbSize()
		const r = canvasRect()
		const s = screenRef.current?.getBoundingClientRect()
		if (!fb || !r || !s) return null
		return {x: r.left - s.left + (p.x / fb.w) * r.width, y: r.top - s.top + (p.y / fb.h) * r.height}
	}

	const drawCursor = useCallback(() => {
		const el = cursorRef.current
		if (!el) return
		const p = cursor.current.x >= 0 ? toScreen(cursor.current) : null
		if (!p) return void (el.style.opacity = '0')
		el.style.opacity = '1'
		el.style.transform = `translate(${p.x}px, ${p.y}px)`
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const applyView = (v: View, animate = false) => {
		const s = screenRef.current
		const stage = stageRef.current
		if (!s || !stage) return
		const w = s.clientWidth
		const h = s.clientHeight
		const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z))
		const x = Math.min(0, Math.max(w - w * z, v.x))
		const y = Math.min(0, Math.max(h - h * z, v.y))
		view.current = {z, x, y}
		stage.style.transition = animate ? 'transform .28s cubic-bezier(.2,.8,.2,1)' : 'none'
		stage.style.transform = `translate(${x}px, ${y}px) scale(${z})`
		setZoomLabel(Math.round(z * 100))
		requestAnimationFrame(drawCursor)
		if (animate) window.setTimeout(drawCursor, 300)
	}
	// Zoom about a point on screen (keeps what's under it still).
	const zoomAt = (z: number, at: Pt, animate = false) => {
		const v = view.current
		const s = screenRef.current!.getBoundingClientRect()
		const px = at.x - s.left
		const py = at.y - s.top
		const sx = (px - v.x) / v.z
		const sy = (py - v.y) / v.z
		const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
		applyView({z: nz, x: px - sx * nz, y: py - sy * nz}, animate)
	}
	const zoomBy = (factor: number) => {
		haptic(5)
		const s = screenRef.current!.getBoundingClientRect()
		const c = mode === 'mouse' && cursor.current.x >= 0 ? toScreen(cursor.current) : null
		zoomAt(view.current.z * factor, c ? {x: s.left + c.x, y: s.top + c.y} : {x: s.left + s.width / 2, y: s.top + s.height / 2}, true)
	}
	const fit = () => {
		haptic(5)
		applyView({z: 1, x: 0, y: 0}, true)
	}
	useEffect(() => {
		const onResize = () => applyView(view.current)
		window.addEventListener('resize', onResize)
		return () => window.removeEventListener('resize', onResize)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// ---- sending input -----------------------------------------------------------
	const send = (p: Pt, m: number) => {
		const r = rfbRef.current as any
		if (!r || r._rfbConnectionState !== 'connected') return
		;(RFB as any).messages.pointerEvent(r._sock, p.x, p.y, m)
		mask.current = m
	}
	const moveTo = (p: Pt) => {
		cursor.current = p
		send(p, mask.current)
		drawCursor()
	}
	const click = (p: Pt, button = BTN.left, times = 1) => {
		cursor.current = p
		send(p, 0)
		for (let i = 0; i < times; i++) {
			send(p, button)
			send(p, 0)
		}
		drawCursor()
		ripple(p, button === BTN.right)
	}
	const press = (p: Pt, button: number) => send(p, mask.current | button)
	const release = (p: Pt, button: number) => send(p, mask.current & ~button)
	const wheel = (p: Pt, button: number) => {
		send(p, mask.current | button)
		send(p, mask.current & ~button)
	}
	const ripple = (fbPt: Pt, right: boolean) => {
		const p = toScreen(fbPt)
		const s = screenRef.current
		if (!p || !s) return
		const dot = document.createElement('span')
		dot.className = `tap-ripple${right ? ' right' : ''}`
		dot.style.left = `${p.x}px`
		dot.style.top = `${p.y}px`
		s.appendChild(dot)
		window.setTimeout(() => dot.remove(), 500)
	}

	// Keep the cursor visible while zoomed in mouse mode.
	const follow = () => {
		const s = screenRef.current
		const p = toScreen(cursor.current)
		if (!s || !p || view.current.z <= 1) return
		const margin = 40
		let {x, y} = view.current
		if (p.x < margin) x += margin - p.x
		if (p.x > s.clientWidth - margin) x -= p.x - (s.clientWidth - margin)
		if (p.y < margin) y += margin - p.y
		if (p.y > s.clientHeight - margin) y -= p.y - (s.clientHeight - margin)
		if (x !== view.current.x || y !== view.current.y) applyView({...view.current, x, y})
	}

	// ---- gestures ----------------------------------------------------------------
	const g = useRef({
		pointers: new Map<number, Pt>(),
		kind: 'none' as 'none' | 'one' | 'two' | 'mouse',
		start: {x: 0, y: 0},
		last: {x: 0, y: 0},
		startTime: 0,
		moved: false,
		held: false, // long-press fired
		dragging: false,
		panning: false,
		longTimer: 0,
		lastTapTime: 0,
		// two-finger
		two: {dist: 0, mid: {x: 0, y: 0}, view: {z: 1, x: 0, y: 0}, type: 'undecided' as 'undecided' | 'pinch' | 'scroll', scrollAcc: 0, scrollAccX: 0, lastMid: {x: 0, y: 0}, maxPointers: 2},
	})

	const two = () => {
		const pts = [...g.current.pointers.values()]
		const [a, b] = pts
		return {dist: Math.hypot(a.x - b.x, a.y - b.y), mid: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}}
	}

	const onPointerDown = (e: React.PointerEvent) => {
		if (state !== 'connected') return
		const st = g.current
		;(e.target as Element).setPointerCapture?.(e.pointerId)
		const p = {x: e.clientX, y: e.clientY}

		// A real mouse (desktop) maps straight through.
		if (e.pointerType === 'mouse') {
			st.kind = 'mouse'
			const fb = toFb(p)
			if (!fb) return
			cursor.current = fb
			const button = e.button === 2 ? BTN.right : e.button === 1 ? BTN.middle : BTN.left
			press(fb, button)
			return
		}

		st.pointers.set(e.pointerId, p)
		if (st.pointers.size === 1) {
			st.kind = 'one'
			st.start = p
			st.last = p
			st.startTime = performance.now()
			st.moved = false
			st.held = false
			st.dragging = false
			st.panning = false
			window.clearTimeout(st.longTimer)
			if (mode === 'touch') {
				st.longTimer = window.setTimeout(() => {
					if (st.kind !== 'one' || st.moved) return
					st.held = true
					haptic(15)
					const fb = toFb(st.start)
					if (fb) ripple(fb, true)
				}, LONG_PRESS_MS)
			} else if (performance.now() - st.lastTapTime < 320) {
				// Mouse mode: double-tap and hold = press the left button for dragging.
				st.dragging = true
				press(cursor.current, BTN.left)
				haptic(10)
			}
		} else if (st.pointers.size === 2) {
			window.clearTimeout(st.longTimer)
			if (st.dragging) release(mode === 'touch' ? (toFb(st.last) ?? cursor.current) : cursor.current, BTN.left)
			st.kind = 'two'
			st.dragging = false
			const t = two()
			st.two = {dist: t.dist, mid: t.mid, view: {...view.current}, type: 'undecided', scrollAcc: 0, scrollAccX: 0, lastMid: t.mid, maxPointers: 2}
			st.startTime = performance.now()
			st.moved = false
		} else {
			st.two.maxPointers = Math.max(st.two.maxPointers, st.pointers.size)
		}
	}

	const onPointerMove = (e: React.PointerEvent) => {
		const st = g.current
		const p = {x: e.clientX, y: e.clientY}
		if (e.pointerType === 'mouse') {
			if (state !== 'connected') return
			const fb = toFb(p)
			if (fb) {
				cursor.current = fb
				send(fb, mask.current)
			}
			return
		}
		if (!st.pointers.has(e.pointerId)) return
		st.pointers.set(e.pointerId, p)

		if (st.kind === 'one') {
			const dx = p.x - st.last.x
			const dy = p.y - st.last.y
			if (!st.moved && Math.hypot(p.x - st.start.x, p.y - st.start.y) > TAP_SLOP) {
				st.moved = true
				window.clearTimeout(st.longTimer)
				if (mode === 'touch') {
					if (st.held) {
						// long-press then drag = drag with the left button
						st.dragging = true
						const fb = toFb(st.start)
						if (fb) {
							cursor.current = fb
							send(fb, 0)
							press(fb, BTN.left)
						}
					} else if (view.current.z > 1.01) st.panning = true
					else {
						st.dragging = true
						const fb = toFb(st.start)
						if (fb) {
							send(fb, 0)
							press(fb, BTN.left)
						}
					}
				}
			}
			if (st.moved) {
				if (mode === 'touch') {
					if (st.panning) applyView({...view.current, x: view.current.x + dx, y: view.current.y + dy})
					else if (st.dragging) {
						const fb = toFb(p)
						if (fb) moveTo(fb)
					}
				} else {
					// Trackpad: relative movement with a little acceleration.
					const fb = fbSize()
					const r = canvasRect()
					if (fb && r?.width) {
						const perPx = fb.w / r.width
						const speed = Math.hypot(dx, dy)
						const accel = 1.2 + Math.min(speed / 12, 1.6)
						const c = cursor.current.x >= 0 ? cursor.current : {x: fb.w / 2, y: fb.h / 2}
						moveTo({
							x: Math.round(Math.min(fb.w - 1, Math.max(0, c.x + dx * perPx * accel))),
							y: Math.round(Math.min(fb.h - 1, Math.max(0, c.y + dy * perPx * accel))),
						})
						follow()
					}
				}
			}
			st.last = p
		} else if (st.kind === 'two' && st.pointers.size >= 2) {
			const t = two()
			const tw = st.two
			const scale = t.dist / Math.max(1, tw.dist)
			const travel = Math.hypot(t.mid.x - tw.mid.x, t.mid.y - tw.mid.y)
			if (tw.type === 'undecided') {
				if (Math.abs(scale - 1) > 0.09) tw.type = 'pinch'
				else if (travel > 12) tw.type = 'scroll'
				if (tw.type !== 'undecided') st.moved = true
			}
			if (tw.type === 'pinch') {
				// Zoom about the starting midpoint and follow the fingers as they move (pan).
				const s = screenRef.current!.getBoundingClientRect()
				const v = tw.view
				const sx = (tw.mid.x - s.left - v.x) / v.z
				const sy = (tw.mid.y - s.top - v.y) / v.z
				const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.z * scale))
				applyView({z, x: t.mid.x - s.left - sx * z, y: t.mid.y - s.top - sy * z})
			} else if (tw.type === 'scroll') {
				tw.scrollAcc += t.mid.y - tw.lastMid.y
				tw.scrollAccX += t.mid.x - tw.lastMid.x
				const at = mode === 'mouse' ? cursor.current : (toFb(t.mid) ?? cursor.current)
				const STEP = 26
				while (Math.abs(tw.scrollAcc) >= STEP) {
					// fingers up = content moves up = scroll down (natural scrolling)
					wheel(at, tw.scrollAcc < 0 ? BTN.wheelDown : BTN.wheelUp)
					tw.scrollAcc -= Math.sign(tw.scrollAcc) * STEP
				}
				while (Math.abs(tw.scrollAccX) >= STEP * 1.5) {
					wheel(at, tw.scrollAccX < 0 ? BTN.wheelRight : BTN.wheelLeft)
					tw.scrollAccX -= Math.sign(tw.scrollAccX) * STEP * 1.5
				}
			}
			tw.lastMid = t.mid
		}
	}

	const onPointerUp = (e: React.PointerEvent) => {
		const st = g.current
		const p = {x: e.clientX, y: e.clientY}
		if (e.pointerType === 'mouse') {
			const fb = toFb(p) ?? cursor.current
			const button = e.button === 2 ? BTN.right : e.button === 1 ? BTN.middle : BTN.left
			release(fb, button)
			return
		}
		if (!st.pointers.has(e.pointerId)) return
		const wasCount = st.pointers.size
		st.pointers.delete(e.pointerId)
		const quick = performance.now() - st.startTime < 280

		if (st.kind === 'one' && wasCount === 1) {
			window.clearTimeout(st.longTimer)
			if (mode === 'touch') {
				const fb = toFb(st.start)
				if (st.dragging) release(toFb(p) ?? cursor.current, BTN.left)
				else if (!st.moved && fb) {
					if (st.held) click(fb, BTN.right)
					else click(fb, BTN.left)
					haptic(5)
				}
			} else {
				if (st.dragging) release(cursor.current, BTN.left)
				else if (!st.moved && quick) {
					click(cursor.current, BTN.left)
					haptic(5)
					st.lastTapTime = performance.now()
				}
			}
			st.kind = 'none'
		} else if (st.kind === 'two') {
			if (st.pointers.size === 0) {
				// Two-finger tap = right-click (three-finger tap = middle).
				if (!st.moved && quick) {
					const at = mode === 'mouse' ? cursor.current : (toFb(st.two.mid) ?? cursor.current)
					click(at, st.two.maxPointers >= 3 ? BTN.middle : BTN.right)
					haptic(10)
				}
				st.kind = 'none'
				// Snap back if the pinch left us just above 100%.
				if (view.current.z < 1.05) applyView({z: 1, x: 0, y: 0}, true)
			}
		}
		if (st.pointers.size === 0) st.kind = 'none'
	}

	const onWheel = (e: React.WheelEvent) => {
		if (state !== 'connected') return
		const p = {x: e.clientX, y: e.clientY}
		if (e.ctrlKey) {
			// trackpad pinch / ctrl+wheel on desktop zooms the view
			zoomAt(view.current.z * Math.exp(-e.deltaY / 200), p)
			return
		}
		const fb = toFb(p)
		if (fb) wheel(fb, e.deltaY > 0 ? BTN.wheelDown : BTN.wheelUp)
	}

	// Mouse-mode buttons: hold the left one to drag with your other finger.
	const holdButton = (button: number) => ({
		onPointerDown: (e: React.PointerEvent) => {
			e.stopPropagation()
			haptic(8)
			press(cursor.current, button)
		},
		onPointerUp: (e: React.PointerEvent) => {
			e.stopPropagation()
			release(cursor.current, button)
		},
		onPointerCancel: () => release(cursor.current, button),
	})

	// ---- keyboard ----------------------------------------------------------------
	const tapKey = (keysym: number) => {
		const rfb = rfbRef.current
		if (!rfb) return
		const held = (Object.keys(mods) as (keyof typeof mods)[]).filter((m) => mods[m])
		for (const m of held) rfb.sendKey(KEY[m], null, true)
		rfb.sendKey(keysym, null, true)
		rfb.sendKey(keysym, null, false)
		for (const m of held.reverse()) rfb.sendKey(KEY[m], null, false)
		if (held.length) setMods({Ctrl: false, Alt: false, Shift: false})
	}
	const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
		const el = e.currentTarget
		for (const ch of el.value) tapKey(ch === '\n' ? KEY.Enter : keysymOf(ch))
		el.value = ''
	}
	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		const special: Record<string, number> = {Backspace: KEY.Backspace, Enter: KEY.Enter, Tab: KEY.Tab, Escape: KEY.Escape, ArrowUp: KEY.Up, ArrowDown: KEY.Down, ArrowLeft: KEY.Left, ArrowRight: KEY.Right}
		if (special[e.key]) {
			e.preventDefault()
			tapKey(special[e.key])
		}
	}
	const toggleKeyboard = () => {
		haptic(8)
		const el = input.current
		if (!el) return
		if (document.activeElement === el) el.blur()
		else el.focus({preventScroll: true})
	}

	const keys: {label: string; sym?: number; mod?: keyof typeof mods}[] = [
		{label: 'esc', sym: KEY.Escape},
		{label: 'tab', sym: KEY.Tab},
		{label: 'ctrl', mod: 'Ctrl'},
		{label: 'alt', mod: 'Alt'},
		{label: 'shift', mod: 'Shift'},
		{label: 'super', sym: KEY.Super},
		{label: '←', sym: KEY.Left},
		{label: '↑', sym: KEY.Up},
		{label: '↓', sym: KEY.Down},
		{label: '→', sym: KEY.Right},
		{label: '⏎', sym: KEY.Enter},
		{label: '⌫', sym: KEY.Backspace},
	]
	const live = state === 'connected'

	return createPortal(
		<div ref={rootRef} className="console" role="dialog" aria-modal="true" aria-label={`${machine.name} console`}>
			<header className="console-bar">
				<button className="round-btn" aria-label="Close console" onClick={onClose}>
					<Icon name="back" size={20} />
				</button>
				<div className="console-title">
					<b>{machine.name}</b>
					<span>
						<i className={`dot ${live ? 'live' : state === 'connecting' ? '' : 'down'}`} />
						{live ? 'Connected' : state === 'connecting' ? 'Connecting…' : state === 'lost' ? 'Reconnecting…' : state === 'superseded' ? 'Opened elsewhere' : 'Unavailable'}
					</span>
				</div>
				<div className="mode-switch" role="radiogroup" aria-label="Input mode">
					<span className="mode-thumb" style={{transform: `translateX(${mode === 'mouse' ? 100 : 0}%)`}} />
					<button role="radio" aria-checked={mode === 'touch'} aria-label="Touch mode: tap where you want to click" onClick={() => setMode('touch')}>
						<Icon name="finger" size={19} />
					</button>
					<button role="radio" aria-checked={mode === 'mouse'} aria-label="Mouse mode: use the screen as a trackpad" onClick={() => setMode('mouse')}>
						<Icon name="mouse" size={19} />
					</button>
				</div>
			</header>

			<div ref={screenRef} className="console-screen">
				<div ref={stageRef} className="console-stage">
					<div ref={canvasHost} className="console-canvas" />
				</div>
				{/* Every touch lands here, above noVNC's canvas, so our gestures decide what the VM gets. */}
				<div
					className="console-touch"
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
					onWheel={onWheel}
					onContextMenu={(e) => e.preventDefault()}
				/>
				<div ref={cursorRef} className={`console-cursor${mode === 'mouse' ? '' : ' hidden'}`} aria-hidden="true">
					<svg width="22" height="22" viewBox="0 0 24 24">
						<path d="M4 2.5v17.2l4.7-4.4 3 6.7 3.1-1.4-3-6.6 6.4-.4z" fill="#fff" stroke="#111" strokeWidth="1.4" strokeLinejoin="round" />
					</svg>
				</div>

				{live && (
					<div className="console-float right" onPointerDown={(e) => e.stopPropagation()}>
						<button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.5)} disabled={zoomLabel <= 100}>
							<Icon name="zoom-out" size={18} />
						</button>
						<button className="pct" aria-label="Fit to screen" onClick={fit}>
							{zoomLabel}%
						</button>
						<button aria-label="Zoom in" onClick={() => zoomBy(1.5)} disabled={zoomLabel >= MAX_ZOOM * 100}>
							<Icon name="zoom-in" size={18} />
						</button>
					</div>
				)}
				{live && mode === 'mouse' && (
					<div className="console-float left mouse-buttons" onPointerDown={(e) => e.stopPropagation()}>
						<button aria-label="Left mouse button (hold to drag)" {...holdButton(BTN.left)}>
							L
						</button>
						<button aria-label="Right mouse button" {...holdButton(BTN.right)}>
							R
						</button>
					</div>
				)}

				{!live && (
					<div className="console-overlay">
						{state === 'connecting' || state === 'lost' ? (
							<span className="spinner" style={{width: 28, height: 28}} />
						) : (
							<>
								<Icon name={state === 'superseded' ? 'machine' : 'alert'} size={34} />
								<b>{state === 'superseded' ? 'This console was opened somewhere else' : 'Console unavailable'}</b>
								{state === 'error' && <span>{message}</span>}
								<button
									className="btn primary small"
									onClick={() => {
										setState('connecting')
										setAttempt((a) => a + 1)
									}}
								>
									{state === 'superseded' ? 'Use it here' : 'Try again'}
								</button>
							</>
						)}
					</div>
				)}
			</div>

			<div className="console-dock">
				<button className={`kbd-btn${keyboardOpen ? ' on' : ''}`} aria-label={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'} aria-pressed={keyboardOpen} disabled={!live} onClick={toggleKeyboard}>
					<Icon name={keyboardOpen ? 'keyboard-hide' : 'keyboard'} size={22} />
				</button>
				<div className="console-keys">
					{keys.map((k) => (
						<button
							key={k.label}
							className={k.mod && mods[k.mod] ? 'on' : ''}
							aria-pressed={k.mod ? mods[k.mod] : undefined}
							disabled={!live}
							onPointerDown={(e) => e.preventDefault()}
							onClick={() => {
								haptic(5)
								if (k.mod) setMods((m) => ({...m, [k.mod!]: !m[k.mod!]}))
								else tapKey(k.sym!)
							}}
						>
							{k.label}
						</button>
					))}
					<button
						className="wide"
						disabled={!live}
						onClick={() => {
							haptic(12)
							rfbRef.current?.sendCtrlAltDel()
						}}
					>
						ctrl alt del
					</button>
				</div>
			</div>
			<textarea
				ref={input}
				className="console-input"
				aria-label="Type into the machine"
				autoCapitalize="off"
				autoCorrect="off"
				autoComplete="off"
				spellCheck={false}
				onInput={onInput}
				onKeyDown={onKeyDown}
				onFocus={() => setKeyboardOpen(true)}
				onBlur={() => setKeyboardOpen(false)}
			/>
		</div>,
		document.body,
	)
}
