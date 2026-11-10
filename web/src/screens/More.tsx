import {useEffect, useMemo, useRef, useState} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {logout, mutate, query, type UsageItem} from '../api'
import {useAction, useApps, useBootstrap, useCpu, useDisk, useMemory, useNotifications, useUser} from '../data'
import {Icon} from '../icons'
import {ACCENTS, THEMES, bytes, useConfirm, useToast, type Prefs} from '../ui'

// One point per successful poll (keyed on the fetch time, so flat values still plot).
function useHistory(value: number | undefined, stamp: number, size = 40) {
	const [series, setSeries] = useState<number[]>([])
	useEffect(() => {
		if (value === undefined || !stamp) return
		setSeries((s) => [...s.slice(-(size - 1)), value])
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [stamp])
	return series
}

function Spark({series, max = 100, color = 'var(--accent)', label}: {series: number[]; max?: number; color?: string; label: string}) {
	const w = 300
	const h = 56
	const id = useMemo(() => `g${Math.random().toString(36).slice(2)}`, [])
	if (series.length < 2) return <div className="spark skeleton" />
	const step = w / (series.length - 1)
	const pts = series.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (Math.min(v, max) / max) * (h - 4)).toFixed(1)}`)
	return (
		<svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
			<defs>
				<linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
					<stop offset="0" stopColor={color} stopOpacity="0.28" />
					<stop offset="1" stopColor={color} stopOpacity="0" />
				</linearGradient>
			</defs>
			<path d={`M0,${h} L${pts.join(' L')} L${w},${h} Z`} fill={`url(#${id})`} />
			<polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
		</svg>
	)
}

const PALETTE = ['var(--blue)', 'var(--mauve)', 'var(--teal)', 'var(--peach)', 'var(--pink)', 'var(--green)', 'var(--yellow)']

function TopList({items, format, nameOf}: {items: UsageItem[]; format: (n: number) => string; nameOf: (id: string) => string}) {
	const top = [...items].sort((a, b) => b.used - a.used).slice(0, 5)
	if (!top.length) return null
	return (
		<div className="legend">
			{top.map((item, i) => (
				<div key={item.id}>
					<i style={{background: PALETTE[i % PALETTE.length]}} />
					<span>{item.name ?? nameOf(item.id)}</span>
					<span className="mono">{format(item.used)}</span>
				</div>
			))}
		</div>
	)
}

