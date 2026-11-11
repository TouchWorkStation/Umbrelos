// Desktop mode: a full desktop in the style of Ubuntu (GNOME) for wide screens with a mouse.
// Top bar (Activities, clock + notifications, system menu), a dock on the left, freely movable
// and resizable windows with snapping, and an Activities overview. Every window reuses the
// same screens as the phone layout, so all functionality stays identical.
import {createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode} from 'react'
import {useQueryClient} from '@tanstack/react-query'

import {logout, mutate, type Bootstrap, type UserApp} from '../api'
import {AppSheet} from '../AppSheet'
import {Console} from '../Console'
import {appUrl, useAction, useApps, useBootstrap, useCpu, useMachines, useMemory, useNotifications, useUpdates, useUser} from '../data'
import {Icon, type IconName} from '../icons'
import {Apps} from '../screens/Apps'
import {Files} from '../screens/Files'
import {Machines} from '../screens/Machines'
import {More} from '../screens/More'
import {Settings} from '../screens/Settings'
import {Store} from '../screens/Store'
import {TerminalScreen} from '../Terminal'
import {AppIcon, InWindow, PortalRoot, StoreIcon, TerminalIcon, setLayoutPref, useConfirm, useToast, type Prefs} from '../ui'

// ---- model ---------------------------------------------------------------------------------
type Kind = 'files' | 'apps' | 'store' | 'terminal' | 'machines' | 'system' | 'settings' | 'console' | 'app'
type Payload = {appId?: string; machineId?: string; term?: {id: string; name?: string; icon?: string}}
type Snap = 'max' | 'left' | 'right' | null
type Rect = {x: number; y: number; w: number; h: number}
type Win = Rect & {id: string; kind: Kind; key: string; payload?: Payload; z: number; min: boolean; snap: Snap; born: number}

const TOP = 34 // top bar height
const DOCK = 74 // dock width
const MIN_W = 380
const MIN_H = 260

const SYS: Record<Exclude<Kind, 'app' | 'console'>, {title: string; icon?: IconName; bg?: string; w: number; h: number; multi?: boolean}> = {
	files: {title: 'Files', icon: 'folder-filled', bg: 'linear-gradient(150deg,#7cb4ff,#2563eb 70%)', w: 960, h: 660, multi: true},
	apps: {title: 'Apps', icon: 'apps-filled', bg: 'linear-gradient(150deg,#c4b5fd,#7c3aed 70%)', w: 800, h: 680},
	store: {title: 'App Store', w: 1040, h: 720},
	terminal: {title: 'Terminal', w: 860, h: 540, multi: true},
	machines: {title: 'Machines', icon: 'machine-filled', bg: 'linear-gradient(150deg,#5eead4,#0f766e 70%)', w: 820, h: 640},
	system: {title: 'System Monitor', icon: 'activity-filled', bg: 'linear-gradient(150deg,#fdba74,#c2410c 70%)', w: 820, h: 720},
	settings: {title: 'Settings', icon: 'settings', bg: 'linear-gradient(150deg,#cbd5e1,#475569 70%)', w: 760, h: 720},
}
const FAVORITES: Exclude<Kind, 'app' | 'console'>[] = ['files', 'apps', 'store', 'terminal', 'machines', 'system', 'settings']
const STORE_KEY = 'umbrel-touch:desktop'
const PIN_KEY = 'umbrel-touch:desktop-pins'

const keyOf = (kind: Kind, p?: Payload) => (kind === 'app' ? `app:${p?.appId}` : kind === 'console' ? `console:${p?.machineId}` : kind)

function SysIcon({kind, size = 44}: {kind: Kind; size?: number}) {
	if (kind === 'store') return <StoreIcon size={size} />
	if (kind === 'terminal') return <TerminalIcon size={size} />
	if (kind === 'console') return <span className="app-icon" style={{width: size, height: size, background: 'linear-gradient(150deg,#5eead4,#0f766e 70%)'}}><Icon name="machine" size={size * 0.5} /></span>
	const s = SYS[kind as keyof typeof SYS]
	return (
		<span className="app-icon" style={{width: size, height: size, background: s?.bg}}>
			<Icon name={s?.icon ?? 'window'} size={size * 0.52} stroke={1.8} />
		</span>
	)
}

// ---- context: lets screens open things as windows ----------------------------------------------
type DesktopApi = {
	open: (kind: Kind, payload?: Payload, opts?: {newWindow?: boolean}) => void
	launch: (app: UserApp) => void
	openConsole: (machineId: string) => void
	openTerminal: (app?: {id: string; name?: string; icon?: string}) => void
	close: (id: string) => void
}
const DesktopContext = createContext<DesktopApi | null>(null)
export const useDesktop = () => useContext(DesktopContext)

// ---- persistence ----------------------------------------------------------------------------
function load<T>(key: string, fallback: T): T {
	try {
		const v = localStorage.getItem(key)
		return v ? (JSON.parse(v) as T) : fallback
	} catch {
		return fallback
	}
}
function save(key: string, v: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(v))
	} catch {
		/* storage full or private mode */
	}
}

function useViewport() {
	const [vp, setVp] = useState({w: window.innerWidth, h: window.innerHeight})
	useEffect(() => {
		const on = () => setVp({w: window.innerWidth, h: window.innerHeight})
		window.addEventListener('resize', on)
		return () => window.removeEventListener('resize', on)
	}, [])
	return vp
}

