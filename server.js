const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path'); // Added for absolute path resolution
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.json());

// Force absolute path mapping for public game assets
app.use(express.static(path.join(__dirname, 'public')));

// ---------- JaaS (Jitsi as a Service) JWT signing ----------
//
// These three values come from your JaaS console (jaas.8x8.vc/#/apikeys):
//   JAAS_APP_ID         -> "Your AppID is:" on that page
//   JAAS_KID            -> the "ID" column for your API key
//   JAAS_PRIVATE_KEY    -> contents of the PRIVATE key file from ssh-keygen
//                          (the one WITHOUT .pub — never the uploaded public key)
//
// Never hardcode these. Set them as environment variables on your host.
// When pasting a multi-line PEM private key into a single-line env var,
// replace real newlines with literal "\n" — the code below converts them back.
const JAAS_APP_ID = process.env.JAAS_APP_ID || '';
const JAAS_KID = process.env.JAAS_KID || '';
const JAAS_PRIVATE_KEY = (process.env.JAAS_PRIVATE_KEY || '').replace(/\\n/g, '\n');

function jaasConfigured() {
    return Boolean(JAAS_APP_ID && JAAS_KID && JAAS_PRIVATE_KEY);
}

// Generates a short-lived JWT authorizing one user to join one room's video call.
// Called fresh for each join rather than reused/cached, so tokens stay short-lived.
function generateJaasToken({ username, roomName, isModerator }) {
    const now = Math.floor(Date.now() / 1000);

    const payload = {
        aud: 'jitsi',
        iss: 'chat',
        sub: JAAS_APP_ID,
        room: '*',
        iat: now,
        nbf: now - 5,
        exp: now + (60 * 60), // 1 hour validity
        context: {
            user: {
                id: 'user-' + Math.random().toString(36).slice(2, 10),
                name: username,
                moderator: isModerator ? 'true' : 'false'
            },
            features: {
                livestreaming: false,
                'file-upload': false,
                'outbound-call': false,
                'sip-outbound-call': false,
                transcription: false,
                'list-visitors': false,
                recording: false,
                flip: false
            }
        }
    };

    return jwt.sign(payload, JAAS_PRIVATE_KEY, {
        algorithm: 'RS256',
        header: {
            kid: JAAS_KID,
            typ: 'JWT'
        }
    });
}

// Client calls this right before opening the video call for a room.
// Room names are sanitized to match what the game already uses, and
// namespaced under the App ID the way JaaS requires.
app.post('/api/video-token', (req, res) => {
    if (!jaasConfigured()) {
        return res.status(503).json({
            error: 'JaaS is not configured on this server. Set JAAS_APP_ID, JAAS_KID, and JAAS_PRIVATE_KEY.'
        });
    }

    const { username, room, isModerator } = req.body || {};

    if (!username || !room || typeof username !== 'string' || typeof room !== 'string') {
        return res.status(400).json({ error: 'username and room are required.' });
    }

    // Keep room names safe for use as a JaaS room identifier
    const safeRoom = room.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeRoom) {
        return res.status(400).json({ error: 'room must contain at least one alphanumeric character.' });
    }

    const fullRoomName = `${JAAS_APP_ID}/${safeRoom}`;

    try {
        const token = generateJaasToken({
            username: username.slice(0, 40),
            roomName: fullRoomName,
            isModerator: Boolean(isModerator)
        });

        res.json({
            token,
            appId: JAAS_APP_ID,
            roomName: fullRoomName
        });
    } catch (err) {
        console.error('JaaS token generation failed:', err);
        res.status(500).json({ error: 'Token generation failed.' });
    }
});

// Fallback Route: If a browser hits the root URL, hand them the main game page
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// In-Memory Game State Databases
const rooms = {}; 
const userProfiles = {}; 

