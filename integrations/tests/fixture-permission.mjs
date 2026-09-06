// Narrow permission used ONLY by the opt-in disposable-workspace test.
import { resolve } from 'node:path';
export function isFixtureRead(tool, cwd) {
  const raw = tool?.rawInput;
  if (!raw || resolve(raw.cwd ?? '') !== resolve(cwd)) return false;
  const actions = raw.commandActions;
  if (!Array.isArray(actions) || actions.length !== 1 || actions[0].type !== 'read' || resolve(actions[0].path ?? '') !== resolve(cwd, 'fixture.txt')) return false;
  const command = String(raw.command ?? '').replaceAll('\\\\', '\\');
  if (command === 'cat fixture.txt' || command === 'cat ./fixture.txt') return true;
  const m = /^"(C:\\(?:Program Files\\WindowsApps\\Microsoft\.PowerShell_[\w.]+__8wekyb3d8bbwe\\pwsh\.exe|Windows\\[Ss]ystem32\\WindowsPowerShell\\v1\.0\\powershell\.exe))" -Command "(Get-Content(?: -Raw)?(?: -LiteralPath)? (?:\.\\)?fixture\.txt)"$/.exec(command);
  return Boolean(m);
}
