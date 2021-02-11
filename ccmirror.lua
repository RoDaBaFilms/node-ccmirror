function split(pString, pPattern)
    local Table = {}  -- NOTE: use {n = 0} in Lua-5.0
    local fpat = "(.-)" .. pPattern
    local last_end = 1
    local s, e, cap = pString:find(fpat, 1)
    while s do
           if s ~= 1 or cap ~= "" then
          table.insert(Table,cap)
           end
           last_end = e+1
           s, e, cap = pString:find(fpat, last_end)
    end
    if last_end <= #pString then
           cap = pString:sub(last_end)
           table.insert(Table, cap)
    end
    return Table
end

local VERSION = 5

local tArgs = { ... }
local path = '.'

assert(#tArgs > 1, 'Usage: ccmirror <path> <code>')

if #tArgs > 0 then
    path = tArgs[1]
end

assert(fs.exists(path), 'Directory ' .. path .. ' not found')

socket = http.websocket('ws://dev.rodabafilms.com:25580/')
assert(socket, 'WebSocket connection failed')

socket.send('ASSOC:slave')
resp = socket.receive()

assert(resp == 'OK', split(resp, ":")[2])

socket.send('COMMAND:connect:' .. tArgs[2])
resp = socket.receive()

assert(resp == 'OK', split(resp, ":")[2])

local isDebugging = false
local oprint = print
local print = function(text)
  if not isDebugging then oprint(text) end
end

function mainThread()
    while true do
        resp = socket.receive()
    
        if resp == 'DIRCREATE' then
            filename = socket.receive()
            fpath = fs.combine(path, filename)
    
            if fs.exists(fpath) then
                socket.send('ERROR:EXISTS')
            else
                fs.makeDir(fpath)
                socket.send('OK')
    
                print('Create dir: ' .. fpath)
            end
        elseif resp == 'FILEWRITE' then
            filename = socket.receive()
            fpath = fs.combine(path, filename)
    
            data = socket.receive()
            handle = fs.open(fpath, 'w')
            handle.write(data)
            handle.close()
            
            socket.send('OK')
    
            print('Change file: ' .. fpath)
        elseif resp == 'UNLINK' then
            filename = socket.receive()
            fpath = fs.combine(path, filename)
    
            fs.delete(fpath)
            
            socket.send('OK')
    
            print('Unlink: ' .. fpath)
        elseif resp == 'DEBUG' then
            filename = socket.receive()
            program = filename
            if filename:find(' ') then
                program = split(filename, ' ')[1]
            end
    
            if not shell.resolveProgram(program) then
                socket.send('DEBUG:STOP:0:RESOLVE_FAILED')
            else
                if isDebugging then
                    socket.send('DEBUG:STOP:0:ALREADY_ACTIVE')
                else
                    print('Debug started: ' .. filename)
                    socket.send('DEBUG:START:' .. shell.resolveProgram(program))
        
                    isDebugging = true

                    os.queueEvent('debug', filename)
                end
            end
        elseif resp == 'DISCONNECT' then
            socket.close()
    
            print('Mirror stopped')
            return
        else
            print(resp)
        end
    end
end

function debugThread()
    while true do
        local _, filename = os.pullEvent('debug')

        local o_term_write = term.write
        
        local o_tgcp = term.getCursorPos
        local o_tscp = term.setCursorPos
        local o_tclr = term.clear
        local o_tscr = term.scroll

        term.write = function (text)
            socket.send('DEBUG:TEXT:' .. text)
        end

        local lastX, lastY = 0, 0

        term.getCursorPos = function()
            lastX, lastY = o_tgcp()
            return lastX, lastY
        end
        
        term.setCursorPos = function(x, y)
            if y == lastY + 1 then
                socket.send('DEBUG:TEXT:\n')
            end
        end

        term.scroll = function(amount)
            if amount == 1 then
                socket.send('DEBUG:TEXT:\n')
            end
        end

        function blank() end

        term.clear = blank

        shell.run(filename)
        
        term.write = o_term_write
        term.setCursorPos = o_tscp
        term.clear = o_tclr
        term.scroll = o_tscr

        sleep(0.2)

        socket.send('DEBUG:STOP:1')

        isDebugging = false

        print('Debug stopped')
    end
end

parallel.waitForAll(mainThread, debugThread)