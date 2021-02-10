#!/usr/bin/env node

const chokidar = require('chokidar');
const WebSocket = require('ws');
const fs = require('fs');
const {EventEmitter} = require('events');

(function() {
    if (process.argv.length < 3) {
        console.error('Invalid params, missing code');
        return;
    }

    const CODE = process.argv[2];

    var watcher = chokidar.watch(process.cwd(), {ignored: /^\./, persistent: true, ignoreInitial: true, awaitWriteFinish: true});
    
    watcher
      .on('add', (path) => doQueueUpdate(path, 'add'))
      .on('addDir', (path) => doQueueUpdate(path, 'addDir'))
      .on('change', (path) => doQueueUpdate(path, 'change'))
      .on('unlink', (path) => doQueueUpdate(path, 'unlink'))
      .on('unlinkDir', (path) => doQueueUpdate(path, 'unlinkDir'));
    
    /**
     * @type {WebSocket}
     */
    var socket = null;
    
    const connection = {
        connected: false,
        connecting: false,
        slaveConnected: false
    }
    
    const updateQueue = [];
    const replayEvents = [];
    const socketQueue = [];
    const socketEmitter = new EventEmitter();

    async function socketRead() {
        if (socketQueue.length > 0) {
            return socketQueue.shift();
        }

        return new Promise((resolve) => {
            socketEmitter.once('message', () => {
                resolve(socketQueue.shift());
            });
        })
    }
    
    function doConnectWebSocket() {
        if (connection.connecting) return;
    
        connection.connecting = true;
        socket = new WebSocket('ws://dev.rodabafilms.com:25580/');
    
        socket.onopen = async () => {
            socket.send('ASSOC:controller');
            let response = await socketRead();

            if (response !== 'OK') {
                console.error('[FATAL] WebSocket handshake failed');
                console.error(response.split(':')[1]);
                process.exit(-1);
            }

            socket.send(`COMMAND:connect:${CODE}`);
            response = await socketRead();

            if (response !== 'OK') {
                console.error('[FATAL] WebSocket handshake failed');
                console.error(response.split(':')[1]);
                process.exit(-1);
            }

            socket.send(`COMMAND:hasslave`);
            connection.slaveConnected = await socketRead() === 'YES';

            connection.connecting = false;
            connection.connected = true;

            if (!connection.slaveConnected) {
                const msgEventHandler = async () => {
                    if (await socketRead() === 'EVENT:CLIENT_CONNECT') {
                        connection.slaveConnected = true;
    
                        socketEmitter.off('message', msgEventHandler);
                
                        console.log('CC Computer connected');

                        for (const event of replayEvents) {
                            await doUpdate(...event);
                        }

                        replayEvents.splice(0, replayEvents.length);
                    }
                }
    
                socketEmitter.on('message', msgEventHandler);
            } else {
                console.log('CC Computer connected');
            }
        }
    
        socket.onmessage = (data) => {
            if (data.data === 'EVENT:CLIENT_CONNECT' && connection.slaveConnected) return;

            socketQueue.push(data.data);
            socketEmitter.emit('message');
        }
    
        socket.onerror = (error) => {
            console.error('[FATAL] Error in WebSocket connection, exiting...');
            console.error(error.message);
            process.exit(-1);
        }
    
        socket.onclose = () => {
            console.error('[ERROR] WebSocket connection lost');
        }
    }
    
    async function doUpdate(origPath, event) {
        var path = origPath.substring(process.cwd().length, origPath.length);

        if (!connection.connected) {
            console.log(`[HOLD] [${event}] ${path}`);
            replayEvents.push([origPath, event]);
    
            if (!connection.connecting) {
                doConnectWebSocket();
            }
            
            return;
        }

        if (!connection.slaveConnected) {
            console.log(`[HOLD] [${event}] ${path}`);
            replayEvents.push([origPath, event]);
            return;
        }

        socket.send('COMMAND:hasslave');
        connection.slaveConnected = await socketRead() === 'YES';

        if (!connection.slaveConnected) {
            console.log(`[HOLD] [${event}] ${path}`);
            replayEvents.push([origPath, event]);

            const msgEventHandler = async () => {
                if (await socketRead() === 'EVENT:CLIENT_CONNECT') {
                    connection.slaveConnected = true;

                    socketEmitter.off('message', msgEventHandler);
            
                    console.log('CC Computer connected');
                    
                    for (const event of replayEvents) {
                        await doUpdate(...event);
                    }

                    replayEvents.splice(0, replayEvents.length);
                }
            }

            socketEmitter.on('message', msgEventHandler);

            return;
        }

        console.log(`[DISPATCH] [${event}] ${path}`);

        switch (event) {
            case 'addDir': {
                socket.send('DIRCREATE');
                socket.send(path);

                await socketRead();
            }
            break;

            case 'add':
            case 'change': {
                socket.send('FILEWRITE');
                socket.send(path);
                socket.send(fs.readFileSync(origPath, 'utf8'));

                await socketRead();
            }
            break;

            case 'unlink':
            case 'unlinkDir': {
                socket.send('UNLINK');
                socket.send(path);

                await socketRead();
            }
            break;
        }
    }

    function doQueueUpdate(origPath, event) {
        updateQueue.push([origPath, event]);
    }

    doConnectWebSocket();

    const run = async () => {
        const clonedQueue = [...updateQueue];
        updateQueue.splice(0, updateQueue.length);

        for (const update of clonedQueue) {
            await doUpdate(...update);
        }

        setTimeout(run, 500);
    }

    setTimeout(run, 500);
})();