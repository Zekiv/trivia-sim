// client.js
document.addEventListener('DOMContentLoaded', () => {
    const nicknameSection = document.getElementById('nickname-section');
    const gameSection = document.getElementById('game-section');
    const nicknameInput = document.getElementById('nickname-input');
    const joinButton = document.getElementById('join-button');
    const errorMessage = document.getElementById('error-message');

    const statusMessage = document.getElementById('status-message');
    const playerInfo = document.getElementById('player-info');
    const playerNicknameSpan = document.getElementById('player-nickname');
    const playerScoreSpan = document.getElementById('player-score');
    const playerCountSpan = document.getElementById('player-count-value');

    const questionArea = document.getElementById('question-area');
    const emojisDisplay = document.getElementById('emojis-display');
    const timerDisplay = document.getElementById('timer-display');
    const timerValueSpan = document.getElementById('timer-value');
    const answerInput = document.getElementById('answer-input');
    const submitAnswerButton = document.getElementById('submit-answer-button');
    const answerFeedback = document.getElementById('answer-feedback');

    const revealArea = document.getElementById('reveal-area');
    const correctAnswerDisplay = document.getElementById('correct-answer-display');
    const roundScoresList = document.getElementById('round-scores-list');

    const leaderboardList = document.getElementById('leaderboard-list');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendChatButton = document.getElementById('send-chat-button');

    let ws;
    let myNickname = '';
    let myScore = 0;
    let questionTimerInterval = null;
    let currentQuestionTimeLimit = 0;

    // --- WebSocket Setup ---
    function connectWebSocket() {
        // Use wss:// for secure connections if your server supports HTTPS/WSS
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket connected');
            // Nickname section is shown by default
        };

        ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                console.log('Message from server:', message);
                handleServerMessage(message);
            } catch (error) {
                console.error('Failed to parse message or handle:', error);
            }
        };

        ws.onclose = () => {
            console.log('WebSocket disconnected');
            statusMessage.textContent = 'Disconnected from server. Attempting to reconnect...';
            showError('Connection lost. Please refresh the page or wait for reconnection.');
            clearInterval(questionTimerInterval);
            // Optional: Implement automatic reconnection logic here
            // setTimeout(connectWebSocket, 5000); // Reconnect after 5 seconds
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            showError('WebSocket connection error. Please refresh the page.');
            clearInterval(questionTimerInterval);
        };
    }

    // --- Message Handling ---
    function handleServerMessage(message) {
        const { type, payload } = message;

        switch (type) {
            case 'initialState':
            case 'updateState':
                updateGameDisplay(payload);
                break;
            case 'nicknameAccepted':
                myNickname = payload.nickname;
                playerNicknameSpan.textContent = myNickname;
                playerScoreSpan.textContent = myScore; // Initial score is 0
                nicknameSection.classList.add('hidden');
                gameSection.classList.remove('hidden');
                errorMessage.textContent = '';
                break;
            case 'error':
                showError(payload);
                // If error during nickname phase, keep nickname section visible
                if (!myNickname) {
                     nicknameSection.classList.remove('hidden');
                     gameSection.classList.add('hidden');
                }
                break;
            case 'revealAnswer':
                showRevealPhase(payload);
                break;
            case 'answerResult':
                showAnswerFeedback(payload.correct, payload.scoreGained);
                // Score is updated via broadcastState, no need to update here directly
                submitAnswerButton.disabled = true; // Disable after answering
                answerInput.disabled = true;
                break;
            case 'chatMessage':
                displayChatMessage(payload.nickname, payload.message, payload.isSelf);
                break;
            default:
                console.warn(`Unknown message type: ${type}`);
        }
    }

    // --- UI Update Functions ---
    function updateGameDisplay(state) {
        myScore = state.players.find(p => p.nickname === myNickname)?.score ?? myScore;
        playerScoreSpan.textContent = myScore;
        playerCountSpan.textContent = state.playerCount;

        updateLeaderboard(state.leaderboard);

        switch (state.gameState) {
            case 'waiting':
                statusMessage.textContent = 'Waiting for players...';
                questionArea.classList.add('hidden');
                revealArea.classList.add('hidden');
                emojisDisplay.textContent = '❓❓❓';
                timerValueSpan.textContent = '--';
                clearInterval(questionTimerInterval);
                break;
            case 'question':
                statusMessage.textContent = 'Guess the Emoji!';
                revealArea.classList.add('hidden');
                if (state.currentQuestion) {
                    questionArea.classList.remove('hidden');
                    emojisDisplay.textContent = state.currentQuestion.emojis;
                    startTimer(state.currentQuestion.timeLimit);
                    answerInput.value = '';
                    answerInput.disabled = false;
                    submitAnswerButton.disabled = false;
                    answerFeedback.textContent = '';
                    answerFeedback.className = 'feedback-text'; // Reset classes
                }
                break;
            case 'reveal':
                // Reveal content is handled by 'revealAnswer' message
                statusMessage.textContent = 'Answer Revealed!';
                questionArea.classList.add('hidden'); // Hide question input during reveal
                clearInterval(questionTimerInterval);
                timerValueSpan.textContent = '0';
                break;
        }
    }

    function updateLeaderboard(leaderboard) {
        leaderboardList.innerHTML = ''; // Clear previous list
        if (leaderboard.length === 0) {
            leaderboardList.innerHTML = '<li>No players yet...</li>';
            return;
        }
        leaderboard.forEach(player => {
            const li = document.createElement('li');
            const nameSpan = document.createElement('span');
            nameSpan.textContent = player.nickname;
            const scoreSpan = document.createElement('span');
            scoreSpan.className = 'score';
            scoreSpan.textContent = player.score;
             if (player.nickname === myNickname) {
                 li.style.fontWeight = 'bold'; // Highlight self
                 li.style.backgroundColor = '#eee';
             }
            li.appendChild(nameSpan);
            li.appendChild(scoreSpan);
            leaderboardList.appendChild(li);
        });
    }

    function startTimer(duration) {
        clearInterval(questionTimerInterval);
        let timeLeft = duration;
        currentQuestionTimeLimit = duration; // Store for potential use
        timerValueSpan.textContent = timeLeft;
        timerValueSpan.style.color = ''; // Reset color

        questionTimerInterval = setInterval(() => {
            timeLeft--;
            timerValueSpan.textContent = timeLeft;
            if (timeLeft <= 5) {
                timerValueSpan.style.color = '#d32f2f'; // Turn red when low
            }
            if (timeLeft <= 0) {
                clearInterval(questionTimerInterval);
                timerValueSpan.textContent = '0';
                // Server will handle timeout and move to reveal phase
                answerInput.disabled = true;
                submitAnswerButton.disabled = true;
                 answerFeedback.textContent = "Time's up!";
                 answerFeedback.className = 'feedback-text feedback-incorrect';
            }
        }, 1000);
    }

     function showRevealPhase(payload) {
        questionArea.classList.add('hidden');
        revealArea.classList.remove('hidden');
        correctAnswerDisplay.textContent = payload.correctAnswer;

        roundScoresList.innerHTML = ''; // Clear previous scores
        if (payload.scores && payload.scores.length > 0) {
            payload.scores.forEach(scoreInfo => {
                 const li = document.createElement('li');
                 li.textContent = `${scoreInfo.nickname}: +${scoreInfo.scoreGained} points`;
                 roundScoresList.appendChild(li);
            });
        } else {
             const li = document.createElement('li');
             li.textContent = 'No correct answers this round.';
             roundScoresList.appendChild(li);
        }
         // Hide reveal area after a delay - server will trigger next question state update
         // setTimeout(() => { revealArea.classList.add('hidden'); }, 4500); // Keep visible briefly before next q
    }

    function showAnswerFeedback(correct, scoreGained) {
        if (correct) {
            answerFeedback.textContent = `Correct! +${scoreGained} points!`;
            answerFeedback.className = 'feedback-text feedback-correct';
        } else {
            answerFeedback.textContent = 'Incorrect answer.';
            answerFeedback.className = 'feedback-text feedback-incorrect';
        }
    }

    function displayChatMessage(nickname, message, isSelf = false) {
        const messageElement = document.createElement('p');
        const nickSpan = document.createElement('span');
        nickSpan.className = 'chat-nickname';
        nickSpan.textContent = `${nickname}: `;
        messageElement.appendChild(nickSpan);
        messageElement.appendChild(document.createTextNode(message));

         if (isSelf) {
             messageElement.classList.add('chat-self'); // Add class for potential self-styling
         }

        chatMessages.appendChild(messageElement);
        // Scroll to the bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }


    function showError(message) {
        errorMessage.textContent = message;
        // Maybe show errors in a more prominent way if needed
    }

     // --- Event Listeners ---
    joinButton.addEventListener('click', () => {
        const nickname = nicknameInput.value.trim();
        if (nickname && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'setNickname', payload: { nickname: nickname } }));
            errorMessage.textContent = ''; // Clear previous errors
        } else if (!nickname) {
             showError('Please enter a nickname.');
        } else {
            showError('Not connected to server.');
        }
    });

    nicknameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            joinButton.click();
        }
    });

    submitAnswerButton.addEventListener('click', () => {
        const answer = answerInput.value.trim();
        if (answer && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'submitAnswer', payload: { answer: answer } }));
             // UI feedback handled by server response ('answerResult')
             // Disable button immediately to prevent double submission? Server side handles this mostly.
            // submitAnswerButton.disabled = true;
        }
    });

    answerInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !submitAnswerButton.disabled) {
             submitAnswerButton.click();
        }
    });

    sendChatButton.addEventListener('click', () => {
        const message = chatInput.value.trim();
        if (message && ws && ws.readyState === WebSocket.OPEN) {
             ws.send(JSON.stringify({ type: 'chatMessage', payload: { message: message } }));
             chatInput.value = ''; // Clear input after sending
        }
    });

    chatInput.addEventListener('keypress', (e) => {
         if (e.key === 'Enter') {
             sendChatButton.click();
         }
     });


    // --- Initialization ---
    connectWebSocket();

}); // End DOMContentLoaded