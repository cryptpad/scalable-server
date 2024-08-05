#!/bin/bash

node core/index.js&
node websocket/index.js&
node storage/index.js

kill $(jobs -p)
