const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const rooms = {};
const definitionCache = new Map();

let allowedWords = [];
let allowedWordSet = new Set();
let answerWords = [];

async function loadWords() {
  const { default: wordListPath } = await import("word-list");

  const text = fs.readFileSync(wordListPath, "utf8");

  allowedWords = text
    .split(/\r?\n/)
    .map((word) => word.trim().toUpperCase())
    .filter((word) => /^[A-Z]{5}$/.test(word));

  allowedWordSet = new Set(allowedWords);

  // 答えも入力許可単語も、辞書内の5文字英単語すべてにする
  answerWords = allowedWords;

  console.log(`入力許可単語を ${allowedWords.length} 個読み込みました。`);
  console.log(`答え用単語を ${answerWords.length} 個用意しました。`);
}

function createRoomId() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function chooseAnswer() {
  return answerWords[Math.floor(Math.random() * answerWords.length)];
}

function sanitizeName(name) {
  if (!name || typeof name !== "string") {
    return "Player";
  }

  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return "Player";
  }

  return trimmed.substring(0, 12);
}

function judgeGuess(answer, guess) {
  const result = Array(5).fill("gray");
  const answerChars = answer.split("");
  const guessChars = guess.split("");

  // まず、文字と位置が両方合っているものを green にする
  for (let i = 0; i < 5; i++) {
    if (guessChars[i] === answerChars[i]) {
      result[i] = "green";
      answerChars[i] = null;
      guessChars[i] = null;
    }
  }

  // 次に、文字はあるが位置が違うものを yellow にする
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

async function getWordMeaning(word) {
  if (definitionCache.has(word)) {
    return definitionCache.get(word);
  }

  try {
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${word.toLowerCase()}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error("definition not found");
    }

    const data = await response.json();
    const entry = data[0];

    const meanings = [];

    for (const meaning of entry.meanings || []) {
      const firstDefinition = meaning.definitions?.[0];

      if (firstDefinition?.definition) {
        meanings.push({
          partOfSpeech: meaning.partOfSpeech || "",
          definition: firstDefinition.definition,
          example: firstDefinition.example || ""
        });
      }

      if (meanings.length >= 3) {
        break;
      }
    }

    const result = {
      word: entry.word || word,
      phonetic: entry.phonetic || "",
      meanings
    };

    definitionCache.set(word, result);
    return result;
  } catch (error) {
    console.log(`意味の取得に失敗: ${word}`);

    const result = {
      word,
      phonetic: "",
      meanings: []
    };

    definitionCache.set(word, result);
    return result;
  }
}

function getPlayer(room, socketId) {
  return room.players.find((player) => player.id === socketId);
}

function getOpponent(room, socketId) {
  return room.players.find((player) => player.id !== socketId);
}

function getPublicPlayers(room) {
  return room.players.map((player) => ({
    id: player.id,
    name: player.name
  }));
}

function resetRoomForRematch(room) {
  room.answer = chooseAnswer();
  room.status = "playing";
  room.winner = null;
  room.definition = null;
  room.rematchRequests = [];

  room.guesses = {};

  for (const player of room.players) {
    player.finished = false;
    player.solved = false;
    player.attempts = 0;
    room.guesses[player.id] = [];
  }
}

async function finishGame(roomId, winnerId) {
  const room = rooms[roomId];

  if (!room || room.status === "finished") {
    return;
  }

  room.status = "finished";
  room.winner = winnerId;
  room.definition = await getWordMeaning(room.answer);

  io.to(roomId).emit("gameOver", {
    winnerId,
    answer: room.answer,
    definition: room.definition
  });
}

async function checkGameEnd(roomId) {
  const room = rooms[roomId];

  if (!room || room.status !== "playing") {
    return;
  }

  const solvedPlayer = room.players.find((player) => player.solved);

  if (solvedPlayer) {
    await finishGame(roomId, solvedPlayer.id);
    return;
  }

  const everyoneFinished =
    room.players.length === 2 &&
    room.players.every((player) => player.finished);

  if (everyoneFinished) {
    await finishGame(roomId, null);
  }
}

function leaveCurrentRoom(socket) {
  const currentRoomId = socket.data.roomId;

  if (!currentRoomId) {
    return;
  }

  const room = rooms[currentRoomId];

  if (!room) {
    socket.data.roomId = null;
    return;
  }

  room.players = room.players.filter((player) => player.id !== socket.id);
  delete room.guesses[socket.id];

  socket.leave(currentRoomId);

  socket.to(currentRoomId).emit("errorMessage", "相手が退出しました。");

  if (room.players.length === 0) {
    delete rooms[currentRoomId];
  } else {
    room.status = "waiting";
    room.rematchRequests = [];
  }

  socket.data.roomId = null;
}