function Activity() {
	const cpu = useCpu()
	const mem = useMemory()
	const disk = useDisk()
	const apps = useApps()
	const nameOf = (id: string) => (id === 'other' ? 'Other' : (apps.data?.find((a) => a.id === id)?.name ?? id))
	const cpuSeries = useHistory(cpu.data?.totalUsed, cpu.dataUpdatedAt)
	const memPct = mem.data ? (mem.data.totalUsed / mem.data.size) * 100 : undefined
	const memSeries = useHistory(memPct, mem.dataUpdatedAt)

	const diskParts = disk.data
		? [
				{label: 'Apps', value: disk.data.apps.reduce((t, a) => t + a.used, 0), color: 'var(--blue)'},
				{label: 'Files', value: disk.data.files ?? 0, color: 'var(--mauve)'},
				{label: 'Machines', value: disk.data.machines.reduce((t, a) => t + a.used, 0), color: 'var(--teal)'},
				{label: 'System', value: disk.data.system, color: 'var(--peach)'},
			].filter((p) => p.value > 0)
		: []

	return (
		<>
			<div className="split">
				<section className="glass stat" aria-label="CPU">
					<div className="k">
						<Icon name="cpu" size={14} /> cpu · {cpu.data?.threads ?? '–'} threads
					</div>
					<div className="v">
						{cpu.data ? cpu.data.totalUsed.toFixed(1) : '–'}
						<small>%</small>
					</div>
					<Spark series={cpuSeries} label="CPU usage over the last two minutes" />
				</section>
				<section className="glass stat" aria-label="Memory">
					<div className="k">
						<Icon name="memory" size={14} /> ram · {bytes(mem.data?.size, 0, 1024)}
					</div>
					<div className="v">
						{mem.data ? bytes(mem.data.totalUsed, 1, 1024).split(' ')[0] : '–'}
						<small> {mem.data ? bytes(mem.data.totalUsed, 1, 1024).split(' ')[1] : ''}</small>
					</div>
					<Spark series={memSeries} color="var(--mauve)" label="Memory usage over the last two minutes" />
				</section>
			</div>
			<div className="split" style={{marginTop: 12}}>
				<section className="glass card">
					<div className="card-head" style={{marginBottom: 0}}>
						<strong>Top CPU</strong>
					</div>
					{cpu.data && <TopList items={[...cpu.data.apps, ...cpu.data.machines]} format={(n) => `${n.toFixed(1)}%`} nameOf={nameOf} />}
				</section>
				<section className="glass card">
					<div className="card-head" style={{marginBottom: 0}}>
						<strong>Top memory</strong>
					</div>
					{mem.data && <TopList items={[...mem.data.apps, ...mem.data.machines]} format={(n) => bytes(n, 1, 1024)} nameOf={nameOf} />}
				</section>
			</div>
			<section className="glass card" style={{marginTop: 12}} aria-label="Storage">
				<div className="card-head">
					<strong>Storage</strong>
					<span className="mono">{disk.data ? `${bytes(disk.data.available, 0)} free of ${bytes(disk.data.size, 0)}` : ''}</span>
				</div>
				<div className="stacked" aria-hidden="true">
					{diskParts.map((p) => (
						<i key={p.label} style={{width: `${(p.value / (disk.data?.size || 1)) * 100}%`, background: p.color}} />
					))}
				</div>
				<div className="legend">
					{diskParts.map((p) => (
						<div key={p.label}>
							<i style={{background: p.color}} />
							<span>{p.label}</span>
							<span className="mono">{bytes(p.value)}</span>
						</div>
					))}
				</div>
			</section>
		</>
	)
}

const NOTIFICATION_TEXT: Record<string, string> = {
	'update-available': 'An umbrelOS update is available',
	'migration': 'Data migration finished',
}
const notificationText = (n: string) => NOTIFICATION_TEXT[n] ?? n.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

