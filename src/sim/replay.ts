import { Simulation } from './simulation';

export interface ReplayResult {
  stats: Simulation['state']['stats'];
  crashed: boolean;
  crashReason: string | null;
  ticks: number;
  durationMs: number;
}

export function encodeInputLog(inputs: readonly boolean[]): string {
  let output = '';
  for (let index = 0; index < inputs.length;) {
    const value = inputs[index] ? '1' : '0';
    let end = index + 1;
    while (end < inputs.length && inputs[end] === inputs[index] && end - index < 65535) end += 1;
    output += `${value}${(end - index).toString(36)}.`;
    index = end;
  }
  return output;
}

export function decodeInputLog(log: string, maxTicks = 20 * 60 * 120): boolean[] {
  if (typeof log !== 'string' || log.length > 1_000_000) throw new Error('invalid_input_log');
  const result: boolean[] = [];
  if (log === '') return result;
  const parts = log.split('.');
  if (parts[parts.length - 1] === '') parts.pop();
  for (const part of parts) {
    const match = /^([01])([0-9a-z]+)$/.exec(part);
    if (!match) throw new Error('invalid_input_log');
    const count = Number.parseInt(match[2], 36);
    if (!Number.isSafeInteger(count) || count < 1 || result.length + count > maxTicks) throw new Error('invalid_input_log');
    for (let i = 0; i < count; i += 1) result.push(match[1] === '1');
  }
  return result;
}

export function replayRun(seed: number, inputLog: string | readonly boolean[]): ReplayResult {
  const inputs = typeof inputLog === 'string' ? decodeInputLog(inputLog) : inputLog;
  const simulation = new Simulation(seed);
  let ticks = 0;
  for (const held of inputs) {
    simulation.step(held);
    ticks += 1;
    if (simulation.state.crashed) break;
  }
  return {
    stats: { ...simulation.state.stats },
    crashed: simulation.state.crashed,
    crashReason: simulation.state.crashReason,
    ticks,
    durationMs: Math.floor(simulation.state.elapsed * 1000 + 0.5),
  };
}
