import {useState} from 'react'

import type {Machine, PortForward} from '../api'
import {Console} from '../Console'
import {useDesktop} from '../desktop/Desktop'
import {CreateMachine} from '../CreateMachine'
import {useAction, useMachines} from '../data'
import {Icon, type IconName} from '../icons'
import {KV, Segmented, Sheet, SheetHeader, StatusPill, haptic, machineStatus, useConfirm, useToast} from '../ui'
import {useQueryClient} from '@tanstack/react-query'
import {mutate} from '../api'

export function osLook(osId = ''): {icon: IconName; bg: string; name: string} {
	const id = osId.toLowerCase()
	if (id.includes('ubuntu')) return {icon: 'ubuntu', bg: 'linear-gradient(140deg,#f2703c,#c7381d)', name: 'Ubuntu'}
	if (id.includes('debian')) return {icon: 'debian', bg: 'linear-gradient(140deg,#d70a53,#8a0636)', name: 'Debian'}
	if (id.includes('win')) return {icon: 'windows', bg: 'linear-gradient(140deg,#2b9af3,#0058b0)', name: 'Windows'}
	if (id.includes('mac')) return {icon: 'macos', bg: 'linear-gradient(140deg,#8e8e93,#3a3a3c)', name: 'macOS'}
	return {icon: 'server', bg: 'linear-gradient(140deg, var(--accent), color-mix(in srgb, var(--accent) 45%, #000))', name: osId || 'Linux'}
}

export function Machines() {
	const desk = useDesktop()
	const machines = useMachines()
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [consoleId, setConsoleId] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const list = machines.data ?? []
	const selected = list.find((m) => m.id === selectedId) ?? null
	const consoleMachine = list.find((m) => m.id === consoleId) ?? null
	const running = list.filter((m) => m.state === 'running').length

	return (
		<div className="stagger">
			<div style={{position: 'relative'}}>
				<button
					className="btn primary small"
					style={{position: 'absolute', right: 4, top: 14}}
					onClick={() => {
						haptic(6)
						setCreating(true)
					}}
				>
					<Icon name="plus" size={18} stroke={2.4} /> New
				</button>
				<h1 className="title">Machines</h1>
				<p className="subtitle">{machines.isLoading ? 'Loading…' : list.length ? `${running} of ${list.length} running` : 'Virtual machines on your Umbrel'}</p>
			</div>
			{machines.error && (
				<div className="error">
					<Icon name="alert" size={18} />
					{(machines.error as Error).message}
				</div>
			)}
			{machines.isLoading && Array.from({length: 2}, (_, i) => <div key={i} className="skeleton" style={{height: 130, borderRadius: 26, marginBottom: 12}} />)}
			{list.map((m) => {
				const os = osLook(m.osId)
				return (
					<button
						key={m.id}
						className="glass vm-card press"
						onClick={() => {
							haptic(6)
							setSelectedId(m.id)
						}}
					>
						<span className="top">
							<span className="vm-os" style={{background: os.bg, filter: m.state === 'running' ? undefined : 'saturate(.7) brightness(.9)'}}>
								<Icon name={os.icon} size={26} />
							</span>
							<span className="main" style={{flex: 1, minWidth: 0}}>
								<b style={{display: 'block', fontSize: 16.5, fontWeight: 650}}>{m.name}</b>
								<span style={{display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 2}}>{m.ipAddress ?? os.name}</span>
							</span>
							<StatusPill {...machineStatus(m.state)} />
						</span>
						{m.state === 'installing' && m.installProgress !== undefined ? (
							<span className="progress" aria-label={`Installing ${m.installProgress}%`}>
								<i style={{width: `${m.installProgress}%`}} />
							</span>
						) : (
							<span className="specs">
								{m.cores ? (
									<span className="spec">
										<Icon name="cpu" size={14} /> {m.cores} cores
									</span>
								) : null}
								{m.memoryGb ? (
									<span className="spec">
										<Icon name="memory" size={14} /> {m.memoryGb} GB
									</span>
								) : null}
								{m.diskSizeGb ? (
									<span className="spec">
										<Icon name="disk" size={14} /> {m.diskSizeGb} GB
									</span>
								) : null}
							</span>
						)}
					</button>
				)
			})}
			{!machines.isLoading && !machines.error && list.length === 0 && (
				<div className="glass empty">
					<span className="big">
						<Icon name="machine" size={30} />
					</span>
					<b>No machines yet</b>
					<span>Run Ubuntu, Debian, Windows and more right on your Umbrel.</span>
					<button className="btn primary small" onClick={() => setCreating(true)}>
						Create a machine
					</button>
				</div>
			)}
			{selected && !consoleMachine && (
				<MachineSheet
					machine={selected}
					onClose={() => setSelectedId(null)}
					onConsole={() => {
						haptic(8)
						if (desk) {
							setSelectedId(null)
							desk.openConsole(selected.id)
						}						else setConsoleId(selected.id)
					}}
				/>
			)}
			<CreateMachine open={creating} onClose={() => setCreating(false)} />
			{consoleMachine && <Console machine={consoleMachine} onClose={() => setConsoleId(null)} />}
		</div>
	)
}