const snapRect = (snap: Exclude<Snap, null>, vp: {w: number; h: number}): Rect => {
	const w = vp.w - DOCK
	const h = vp.h - TOP
	if (snap === 'left') return {x: DOCK, y: TOP, w: Math.floor(w / 2), h}
	if (snap === 'right') return {x: DOCK + Math.floor(w / 2), y: TOP, w: Math.ceil(w / 2), h}
	return {x: DOCK, y: TOP, w, h}
}
const rectOf = (win: Win, vp: {w: number; h: number}): Rect => (win.snap ? snapRect(win.snap, vp) : {x: win.x, y: win.y, w: win.w, h: win.h})

// ---- the desktop -------------------------------------------------------------------------------
export function Desktop({boot, prefs, setPrefs, onSignedOut}: {boot: Bootstrap; prefs: Prefs; setPrefs: (p: Prefs) => void; onSignedOut: () => void}) {
	const vp = useViewport()
	const user = useUser()
	const apps = useApps()
	const owner = user.data?.role !== 'member'
	const [wins, setWins] = useState<Win[]>(() => load<Win[]>(STORE_KEY, []).filter((w) => w.kind !== 'terminal' && w.kind !== 'console'))
	const [pins, setPins] = useState<string[]>(() => load<string[]>(PIN_KEY, []))
	const [overview, setOverview] = useState<null | 'windows' | 'apps'>(null)
	const [menu, setMenu] = useState<null | 'clock' | 'system' | {key: string; x: number; y: number}>(null)
	const [preview, setPreview] = useState<Rect | null>(null)
	const [dragging, setDragging] = useState(false)
	const zTop = useRef(Math.max(10, ...wins.map((w) => w.z)))
	const winsRef = useRef(wins)
	winsRef.current = wins

	useEffect(() => save(STORE_KEY, wins.filter((w) => w.kind !== 'terminal' && w.kind !== 'console')), [wins])
	useEffect(() => save(PIN_KEY, pins), [pins])
	useEffect(() => {
		document.documentElement.classList.add('desk-mode')
		return () => document.documentElement.classList.remove('desk-mode')
	}, [])

	const visible = wins.filter((w) => !w.min)
	const active = visible.length ? visible.reduce((a, b) => (b.z > a.z ? b : a)) : null

	// -- window operations --
	const focus = useCallback((id: string) => {
		setWins((ws) => {
			const w = ws.find((x) => x.id === id)
			if (!w) return ws
			const top = ws.every((x) => x.id === id || x.min || x.z < w.z)
			if (top && !w.min) return ws
			zTop.current += 1
			return ws.map((x) => (x.id === id ? {...x, z: zTop.current, min: false} : x))
		})
	}, [])
	const update = useCallback((id: string, patch: Partial<Win>) => setWins((ws) => ws.map((w) => (w.id === id ? {...w, ...patch} : w))), [])
	const close = useCallback((id: string) => setWins((ws) => ws.filter((w) => w.id !== id)), [])
	const minimize = useCallback((id: string) => update(id, {min: true}), [update])

	const open = useCallback<DesktopApi['open']>(
		(kind, payload, opts) => {
			setOverview(null)
			setMenu(null)
			const key = keyOf(kind, payload)
			const multi = kind === 'files' || kind === 'terminal'
			const existing = winsRef.current.filter((w) => w.key === key).sort((a, b) => b.z - a.z)[0]
			if (existing && !(multi && opts?.newWindow)) {
				focus(existing.id)
				return
			}
			const def = kind === 'app' ? {w: 1140, h: 760} : kind === 'console' ? {w: 1060, h: 720} : SYS[kind as keyof typeof SYS]
			const areaW = window.innerWidth - DOCK
			const areaH = window.innerHeight - TOP
			const w = Math.max(MIN_W, Math.min(def.w, areaW - 48))
			const h = Math.max(MIN_H, Math.min(def.h, areaH - 40))
			const n = winsRef.current.filter((x) => !x.min).length
			const off = (n % 6) * 30
			const x = Math.min(DOCK + Math.max(16, (areaW - w) / 2) + off - 60, window.innerWidth - w - 8)
			const y = Math.min(TOP + Math.max(12, (areaH - h) / 2) + off - 30, window.innerHeight - h - 8)
			zTop.current += 1
			const win: Win = {id: Math.random().toString(36).slice(2, 10), kind, key, payload, x: Math.max(DOCK + 8, x), y: Math.max(TOP + 8, y), w, h, z: zTop.current, min: false, snap: null, born: Date.now()}
			setWins((ws) => [...ws, win])
		},
		[focus],
	)
	const api = useMemo<DesktopApi>(
		() => ({
			open,
			launch: (app) => {
				mutate('apps.trackOpen', {appId: app.id}).catch(() => {})
				open('app', {appId: app.id})
			},
			openConsole: (machineId) => open('console', {machineId}),
			openTerminal: (term) => open('terminal', term ? {term} : undefined, {newWindow: true}),
			close,
		}),
		[open, close],
	)

	// Clicking into an app's iframe doesn't reach our handlers; notice the focus moving to it.
	useEffect(() => {
		const onBlur = () =>
			window.setTimeout(() => {
				const el = document.activeElement
				if (el?.tagName === 'IFRAME') {
					const id = (el.closest('.win') as HTMLElement | null)?.dataset.id
					if (id) focus(id)
				}
			}, 0)
		window.addEventListener('blur', onBlur)
		return () => window.removeEventListener('blur', onBlur)
	}, [focus])

	// Keyboard: Super taps toggle Activities, Ctrl+Alt+T opens a terminal, Escape leaves menus.
	useEffect(() => {
		let superAlone = false
		const down = (e: KeyboardEvent) => {
			if (e.key === 'Meta' || e.key === 'OS') superAlone = true
			else superAlone = false
			if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 't' && owner) {
				e.preventDefault()
				api.openTerminal()
			}
			if (e.key === 'Escape') {
				setMenu(null)
				setOverview(null)
			}
		}
		const up = (e: KeyboardEvent) => {
			if ((e.key === 'Meta' || e.key === 'OS') && superAlone) setOverview((o) => (o ? null : 'windows'))
			superAlone = false
		}
		window.addEventListener('keydown', down)
		window.addEventListener('keyup', up)
		return () => {
			window.removeEventListener('keydown', down)
			window.removeEventListener('keyup', up)
		}
	}, [api, owner])

	// -- dock entries: favorites, then pinned and running Umbrel apps --
	const appList = apps.data ?? []
	const runningAppIds = [...new Set(wins.filter((w) => w.kind === 'app').map((w) => w.payload!.appId!))]
	const dockApps = [...pins, ...runningAppIds.filter((id) => !pins.includes(id))].map((id) => appList.find((a) => a.id === id)).filter(Boolean) as UserApp[]
	const consoles = [...new Set(wins.filter((w) => w.kind === 'console').map((w) => w.key))]
	const dockClick = (key: string, launch: () => void) => {
		setMenu(null)
		setOverview(null)
		const mine = wins.filter((w) => w.key === key)
		if (!mine.length) return launch()
		const top = mine.reduce((a, b) => (b.z > a.z ? b : a))
		if (active && active.key === key && !top.min) mine.forEach((w) => minimize(w.id))
		else {
			// bring every window of this app forward, most recent last
			;[...mine].sort((a, b) => a.z - b.z).forEach((w) => focus(w.id))
		}
	}

	const confirm = useConfirm()
	const toast = useToast()
	const qc = useQueryClient()
	const power = async (kind: 'restart' | 'shutdown') => {
		setMenu(null)
		const ok = await confirm({
			title: kind === 'restart' ? 'Restart your Umbrel?' : 'Shut down your Umbrel?',
			body:
				kind === 'restart'
					? 'All apps and machines stop, then come back once umbrelOS has restarted. This takes a few minutes.'
					: 'All apps and machines stop. You’ll need to turn the Umbrel back on yourself (for a VM, from FygoNAS).',
			confirm: kind === 'restart' ? 'Restart' : 'Shut down',
			danger: true,
			icon: kind === 'restart' ? 'restart' : 'power',
		})
		if (!ok) return
		try {
			await mutate(`system.${kind}`)
			toast(kind === 'restart' ? 'Your Umbrel is restarting' : 'Your Umbrel is shutting down')
		} catch (e) {
			toast((e as Error).message, true)
		}
	}
	const signOut = async () => {
		setMenu(null)
		if (!(await confirm({title: 'Sign out?', body: 'This browser is signed out and removed from your Umbrel’s devices.', confirm: 'Sign out', icon: 'signout'}))) return
		await logout().catch(() => {})
		qc.clear()
		onSignedOut()
	}

	const ctxMenu = menu && typeof menu === 'object' ? menu : null
	const ctxApp = ctxMenu?.key.startsWith('app:') ? appList.find((a) => a.id === ctxMenu.key.slice(4)) : undefined

	return (
		<DesktopContext.Provider value={api}>
			<div className={`desk${dragging ? ' dragging' : ''}${overview ? ` overview-on ov-${overview}` : ''}`} onContextMenu={(e) => e.target === e.currentTarget && e.preventDefault()}>
				<TopBar
					boot={boot}
					active={active}
					appList={appList}
					overview={!!overview}
					menu={typeof menu === 'string' ? menu : null}
					setMenu={(m) => setMenu(m)}
					toggleOverview={() => setOverview((o) => (o ? null : 'windows'))}
					onPower={power}
					onSignOut={signOut}
					onSettings={() => open('settings')}
					onSystem={() => open('system')}
				/>

				{wins.length === 0 && !overview && (
					<div className="desk-hint">
						<b>{boot.umbrel?.device ?? 'Umbrel'}</b>
						<span>Open something from the dock, or press Activities.</span>
					</div>
				)}

				{wins.map((w) => (
					<WindowFrame
						key={w.id}
						win={w}
						vp={vp}
						active={active?.id === w.id}
						overviewSlot={overview === 'windows' ? overviewSlot(w, visible, vp) : null}
						appList={appList}
						onFocus={focus}
						onUpdate={update}
						onClose={close}
						onMinimize={minimize}
						onPreview={setPreview}
						onDragging={setDragging}
						onOverviewPick={(id) => {
							focus(id)
							setOverview(null)
						}}
					>
						<WindowContent win={w} prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} owner={owner} />
					</WindowFrame>
				))}

				{preview && <div className="snap-preview" style={{left: preview.x, top: preview.y, width: preview.w, height: preview.h}} />}

				<nav className="desk-dock" aria-label="Dock">
					<div className="dock-apps">
						{FAVORITES.filter((k) => k !== 'terminal' || owner).map((k) => (
							<DockItem
								key={k}
								label={SYS[k].title}
								count={wins.filter((w) => w.key === k).length}
								focused={active?.key === k}
								onClick={() => dockClick(k, () => open(k))}
								onContext={(x, y) => setMenu({key: k, x, y})}
							>
								<SysIcon kind={k} size={44} />
							</DockItem>
						))}
						{(dockApps.length > 0 || consoles.length > 0) && <span className="dock-sep" />}
						{dockApps.map((a) => (
							<DockItem
								key={a.id}
								label={a.name ?? a.id}
								count={wins.filter((w) => w.key === `app:${a.id}`).length}
								focused={active?.key === `app:${a.id}`}
								onClick={() => dockClick(`app:${a.id}`, () => api.launch(a))}
								onContext={(x, y) => setMenu({key: `app:${a.id}`, x, y})}
							>
								<AppIcon src={a.icon} name={a.name ?? a.id} size={44} />
							</DockItem>
						))}
						{consoles.map((key) => (
							<ConsoleDockItem key={key} k={key} wins={wins} active={active} onClick={() => dockClick(key, () => {})} onContext={(x, y) => setMenu({key, x, y})} />
						))}
					</div>
					<DockItem label="Show Applications" count={0} focused={overview === 'apps'} onClick={() => setOverview((o) => (o === 'apps' ? null : 'apps'))}>
						<span className="show-apps">
							<Icon name="show-apps" size={26} />
						</span>
					</DockItem>
				</nav>

				{overview && <Overview mode={overview} setMode={setOverview} appList={appList} owner={owner} hasWindows={visible.length > 0} onLaunch={(k, a) => (a ? api.launch(a) : open(k))} />}

				{ctxMenu && (
					<>
						<button className="menu-scrim" aria-label="Close menu" onClick={() => setMenu(null)} onContextMenu={(e) => (e.preventDefault(), setMenu(null))} />
						<div className="ctx-menu" style={{left: ctxMenu.x, top: ctxMenu.y}} role="menu">
							<b className="ctx-title">{ctxApp ? (ctxApp.name ?? ctxApp.id) : ctxMenu.key.startsWith('console:') ? 'Console' : SYS[ctxMenu.key as keyof typeof SYS]?.title}</b>
							{(ctxMenu.key === 'files' || ctxMenu.key === 'terminal') && (
								<button role="menuitem" onClick={() => (setMenu(null), ctxMenu.key === 'terminal' ? api.openTerminal() : open('files', undefined, {newWindow: true}))}>
									New window
								</button>
							)}
							{ctxApp && (
								<>
									<button role="menuitem" onClick={() => (setMenu(null), setPins((p) => (p.includes(ctxApp.id) ? p.filter((x) => x !== ctxApp.id) : [...p, ctxApp.id])))}>
										{pins.includes(ctxApp.id) ? 'Unpin from dock' : 'Pin to dock'}
									</button>
									{appUrl(ctxApp, boot.umbrel!.host) && (
										<button role="menuitem" onClick={() => (setMenu(null), window.open(appUrl(ctxApp, boot.umbrel!.host)!, '_blank', 'noopener'))}>
											Open in a browser tab
										</button>
									)}
								</>
							)}
							{wins.some((w) => w.key === ctxMenu.key) && (
								<button
									role="menuitem"
									className="danger"
									onClick={() => {
										setMenu(null)
										wins.filter((w) => w.key === ctxMenu.key).forEach((w) => close(w.id))
									}}
								>
									{wins.filter((w) => w.key === ctxMenu.key).length > 1 ? `Close ${wins.filter((w) => w.key === ctxMenu.key).length} windows` : 'Close'}
								</button>
							)}
						</div>
					</>
				)}
			</div>
		</DesktopContext.Provider>
	)
}

