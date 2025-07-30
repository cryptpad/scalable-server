import * as Storage from './index.js';

type Message = { name: string, index: number, config: { myId: string, index: number } }

process.on('message', (message: Message) => {
	let config = message?.config;
	config.myId = message?.name;
	config.index = message?.index;
	Storage.start(config);
});

