// What's new, newest first. Shown once after an update (everything since the version this device last saw),
// and any time from Settings → Software update. Keep each line short and about what the person can now do.
export type Release = {version: string; date: string; title: string; added?: string[]; fixed?: string[]}

export const CHANGELOG: Release[] = [
	{
		version: '0.16.1',
		date: '2026-11-12',
		title: 'Machines on your network',
		added: ['Machines: a Network switch puts a machine directly on your home network (its own address from your router), so every port on it, like apps running inside it, is reachable without port forwards.'],
	},
	{
		version: '0.16.0',
		date: '2026-11-12',
		title: 'Port forwarding for machines',
		added: [
			'Machines → a machine → Port forwarding: reach a service inside a machine from your other devices, through a port on your Umbrel (40000–49999).',
			'One-tap presets for Omarchy Server, SSH and a web server.',
		],
	},
	{
		version: '0.15.2',
		date: '2026-11-12',
		title: 'Machine console keyboard',
		added: ['A paste key in the machine console: press and hold it, then tap Paste, to type your phone’s clipboard into the machine.'],
		fixed: [
			'Symbols that need Shift, like | ~ ! @ and capital letters, now type correctly in the machine console instead of coming out as \\ and other wrong keys.',
			'Removed the L and R mouse buttons from the console. Tap to click, two-finger tap to right-click.',
		],
	},
	{
		version: '0.15.1',
		date: '2026-11-12',
		title: 'Always the latest',
		added: ['The App Store has a Stores button (top right) for community app stores, such as TouchWorkStation’s browsers.'],
		fixed: ['The home-screen app reloads itself when Touch on your Umbrel has been updated, instead of running the old version until you force-quit it.'],
	},
	{
		version: '0.15.0',
		date: '2026-11-12',
		title: 'What’s new, every time',
		added: [
			'This popup: after each update, Touch shows what was added and fixed. Find it again in Settings → Software update.',
		],
		fixed: [
			'If an umbrelOS update fails, the reason now stays on screen with a Try again button, instead of a toast that disappears.',
		],
	},
	{
		version: '0.14.1',
		date: '2026-11-12',
		title: 'Community app stores',
		added: [
			'App Store → ⋯ → Community stores: add or remove extra app catalogs by link.',
			'One-tap TouchWorkStation store with Google Chrome and Brave browsers that run on your Umbrel and stream to any device.',
		],
	},
	{
		version: '0.13.4',
		date: '2026-11-11',
		title: 'iPhone fixes',
		fixed: [
			'No more empty strip under the dock in the home-screen app on iOS 26.',
			'The machine console fits above the keyboard and returns to full size when the keyboard closes.',
		],
	},
	{
		version: '0.13.1',
		date: '2026-11-11',
		title: 'Omarchy theme',
		added: ['Settings → Appearance → Omarchy: Tokyo Night colors, JetBrains Mono, square tiles and flat panels.'],
	},
	{
		version: '0.13.0',
		date: '2026-11-11',
		title: 'Open any file',
		added: [
			'Files opens photos, video, music, PDFs, Word, Excel, PowerPoint, Keynote previews, text, Markdown, CSV, zip archives and fonts in a full-window viewer.',
			'Swipe or use ← → to step through a folder; pinch to zoom photos.',
			'Edit and save text, Markdown and CSV files in place, and extract archives.',
		],
	},
	{
		version: '0.12.1',
		date: '2026-11-10',
		title: 'Photos folder',
		added: ['Files → Photos with Sync photos: uploads only the photos that aren’t already there.'],
	},
	{
		version: '0.12.0',
		date: '2026-11-10',
		title: 'Apps in windows',
		added: ['Umbrel apps open in desktop windows, including through a Cloudflare tunnel.'],
		fixed: ['Signing in asks for your username and password.'],
	},
]

const parse = (v: string) => v.split('.').map((n) => parseInt(n, 10) || 0)
export function newer(a: string, b: string) {
	const x = parse(a)
	const y = parse(b)
	for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
	return false
}
// Releases a device hasn't seen yet. With no record (first run of this feature), just the newest one.
export function unseen(current: string, lastSeen: string | null): Release[] {
	const upTo = CHANGELOG.filter((r) => !newer(r.version, current))
	if (!lastSeen) return upTo.slice(0, 1)
	return upTo.filter((r) => newer(r.version, lastSeen))
}
