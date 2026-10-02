/** The systemd unit that keeps the box listening to its control repo. */
export const CONTROL_UNIT_NAME = 'salu-control.service';

export function controlUnit(opts: { bin?: string; user?: string } = {}): string {
  const bin = opts.bin ?? '/usr/local/bin/salu';
  return `[Unit]
Description=salu control channel (commands from your Mac)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${opts.user ?? 'salu'}
ExecStart=${bin} control watch
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`;
}
