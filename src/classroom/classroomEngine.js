"use strict";
const db = require("../config/db");

const sessions = new Map();

function genCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function newSession({ code, teacherId, teacherName, subject, title, description, themeColor, icon }) {
  return {
    code, teacherId, teacherName,
    subject: subject || "General",
    title:   title   || "Scholar Session",
    description: description || "",
    themeColor:  themeColor  || "#7C5CFF",
    icon:        icon        || "📚",
    participants:  new Map(), // socketId → user
    pendingJoins:  new Map(), // socketId → { studentId, studentName }
    chat:  [],
    board: [],
    started: new Date(),
  };
}

function sanitize(s) {
  return {
    code: s.code, teacherName: s.teacherName,
    subject: s.subject, title: s.title,
    description: s.description, themeColor: s.themeColor, icon: s.icon,
    participants: Array.from(s.participants.values()),
    started: s.started,
  };
}

// Persist the whiteboard + chat and mark the session ended — shared by
// both an explicit "End Session" tap and an unexpected teacher disconnect,
// so a class is never silently lost without becoming visitable later.
async function endAndArchiveSession(code, nsp) {
  const sess = sessions.get(code);
  if (!sess) return;
  try {
    await db.query(
      `UPDATE classroom_sessions
         SET status='ended', ended_at=NOW(),
             board_archive=$2, chat_archive=$3,
             peak_count = GREATEST(peak_count, $4)
       WHERE code=$1`,
      [code, JSON.stringify(sess.board || []), JSON.stringify(sess.chat || []), sess.participants.size]
    );
  } catch (err) {
    console.error(`Failed to archive session ${code}:`, err.message);
  }
  sessions.delete(code);
}

