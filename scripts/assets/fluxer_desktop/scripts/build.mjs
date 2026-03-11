/*
 * Copyright (C) 2026 Fluxer Contributors
 *
 * This file is part of Fluxer.
 *
 * Fluxer is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Fluxer is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Fluxer. If not, see <https://www.gnu.org/licenses/>.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(ROOT_DIR, 'src');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const isProduction = process.env.NODE_ENV === 'production';

const electronExternals = [
	'electron',
	'electron-log',
	'electron-squirrel-startup',
	'electron-webauthn-mac',
	'update-electron-app',
	'@electron-webauthn/native',
	'uiohook-napi',
	'node-mac-permissions',
];

const pathAliasPlugin = {
	name: 'path-alias',
	setup(build) {
		build.onResolve({filter: /^@electron\//}, (args) => {
			const relativePath = args.path.replace(/^@electron\//, '');
			const absolutePath = path.join(SRC_DIR, relativePath);

			const extensions = ['.tsx', '.ts', '.js', '.jsx'];
			for (const ext of extensions) {
				const fullPath = absolutePath + ext;
				if (fs.existsSync(fullPath)) {
					return {path: fullPath};
				}
			}

			for (const ext of extensions) {
				const indexPath = path.join(absolutePath, `index${ext}`);
				if (fs.existsSync(indexPath)) {
					return {path: indexPath};
				}
			}

			return {path: `${absolutePath}.tsx`};
		});
	},
};

async function buildMain() {
	console.log('Building main process...');

	await esbuild.build({
		entryPoints: [path.join(SRC_DIR, 'main', 'index.tsx')],
		bundle: true,
		platform: 'node',
		target: 'node20',
		format: 'esm',
		outfile: path.join(DIST_DIR, 'main', 'index.js'),
		minify: isProduction,
		sourcemap: !isProduction,
		external: electronExternals,
		plugins: [pathAliasPlugin],
		define: {
			'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
		},
	});

	console.log('Main process build complete.');
}

async function buildPreload() {
	console.log('Building preload script...');

	await esbuild.build({
		entryPoints: [path.join(SRC_DIR, 'preload', 'index.tsx')],
		bundle: true,
		platform: 'node',
		target: 'node20',
		format: 'cjs',
		outfile: path.join(DIST_DIR, 'preload', 'index.js'),
		minify: isProduction,
		sourcemap: !isProduction,
		external: electronExternals,
		plugins: [pathAliasPlugin],
		define: {
			'process.env.NODE_ENV': JSON.stringify(isProduction ? 'production' : 'development'),
		},
	});

	console.log('Preload script build complete.');
}

async function build() {
	console.log(`Building Electron app (${isProduction ? 'production' : 'development'})...`);

	if (fs.existsSync(DIST_DIR)) {
		fs.rmSync(DIST_DIR, {recursive: true});
	}

	fs.mkdirSync(path.join(DIST_DIR, 'main'), {recursive: true});
	fs.mkdirSync(path.join(DIST_DIR, 'preload'), {recursive: true});

	await Promise.all([buildMain(), buildPreload()]);

	console.log('Build complete!');
}

build().catch((error) => {
	console.error('Build failed:', error);
	process.exit(1);
});