export function More({prefs, setPrefs, onSignedOut}: {prefs: Prefs; setPrefs: (p: Prefs) => void; onSignedOut: () => void}) {
	const boot = useBootstrap()
	const user = useUser()
	const notifications = useNotifications()
	const action = useAction()
	const confirm = useConfirm()
	const toast = useToast()
	const qc = useQueryClient()
	const update = useQuery({queryKey: ['system.checkUpdate'], queryFn: () => query<{available: boolean; name: string; version: string}>('system.checkUpdate'), staleTime: 30 * 60_000, retry: false})
	const signingOut = useRef(false)

	const power = async (kind: 'restart' | 'shutdown') => {
		const ok = await confirm({
			title: kind === 'restart' ? 'Restart your Umbrel?' : 'Shut down your Umbrel?',
			body:
				kind === 'restart'
					? 'All apps and machines stop and come back once umbrelOS has restarted. This takes a few minutes.'
					: 'All apps and machines stop. You’ll need to turn the Umbrel back on yourself (for a VM: from FygoNAS).',
			confirm: kind === 'restart' ? 'Restart' : 'Shut down',
			danger: true,
		})
		if (!ok) return
		try {
			await mutate(`system.${kind}`)
			toast(kind === 'restart' ? 'Umbrel is restarting' : 'Umbrel is shutting down')
		} catch (e) {
			toast((e as Error).message, true)
		}
	}

	const signOut = async () => {
		if (signingOut.current) return
		signingOut.current = true
		await logout().catch(() => {})
		qc.clear()
		onSignedOut()
	}

	return (
		<>
			<h1 className="title">System</h1>
			<p className="subtitle">
				{user.data?.name ?? ' '}
				{user.data?.role ? ` · ${user.data.role}` : ''}
			</p>

			<Activity />

			<div className="section-head">
				<h2>Notifications</h2>
			</div>
			<section className="glass list-card">
				{(notifications.data ?? []).length === 0 ? (
					<div className="empty" style={{padding: 22}}>
						You’re all caught up.
					</div>
				) : (
					notifications.data!.map((n) => (
						<div key={n} className="row" style={{cursor: 'default'}}>
							<span className="row-ico" style={{'--c': 'var(--yellow)'} as React.CSSProperties}>
								<Icon name="bell" size={18} />
							</span>
							<span className="main">
								<b style={{fontWeight: 500, whiteSpace: 'normal'}}>{notificationText(n)}</b>
							</span>
							<button className="icon-btn" aria-label="Dismiss" onClick={() => action.mutate({path: 'notifications.clear', input: n})}>
								<Icon name="close" size={16} />
							</button>
						</div>
					))
				)}
			</section>

			<div className="section-head">
				<h2>Appearance</h2>
			</div>
			<section className="glass card">
				<div className="themes" role="radiogroup" aria-label="Theme">
					{THEMES.map((t) => (
						<button
							key={t.id}
							role="radio"
							aria-checked={prefs.theme === t.id}
							className={`theme-card${prefs.theme === t.id ? ' on' : ''}`}
							style={{background: t.bg, color: t.fg}}
							onClick={() => setPrefs({...prefs, theme: t.id})}
						>
							{t.name}
							<span className="dots">
								{t.dots.map((d) => (
									<i key={d} style={{background: d}} />
								))}
							</span>
						</button>
					))}
				</div>
				<div className="accents" role="radiogroup" aria-label="Accent color">
					{ACCENTS.map((a) => (
						<button
							key={a}
							role="radio"
							aria-checked={prefs.accent === a}
							aria-label={a}
							className={`accent-btn${prefs.accent === a ? ' on' : ''}`}
							style={{background: `var(--${a})`}}
							onClick={() => setPrefs({...prefs, accent: a})}
						/>
					))}
				</div>
			</section>

			<div className="section-head">
				<h2>Your Umbrel</h2>
			</div>
			<section className="glass card">
				<dl className="kv" style={{margin: 0}}>
					<dt>Device</dt>
					<dd>{boot.umbrel?.device ?? '–'}</dd>
					<dt>Address</dt>
					<dd>{boot.umbrel?.host}</dd>
					<dt>umbrelOS</dt>
					<dd>{boot.umbrel?.version}</dd>
					<dt>Update</dt>
					<dd>{update.data ? (update.data.available ? `${update.data.name} available` : 'Up to date') : '–'}</dd>
					<dt>Touch</dt>
					<dd>v{boot.touch.version} · {boot.session?.mode === 'native' ? 'device session' : 'legacy session'}</dd>
				</dl>
			</section>
			<section className="glass list-card" style={{marginTop: 12}}>
				<a className="row" href={boot.umbrel?.url} target="_blank" rel="noopener noreferrer" style={{color: 'inherit', textDecoration: 'none'}}>
					<span className="row-ico">
						<Icon name="open" size={18} />
					</span>
					<span className="main">
						<b style={{fontWeight: 500}}>Open umbrelOS dashboard</b>
					</span>
					<Icon name="chevron" size={18} className="muted" />
				</a>
				<button className="row" onClick={() => power('restart')}>
					<span className="row-ico" style={{'--c': 'var(--peach)'} as React.CSSProperties}>
						<Icon name="restart" size={18} />
					</span>
					<span className="main">
						<b style={{fontWeight: 500}}>Restart Umbrel</b>
					</span>
				</button>
				<button className="row" onClick={() => power('shutdown')}>
					<span className="row-ico" style={{'--c': 'var(--red)'} as React.CSSProperties}>
						<Icon name="power" size={18} />
					</span>
					<span className="main">
						<b style={{fontWeight: 500}}>Shut down Umbrel</b>
					</span>
				</button>
				<button className="row" onClick={signOut}>
					<span className="row-ico" style={{'--c': 'var(--muted)'} as React.CSSProperties}>
						<Icon name="signout" size={18} />
					</span>
					<span className="main">
						<b style={{fontWeight: 500}}>Sign out of this device</b>
					</span>
				</button>
			</section>
			<p className="muted mono" style={{fontSize: 11, textAlign: 'center', margin: '22px 0 0'}}>
				UmbrelOS Touch {boot.touch.version} · not affiliated with Umbrel
			</p>
		</>
	)
}
