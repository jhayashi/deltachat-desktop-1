import { register } from 'node:module';

// this script is used to run typescript tests
// with mocha without precompiling.
//
// transpile-only: types are checked separately via `pnpm check:types`.
// Without this, ts-node ESM falls over on workspace-y imports
// (e.g. CSS modules, `.js` extension hops on `.tsx` files) that the
// real tsc handles correctly.

process.env.TS_NODE_TRANSPILE_ONLY = 'true';

const packageRoot = new URL('../', import.meta.url);

register('./node_modules/ts-node/esm.mjs', packageRoot);