io.on('connection', (socket) => {
    console.log(`🔌 Security Node Connected: ${socket.id}`);

    socket.on('joinRoom', ({ username, room }) => {
        if (!room || !username) return;

        socket.join(room);

        // Track or fetch permanent database profile metrics
        if (!userProfiles[username]) {
            userProfiles[username] = { wins: 0, losses: 0, gamesPlayed: 0 };
        }

        // Initialize room structure if empty
        if (!rooms[room]) {
            rooms[room] = {
                name: room,
                hostId: socket.id,
                started: false,
                phase: 'lobby', // lobby, night, day, ended
                timer: null,
                timeLeft: 0,
                users: [],
                votes: {} // targetId: count
            };
        }

        const playerObject = {
            id: socket.id,
            username: username,
            role: 'civilian',
            alive: true,
            votedFor: null
        };

        rooms[room].users.push(playerObject);

        // Sync individual profile stats back to caller
        socket.emit('profileUpdate', userProfiles[username]);

        // Broadcast host and state rights
        if (rooms[room].hostId === socket.id) {
            socket.emit('isHost');
        } else {
            socket.emit('isPlayer');
        }

        updateRoomUsers(room);
        io.to(room).emit('announcement', `📢 ${username} joined operations.`);
    });

    socket.on('startGame', (roomName) => {
        const room = rooms[roomName];
        if (!room || room.hostId !== socket.id || room.started) return;

        if (room.users.length < 3) {
            socket.emit('announcement', "🚨 Error: Minimum of 3 operatives required to clear operations.");
            return;
        }

        room.started = true;
        room.phase = 'night';
        
        // Assign Roles Strategically (1 Mafia for small groups, ~25% for larger ones)
        const totalPlayers = room.users.length;
        const mafiaCount = Math.max(1, Math.floor(totalPlayers * 0.25));
        
        // Shuffle utility array
        const shuffledIndices = Array.from({ length: totalPlayers }, (_, i) => i)
            .sort(() => Math.random() - 0.5);

        for (let i = 0; i < mafiaCount; i++) {
            room.users[shuffledIndices[i]].role = 'mafia';
        }

        // Direct roles to private client instances
        room.users.forEach(user => {
            io.to(user.id).emit('assignRole', user.role);
        });

        io.to(roomName).emit('gameStarted');
        startPhaseLoop(roomName, 'night', 30); // Start with 30s Night Phase
    });

    socket.on('castVote', ({ room: roomName, targetId }) => {
        const room = rooms[roomName];
        if (!room || !room.started || room.phase === 'lobby') return;

        const voter = room.users.find(u => u.id === socket.id);
        const target = room.users.find(u => u.id === targetId);

        if (!voter || !voter.alive || !target || !target.alive) return;

        // Night Constraints: Non-mafia nodes cannot transmit structural data signatures
        if (room.phase === 'night' && voter.role !== 'mafia') return;

        // Clear existing signature if any
        if (voter.votedFor) {
            room.votes[voter.votedFor] = Math.max(0, (room.votes[voter.votedFor] || 1) - 1);
        }

        voter.votedFor = targetId;
        room.votes[targetId] = (room.votes[targetId] || 0) + 1;

        // Sync updates out
        io.to(roomName).emit('voteUpdate', room.votes);
    });

    socket.on('disconnect', () => {
        console.log(`❌ Disconnected Node: ${socket.id}`);
        
        for (const [roomName, room] of Object.entries(rooms)) {
            const index = room.users.findIndex(u => u.id === socket.id);
            if (index !== -1) {
                const disconnectedUser = room.users[index];
                room.users.splice(index, 1);
                
                io.to(roomName).emit('announcement', `🚨 ${disconnectedUser.username} abandoned operational tracking link.`);

                if (room.users.length === 0) {
                    clearInterval(room.timer);
                    delete rooms[roomName];
                    continue;
                }

                // Migrate Host Authority if creator disconnected
                if (room.hostId === socket.id && room.users.length > 0) {
                    room.hostId = room.users[0].id;
                    io.to(room.hostId).emit('isHost');
                }

                updateRoomUsers(roomName);
                checkVictoryConditions(roomName);
            }
        }
    });
});

function updateRoomUsers(roomName) {
    const room = rooms[roomName];
    if (!room) return;

    // Mask deep role signatures before shipping manifest down the client pipeline
    const publicUserManifest = room.users.map(u => ({
        id: u.id,
        username: u.username,
        alive: u.alive
    }));

    io.to(roomName).emit('roomUsers', { users: publicUserManifest });
}

