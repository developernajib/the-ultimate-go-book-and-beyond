import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router'
import { getAllChapters } from '@/lib/chapters'
import { useTranslation, useTranslatedTexts } from '@/lib/translation/TranslationContext'

type KeyboardEvent = React.KeyboardEvent<HTMLInputElement>

const WELCOME_MESSAGES: Record<string, string> = {
	en: 'Welcome to The Ultimate Go Book & Beyond',
	es: 'Bienvenido a The Ultimate Go Book & Beyond',
	zh: '欢迎阅读《The Ultimate Go Book & Beyond》',
	ja: '『The Ultimate Go Book & Beyond』へようこそ',
	de: 'Willkommen bei The Ultimate Go Book & Beyond',
	fr: 'Bienvenue dans The Ultimate Go Book & Beyond',
	pt: 'Bem-vindo ao The Ultimate Go Book & Beyond',
	ru: 'Добро пожаловать в The Ultimate Go Book & Beyond',
	ko: 'The Ultimate Go Book & Beyond에 오신 것을 환영합니다',
	hi: 'The Ultimate Go Book & Beyond में आपका स्वागत है',
	bn: 'The Ultimate Go Book & Beyond-এ স্বাগতম',
	id: 'Selamat datang di The Ultimate Go Book & Beyond',
	it: 'Benvenuto in The Ultimate Go Book & Beyond',
	ar: 'مرحبًا بك في The Ultimate Go Book & Beyond',
	tr: "The Ultimate Go Book & Beyond'a hoş geldiniz",
	vi: 'Chào mừng bạn đến với The Ultimate Go Book & Beyond',
}

const SUBTITLE_MESSAGES: Record<string, string> = {
	en: 'Your complete path from beginner to senior engineer.',
	es: 'Tu camino completo desde principiante a ingeniero senior.',
	zh: '从初学者到高级工程师的完整进阶之路。',
	ja: '初心者からシニアエンジニアまでの完全なロードマップ。',
	de: 'Ihr kompletter Weg vom Anfänger zum Senior Engineer.',
	fr: 'Votre parcours complet de débutant à ingénieur senior.',
	pt: 'Seu caminho completo de iniciante a engenheiro sênior.',
	ru: 'Ваш полный путь от новичка до старшего инженера.',
	ko: '초보자부터 시니어 엔지니어까지의 완벽한 여정.',
	hi: 'शुरुआती से वरिष्ठ इंजीनियर तक का आपका पूरा रास्ता।',
	bn: 'শিক্ষানবিস থেকে সিনিয়র ইঞ্জিনিয়ার হওয়ার সম্পূর্ণ পথ।',
	id: 'Jalur lengkap Anda dari pemula hingga insinyur senior.',
	it: 'Il tuo percorso completo da principiante a ingegnere senior.',
	ar: 'مسارك الكامل من المبتدئ إلى المهندس الأول.',
	tr: 'Yeni başlayandan kıdemli mühendise kadar eksiksiz yolunuz.',
	vi: 'Lộ trình hoàn chỉnh từ người mới bắt đầu đến kỹ sư cấp cao.',
}

const TYPE_PROMPTS: Record<string, string> = {
	en: 'Type: go run gobook',
	es: 'Escriba: go run gobook',
	zh: '输入: go run gobook',
	ja: '入力: go run gobook',
	de: 'Eingeben: go run gobook',
	fr: 'Tapez: go run gobook',
	pt: 'Digite: go run gobook',
	ru: 'Введите: go run gobook',
	ko: '입력: go run gobook',
	hi: 'टाइप करें: go run gobook',
	bn: 'টাইপ করুন: go run gobook',
	id: 'Ketik: go run gobook',
	it: 'Digita: go run gobook',
	ar: 'اكتب: go run gobook',
	tr: 'Yazın: go run gobook',
	vi: 'Gõ: go run gobook',
}

const TRY_PROMPTS: Record<string, string> = {
	en: 'Try: go run gobook',
	es: 'Pruebe: go run gobook',
	zh: '尝试: go run gobook',
	ja: '試す: go run gobook',
	de: 'Versuchen Sie: go run gobook',
	fr: 'Essayez: go run gobook',
	pt: 'Tente: go run gobook',
	ru: 'Попробуйте: go run gobook',
	ko: '시도: go run gobook',
	hi: 'प्रयास करें: go run gobook',
	bn: 'চেষ্টা করুন: go run gobook',
	id: 'Coba: go run gobook',
	it: 'Prova: go run gobook',
	ar: 'جرب: go run gobook',
	tr: 'Deneyin: go run gobook',
	vi: 'Thử: go run gobook',
}

