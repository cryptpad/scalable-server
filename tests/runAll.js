const Fs = require('node:fs');
const Path = require('node:path');

let number = 0;
Fs.readdir(Path.join('.', 'tests'), (err, dir) => {
    dir.forEach(file => {
        if (!/test.js$/.test(file)) { return; }
        number++;
        require('./'+file);
    });
});

let done = 0;
global.onTestEnd = (success) => {
    done++;
    if (done === number) { process.exit(0); }
};
