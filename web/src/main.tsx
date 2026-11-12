import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'

import {App} from './App'
import {ApiError} from './api'
import {Providers, applyPrefs, readPrefs, watchKeyboardViewport, watchStandaloneGap} from './ui'
import './styles.css'

applyPrefs(readPrefs())
watchKeyboardViewport()
watchStandaloneGap()

const client = new QueryClient({
	defaultOptions: {
		queries: {
			// Don't hammer umbreld with retries for auth or permission errors.
			retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
			refetchOnWindowFocus: true,
			staleTime: 2000,
		},
	},
})

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<QueryClientProvider client={client}>
			<Providers>
				<App />
			</Providers>
		</QueryClientProvider>
	</StrictMode>,
)

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
	window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
