#!/bin/bash

node core/index.js&
sleep 1s
node websocket/index.js&
node storage/index.js

kill $(jobs -p)
