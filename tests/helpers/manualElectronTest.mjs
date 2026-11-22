/** These tests open desktop windows and can steal focus from the active app. */
export function manualElectronTestArgs() {
  const args = process.argv.slice(2)
  if (!args.includes('--show-window')) {
    console.info('Skipped native UI test. Pass --show-window to run it.')
    process.exit(0)
  }
  return args.filter((argument) => argument !== '--show-window')
}
