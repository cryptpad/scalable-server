import * as WebSocket from './index.js';

process.on('message', (message: Message) => {
	let config = message?.config;
	config.myId = message.name;
	config.index = message.index;
	WebSocket.start(config);
});

