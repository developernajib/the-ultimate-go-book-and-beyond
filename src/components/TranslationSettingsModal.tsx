import { useEffect, useState } from 'react'
import Tooltip from '@/components/Tooltip'
import { useTranslation } from '@/lib/translation/TranslationContext'
import { PROVIDER_METAS, type ProviderId } from '@/lib/translation/types'
import { PROVIDERS_REGISTRY } from '@/lib/translation/providers'
import { deobfuscateApiKey } from '@/lib/translation/obfuscation'

export default function TranslationSettingsModal() {
	const {
		isSettingsOpen,
		closeSettings,
		settings,
		setProviderKey,
		setProviderEnabled,
		setProviderRegion,
		setProviderEndpoint,
		setProviderOrder,
		cacheStats,
		clearCache,
	} = useTranslation()

	// Draft key text lives here until saved, so typing never touches stored keys
	const [editingKey, setEditingKey] = useState<Record<ProviderId, string>>({
		deepl: '',
		google_cloud: '',
		azure: '',
		libretranslate: '',
		free_web: '',
	})

	const [testResults, setTestResults] = useState<
		Record<string, { loading?: boolean; msg?: string; ok?: boolean }>
	>({})
	const [cacheClearedMsg, setCacheClearedMsg] = useState(false)

	useEffect(() => {
		if (!isSettingsOpen) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') closeSettings()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [isSettingsOpen, closeSettings])

	if (!isSettingsOpen) return null

	const handleKeyChange = (id: ProviderId, val: string) => {
		setEditingKey((prev) => ({ ...prev, [id]: val }))
		setProviderKey(id, val)
	}

	const moveOrder = (index: number, direction: 'up' | 'down') => {
		const order = [...settings.order]
		const target = direction === 'up' ? index - 1 : index + 1
		if (target < 0 || target >= order.length) return
		const temp = order[index]
		order[index] = order[target]
		order[target] = temp
		setProviderOrder(order)
	}

	const runTest = async (id: ProviderId) => {
		const provider = PROVIDERS_REGISTRY[id]
		if (!provider) return

		setTestResults((prev) => ({ ...prev, [id]: { loading: true } }))
		const config = settings.providers[id]
		const res = await provider.test(config || { enabled: true })
		setTestResults((prev) => ({
			...prev,
			[id]: { loading: false, msg: res.message, ok: res.success },
		}))
	}

	const handleClearCache = async () => {
		await clearCache()
		setCacheClearedMsg(true)
		setTimeout(() => setCacheClearedMsg(false), 2500)
	}

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="translation-settings-title"
				className="relative w-full max-w-2xl bg-base-100 rounded-2xl shadow-2xl border border-base-300 overflow-hidden my-8 max-h-[90vh] flex flex-col"
			>
				<div className="px-6 py-4 border-b border-base-300 flex items-center justify-between shrink-0 bg-base-200/50">
					<div>
						<h2
							id="translation-settings-title"
							className="text-base sm:text-lg font-bold flex items-center gap-2"
						>
							<span>🌐</span> Translation & BYOK Settings
						</h2>
						<p className="text-xs text-base-content/70 mt-0.5">
							100% free by default with optional high-accuracy API keys
						</p>
					</div>
					<Tooltip content="Close" position="left">
						<button
							type="button"
							onClick={closeSettings}
							className="btn btn-ghost btn-sm btn-circle"
							aria-label="Close modal"
						>
							✕
						</button>
					</Tooltip>
				</div>

				<div className="p-4 sm:p-6 overflow-y-auto space-y-6">
					<div className="rounded-xl bg-primary/10 border border-primary/20 p-3 sm:p-4 text-xs text-base-content/80">
						<div className="flex items-start gap-2.5">
							<span className="text-base">🛡️</span>
							<div>
								<strong className="text-primary font-semibold">
									Canary Obfuscation Protection
								</strong>
								<p className="mt-0.5 text-base-content/70 leading-relaxed">
									All API keys are protected before browser storage by randomly
									inserting the interior canary marker <code>tuGBaB</code>. If
									browser data is ever scraped, raw keys cannot be used by
									unauthorized parties.
								</p>
							</div>
						</div>
					</div>

					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<h3 className="text-xs font-bold uppercase tracking-wider text-base-content/70">
								Fallback Priority Chain
							</h3>
							<span className="text-[11px] text-base-content/50">
								Highest priority used first
							</span>
						</div>
						<div className="bg-base-200/60 rounded-xl p-2.5 border border-base-300 space-y-1.5">
							{settings.order.map((id, idx) => {
								const meta = PROVIDER_METAS[id]
								const conf = settings.providers[id]
								const isConfigured = id === 'free_web' || Boolean(conf?.key)
								return (
									<div
										key={id}
										className="flex items-center justify-between bg-base-100 px-3 py-2 rounded-lg border border-base-300/60 text-xs"
									>
										<div className="flex items-center gap-2">
											<span className="w-5 h-5 rounded-full bg-base-200 flex items-center justify-center font-mono font-bold text-[10px] text-base-content/70">
												{idx + 1}
											</span>
											<span className="font-semibold">{meta.name}</span>
											{meta.badge && (
												<span className="py-2 badge badge-xs badge-neutral text-[10px]">
													{meta.badge}
												</span>
											)}
											{isConfigured ? (
												<span className="badge badge-xs badge-success text-[10px] gap-1">
													● Ready
												</span>
											) : (
												<span className="badge badge-xs badge-ghost text-[10px]">
													No Key
												</span>
											)}
										</div>
										<div className="flex items-center gap-1">
											<Tooltip content="Move up in priority" position="top">
												<button
													type="button"
													onClick={() => moveOrder(idx, 'up')}
													disabled={idx === 0}
													className="btn btn-ghost btn-xs btn-circle disabled:opacity-30"
													aria-label="Move up in priority"
												>
													▲
												</button>
											</Tooltip>
											<Tooltip content="Move down in priority" position="top">
												<button
													type="button"
													onClick={() => moveOrder(idx, 'down')}
													disabled={idx === settings.order.length - 1}
													className="btn btn-ghost btn-xs btn-circle disabled:opacity-30"
													aria-label="Move down in priority"
												>
													▼
												</button>
											</Tooltip>
										</div>
									</div>
								)
							})}
						</div>
					</div>

					<div className="space-y-4">
						<h3 className="text-xs font-bold uppercase tracking-wider text-base-content/70">
							Configure Providers
						</h3>

						<div className="bg-base-200/40 rounded-xl p-3.5 border border-base-300 space-y-2.5">
							<div className="flex items-center justify-between">
								<div>
									<div className="flex items-center gap-2">
										<span className="font-bold text-xs">DeepL API</span>
										<span className="badge badge-xs badge-primary text-[10px]">
											High Quality
										</span>
									</div>
									<p className="text-[11px] text-base-content/60 mt-0.5">
										Free tier (500k chars/mo) or Pro.
									</p>
								</div>
								<input
									type="checkbox"
									checked={settings.providers.deepl.enabled}
									aria-label="Enable DeepL"
									onChange={(e) => setProviderEnabled('deepl', e.target.checked)}
									className="toggle toggle-primary toggle-sm"
								/>
							</div>
							<div className="flex gap-2">
								<input
									type="password"
									placeholder={PROVIDER_METAS.deepl.keyPlaceholder}
									aria-label="DeepL API key"
									value={
										editingKey.deepl !== ''
											? editingKey.deepl
											: deobfuscateApiKey(settings.providers.deepl.key || '')
									}
									onChange={(e) => handleKeyChange('deepl', e.target.value)}
									className="input input-sm input-bordered flex-1 text-xs font-mono"
								/>
								<button
									type="button"
									onClick={() => runTest('deepl')}
									disabled={
										!settings.providers.deepl.key || testResults.deepl?.loading
									}
									className="btn btn-sm btn-outline text-xs"
								>
									{testResults.deepl?.loading ? 'Testing...' : 'Test Key'}
								</button>
							</div>
							{testResults.deepl?.msg && (
								<p
									className={`text-[11px] ${testResults.deepl.ok ? 'text-success' : 'text-error'}`}
								>
									{testResults.deepl.msg}
								</p>
							)}
						</div>

						<div className="bg-base-200/40 rounded-xl p-3.5 border border-base-300 space-y-2.5">
							<div className="flex items-center justify-between">
								<div>
									<div className="flex items-center gap-2">
										<span className="font-bold text-xs">
											Google Cloud Translation v2
										</span>
									</div>
									<p className="text-[11px] text-base-content/60 mt-0.5">
										Broad language support and low latency.
									</p>
								</div>
								<input
									type="checkbox"
									checked={settings.providers.google_cloud.enabled}
									aria-label="Enable Google Cloud Translation"
									onChange={(e) =>
										setProviderEnabled('google_cloud', e.target.checked)
									}
									className="toggle toggle-primary toggle-sm"
								/>
							</div>
							<div className="flex gap-2">
								<input
									type="password"
									placeholder={PROVIDER_METAS.google_cloud.keyPlaceholder}
									aria-label="Google Cloud API key"
									value={
										editingKey.google_cloud !== ''
											? editingKey.google_cloud
											: deobfuscateApiKey(
													settings.providers.google_cloud.key || ''
												)
									}
									onChange={(e) =>
										handleKeyChange('google_cloud', e.target.value)
									}
									className="input input-sm input-bordered flex-1 text-xs font-mono"
								/>
								<button
									type="button"
									onClick={() => runTest('google_cloud')}
									disabled={
										!settings.providers.google_cloud.key ||
										testResults.google_cloud?.loading
									}
									className="btn btn-sm btn-outline text-xs"
								>
									{testResults.google_cloud?.loading ? 'Testing...' : 'Test Key'}
								</button>
							</div>
							{testResults.google_cloud?.msg && (
								<p
									className={`text-[11px] ${testResults.google_cloud.ok ? 'text-success' : 'text-error'}`}
								>
									{testResults.google_cloud.msg}
								</p>
							)}
						</div>

						<div className="bg-base-200/40 rounded-xl p-3.5 border border-base-300 space-y-2.5">
							<div className="flex items-center justify-between">
								<div>
									<div className="flex items-center gap-2">
										<span className="font-bold text-xs">
											Microsoft Azure Translator
										</span>
									</div>
									<p className="text-[11px] text-base-content/60 mt-0.5">
										2M characters/month free tier on Azure.
									</p>
								</div>
								<input
									type="checkbox"
									checked={settings.providers.azure.enabled}
									aria-label="Enable Azure Translator"
									onChange={(e) => setProviderEnabled('azure', e.target.checked)}
									className="toggle toggle-primary toggle-sm"
								/>
							</div>
							<div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
								<input
									type="password"
									placeholder="Azure Secret Key"
									aria-label="Azure secret key"
									value={
										editingKey.azure !== ''
											? editingKey.azure
											: deobfuscateApiKey(settings.providers.azure.key || '')
									}
									onChange={(e) => handleKeyChange('azure', e.target.value)}
									className="input input-sm input-bordered sm:col-span-2 text-xs font-mono"
								/>
								<input
									type="text"
									placeholder="Region (e.g. global)"
									aria-label="Azure region"
									value={settings.providers.azure.region || 'global'}
									onChange={(e) => setProviderRegion(e.target.value)}
									className="input input-sm input-bordered text-xs"
								/>
							</div>
							<div className="flex justify-end">
								<button
									type="button"
									onClick={() => runTest('azure')}
									disabled={
										!settings.providers.azure.key || testResults.azure?.loading
									}
									className="btn btn-sm btn-outline text-xs"
								>
									{testResults.azure?.loading ? 'Testing...' : 'Test Key'}
								</button>
							</div>
							{testResults.azure?.msg && (
								<p
									className={`text-[11px] ${testResults.azure.ok ? 'text-success' : 'text-error'}`}
								>
									{testResults.azure.msg}
								</p>
							)}
						</div>

						<div className="bg-base-200/40 rounded-xl p-3.5 border border-base-300 space-y-2.5">
							<div className="flex items-center justify-between">
								<div>
									<div className="flex items-center gap-2">
										<span className="font-bold text-xs">LibreTranslate</span>
										<span className="py-2 badge badge-xs badge-neutral text-[10px]">
											Self-Hosted / BYOK
										</span>
									</div>
									<p className="text-[11px] text-base-content/60 mt-0.5">
										Self-hosted instance (e.g. http://localhost:5000) or
										libretranslate.com (API key required).
									</p>
								</div>
								<input
									type="checkbox"
									checked={settings.providers.libretranslate.enabled}
									aria-label="Enable LibreTranslate"
									onChange={(e) =>
										setProviderEnabled('libretranslate', e.target.checked)
									}
									className="toggle toggle-primary toggle-sm"
								/>
							</div>
							<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
								<input
									type="text"
									placeholder="https://libretranslate.com or http://localhost:5000"
									aria-label="LibreTranslate endpoint"
									value={settings.providers.libretranslate.endpoint || ''}
									onChange={(e) => setProviderEndpoint(e.target.value)}
									className="input input-sm input-bordered text-xs font-mono"
								/>
								<input
									type="password"
									placeholder={
										settings.providers.libretranslate.endpoint?.includes(
											'localhost'
										) ||
										settings.providers.libretranslate.endpoint?.includes(
											'127.0.0.1'
										)
											? 'API key (optional for local)'
											: 'API key (required for libretranslate.com)'
									}
									value={
										editingKey.libretranslate !== ''
											? editingKey.libretranslate
											: deobfuscateApiKey(
													settings.providers.libretranslate.key || ''
												)
									}
									onChange={(e) =>
										handleKeyChange('libretranslate', e.target.value)
									}
									aria-label="LibreTranslate API key"
									className="input input-sm input-bordered text-xs font-mono"
								/>
							</div>
							{!(
								settings.providers.libretranslate.endpoint?.includes('localhost') ||
								settings.providers.libretranslate.endpoint?.includes('127.0.0.1')
							) &&
								!settings.providers.libretranslate.key &&
								!editingKey.libretranslate && (
									<p className="text-[10px] text-base-content/60">
										* Note: libretranslate.com requires an API key. For 100%
										free translation without an API key, use the default Free
										Web Translator below.
									</p>
								)}
							<div className="flex justify-end">
								<button
									type="button"
									onClick={() => runTest('libretranslate')}
									disabled={testResults.libretranslate?.loading}
									className="btn btn-sm btn-outline text-xs"
								>
									{testResults.libretranslate?.loading
										? 'Testing...'
										: 'Test Connection'}
								</button>
							</div>
							{testResults.libretranslate?.msg && (
								<p
									className={`text-[11px] ${testResults.libretranslate.ok ? 'text-success' : 'text-error'}`}
								>
									{testResults.libretranslate.msg}
								</p>
							)}
						</div>

						<div className="bg-base-200/40 rounded-xl p-3.5 border border-base-300 space-y-2.5">
							<div className="flex items-center justify-between">
								<div>
									<div className="flex items-center gap-2">
										<span className="font-bold text-xs">
											Free Web Translator
										</span>
										<span className="badge badge-xs badge-success text-[10px]">
											100% Free Default
										</span>
									</div>
									<p className="text-[11px] text-base-content/60 mt-0.5">
										Always active out-of-the-box. Used when no keys are supplied
										or if all configured BYOKs fail.
									</p>
								</div>
								<button
									type="button"
									onClick={() => runTest('free_web')}
									disabled={testResults.free_web?.loading}
									className="btn btn-sm btn-outline text-xs"
								>
									{testResults.free_web?.loading ? 'Testing...' : 'Test'}
								</button>
							</div>
							{testResults.free_web?.msg && (
								<p
									className={`text-[11px] ${testResults.free_web.ok ? 'text-success' : 'text-error'}`}
								>
									{testResults.free_web.msg}
								</p>
							)}
						</div>
					</div>

					<div className="bg-base-200/60 rounded-xl p-3.5 border border-base-300 flex items-center justify-between flex-wrap gap-2">
						<div>
							<span className="font-bold text-xs">IndexedDB Translation Cache</span>
							<p className="text-[11px] text-base-content/60">
								{cacheStats.count} sections cached ({cacheStats.estimatedSizeKb}{' '}
								KB). Revisits load in &lt;5ms.
							</p>
						</div>
						<div className="flex items-center gap-2">
							{cacheClearedMsg && (
								<span className="text-xs text-success font-medium">
									Cache cleared!
								</span>
							)}
							<button
								type="button"
								onClick={handleClearCache}
								className="btn btn-xs btn-ghost border border-base-300"
							>
								Clear Cache
							</button>
						</div>
					</div>
				</div>

				<div className="px-6 py-3 border-t border-base-300 flex justify-end shrink-0 bg-base-200/50">
					<button
						type="button"
						onClick={closeSettings}
						className="btn btn-primary btn-sm px-6"
					>
						Done
					</button>
				</div>
			</div>
		</div>
	)
}
