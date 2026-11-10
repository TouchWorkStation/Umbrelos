import {useMemo, useState} from 'react'

import type {UserApp} from '../api'
import {useAction, useApps, useUpdates} from '../data'
import {Icon} from '../icons'
import {AppIcon, StatusPill, appStatus, useConfirm} from '../ui'

type Filter = 'all' | 'running' | 'stopped' | 'updates'

export function Apps({onOpenApp}: {onOpenApp: (app: UserApp) => void}) {
	const apps = useApps()
	const updates = useUpdates()
	const action = useAction()
	const confirm = useConfirm()
	const [q, setQ] = useState('')
	const [filter, setFilter] = useState<Filter>('all')
	const updateMap = useMemo(() => new Map((updates.data ?? []).map((u) => [u.id, u.version])), [updates.data])
	const list = apps.data ?? []

	const counts = {
		all: list.length,
		running: list.filter((a) => appStatus(a.state).kind === 'running').length,
		stopped: list.filter((a) => a.state === 'stopped').length,
		updates: list.filter((a) => updateMap.has(a.id)).length,
	}
	const shown = list.filter((a) => {
		if (q && !`${a.name} ${a.id}`.toLowerCase().includes(q.toLowerCase())) return false
		if (filter === 'running') return appStatus(a.state).kind === 'running'
		if (filter === 'stopped') return a.state === 'stopped'
		if (filter === 'updates') return updateMap.has(a.id)
		return true
	})

	const updateAll = async () => {
		const ids = list.filter((a) => updateMap.has(a.id))
		const ok = await confirm({
			title: `Update ${ids.length} apps?`,
			body: `${ids.map((a) => a.name).join(', ')} will update one after another. Each app restarts while it updates.`,
			confirm: 'Update all',
		})
		if (!ok) return
		for (const app of ids) {
			await action
				.mutateAsync({path: 'apps.update', input: {appId: app.id}, optimistic: {appId: app.id, state: 'updating'}, done: `${app.name} updated`})
				.catch(() => {})
		}
	}

	return (
		<>
			<h1 className="title">Apps</h1>
			<p className="subtitle">
				{apps.isLoading ? 'Loading…' : `${counts.running} running · ${counts.stopped} stopped${counts.updates ? ` · ${counts.updates} to update` : ''}`}
			</p>
			<label className="search">
				<Icon name="search" size={18} />
				<span className="sr-only">Search apps</span>
				<input type="search" placeholder={`Search ${list.length} apps`} value={q} onChange={(e) => setQ(e.target.value)} />
			</label>
			<div className="filters" role="tablist" aria-label="Filter apps">
				{(['all', 'running', 'stopped', 'updates'] as Filter[]).map((f) => (
					<button key={f} role="tab" aria-selected={filter === f} className={`filter${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
						{f} {counts[f]}
					</button>
				))}
			</div>
			{filter === 'updates' && counts.updates > 1 && (
				<button className="btn primary block" style={{margin: '4px 0 12px'}} onClick={updateAll} disabled={action.isPending}>
					<Icon name="update" size={20} />
					Update all {counts.updates}
				</button>
			)}
			<div className="rows">
				{apps.isLoading &&
					Array.from({length: 6}, (_, i) => <div key={i} className="skeleton" style={{height: 62, margin: '2px 0'}} />)}
				{shown.map((app) => {
					const status = appStatus(app.state, updateMap.has(app.id))
					return (
						<button key={app.id} className="row" onClick={() => onOpenApp(app)}>
							<AppIcon src={app.icon} name={app.name ?? app.id} size={48} />
							<span className="main">
								<b>{app.name ?? app.id}</b>
								<span>
									{app.error
										? app.error
										: `v${app.version}${updateMap.has(app.id) ? ` → ${updateMap.get(app.id)}` : ''}${app.port ? ` · :${app.port}` : ''}`}
								</span>
							</span>
							<StatusPill {...status} />
						</button>
					)
				})}
				{!apps.isLoading && shown.length === 0 && <div className="empty">{q ? `No apps match “${q}”.` : 'Nothing here.'}</div>}
			</div>
		</>
	)
}
