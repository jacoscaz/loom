
# @loom/harness

Minimal agent harness: converse with an agent over Telegram.

- Inference goes through `@loom/models`.
- Tools are served through the `@loom/tools` `ToolServerManager`; the only
  tool server registered is `@loom/telegram`.
- Incoming Telegram messages arrive as `@loom/proto` envelopes; each Telegram
  chat is its own session (`telegram:<chat_id>`).
- History lives in Postgres (Kysely query functions in `src/database`).
  Incoming messages are stored before Telegram is told they were received,
  and sessions with unprocessed messages resume at boot.
- The agent replies by calling `telegram_send_text`; its plain-text output is
  not delivered to anyone.

## Running

```sh
npm run build
node packages/harness/dist/server.js config.toml
```

Copy and edit the examples at the repository root:

```sh
cp .env-example .env
cp config-example.toml config.toml
```

## Testing

`npm test` runs everything that needs no external services. To also run
the history store tests against Postgres, point them at a database; each
test works in its own throwaway schema:

```sh
LOOM_TEST_POSTGRES_URL=postgres://loom:loom@127.0.0.1:5432/loom npm test
```

Documentation for the project as a whole lives in the
[root README](../../README.md).
