export type GameSessionState = 'menu' | 'playing' | 'paused' | 'gameover';

export class GameSession {
  state: GameSessionState = 'menu';

  start(): void {
    if (this.state === 'playing') return;
    this.state = 'playing';
  }

  pause(): void {
    if (this.state === 'playing') this.state = 'paused';
  }

  resume(): void {
    if (this.state === 'paused') this.state = 'playing';
  }

  finish(): void {
    if (this.state === 'playing' || this.state === 'paused') this.state = 'gameover';
  }

  quit(): void {
    this.state = 'menu';
  }

  restart(): void {
    this.state = 'playing';
  }
}
