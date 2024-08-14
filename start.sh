#!/bin/bash

node core/index.js&
node core/index.js --id 1&
sleep 1s
node websocket/index.js&
node websocket/index.js --id 1 --port 3001&
node storage/index.js
node storage/index.js --id 1

kill $(jobs -p)
