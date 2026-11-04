import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@agent-office/shared';

/** Hub central de eventos: tudo que o frontend vê passa por aqui. */
export class Hub extends EventEmitter {
  broadcast(ev: ServerEvent): void {
    this.emit('event', ev);
  }
  onEvent(listener: (ev: ServerEvent) => void): void {
    this.on('event', listener);
  }
}
