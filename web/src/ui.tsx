import {createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode} from 'react'

import type {AppState, Machine} from './api'
import {Icon} from './icons'

// ---- formatting -------------------------------------------------------------
// Storage in decimal units (as drives are sold); memory in binary (16 GB RAM reads as 16 GB).
export function bytes(n: number | undefined, digits = 1, base: 1000 | 1024 = 1000) {
	if (n === undefined || !Number.isFinite(n)) return '–'
	const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
	let i = 0
	while (n >= base && i < units.length - 1) {
		n /= base
		i++
	}
	return `${n.toFixed(n >= 100 || i === 0 ? 0 : digits)} ${units[i]}`
}
export function duration(seconds: number | undefined) {
	if (!seconds) return '–'
	const d = Math.floor(seconds / 86400)
	const h = Math.floor((seconds % 86400) / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}
export const pct = (used: number, total: number) => (total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0)
export const level = (p: number) => (p >= 90 ? 'high' : p >= 70 ? 'mid' : '')
export function initials(name = '') {
	const parts = name.trim().split(/\s+/)
	return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '')).toUpperCase() || '•'
}
export function greeting() {
	const h = new Date().getHours()
	return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

// ---- app status -----------------------------------------------------------
export type StatusKind = 'running' | 'stopped' | 'busy' | 'update' | 'error'
const BUSY: AppState[] = ['installing', 'starting', 'stopping', 'restarting', 'uninstalling', 'updating']
export function appStatus(state: AppState | undefined, hasUpdate = false): {kind: StatusKind; label: string} {
	if (state && BUSY.includes(state)) return {kind: 'busy', label: state}
	if (state === 'stopped') return {kind: 'stopped', label: 'stopped'}
	if (state === 'unknown' || !state) return {kind: 'error', label: 'unknown'}
	if (hasUpdate) return {kind: 'update', label: 'update'}
	return {kind: 'running', label: 'running'}
}
export const isAppBusy = (state?: AppState) => !!state && BUSY.includes(state)
export function machineStatus(state: Machine['state']): {kind: StatusKind; label: string} {
	if (state === 'running') return {kind: 'running', label: 'running'}
	if (state === 'stopped' || state === 'suspended') return {kind: 'stopped', label: state}
	if (state === 'error') return {kind: 'error', label: 'error'}
	return {kind: 'busy', label: state}
}
const STATUS_COLOR: Record<StatusKind, string> = {
	running: 'var(--green)',
	stopped: 'var(--muted)',
	busy: 'var(--blue)',
	update: 'var(--yellow)',
	error: 'var(--red)',
}
export const statusColor = (kind: StatusKind) => STATUS_COLOR[kind]

export function StatusPill({kind, label}: {kind: StatusKind; label: string}) {
	return (
		<span className={`pill${kind === 'busy' ? ' busy' : ''}`} style={{'--c': STATUS_COLOR[kind]} as React.CSSProperties}>
			<i />
			{label}
		</span>
	)
}

// ---- app icon ---------------------------------------------------------------
const ICON_TINTS = ['var(--blue)', 'var(--mauve)', 'var(--teal)', 'var(--peach)', 'var(--pink)', 'var(--green)']
export function AppIcon({src, name, size = 52, badge}: {src?: string; name?: string; size?: number; badge?: StatusKind}) {
	const [failed, setFailed] = useState(false)
	const tint = ICON_TINTS[(name ?? '').length % ICON_TINTS.length]
	return (
		<span
			className="app-icon"
			style={{width: size, height: size, fontSize: size * 0.32, background: failed || !src ? tint : 'var(--bg-3)', color: 'var(--on-accent)'}}
		>
			{src && !failed ? <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} /> : initials(name)}
			{badge && <span className="badge" style={{background: STATUS_COLOR[badge]}} />}
		</span>
	)
}

// ---- bottom sheet -----------------------------------------------------------
export function Sheet({
	open,
	onClose,
	label,
	children,
	tall,
}: {
	open: boolean
	onClose: () => void
	label: string
	children: ReactNode
	tall?: boolean
}) {
	const ref = useRef<HTMLDivElement>(null)
	const start = useRef<number | null>(null)
	const [drag, setDrag] = useState(0)
	useEffect(() => {
		if (!open) return
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
		document.addEventListener('keydown', onKey)
		const prev = document.body.style.overflow
		document.body.style.overflow = 'hidden'
		ref.current?.focus()
		return () => {
			document.removeEventListener('keydown', onKey)
			document.body.style.overflow = prev
		}
	}, [open, onClose])
	if (!open) return null
	// Swipe down on the grabber/header area to dismiss (the close button is the accessible path).
	const onTouchStart = (e: React.TouchEvent) => {
		if ((ref.current?.scrollTop ?? 0) > 0) return
		start.current = e.touches[0].clientY
	}
	const onTouchMove = (e: React.TouchEvent) => {
		if (start.current === null) return
		setDrag(Math.max(0, e.touches[0].clientY - start.current))
	}
	const onTouchEnd = () => {
		if (drag > 110) onClose()
		start.current = null
		setDrag(0)
	}
	return (
		<>
			<button className="scrim" aria-label="Close" onClick={onClose} tabIndex={-1} />
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-label={label}
				tabIndex={-1}
				className={`sheet${tall ? ' tall' : ''}`}
				style={drag ? {transform: `translate(-50%, ${drag}px)`, transition: 'none'} : undefined}
				onTouchStart={onTouchStart}
				onTouchMove={onTouchMove}
				onTouchEnd={onTouchEnd}
			>
				<span className="grabber" />
				{children}
			</div>
		</>
	)
}