function initClassroom(io) {
  const nsp = io.of("/classroom");

  nsp.on("connection", socket => {
    let sessionCode = null;
    let me          = null;

    // ── CREATE SESSION (teacher) ──────────────────────────
    socket.on("create_session", async (data, cb) => {
      try {
        const c    = genCode();
        const sess = newSession({ code: c, ...data });
        sessions.set(c, sess);

        await db.query(
          `INSERT INTO classroom_sessions (code,teacher_id,teacher_name,subject,title,description,theme_color,icon,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active') ON CONFLICT DO NOTHING`,
          [c, data.teacherId, data.teacherName,
           data.subject || "General", data.title || "Scholar Session",
           data.description || null, data.themeColor || "#7C5CFF", data.icon || "📚"]
        ).catch(() => {});

        socket.join(c);
        sessionCode = c;
        me = { id: data.teacherId, name: data.teacherName, role: "teacher", socketId: socket.id };
        sess.participants.set(socket.id, me);

        cb({ success: true, code: c, session: sanitize(sess) });
        console.log(`📚 Session ${c} created by ${data.teacherName}`);
      } catch (err) { cb({ success: false, error: err.message }); }
    });

    // ── STUDENT REQUEST JOIN (pending approval) ───────────
    socket.on("request_join", (data, cb) => {
      try {
        const c    = (data.code || "").toUpperCase();
        const sess = sessions.get(c);

        if (!sess) return cb({ success: false, error: "Session not found. Check the code." });

        // Store pending join
        sess.pendingJoins.set(socket.id, {
          socketId:    socket.id,
          studentId:   data.studentId,
          studentName: data.studentName,
        });

        // Notify teacher
        for (const [sid, user] of sess.participants) {
          if (user.role === "teacher") {
            nsp.to(sid).emit("join_request", {
              socketId:    socket.id,
              studentId:   data.studentId,
              studentName: data.studentName,
            });
            break;
          }
        }

        // Store code temporarily on socket for approval
        socket._pendingCode = c;
        socket._pendingId   = data.studentId;
        socket._pendingName = data.studentName;

        cb({ success: true, pending: true });
        console.log(`⏳ ${data.studentName} requesting to join ${c}`);
      } catch (err) { cb({ success: false, error: err.message }); }
    });

    // ── TEACHER APPROVES JOIN ─────────────────────────────
    socket.on("approve_join", (data) => {
      if (!sessionCode) return;
      const sess = sessions.get(sessionCode);
      if (!sess || me?.role !== "teacher") return;

      const pending = sess.pendingJoins.get(data.socketId);
      if (!pending) return;

      sess.pendingJoins.delete(data.socketId);

      // Add student to session
      const studentUser = {
        id:       pending.studentId,
        name:     pending.studentName,
        role:     "student",
        socketId: data.socketId,
      };
      sess.participants.set(data.socketId, studentUser);

      // FIX: record attendance so the student can find this class again
      // later in "My Past Classes" — previously nothing tracked who had
      // actually attended a session, only who created it.
      db.query(
        `INSERT INTO classroom_participants (session_code, student_id, student_name)
         VALUES ($1,$2,$3)`,
        [sessionCode, pending.studentId, pending.studentName]
      ).catch(() => {});

      // Make student join room
      const studentSocket = nsp.sockets.get(data.socketId);
      if (studentSocket) {
        studentSocket.join(sessionCode);
        studentSocket._sessionCode = sessionCode;
        studentSocket._me = studentUser;
      }

      // Send session data to student
      nsp.to(data.socketId).emit("join_approved", {
        session: sanitize(sess),
        board:   sess.board,
        chat:    sess.chat.slice(-50),
      });

      // Notify everyone else
      socket.to(sessionCode).emit("participant_joined", {
        user:         studentUser,
        participants: Array.from(sess.participants.values()),
      });

      console.log(`✅ ${pending.studentName} approved into ${sessionCode}`);
    });

    // ── TEACHER REJECTS JOIN ──────────────────────────────
    socket.on("reject_join", (data) => {
      if (!sessionCode || me?.role !== "teacher") return;
      const sess = sessions.get(sessionCode);
      if (sess) sess.pendingJoins.delete(data.socketId);
      nsp.to(data.socketId).emit("join_rejected");
      console.log(`❌ Join rejected for socket ${data.socketId}`);
    });

    // ── WHITEBOARD ────────────────────────────────────────
    socket.on("draw_stroke", data => {
      const code = sessionCode || socket._sessionCode;
      if (!code) return;
      const sess = sessions.get(code);
      if (!sess) return;
      const stroke = { ...data, uid: me?.id || socket._me?.id, uname: me?.name || socket._me?.name, ts: Date.now() };
      if (data.tool !== "eraser") {
        sess.board.push({ type: "stroke", data: stroke });
        if (sess.board.length > 3000) sess.board = sess.board.slice(-2000);
      }
      socket.to(code).emit("draw_stroke", stroke);
    });

    socket.on("add_text", data => {
      const code = sessionCode || socket._sessionCode;
      if (!code) return;
      const sess = sessions.get(code);
      if (!sess) return;
      const el = { ...data, uid: me?.id || socket._me?.id, ts: Date.now() };
      sess.board.push({ type: "text", data: el });
      socket.to(code).emit("add_text", el);
    });

    socket.on("clear_board", () => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || user?.role !== "teacher") return;
      const sess = sessions.get(code);
      if (sess) sess.board = [];
      nsp.to(code).emit("clear_board");
    });

    // ── CHAT ──────────────────────────────────────────────
    socket.on("chat_message", data => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || !user) return;
      const sess = sessions.get(code);
      if (!sess) return;
      const msg = {
        id:   Date.now(),
        uid:  user.id,
        name: user.name,
        role: user.role,
        text: (data.text || "").slice(0, 500),
        ts:   new Date().toISOString(),
      };
      sess.chat.push(msg);
      if (sess.chat.length > 200) sess.chat = sess.chat.slice(-150);
      nsp.to(code).emit("chat_message", msg);
    });

    // ── VOICE SIGNALING (WebRTC) ──────────────────────────
    socket.on("voice_join", () => {
      const code = sessionCode || socket._sessionCode;
      if (!code) return;
      socket.to(code).emit("voice_join", {
        socketId: socket.id,
        user:     me || socket._me,
      });
    });

    socket.on("voice_offer",  d => socket.to(d.to).emit("voice_offer",  { ...d, from: socket.id }));
    socket.on("voice_answer", d => socket.to(d.to).emit("voice_answer", { ...d, from: socket.id }));
    socket.on("voice_ice",    d => socket.to(d.to).emit("voice_ice",    { ...d, from: socket.id }));
    socket.on("voice_leave",  () => {
      const code = sessionCode || socket._sessionCode;
      if (!code) return;
      socket.to(code).emit("voice_leave", { socketId: socket.id });
    });

    // ── TEACHER CONTROLS ──────────────────────────────────
    socket.on("allow_draw", data => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || user?.role !== "teacher") return;
      nsp.to(code).emit("draw_permission", data);
    });

    socket.on("kick_student", data => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || user?.role !== "teacher") return;
      const sess = sessions.get(code);
      if (!sess) return;
      for (const [sid, u] of sess.participants) {
        if (String(u.id) === String(data.studentId)) {
          nsp.to(sid).emit("kicked", { message: "You have been removed from this session." });
          sess.participants.delete(sid);
          break;
        }
      }
      nsp.to(code).emit("participant_left", {
        participants: Array.from(sess.participants.values()),
      });
    });

    socket.on("end_session", async () => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || user?.role !== "teacher") return;
      nsp.to(code).emit("session_ended", { message: "The teacher has ended this session." });
      await endAndArchiveSession(code, nsp);
    });

    socket.on("share_question", async data => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || user?.role !== "teacher") return;
      try {
        const r = await db.query(
          "SELECT question,option_a,option_b,option_c,option_d,correct_answer,explanation,subject FROM questions WHERE id=$1",
          [data.questionId]
        );
        if (r.rows.length) nsp.to(code).emit("question_shared", r.rows[0]);
      } catch {}
    });

    // ── WEBRTC VIDEO SIGNALING ─────────────────────────────
    // Teacher broadcasts video offer to all students in room
    socket.on("video:offer", ({ sdp, targetSocketId }) => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || !user) return;
      const target = targetSocketId || null;
      if (target) {
        // Direct offer to one peer (student joining late)
        nsp.to(target).emit("video:offer", { sdp, fromSocketId: socket.id, fromName: user.name, fromRole: user.role });
      } else {
        // Broadcast to everyone in session
        socket.to(code).emit("video:offer", { sdp, fromSocketId: socket.id, fromName: user.name, fromRole: user.role });
      }
    });

    socket.on("video:answer", ({ sdp, targetSocketId }) => {
      if (!targetSocketId) return;
      nsp.to(targetSocketId).emit("video:answer", { sdp, fromSocketId: socket.id });
    });

    socket.on("video:ice", ({ candidate, targetSocketId }) => {
      if (!targetSocketId) return;
      nsp.to(targetSocketId).emit("video:ice", { candidate, fromSocketId: socket.id });
    });

    // Student toggles camera/mic — broadcast status to room
    socket.on("video:toggle", ({ video, audio }) => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || !user) return;
      socket.to(code).emit("video:toggle", { socketId: socket.id, userId: user.id, name: user.name, video, audio });
    });

    // Teacher can mute a specific student
    socket.on("video:mute_student", ({ targetSocketId }) => {
      const user = me || socket._me;
      if (user?.role !== "teacher") return;
      nsp.to(targetSocketId).emit("video:force_mute");
    });

    // Student requests to speak (hand raise)
    socket.on("video:raise_hand", ({ raised }) => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || !user) return;
      nsp.to(code).emit("video:hand_raised", { socketId: socket.id, userId: user.id, name: user.name, raised });
    });

    // Screen share — relay offer/answer to room
    socket.on("video:screen_share_start", () => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || !user) return;
      socket.to(code).emit("video:screen_share_started", { socketId: socket.id, name: user.name });
    });

    socket.on("video:screen_share_stop", () => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || !user) return;
      socket.to(code).emit("video:screen_share_stopped", { socketId: socket.id });
    });

    // ── LIVE QUIZ (teacher pushes question, all students answer) ──
    socket.on("quiz:push", async ({ questionId, timeLimit = 30 }, cb) => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || user?.role !== "teacher") return cb?.({ success: false });
      const sess = sessions.get(code);
      if (!sess) return;

      let q = null;
      if (questionId) {
        const r = await db.query(
          "SELECT id,question,option_a,option_b,option_c,option_d,correct_answer,explanation FROM questions WHERE id=$1",
          [questionId]
        ).catch(() => ({ rows: [] }));
        q = r.rows[0] || null;
      }
      if (!q) return cb?.({ success: false, error: "Question not found" });

      sess.activeQuiz = { questionId: q.id, correct: q.correct_answer, answers: {}, timeLimit, startedAt: Date.now() };

      const clientQ = { id: q.id, question: q.question, options: { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d }, timeLimit };
      nsp.to(code).emit("quiz:question", clientQ);
      cb?.({ success: true });

      // Auto-reveal after time limit
      setTimeout(() => {
        if (!sess.activeQuiz || sess.activeQuiz.questionId !== q.id) return;
        const results = Object.entries(sess.activeQuiz.answers).map(([uid, ans]) => ({ uid, ans, correct: (ans || "").toUpperCase() === (q.correct_answer || "").toUpperCase() }));
        nsp.to(code).emit("quiz:reveal", { correctAnswer: q.correct_answer, explanation: q.explanation, results });
        sess.activeQuiz = null;
      }, (timeLimit + 3) * 1000);
    });

    socket.on("quiz:answer", ({ questionId, answer }) => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || !user) return;
      const sess = sessions.get(code);
      if (!sess?.activeQuiz || sess.activeQuiz.questionId !== questionId) return;
      sess.activeQuiz.answers[user.id] = answer;
      // Tell teacher someone answered (not which answer)
      for (const [sid, p] of sess.participants) {
        if (p.role === "teacher") {
          nsp.to(sid).emit("quiz:student_answered", { studentId: user.id, name: user.name, answered: true });
        }
      }
    });

    // ── POLLS ─────────────────────────────────────────────
    socket.on("poll:create", ({ question, options }, cb) => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || user?.role !== "teacher") return cb?.({ success: false });
      const sess = sessions.get(code);
      if (!sess) return;
      const pollId = `poll_${Date.now()}`;
      sess.activePoll = { id: pollId, question, options, votes: Object.fromEntries(options.map((_, i) => [i, 0])), voters: new Set() };
      nsp.to(code).emit("poll:started", { pollId, question, options });
      cb?.({ success: true, pollId });
    });

    socket.on("poll:vote", ({ pollId, optionIndex }) => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || !user) return;
      const sess = sessions.get(code);
      if (!sess?.activePoll || sess.activePoll.id !== pollId) return;
      if (sess.activePoll.voters.has(user.id)) return; // already voted
      sess.activePoll.voters.add(user.id);
      sess.activePoll.votes[optionIndex] = (sess.activePoll.votes[optionIndex] || 0) + 1;
      nsp.to(code).emit("poll:update", { pollId, votes: sess.activePoll.votes, totalVotes: sess.activePoll.voters.size });
    });

    socket.on("poll:end", ({ pollId }) => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code || user?.role !== "teacher") return;
      const sess = sessions.get(code);
      if (!sess?.activePoll) return;
      nsp.to(code).emit("poll:ended", { pollId, finalVotes: sess.activePoll.votes });
      sess.activePoll = null;
    });

    // ── DISCONNECT ────────────────────────────────────────
    socket.on("disconnect", () => {
      const code = sessionCode || socket._sessionCode;
      const user = me || socket._me;
      if (!code) return;

      const sess = sessions.get(code);
      if (!sess) return;

      sess.pendingJoins.delete(socket.id);
      sess.participants.delete(socket.id);

      // Notify peers to close their RTCPeerConnection to this socket
      socket.to(code).emit("video:peer_left", { socketId: socket.id, userId: user?.id });

      if (user?.role === "teacher") {
        socket.to(code).emit("teacher_left", { message: "Teacher disconnected. Session may end soon." });
        // FIX: previously a dropped connection (closed tab, lost wifi,
        // crashed app) meant the class just sat "active" forever in the
        // DB with its board/chat trapped in server memory — never
        // archived, never visitable again once the server eventually
        // restarted. A short grace period lets a genuine reconnect (e.g.
        // a page refresh) resume the same session; if the teacher hasn't
        // come back after that, the class is archived like a normal end.
        setTimeout(() => {
          const stillGone = !Array.from(sessions.get(code)?.participants?.values() || [])
            .some(p => p.role === "teacher");
          if (stillGone && sessions.has(code)) {
            nsp.to(code).emit("session_ended", { message: "The teacher disconnected and the session has ended." });
            endAndArchiveSession(code, nsp);
          }
        }, 60000); // 60s reconnect grace period
      } else if (user) {
        socket.to(code).emit("participant_left", { user, participants: Array.from(sess.participants.values()) });
      }
    });

    socket.on("set_session", () => {
      if (socket._sessionCode) { sessionCode = socket._sessionCode; me = socket._me; }
    });
  });

  console.log("📚 Classroom Engine v3 initialized — Video + Polls + Live Quiz");
}

module.exports = { initClassroom };
