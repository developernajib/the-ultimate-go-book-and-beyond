import { useState, useTransition, useMemo } from 'react'
import { useTranslation } from '@/lib/translation/TranslationContext'
import {
	ALL_LANGUAGES,
	PROVIDER_METAS,
	getEffectiveActiveProvider,
	getLanguagesForProvider,
	moveHebrewAndHindiToEnd,
} from '@/lib/translation/types'
import Tooltip from './Tooltip'

export default function LanguageSelector() {
	const { language, setLanguage, openSettings, settings, activeProvider, isTranslating, t } =
		useTranslation()

	const [isOpen, setIsOpen] = useState(false)
	const [search, setSearch] = useState('')
	const [showAllOverride, setShowAllOverride] = useState(false)
	const [, startTransition] = useTransition()

	const activeEngine = activeProvider || getEffectiveActiveProvider(settings)
	const providerLanguages = useMemo(() => getLanguagesForProvider(activeEngine), [activeEngine])

	const currentLang = ALL_LANGUAGES.find((l) => l.code === language) || ALL_LANGUAGES[0]

	const baseLanguages = showAllOverride ? ALL_LANGUAGES : providerLanguages

	const filteredLanguages = useMemo(() => {
		let list = baseLanguages
		if (search.trim()) {
			const q = search.trim().toLowerCase()
			list = baseLanguages.filter((lang) => {
				return (
					lang.name.toLowerCase().includes(q) ||
					lang.nativeName.toLowerCase().includes(q) ||
					lang.code.toLowerCase().includes(q)
				)
			})
			const ordered = moveHebrewAndHindiToEnd(list)
			const activeIdx = ordered.findIndex((l) => l.code === currentLang.code)
			if (activeIdx > 0) {
				return [
					ordered[activeIdx],
					...ordered.slice(0, activeIdx),
					...ordered.slice(activeIdx + 1),
				]
			}
			return ordered
		}

		const ordered = moveHebrewAndHindiToEnd(list)
		const activeIdx = ordered.findIndex((l) => l.code === currentLang.code)
		if (activeIdx > 0) {
			return [
				ordered[activeIdx],
				...ordered.slice(0, activeIdx),
				...ordered.slice(activeIdx + 1),
			]
		} else if (activeIdx === -1) {
			return [currentLang, ...ordered]
		}
		return ordered
	}, [baseLanguages, search, currentLang])

	const handleSelect = (code: string) => {
		startTransition(() => {
			setLanguage(code)
			setIsOpen(false)
		})
	}

	return (
		<div className="relative">
			<Tooltip content={t('translateBookLanguage')} position="bottom">
				<button
					type="button"
					onClick={() => setIsOpen(!isOpen)}
					className="btn btn-ghost btn-sm gap-1.5 px-2 border border-base-300/60 font-medium"
					aria-label={t('selectLanguage')}
					aria-expanded={isOpen}
				>
					{isTranslating ? (
						<span className="loading loading-spinner loading-xs text-primary" />
					) : (
						<svg
							aria-hidden="true"
							className="w-4 h-4 text-base-content/70"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"
							/>
						</svg>
					)}
					<span className="text-xs uppercase tracking-wider font-mono">
						{currentLang.code.split('-')[0]}
					</span>
					<svg
						aria-hidden="true"
						className={`w-3 h-3 text-base-content/50 transition-transform ${isOpen ? 'rotate-180' : ''}`}
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M19 9l-7 7-7-7"
						/>
					</svg>
				</button>
			</Tooltip>

			{isOpen && (
				<>
					<div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />

					<div className="absolute right-0 mt-2 z-50 w-80 rounded-xl bg-base-100 p-2 shadow-2xl border border-base-300">
						<div className="px-2.5 py-1.5 mb-1.5 flex items-center justify-between text-[11px] text-base-content/60 border-b border-base-200">
							<span className="font-semibold">
								{filteredLanguages.length}{' '}
								{filteredLanguages.length === 1 ? t('language') : t('languages')}
							</span>
							<span className="py-2 badge badge-xs badge-neutral">
								{PROVIDER_METAS[activeEngine]?.name || activeEngine}
							</span>
						</div>

						<div className="px-2 pb-2">
							<input
								type="text"
								placeholder={t('searchLanguagesPlaceholder')}
								aria-label={t('searchLanguagesPlaceholder')}
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								className="input input-xs input-bordered w-full"
								autoFocus
							/>
						</div>

						{providerLanguages.length < ALL_LANGUAGES.length && (
							<div className="px-2 pb-2 text-center">
								<button
									type="button"
									onClick={() => setShowAllOverride((prev) => !prev)}
									className="text-[11px] text-primary hover:underline font-medium"
								>
									{showAllOverride
										? `Show ${providerLanguages.length} ${PROVIDER_METAS[activeEngine]?.name || activeEngine} languages only`
										: `Show all ${ALL_LANGUAGES.length} languages (via Free Web)`}
								</button>
							</div>
						)}

						<div className="max-h-64 overflow-y-auto space-y-0.5 py-1 pr-1">
							{filteredLanguages.map((lang, idx) => {
								const isSelected = lang.code === currentLang.code
								return (
									<div key={lang.code}>
										<button
											type="button"
											onClick={() => handleSelect(lang.code)}
											className={`w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-xs transition-colors ${
												isSelected
													? 'bg-primary/10 text-primary font-semibold'
													: 'hover:bg-base-200 text-base-content/80'
											}`}
										>
											<div className="flex items-center gap-2 min-w-0">
												<span className="font-medium truncate">
													{lang.nativeName}
												</span>
												{lang.name !== lang.nativeName && (
													<span className="text-[10px] text-base-content/50 truncate">
														({lang.name})
													</span>
												)}
											</div>
											<div className="flex items-center gap-1.5 shrink-0 ml-2">
												{lang.rtl && (
													<span className="text-[9px] uppercase px-1 py-0.5 rounded bg-base-200 text-base-content/50">
														RTL
													</span>
												)}
												{isSelected && (
													<svg
														aria-hidden="true"
														className="w-4 h-4 text-primary"
														fill="none"
														viewBox="0 0 24 24"
														stroke="currentColor"
													>
														<path
															strokeLinecap="round"
															strokeLinejoin="round"
															strokeWidth={2}
															d="M5 13l4 4L19 7"
														/>
													</svg>
												)}
											</div>
										</button>
										{!search.trim() &&
											isSelected &&
											idx === 0 &&
											filteredLanguages.length > 1 && (
												<div className="border-b border-base-200/80 my-1 mx-1" />
											)}
									</div>
								)
							})}
							{filteredLanguages.length === 0 && (
								<p className="text-center py-4 text-xs text-base-content/50">
									{t('noLanguageMatches')} &quot;{search}&quot;
								</p>
							)}
						</div>

						<div className="border-t border-base-200 mt-2 pt-2 px-1">
							<button
								type="button"
								onClick={() => {
									setIsOpen(false)
									openSettings()
								}}
								className="w-full btn btn-xs btn-outline btn-primary gap-1.5"
							>
								<svg
									aria-hidden="true"
									className="w-3.5 h-3.5"
									fill="none"
									viewBox="0 0 24 24"
									stroke="currentColor"
								>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
									/>
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
									/>
								</svg>
								<span>{t('translationKeysAndOrder')}</span>
							</button>
						</div>
					</div>
				</>
			)}
		</div>
	)
}
