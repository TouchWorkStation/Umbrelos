import {useState} from 'react'

import type {Machine} from '../api'
import {useAction, useBootstrap, useMachines} from '../data'
import {Icon, type IconName} from '../icons'
import {Sheet, SheetHeader, StatusPill, machineStatus, useConfirm} from '../ui'

export function Machines() {
	const machines = useMachines()
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const list = machines.data ?? []
	const selected = list.find((m) => m.id === selectedId) ?? null
	const running = list.filter((m) => m.state === 'running').length

	return (
		<>
			<h1 className="title">Machines</h1>
			<p className="subtitle">{machines.isLoading ? 'Loading…' : list.length ? `${running} of ${list.length} running` : 'Virtual machines on your Umbrel'}</p>
			{machines.error && <div className="error">{(machines.error as Error).message}</div>}
			<div className="rows">
				{machines.isLoading && Array.from({length: 3}, (_, i) => <div key={i} className="skeleton" style={{height: 66, margin: '3px 0'}} />)}
				{list.map((m) => (
					<button key={m.id} className="row" onClick={() => setSelectedId(m.id)}>
						<span className="row-ico" style={{width: 48, height: 48, borderRadius: 14, '--c': m.state === 'running' ? 'var(--green)' : 'var(--muted)'} as React.CSSProperties}>
							<Icon name="machine" size={22} />
						</span>
						<span className="main">
							<b>{m.name}</b>
							<span>
								{m.state === 'installing' && m.installProgress !== undefined
									? `installing ${m.installProgress}%`
									: [m.osId, m.cores && `${m.cores} cores`, m.memoryGb && `${m.memoryGb} GB`].filter(Boolean).join(' · ')}
							</span>
						</span>
						<StatusPill {...machineStatus(m.state)} />
					</button>
				))}
				{!machines.isLoading && !machines.error && list.length === 0 && (
					<div className="glass empty">
						No virtual machines yet.
						<br />
						Create one in umbrelOS and it will show up here.
					</div>
				)}
			</div>
			{selected && <MachineSheet machine={selected} onClose={() => setSelectedId(null)} />}
		</>
	)
}

function MachineSheet({machine: m, onClose}: {machine: Machine; onClose: () => void}) {
	const boot = useBootstrap()
	const action = useAction()
	const confirm = useConfirm()
	const status = machineStatus(m.state)
	const busy = status.kind === 'busy' || action.isPending
	const run = (path: string, done: string) => action.mutate({path, input: {id: m.id}, done})

	type A = {label: string; icon: IconName; onClick: () => void; primary?: boolean; disabled?: boolean}
	const actions: A[] =
		m.state === 'running'
			? [
					{label: 'Restart', icon: 'restart', onClick: () => run('machines.restart', `${m.name} restarting`)},
					{
						label: 'Shut down',
						icon: 'power',
						onClick: async () => {
							if (await confirm({title: `Shut down ${m.name}?`, body: 'The machine is asked to shut down like pressing its power button.', confirm: 'Shut down'}))
								run('machines.stop', `${m.name} shutting down`)
						},
					},
				]
			: [{label: 'Start', icon: 'play', primary: true, onClick: () => run('machines.start', `${m.name} starting`), disabled: m.state === 'installing'}]

	const forceStop = async () => {
		const ok = await confirm({
			title: `Force stop ${m.name}?`,
			body: 'This cuts power to the machine immediately. Unsaved work inside it will be lost.',
			confirm: 'Force stop',
			danger: true,
		})
		if (ok) run('machines.forceStop', `${m.name} stopped`)
	}

	return (
		<Sheet open onClose={onClose} label={m.name}>
			<SheetHeader
				icon={
					<span className="row-ico" style={{width: 58, height: 58, borderRadius: 17, '--c': 'var(--accent)'} as React.CSSProperties}>
						<Icon name="machine" size={26} />
					</span>
				}
				title={m.name}
				subtitle={<StatusPill {...status} />}
				onClose={onClose}
			/>
			{m.errorMessage && <div className="error">{m.errorMessage.replace(/^\[|\]$/g, '').replace(/-/g, ' ')}</div>}
			<div className="actions">
				{actions.map((a) => (
					<button key={a.label} className={`btn${a.primary ? ' primary' : ''}`} onClick={a.onClick} disabled={busy || a.disabled}>
						{busy && a.primary ? <span className="spinner" /> : <Icon name={a.icon} size={20} />}
						{a.label}
					</button>
				))}
				<a className="btn" href={boot.umbrel!.url} target="_blank" rel="noopener noreferrer" style={actions.length === 1 ? {} : {gridColumn: 'span 2'}}>
					<Icon name="open" size={20} />
					Console in umbrelOS
				</a>
			</div>
			<dl className="kv" style={{marginTop: 18}}>
				<dt>System</dt>
				<dd>{m.osId ?? '–'}</dd>
				<dt>CPU</dt>
				<dd>{m.cores ? `${m.cores} cores` : '–'}</dd>
				<dt>Memory</dt>
				<dd>{m.memoryGb ? `${m.memoryGb} GB` : '–'}</dd>
				<dt>Disk</dt>
				<dd>{m.diskSizeGb ? `${m.diskSizeGb} GB` : '–'}</dd>
				<dt>IP address</dt>
				<dd>{m.ipAddress ?? '–'}</dd>
			</dl>
			{m.state !== 'stopped' && (
				<button className="btn danger block" onClick={forceStop} disabled={action.isPending}>
					<Icon name="stop" size={18} />
					Force stop…
				</button>
			)}
		</Sheet>
	)
}