const INTERACTIVE_BADGES: Record<string, string> = {
	en: 'Interactive terminal • Type to get started',
	es: 'Terminal interactivo • Escriba para comenzar',
	zh: '交互式终端 • 输入即可开始',
	ja: '対話型ターミナル • 入力して開始',
	de: 'Interaktives Terminal • Tippen zum Starten',
	fr: 'Terminal interactif • Tapez pour commencer',
	pt: 'Terminal interativo • Digite para começar',
	ru: 'Интерактивный терминал • Введите команду для начала',
	ko: '대화형 터미널 • 입력을 시작하세요',
	hi: 'इंटरएक्टिव टर्मिनल • शुरू करने के लिए टाइप करें',
	bn: 'ইন্টারেক্টিভ টার্মিনাল • শুরু করতে টাইপ করুন',
	id: 'Terminal interaktif • Ketik untuk memulai',
	it: 'Terminal interattivo • Digita per iniziare',
	ar: 'محطة تفاعلية • اكتب للبدء',
	tr: 'Etkileşimli terminal • Başlamak için yazın',
	vi: 'Terminal tương tác • Gõ để bắt đầu',
}

const TERMINAL_DYNAMIC_TEXTS = [
	'Welcome to The Ultimate Go Book & Beyond',
	'Your complete path from beginner to senior engineer.',
	'Type: go run gobook',
	'Try: go run gobook',
	'Interactive terminal • Type to get started',
	'Terminal input',
	'🚀 Initializing Go Book...',
	'📚 Loading 150+ chapters...',
	'✨ Preparing your path to senior engineer...',
	'✓ Ready! Starting Chapter 1...',
	'Available commands:',
	'  go run gobook     - Start your learning journey',
	'  go version        - Show Go version info',
	'  author            - Project started by (Author) ',
	'  help              - Show this message',
	'  clear             - Clear terminal',
]