function MachineSheet({machine: m, onClose, onConsole}: {machine: Machine; onClose: () => void; onConsole: () => void}) {
	const action = useAction()
	const confirm = useConfirm()
	const status = machineStatus(m.state)
	const busy = status.kind === 'busy' || action.isPending
	const os = osLook(m.osId)
	const run = (path: string, done: string) => {
		haptic(10)
		action.mutate({path, input: {id: m.id}, done})
	}
	const shutDown = async () => {
		if (await confirm({title: `Shut down ${m.name}?`, body: 'The machine is asked to shut down, like pressing its power button.', confirm: 'Shut down', icon: 'power'}))
			run('machines.stop', `${m.name} is shutting down`)
	}
	const remove = async () => {
		const ok = await confirm({
			title: `Delete ${m.name}?`,
			body: `${m.name} and its virtual disk will be permanently deleted. This can’t be undone.`,
			confirm: `Delete ${m.name}`,
			danger: true,
			icon: 'trash',
		})
		if (ok) {
			run('machines.uninstall', `${m.name} deleted`)
			onClose()
		}
	}
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
					<span className="vm-os" style={{width: 64, height: 64, borderRadius: 19, background: os.bg}}>
						<Icon name={os.icon} size={32} />
					</span>
				}
				title={m.name}
				subtitle={<StatusPill {...status} />}
				onClose={onClose}
			/>
			{m.errorMessage && (
				<div className="error">
					<Icon name="alert" size={18} />
					{m.errorMessage.replace(/^\[|\]$/g, '').replace(/-/g, ' ')}
				</div>
			)}
			<div className="primary-row">
				{m.state === 'running' ? (
					<button className="btn primary" onClick={onConsole}>
						<Icon name="machine" size={20} />
						Open console
					</button>
				) : (
					<button className="btn primary" onClick={() => run('machines.start', `${m.name} is starting`)} disabled={busy || m.state === 'installing'}>
						{busy ? <span className="spinner" /> : <Icon name="play" size={20} />}
						{busy ? 'Working…' : 'Start'}
					</button>
				)}
			</div>
			{m.state === 'running' && (
				<div className="actions" style={{gridTemplateColumns: 'repeat(2, minmax(0, 1fr))'}}>
					<button className="action" onClick={() => run('machines.restart', `${m.name} is restarting`)} disabled={busy}>
						<Icon name="restart" size={22} />
						Restart
					</button>
					<button className="action" onClick={shutDown} disabled={busy}>
						<Icon name="power" size={22} />
						Shut down
					</button>
				</div>
			)}
			<KV
				rows={[
					['System', os.name],
					['CPU', m.cores ? `${m.cores} cores` : '–'],
					['Memory', m.memoryGb ? `${m.memoryGb} GB` : '–'],
					['Disk', m.diskSizeGb ? `${m.diskSizeGb} GB` : '–'],
					['IP address', m.ipAddress ?? '–'],
				]}
			/>
			<NetworkMode machine={m} />
			<PortForwarding machine={m} />
			<div className="stack">
				{m.state !== 'stopped' && (
					<button className="btn danger block" onClick={forceStop} disabled={action.isPending}>
						<Icon name="stop" size={18} />
						Force stop
					</button>
				)}
				<button className="btn danger block" onClick={remove} disabled={action.isPending}>
					<Icon name="trash" size={18} />
					Delete machine
				</button>
			</div>
		</Sheet>
	)
}

