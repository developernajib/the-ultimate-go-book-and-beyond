/** @type {import('tailwindcss').Config} */
export default {
    content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
    theme: {
        extend: {},
        container: false,
    },
    plugins: [require('daisyui')],
    daisyui: {
        themes: [
            {
                gobook: {
                    'color-scheme': 'dark',
                    // Go's Gopher Blue as primary
                    primary: 'oklch(62% 0.15 200)',
                    'primary-content': 'oklch(98% 0.01 200)',
                    // Lighter cyan as secondary
                    secondary: 'oklch(70% 0.12 195)',
                    'secondary-content': 'oklch(15% 0.02 195)',
                    // Teal accent
                    accent: 'oklch(65% 0.14 180)',
                    'accent-content': 'oklch(98% 0.01 180)',
                    // Neutral dark grays
                    neutral: 'oklch(25% 0.015 240)',
                    'neutral-content': 'oklch(85% 0.005 240)',
                    // Dark base colors
                    'base-100': 'oklch(18% 0.01 240)',
                    'base-200': 'oklch(15% 0.01 240)',
                    'base-300': 'oklch(12% 0.01 240)',
                    'base-content': 'oklch(90% 0.01 240)',
                    // Status colors
                    info: 'oklch(62% 0.15 230)',
                    'info-content': 'oklch(98% 0.02 230)',
                    success: 'oklch(65% 0.15 145)',
                    'success-content': 'oklch(15% 0.02 145)',
                    warning: 'oklch(75% 0.15 70)',
                    'warning-content': 'oklch(15% 0.02 70)',
                    error: 'oklch(55% 0.18 25)',
                    'error-content': 'oklch(95% 0.02 25)',
                    // Styling
                    '--rounded-box': '0.5rem',
                    '--rounded-btn': '0.375rem',
                    '--rounded-badge': '0.25rem',
                    '--animation-btn': '0.25s',
                    '--animation-input': '0.2s',
                    '--btn-focus-scale': '0.95',
                    '--border-btn': '1px',
                    '--tab-border': '1px',
                    '--tab-radius': '0.5rem',
                },
                gobooklight: {
                    'color-scheme': 'light',
                    // Go's Gopher Blue as primary
                    primary: 'oklch(55% 0.18 200)',
                    'primary-content': 'oklch(98% 0.01 200)',
                    // Lighter cyan as secondary
                    secondary: 'oklch(60% 0.14 195)',
                    'secondary-content': 'oklch(98% 0.01 195)',
                    // Teal accent
                    accent: 'oklch(55% 0.16 180)',
                    'accent-content': 'oklch(98% 0.01 180)',
                    // Light neutrals
                    neutral: 'oklch(30% 0.02 240)',
                    'neutral-content': 'oklch(95% 0.005 240)',
                    // Light base colors
                    'base-100': 'oklch(99% 0.005 240)',
                    'base-200': 'oklch(96% 0.008 240)',
                    'base-300': 'oklch(93% 0.01 240)',
                    'base-content': 'oklch(20% 0.02 240)',
                    // Status colors
                    info: 'oklch(55% 0.15 230)',
                    'info-content': 'oklch(98% 0.02 230)',
                    success: 'oklch(55% 0.15 145)',
                    'success-content': 'oklch(98% 0.02 145)',
                    warning: 'oklch(65% 0.15 70)',
                    'warning-content': 'oklch(15% 0.02 70)',
                    error: 'oklch(50% 0.18 25)',
                    'error-content': 'oklch(98% 0.02 25)',
                    // Styling
                    '--rounded-box': '0.5rem',
                    '--rounded-btn': '0.375rem',
                    '--rounded-badge': '0.25rem',
                    '--animation-btn': '0.25s',
                    '--animation-input': '0.2s',
                    '--btn-focus-scale': '0.95',
                    '--border-btn': '1px',
                    '--tab-border': '1px',
                    '--tab-radius': '0.5rem',
                },
            },
        ],
        darkTheme: 'gobook',
        base: true,
        styled: true,
        utils: true,
    },
}
