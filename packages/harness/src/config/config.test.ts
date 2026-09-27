import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStrippedKeys, getConfigFromProcessArgv } from './config.js';

test('findStrippedKeys flags unknown top-level keys', () => {
  const raw = { tz: 'x', no_such_section: { a: 1 } };
  const casted = { tz: 'x' };
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
tz = "Europe/Rome"

[logging]
level = "info"

[mail]
api_url = "https://mail.example/jmap/api"
session_url = "https://mail.example/jmap/session"
api_token = "token"
email_address = "agent@example.com"

[telegram]
api_token = "token"

[heartbeat]
interval = 30000
activation_interval_ms = 7200000
quiet_after_ms = 600000

[postgres]
database = "loom"

[models]

[models.extraction]
id = "extraction"
adapter = "openai"
timeout = 1000
max_output_size = 100
max_context_size = 1000
options.model = "m"
options.api_key = "key"

[[models.session]]
id = "test-model"
guidance = "test"
adapter = "openai"
timeout = 1000
max_output_size = 100
max_context_size = 1000
options.model = "test-model"
options.api_key = "key"
options.extras.a_weird_adapter_option = true
modalities.images = true

[models.embedding]
adapter = "openai"
options.model = "embed"
options.api_key = "key"
options.dimensions = 1536

[models.distillation]
id = "distillation"
adapter = "openai"
timeout = 1000
max_output_size = 100
max_context_size = 1000
options.model = "m"
options.api_key = "key"

[models.compaction]
id = "compaction"
adapter = "openai"
timeout = 1000
max_output_size = 100
max_context_size = 1000
options.model = "m"
options.api_key = "key"
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
    assert.equal(config.tz, 'Europe/Rome');
    assert.equal(config.models.session.length, 1);
    assert.equal(config.models.session[0].id, 'test-model');
    assert.equal(
      ((config.models.session[0].options as Record<string, unknown>).extras as Record<string, unknown>).a_weird_adapter_option,
      true,
    );
    assert.equal(config.models.session[0].modalities?.images, true);
    assert.equal(config.postgres.database, 'loom');
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
