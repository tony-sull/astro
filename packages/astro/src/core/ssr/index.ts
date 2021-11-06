import type { BuildResult } from 'esbuild';
import type vite from '../vite';
import type { AstroConfig, ComponentInstance, EndpointRouteData, GetStaticPathsResult, PageRouteData, Params, Props, Renderer, RouteCache, RouteData, RuntimeMode, SSRError } from '../../@types/astro-core';
import type { AstroGlobal, TopLevelAstro, SSRResult, SSRElement } from '../../@types/astro-runtime';
import type { LogOptions } from '../logger';

import fs from 'fs';
import path from 'path';
import { renderPage, renderSlot } from '../../runtime/server/index.js';
import { canonicalURL as getCanonicalURL, codeFrame, resolveDependency } from '../util.js';
import { getStylesForID } from './css.js';
import { injectTags } from './html.js';
import { generatePaginateFunction } from './paginate.js';
import { getParams, validateGetStaticPathsModule, validateGetStaticPathsResult } from './routing.js';
import { ViteDevServer } from 'vite';

interface SSROptions<Route extends RouteData = RouteData> {
  /** an instance of the AstroConfig */
  astroConfig: AstroConfig;
  /** location of file on disk */
  filePath: URL;
  /** logging options */
  logging: LogOptions;
  /** "development" or "production" */
  mode: RuntimeMode;
  /** production website, needed for some RSS & Sitemap functions */
  origin: string;
  /** the web request (needed for dynamic routes) */
  pathname: string;
  /** optional, in case we need to render something outside of a dev server */
  route?: Route;
  /** pass in route cache because SSR can’t manage cache-busting */
  routeCache: RouteCache;
  /** Vite instance */
  viteServer: vite.ViteDevServer;
}

const cache = new Map<string, Promise<Renderer>>();

// TODO: improve validation and error handling here.
async function resolveRenderer(viteServer: vite.ViteDevServer, renderer: string, astroConfig: AstroConfig) {
  const resolvedRenderer: any = {};
  // We can dynamically import the renderer by itself because it shouldn't have
  // any non-standard imports, the index is just meta info.
  // The other entrypoints need to be loaded through Vite.
  const {
    default: { name, client, polyfills, hydrationPolyfills, server },
  } = await import(resolveDependency(renderer, astroConfig));

  resolvedRenderer.name = name;
  if (client) resolvedRenderer.source = path.posix.join(renderer, client);
  if (Array.isArray(hydrationPolyfills)) resolvedRenderer.hydrationPolyfills = hydrationPolyfills.map((src: string) => path.posix.join(renderer, src));
  if (Array.isArray(polyfills)) resolvedRenderer.polyfills = polyfills.map((src: string) => path.posix.join(renderer, src));
  const { url } = await viteServer.moduleGraph.ensureEntryFromUrl(path.posix.join(renderer, server));
  const { default: rendererSSR } = await viteServer.ssrLoadModule(url);
  resolvedRenderer.ssr = rendererSSR;

  const completedRenderer: Renderer = resolvedRenderer;
  return completedRenderer;
}

async function resolveRenderers(viteServer: vite.ViteDevServer, astroConfig: AstroConfig): Promise<Renderer[]> {
  const ids: string[] = astroConfig.renderers;
  const renderers = await Promise.all(
    ids.map((renderer) => {
      if (cache.has(renderer)) return cache.get(renderer)!;
      let promise = resolveRenderer(viteServer, renderer, astroConfig);
      cache.set(renderer, promise);
      return promise;
    })
  );

  return renderers;
}

