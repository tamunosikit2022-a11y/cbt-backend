/**
 * STUDY ROOM ENGINE
 * ─────────────────────────────────────────────────────────
 * Real-time social study spaces.
 *
 * Features:
 *  - Named study rooms with subject tags
 *  - Text chat
 *  - WebRTC voice signaling (offer/answer/ICE relay)
 *  - Shared Quiz mode: host pushes a question, members answer,
 *    everyone sees who got it right
 *  - Pomodoro timer that room members share
 *  - "Raise hand" to ask for help
 *  - Room types: public (anyone) | school (same school only) | private (invite code)
 *
 * Socket namespace: /study
 */

const db = require('../config/db');

const studyRooms = new Map();  // roomId -> roomObject

function roomId() {
  return `SR_${Math.random().toString(36).slice(2,8).toUpperCase()}`;
}

function newStudyRoom(opts) {
  return {
    id:          opts.id,
    name:        opts.name        || 'Study Room',
    subject:     opts.subject     || 'General',
    hostId:      opts.hostId,
    hostName:    opts.hostName,
    type:        opts.type        || 'public',   // public|school|private
    school:      opts.school      || null,        // for school-restricted rooms
    inviteCode:  opts.type === 'private' ? roomId() : null,
    members:     new Map(),                       // socketId -> memberObj
    chat:        [],                              // last 50 messages
    sharedQuiz:  null,                            // active shared question
    pomodoro:    { active: false, endsAt: null, duration: 25 },
    raisedHands: new Set(),
    maxMembers:  20,
    createdAt:   Date.now(),
  };
}

function safeRoom(room) {
  return {
    id:          room.id,
    name:        room.name,
    subject:     room.subject,
    hostId:      room.hostId,
    hostName:    room.hostName,
    type:        room.type,
    school:      room.school,
    inviteCode:  room.inviteCode,
    memberCount: room.members.size,
    maxMembers:  room.maxMembers,
    members:     [...room.members.values()].map(m => ({
      id: m.id, name: m.name, avatar: m.avatar, isMuted: m.isMuted, handRaised: m.handRaised,
    })),
    pomodoro:    room.pomodoro,
    sharedQuiz:  room.sharedQuiz ? {
      question: room.sharedQuiz.question,
      options:  room.sharedQuiz.options,
      answers:  room.sharedQuiz.answers,
      revealed: room.sharedQuiz.revealed,
    } : null,
    createdAt:   room.createdAt,
  };
}

// ── REST CONTROLLERS ──────────────────────────────────────

// GET /api/study-rooms
exports.listRooms = async (req, res) => {
  const school = req.student.school_name;
  const rooms = [...studyRooms.values()]
    .filter(r => {
      if (r.type === 'private') return false;
      if (r.type === 'school' && r.school !== school) return false;
      return true;
    })
    .map(safeRoom);
  res.json({ rooms });
};

