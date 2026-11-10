import {useMemo, useState} from 'react'

import type {RegistryApp} from '../api'
import {useAction, useApps, useInstallReview, useRegistry} from '../data'
import {Icon} from '../icons'
import {AppIcon, Sheet, SheetHeader, StatusPill, appStatus, bytes} from '../ui'

type StoreApp = RegistryApp & {compatible?: boolean; repo?: string}

const CATEGORY_LABEL: Record<string, string> = {
	files: 'Files',
	bitcoin: 'Bitcoin',
	media: 'Media',
	networking: 'Networking',
	social: 'Social',
	automation: 'Home & Automation',
	finance: 'Finance',
	ai: 'AI',
	developer: 'Developer',
	crypto: 'Crypto',
	gaming: 'Gaming',
}
const label = (c: string) => CATEGORY_LABEL[c] ?? c.charAt(0).toUpperCase() + c.slice(1)

export function Store() {
	const registry = useRegistry()
	const apps = useApps()
	const [q, setQ] = useState('')
	const [category, setCategory] = useState('all')
	const [selected, setSelected] = useState<StoreApp | null>(null)

	const all = useMemo(() => {
		const seen = new Map<string, StoreApp>()
		for (const repo of registry.data ?? []) for (const app of repo.apps) if (!seen.has(app.id)) seen.set(app.id, {...app, repo: repo.meta.name})
		return [...seen.values()]
	}, [registry.data])
	const categories = useMemo(() => {
		const counts = new Map<string, number>()
		for (const a of all) if (a.category) counts.set(a.category, (counts.get(a.category) ?? 0) + 1)
		return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
	}, [all])
	const installed = useMemo(() => new Map((apps.data ?? []).map((a) => [a.id, a])), [apps.data])

	const shown = all
		.filter((a) => (category === 'all' ? true : a.category === category))
		.filter((a) => !q || `${a.name} ${a.tagline} ${a.developer}`.toLowerCase().includes(q.toLowerCase()))
		.sort((a, b) => a.name.localeCompare(b.name))

	return (
		<>
			<h1 className="title">App Store</h1>
			<p className="subtitle">{registry.isLoading ? 'Loading the catalog…' : `${all.length} app${all.length === 1 ? "" : "s"} from ${registry.data?.length ?? 0} store${registry.data?.length === 1 ? '' : 's'}`}</p>
			<label className="search">
				<Icon name="search" size={18} />
				<span className="sr-only">Search the App Store</span>
				<input type="search" placeholder="Search apps" value={q} onChange={(e) => setQ(e.target.value)} />
			</label>
			<div className="filters" role="tablist" aria-label="Categories">
				{['all', ...categories].map((c) => (
					<button key={c} role="tab" aria-selected={category === c} className={`filter${category === c ? ' on' : ''}`} onClick={() => setCategory(c)}>
						{c === 'all' ? 'all' : label(c).toLowerCase()}
					</button>
				))}
			</div>
			{registry.error && <div className="error">{(registry.error as Error).message}</div>}
			<div className="rows">
				{registry.isLoading && Array.from({length: 7}, (_, i) => <div key={i} className="skeleton" style={{height: 66, margin: '3px 0'}} />)}
				{shown.map((app) => {
					const inst = installed.get(app.id)
					return (
						<button key={app.id} className="store-card" onClick={() => setSelected(app)}>
							<AppIcon src={app.icon} name={app.name} size={52} />
							<span className="main" style={{flex: 1, minWidth: 0}}>
								<b style={{display: 'block', fontSize: 15, fontWeight: 600}}>{app.name}</b>
								<span style={{display: 'block', fontSize: 13, color: 'var(--fg-2)', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'}}>
									{app.tagline}
								</span>
							</span>
							{inst ? <StatusPill kind="running" label="installed" /> : <Icon name="chevron" size={18} className="muted" />}
						</button>
					)
				})}
				{!registry.isLoading && shown.length === 0 && <div className="empty">No apps match.</div>}
			</div>
			<StoreSheet app={selected} all={all} installedIds={new Set(installed.keys())} onSelect={setSelected} onClose={() => setSelected(null)} />
		</>
	)
}

function StoreSheet({
	app,
	all,
	installedIds,
	onSelect,
	onClose,
}: {
	app: StoreApp | null
	all: StoreApp[]
	installedIds: Set<string>
	onSelect: (a: StoreApp) => void
	onClose: () => void
}) {
	const apps = useApps()
	const action = useAction()
	const [reviewing, setReviewing] = useState(false)
	const review = useInstallReview(reviewing && app ? app.id : null)
	if (!app) return null

	const live = apps.data?.find((a) => a.id === app.id)
	const missingDeps = (app.dependencies ?? []).filter((d) => !installedIds.has(d))
	const depName = (id: string) => all.find((a) => a.id === id)?.name ?? id
	const incompatible = app.compatible === false

	const install = () => {
		const folderAccess = review.data?.requiredFolders.map((f) => ({id: f.id, sourcePath: f.defaultSourcePath}))
		action.mutate({
			path: 'apps.install',
			input: {appId: app.id, ...(folderAccess?.length ? {folderAccess} : {})},
			done: `${app.name} installed`,
		})
		setReviewing(false)
	}

	const close = () => {
		setReviewing(false)
		onClose()
	}

	return (
		<Sheet open onClose={close} label={app.name}>
			<SheetHeader
				icon={<AppIcon src={app.icon} name={app.name} size={64} />}
				title={app.name}
				subtitle={`${app.developer ?? app.repo ?? ''}${app.version ? ` · v${app.version}` : ''}`}
				onClose={close}
			/>
			{!reviewing ? (
				<>
					{live ? (
						<div className="glass card" style={{display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16}}>
							<StatusPill {...appStatus(live.state)} />
							<span style={{fontSize: 14}}>{live.state === 'installing' ? `Installing… ${live.progress ?? 0}%` : 'Installed on your Umbrel'}</span>
						</div>
					) : incompatible ? (
						<div className="error">This app needs a newer version of umbrelOS.</div>
					) : missingDeps.length ? (
						<div className="glass card" style={{marginBottom: 16}}>
							<div style={{fontSize: 14, fontWeight: 600, marginBottom: 10}}>Install these first</div>
							<div className="stack">
								{missingDeps.map((d) => {
									const dep = all.find((a) => a.id === d)
									return (
										<button key={d} className="btn" onClick={() => dep && onSelect(dep)} disabled={!dep}>
											{depName(d)}
										</button>
									)
								})}
							</div>
						</div>
					) : (
						<button className="btn primary block" style={{marginBottom: 16}} onClick={() => setReviewing(true)} disabled={action.isPending}>
							<Icon name="update" size={20} />
							Install
						</button>
					)}
					{app.tagline && <p style={{margin: '0 0 14px', fontSize: 16, fontWeight: 500}}>{app.tagline}</p>}
					{(app.gallery?.length ?? 0) > 0 && (
						<div className="gallery">
							{app.gallery!.slice(0, 6).map((src) => (
								<img key={src} src={src} alt="" loading="lazy" />
							))}
						</div>
					)}
					{app.description && <div className="prose">{app.description}</div>}
					<dl className="kv" style={{marginTop: 18}}>
						{app.category && (
							<>
								<dt>Category</dt>
								<dd>{label(app.category)}</dd>
							</>
						)}
						{app.installSize ? (
							<>
								<dt>Download size</dt>
								<dd>{bytes(app.installSize)}</dd>
							</>
						) : null}
						{app.repo && (
							<>
								<dt>Source</dt>
								<dd>{app.repo}</dd>
							</>
						)}
					</dl>
				</>
			) : (
				<>
					<p className="prose" style={{marginTop: 0}}>
						Ready to install <b>{app.name}</b> on your Umbrel.
					</p>
					{review.isLoading && (
						<div className="glass card" style={{display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16}}>
							<span className="spinner" /> Checking what it needs…
						</div>
					)}
					{review.error && <div className="error">{(review.error as Error).message}</div>}
					{review.data && (review.data.requiredFolders.length > 0 || review.data.gpuAccess) && (
						<div className="glass card" style={{marginBottom: 16}}>
							<div style={{fontSize: 14, fontWeight: 600, marginBottom: 10}}>This app will get access to</div>
							<div className="legend" style={{marginTop: 0}}>
								{review.data.requiredFolders.map((f) => (
									<div key={f.id}>
										<Icon name="disk" size={16} />
										<span>{f.name}</span>
										<span className="mono">
											{f.defaultSourcePath}
											{f.readOnly ? ' (read-only)' : ''}
										</span>
									</div>
								))}
								{review.data.gpuAccess && (
									<div>
										<Icon name="cpu" size={16} />
										<span>GPU</span>
										<span className="mono">hardware acceleration</span>
									</div>
								)}
							</div>
						</div>
					)}
					<div className="stack">
						<button className="btn primary block" onClick={install} disabled={!review.data || action.isPending}>
							<Icon name="check" size={20} />
							Install {app.name}
						</button>
						<button className="btn block ghost" onClick={() => setReviewing(false)}>
							Back
						</button>
					</div>
				</>
			)}
		</Sheet>
	)
}
