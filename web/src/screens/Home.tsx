import {useMemo} from 'react'

import type {UserApp} from '../api'
import {useApps, useCpu, useDisk, useMemory, useNotifications, useTemp, useUpdates, useUptime, useUser} from '../data'
import {Icon} from '../icons'
import {AppIcon, appStatus, bytes, duration, greeting, level, pct} from '../ui'

export function Meter({label, used, total, value}: {label: string; used: number; total: number; value: string}) {
	const p = pct(used, total)
	return (
		<div className="meter">
			<span className="label">{label}</span>
			<span className="bar" role="meter" aria-label={label} aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
				<i className={level(p)} style={{width: `${p}%`}} />
			</span>
			<span className="val">{value}</span>
		</div>
	)
}

export function SystemCard() {
	const cpu = useCpu()
	const mem = useMemory()
	const disk = useDisk()
	const temp = useTemp()
	const uptime = useUptime()
	return (
		<section className="glass card" aria-label="System health">
			<div className="card-head">
				<strong>System</strong>
				<span className="mono">
					{temp.data ? `${Math.round(temp.data.temperature)}°C · ` : ''}up {duration(uptime.data)}
				</span>
			</div>
			<div className="meters">
				<Meter label="cpu" used={cpu.data?.totalUsed ?? 0} total={100} value={cpu.data ? `${cpu.data.totalUsed.toFixed(0)}%` : '–'} />
				<Meter
					label="ram"
					used={mem.data?.totalUsed ?? 0}
					total={mem.data?.size ?? 1}
					value={mem.data ? `${bytes(mem.data.totalUsed, 1, 1024)} / ${bytes(mem.data.size, 0, 1024)}` : '–'}
				/>
				<Meter
					label="disk"
					used={disk.data?.totalUsed ?? 0}
					total={disk.data?.size ?? 1}
					value={disk.data ? `${bytes(disk.data.totalUsed, 0)} / ${bytes(disk.data.size, 0)}` : '–'}
				/>
			</div>
		</section>
	)
}

export function Home({onOpenApp, go}: {onOpenApp: (app: UserApp) => void; go: (tab: 'apps' | 'more') => void}) {
	const user = useUser()
	const apps = useApps()
	const updates = useUpdates()
	const notifications = useNotifications()
	const updateIds = useMemo(() => new Set((updates.data ?? []).map((u) => u.id)), [updates.data])
	const list = apps.data ?? []
	const running = list.filter((a) => appStatus(a.state).kind === 'running').length
	const problems = list.filter((a) => a.error || a.state === 'unknown')

	const updateNames = (updates.data ?? []).map((u) => list.find((a) => a.id === u.id)?.name ?? u.id)
	const summary = apps.isLoading
		? 'Checking your apps…'
		: problems.length
			? `${problems.length} app${problems.length > 1 ? 's need' : ' needs'} attention`
			: `All systems normal · ${running} of ${list.length} apps running`

	return (
		<>
			<h1 className="title">
				{greeting()}
				{user.data?.name ? `, ${user.data.name.split(' ')[0]}` : ''}
			</h1>
			<p className="subtitle">{summary}</p>

			<SystemCard />

			{updateNames.length > 0 && (
				<button className="banner" onClick={() => go('apps')}>
					<span className="ico">
						<Icon name="update" size={18} />
					</span>
					<span className="txt">
						<b>
							{updateNames.length} app update{updateNames.length > 1 ? 's' : ''} ready
						</b>
						<span>{updateNames.join(', ')}</span>
					</span>
					<span className="cta">Review</span>
				</button>
			)}
			{(notifications.data?.length ?? 0) > 0 && (
				<button className="banner warn" onClick={() => go('more')}>
					<span className="ico">
						<Icon name="bell" size={18} />
					</span>
					<span className="txt">
						<b>
							{notifications.data!.length} notification{notifications.data!.length > 1 ? 's' : ''}
						</b>
						<span>From umbrelOS</span>
					</span>
					<span className="cta">View</span>
				</button>
			)}

			<div className="section-head">
				<h2>Your apps</h2>
				<button className="link-btn" onClick={() => go('apps')}>
					See all
				</button>
			</div>
			{apps.isLoading ? (
				<div className="app-grid">
					{Array.from({length: 8}, (_, i) => (
						<div key={i} className="skeleton" style={{height: 76}} />
					))}
				</div>
			) : list.length === 0 ? (
				<div className="glass empty">No apps installed yet. Find some in the Store.</div>
			) : (
				<div className="app-grid">
					{list.map((app) => (
						<button key={app.id} className="app-tile" onClick={() => onOpenApp(app)} aria-label={`${app.name ?? app.id}, ${appStatus(app.state, updateIds.has(app.id)).label}`}>
							<AppIcon src={app.icon} name={app.name ?? app.id} size={58} badge={appStatus(app.state, updateIds.has(app.id)).kind} />
							<span className="name">{app.name ?? app.id}</span>
						</button>
					))}
				</div>
			)}
		</>
	)
}