export function SheetHeader({icon, title, subtitle, onClose}: {icon?: ReactNode; title: string; subtitle?: ReactNode; onClose: () => void}) {
	return (
		<div className="sheet-head">
			{icon}
			<div className="main">
				<h3>{title}</h3>
				{subtitle && <p>{subtitle}</p>}
			</div>
			<button className="icon-btn" aria-label="Close" onClick={onClose}>
				<Icon name="close" size={18} />
			</button>
		</div>
	)
}

// ---- confirmation -----------------------------------------------------------
type ConfirmOptions = {title: string; body: ReactNode; confirm: string; danger?: boolean}
const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false)
export const useConfirm = () => useContext(ConfirmContext)

// ---- toasts -----------------------------------------------------------------
type Toast = {id: number; text: string; error?: boolean}
const ToastContext = createContext<(text: string, error?: boolean) => void>(() => {})
export const useToast = () => useContext(ToastContext)

export function Providers({children}: {children: ReactNode}) {
	const [toast, setToast] = useState<Toast | null>(null)
	const timer = useRef<number>()
	const show = useCallback((text: string, error = false) => {
		setToast({id: Date.now(), text, error})
		window.clearTimeout(timer.current)
		timer.current = window.setTimeout(() => setToast(null), error ? 4200 : 2400)
	}, [])

	const [pending, setPending] = useState<(ConfirmOptions & {resolve: (v: boolean) => void}) | null>(null)
	const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({...o, resolve})), [])
	const finish = (v: boolean) => {
		pending?.resolve(v)
		setPending(null)
	}

	return (
		<ToastContext.Provider value={show}>
			<ConfirmContext.Provider value={confirm}>
				{children}
				<Sheet open={!!pending} onClose={() => finish(false)} label={pending?.title ?? 'Confirm'}>
					{pending && (
						<>
							<div className="sheet-head">
								{pending.danger && (
									<span className="row-ico" style={{'--c': 'var(--red)'} as React.CSSProperties}>
										<Icon name="alert" size={20} />
									</span>
								)}
								<div className="main">
									<h3>{pending.title}</h3>
								</div>
							</div>
							<div className="prose" style={{marginBottom: 20}}>
								{pending.body}
							</div>
							<div className="stack">
								<button className={`btn block ${pending.danger ? 'danger solid' : 'primary'}`} onClick={() => finish(true)}>
									{pending.confirm}
								</button>
								<button className="btn block ghost" onClick={() => finish(false)}>
									Cancel
								</button>
							</div>
						</>
					)}
				</Sheet>
				{toast && (
					<div key={toast.id} className={`toast${toast.error ? ' error' : ''}`} role="status" aria-live="polite">
						<Icon name={toast.error ? 'alert' : 'check'} size={16} />
						{toast.text}
					</div>
				)}
			</ConfirmContext.Provider>
		</ToastContext.Provider>
	)
}

// ---- preferences ------------------------------------------------------------
export const THEMES = [
	{id: 'mocha', name: 'Catppuccin', bg: '#1e1e2e', fg: '#cdd6f4', dots: ['#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8']},
	{id: 'tokyo', name: 'Tokyo Night', bg: '#1a1b26', fg: '#c0caf5', dots: ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e']},
	{id: 'gruvbox', name: 'Gruvbox', bg: '#282828', fg: '#ebdbb2', dots: ['#83a598', '#b8bb26', '#fabd2f', '#fb4934']},
	{id: 'latte', name: 'Latte (light)', bg: '#eff1f5', fg: '#4c4f69', dots: ['#1e66f5', '#40a02b', '#df8e1d', '#d20f39']},
] as const
export const ACCENTS = ['blue', 'mauve', 'teal', 'peach', 'green'] as const
export type Prefs = {theme: (typeof THEMES)[number]['id']; accent: (typeof ACCENTS)[number]}

export function readPrefs(): Prefs {
	try {
		const p = JSON.parse(localStorage.getItem('umbrel-touch:prefs') ?? '{}')
		return {theme: p.theme ?? 'mocha', accent: p.accent ?? 'blue'}
	} catch {
		return {theme: 'mocha', accent: 'blue'}
	}
}
export function applyPrefs(p: Prefs) {
	document.documentElement.dataset.theme = p.theme
	document.documentElement.style.setProperty('--accent', `var(--${p.accent})`)
	const meta = document.querySelector('meta[name="theme-color"]')
	meta?.setAttribute('content', THEMES.find((t) => t.id === p.theme)?.bg ?? '#1e1e2e')
}
export function usePrefs() {
	const [prefs, setPrefs] = useState<Prefs>(readPrefs)
	useEffect(() => {
		applyPrefs(prefs)
		try {
			localStorage.setItem('umbrel-touch:prefs', JSON.stringify(prefs))
		} catch {
			/* private mode: keep in memory */
		}
	}, [prefs])
	return [prefs, setPrefs] as const
}
