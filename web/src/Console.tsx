// Full-screen VM console. The picture and input travel as raw VNC over a WebSocket
// to the Touch server, which bridges it to umbreld (see server/app.mjs).
import {useEffect, useRef, useState} from 'react'
import {createPortal} from 'react-dom'
import * as RFBModule from '@novnc/novnc/lib/rfb.js'

import type {Machine} from './api'
import {Icon} from './icons'
import {haptic} from './ui'

type RFBClass = typeof import('@novnc/novnc/lib/rfb.js').default
// noVNC ships CommonJS; depending on the bundler the class is the default or default.default.
const RFB: RFBClass = ((RFBModule as any).default?.default ?? (RFBModule as any).default) as RFBClass

const SUPERSEDED = 4001
const KEY = {Escape: 0xff1b, Tab: 0xff09, Enter: 0xff0d, Backspace: 0xff08, Up: 0xff52, Down: 0xff54, Left: 0xff51, Right: 0xff53, Ctrl: 0xffe3, Alt: 0xffe9, Super: 0xffeb}
const keysymOf = (ch: string) => {
	const cp = ch.codePointAt(0)!
	return cp < 0x100 ? cp : 0x01000000 | cp
}

type State = 'connecting' | 'connected' | 'lost' | 'superseded' | 'error'

export function Console({machine, onClose}: {machine: Machine; onClose: () => void}) {
	const screen = useRef<HTMLDivElement>(null)
	const input = useRef<HTMLTextAreaElement>(null)
	const rfbRef = useRef<InstanceType<RFBClass>>()
	const [state, setState] = useState<State>('connecting')
	const [message, setMessage] = useState('')
	const [mods, setMods] = useState<{Ctrl: boolean; Alt: boolean}>({Ctrl: false, Alt: false})
	const [attempt, setAttempt] = useState(0)

	useEffect(() => {
		let disposed = false
		let retry: number | undefined
		let rfb: InstanceType<RFBClass> | undefined
		let socket: WebSocket | undefined

		const connect = async () => {
			if (disposed || !screen.current) return
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
			screen.current.replaceChildren()
			const r = new RFB(screen.current, socket, {shared: true})
			rfb = r
			rfbRef.current = r
			r.scaleViewport = true
			r.resizeSession = false
			r.focusOnClick = false // the on-screen keyboard is opened explicitly, not on every tap
			r.background = '#000'
			r.addEventListener('connect', () => {
				setState('connected')
				haptic(8)
			})
			r.addEventListener('disconnect', (e) => {
				if (disposed) return
				if (closeCode === SUPERSEDED) return setState('superseded')
				if ((e as CustomEvent<{clean: boolean}>).detail.clean) return setState('lost')
				setState('lost')
				retry = window.setTimeout(connect, 1500)
			})
		}
		connect()

		const prev = document.body.style.overflow
		document.body.style.overflow = 'hidden'
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
			document.body.style.overflow = prev
		}
	}, [machine.id, attempt])

	const press = (keysym: number) => {
		const rfb = rfbRef.current
		if (!rfb) return
		const held = (Object.keys(mods) as (keyof typeof mods)[]).filter((m) => mods[m])
		for (const m of held) rfb.sendKey(KEY[m], null, true)
		rfb.sendKey(keysym, null, true)
		rfb.sendKey(keysym, null, false)
		for (const m of held.reverse()) rfb.sendKey(KEY[m], null, false)
		if (held.length) setMods({Ctrl: false, Alt: false})
	}
	const tap = (keysym: number) => {
		haptic(5)
		press(keysym)
	}

	// The phone keyboard types into a hidden field; each character is forwarded as a key press.
	const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
		const el = e.currentTarget
		for (const ch of el.value) press(ch === '\n' ? KEY.Enter : keysymOf(ch))
		el.value = ''
	}
	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		const special: Record<string, number> = {Backspace: KEY.Backspace, Enter: KEY.Enter, Tab: KEY.Tab, Escape: KEY.Escape, ArrowUp: KEY.Up, ArrowDown: KEY.Down, ArrowLeft: KEY.Left, ArrowRight: KEY.Right}
		if (special[e.key]) {
			e.preventDefault()
			press(special[e.key])
		}
	}
	const toggleKeyboard = () => {
		haptic(6)
		const el = input.current
		if (!el) return
		if (document.activeElement === el) el.blur()
		else el.focus({preventScroll: true})
	}
	const cad = () => {
		haptic(12)
		rfbRef.current?.sendCtrlAltDel()
	}

	const keys: {label: string; sym?: number; mod?: 'Ctrl' | 'Alt'; icon?: boolean}[] = [
		{label: 'esc', sym: KEY.Escape},
		{label: 'tab', sym: KEY.Tab},
		{label: 'ctrl', mod: 'Ctrl'},
		{label: 'alt', mod: 'Alt'},
		{label: '←', sym: KEY.Left},
		{label: '↑', sym: KEY.Up},
		{label: '↓', sym: KEY.Down},
		{label: '→', sym: KEY.Right},
		{label: 'super', sym: KEY.Super},
	]

	return createPortal(
		<div className="console" role="dialog" aria-modal="true" aria-label={`${machine.name} console`}>
			<header className="console-bar">
				<button className="round-btn" aria-label="Close console" onClick={onClose}>
					<Icon name="back" size={20} />
				</button>
				<div className="console-title">
					<b>{machine.name}</b>
					<span>
						<i className={`dot ${state === 'connected' ? 'live' : state === 'connecting' ? '' : 'down'}`} />
						{state === 'connected' ? 'Connected' : state === 'connecting' ? 'Connecting…' : state === 'lost' ? 'Reconnecting…' : state === 'superseded' ? 'Opened elsewhere' : 'Unavailable'}
					</span>
				</div>
				<button className="round-btn" aria-label="Keyboard" onClick={toggleKeyboard} disabled={state !== 'connected'}>
					<Icon name="keyboard" size={20} />
				</button>
			</header>

			<div className="console-screen">
				<div ref={screen} className="console-canvas" />
				{state !== 'connected' && (
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

			<div className="console-keys">
				{keys.map((k) => (
					<button
						key={k.label}
						className={k.mod && mods[k.mod] ? 'on' : ''}
						aria-pressed={k.mod ? mods[k.mod] : undefined}
						disabled={state !== 'connected'}
						onClick={() => (k.mod ? (haptic(5), setMods((m) => ({...m, [k.mod!]: !m[k.mod!]}))) : tap(k.sym!))}
					>
						{k.label}
					</button>
				))}
				<button className="wide" disabled={state !== 'connected'} onClick={cad}>
					ctrl+alt+del
				</button>
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
			/>
		</div>,
		document.body,
	)
}
