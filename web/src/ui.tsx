import {createPortal} from 'react-dom'
import {createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode} from 'react'

import type {AppState, Machine, Wallpaper} from './api'
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
export const levelColor = (p: number) => (p >= 90 ? 'var(--red)' : p >= 75 ? 'var(--yellow)' : 'var(--green)')
export function initials(name = '') {
	const parts = name.trim().split(/\s+/)
	return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '•'
}
export function greeting() {
	const h = new Date().getHours()
	return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}
export const today = () => new Date().toLocaleDateString(undefined, {weekday: 'long', month: 'long', day: 'numeric'})

// A light tap on Android; iOS Safari has no vibration API and ignores it.
export const haptic = (ms: number | number[] = 8) => {
	try {
		navigator.vibrate?.(ms)
	} catch {
		/* unsupported */
	}
}

// ---- status ---------------------------------------------------------------
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
		<span className={`pill${kind === 'busy' ? ' busy' : ''}`} style={{'--c': STATUS_COLOR[kind]} as CSSProperties}>
			<i />
			{label}
		</span>
	)
}

// ---- app icon ---------------------------------------------------------------
const TINTS = [
	['#6366f1', '#a855f7'],
	['#0ea5e9', '#6366f1'],
	['#14b8a6', '#0ea5e9'],
	['#f97316', '#ef4444'],
	['#ec4899', '#8b5cf6'],
	['#22c55e', '#14b8a6'],
]
export function AppIcon({
	src,
	name,
	size = 56,
	badge,
	dim,
	progress,
}: {
	src?: string
	name?: string
	size?: number
	badge?: StatusKind
	dim?: boolean
	progress?: number | 'spin'
}) {
	const [failed, setFailed] = useState(false)
	const [a, b] = TINTS[[...(name ?? '')].reduce((t, c) => t + c.charCodeAt(0), 0) % TINTS.length]
	const showImg = src && !failed
	const r = size / 2 + 3
	const c = 2 * Math.PI * r
	return (
		<span
			className={`app-icon${dim ? ' dim' : ''}`}
			style={{width: size, height: size, fontSize: size * 0.36, background: showImg ? 'rgba(255,255,255,.92)' : `linear-gradient(140deg, ${a}, ${b})`}}
		>
			{showImg ? (
				<img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} draggable={false} />
			) : (
				<span className="initials">{initials(name)}</span>
			)}
			{progress !== undefined && (
				<svg className={`busy-ring${progress === 'spin' ? ' spin' : ''}`} viewBox={`0 0 ${size + 10} ${size + 10}`} aria-hidden="true">
					<circle cx={size / 2 + 5} cy={size / 2 + 5} r={r} fill="none" stroke="rgba(255,255,255,.2)" strokeWidth="2.5" />
					<circle
						cx={size / 2 + 5}
						cy={size / 2 + 5}
						r={r}
						fill="none"
						stroke="var(--accent-text)"
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeDasharray={c}
						strokeDashoffset={progress === 'spin' ? c * 0.72 : c * (1 - Math.max(0.04, progress / 100))}
					/>
				</svg>
			)}
			{badge && <span className="badge" style={{background: STATUS_COLOR[badge]}} />}
		</span>
	)
}

// ---- ring gauge -------------------------------------------------------------
export function Ring({value, color, children, size = 84, label}: {value: number; color: string; children: ReactNode; size?: number; label: string}) {
	const stroke = 8
	const r = (size - stroke) / 2
	const c = 2 * Math.PI * r
	const [shown, setShown] = useState(0)
	useEffect(() => {
		const id = requestAnimationFrame(() => setShown(value))
		return () => cancelAnimationFrame(id)
	}, [value])
	return (
		<div className="ring" style={{width: size, height: size, color}} role="meter" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
			<svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
				<circle className="track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
				<circle
					className="value"
					cx={size / 2}
					cy={size / 2}
					r={r}
					fill="none"
					stroke="currentColor"
					strokeWidth={stroke}
					strokeLinecap="round"
					strokeDasharray={c}
					strokeDashoffset={c * (1 - Math.max(0.005, shown / 100))}
				/>
			</svg>
			<div className="center">{children}</div>
		</div>
	)
}

// ---- segmented control ------------------------------------------------------
export function Segmented<T extends string>({
	value,
	options,
	onChange,
	label,
}: {
	value: T
	options: {id: T; label: string; count?: number}[]
	onChange: (v: T) => void
	label: string
}) {
	const index = Math.max(0, options.findIndex((o) => o.id === value))
	return (
		<div className="segmented glass" role="tablist" aria-label={label}>
			<span className="thumb" style={{width: `calc((100% - 8px) / ${options.length})`, transform: `translateX(${index * 100}%)`}} />
			{options.map((o) => (
				<button
					key={o.id}
					role="tab"
					aria-selected={o.id === value}
					onClick={() => {
						haptic(5)
						onChange(o.id)
					}}
				>
					{o.label}
					{o.count !== undefined && <span className="n">{o.count}</span>}
				</button>
			))}
		</div>
	)
}