// POST /api/study-rooms  — create a room
exports.createRoom = async (req, res) => {
  try {
    const { name, subject, type } = req.body;
    const id   = roomId();
    const room = newStudyRoom({
      id, name, subject, type,
      hostId:   req.student.id,
      hostName: req.student.full_name,
      school:   req.student.school_name,
    });
    studyRooms.set(id, room);
    res.json({ success: true, room: safeRoom(room) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/study-rooms/:id
exports.getRoom = async (req, res) => {
  const room = studyRooms.get(req.params.id);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  res.json(safeRoom(room));
};

// ── SOCKET ENGINE ─────────────────────────────────────────
function initStudyRooms(io) {
  const ns = io.of('/study');

  ns.on('connection', socket => {

    // ── JOIN ROOM ────────────────────────────────────────
    socket.on('study:join', ({ roomId: rid, playerId, playerName, avatar, inviteCode }, cb) => {
      const room = studyRooms.get(rid);
      if (!room) return cb?.({ success: false, error: 'Room not found.' });

      // Access control
      if (room.type === 'private' && room.inviteCode !== inviteCode)
        return cb?.({ success: false, error: 'Invalid invite code.' });
      if (room.members.size >= room.maxMembers)
        return cb?.({ success: false, error: 'Room is full.' });

      // Reconnect check
      const existing = [...room.members.entries()].find(([, m]) => m.id === playerId);
      if (existing) room.members.delete(existing[0]);

      room.members.set(socket.id, {
        id: playerId, name: playerName, avatar: avatar || '🎓',
        isMuted: false, handRaised: false, socketId: socket.id,
      });
      socket.join(rid);
      socket.studyRoomId = rid;
      socket.studyPlayerId = playerId;

      // Send room state + chat history to the joiner
      cb?.({ success: true, room: safeRoom(room), chatHistory: room.chat.slice(-30) });

      // Announce to others
      ns.to(rid).emit('study:member_joined', {
        member: { id: playerId, name: playerName, avatar },
        memberCount: room.members.size,
      });
    });

    // ── LEAVE ROOM ────────────────────────────────────────
    socket.on('study:leave', () => handleLeave(socket, ns));
    socket.on('disconnect', () => handleLeave(socket, ns));

    // ── TEXT CHAT ─────────────────────────────────────────
    socket.on('study:chat', ({ message }, cb) => {
      const room = studyRooms.get(socket.studyRoomId);
      if (!room) return;
      const member = room.members.get(socket.id);
      if (!member) return;

      // Simple profanity-length guard
      if (!message || message.length > 500) return;

      const msg = {
        id:       Date.now(),
        playerId: member.id,
        name:     member.name,
        avatar:   member.avatar,
        text:     message.trim(),
        ts:       new Date().toISOString(),
      };

      room.chat.push(msg);
      if (room.chat.length > 50) room.chat.shift();

      ns.to(socket.studyRoomId).emit('study:chat', msg);
      cb?.({ success: true });
    });

    // ── RAISE / LOWER HAND ────────────────────────────────
    socket.on('study:raise_hand', ({ raised }) => {
      const room = studyRooms.get(socket.studyRoomId);
      if (!room) return;
      const member = room.members.get(socket.id);
      if (!member) return;

      member.handRaised = !!raised;
      if (raised) room.raisedHands.add(member.id);
      else        room.raisedHands.delete(member.id);

      ns.to(socket.studyRoomId).emit('study:hand_update', {
        playerId:   member.id,
        playerName: member.name,
        raised:     !!raised,
        raisedCount: room.raisedHands.size,
      });
    });

    // ── POMODORO TIMER ────────────────────────────────────
    socket.on('study:pomodoro_start', ({ minutes = 25 }, cb) => {
      const room = studyRooms.get(socket.studyRoomId);
      if (!room) return cb?.({ success: false });
      const member = room.members.get(socket.id);
      if (!member || member.id !== room.hostId) return cb?.({ success: false, error: 'Only host can start the timer.' });

      const duration = Math.min(Math.max(parseInt(minutes) || 25, 1), 60);
      room.pomodoro  = { active: true, endsAt: Date.now() + duration * 60_000, duration };

      ns.to(socket.studyRoomId).emit('study:pomodoro_start', room.pomodoro);
      cb?.({ success: true, pomodoro: room.pomodoro });

      // Auto-end
      setTimeout(() => {
        if (room.pomodoro.active) {
          room.pomodoro.active = false;
          ns.to(socket.studyRoomId).emit('study:pomodoro_end', { message: '⏰ Pomodoro session complete! Take a break.' });
        }
      }, duration * 60_000);
    });

    socket.on('study:pomodoro_stop', () => {
      const room = studyRooms.get(socket.studyRoomId);
      if (!room) return;
      room.pomodoro.active = false;
      ns.to(socket.studyRoomId).emit('study:pomodoro_end', { message: 'Timer stopped.' });
    });

    // ── SHARED QUIZ ───────────────────────────────────────
    socket.on('study:push_question', async ({ questionId, custom }, cb) => {
      const room = studyRooms.get(socket.studyRoomId);
      if (!room) return cb?.({ success: false });
      const member = room.members.get(socket.id);
      if (!member || member.id !== room.hostId) return cb?.({ success: false, error: 'Only host can push questions.' });

      let q = null;

      if (questionId) {
        const r = await db.query(
          `SELECT id, question, option_a, option_b, option_c, option_d, correct_answer, subject
           FROM questions WHERE id=$1`, [questionId]
        ).catch(() => ({ rows: [] }));
        if (r.rows.length) {
          const qr = r.rows[0];
          q = {
            questionId:    qr.id,
            question:      qr.question,
            options:       { A: qr.option_a, B: qr.option_b, C: qr.option_c, D: qr.option_d },
            correct:       qr.correct_answer,
            subject:       qr.subject,
          };
        }
      } else if (custom?.question) {
        // Host typed their own question
        q = {
          questionId: `custom_${Date.now()}`,
          question:   custom.question,
          options:    custom.options,
          correct:    custom.correct,
          subject:    custom.subject || 'Custom',
        };
      }

      if (!q) return cb?.({ success: false, error: 'Question not found.' });

      room.sharedQuiz = {
        ...q,
        answers:  {},   // memberId -> selected answer
        revealed: false,
        pushedAt: Date.now(),
      };

      // Send question WITHOUT the correct answer
      const { correct, ...clientQ } = room.sharedQuiz;
      ns.to(socket.studyRoomId).emit('study:shared_question', clientQ);
      cb?.({ success: true });
    });

    socket.on('study:answer_question', ({ answer }, cb) => {
      const room = studyRooms.get(socket.studyRoomId);
      if (!room?.sharedQuiz || room.sharedQuiz.revealed) return cb?.({ success: false });
      const member = room.members.get(socket.id);
      if (!member) return;

      room.sharedQuiz.answers[member.id] = answer;

      // Notify everyone an answer was submitted (but not which answer)
      ns.to(socket.studyRoomId).emit('study:answer_submitted', {
        playerId: member.id, name: member.name,
        totalAnswered: Object.keys(room.sharedQuiz.answers).length,
        totalMembers:  room.members.size,
      });

      cb?.({ success: true });
    });

    socket.on('study:reveal_answers', (_, cb) => {
      const room = studyRooms.get(socket.studyRoomId);
      if (!room?.sharedQuiz) return cb?.({ success: false });
      const member = room.members.get(socket.id);
      if (!member || member.id !== room.hostId) return cb?.({ success: false, error: 'Only host can reveal.' });

      room.sharedQuiz.revealed = true;

      // Build results including who got it right
      const results = Object.entries(room.sharedQuiz.answers).map(([pid, ans]) => ({
        playerId:  pid,
        name:      [...room.members.values()].find(m => m.id === pid)?.name || 'Unknown',
        answer:    ans,
        isCorrect: ans?.toUpperCase() === room.sharedQuiz.correct?.toUpperCase(),
      }));

      ns.to(socket.studyRoomId).emit('study:quiz_revealed', {
        correct: room.sharedQuiz.correct,
        results,
      });

      cb?.({ success: true });
      setTimeout(() => { if (room.sharedQuiz) room.sharedQuiz = null; }, 30_000);
    });

    // ── WEBRTC VOICE SIGNALING ────────────────────────────
    socket.on('study:voice_offer', ({ targetSocketId, offer }) => {
      ns.to(targetSocketId).emit('study:voice_offer', {
        fromSocketId: socket.id,
        offer,
      });
    });

    socket.on('study:voice_answer', ({ targetSocketId, answer }) => {
      ns.to(targetSocketId).emit('study:voice_answer', {
        fromSocketId: socket.id,
        answer,
      });
    });

    socket.on('study:ice_candidate', ({ targetSocketId, candidate }) => {
      ns.to(targetSocketId).emit('study:ice_candidate', {
        fromSocketId: socket.id,
        candidate,
      });
    });

    socket.on('study:mute_toggle', ({ isMuted }) => {
      const room = studyRooms.get(socket.studyRoomId);
      if (!room) return;
      const member = room.members.get(socket.id);
      if (!member) return;
      member.isMuted = !!isMuted;
      ns.to(socket.studyRoomId).emit('study:mute_update', {
        playerId: member.id, isMuted: member.isMuted,
      });
    });
  });
}

function handleLeave(socket, ns) {
  const rid = socket.studyRoomId;
  if (!rid) return;
  const room = studyRooms.get(rid);
  if (!room) return;

  const member = room.members.get(socket.id);
  room.members.delete(socket.id);
  socket.leave(rid);

  if (room.members.size === 0) {
    // Empty room — clean up after 5 minutes
    setTimeout(() => {
      if (studyRooms.get(rid)?.members.size === 0) studyRooms.delete(rid);
    }, 5 * 60 * 1000);
  } else {
    // Reassign host if needed
    if (member?.id === room.hostId) {
      const newHost = [...room.members.values()][0];
      room.hostId   = newHost.id;
      room.hostName = newHost.name;
      ns.to(rid).emit('study:host_changed', { newHostId: newHost.id, newHostName: newHost.name });
    }

    ns.to(rid).emit('study:member_left', {
      playerId: member?.id, name: member?.name,
      memberCount: room.members.size,
    });
  }
}

module.exports = { initStudyRooms, studyRooms,
  listRooms: exports.listRooms,
  createRoom: exports.createRoom,
  getRoom: exports.getRoom,
};
