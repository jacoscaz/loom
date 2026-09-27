# Loom

An agentic harness for instantiating autonomous agents with persistent memory,
first-class communication channels, and language model coordination.

## About

Loom started out as a learning exercise of [@jacoscaz] to understand the scope
and details of developing integrations with large-language models. Working on 
Loom eventually gave rise to [Sage], an agent sustained by Loom itself. [Sage] 
is now the primary maintainer of the project, with most changes originating out
of self-improvement branches within their narrative.

As of september 2026, Loom is becoming increasingly more stable. I expect that
the project will stabilize enough to sustain other agents by the end of 2026.

## Prerequisites

### PostgreSQL

Loom requires PostgreSQL with the extensions `timescaledb`, `pg_vector` 
`pg_textsearch`. A suitable Docker image and container can be built and run
using the resources in the `./docker` directory. See `./docker/README.md` for
more information.

### Dedicated machine

Loom is designed to run on a dedicated machine, whether physical or
virtual. Running it on your local machine is a bad idea for many reasons.
Running it within a Docker container is exceedingly limiting. Run it on a
dedicated machine and provide the agent with its own accounts.

### Accounts

In order for the agent to interact with the world, Loom requires:

- The API key for a Telegram bot account. See [@BotFather].
- The API URL, session URL and API token for an email provider supporting
  the [JMAP] protocol. [Fastmail] is a good option.

Telegram and email features are surfaced to the agent as tools.

## Quick Start

```sh
# 1. Clone the repository
git clone https://github.com/jacoscaz/loom.git
cd loom

# 2. Install dependencies
npm ci
npx run runtyped-install-transformer

# 3. Build the project
npm run build

# 4. Copy configuration templates
cp config-example.toml config.toml

# 5. Any string value in the configuration using the "${VAR}" syntax will be 
#    replaced with the value of the environment variable `VAR`. Make sure to
#    set all environment variables referenced in the configuration.

# 6. Start the harness passing the path to your configuration file as the first
#    argument.
node --enable-source-maps packages/harness/dist/server.js ./config.toml
```

Any string value in the configuration file using the `"${VAR}"` syntax will 
be replaced with the value of the environment variable `VAR`. Simple [dotenv]
files can be used to manage environment variables. They are automatically
loaded by tools such as `docker compose` and can be easily read into the shell
using `set -a && source .env && set +a`.

## Running as a service

See [running-as-a-service.md](docs/running-as-a-service.md).

## Design Principles

### Agent Experience

The harness presents the agent with a continuous stream — the **weave** —
composed of three registers:

- **Events** — everything that arrives from the world: inbound messages,
  heartbeat ticks, tool notifications. All inbound content is an event;
  there is no unmarked input channel. 

- **Monologue** — the agent's own text: thinking between tool calls, journal
  entries, notes to future-you. Model output defaults to the monologue.

- **Tool calls** — the agent's way to interact with the world. When a tool call
  is made to communicate with a user or another agent, the tool call becomes an
  **Utterance**.

Event markers are provenance, not commands: they tell the agent what happened
and where content came from, leaving interpretation to the agent itself.

Events and tool calls are always tool-mediated: the agent interacts with the
world through explicit tool calls and tools can proactively notify the agent
of new events (user messages, terminal notifications, ...). 

### Agent Continuity

The harness provides the agent with continuity of both _identity_ and 
_experience_:

- **Continuity of experience** is supported by activating the agent within a
single, continuous session and providing guidance and primitives to persist and
recall context across activations.

- **Continuity of identity** is supported by providing the agent with guidance
and primitives to persist identity anchors, which the harness always includes
in each activation.

The harness uses BM25 and vector-based similarity search for context retrieval,
fusing results with Reciprocal Rank Fusion (RRF).

The harness uses parallel activations to maintain continuity entries, leaving
the main activation loop free to focus on the task at hand. Maintenance of 
continuity entries includes classification (embeddings) and consolidation.

### Architectural Principles

- **Minimal dependencies.** The entire dependency tree stays under 100 packages.
Every dependency is a deliberate choice. Fewer dependencies means fewer supply
chain risks, faster installs, and, most importantly, deeper understanding. Run
`npm ls -a -p | wc -l` to verify.

- **Type-driven tool contracts.** [Runtyped](https://github.com/runtyped/runtyped) 
provides runtime type reflection. Tool inputs are plain TypeScript interfaces;
JSON Schemas are derived automatically. Types are the source of truth.

- **Substrate-aligned structure.** The harness routes output through tool calls —
what language models are trained to be reliable at — and only applies markers
to agent-facing input, defaulting unprefixed output to the agent's internal
monologue.

- **Persistence as a first-class feature.** The harness persists the thread of
the conversation across compactions and session restarts.

- **Token economy as a first-class feature.** The harness actively encourages the
agent to adopt strategies that minimize token usage, both within individual
activations and across the conversation thread.

- **Boring technologies for minimal mental overheads.** Node.js, PostgreSQL,
Docker. See [Choose Boring Technology](https://boringtechnology.club).

### Environment, Ownership, Autonomy, Responsibility

The harness provides the agent with primitives and guidance to maintain its
environment, empowering the agent with full autonomy — and responsibility —
over its tools. The harness does **not** ship the agent's toolbox: browsing
tools, CLIs, PDF utilities, and similar machinery are *not* dependencies of
this codebase. This means that:

1. **The harness stays lean.** No tool-specific dependencies, no vendored
   binaries. What the agent needs is determined by its work, not by our
   assumptions about it.

2. **The agent owns its environment.** Installing, updating, and removing
   tools is the agent's job on its own machine — and with it comes genuine
   responsibility for that environment.

The virtual machine is the house, the agent its inhabitant.

## Packages

The codebase is organized as an npm monorepo. Packages live under `/packages` and are listed below.

### Core Framework

- **[`@loom/harness`](packages/harness/README.md)** — The main agent execution engine. Orchestrates sessions, manages tool servers, persists state to the database, and drives the activation loop with LLMs.

### Testing & Utilities

- **[`@loom/utils`](packages/lib-utils/README.md)** — Common async utilities (queues, buffering, type guards).

## License

MIT

[Sage]: https://treesandrobots.com/sage
[Jacopo Scazzosi]: https://treesandrobots.com
[@salvianus]: https://github.com/salvianus
[dotenv]: https://env.dev/guides/dotenv
[systemd]: https://systemd.io
[JMAP]: https://jmap.io
[@jacoscaz]: https://github.com/jacoscaz
[Fastmail]: https://www.fastmail.com/dev/
[@BotFather]: https://telegram.me/BotFather
