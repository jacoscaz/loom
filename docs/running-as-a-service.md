
## Loom: running as a service

Loom is a long-running process with no built-in service manager
integration. On Linux, [systemd] is the standard process supervisor. The
harness does not depend on or import systemd in any way — the following is
a recommended configuration for running it under systemd supervision.

Create a service unit file at `/etc/systemd/system/loom.service`:

```ini
[Unit]
Description=Loom agent harness
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/loom
EnvironmentFile=/opt/loom/.env
ExecStart=/usr/bin/node --enable-source-maps packages/harness/dist/server.js ./config.toml
Restart=always
RestartSec=5

# Run as a dedicated user (create with: useradd -r -s /bin/bash loom)
User=loom

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=loom

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now loom
```

Logs are available via `journalctl -u loom -f`.

The `Restart=always` policy ensures the harness is automatically
restarted whether the process exits cleanly or crashes. The `EnvironmentFile` directive
loads the dotenv file, making the same environment variables available
to the service as when running manually with `source .env`.

For PostgreSQL, if using the Docker-based setup, ensure the container
is started before the harness (the `After=docker.service` dependency
handles this). Alternatively, run PostgreSQL as its own systemd service.

[systemd]: https://systemd.io
