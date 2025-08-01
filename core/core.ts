import * as Core from './index.js';

process.on('message', (message: Message) => {
    Core.start(message);
});

export const start = Core.start;
