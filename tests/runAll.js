const Fs = require('node:fs');
const Path = require('node:path');
const { Worker } = require('node:worker_threads');

Fs.readdir(Path.join('.', 'tests'), (err, dir) => {
    dir.forEach(file => {
        if (!/test.js$/.test(file)) { return; }
        new Worker('./tests/'+file);
    });
});

