const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- JaaS JWT signing ----------
const JAAS_APP_ID = process.env.JAAS_APP_ID || '';
const JAAS_KID = process.env.JAAS_KID || '';
const JAAS_PRIVATE_KEY = (process.env.JAAS_PRIVATE_KEY || '').replace(/\\n/g, '\n');

function jaasConfigured() {
    return Boolean(JAAS_APP_ID && JAAS_KID && JAAS_PRIVATE_KEY);
}

function generateJaasToken({ username, isModerator }) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        aud: 'jitsi',
        iss: 'chat',
        sub: JAAS_APP_ID,
        room: '*',
        iat: now,
        nbf: now - 5,
        exp: now + (60 * 60),
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
        header: { kid: JAAS_KID, typ: 'JWT' }
    });
}

app.post('/api/video-token', (req, res) => {
    if (!jaasConfigured()) {
        return res.status(503).json({ error: 'JaaS not configured.' });
    }
    const { username, room, isModerator } = req.body || {};
    if (!username || !room) return res.status(400).json({ error: 'username and room required.' });
    const safeRoom = room.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeRoom) return res.status(400).json({ error: 'Invalid room name.' });
    try {
        const token = generateJaasToken({ username: username.slice(0, 40), isModerator: Boolean(isModerator) });
        res.json({ token, appId: JAAS_APP_ID, roomName: `${JAAS_APP_ID}/${safeRoom}` });
    } catch (err) {
        console.error('JaaS token error:', err);
        res.status(500).json({ error: 'Token generation failed.' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Game state ----------
const rooms = {};
const userProfiles = {};
const RECONNECT_GRACE_MS = 45 * 1000;

io.on('connection', (socket) => {
    console.log(`🔌 Connected: ${socket.id}`);

    socket.on('joinRoom', ({ username, room }) => {
        if (!room || !username) return;
        socket.join(room);

        if (!userProfiles[username]) {
            userProfiles[username] = { wins: 0, losses: 0, gamesPlayed: 0 };
        }

        if (!rooms[room]) {
            rooms[room] = {
                name: room,
                hostId: socket.id,
                started: false,
                round: 0,
                users: [],
                votes: {},
                mafiaVotes: {}
            };
        }

        const currentRoom = rooms[room];

        // Reconnect path
        const reconnectingUser = currentRoom.users.find(u => u.username === username && u.disconnected);
        if (reconnectingUser) {
            if (reconnectingUser.disconnectTimer) {
                clearTimeout(reconnectingUser.disconnectTimer);
                reconnectingUser.disconnectTimer = null;
            }
            const wasHost = currentRoom.hostId === reconnectingUser.id;
            reconnectingUser.id = socket.id;
            reconnectingUser.disconnected = false;
            if (wasHost) currentRoom.hostId = socket.id;

            socket.emit('profileUpdate', userProfiles[username]);
            socket.emit('rejoined', { role: reconnectingUser.role, alive: reconnectingUser.alive });
            socket.emit(currentRoom.hostId === socket.id ? 'isHost' : 'isPlayer');
            if (currentRoom.started && reconnectingUser.role) {
                socket.emit('assignRole', reconnectingUser.role);
            }
            updateRoomUsers(room);
            io.to(room).emit('announcement', `🔄 ${username} reconnected.`);
            return;
        }

        // Duplicate username check
        const nameTaken = currentRoom.users.some(u => u.username === username && !u.disconnected);
        if (nameTaken) {
            socket.emit('joinRejected', { reason: 'username-taken' });
            return;
        }

        currentRoom.users.push({
            id: socket.id,
            username,
            role: 'civilian',
            alive: true,
            votedFor: null,
            mafiaVotedFor: null,
            disconnected: false,
            disconnectTimer: null
        });

        socket.emit('profileUpdate', userProfiles[username]);
        socket.emit(currentRoom.hostId === socket.id ? 'isHost' : 'isPlayer');
        updateRoomUsers(room);
        io.to(room).emit('announcement', `${username} joined.`);
    });

    socket.on('startGame', (roomName) => {
        const room = rooms[roomName];
        if (!room || room.hostId !== socket.id || room.started) return;
        if (room.users.length < 3) {
            socket.emit('announcement', 'Need at least 3 players to start.');
            return;
        }

        room.started = true;
        room.round = 1;
        room.votes = {};
        room.mafiaVotes = {};

        const total = room.users.length;
        const mafiaCount = Math.max(1, Math.floor(total * 0.25));
        const shuffled = Array.from({ length: total }, (_, i) => i).sort(() => Math.random() - 0.5);
        for (let i = 0; i < mafiaCount; i++) {
            room.users[shuffled[i]].role = 'mafia';
        }

        room.users.forEach(u => io.to(u.id).emit('assignRole', u.role));
        io.to(roomName).emit('gameStarted', { round: room.round });
        updateRoomUsers(roomName);
    });

    // Public vote (everyone can see the counts)
    socket.on('castVote', ({ room: roomName, targetId }) => {
        const room = rooms[roomName];
        if (!room || !room.started) return;

        const voter = room.users.find(u => u.id === socket.id);
        const target = room.users.find(u => u.id === targetId);
        if (!voter || !voter.alive || !target || !target.alive || target.disconnected) return;
        if (voter.id === targetId) return;

        if (voter.votedFor) {
            room.votes[voter.votedFor] = Math.max(0, (room.votes[voter.votedFor] || 1) - 1);
        }
        voter.votedFor = targetId;
        room.votes[targetId] = (room.votes[targetId] || 0) + 1;
        io.to(roomName).emit('voteUpdate', room.votes);
    });

    // Mafia secret vote (only sent back to mafia members)
    socket.on('castMafiaVote', ({ room: roomName, targetId }) => {
        const room = rooms[roomName];
        if (!room || !room.started) return;

        const voter = room.users.find(u => u.id === socket.id);
        const target = room.users.find(u => u.id === targetId);
        if (!voter || voter.role !== 'mafia' || !voter.alive) return;
        if (!target || !target.alive || target.disconnected) return;
        if (voter.id === targetId) return;

        if (voter.mafiaVotedFor) {
            room.mafiaVotes[voter.mafiaVotedFor] = Math.max(0, (room.mafiaVotes[voter.mafiaVotedFor] || 1) - 1);
        }
        voter.mafiaVotedFor = targetId;
        room.mafiaVotes[targetId] = (room.mafiaVotes[targetId] || 0) + 1;

        // Only broadcast mafia vote totals back to mafia members
        const mafiaMembers = room.users.filter(u => u.role === 'mafia' && u.alive);
        mafiaMembers.forEach(m => io.to(m.id).emit('mafiaVoteUpdate', room.mafiaVotes));
    });

    // Host ends the round — resolves both public vote and mafia kill
    socket.on('endRound', (roomName) => {
        const room = rooms[roomName];
        if (!room || room.hostId !== socket.id || !room.started) return;

        const announcements = [];

        // Resolve mafia kill (highest mafia vote)
        let mafiaKillId = resolveMajorityVote(room.mafiaVotes);
        if (mafiaKillId) {
            const victim = room.users.find(u => u.id === mafiaKillId);
            if (victim && victim.alive) {
                victim.alive = false;
                io.to(mafiaKillId).emit('eliminated');
                announcements.push(`🩸 ${victim.username} was eliminated by the mafia.`);
            }
        } else {
            announcements.push('🕊️ The mafia couldn\'t agree — no kill this round.');
        }

        // Resolve public vote (highest public vote)
        let publicKillId = resolveMajorityVote(room.votes);
        if (publicKillId) {
            const victim = room.users.find(u => u.id === publicKillId);
            if (victim && victim.alive) {
                victim.alive = false;
                io.to(publicKillId).emit('eliminated');
                announcements.push(`⚖️ ${victim.username} was voted out by the group.`);
            }
        } else {
            announcements.push('🤝 No consensus — nobody was voted out.');
        }

        // Reset votes for next round
        room.votes = {};
        room.mafiaVotes = {};
        room.users.forEach(u => { u.votedFor = null; u.mafiaVotedFor = null; });
        io.to(roomName).emit('voteUpdate', room.votes);
        const mafiaMembers = room.users.filter(u => u.role === 'mafia');
        mafiaMembers.forEach(m => io.to(m.id).emit('mafiaVoteUpdate', room.mafiaVotes));

        announcements.forEach(msg => io.to(roomName).emit('announcement', msg));
        updateRoomUsers(roomName);

        if (checkVictoryConditions(roomName)) return;

        room.round++;
        io.to(roomName).emit('roundStarted', { round: room.round });
    });

    // ---------- Host controls ----------
    socket.on('kickPlayer', ({ room: roomName, targetId }) => {
        const room = rooms[roomName];
        if (!room || room.hostId !== socket.id) return;
        if (targetId === socket.id) return;

        const index = room.users.findIndex(u => u.id === targetId);
        if (index === -1) return;

        const kicked = room.users[index];
        if (kicked.disconnectTimer) clearTimeout(kicked.disconnectTimer);
        room.users.splice(index, 1);

        io.to(targetId).emit('kicked');
        io.sockets.sockets.get(targetId)?.leave(roomName);
        io.to(roomName).emit('announcement', `${kicked.username} was removed by the host.`);

        if (room.users.length === 0) { delete rooms[roomName]; return; }
        updateRoomUsers(roomName);
        if (room.started) checkVictoryConditions(roomName);
    });

    socket.on('transferHost', ({ room: roomName, targetId }) => {
        const room = rooms[roomName];
        if (!room || room.hostId !== socket.id) return;
        const target = room.users.find(u => u.id === targetId && !u.disconnected);
        if (!target) return;

        room.hostId = targetId;
        io.to(targetId).emit('isHost');
        socket.emit('isPlayer');
        io.to(roomName).emit('announcement', `👑 ${target.username} is now the host.`);
        updateRoomUsers(roomName);
    });

    socket.on('restartGame', (roomName) => {
        const room = rooms[roomName];
        if (!room || room.hostId !== socket.id) return;

        room.started = false;
        room.round = 0;
        room.votes = {};
        room.mafiaVotes = {};
        room.users.forEach(u => {
            u.role = 'civilian';
            u.alive = true;
            u.votedFor = null;
            u.mafiaVotedFor = null;
        });

        io.to(roomName).emit('gameReset');
        io.to(roomName).emit('announcement', 'The host reset the game. Back to the lobby.');
        updateRoomUsers(roomName);
    });

    socket.on('disconnect', () => {
        console.log(`❌ Disconnected: ${socket.id}`);
        for (const [roomName, room] of Object.entries(rooms)) {
            const user = room.users.find(u => u.id === socket.id);
            if (!user) continue;

            user.disconnected = true;
            io.to(roomName).emit('announcement', `${user.username} lost connection — holding seat for ${RECONNECT_GRACE_MS / 1000}s...`);
            updateRoomUsers(roomName);

            user.disconnectTimer = setTimeout(() => {
                finalizeDisconnect(roomName, socket.id);
            }, RECONNECT_GRACE_MS);
        }
    });
});

function resolveMajorityVote(votes) {
    let highest = 0;
    let candidates = [];
    for (const [id, count] of Object.entries(votes)) {
        if (count > highest) { highest = count; candidates = [id]; }
        else if (count === highest) { candidates.push(id); }
    }
    return (highest > 0 && candidates.length === 1) ? candidates[0] : null;
}

function finalizeDisconnect(roomName, socketId) {
    const room = rooms[roomName];
    if (!room) return;
    const index = room.users.findIndex(u => u.id === socketId && u.disconnected);
    if (index === -1) return;

    const removed = room.users[index];
    room.users.splice(index, 1);
    io.to(roomName).emit('announcement', `${removed.username} left the game.`);

    if (room.users.length === 0) { delete rooms[roomName]; return; }

    if (room.hostId === socketId) {
        const next = room.users.find(u => !u.disconnected) || room.users[0];
        room.hostId = next.id;
        io.to(room.hostId).emit('isHost');
    }

    updateRoomUsers(roomName);
    checkVictoryConditions(roomName);
}

function updateRoomUsers(roomName) {
    const room = rooms[roomName];
    if (!room) return;
    const manifest = room.users.map(u => ({
        id: u.id,
        username: u.username,
        alive: u.alive,
        disconnected: Boolean(u.disconnected)
    }));
    io.to(roomName).emit('roomUsers', { users: manifest, hostId: room.hostId });
}

function checkVictoryConditions(roomName) {
    const room = rooms[roomName];
    if (!room || !room.started) return false;

    const aliveMafia = room.users.filter(u => u.alive && u.role === 'mafia').length;
    const aliveCivilians = room.users.filter(u => u.alive && u.role === 'civilian').length;

    if (aliveMafia === 0) {
        endGame(roomName, '🏆 Civilians win! All mafia have been eliminated.');
        updateProfiles(room.users, 'civilian');
        return true;
    }
    if (aliveMafia >= aliveCivilians) {
        endGame(roomName, '🩸 Mafia wins! They now control the majority.');
        updateProfiles(room.users, 'mafia');
        return true;
    }
    return false;
}

function updateProfiles(users, winningRole) {
    users.forEach(user => {
        if (!userProfiles[user.username]) return;
        userProfiles[user.username].gamesPlayed += 1;
        if (user.role === winningRole) userProfiles[user.username].wins += 1;
        else userProfiles[user.username].losses += 1;
    });
}

function endGame(roomName, message) {
    const room = rooms[roomName];
    if (!room) return;
    room.started = false;
    io.to(roomName).emit('gameOver', message);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
