import {useEffect, useState} from 'react'
import {useQuery} from '@tanstack/react-query'

import {mutate, query, type UserApp} from './api'
import {appUrl, useAction, useBootstrap} from './data'
import {Icon, type IconName} from './icons'
import {AppIcon, Sheet, SheetHeader, StatusPill, appStatus, isAppBusy, useConfirm} from './ui'

type Props = {app: UserApp | null; update?: {version: string}; onClose: () => void}

export function AppSheet({app, update, onClose}: Props) {
	const boot = useBootstrap()
	const action = useAction()
	const confirm = useConfirm()
	const [logsOpen, setLogsOpen] = useState(false)
	useEffect(() => setLogsOpen(false), [app?.id])

	if (!app) return null
	const status = appStatus(app.state, !!update)
	const busy = isAppBusy(app.state) || action.isPending
	const stopped = app.state === 'stopped'
	const url = appUrl(app, boot.umbrel!.host)
	const name = app.name ?? app.id

	const run = (path: string, optimisticState: UserApp['state'], done: string) =>
		action.mutate({path, input: {appId: app.id}, optimistic: {appId: app.id, state: optimisticState}, done})

	const open = () => {
		if (!url) return
		mutate('apps.trackOpen', {appId: app.id}).catch(() => {})
		window.open(url, '_blank', 'noopener')
	}

	type A = {label: string; icon: IconName; onClick: () => void; primary?: boolean; disabled?: boolean}
	const openA: A = {label: 'Open', icon: 'open', onClick: open, disabled: !url || stopped}
	const startA: A = {label: 'Start', icon: 'play', onClick: () => run('apps.start', 'starting', `${name} started`)}
	const stopA: A = {label: 'Stop', icon: 'stop', onClick: () => run('apps.stop', 'stopping', `${name} stopped`)}
	const restartA: A = {label: 'Restart', icon: 'restart', onClick: () => run('apps.restart', 'restarting', `${name} restarted`), disabled: stopped}
	const updateA: A = {label: `Update`, icon: 'update', onClick: () => run('apps.update', 'updating', `${name} updated to ${update?.version}`)}
	const logsA: A = {label: 'Logs', icon: 'logs', onClick: () => setLogsOpen(true)}

	const actions: A[] = stopped
		? [{...startA, primary: true}, logsA, openA, restartA]
		: update
			? [{...updateA, primary: true}, openA, restartA, stopA, logsA]
			: [{...openA, primary: true}, restartA, stopA, logsA]

	const uninstall = async () => {
		const ok = await confirm({
			title: `Uninstall ${name}?`,
			body: `${name} and all of its data will be permanently removed from your Umbrel. This can’t be undone.`,
			confirm: `Uninstall ${name}`,
			danger: true,
		})
		if (ok) {
			run('apps.uninstall', 'uninstalling', `${name} uninstalled`)
			onClose()
		}
	}

	return (
		<>
			<Sheet open={!logsOpen} onClose={onClose} label={`${name} actions`}>
				<SheetHeader
					icon={<AppIcon src={app.icon} name={name} size={58} />}
					title={name}
					subtitle={
						<span style={{display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
							<StatusPill {...status} />
							<span>
								v{app.version}
								{update ? ` → ${update.version}` : ''}
							</span>
						</span>
					}
					onClose={onClose}
				/>
				{app.progress && isAppBusy(app.state) ? (
					<div className="bar" style={{marginBottom: 16}} aria-label={`${app.state} ${app.progress}%`}>
						<i style={{width: `${app.progress}%`, background: 'var(--accent)'}} />
					</div>
				) : null}
				<div className="actions">
					{actions.map((a) => (
						<button
							key={a.label}
							className={`btn${a.primary ? ' primary' : ''}`}
							onClick={a.onClick}
							disabled={a.disabled || (busy && a.label !== 'Logs')}
						>
							{busy && a.primary ? <span className="spinner" /> : <Icon name={a.icon} size={20} />}
							{a.label}
						</button>
					))}
				</div>
				{(app.credentials?.defaultUsername || app.credentials?.defaultPassword) && (
					<dl className="kv" style={{marginTop: 18}}>
						{app.credentials.defaultUsername && (
							<>
								<dt>Default username</dt>
								<dd>{app.credentials.defaultUsername}</dd>
							</>
						)}
						{app.credentials.defaultPassword && (
							<>
								<dt>Default password</dt>
								<dd>{app.credentials.defaultPassword}</dd>
							</>
						)}
					</dl>
				)}
				<dl className="kv" style={{marginTop: 18}}>
					<dt>Address</dt>
					<dd>{url ? new URL(url).host : '–'}</dd>
				</dl>
				<button className="btn danger block" onClick={uninstall} disabled={busy}>
					<Icon name="trash" size={18} />
					Uninstall…
				</button>
			</Sheet>
			{logsOpen && <LogsSheet appId={app.id} name={name} onClose={() => setLogsOpen(false)} />}
		</>
	)
}

function LogsSheet({appId, name, onClose}: {appId: string; name: string; onClose: () => void}) {
	const logs = useQuery({
		queryKey: ['apps.logs', appId],
		queryFn: () => query<string>('apps.logs', {appId, maxOutputBytes: 200_000}),
		refetchInterval: 5000,
	})
	const [el, setEl] = useState<HTMLPreElement | null>(null)
	useEffect(() => {
		if (el) el.scrollTop = el.scrollHeight
	}, [el, logs.data])
	return (
		<Sheet open onClose={onClose} label={`${name} logs`} tall>
			<SheetHeader title={`${name} logs`} subtitle="live · refreshes every 5s" onClose={onClose} />
			<pre className="logs" ref={setEl}>
				{logs.isLoading ? 'loading…' : logs.error ? (logs.error as Error).message : logs.data?.trim() || 'No log output yet.'}
			</pre>
		</Sheet>
	)
}
