// Old TICKET_* environment variables keep working: each one fills in its SALU_* twin when that is unset.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('TICKET_') && v !== undefined) {
    const next = 'SALU_' + k.slice(7);
    if (process.env[next] === undefined) process.env[next] = v;
  }
}
export {};
