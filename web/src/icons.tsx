import type {SVGProps} from 'react'

const paths = {
	home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
	apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
	store: 'M4 7h16l-1.2 11.2a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8zM9 7V6a3 3 0 0 1 6 0v1',
	machine: 'M3 5h18v11H3zM8 20h8M12 16v4',
	more: 'M5 12h.01M12 12h.01M19 12h.01',
	play: 'M7 4.5l12 7.5-12 7.5z',
	stop: 'M6.5 6.5h11v11h-11z',
	restart: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
	logs: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
	open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
	update: 'M12 4v12M6 10l6 6 6-6M4 20h16',
	trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
	close: 'M6 6l12 12M18 6L6 18',
	search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5',
	back: 'M15 5l-7 7 7 7',
	chevron: 'M9 6l6 6-6 6',
	bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0',
	power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
	check: 'M5 12.5l4.5 4.5L19 7',
	alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
	cpu: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
	memory: 'M3 8h18v8H3zM7 8v8M11 8v8M15 8v8M19 16v3M5 16v3',
	disk: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
	thermo: 'M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z',
	palette: 'M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2 2 0 0 0-1.4 3.4c.4.4.4 1 0 1.4-.6.6-1.6 1.2-2.6 1.2zM7.5 11h.01M10.5 7h.01M15 7.5h.01',
	link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
	key: 'M15 7a4 4 0 1 1-3.9 4.9L4 19v-3h3v-3h3l1.1-1.1A4 4 0 0 1 15 7zM16 8h.01',
	signout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11',
	activity: 'M3 12h4l3-8 4 16 3-8h4',
	sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z',
}

export type IconName = keyof typeof paths

export function Icon({name, size = 22, strokeWidth = 2, ...rest}: {name: IconName; size?: number; strokeWidth?: number} & SVGProps<SVGSVGElement>) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={name === 'more' ? 3.2 : strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...rest}
		>
			<path d={paths[name]} />
		</svg>
	)
}
