export {};
// Opens the list on the seeded TICKET_HOME. Used by src/tui/bench/tui-perf.py under a pty.
const { openList } = await import('../index.tsx');
await openList({});