// ---- port forwarding ----------------------------------------------------------------------------
// A machine on umbrelOS's private network (10.x) can't be reached from your phone or computer
// directly. A forward opens a port on the Umbrel (umbrelOS allows 40000-49999) that leads into it.
const PORT_MIN = 40_000
const PORT_MAX = 49_999
const PRESETS = [
	{label: 'Omarchy Server', guestPort: 7780, hostPort: 47780},
	{label: 'SSH', guestPort: 22, hostPort: 42222},
	{label: 'Web (80)', guestPort: 80, hostPort: 48080},
]
// Behind Umbrel (NAT, reached through port forwards) or on your own network (bridged: its own address
// from your router, every port reachable, like any other device). Takes effect when it next starts.
function NetworkMode({machine: m}: {machine: Machine}) {
	const confirm = useConfirm()
	const toast = useToast()
	const qc = useQueryClient()
	const [busy, setBusy] = useState(false)
	const mode = m.networkMode ?? 'nat'
	const change = async (next: 'nat' | 'bridged') => {
		if (next === mode) return
		const running = m.state === 'running'
		const ok = await confirm(
			next === 'bridged'
				? {
						title: `Put ${m.name} on your network?`,
						body: `It gets its own address from your router, like any other device, so everything on it is reachable without port forwards.${(m.portForwards ?? []).length ? ' Its port forwards are removed.' : ''}${running ? ' It restarts now to switch.' : ' It switches the next time it starts.'}`,
						confirm: running ? 'Switch and restart' : 'Switch',
						icon: 'network',
					}
				: {
						title: `Put ${m.name} behind your Umbrel?`,
						body: `It goes back on Umbrel’s private network and is reached through port forwards.${running ? ' It restarts now to switch.' : ' It switches the next time it starts.'}`,
						confirm: running ? 'Switch and restart' : 'Switch',
						icon: 'network',
					},
		)
		if (!ok) return
		haptic(10)
		setBusy(true)
		try {
			await mutate('machines.updateSettings', {id: m.id, networkMode: next, ...(next === 'bridged' ? {portForwards: []} : {})})
			if (running) await mutate('machines.restart', {id: m.id})
			toast(next === 'bridged' ? `${m.name} is joining your network` : `${m.name} is going behind your Umbrel`)
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(false)
			qc.invalidateQueries({queryKey: ['machines.list']})
		}
	}
	return (
		<section className="pf">
			<h4 className="list-head">Network</h4>
			<Segmented
				label="Network"
				value={mode}
				options={[
					{id: 'nat', label: 'Behind Umbrel'},
					{id: 'bridged', label: 'On your network'},
				]}
				onChange={(v) => !busy && change(v)}
			/>
			<p className="pf-note">
				{mode === 'bridged'
					? `${m.name} has its own address on your network${m.ipAddress ? ` (${m.ipAddress})` : ''}. Open its services at that address.`
					: `Choose “On your network” if other devices need to reach many ports on ${m.name}, such as apps running inside it.`}
			</p>
		</section>
	)
}

