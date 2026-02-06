// Guard against EPIPE when piping output to a command that exits early.
export function installStdoutEpipeGuard() {
  try {
    process.stdout.on('error', (e) => {
      if (e && (e.code === 'EPIPE' || e.errno === -32)) process.exit(0);
    });
  } catch {}
}
