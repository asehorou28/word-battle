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

function buildSearchLinks(word) {
  const lower = word.toLowerCase();

  return [
    {
      name: "Wiktionary",
      url: `https://en.wiktionary.org/wiki/${encodeURIComponent(lower)}`
    },
    {
      name: "Cambridge Dictionary",
      url: `https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(lower)}`
    },
    {
      name: "Google Search",
      url: `https://www.google.com/search?q=${encodeURIComponent(lower + " meaning")}`
    }
  ];
}

function normalizeMeaningResult(word, sourceName, meanings, phonetic = "", sourceUrl = "") {
  return {
    word,
    phonetic,
    sourceName,
    sourceUrl,
    searchLinks: buildSearchLinks(word),
    meanings: meanings.slice(0, 5)
  };
}

async function getFromDictionaryApiDev(word) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${word.toLowerCase()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("dictionaryapi.dev not found");
  }

  const data = await response.json();
  const entry = data[0];

  const meanings = [];

  for (const meaning of entry.meanings || []) {
    for (const definitionItem of meaning.definitions || []) {
      if (definitionItem.definition) {
        meanings.push({
          partOfSpeech: meaning.partOfSpeech || "",
          definition: definitionItem.definition,
          example: definitionItem.example || ""
        });
      }

      if (meanings.length >= 5) {
        break;
      }
    }

    if (meanings.length >= 5) {
      break;
    }
  }

  if (meanings.length === 0) {
    throw new Error("dictionaryapi.dev no meanings");
  }

  return normalizeMeaningResult(
    entry.word || word,
    "DictionaryAPI.dev",
    meanings,
    entry.phonetic || "",
    url
  );
}

async function getFromFreeDictionaryApi(word) {
  const url = `https://freedictionaryapi.com/api/v1/entries/en/${word.toLowerCase()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("freedictionaryapi.com not found");
  }

  const data = await response.json();

  const meanings = [];
  const entries = data.entries || [];

  for (const entry of entries) {
    for (const sense of entry.senses || []) {
      if (sense.definition) {
        meanings.push({
          partOfSpeech: entry.partOfSpeech || "",
          definition: sense.definition,
          example: sense.examples?.[0] || ""
        });
      }

      if (meanings.length >= 5) {
        break;
      }
    }

    if (meanings.length >= 5) {
      break;
    }
  }

  if (meanings.length === 0) {
    throw new Error("freedictionaryapi.com no meanings");
  }

  const pronunciationText =
    entries[0]?.pronunciations?.find((p) => p.type === "ipa")?.text ||
    entries[0]?.pronunciations?.[0]?.text ||
    "";

  return normalizeMeaningResult(
    data.word || word,
    "FreeDictionaryAPI.com / Wiktionary",
    meanings,
    pronunciationText,
    data.source?.url || url
  );
}

async function getFromDatamuse(word) {
  const url = `https://api.datamuse.com/words?sp=${encodeURIComponent(word.toLowerCase())}&md=d&max=1`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error("datamuse not found");
  }

  const data = await response.json();
  const item =
    data.find((entry) => entry.word?.toLowerCase() === word.toLowerCase()) ||
    data[0];

  if (!item || !item.defs || item.defs.length === 0) {
    throw new Error("datamuse no meanings");
  }

  const meanings = item.defs.map((def) => {
    const parts = def.split("\t");
    const partOfSpeech = parts[0] || "";
    const definition = parts.slice(1).join(" ") || def;

    return {
      partOfSpeech,
      definition,
      example: ""
    };
  });

  return normalizeMeaningResult(
    item.word || word,
    "Datamuse / Wiktionary / WordNet",
    meanings,
    "",
    url
  );
}

async function getWordMeaning(word) {
  const upperWord = word.toUpperCase();

  if (definitionCache.has(upperWord)) {
    return definitionCache.get(upperWord);
  }

  const providers = [
    getFromDictionaryApiDev,
    getFromFreeDictionaryApi,
    getFromDatamuse
  ];

  for (const provider of providers) {
    try {
      const result = await provider(upperWord);

      if (result && result.meanings && result.meanings.length > 0) {
        definitionCache.set(upperWord, result);
        return result;
      }
    } catch (error) {
      console.log(`意味取得失敗: ${upperWord} / ${error.message}`);
    }
  }

  const fallbackResult = {
    word: upperWord,
    phonetic: "",
    sourceName: "",
    sourceUrl: "",
    meanings: [],
    searchLinks: buildSearchLinks(upperWord)
  };

  definitionCache.set(upperWord, fallbackResult);
  return fallbackResult;
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

  socket.to(currentRoomId).emit("opponentLeft", {
    message: "相手が退出しました。"
  });

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