export default function AnimatedTerminal() {
	const navigate = useNavigate()
	const { language } = useTranslation()
	const tr = useTranslatedTexts(TERMINAL_DYNAMIC_TEXTS)
	const [input, setInput] = useState('')
	const [history, setHistory] = useState<string[]>([
		'Welcome to The Ultimate Go Book & Beyond',
		'',
		'Your complete path from beginner to senior engineer.',
		'Type: go run gobook',
		'',
		'$ ',
	])
	const [cursorVisible, setCursorVisible] = useState(true)
	const [cursorPos, setCursorPos] = useState(0)
	const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
		const update = () => setPrefersReducedMotion(mq.matches)
		update()
		mq.addEventListener('change', update)
		return () => mq.removeEventListener('change', update)
	}, [])

	useEffect(() => {
		if (prefersReducedMotion) {
			setCursorVisible(true)
			return
		}
		const id = setInterval(() => setCursorVisible((v) => !v), 530)
		return () => clearInterval(id)
	}, [prefersReducedMotion])

	const handleKeyDown = async (e: KeyboardEvent) => {
		if (e.key !== 'Enter') return
		e.preventDefault()
		const cmd = input.trim()

		if (cmd === 'go run gobook') {
			setHistory((prev) => [
				...prev,
				`$ ${cmd}`,
				'',
				'🚀 Initializing Go Book...',
				'📚 Loading 150+ chapters...',
				'✨ Preparing your path to senior engineer...',
				'',
				'✓ Ready! Starting Chapter 1...',
			])
			setInput('')
			setTimeout(async () => {
				const chapters = await getAllChapters()
				const first = chapters[0]
				if (first) navigate(`/chapters/${first.slug}`)
			}, 1800)
		} else if (cmd === 'clear') {
			setHistory(['$ '])
			setInput('')
		} else if (cmd === 'help') {
			setHistory((prev) => [
				...prev,
				`$ ${cmd}`,
				'',
				'Available commands:',
				'  go run gobook     - Start your learning journey',
				'  go version        - Show Go version info',
				'  author            - Project started by (Author) ',
				'  help              - Show this message',
				'  clear             - Clear terminal',
				'',
				'$ ',
			])
			setInput('')
		} else if (cmd === 'go version') {
			setHistory((prev) => [...prev, `$ ${cmd}`, 'go version go1.27.1 linux/amd64', '', '$ '])
			setInput('')
		} else if (cmd === 'author') {
			setHistory((prev) => [
				...prev,
				`$ ${cmd}`,
				'Md Najib Islam (developernajib@pm.me)',
				'',
				'$ ',
			])
			setInput('')
		} else if (cmd) {
			setHistory((prev) => [
				...prev,
				`$ ${cmd}`,
				`zsh: command not found: ${cmd}`,
				'',
				'Try: go run gobook',
				'$ ',
			])
			setInput('')
		} else {
			setHistory((prev) => [...prev, '$ '])
			setInput('')
			setCursorPos(0)
		}
	}

	const txt = (line: string): string => {
		if (line === 'Welcome to The Ultimate Go Book & Beyond') {
			return (
				(language !== 'en' && WELCOME_MESSAGES[language]) || tr[line] || WELCOME_MESSAGES.en
			)
		}
		if (line === 'Your complete path from beginner to senior engineer.') {
			return (
				(language !== 'en' && SUBTITLE_MESSAGES[language]) ||
				tr[line] ||
				SUBTITLE_MESSAGES.en
			)
		}
		if (line === 'Type: go run gobook') {
			return (language !== 'en' && TYPE_PROMPTS[language]) || tr[line] || TYPE_PROMPTS.en
		}
		if (line === 'Try: go run gobook') {
			return (language !== 'en' && TRY_PROMPTS[language]) || tr[line] || TRY_PROMPTS.en
		}
		if (language === 'en') return line
		const translated = tr[line]
		if (translated) {
			return line.startsWith('  ') && !translated.startsWith('  ')
				? '  ' + translated
				: translated
		}
		return line
	}

	return (
		<div className="mx-auto w-full max-w-2xl px-2">
			<div className="group relative overflow-hidden rounded-xl border-2 border-base-300 bg-base-300/40 bg-gradient-to-b from-base-300/60 via-base-300/20 to-base-100/10 shadow-lg backdrop-blur transition-all duration-150 hover:shadow-xl [html[data-theme=gobook]_&]:border-primary/40 [html[data-theme=gobook]_&]:hover:border-primary/70">
				<div className="flex items-center gap-2 border-b border-base-300/70 bg-base-300/70 px-3 sm:px-4 py-2.5">
					<div className="flex gap-1.5 shrink-0">
						<div className="h-2 w-2 sm:h-2.5 sm:w-2.5 rounded-full bg-error/80 group-hover:bg-error transition-colors" />
						<div className="h-2 w-2 sm:h-2.5 sm:w-2.5 rounded-full bg-warning/80 group-hover:bg-warning transition-colors" />
						<div className="h-2 w-2 sm:h-2.5 sm:w-2.5 rounded-full bg-success/80 group-hover:bg-success transition-colors" />
					</div>
					<div className="flex-1 text-center text-xs sm:text-sm font-medium text-base-content/70 truncate">
						bash - gobook
					</div>
				</div>

				<div
					className="relative cursor-ibeam p-3 sm:p-4 md:p-5 font-mono text-[0.7rem] sm:text-xs md:text-sm min-h-[260px] sm:min-h-[300px] text-left text-base-content/90 overflow-x-auto"
					onClick={() => inputRef.current?.focus()}
				>
					{history.map((line, idx) => {
						const isLastPrompt = line.startsWith('$ ') && idx === history.length - 1
						const isPastPrompt = line.startsWith('$ ') && !isLastPrompt

						if (isLastPrompt) {
							return (
								<div key={idx} className="flex items-center">
									<span className="mr-1 sm:mr-2 text-[0.65rem] sm:text-[0.75rem] text-base-content/50 shrink-0">
										gobook %
									</span>
									<span className="font-semibold text-primary shrink-0">$ </span>
									<span className="ml-1 sm:ml-2 text-base-content break-all">
										{input.slice(0, cursorPos)}
										<span
											className={`inline-block h-4 sm:h-5 w-1.5 sm:w-2 align-middle ${cursorVisible ? 'bg-primary' : 'bg-transparent'}`}
										/>
										{input.slice(cursorPos)}
									</span>
								</div>
							)
						}
						if (isPastPrompt) {
							return (
								<div
									key={idx}
									className="flex items-center font-semibold text-primary"
								>
									<span className="mr-1 sm:mr-2 text-[0.65rem] sm:text-[0.75rem] text-base-content/50 shrink-0">
										gobook %
									</span>
									<span className="break-all">{line}</span>
								</div>
							)
						}
						return (
							<div
								key={idx}
								className="whitespace-pre-wrap break-words text-base-content/90"
							>
								{txt(line)}
							</div>
						)
					})}

					<input
						ref={inputRef}
						type="text"
						value={input}
						onChange={(e) => {
							setInput(e.target.value)
							setCursorPos(e.target.selectionStart ?? e.target.value.length)
						}}
						onKeyDown={handleKeyDown}
						onKeyUp={() =>
							setCursorPos(inputRef.current?.selectionStart ?? input.length)
						}
						onClick={() =>
							setCursorPos(inputRef.current?.selectionStart ?? input.length)
						}
						onSelect={() =>
							setCursorPos(inputRef.current?.selectionStart ?? input.length)
						}
						className="opacity-0 absolute pointer-events-none"
						autoFocus
						aria-label={tr['Terminal input'] || 'Terminal input'}
					/>
				</div>
			</div>

			<div className="mt-3 flex justify-center text-xs sm:text-sm text-base-content/70 px-2">
				<div className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-base-100/10 px-3 py-1.5 max-w-full">
					<span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
					<span className="italic break-words text-center">
						{(language !== 'en' && INTERACTIVE_BADGES[language]) ||
							tr['Interactive terminal • Type to get started'] ||
							INTERACTIVE_BADGES.en}
					</span>
				</div>
			</div>
		</div>
	)
}
