import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';

export default defineConfig([
	globalIgnores(['main.js', 'node_modules/', 'esbuild.config.mjs', 'version-bump.mjs']),
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.*'],
				},
			},
		},
	},
	{
		// "Gumroad" is a product name, so it keeps its capital in UI text.
		files: ['src/**/*.ts'],
		rules: {
			'obsidianmd/ui/sentence-case': ['warn', { brands: [...DEFAULT_BRANDS, 'Gumroad', 'Gumroad Sales Ledger'] }],
		},
	},
	{
		// Unit tests run in Node, not in Obsidian, and node:test returns promises by design.
		files: ['tests/**/*.ts'],
		rules: {
			'obsidianmd/no-nodejs-modules': 'off',
			'@typescript-eslint/no-floating-promises': 'off',
		},
	},
]);