function PortForwarding({machine: m}: {machine: Machine}) {
	const action = useAction()
	const forwards = m.portForwards ?? []
	const [adding, setAdding] = useState(false)
	const [hostPort, setHostPort] = useState('')
	const [guestPort, setGuestPort] = useState('')
	const [protocol, setProtocol] = useState<PortForward['protocol']>('tcp')
	if (m.networkMode === 'bridged') return null
	const taken = new Set(forwards.map((f) => `${f.protocol}:${f.hostPort}`))
	const freePort = (wanted: number) => {
		for (let p = wanted; p <= PORT_MAX; p++) if (!taken.has(`tcp:${p}`)) return p
		return PORT_MIN
	}
	const save = (next: PortForward[], done: string) => {
		haptic(8)
		action.mutate({path: 'machines.updateSettings', input: {id: m.id, portForwards: next}, done})
	}
	const host = typeof location !== 'undefined' ? location.hostname : 'your-umbrel'
	const h = Number(hostPort)
	const g = Number(guestPort)
	const valid = Number.isInteger(h) && h >= PORT_MIN && h <= PORT_MAX && Number.isInteger(g) && g >= 1 && g <= 65_535 && !taken.has(`${protocol}:${h}`)
	const add = (hp: number, gp: number, proto: PortForward['protocol'], label: string) => {
		const id = `fwd-${Date.now().toString(36)}`
		save([...forwards, {id, protocol: proto, hostPort: hp, guestPort: gp}], `${label}: ${host}:${hp} now leads to ${m.name}`)
		setAdding(false)
		setHostPort('')
		setGuestPort('')
	}
	return (
		<section className="pf">
			<h4 className="list-head">Port forwarding</h4>
			<p className="muted pf-note">
				{m.name} is on the Umbrel’s private network{m.ipAddress ? ` (${m.ipAddress})` : ''}. Forward a port to reach a service inside it from your other devices.
			</p>
			{forwards.length > 0 && (
				<div className="glass group">
					{forwards.map((f) => (
						<div key={f.id} className="row static">
							<span className="main">
								<b className="mono">
									{f.hostPort} → {f.guestPort}
								</b>
								<span className="mono">
									{host}:{f.hostPort} · {f.protocol.toUpperCase()}
								</span>
							</span>
							{f.protocol === 'tcp' && (
								<a className="btn small" href={`http://${host}:${f.hostPort}`} target="_blank" rel="noreferrer">
									Open
								</a>
							)}
							<button
								className="btn small"
								disabled={action.isPending}
								aria-label={`Remove forward ${f.hostPort}`}
								onClick={() => save(forwards.filter((x) => x.id !== f.id), `Removed port ${f.hostPort}`)}
							>
								Remove
							</button>
						</div>
					))}
				</div>
			)}
			{adding ? (
				<div className="pf-add glass">
					<div className="pf-presets">
						{PRESETS.filter((p) => !forwards.some((f) => f.guestPort === p.guestPort)).map((p) => (
							<button
								key={p.label}
								className="btn small"
								onClick={() => {
									setGuestPort(String(p.guestPort))
									setHostPort(String(freePort(p.hostPort)))
									setProtocol('tcp')
								}}
							>
								{p.label}
							</button>
						))}
					</div>
					<div className="pf-fields">
						<label>
							<span>Umbrel port</span>
							<input className="field" inputMode="numeric" placeholder="47780" value={hostPort} onChange={(e) => setHostPort(e.target.value.replace(/\D/g, '').slice(0, 5))} />
						</label>
						<span className="pf-arrow" aria-hidden="true">→</span>
						<label>
							<span>Machine port</span>
							<input className="field" inputMode="numeric" placeholder="7780" value={guestPort} onChange={(e) => setGuestPort(e.target.value.replace(/\D/g, '').slice(0, 5))} />
						</label>
						<label>
							<span>Type</span>
							<select className="field" value={protocol} onChange={(e) => setProtocol(e.target.value as PortForward['protocol'])}>
								<option value="tcp">TCP</option>
								<option value="udp">UDP</option>
							</select>
						</label>
					</div>
					{hostPort && !(h >= PORT_MIN && h <= PORT_MAX) && <p className="muted pf-note">The Umbrel port must be between 40000 and 49999.</p>}
					<div className="pf-actions">
						<button className="btn small" onClick={() => setAdding(false)}>
							Cancel
						</button>
						<button className="btn small primary" disabled={!valid || action.isPending} onClick={() => add(h, g, protocol, 'Forward added')}>
							Add forward
						</button>
					</div>
				</div>
			) : (
				<button className="btn block" onClick={() => setAdding(true)} disabled={action.isPending}>
					<Icon name="plus" size={18} />
					Forward a port
				</button>
			)}
		</section>
	)
}
