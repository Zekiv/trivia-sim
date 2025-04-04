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
    console.error("Error loading or parsing database.json:", err);
    // Exit if database can't load, essential for the game
    process.exit(1);
}

// Check if database loaded correctly
if (!Array.isArray(triviaDatabase) || triviaDatabase.length === 0) {
    console.error("Database is empty or not loaded correctly. Exiting.");
    process.exit(1);
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
            try {
                client.send(message);
            } catch (error) {
                console.error("Error sending message to client:", error);
            }
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
            // Include type in currentQuestion payload
            currentQuestion: currentQuestion ? { emojis: currentQuestion.emojis, timeLimit: QUESTION_TIME_LIMIT, type: currentQuestion.type } : null,
            playerCount: Object.keys(players).length
        }
    });
};

const sendToClient = (ws, data) => {
    if (ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(data));
        } catch (error) {
            console.error("Error sending message to a specific client:", error);
        }
    }
};

const normalizeAnswer = (answer) => {
    if (!answer) return "";
    // Trim, lowercase, remove leading articles, remove most punctuation, normalize spaces
    return answer.trim().toLowerCase()
        .replace(/^(a|an|the)\s+/i, '')
        .replace(/[^\w\s:&']/gi, '') // Allow letters, numbers, space, :, &, '
        .replace(/\s+/g, ' ');
};

const checkAnswer = (playerAnswer) => {
    if (!currentQuestion) return false;
    return normalizeAnswer(playerAnswer) === normalizeAnswer(currentQuestion.title);
};

const selectNewQuestion = () => {
    if (triviaDatabase.length === 0) {
        console.error("Database is empty! Cannot select question.");
        return null; // Should have exited earlier, but safety check
    }
    if (usedQuestionIndices.size >= triviaDatabase.length) {
        console.log("All questions used, resetting.");
        usedQuestionIndices.clear(); // Reset if all questions have been shown
    }

    let newIndex;
    let attempts = 0;
    const maxAttempts = triviaDatabase.length * 2; // Prevent infinite loop

    do {
        newIndex = Math.floor(Math.random() * triviaDatabase.length);
        attempts++;
        if (attempts > maxAttempts) {
            console.error("Could not find an unused question index after many attempts. Check database/logic.");
            // Fallback: Just pick a random one even if used? Or clear used?
            usedQuestionIndices.clear();
            newIndex = Math.floor(Math.random() * triviaDatabase.length);
            console.warn("Resetting used questions due to selection difficulty.");
            break; // Exit loop
        }
    } while (usedQuestionIndices.has(newIndex));

    usedQuestionIndices.add(newIndex);
    const questionData = triviaDatabase[newIndex];

    // Safety check if questionData is somehow undefined (shouldn't happen with checks)
    if (!questionData) {
        console.error(`Selected index ${newIndex} resulted in undefined questionData.`);
        // Attempt to recover by trying again recursively or returning null
        return selectNewQuestion(); // Try again
    }

    console.log(`Selected question index: ${newIndex}, Title: ${questionData.title}`);
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
        console.error("Failed to select a new question. Waiting.");
        gameState = 'waiting';
        broadcast({ type: 'error', payload: 'Error selecting question. Waiting for admin.' });
        broadcastState();
        return;
    }

    gameState = 'question';
    console.log(`Starting question: ${currentQuestion.title} (${currentQuestion.emojis}) Type: ${currentQuestion.type}`);

    // Reset player round status
    Object.values(players).forEach(p => {
        p.answeredThisRound = false;
        p.correctAnswerForRound = false;
        p.scoreGainedThisRound = 0;
    });

    broadcastState(); // Send the new question (with type) and state

    // Clear previous timeout if any
    if (questionTimeout) clearTimeout(questionTimeout);

    // Set timer for the question
    questionTimeout = setTimeout(startRevealPhase, QUESTION_TIME_LIMIT * 1000);
};

const startRevealPhase = () => {
    gameState = 'reveal';
    console.log(`Revealing answer: ${currentQuestion?.title || 'N/A'}`);

    // Clear the question timeout
    if (questionTimeout) clearTimeout(questionTimeout);
    questionTimeout = null;

    const scoresForRound = Object.values(players)
        .filter(p => p.correctAnswerForRound) // Only show scores for those who answered correctly
        .map(p => ({ nickname: p.nickname, scoreGained: p.scoreGainedThisRound }))
        .sort((a, b) => b.scoreGained - a.scoreGained); // Show highest scores first

    broadcast({
        type: 'revealAnswer',
        payload: {
            correctAnswer: currentQuestion?.title || "N/A",
            scores: scoresForRound
        }
    });

    // Reset round-specific player data stored in memory
    Object.values(players).forEach(p => {
        p.correctAnswerForRound = false; // Reset for next round
        p.scoreGainedThisRound = 0;     // Reset for next round
    });

    broadcastState(); // Update leaderboard after reveal

    // Schedule the next question
    console.log("Scheduling next question in 5 seconds...");
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
            // Include type in currentQuestion payload for initial state
            currentQuestion: currentQuestion ? { emojis: currentQuestion.emojis, timeLimit: QUESTION_TIME_LIMIT, type: currentQuestion.type } : null,
            playerCount: Object.keys(players).length
        }
    });

    ws.on('message', (message) => {
        let parsedMessage;
        try {
            // Added protection for large messages (e.g., prevent simple DoS)
            if (message.length > 1024) {
                 console.warn(`Received overly large message from ${playerId}. Ignoring.`);
                 sendToClient(ws, { type: 'error', payload: 'Message too large.' });
                 return;
            }
            parsedMessage = JSON.parse(message);
            // Don't log sensitive payload data in production if necessary
            console.log(`Received from ${players[playerId]?.nickname || playerId}: Type ${parsedMessage.type}`);

            const player = players[playerId]; // Get player object AFTER parsing

            switch (parsedMessage.type) {
                case 'setNickname':
                    // Ensure payload and nickname exist
                    if (!parsedMessage.payload || typeof parsedMessage.payload.nickname !== 'string') {
                        sendToClient(ws, { type: 'error', payload: 'Invalid nickname data.' });
                        return;
                    }

                    const nickname = parsedMessage.payload.nickname.trim().substring(0, 15); // Limit nickname length
                    if (!nickname || nickname.length < 2) { // Basic validation
                        sendToClient(ws, { type: 'error', payload: 'Nickname must be at least 2 characters.' });
                        return;
                    }
                    // Basic check for uniqueness (case-insensitive)
                    const nicknameLower = nickname.toLowerCase();
                    if (Object.values(players).some(p => p.nickname.toLowerCase() === nicknameLower)) {
                         sendToClient(ws, { type: 'error', payload: 'Nickname already taken.' });
                         return;
                    }
                     // Check if this player ID already has a nickname (prevent changing?)
                     if (player) {
                        console.warn(`Player ${playerId} attempted to change nickname to ${nickname}. Ignored.`);
                        sendToClient(ws, { type: 'error', payload: 'Nickname already set.'});
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
                         console.log("First player joined or enough players present, starting game soon...");
                         // Clear any existing timeout just in case
                         if (questionTimeout) clearTimeout(questionTimeout);
                         // Use a timeout to start, prevents rapid start/stop if players join/leave quickly
                         questionTimeout = setTimeout(startQuestionPhase, 3000); // Start game after a short delay
                    }
                    break;

                case 'submitAnswer':
                    if (!player) {
                        console.warn(`Received answer from unknown or unset player ID: ${playerId}`);
                        return; // Ignore if player hasn't set nickname yet
                    }
                    if (gameState !== 'question' || !currentQuestion || player.answeredThisRound) {
                        // Optionally send feedback: sendToClient(ws, { type: 'error', payload: 'Cannot answer now.' });
                        return; // Ignore answers outside question phase or if already answered
                    }
                     // Ensure payload and answer exist
                    if (!parsedMessage.payload || typeof parsedMessage.payload.answer !== 'string') {
                        console.warn(`Invalid answer payload from ${player.nickname}`);
                        return;
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
                        // Note: State isn't broadcast here, only score changes trigger full broadcast
                    }
                    break;

                case 'chatMessage':
                     if (!player || !player.nickname) {
                        console.warn(`Chat message from player without nickname: ${playerId}`);
                        return; // Ignore chat if nickname not set
                    }
                     // Ensure payload and message exist
                    if (!parsedMessage.payload || typeof parsedMessage.payload.message !== 'string') {
                         console.warn(`Invalid chat payload from ${player.nickname}`);
                        return;
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
                    console.log(`Unknown message type received: ${parsedMessage.type}`);
            }

        } catch (error) {
            console.error(`Failed to process message or invalid JSON: ${message}`, error);
            // Consider sending an error to the client if appropriate
            // sendToClient(ws, { type: 'error', payload: 'Invalid message format.' });
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
             console.log(`Client disconnected: ${playerId} (no nickname set or already removed)`);
        }
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for ${players[playerId]?.nickname || playerId}:`, error);
        // Attempt to remove player on error as well
        const playerOnError = players[playerId];
        if (playerOnError) {
            console.log(`Removing player due to error: ${playerOnError.nickname}`);
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

// Graceful shutdown handling (optional but good practice)
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        // Close WebSocket connections
        wss.clients.forEach(client => {
            client.terminate();
        });
        console.log("WebSocket connections terminated.");
        process.exit(0);
    });
});