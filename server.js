const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const words = ["APPLE", "GRAPE", "LEMON", "MELON", "PEACH", "BRAIN", "MOUSE"];

const rooms = {};

function createRoomId() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function chooseAnswer() {
  return words[Math.floor(Math.random() * words.length)];
}

function judgeGuess(answer, guess) {
  const result = Array(5).fill("gray");
  const answerChars = answer.split("");
  const guessChars = guess.split("");

  for (let i = 0; i < 5; i++) {
    if (guessChars[i] === answerChars[i]) {
      result[i] = "green";
      answerChars[i] = null;
      guessChars[i] = null;
    }
  }

  for (let i = 0; i < 5; i++) {
    if (guessChars[i] === null) continue;

    const index = answerChars.indexOf(guessChars[i]);
    if (index !== -1) {
      result[i] = "yellow";
      answerChars[index] = null;
    }
  }

  return result;
}

io.on("connection", (socket) => {
  console.log("接続:", socket.id);

  socket.on("createRoom", () => {
    let roomId = createRoomId();

    while (rooms[roomId]) {
      roomId = createRoomId();
    }

    rooms[roomId] = {
      players: [socket.id],
      answer: chooseAnswer(),
      guesses: {
        [socket.id]: []
      },
      status: "waiting",
      winner: null
    };

    socket.join(roomId);

    socket.emit("roomCreated", {
      roomId
    });

    console.log(`部屋作成: ${roomId}`);
  });

  socket.on("joinRoom", ({ roomId }) => {
    roomId = roomId.toUpperCase();

    const room = rooms[roomId];

    if (!room) {
      socket.emit("errorMessage", "その部屋は存在しません。");
      return;
    }

    if (room.players.length >= 2) {
      socket.emit("errorMessage", "その部屋は満員です。");
      return;
    }

    room.players.push(socket.id);
    room.guesses[socket.id] = [];
    room.status = "playing";

    socket.join(roomId);

    io.to(roomId).emit("gameStart", {
      roomId,
      message: "2人そろいました。ゲーム開始です。"
    });

    console.log(`部屋参加: ${roomId}`);
  });

  socket.on("submitGuess", ({ roomId, guess }) => {
    roomId = roomId.toUpperCase();
    guess = guess.toUpperCase();

    const room = rooms[roomId];

    if (!room) {
      socket.emit("errorMessage", "部屋が見つかりません。");
      return;
    }

    if (room.status !== "playing") {
      socket.emit("errorMessage", "まだゲームは開始していません。");
      return;
    }

    if (guess.length !== 5) {
      socket.emit("errorMessage", "5文字で入力してください。");
      return;
    }

    if (room.guesses[socket.id].length >= 6) {
  socket.emit("errorMessage", "もう6回入力済みです。");
  return;
}

    const result = judgeGuess(room.answer, guess);

    room.guesses[socket.id].push({
      guess,
      result
    });

    socket.emit("guessResult", {
      guess,
      result
    });

    socket.to(roomId).emit("opponentProgress", {
      guessCount: room.guesses[socket.id].length
    });

    if (guess === room.answer) {
      room.status = "finished";
      room.winner = socket.id;

      io.to(roomId).emit("gameOver", {
        winner: socket.id,
        answer: room.answer
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("切断:", socket.id);

    for (const roomId in rooms) {
      const room = rooms[roomId];

      if (room.players.includes(socket.id)) {
        room.players = room.players.filter((id) => id !== socket.id);
        delete room.guesses[socket.id];

        socket.to(roomId).emit("errorMessage", "相手が退出しました。");

        if (room.players.length === 0) {
          delete rooms[roomId];
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
});