function startPhaseLoop(roomName, currentPhase, durationSeconds) {
    const room = rooms[roomName];
    if (!room) return;

    room.phase = currentPhase;
    room.timeLeft = durationSeconds;
    room.votes = {}; // Flush the vote matrix baseline for the new cycle
    
    // Clear previous voter alignments
    room.users.forEach(u => u.votedFor = null);
    io.to(roomName).emit('voteUpdate', room.votes);

    io.to(roomName).emit('phaseChange', { phase: room.phase, timeLeft: room.timeLeft });

    if (room.timer) clearInterval(room.timer);

    room.timer = setInterval(() => {
        room.timeLeft--;
        if (room.timeLeft > 0) {
            io.to(roomName).emit('timerUpdate', room.timeLeft);
        } else {
            clearInterval(room.timer);
            evaluatePhaseResolution(roomName);
        }
    }, 1000);
}

function evaluatePhaseResolution(roomName) {
    const room = rooms[roomName];
    if (!room) return;

    // Extract maximum votes metrics
    let highestVoteCount = 0;
    let candidatesToEliminate = [];

    for (const [targetId, voteCount] of Object.entries(room.votes)) {
        if (voteCount > highestVoteCount) {
            highestVoteCount = voteCount;
            candidatesToEliminate = [targetId];
        } else if (voteCount === highestVoteCount) {
            candidatesToEliminate.push(targetId);
        }
    }

    let announcementMsg = "🕊️ No decisive actions taken this round. No one was eliminated.";
    
    // Eliminate only if there isn't an operational tie
    if (highestVoteCount > 0 && candidatesToEliminate.length === 1) {
        const eliminatedId = candidatesToEliminate[0];
        const victim = room.users.find(u => u.id === eliminatedId);
        
        if (victim && victim.alive) {
            victim.alive = false;
            io.to(eliminatedId).emit('eliminated');
            
            announcementMsg = room.phase === 'night' 
                ? `🩸 Tactical Report: ${victim.username} was eliminated during the dark hours.`
                : `⚖️ Public Verdict: ${victim.username} was executed by group decision.`;
        }
    }

    io.to(roomName).emit('announcement', announcementMsg);
    updateRoomUsers(roomName);

    if (checkVictoryConditions(roomName)) return;

    // Flip State Engine to next logical phase
    if (room.phase === 'night') {
        startPhaseLoop(roomName, 'day', 45); // Day phase discussion (45 seconds)
    } else {
        startPhaseLoop(roomName, 'night', 30);
    }
}

function checkVictoryConditions(roomName) {
    const room = rooms[roomName];
    if (!room) return false;

    const aliveMafia = room.users.filter(u => u.alive && u.role === 'mafia').length;
    const aliveCivilians = room.users.filter(u => u.alive && u.role === 'civilian').length;

    // Victory Check 1: All Syndicate agents destroyed
    if (aliveMafia === 0) {
        endGameSession(roomName, "🏆 CIVILIANS WIN! The syndicate has been successfully flushed out of the system.");
        updateProfiles(room.users, 'civilian');
        return true;
    }

    // Victory Check 2: Syndicate matches or outnumbers local enforcement forces
    if (aliveMafia >= aliveCivilians) {
        endGameSession(roomName, "🩸 MAFIA WINS! The syndicate has successfully taken total control of this sector.");
        updateProfiles(room.users, 'mafia');
        return true;
    }

    return false;
}

function updateProfiles(users, winningRole) {
    users.forEach(user => {
        if (!userProfiles[user.username]) return;
        
        userProfiles[user.username].gamesPlayed += 1;
        if (user.role === winningRole) {
            userProfiles[user.username].wins += 1;
        } else {
            userProfiles[user.username].losses += 1;
        }
    });
}

function endGameSession(roomName, winningMessage) {
    const room = rooms[roomName];
    if (!room) return;

    room.phase = 'ended';
    if (room.timer) clearInterval(room.timer);
    io.to(roomName).emit('gameOver', winningMessage);
} // Fixed: Added missing function closing bracket here

// Dynamic Port Assignment optimized for cloud container environments
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Security Engine Operating across link node on port ${PORT}`);
});
