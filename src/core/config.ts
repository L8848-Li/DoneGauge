import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Ajv, type ErrorObject } from 'ajv';
import { DoneGaugeError, errorMessage } from './errors.js';
import type { AcceptanceConfig } from './types.js';

// The same schema is shipped for editors and used at runtime.
const schema = JSON.parse(
  await readFile(
    new URL('../../../schema/donegauge.schema.json', import.meta.url),
    'utf8',
  ).catch(() =>
    readFile(
      new URL('../../schema/donegauge.schema.json', import.meta.url),
      'utf8',
    ),
  ),
) as object;
const validate = new Ajv({
  allErrors: true,
  strict: true,
}).compile<AcceptanceConfig>(schema);

function describe(error: ErrorObject): string {
  const at = error.instancePath || '/';
  if (error.keyword === 'additionalProperties') {
    return `${at}: unknown field "${String(error.params.additionalProperty)}". Remove it or check the spelling.`;
  }
  if (error.keyword === 'required') {
    return `${at}: add required field "${String(error.params.missingProperty)}".`;
  }
  if (error.keyword === 'minItems' && at.endsWith('/command')) {
    return `${at}: add an executable, for example ["node", "--test"].`;
  }
  return `${at}: ${error.message ?? 'invalid value'}.`;
}

export function parseConfig(text: string): AcceptanceConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DoneGaugeError(
      'Invalid JSON. Check commas, quotes, and brackets in your configuration.',
      'CONFIG',
    );
  }
  if (!validate(value)) {
    throw new DoneGaugeError(
      `Invalid acceptance configuration:\n${(validate.errors ?? []).map(describe).join('\n')}\nUse donegauge init in an empty configuration location for an example.`,
      'CONFIG',
    );
  }
  const ids = new Set<string>();
  for (const criterion of value.criteria) {
    if (ids.has(criterion.id)) {
      throw new DoneGaugeError(
        `Duplicate criterion id "${criterion.id}". Give each criterion a unique id.`,
        'CONFIG',
      );
    }
    ids.add(criterion.id);
    if (criterion.check?.kind === 'junit') {
      const file = criterion.check.junit.file;
      const parts = file.slice('{evidenceDir}/'.length).split('/');
      if (
        parts.some(
          (part) =>
            !part || part === '.' || part === '..' || part.includes('\\'),
        )
      )
        throw new DoneGaugeError(
          `${criterion.id}: junit.file must be a normal XML path inside {evidenceDir}; traversal and backslashes are not allowed.`,
          'CONFIG',
        );
    }
    if (criterion.check && !criterion.check.command[0]?.trim()) {
      throw new DoneGaugeError(
        `${criterion.id}: check.command needs an executable as its first element, for example ["node", "--test"].`,
        'CONFIG',
      );
    }
  }
  return value;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

export async function projectPath(
  root: string,
  path: string,
  label: string,
): Promise<string> {
  try {
    const target = await realpath(resolve(root, path));
    if (!isWithin(root, target)) {
      throw new DoneGaugeError(
        `${label} must stay inside the project, including symlinks: ${path}`,
        'CONFIG',
      );
    }
    return target;
  } catch (error) {
    if (error instanceof DoneGaugeError) throw error;
    throw new DoneGaugeError(
      `Cannot read ${label} "${path}": ${errorMessage(error)}. Check the path and permissions.`,
      'CONFIG',
    );
  }
}

export async function loadConfig(root: string, path = 'donegauge.json') {
  const file = await projectPath(root, path, 'configuration');
  if ((await stat(file)).size > 1_048_576) {
    throw new DoneGaugeError(
      'Configuration exceeds 1 MiB. Split large tasks into smaller acceptance runs.',
      'CONFIG',
    );
  }
  const text = await readFile(file, 'utf8');
  const config = parseConfig(text);
  // Relative check directories always use the project root, not the config directory.
  return {
    config,
    sha256: sha256(text),
    path: relative(root, file),
    directory: dirname(file),
  };
}
