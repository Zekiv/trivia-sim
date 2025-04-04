// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const QUESTION_TIME_LIMIT = 20; // seconds
const POINTS_CORRECT = 100;
const POINTS_TIME_BONUS_MULTIPLIER = 5; // Points per remaining second

// --- Database ---
let triviaDatabase = [];
try {
    const data = fs.readFileSync(path.join(__dirname, 'database.json'), 'utf8');
    triviaDatabase = JSON.parse(data);
    console.log(`Loaded ${triviaDatabase.length} trivia items.`);
} catch (err) {
    console.error("Error loading database.json:", err);
    process.exit(1); // Exit if database can't load
}

// --- Game State ---
let players = {}; // Store player data { ws: WebSocket, id: string, nickname: string, score: number, answeredThisRound: boolean }
let currentQuestion = null; // { index: number, title: string, emojis: string, type: string, startTime: number }
let questionTimeout = null;
let gameState = 'waiting'; // 'waiting', 'question', 'reveal'
let usedQuestionIndices = new Set();

// --- Helper Functions ---
const generateUniqueId = () => '_' + Math.random().toString(36).substr(2, 9);

const broadcast = (data, senderWs = null) => {
    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client !== senderWs) {
            client.send(message);
        }
    });
};

const broadcastState = () => {
    const leaderboard = Object.values(players)
        .sort((a, b) => b.score - a.score)
        .map(p => ({ nickname: p.nickname, score: p.score }));

    broadcast({
        type: 'updateState',
        payload: {
            players: Object.values(players).map(p => ({ nickname: p.nickname, score: p.score })),
            leaderboard: leaderboard,
            gameState: gameState,
            // Only send question emojis, not the answer
            currentQuestion: currentQuestion ? { emojis: currentQuestion.emojis, timeLimit: QUESTION_TIME_LIMIT } : null,
            playerCount: Object.keys(players).length
        }
    });
};

const sendToClient = (ws, data) => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
};

const normalizeAnswer = (answer) => {
    if (!answer) return "";
    return answer.trim().toLowerCase()
        .replace(/^(a|an|the)\s+/i, '') // Remove leading articles
        .replace(/[^\w\s]/gi, '') // Remove punctuation
        .replace(/\s+/g, ' '); // Normalize whitespace
};

const checkAnswer = (playerAnswer) => {
    if (!currentQuestion) return false;
    return normalizeAnswer(playerAnswer) === normalizeAnswer(currentQuestion.title);
};

const selectNewQuestion = () => {
    if (usedQuestionIndices.size >= triviaDatabase.length) {
        console.log("All questions used, resetting.");
        usedQuestionIndices.clear(); // Reset if all questions have been shown
    }
    if (triviaDatabase.length === 0) {
        console.error("Database is empty!");
        return null;
    }

    let newIndex;
    do {
        newIndex = Math.floor(Math.random() * triviaDatabase.length);
    } while (usedQuestionIndices.has(newIndex));

    usedQuestionIndices.add(newIndex);
    const questionData = triviaDatabase[newIndex];
    return {
        index: newIndex,
        title: questionData.title,
        emojis: questionData.emojis,
        type: questionData.type,
        startTime: Date.now()
    };
};

const startQuestionPhase = () => {
    if (Object.keys(players).length < 1) { // Require at least 1 player to start
        console.log("Not enough players to start a round. Waiting...");
        gameState = 'waiting';
        broadcastState();
        return;
    }

    currentQuestion = selectNewQuestion();
    if (!currentQuestion) {
        // Handle case where no questions are available (shouldn't happen with reset logic)
        gameState = 'waiting';
        broadcast({ type: 'error', payload: 'No more questions available!' });
        broadcastState();
        return;
    }

    gameState = 'question';
    console.log(`Starting question: ${currentQuestion.title} (${currentQuestion.emojis})`);

    // Reset player round status
    Object.values(players).forEach(p => p.answeredThisRound = false);

    broadcastState(); // Send the new question emojis and state

    // Clear previous timeout if any
    if (questionTimeout) clearTimeout(questionTimeout);

    // Set timer for the question
    questionTimeout = setTimeout(startRevealPhase, QUESTION_TIME_LIMIT * 1000);
};

const startRevealPhase = () => {
    gameState = 'reveal';
    console.log(`Revealing answer: ${currentQuestion?.title}`);

    // Clear the question timeout
    if (questionTimeout) clearTimeout(questionTimeout);
    questionTimeout = null;

    const scoresForRound = Object.values(players)
        .filter(p => p.correctAnswerForRound) // Only show scores for those who answered correctly
        .map(p => ({ nickname: p.nickname, scoreGained: p.scoreGainedThisRound }));

    broadcast({
        type: 'revealAnswer',
        payload: {
            correctAnswer: currentQuestion?.title || "N/A",
            scores: scoresForRound
        }
    });

    // Reset round-specific player data
    Object.values(players).forEach(p => {
        p.correctAnswerForRound = false;
        p.scoreGainedThisRound = 0;
    });

    broadcastState(); // Update leaderboard after reveal

    // Schedule the next question
    setTimeout(startQuestionPhase, 5000); // Wait 5 seconds before next question
};