// ---- bottom sheet -----------------------------------------------------------
export function Sheet({open, onClose, label, children, tall}: {open: boolean; onClose: () => void; label: string; children: ReactNode; tall?: boolean}) {
	const ref = useRef<HTMLDivElement>(null)
	const start = useRef<{y: number; t: number} | null>(null)
	const [drag, setDrag] = useState(0)
	useEffect(() => {
		if (!open) return
		const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
		document.addEventListener('keydown', onKey)
		const prev = document.body.style.overflow
		document.body.style.overflow = 'hidden'
		ref.current?.focus({preventScroll: true})
		return () => {
			document.removeEventListener('keydown', onKey)
			document.body.style.overflow = prev
		}
	}, [open, onClose])
	if (!open) return null
	// Swipe down to dismiss when the sheet is scrolled to the top (the close button is the accessible path).
	const onTouchStart = (e: React.TouchEvent) => {
		if ((ref.current?.scrollTop ?? 0) > 0) return
		const target = e.target as HTMLElement
		if (target.closest('.logs, .gallery, input, textarea')) return
		start.current = {y: e.touches[0].clientY, t: Date.now()}
	}
	const onTouchMove = (e: React.TouchEvent) => {
		if (!start.current) return
		const dy = e.touches[0].clientY - start.current.y
		setDrag(dy > 0 ? dy : dy / 6)
	}
	const onTouchEnd = () => {
		if (!start.current) return
		const velocity = drag / Math.max(1, Date.now() - start.current.t)
		if (drag > 120 || (drag > 40 && velocity > 0.6)) {
			haptic(6)
			onClose()
		}
		start.current = null
		setDrag(0)
	}
	// Portalled to <body> so a transformed/animated ancestor can't re-anchor position: fixed.
	return createPortal(
		<>
			<button className="scrim" aria-label="Close" onClick={onClose} tabIndex={-1} style={drag > 0 ? {opacity: Math.max(0.2, 1 - drag / 400)} : undefined} />
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
		</>,
		document.body,
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
				<Icon name="close" size={18} stroke={2.2} />
			</button>
		</div>
	)
}

export function KV({rows}: {rows: [string, ReactNode][]}) {
	return (
		<div className="kv glass group" style={{borderRadius: 18}}>
			{rows.map(([k, v]) => (
				<div className="row static" key={k}>
					<span className="k">{k}</span>
					<span className="v">{v}</span>
				</div>
			))}
		</div>
	)
}

// ---- confirmation & toasts ----------------------------------------------------
type ConfirmOptions = {title: string; body: ReactNode; confirm: string; danger?: boolean; icon?: Parameters<typeof Icon>[0]['name']}
const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false)
export const useConfirm = () => useContext(ConfirmContext)

type Toast = {id: number; text: string; error?: boolean}
const ToastContext = createContext<(text: string, error?: boolean) => void>(() => {})
export const useToast = () => useContext(ToastContext)

export function Providers({children}: {children: ReactNode}) {
	const [toast, setToast] = useState<Toast | null>(null)
	const timer = useRef<number>()
	const show = useCallback((text: string, error = false) => {
		haptic(error ? [20, 40, 20] : 10)
		setToast({id: Date.now(), text, error})
		window.clearTimeout(timer.current)
		timer.current = window.setTimeout(() => setToast(null), error ? 4500 : 2600)
	}, [])

	const [pending, setPending] = useState<(ConfirmOptions & {resolve: (v: boolean) => void}) | null>(null)
	const confirm = useCallback((o: ConfirmOptions) => {
		haptic(10)
		return new Promise<boolean>((resolve) => setPending({...o, resolve}))
	}, [])
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
						<div style={{textAlign: 'center', padding: '6px 4px 0'}}>
							<span
								className="row-ico"
								style={{width: 56, height: 56, borderRadius: 18, margin: '0 auto 16px', '--c': pending.danger ? 'var(--red)' : 'var(--accent)'} as CSSProperties}
							>
								<Icon name={pending.icon ?? (pending.danger ? 'alert' : 'info')} size={28} />
							</span>
							<h3 style={{margin: '0 0 8px', fontSize: 21, fontWeight: 700, letterSpacing: '-0.02em'}}>{pending.title}</h3>
							<div className="prose" style={{marginBottom: 24}}>
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
						</div>
					)}
				</Sheet>
				{toast && (
					<div key={toast.id} className={`toast${toast.error ? ' error' : ''}`} role="status" aria-live="polite">
						<span className="ico">
							<Icon name={toast.error ? 'alert' : 'check'} size={15} stroke={2.6} />
						</span>
						{toast.text}
					</div>
				)}
			</ConfirmContext.Provider>
		</ToastContext.Provider>
	)
}

