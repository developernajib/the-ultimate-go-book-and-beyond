import { useEffect, useState } from 'react'

const DARK_THEME = 'gobook'
const LIGHT_THEME = 'gobooklight'

function getInitialTheme() {
    if (typeof window !== 'undefined') {
        return localStorage.getItem('theme') || DARK_THEME
    }
    return DARK_THEME
}

export default function ThemeToggle() {
    const [theme, setTheme] = useState(getInitialTheme)

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme)
    }, [theme])

    const toggleTheme = () => {
        const next = theme === DARK_THEME ? LIGHT_THEME : DARK_THEME
        setTheme(next)
        localStorage.setItem('theme', next)
        document.documentElement.setAttribute('data-theme', next)
    }

    return (
        <button
            onClick={toggleTheme}
            className="btn btn-ghost btn-circle transition-shadow hover:ring-2 hover:ring-accent/40"
            aria-label="Toggle theme"
        >
            {theme === DARK_THEME ? (
                // Sun — switch to light
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                    />
                </svg>
            ) : (
                // Moon — switch to dark
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                    />
                </svg>
            )}
        </button>
    )
}