// --- WebSocket Connection Handling ---
wss.on('connection', (ws) => {
    const playerId = generateUniqueId();
    console.log(`Client connected: ${playerId}`);

    // Send initial state to the newly connected client
    const leaderboard = Object.values(players)
        .sort((a, b) => b.score - a.score)
        .map(p => ({ nickname: p.nickname, score: p.score }));

    sendToClient(ws, {
        type: 'initialState',
        payload: {
            playerId: playerId,
            players: Object.values(players).map(p => ({ nickname: p.nickname, score: p.score })),
            leaderboard: leaderboard,
            gameState: gameState,
            currentQuestion: currentQuestion ? { emojis: currentQuestion.emojis, timeLimit: QUESTION_TIME_LIMIT } : null,
            playerCount: Object.keys(players).length
        }
    });

    ws.on('message', (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message);
            console.log(`Received from ${players[playerId]?.nickname || playerId}:`, parsedMessage);

            const player = players[playerId]; // Get player object AFTER parsing

            switch (parsedMessage.type) {
                case 'setNickname':
                    const nickname = parsedMessage.payload.nickname.trim().substring(0, 15); // Limit nickname length
                    if (!nickname) {
                        sendToClient(ws, { type: 'error', payload: 'Nickname cannot be empty.' });
                        return;
                    }
                    // Basic check for uniqueness (case-insensitive)
                    const nicknameLower = nickname.toLowerCase();
                    if (Object.values(players).some(p => p.nickname.toLowerCase() === nicknameLower)) {
                         sendToClient(ws, { type: 'error', payload: 'Nickname already taken.' });
                         return;
                    }

                    players[playerId] = {
                        ws: ws,
                        id: playerId,
                        nickname: nickname,
                        score: 0,
                        answeredThisRound: false,
                        correctAnswerForRound: false,
                        scoreGainedThisRound: 0
                    };
                    console.log(`Player ${playerId} set nickname to ${nickname}`);
                    sendToClient(ws, { type: 'nicknameAccepted', payload: { nickname: nickname } });
                    broadcastState(); // Update everyone with the new player list

                    // If waiting and now have enough players, start the game
                    if (gameState === 'waiting' && Object.keys(players).length >= 1) {
                         console.log("First player joined, starting game soon...");
                         setTimeout(startQuestionPhase, 3000); // Start game after a short delay
                    }
                    break;

                case 'submitAnswer':
                    if (!player) {
                        console.warn(`Received answer from unknown player ID: ${playerId}`);
                        return;
                    }
                    if (gameState !== 'question' || !currentQuestion || player.answeredThisRound) {
                        return; // Ignore answers outside question phase or if already answered
                    }

                    const answer = parsedMessage.payload.answer;
                    player.answeredThisRound = true;
                    player.correctAnswerForRound = false; // Default
                    player.scoreGainedThisRound = 0;

                    if (checkAnswer(answer)) {
                        const timeTaken = (Date.now() - currentQuestion.startTime) / 1000;
                        const remainingTime = Math.max(0, QUESTION_TIME_LIMIT - timeTaken);
                        const timeBonus = Math.floor(remainingTime * POINTS_TIME_BONUS_MULTIPLIER);
                        const scoreGained = POINTS_CORRECT + timeBonus;

                        player.score += scoreGained;
                        player.correctAnswerForRound = true;
                        player.scoreGainedThisRound = scoreGained;

                        console.log(`${player.nickname} answered correctly! +${scoreGained} points`);
                        sendToClient(ws, { type: 'answerResult', payload: { correct: true, scoreGained: scoreGained } });
                        broadcastState(); // Update scores immediately for everyone
                    } else {
                        console.log(`${player.nickname} answered incorrectly.`);
                        sendToClient(ws, { type: 'answerResult', payload: { correct: false, scoreGained: 0 } });
                    }
                    break;

                case 'chatMessage':
                     if (!player || !player.nickname) {
                        console.warn(`Chat message from player without nickname: ${playerId}`);
                        return; // Ignore chat if nickname not set
                    }
                    const messageText = parsedMessage.payload.message.trim().substring(0, 100); // Limit message length
                    if (messageText) {
                        broadcast({
                            type: 'chatMessage',
                            payload: { nickname: player.nickname, message: messageText }
                        }, /* senderWs */ ws); // Send to others, not back to sender
                        // Send back to sender too, so their own message appears
                        sendToClient(ws, {
                             type: 'chatMessage',
                             payload: { nickname: player.nickname, message: messageText, isSelf: true }
                         });
                    }
                    break;

                default:
                    console.log(`Unknown message type: ${parsedMessage.type}`);
            }

        } catch (error) {
            console.error(`Failed to process message or invalid JSON: ${message}`, error);
        }
    });

    ws.on('close', () => {
        const player = players[playerId];
        if (player) {
            console.log(`Client disconnected: ${player.nickname} (${playerId})`);
            delete players[playerId];
            broadcastState(); // Update everyone about the disconnected player

            if (Object.keys(players).length === 0 && gameState !== 'waiting') {
                console.log("Last player left. Returning to waiting state.");
                gameState = 'waiting';
                if (questionTimeout) clearTimeout(questionTimeout);
                questionTimeout = null;
                currentQuestion = null;
                usedQuestionIndices.clear();
                broadcastState();
            }
        } else {
             console.log(`Client disconnected: ${playerId} (no nickname set)`);
        }
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${players[playerId]?.nickname || playerId}:`, error);
        // Attempt to remove player on error as well
        if (players[playerId]) {
            delete players[playerId];
            broadcastState();
             if (Object.keys(players).length === 0 && gameState !== 'waiting') {
                console.log("Last player left after error. Returning to waiting state.");
                gameState = 'waiting';
                if (questionTimeout) clearTimeout(questionTimeout);
                questionTimeout = null;
                currentQuestion = null;
                usedQuestionIndices.clear();
                broadcastState();
            }
        }
    });
});

// --- Serve Static Files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Server started on http://localhost:${PORT}`);
    // Initial state setup
    gameState = 'waiting';
    currentQuestion = null;
    usedQuestionIndices.clear();
});