function ConsoleDockItem({k, wins, active, onClick, onContext}: {k: string; wins: Win[]; active: Win | null; onClick: () => void; onContext: (x: number, y: number) => void}) {
	const machines = useMachines()
	const m = machines.data?.find((x) => `console:${x.id}` === k)
	return (
		<DockItem label={`${m?.name ?? 'Machine'} console`} count={wins.filter((w) => w.key === k).length} focused={active?.key === k} onClick={onClick} onContext={onContext}>
			<SysIcon kind="console" size={44} />
		</DockItem>
	)
}

function DockItem({label, count, focused, onClick, onContext, children}: {label: string; count: number; focused: boolean; onClick: () => void; onContext?: (x: number, y: number) => void; children: ReactNode}) {
	return (
		<button
			className={`dock-item${focused ? ' focused' : ''}${count ? ' running' : ''}`}
			aria-label={label}
			data-tip={label}
			onClick={onClick}
			onContextMenu={(e) => {
				e.preventDefault()
				onContext?.(e.clientX + 6, Math.min(e.clientY, window.innerHeight - 180))
			}}
		>
			{count > 0 && (
				<span className="dots" aria-hidden="true">
					{Array.from({length: Math.min(count, 3)}, (_, i) => (
						<i key={i} />
					))}
				</span>
			)}
			{children}
		</button>
	)
}

