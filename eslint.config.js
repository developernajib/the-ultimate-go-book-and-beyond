import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	{ ignores: ['dist/', 'public/chapters/'] },
	...tseslint.configs.recommended,
	reactHooks.configs.flat.recommended,
	{
		rules: {
			// Ported reader code initializes mount-once state (cursor blink,
			// palette reset, sidebar scroll) inside effects on purpose
			'react-hooks/set-state-in-effect': 'off',
		},
	}
)
