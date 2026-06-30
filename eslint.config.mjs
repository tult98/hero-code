import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		files: ['src/**/*.ts'],
		extends: [...tseslint.configs.recommended],
		rules: {
			'@typescript-eslint/naming-convention': [
				'warn',
				{
					selector: 'import',
					format: ['camelCase', 'PascalCase'],
				},
			],
			curly: 'warn',
			eqeqeq: 'warn',
			semi: ['warn', 'never'],
		},
	},
);