// ---- top bar ----------------------------------------------------------------------------------------
function useClock() {
	const [now, setNow] = useState(() => new Date())
	useEffect(() => {
		const t = window.setInterval(() => setNow(new Date()), 15_000)
		return () => window.clearInterval(t)
	}, [])
	return now
}

const NOTIFICATION_TEXT: Record<string, string> = {
	'update-available': 'A new version of umbrelOS is available',
	migration: 'Your data migration finished',
}
const noteText = (n: string) => NOTIFICATION_TEXT[n] ?? n.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

function TopBar(p: {
	boot: Bootstrap
	active: Win | null
	appList: UserApp[]
	overview: boolean
	menu: 'clock' | 'system' | null
	setMenu: (m: 'clock' | 'system' | null) => void
	toggleOverview: () => void
	onPower: (k: 'restart' | 'shutdown') => void
	onSignOut: () => void
	onSettings: () => void
	onSystem: () => void
}) {
	const now = useClock()
	const notes = useNotifications().data ?? []
	const updates = useUpdates().data ?? []
	const cpu = useCpu()
	const mem = useMemory()
	const user = useUser()
	const action = useAction()
	const cpuPct = cpu.data ? Math.round(cpu.data.totalUsed) : null
	const memPct = mem.data ? Math.round((mem.data.totalUsed / mem.data.size) * 100) : null
	const title = p.active ? winTitle(p.active, p.appList) : null
	return (
		<header className="desk-top">
			<div className="top-left">
				<button className={`activities${p.overview ? ' on' : ''}`} onClick={p.toggleOverview} aria-pressed={p.overview}>
					<span className="act-dots" aria-hidden="true">
						<i />
						<i />
						<i />
					</span>
					Activities
				</button>
				{title && !p.overview && <span className="top-title">{title}</span>}
			</div>
			<button className={`top-clock${p.menu === 'clock' ? ' on' : ''}`} onClick={() => p.setMenu(p.menu === 'clock' ? null : 'clock')}>
				{now.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'})}
				<b>{now.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'})}</b>
				{notes.length + updates.length > 0 && <span className="note-dot" />}
			</button>
			<div className="top-right">
				{cpuPct !== null && (
					<span className="top-stat" title="CPU">
						<Icon name="cpu" size={15} />
						{cpuPct}%
					</span>
				)}
				{memPct !== null && (
					<span className="top-stat" title="Memory">
						<Icon name="memory" size={15} />
						{memPct}%
					</span>
				)}
				<button className={`top-sys${p.menu === 'system' ? ' on' : ''}`} onClick={() => p.setMenu(p.menu === 'system' ? null : 'system')} aria-label="System menu">
					<span className="dot live" />
					<Icon name="power" size={16} />
					<Icon name="chevron-down" size={13} />
				</button>
			</div>

			{p.menu && <button className="menu-scrim" aria-label="Close menu" onClick={() => p.setMenu(null)} />}
			{p.menu === 'clock' && (
				<div className="top-pop clock-pop" role="dialog" aria-label="Notifications and calendar">
					<div className="pop-notes">
						<h4>Notifications</h4>
						{notes.length === 0 && updates.length === 0 ? (
							<p className="muted pop-empty">
								<Icon name="bell" size={30} />
								No notifications
							</p>
						) : (
							<>
								{updates.length > 0 && (
									<div className="pop-note">
										<Icon name="download" size={18} />
										<span>
											{updates.length} app update{updates.length > 1 ? 's' : ''} available
										</span>
									</div>
								)}
								{notes.map((n) => (
									<div key={n} className="pop-note">
										<Icon name="bell" size={18} />
										<span>{noteText(n)}</span>
										<button className="icon-btn" aria-label="Dismiss" onClick={() => action.mutate({path: 'notifications.clear', input: n})}>
											<Icon name="close" size={14} stroke={2.2} />
										</button>
									</div>
								))}
							</>
						)}
					</div>
					<MiniCalendar now={now} />
				</div>
			)}
			{p.menu === 'system' && (
				<div className="top-pop sys-pop" role="menu">
					<div className="sys-head">
						<span className="dot live" />
						<span>
							<b>{p.boot.umbrel?.device ?? 'Umbrel'}</b>
							<span className="mono muted">{p.boot.umbrel?.host}</span>
						</span>
					</div>
					<div className="sys-user muted">Signed in as {user.data?.name ?? 'you'}</div>
					<button role="menuitem" onClick={() => (p.setMenu(null), p.onSettings())}>
						<Icon name="settings" size={17} /> Settings
					</button>
					<button role="menuitem" onClick={() => (p.setMenu(null), p.onSystem())}>
						<Icon name="activity" size={17} /> System Monitor
					</button>
					<button role="menuitem" onClick={() => (p.setMenu(null), setLayoutPref('phone'))}>
						<Icon name="phone" size={17} /> Switch to phone layout
					</button>
					<hr />
					<button role="menuitem" onClick={p.onSignOut}>
						<Icon name="signout" size={17} /> Sign out
					</button>
					<button role="menuitem" onClick={() => p.onPower('restart')}>
						<Icon name="restart" size={17} /> Restart…
					</button>
					<button role="menuitem" className="danger" onClick={() => p.onPower('shutdown')}>
						<Icon name="power" size={17} /> Shut down…
					</button>
				</div>
			)}
		</header>
	)
}

function MiniCalendar({now}: {now: Date}) {
	const [month, setMonth] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1))
	const first = new Date(month.getFullYear(), month.getMonth(), 1)
	const start = (first.getDay() + 6) % 7 // weeks start Monday, like GNOME in most locales
	const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
	const cells = Array.from({length: Math.ceil((start + days) / 7) * 7}, (_, i) => i - start + 1)
	const today = (d: number) => d === now.getDate() && month.getMonth() === now.getMonth() && month.getFullYear() === now.getFullYear()
	return (
		<div className="pop-cal">
			<div className="cal-head">
				<b>{now.toLocaleDateString(undefined, {weekday: 'long'})}</b>
				<span>{now.toLocaleDateString(undefined, {month: 'long', day: 'numeric', year: 'numeric'})}</span>
			</div>
			<div className="cal-nav">
				<button className="icon-btn" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>
					<Icon name="back" size={15} />
				</button>
				<b>{month.toLocaleDateString(undefined, {month: 'long', year: 'numeric'})}</b>
				<button className="icon-btn" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>
					<Icon name="chevron" size={15} />
				</button>
			</div>
			<div className="cal-grid">
				{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
					<span key={i} className="cal-dow">
						{d}
					</span>
				))}
				{cells.map((d, i) => (
					<span key={i} className={`cal-day${d < 1 || d > days ? ' out' : ''}${today(d) ? ' today' : ''}`}>
						{d >= 1 && d <= days ? d : ''}
					</span>
				))}
			</div>
		</div>
	)
}

