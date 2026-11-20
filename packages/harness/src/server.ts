#!/usr/bin/env node

import 'dotenv/config';

import pinetto, { datetimeISO, datetimeVoid, ProcessWriter } from 'pinetto';
import { completionModel, type AbstractCompletionModel } from '@loom/models';
import { ToolServerManager } from '@loom/tools';
import { TelegramToolServer } from '@loom/telegram';

import { getConfigFromProcessArgv, type ConfigModel } from './config/config.js';
import { acquirePidFile, releasePidFile, defaultPidFilePath } from './pid-file.js';
import { Agent } from './agent.js';
import { getDB } from './database/client.js';
import { migrateToLatest } from './database/migrator.js';
import { DatabaseHistoryStore } from './stores/database.js';
import { DEFAULT_SYSTEM_PROMPT } from './prompt.js';

const config = await getConfigFromProcessArgv();

// ---------------------------------------------------------------------------
// Single-instance guard (pid file). This must happen before anything else:
// two concurrent harness instances would, among other things, both long-poll
// the same Telegram bot. Runs before the logger is set up, so its messages go
// to the console directly.
// ---------------------------------------------------------------------------
const pid_file_path = config.pid_file ?? defaultPidFilePath();
const pid_file_acquisition = acquirePidFile(pid_file_path);
if (!pid_file_acquisition.acquired) {
  console.error(
    `Refusing to start: another harness instance (pid ${pid_file_acquisition.conflict_pid}) ` +
    `holds the pid file at ${pid_file_acquisition.path}. Exiting.`,
  );
  process.exit(0);
}
if (pid_file_acquisition.reclaimed) {
  const { pid, reason } = pid_file_acquisition.reclaimed;
  console.warn(
    reason === 'dead-pid'
      ? `Stale pid file at ${pid_file_path} (pid ${pid} is gone) — reclaimed.`
      : `Corrupt pid file at ${pid_file_path} — reclaimed.`,
  );
}

const logger = pinetto({
  level: config.logging.level,
  datetime: config.logging.datetime === false ? datetimeVoid : datetimeISO,
  writer: new ProcessWriter('stderr'),
});

logger.info('PID %s', process.pid);
process.title = 'loom';

const db = getDB(config.postgres);
await migrateToLatest(db, logger.child('[db:migrations]'), config.postgres.schema);

const createModel = (config: ConfigModel): AbstractCompletionModel => {
  switch (config.adapter) {
    case 'anthropic': return completionModel('anthropic', config.options);
    case 'openai': return completionModel('openai', config.options);
    case 'tensorx': return completionModel('tensorx', config.options);
  }
};

const model = createModel(config.model);

const tools = new ToolServerManager();

const telegram = new TelegramToolServer({
  ...config.telegram,
  logger: logger.child('[tools:telegram]'),
});
await tools.addLocalServer(telegram);

const agent = new Agent({
  model,
  tools,
  store: new DatabaseHistoryStore(db),
  system_prompt: config.agent?.system_prompt ?? DEFAULT_SYSTEM_PROMPT,
  max_steps_per_turn: config.agent?.max_steps_per_turn,
  logger: logger.child('[agent]'),
});

tools.onEnvelope = async (envelope) => {
  logger.info('envelope from %s in session %s', envelope.from, envelope.session);
  // Resolves once the envelope is in the database: only then does the
  // Telegram server confirm the update (at-least-once delivery).
  await agent.receive(envelope);
};

const resumed = await agent.resume();
if (resumed.length > 0) {
  logger.info('resuming sessions with unprocessed messages: %s', resumed.join(', '));
}

telegram.start();
logger.info('listening on Telegram with model %s (%s)', model.model, config.model.adapter);

// ============================================================================
//                          PROCESS EXIT HANDLING
// ============================================================================

let shutting_down = false;

const onSignal = async (signal: NodeJS.Signals) => {
  if (shutting_down) {
    return;
  }
  shutting_down = true;
  logger.warn('received %s, shutting down...', signal);
  try {
    await tools.stop();
    // In-flight activations are not awaited: one interrupted here persists
    // nothing and is retried at the next boot (see Agent#resume()).
    await db.destroy();
  } finally {
    releasePidFile(pid_file_acquisition.path);
    process.exit(0);
  }
};

process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
