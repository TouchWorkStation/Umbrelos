import {useCallback, useEffect, useState} from 'react'
import {useIsFetching, useQuery, useQueryClient} from '@tanstack/react-query'

import {getBootstrap} from './api'
import {AppSheet} from './AppSheet'
import {BootstrapContext, useApps, useUpdates} from './data'
import {Icon, type IconName} from './icons'
import {Apps} from './screens/Apps'
import {Connect, Login} from './screens/Auth'
import {Home} from './screens/Home'
import {Machines} from './screens/Machines'
import {More} from './screens/More'
import {Store} from './screens/Store'
import {usePrefs} from './ui'

type Tab = 'home' | 'apps' | 'store' | 'machines' | 'more'
const TABS: {id: Tab; label: string; icon: IconName}[] = [
	{id: 'home', label: 'Home', icon: 'home'},
	{id: 'apps', label: 'Apps', icon: 'apps'},
	{id: 'store', label: 'Store', icon: 'store'},
	{id: 'machines', label: 'Machines', icon: 'machine'},
	{id: 'more', label: 'System', icon: 'activity'},
]
const tabFromHash = (): Tab => {
	const h = location.hash.replace('#/', '') as Tab
	return TABS.some((t) => t.id === h) ? h : 'home'
}

export function App() {
	const [prefs, setPrefs] = usePrefs()
	const qc = useQueryClient()
	const boot = useQuery({queryKey: ['bootstrap'], queryFn: getBootstrap, retry: 1, refetchOnWindowFocus: false})
	const refresh = useCallback(() => qc.invalidateQueries({queryKey: ['bootstrap']}), [qc])

	useEffect(() => {
		const onOut = () => {
			qc.removeQueries({predicate: (q) => q.queryKey[0] !== 'bootstrap'})
			refresh()
		}
		window.addEventListener('touch:signed-out', onOut)
		return () => window.removeEventListener('touch:signed-out', onOut)
	}, [qc, refresh])

	if (boot.isLoading) {
		return (
			<main className="auth" style={{alignItems: 'center', justifyContent: 'center'}}>
				<span className="spinner" style={{width: 28, height: 28, color: 'var(--accent)'}} aria-label="Loading" />
			</main>
		)
	}
	if (boot.error || !boot.data) {
		return (
			<main className="auth">
				<h1>UmbrelOS Touch is offline</h1>
				<p className="lead">The UmbrelOS Touch server isn’t answering. Is it still running?</p>
				<button className="btn primary block" onClick={refresh}>
					Try again
				</button>
			</main>
		)
	}
	const b = boot.data
	if (!b.configured) return <Connect onDone={refresh} />
	if (!b.umbrel?.reachable) return <Connect onDone={refresh} unreachable={b.umbrel} />
	if (!b.session) return <Login boot={b} onDone={refresh} />

	return (
		<BootstrapContext.Provider value={b}>
			<Shell prefs={prefs} setPrefs={setPrefs} onSignedOut={refresh} />
		</BootstrapContext.Provider>
	)
}

function Shell({prefs, setPrefs, onSignedOut}: {prefs: ReturnType<typeof usePrefs>[0]; setPrefs: ReturnType<typeof usePrefs>[1]; onSignedOut: () => void}) {
	const [tab, setTab] = useState<Tab>(tabFromHash)
	const [appId, setAppId] = useState<string | null>(null)
	const apps = useApps()
	const updates = useUpdates()
	const fetching = useIsFetching()
	const qc = useQueryClient()
	const boot = qc.getQueryData<import('./api').Bootstrap>(['bootstrap'])!

	useEffect(() => {
		const onHash = () => setTab(tabFromHash())
		window.addEventListener('hashchange', onHash)
		return () => window.removeEventListener('hashchange', onHash)
	}, [])
	const go = (t: Tab) => {
		if (t === tab) window.scrollTo({top: 0, behavior: 'smooth'})
		else {
			history.pushState(null, '', `#/${t}`)
			setTab(t)
			window.scrollTo({top: 0})
		}
	}

	const app = apps.data?.find((a) => a.id === appId) ?? null
	const update = updates.data?.find((u) => u.id === appId)
	const online = !apps.error
	const updateCount = updates.data?.length ?? 0

	return (
		<>
			<div className="shell">
				<header className="topbar">
					<span className="brand">umbrel touch</span>
					<span className={`dot ${online ? 'live' : 'down'}`} title={online ? 'Connected' : 'Connection lost'} style={fetching && online ? {opacity: 0.6} : undefined} />
					<span className="chip">
						<span className="sw" />
						<span>
							{boot.umbrel?.host} · {boot.umbrel?.version}
						</span>
					</span>
				</header>
				{!online && (
					<div className="error" role="alert">
						<Icon name="alert" size={18} />
						Lost contact with your Umbrel. Retrying…
					</div>
				)}
				<main>
					{tab === 'home' && <Home onOpenApp={(a) => setAppId(a.id)} go={go} />}
					{tab === 'apps' && <Apps onOpenApp={(a) => setAppId(a.id)} />}
					{tab === 'store' && <Store />}
					{tab === 'machines' && <Machines />}
					{tab === 'more' && <More prefs={prefs} setPrefs={setPrefs} onSignedOut={onSignedOut} />}
				</main>
			</div>
			<nav className="nav" aria-label="Main">
				{TABS.map((t) => (
					<button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
						<Icon name={t.icon} size={22} />
						{t.label}
						{t.id === 'apps' && updateCount > 0 && <span className="count">{updateCount}</span>}
					</button>
				))}
			</nav>
			<AppSheet app={app} update={update} onClose={() => setAppId(null)} />
		</>
	)
}