// ---- overview (Activities / Show Applications) -----------------------------------------------------------
function overviewSlot(w: Win, visible: Win[], vp: {w: number; h: number}) {
	if (w.min) return null
	const list = [...visible].sort((a, b) => a.born - b.born)
	const i = list.findIndex((x) => x.id === w.id)
	const n = list.length
	const areaX = DOCK + 40
	const areaY = TOP + 110
	const areaW = vp.w - DOCK - 80
	const areaH = vp.h - TOP - 150
	const cols = Math.ceil(Math.sqrt((n * areaW) / areaH / 1.4))
	const rows = Math.ceil(n / cols)
	const cw = areaW / cols
	const ch = areaH / rows
	const r = rectOf(w, vp)
	const s = Math.min(1, (cw - 36) / r.w, (ch - 44) / r.h)
	const col = i % cols
	const row = Math.floor(i / cols)
	const inRow = row === rows - 1 ? n - row * cols : cols
	const rowOffset = ((cols - inRow) * cw) / 2
	const cx = areaX + rowOffset + col * cw + cw / 2
	const cy = areaY + row * ch + ch / 2
	return `translate(${cx - (r.x + r.w / 2)}px, ${cy - (r.y + r.h / 2)}px) scale(${s})`
}

function Overview({mode, setMode, appList, owner, hasWindows, onLaunch}: {mode: 'windows' | 'apps'; setMode: (m: null | 'windows' | 'apps') => void; appList: UserApp[]; owner: boolean; hasWindows: boolean; onLaunch: (k: Kind, a?: UserApp) => void}) {
	const [q, setQ] = useState('')
	const ref = useRef<HTMLInputElement>(null)
	useEffect(() => ref.current?.focus(), [])
	const showApps = mode === 'apps' || q.trim() !== '' || !hasWindows
	const items: {id: string; name: string; kind: Kind; app?: UserApp}[] = [
		...FAVORITES.filter((k) => k !== 'terminal' || owner).map((k) => ({id: k, name: SYS[k].title, kind: k as Kind})),
		...[...appList].sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id)).map((a) => ({id: `app:${a.id}`, name: a.name ?? a.id, kind: 'app' as Kind, app: a})),
	].filter((x) => !q.trim() || x.name.toLowerCase().includes(q.trim().toLowerCase()))
	return (
		<>
			<div className="ov-backdrop" onClick={() => setMode(null)} />
			<div className={`ov-layer${showApps ? ' apps' : ''}`} onClick={(e) => e.target === e.currentTarget && setMode(null)}>
			<div className="ov-search">
				<Icon name="search" size={18} />
				<input
					ref={ref}
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="Type to search"
					aria-label="Search apps"
					onKeyDown={(e) => {
						if (e.key === 'Enter' && items[0]) onLaunch(items[0].kind, items[0].app)
					}}
				/>
			</div>
			{showApps && (
				<div className="ov-grid" onClick={(e) => e.target === e.currentTarget && setMode(null)}>
					{items.map((x) => (
						<button key={x.id} className="ov-app" onClick={() => onLaunch(x.kind, x.app)}>
							{x.app ? <AppIcon src={x.app.icon} name={x.name} size={72} dim={x.app.state === 'stopped'} /> : <SysIcon kind={x.kind} size={72} />}
							<span>{x.name}</span>
						</button>
					))}
					{items.length === 0 && <p className="muted">No apps match “{q}”</p>}
				</div>
			)}
			</div>
		</>
	)
}

