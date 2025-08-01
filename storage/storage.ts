import * as Storage from './index.js';

process.on('message', (message: Message) => {
    Storage.start(message);
});

export const start = Storage.start;