/** use Vite to SSR a page */
async function ssrPage({ astroConfig, filePath, logging, mode, origin, pathname, route, routeCache, viteServer }: SSROptions<PageRouteData>): Promise<string> {
  try {
    // Important: This needs to happen first, in case a renderer provides polyfills.
    const renderers = await resolveRenderers(viteServer, astroConfig);
    // Load the module from the Vite SSR Runtime.
    const viteFriendlyURL = `/@fs${filePath.pathname}`;
    const mod = (await viteServer.ssrLoadModule(viteFriendlyURL)) as ComponentInstance;
    // Handle dynamic routes
    let params: Params = {};
    let pageProps: Props = {};
    if (route && !route.pathname) {
      if (route.params.length) {
        const paramsMatch = route.pattern.exec(pathname);
        if (paramsMatch) {
          params = getParams(route.params)(paramsMatch);
        }
      }
      validateGetStaticPathsModule(mod);
      if (!routeCache[route.component]) {
        routeCache[route.component] = await (
          await mod.getStaticPaths!({
            paginate: generatePaginateFunction(route),
            rss: () => {
              /* noop */
            },
          })
        ).flat();
      }
      validateGetStaticPathsResult(routeCache[route.component], logging);
      const routePathParams: GetStaticPathsResult = routeCache[route.component];
      const matchedStaticPath = routePathParams.find(({ params: _params }) => JSON.stringify(_params) === JSON.stringify(params));
      if (!matchedStaticPath) {
        throw new Error(`[getStaticPaths] route pattern matched, but no matching static path found. (${pathname})`);
      }
      pageProps = { ...matchedStaticPath.props } || {};
    }

    // Validate the page component before rendering the page
    const Component = await mod.default;
    if (!Component) throw new Error(`Expected an exported Astro component but received typeof ${typeof Component}`);
    if (!Component.isAstroComponentFactory) throw new Error(`Unable to SSR non-Astro component (${route?.component})`);

    // Create the result object that will be passed into the render function.
    // This object starts here as an empty shell (not yet the result) but then
    // calling the render() function will populate the object with scripts, styles, etc.
    const result: SSRResult = {
      styles: new Set<SSRElement>(),
      scripts: new Set<SSRElement>(),
      /** This function returns the `Astro` faux-global */
      createAstro(astroGlobal: TopLevelAstro, props: Record<string, any>, slots: Record<string, any> | null) {
        const site = new URL(origin);
        const url = new URL('.' + pathname, site);
        const canonicalURL = getCanonicalURL('.' + pathname, astroConfig.buildOptions.site || origin);
        return {
          __proto__: astroGlobal,
          props,
          request: {
            canonicalURL,
            params,
            url,
          },
          slots: Object.fromEntries(Object.entries(slots || {}).map(([slotName]) => [slotName, true])),
          // This is used for <Markdown> but shouldn't be used publicly
          privateRenderSlotDoNotUse(slotName: string) {
            return renderSlot(result, slots ? slots[slotName] : null);
          },
          // <Markdown> also needs the same `astroConfig.markdownOptions.render` as `.md` pages
          async privateRenderMarkdownDoNotUse(content: string, opts: any) {
            let render = astroConfig.markdownOptions.render;
            let renderOpts = {};
            if (Array.isArray(render)) {
              renderOpts = render[1];
              render = render[0];
            }
            if (typeof render === 'string') {
              ({ default: render } = await import(render));
            }
            const { code } = await render(content, { ...renderOpts, ...(opts ?? {}) });
            return code;
          },
        } as unknown as AstroGlobal;
      },
      _metadata: { renderers },
    };

    let html = await renderPage(result, Component, pageProps, null);

    // inject tags
    const tags: vite.HtmlTagDescriptor[] = [];

    // dev only: inject Astro HMR client
    if (mode === 'development') {
      tags.push({
        tag: 'script',
        attrs: { type: 'module' },
        children: `import 'astro/runtime/client/hmr.js';`,
        injectTo: 'head',
      });
    }

    // inject CSS
    [...getStylesForID(filePath.pathname, viteServer)].forEach((href) => {
      tags.push({
        tag: 'link',
        attrs: { type: 'text/css', rel: 'stylesheet', href },
        injectTo: 'head',
      });
    });

    // add injected tags
    html = injectTags(html, tags);

    // run transformIndexHtml() in dev to run Vite dev transformations
    if (mode === 'development') {
      html = await viteServer.transformIndexHtml(filePath.pathname, html, pathname);
    }

    return html;
  } catch (e: any) {
    viteServer.ssrFixStacktrace(e);
    // Astro error (thrown by esbuild so it needs to be formatted for Vite)
    if (e.errors) {
      const { location, pluginName, text } = (e as BuildResult).errors[0];
      const err = new Error(text) as SSRError;
      if (location) err.loc = { file: location.file, line: location.line, column: location.column };
      const frame = codeFrame(await fs.promises.readFile(filePath, 'utf8'), err.loc);
      err.frame = frame;
      err.id = location?.file;
      err.message = `${location?.file}: ${text}

${frame}
`;
      err.stack = e.stack;
      if (pluginName) err.plugin = pluginName;
      throw err;
    }

    // Generic error (probably from Vite, and already formatted)
    throw e;
  }
}

async function ssrEndpoint({ route, viteServer }: { route: EndpointRouteData, viteServer: ViteDevServer }): Promise<string> {
  const mod = await route.load(viteServer);

  const handler = mod['get'];

  if (!handler) {
    throw new Error(`Endpoint get handler not found for ${route.pathname}`);
  }

  const response = await handler();

  if (typeof response !== 'object') {
    throw new Error(`Invalid endpoint response from route ${route.pathname}: expected an object, got ${typeof response}`);
  }

  const { body } = response;

  // TODO: Should this actually stringify all return types?
  return typeof body === 'string' ? body : JSON.stringify(body);
}

export async function ssr(options: SSROptions): Promise<string> {
  if (options.route && options.route.type === 'endpoint') {
    const { route, viteServer } = options;
    return ssrEndpoint({ route, viteServer });
  } else {
    return ssrPage(options as SSROptions<PageRouteData>);
  }
}