import fs from 'fs';
import { join } from 'path';
import sirv from 'sirv';
import { pathToFileURL } from 'url';
import { getRequest, setResponse } from '../../node/index.js';
import { installPolyfills } from '../../node/polyfills.js';
import { SVELTE_KIT_ASSETS } from '../../core/constants.js';

/** @typedef {import('http').IncomingMessage} Req */
/** @typedef {import('http').ServerResponse} Res */
/** @typedef {(req: Req, res: Res, next: () => void) => void} Handler */

/**
 * @param {{
 *   middlewares: import('connect').Server;
 *   httpServer: import('http').Server;
 * }} vite
 * @param {import('types').ValidatedConfig} config
 * @param {'http' | 'https'} protocol
 */
export async function preview(vite, config, protocol) {
	installPolyfills();

	const { paths } = config.kit;
	const base = paths.base;
	const assets = paths.assets ? SVELTE_KIT_ASSETS : paths.base;

	const etag = `"${Date.now()}"`;

	const index_file = join(config.kit.outDir, 'output/server/index.js');
	const manifest_file = join(config.kit.outDir, 'output/server/manifest.js');

	/** @type {import('types').ServerModule} */
	const { Server, override } = await import(pathToFileURL(index_file).href);
	const { manifest } = await import(pathToFileURL(manifest_file).href);

	override({
		paths: { base, assets },
		prerendering: false,
		protocol,
		read: (file) => fs.readFileSync(join(config.kit.files.assets, file))
	});

	const server = new Server(manifest);

	return () => {
		// immutable generated client assets
		vite.middlewares.use(
			scoped(
				assets,
				sirv(join(config.kit.outDir, 'output/client'), {
					setHeaders: (res, pathname) => {
						// only apply to build directory, not e.g. version.json
						if (pathname.startsWith(`/${config.kit.appDir}/immutable`)) {
							res.setHeader('cache-control', 'public,max-age=31536000,immutable');
						}
					}
				})
			)
		);

		// prerendered dependencies
		vite.middlewares.use(
			scoped(base, mutable(join(config.kit.outDir, 'output/prerendered/dependencies')))
		);

		// prerendered pages (we can't just use sirv because we need to
		// preserve the correct trailingSlash behaviour)
		vite.middlewares.use(
			scoped(base, (req, res, next) => {
				let if_none_match_value = req.headers['if-none-match'];

				if (if_none_match_value?.startsWith('W/"')) {
					if_none_match_value = if_none_match_value.substring(2);
				}

				if (if_none_match_value === etag) {
					res.statusCode = 304;
					res.end();
					return;
				}

				const { pathname } = new URL(/** @type {string} */ (req.url), 'http://dummy');

				// only treat this as a page if it doesn't include an extension
				if (pathname === '/' || /\/[^./]+\/?$/.test(pathname)) {
					const file = join(
						config.kit.outDir,
						'output/prerendered/pages' +
							pathname +
							(pathname.endsWith('/') ? 'index.html' : '.html')
					);

					if (fs.existsSync(file)) {
						res.writeHead(200, {
							'content-type': 'text/html',
							etag
						});

						fs.createReadStream(file).pipe(res);
						return;
					}
				}

				next();
			})
		);

		// SSR
		vite.middlewares.use(
			scoped(base, async (req, res) => {
				const host = req.headers['host'];

				let request;

				try {
					request = await getRequest(`${protocol}://${host}`, req);
				} catch (/** @type {any} */ err) {
					res.statusCode = err.status || 400;
					return res.end(err.reason || 'Invalid request body');
				}

				setResponse(
					res,
					await server.respond(request, {
						getClientAddress: () => {
							const { remoteAddress } = req.socket;
							if (remoteAddress) return remoteAddress;
							throw new Error('Could not determine clientAddress');
						}
					})
				);
			})
		);
	};
}

/**
 * @param {string} dir
 * @returns {Handler}
 */
const mutable = (dir) =>
	fs.existsSync(dir)
		? sirv(dir, {
				etag: true,
				maxAge: 0
		  })
		: (req, res, next) => next();

/**
 * @param {string} scope
 * @param {Handler} handler
 * @returns {Handler}
 */
function scoped(scope, handler) {
	if (scope === '') return handler;

	return (req, res, next) => {
		if (req.url?.startsWith(scope)) {
			const original_url = req.url;
			req.url = req.url.slice(scope.length);
			handler(req, res, () => {
				req.url = original_url;
				next();
			});
		} else {
			next();
		}
	};
}
