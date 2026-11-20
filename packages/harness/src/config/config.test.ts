import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findStrippedKeys, getConfigFromProcessArgv } from './config.js';

test('findStrippedKeys flags unknown top-level keys', () => {
  const raw = { pid_file: 'x', no_such_section: { a: 1 } };
  const casted = { pid_file: 'x' };
  assert.deepEqual(findStrippedKeys(raw, casted), ['no_such_section']);
});

test('findStrippedKeys flags typos nested in session models, with the full path', () => {
  const raw = { models: { session: [{ id: 'm', optons: { model: 'x' } }] } };
  const casted = { models: { session: [{ id: 'm' }] } };
  assert.deepEqual(findStrippedKeys(raw, casted), ['models.session[0].optons']);
});

test('findStrippedKeys stays silent when open regions (extras) survive cast', () => {
  const raw = {
    models: {
      session: [{
        id: 'm',
        options: {
          model: 'm',
          extras: { weird_provider_option: true },
        },
      }],
    },
  };
  const casted = JSON.parse(JSON.stringify(raw));
  assert.deepEqual(findStrippedKeys(raw, casted), []);
});

const MINIMAL_TOML = `
[logging]
level = "info"

[telegram]
api_token = "token"
allowed_user_ids = [1001]

[postgres]
database = "loom"
port = 5432

[model]
adapter = "openai"
options.model = "test-model"
options.api_key = "key"
options.timeout = 1000
options.max_output_size = 100
options.max_context_size = 1000
options.extras.a_weird_adapter_option = true
options.modalities.images = true
`;

const withConfigFile = async (body: string, fn: (path: string) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-config-test-'));
  const path = join(dir, 'config.toml');
  await writeFile(path, body, 'utf8');
  const argv_backup = process.argv;
  process.argv = [process.argv[0], 'server.js', path];
  try {
    await fn(path);
  } finally {
    process.argv = argv_backup;
    await rm(dir, { recursive: true, force: true });
  }
};

test('getConfigFromProcessArgv parses a minimal TOML config, keeping open options', async () => {
  await withConfigFile(MINIMAL_TOML, async () => {
    const config = await getConfigFromProcessArgv();
    assert.equal(config.model.adapter, 'openai');
    assert.equal(config.model.options.model, 'test-model');
    assert.equal(config.model.options.timeout, 1000);
    assert.equal(config.model.options.extras?.a_weird_adapter_option, true);
    assert.equal(config.model.options.modalities?.images, true);
    assert.equal(config.telegram.api_token, 'token');
    assert.deepEqual(config.telegram.allowed_user_ids, [1001]);
    assert.equal(config.agent, undefined);
    assert.deepEqual(config.postgres, { database: 'loom', port: 5432 });
  });
});

test('getConfigFromProcessArgv fills env placeholders', async () => {
  process.env.LOOM_TEST_TELEGRAM_TOKEN = 'from-env';
  try {
    await withConfigFile(MINIMAL_TOML.replace('api_token = "token"', 'api_token = "${LOOM_TEST_TELEGRAM_TOKEN}"'), async () => {
      assert.equal((await getConfigFromProcessArgv()).telegram.api_token, 'from-env');
    });
  } finally {
    delete process.env.LOOM_TEST_TELEGRAM_TOKEN;
  }
});

test('getConfigFromProcessArgv rejects unknown adapters', async () => {
  await withConfigFile(MINIMAL_TOML.replace('adapter = "openai"', 'adapter = "nope"'), async () => {
    await assert.rejects(() => getConfigFromProcessArgv());
  });
});

test('getConfigFromProcessArgv rejects unknown structural keys, naming them', async () => {
  await withConfigFile(MINIMAL_TOML + '\nno_such_section = 1\n', async () => {
    await assert.rejects(
      () => getConfigFromProcessArgv(),
      (err: Error) => /no_such_section/.test(err.message) && /silently dropped/.test(err.message),
    );
  });
});

test('getConfigFromProcessArgv rejects undeclared options keys too — extras is the open region', async () => {
  const body = MINIMAL_TOML.replace('options.extras.a_weird_adapter_option = true', 'options.undeclared_key = true');
  await withConfigFile(body, async () => {
    await assert.rejects(() => getConfigFromProcessArgv(), /undeclared_key/);
  });
});

test('getConfigFromProcessArgv rejects malformed TOML', async () => {
  await withConfigFile('tz = [unclosed', async () => {
    await assert.rejects(() => getConfigFromProcessArgv());
  });
});

test('config-example.toml at the repository root is a valid config', async () => {
  const example = resolve(import.meta.dirname, '../../../../config-example.toml');
  const env_vars = {
    POSTGRES_HOSTNAME: '127.0.0.1',
    POSTGRES_PORT: '5432',
    POSTGRES_DATABASE: 'loom',
    POSTGRES_USERNAME: 'loom',
    POSTGRES_PASSWORD: 'loom',
    TELEGRAM_API_TOKEN: 'telegram-token',
    ANTHROPIC_API_KEY: 'anthropic-key',
  };
  const env_backup = { ...process.env };
  Object.assign(process.env, env_vars);
  try {
    await withConfigFile(await readFile(example, 'utf8'), async () => {
      const config = await getConfigFromProcessArgv();
      assert.equal(config.model.adapter, 'anthropic');
      assert.equal(config.model.options.api_key, 'anthropic-key');
      assert.equal(config.telegram.api_token, 'telegram-token');
      assert.equal(config.postgres.schema, 'harness');
      assert.equal(Number(config.postgres.port), 5432);
    });
  } finally {
    for (const key of Object.keys(env_vars)) {
      if (!(key in env_backup)) delete process.env[key];
      else process.env[key] = env_backup[key];
    }
  }
});
