import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The published module lives at dist/src/core/version.js under this manifest.
export const { version } = require('../../../package.json') as {
  version: string;
};