// ---- appearance ---------------------------------------------------------------
export const THEMES = [
	{id: 'umbrel', name: 'umbrelOS', bg: '#111', fg: '#fff', dots: [] as string[], wallpaper: true},
	{id: 'mocha', name: 'Catppuccin', bg: '#1e1e2e', fg: '#cdd6f4', dots: ['#89b4fa', '#a6e3a1', '#f9e2af', '#f38ba8']},
	{id: 'tokyo', name: 'Tokyo Night', bg: '#1a1b26', fg: '#c0caf5', dots: ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e']},
	{id: 'gruvbox', name: 'Gruvbox', bg: '#282828', fg: '#ebdbb2', dots: ['#83a598', '#b8bb26', '#fabd2f', '#fb4934']},
	{id: 'latte', name: 'Latte', bg: '#eff1f5', fg: '#4c4f69', dots: ['#1e66f5', '#40a02b', '#df8e1d', '#d20f39']},
] as const
export const ACCENTS = ['wallpaper', 'blue', 'mauve', 'teal', 'peach', 'green', 'pink'] as const
export type ThemeId = (typeof THEMES)[number]['id']
export type Prefs = {theme: ThemeId; accent: (typeof ACCENTS)[number]}
const DEFAULT_PREFS: Prefs = {theme: 'umbrel', accent: 'wallpaper'}

export function readPrefs(): Prefs {
	try {
		const p = JSON.parse(localStorage.getItem('umbrel-touch:prefs') ?? '{}')
		const theme = THEMES.some((t) => t.id === p.theme) ? p.theme : DEFAULT_PREFS.theme
		const accent = (ACCENTS as readonly string[]).includes(p.accent) ? p.accent : DEFAULT_PREFS.accent
		return {theme, accent}
	} catch {
		return DEFAULT_PREFS
	}
}

const FALLBACK_BRAND = '24 90% 50%' // umbrelOS's default wallpaper colour
export function applyPrefs(p: Prefs, brandHsl?: string | null) {
	const root = document.documentElement
	root.dataset.theme = p.theme
	const light = p.theme === 'latte'
	if (p.accent === 'wallpaper') {
		const [h, s, l] = (brandHsl ?? FALLBACK_BRAND).split(' ').map((v) => parseFloat(v))
		root.style.setProperty('--accent', `hsl(${h} ${s}% ${l}%)`)
		root.style.setProperty('--accent-text', `hsl(${h} ${Math.min(s, 95)}% ${light ? Math.min(l, 42) : Math.max(l, 66)}%)`)
		root.style.setProperty('--on-accent', '#fff')
	} else {
		root.style.setProperty('--accent', `var(--${p.accent})`)
		root.style.setProperty('--accent-text', `var(--${p.accent})`)
		root.style.setProperty('--on-accent', light ? '#fff' : '#111')
	}
	const meta = document.querySelector('meta[name="theme-color"]')
	meta?.setAttribute('content', THEMES.find((t) => t.id === p.theme)?.bg ?? '#111')
}

export function usePrefs(brandHsl?: string | null) {
	const [prefs, setPrefs] = useState<Prefs>(readPrefs)
	useLayoutEffect(() => {
		applyPrefs(prefs, brandHsl)
		try {
			localStorage.setItem('umbrel-touch:prefs', JSON.stringify(prefs))
		} catch {
			/* private mode: keep in memory */
		}
	}, [prefs, brandHsl])
	return [prefs, setPrefs] as const
}

// ---- backdrop -----------------------------------------------------------------
export const wallpaperUrl = (w?: Wallpaper | null) => (w?.id ? `/api/umbrel-wallpaper/${w.id}` : null)

export function Backdrop({wallpaper, theme}: {wallpaper?: Wallpaper | null; theme: ThemeId}) {
	const url = theme === 'umbrel' ? wallpaperUrl(wallpaper) : null
	const [ready, setReady] = useState<string | null>(null)
	useEffect(() => {
		if (!url) return
		const img = new Image()
		img.onload = () => setReady(url)
		img.src = url
	}, [url])
	return (
		<div className="backdrop" aria-hidden="true">
			{url ? (
				<>
					<div className={`wall${ready === url ? ' ready' : ''}`} style={{backgroundImage: `url(${url})`}} />
					<div className="shade" />
				</>
			) : (
				<div className="aurora" />
			)}
		</div>
	)
}
