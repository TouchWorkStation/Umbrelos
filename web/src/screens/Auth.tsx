import {useState, type FormEvent} from 'react'

import {ApiError, login, setup, type Bootstrap} from '../api'
import {Icon} from '../icons'
import {initials} from '../ui'

function Logo() {
	return (
		<div className="logo" aria-hidden="true">
			<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
				<path d="M3 12a9 9 0 0 1 18 0z" />
				<path d="M12 12v6.5a2.5 2.5 0 0 1-5 0" />
			</svg>
		</div>
	)
}

export function Connect({onDone, unreachable}: {onDone: () => void; unreachable?: Bootstrap['umbrel']}) {
	const [url, setUrl] = useState(unreachable?.url ?? '')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	const submit = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError('')
		try {
			await setup(url)
			onDone()
		} catch (err) {
			setError((err as Error).message)
		} finally {
			setBusy(false)
		}
	}
	return (
		<main className="auth">
			<Logo />
			<h1>{unreachable ? 'Can’t reach your Umbrel' : 'Connect your Umbrel'}</h1>
			<p className="lead">
				{unreachable
					? `UmbrelOS Touch couldn’t reach ${unreachable.url}. Make sure it’s on and on this network, or enter its new address.`
					: 'Enter the address you use to open umbrelOS in a browser. Nothing on your Umbrel is changed.'}
			</p>
			<form onSubmit={submit}>
				{error && (
					<div className="error" role="alert">
						<Icon name="alert" size={18} />
						{error}
					</div>
				)}
				<div className="field">
					<label htmlFor="url">Umbrel address</label>
					<input
						id="url"
						inputMode="url"
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						placeholder="192.168.1.50 or umbrel.local"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						required
					/>
					<span className="hint">An IP address is the most reliable. umbrel.local works on most home networks.</span>
				</div>
				<button className="btn primary block" disabled={busy || !url.trim()}>
					{busy ? <span className="spinner" /> : <Icon name="link" size={20} />}
					{busy ? 'Checking…' : unreachable ? 'Try again' : 'Connect'}
				</button>
			</form>
		</main>
	)
}

export function Login({boot, onDone}: {boot: Bootstrap; onDone: () => void}) {
	const accounts = boot.accounts
	const [userId, setUserId] = useState(accounts[0]?.userId)
	const [password, setPassword] = useState('')
	const [totp, setTotp] = useState('')
	const [needTotp, setNeedTotp] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')

	const submit = async (e: FormEvent) => {
		e.preventDefault()
		setBusy(true)
		setError('')
		try {
			await login({password, userId, ...(needTotp && totp ? {totpToken: totp.replace(/\s/g, '')} : {})})
			onDone()
		} catch (err) {
			const message = (err as ApiError).message
			if (/2FA/i.test(message)) {
				if (needTotp) setError(message)
				setNeedTotp(true)
			} else setError(message)
		} finally {
			setBusy(false)
		}
	}

	return (
		<main className="auth">
			<Logo />
			<h1>Sign in</h1>
			<p className="lead">Use your umbrelOS password. UmbrelOS Touch shows up as its own device in umbrelOS, so you can sign it out from there any time.</p>
			<div className="glass device-card">
				<span className="dot live" />
				<div style={{flex: 1, minWidth: 0}}>
					<div style={{fontWeight: 600, fontSize: 14}}>{boot.umbrel?.device ?? 'Umbrel'}</div>
					<div className="mono muted" style={{fontSize: 12, marginTop: 2}}>
						{boot.umbrel?.host} · {boot.umbrel?.name ?? `umbrelOS ${boot.umbrel?.version}`}
					</div>
				</div>
			</div>
			<form onSubmit={submit}>
				{accounts.length > 1 && (
					<div className="accounts" role="radiogroup" aria-label="Account">
						{accounts.map((a) => (
							<button
								type="button"
								key={a.userId}
								role="radio"
								aria-checked={a.userId === userId}
								className={`account${a.userId === userId ? ' on' : ''}`}
								onClick={() => setUserId(a.userId)}
							>
								<span className="avatar">{a.avatar ? <img src={a.avatar} alt="" /> : initials(a.name)}</span>
								{a.name}
							</button>
						))}
					</div>
				)}
				{error && (
					<div className="error" role="alert">
						<Icon name="alert" size={18} />
						{error}
					</div>
				)}
				<div className="field">
					<label htmlFor="password">{accounts.length === 1 ? `Password for ${accounts[0].name}` : 'Password'}</label>
					<input
						id="password"
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						autoFocus
						required
					/>
				</div>
				{needTotp && (
					<div className="field">
						<label htmlFor="totp">2FA code</label>
						<input
							id="totp"
							inputMode="numeric"
							autoComplete="one-time-code"
							pattern="[0-9 ]*"
							maxLength={7}
							value={totp}
							onChange={(e) => setTotp(e.target.value)}
							autoFocus
							required
						/>
						<span className="hint">From your authenticator app.</span>
					</div>
				)}
				<button className="btn primary block" disabled={busy || !password}>
					{busy ? <span className="spinner" /> : <Icon name="key" size={20} />}
					{busy ? 'Signing in…' : 'Sign in'}
				</button>
			</form>
		</main>
	)
}