// ---- a window ------------------------------------------------------------------------------------
function winTitle(w: Win, appList: UserApp[], machineName?: string) {
	if (w.kind === 'app') {
		const a = appList.find((x) => x.id === w.payload?.appId)
		return a?.name ?? w.payload?.appId ?? 'App'
	}
	if (w.kind === 'console') return machineName ? `${machineName} — Console` : 'Console'
	if (w.kind === 'terminal' && w.payload?.term) return `Terminal — ${w.payload.term.name ?? w.payload.term.id}`
	return SYS[w.kind as keyof typeof SYS].title
}

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

function WindowFrame({
	win,
	vp,
	active,
	overviewSlot,
	appList,
	onFocus,
	onUpdate,
	onClose,
	onMinimize,
	onPreview,
	onDragging,
	onOverviewPick,
	children,
}: {
	win: Win
	vp: {w: number; h: number}
	active: boolean
	overviewSlot: string | null
	appList: UserApp[]
	onFocus: (id: string) => void
	onUpdate: (id: string, patch: Partial<Win>) => void
	onClose: (id: string) => void
	onMinimize: (id: string) => void
	onPreview: (r: Rect | null) => void
	onDragging: (b: boolean) => void
	onOverviewPick: (id: string) => void
	children: ReactNode
}) {
	const el = useRef<HTMLDivElement>(null)
	const [portal, setPortal] = useState<HTMLDivElement | null>(null)
	const [reload, setReload] = useState(0)
	const r = rectOf(win, vp)
	const machines = useMachines()
	const title = winTitle(win, appList, machines.data?.find((m) => m.id === win.payload?.machineId)?.name)
	const app = win.kind === 'app' ? appList.find((a) => a.id === win.payload?.appId) : undefined
	const boot = useBootstrap()
	const url = app ? appUrl(app, boot.umbrel!.host) : null

	const toggleMax = () => {
		if (win.snap) onUpdate(win.id, {snap: null})
		else onUpdate(win.id, {snap: 'max'})
	}

	// Move: drag the title bar. Snap to the top edge to maximize, to a side to tile half the screen.
	const startMove = (e: React.PointerEvent) => {
		if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
		e.preventDefault() // no text selection while dragging a window
		window.getSelection()?.removeAllRanges()
		const node = el.current!
		const start = {px: e.clientX, py: e.clientY}
		let rect = {...r}
		let unsnapped = !win.snap
		let moved = false
		let snap: Snap = null
		const move = (ev: PointerEvent) => {
			const dx = ev.clientX - start.px
			const dy = ev.clientY - start.py
			if (!moved && Math.hypot(dx, dy) < 4) return
			if (!moved) {
				moved = true
				onDragging(true)
			}
			if (!unsnapped) {
				// Pull a maximized/tiled window out: restore its size under the pointer.
				const ratio = (start.px - rect.x) / rect.w
				rect = {x: start.px - ratio * win.w, y: rect.y, w: win.w, h: win.h}
				unsnapped = true
				node.style.width = `${rect.w}px`
				node.style.height = `${rect.h}px`
			}
			const x = rect.x + dx
			const y = Math.min(Math.max(TOP, rect.y + dy), window.innerHeight - 48)
			node.style.left = `${x}px`
			node.style.top = `${y}px`
			snap = ev.clientY <= TOP + 2 ? 'max' : ev.clientX <= DOCK + 4 ? 'left' : ev.clientX >= window.innerWidth - 5 ? 'right' : null
			onPreview(snap ? snapRect(snap, {w: window.innerWidth, h: window.innerHeight}) : null)
		}
		const up = (ev: PointerEvent) => {
			window.removeEventListener('pointermove', move)
			window.removeEventListener('pointerup', up)
			onPreview(null)
			onDragging(false)
			if (!moved) return
			const x = rect.x + (ev.clientX - start.px)
			const y = Math.min(Math.max(TOP, rect.y + (ev.clientY - start.py)), window.innerHeight - 48)
			onUpdate(win.id, snap ? {snap, x, y, w: rect.w, h: rect.h} : {snap: null, x, y, w: rect.w, h: rect.h})
		}
		window.addEventListener('pointermove', move)
		window.addEventListener('pointerup', up)
	}

	// Resize: any edge or corner.
	const startResize = (edge: Edge) => (e: React.PointerEvent) => {
		if (e.button !== 0) return
		e.preventDefault()
		e.stopPropagation()
		onFocus(win.id)
		const node = el.current!
		const start = {px: e.clientX, py: e.clientY, ...r}
		let next = {...r}
		onDragging(true)
		const move = (ev: PointerEvent) => {
			const dx = ev.clientX - start.px
			const dy = ev.clientY - start.py
			let {x, y, w, h} = start
			if (edge.includes('e')) w = Math.max(MIN_W, start.w + dx)
			if (edge.includes('s')) h = Math.max(MIN_H, Math.min(start.h + dy, window.innerHeight - start.y))
			if (edge.includes('w')) {
				w = Math.max(MIN_W, start.w - dx)
				x = start.x + start.w - w
			}
			if (edge.includes('n')) {
				const ny = Math.max(TOP, start.y + dy)
				h = Math.max(MIN_H, start.h + (start.y - ny))
				y = start.y + start.h - h
			}
			next = {x, y, w, h}
			Object.assign(node.style, {left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`})
		}
		const up = () => {
			window.removeEventListener('pointermove', move)
			window.removeEventListener('pointerup', up)
			onDragging(false)
			onUpdate(win.id, {snap: null, ...next})
		}
		window.addEventListener('pointermove', move)
		window.addEventListener('pointerup', up)
	}

	const style: CSSProperties = {left: r.x, top: r.y, width: r.w, height: r.h, zIndex: win.z, transform: overviewSlot ?? undefined}
	return (
		<div
			ref={el}
			data-id={win.id}
			className={`win${active ? ' active' : ''}${win.snap ? ` snapped snap-${win.snap}` : ''}${win.min ? ' minimized' : ''}${overviewSlot ? ' in-overview' : ''}`}
			style={style}
			role="dialog"
			aria-label={title}
			onPointerDownCapture={() => onFocus(win.id)}
		>
			<div className="win-bar" onPointerDown={startMove} onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && toggleMax()}>
				<span className="win-ico">{app ? <AppIcon src={app.icon} name={title} size={20} /> : <SysIcon kind={win.kind} size={20} />}</span>
				<span className="win-title">{title}</span>
				<span className="win-tools">
					{win.kind === 'app' && (
						<>
							<button className="win-btn ghost" aria-label="Reload" data-tip="Reload" onClick={() => setReload((n) => n + 1)}>
								<Icon name="restart" size={15} />
							</button>
							{url && (
								<button className="win-btn ghost" aria-label="Open in a browser tab" data-tip="Open in a browser tab" onClick={() => window.open(url, '_blank', 'noopener')}>
									<Icon name="open" size={15} />
								</button>
							)}
						</>
					)}
					<button className="win-btn" aria-label="Minimize" onClick={() => onMinimize(win.id)}>
						<Icon name="win-min" size={14} stroke={2.4} />
					</button>
					<button className="win-btn" aria-label={win.snap === 'max' ? 'Restore' : 'Maximize'} onClick={toggleMax}>
						<Icon name={win.snap === 'max' ? 'win-restore' : 'win-max'} size={13} stroke={2.4} />
					</button>
					<button className="win-btn close" aria-label="Close" onClick={() => onClose(win.id)}>
						<Icon name="close" size={14} stroke={2.6} />
					</button>
				</span>
			</div>
			<div className="win-body">
				<PortalRoot.Provider value={portal}>
					<InWindow.Provider value={true}>{portal && (win.kind === 'app' ? <AppFrame key={reload} app={app} url={url} /> : children)}</InWindow.Provider>
				</PortalRoot.Provider>
				<div className="win-portal" ref={setPortal} />
			</div>
			{!win.snap && !overviewSlot && EDGES.map((edge) => <span key={edge} className={`win-edge e-${edge}`} onPointerDown={startResize(edge)} />)}
			{overviewSlot && <button className="win-pick" aria-label={`Switch to ${title}`} onClick={() => onOverviewPick(win.id)} />}
		</div>
	)
}

function AppFrame({app, url}: {app?: UserApp; url: string | null}) {
	const [loaded, setLoaded] = useState(false)
	if (!app) return <div className="win-empty">This app is no longer installed.</div>
	if (!url) return <div className="win-empty">{app.name ?? app.id} doesn’t have a web interface.</div>
	if (app.state && app.state !== 'ready' && app.state !== 'running')
		return (
			<div className="win-empty">
				<AppIcon src={app.icon} name={app.name} size={64} dim />
				<b>{app.name ?? app.id} isn’t running</b>
				<span>Start it from Apps, then reload this window.</span>
			</div>
		)
	return (
		<>
			{!loaded && (
				<div className="frame-loading">
					<AppIcon src={app.icon} name={app.name} size={64} />
					<span className="spinner" />
				</div>
			)}
			<iframe
				className="app-frame"
				src={url}
				title={app.name ?? app.id}
				onLoad={() => setLoaded(true)}
				allow="clipboard-read; clipboard-write; fullscreen; camera; microphone; display-capture"
				allowFullScreen
			/>
		</>
	)
}

// ---- what goes inside a window ----------------------------------------------------------------------
const WindowContent = memo(function WindowContent({win, prefs, setPrefs, onSignedOut, owner}: {win: Win; prefs: Prefs; setPrefs: (p: Prefs) => void; onSignedOut: () => void; owner: boolean}) {
	const desk = useDesktop()!
	const close = () => desk.close(win.id)
	const body = (() => {
		switch (win.kind) {
			case 'files':
				return <Files />
			case 'apps':
				return <AppsWindow />
			case 'store':
				return <Store onOpenInstalled={(a) => desk.launch(a)} />
			case 'machines':
				return <Machines />
			case 'system':
				return <More prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} onSettings={() => desk.open('settings')} />
			case 'settings':
				return <Settings prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} onBack={close} />
			case 'terminal':
				return owner ? <TerminalScreen embedded app={win.payload?.term} onClose={close} /> : <div className="win-empty">Only the Umbrel’s owner can open a terminal.</div>
			case 'console':
				return <ConsoleWindow machineId={win.payload!.machineId!} onClose={close} />
			default:
				return null
		}
	})()
	if (win.kind === 'terminal' || win.kind === 'console') return body
	return (
		<div className="win-scroll">
			<main className="screen win-screen">{body}</main>
		</div>
	)
}, (a, b) => a.win.id === b.win.id && a.win.kind === b.win.kind && a.prefs === b.prefs && a.owner === b.owner)

function AppsWindow() {
	const desk = useDesktop()!
	const apps = useApps()
	const updates = useUpdates()
	const [appId, setAppId] = useState<string | null>(null)
	const app = apps.data?.find((a) => a.id === appId) ?? null
	const update = updates.data?.find((u) => u.id === appId)
	return (
		<>
			<Apps onOpenApp={(a) => setAppId(a.id)} onTerminal={() => desk.openTerminal()} onStore={() => desk.open('store')} />
			<AppSheet app={app} update={update} onClose={() => setAppId(null)} onTerminal={(t) => (setAppId(null), desk.openTerminal(t))} />
		</>
	)
}

function ConsoleWindow({machineId, onClose}: {machineId: string; onClose: () => void}) {
	const machines = useMachines()
	const m = machines.data?.find((x) => x.id === machineId)
	if (machines.isLoading) return <div className="win-empty"><span className="spinner" /></div>
	if (!m) return <div className="win-empty">This machine no longer exists.</div>
	return <Console embedded machine={m} onClose={onClose} />
}