io.on("connection", (socket) => {
  console.log("接続:", socket.id);

  socket.on("createRoom", ({ playerName } = {}) => {
    leaveCurrentRoom(socket);

    let roomId = createRoomId();

    while (rooms[roomId]) {
      roomId = createRoomId();
    }

    const name = sanitizeName(playerName);

    rooms[roomId] = {
      players: [
        {
          id: socket.id,
          name,
          finished: false,
          solved: false,
          attempts: 0
        }
      ],
      answer: chooseAnswer(),
      guesses: {
        [socket.id]: []
      },
      status: "waiting",
      winner: null,
      definition: null,
      rematchRequests: []
    };

    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit("roomCreated", {
      roomId,
      playerName: name,
      players: getPublicPlayers(rooms[roomId])
    });

    console.log(`部屋作成: ${roomId}`);
    console.log(`答え: ${rooms[roomId].answer}`);
  });

  socket.on("joinRoom", ({ roomId, playerName } = {}) => {
    if (!roomId) {
      socket.emit("errorMessage", "部屋IDを入力してください。");
      return;
    }

    roomId = roomId.trim().toUpperCase();

    const room = rooms[roomId];

    if (!room) {
      socket.emit("errorMessage", "その部屋は存在しません。");
      return;
    }

    if (room.players.some((player) => player.id === socket.id)) {
      socket.emit("errorMessage", "すでにこの部屋に入っています。");
      return;
    }

    if (room.players.length >= 2) {
      socket.emit("errorMessage", "その部屋は満員です。");
      return;
    }

    leaveCurrentRoom(socket);

    const name = sanitizeName(playerName);

    room.players.push({
      id: socket.id,
      name,
      finished: false,
      solved: false,
      attempts: 0
    });

    room.guesses[socket.id] = [];
    room.status = "playing";

    socket.join(roomId);
    socket.data.roomId = roomId;

    io.to(roomId).emit("gameStart", {
      roomId,
      players: getPublicPlayers(room),
      message: "2人そろいました。ゲーム開始です。"
    });

    console.log(`部屋参加: ${roomId}`);
    console.log(`現在の人数: ${room.players.length}`);
  });

  socket.on("submitGuess", async ({ roomId, guess } = {}) => {
    if (!roomId || !guess) {
      socket.emit("errorMessage", "入力内容が不足しています。");
      return;
    }

    roomId = roomId.trim().toUpperCase();
    guess = guess.trim().toUpperCase();

    const room = rooms[roomId];

    if (!room) {
      socket.emit("errorMessage", "部屋が見つかりません。");
      return;
    }

    const player = getPlayer(room, socket.id);

    if (!player) {
      socket.emit("errorMessage", "この部屋のプレイヤーではありません。");
      return;
    }

    if (room.status !== "playing") {
      socket.emit("errorMessage", "現在は入力できません。");
      return;
    }

    if (player.finished) {
      socket.emit("errorMessage", "あなたはこのラウンドの入力を終了しています。");
      return;
    }

    if (guess.length !== 5) {
      socket.emit("errorMessage", "5文字で入力してください。");
      return;
    }

    if (!allowedWordSet.has(guess)) {
      socket.emit("errorMessage", "辞書にない英単語です。");
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

    player.attempts = room.guesses[socket.id].length;

    socket.emit("guessResult", {
      guess,
      result,
      guessCount: player.attempts
    });

    socket.to(roomId).emit("opponentGuess", {
      result,
      guessCount: player.attempts,
      playerName: player.name
    });

    if (guess === room.answer) {
      player.solved = true;
      player.finished = true;
      await checkGameEnd(roomId);
      return;
    }

    if (player.attempts >= 6) {
      player.finished = true;

      socket.emit("playerFinished", {
        message: "6回使い切りました。相手の結果を待っています。"
      });

      const opponent = getOpponent(room, socket.id);

      if (opponent) {
        socket.to(roomId).emit("opponentFinished", {
          playerName: player.name
        });
      }

      await checkGameEnd(roomId);
    }
  });

  socket.on("requestRematch", ({ roomId } = {}) => {
    if (!roomId) {
      return;
    }

    roomId = roomId.trim().toUpperCase();

    const room = rooms[roomId];

    if (!room) {
      socket.emit("errorMessage", "部屋が見つかりません。");
      return;
    }

    if (room.status !== "finished") {
      socket.emit("errorMessage", "まだ再戦できません。");
      return;
    }

    if (!room.players.some((player) => player.id === socket.id)) {
      socket.emit("errorMessage", "この部屋のプレイヤーではありません。");
      return;
    }

    if (!room.rematchRequests.includes(socket.id)) {
      room.rematchRequests.push(socket.id);
    }

    io.to(roomId).emit("rematchStatus", {
      count: room.rematchRequests.length
    });

    if (room.players.length === 2 && room.rematchRequests.length === 2) {
      resetRoomForRematch(room);

      io.to(roomId).emit("rematchStarted", {
        roomId,
        players: getPublicPlayers(room),
        message: "再戦開始です。"
      });

      console.log(`再戦開始: ${roomId}`);
      console.log(`答え: ${room.answer}`);
    }
  });

  socket.on("disconnect", () => {
    console.log("切断:", socket.id);
    leaveCurrentRoom(socket);
  });
});

loadWords().then(() => {
  server.listen(PORT, () => {
    console.log(`サーバー起動: http://localhost:${PORT}`);
  });
});