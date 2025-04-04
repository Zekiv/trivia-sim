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
    // Get reference to the heading
    const questionTitleHeading = document.getElementById('question-title-heading');
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
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;
    const RECONNECT_DELAY = 5000; // 5 seconds

    // --- WebSocket Setup ---
    function connectWebSocket() {
        clearError(); // Clear previous errors on new attempt
        statusMessage.textContent = 'Connecting to server...';
        // Use wss:// for secure connections if your server supports HTTPS/WSS
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${wsProtocol}//${window.location.host}`;
        console.log(`Attempting to connect to: ${wsUrl}`);
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket connected');
            statusMessage.textContent = 'Connected! Waiting for nickname...';
            reconnectAttempts = 0; // Reset attempts on successful connection
            // If nickname already set (e.g., reconnection), re-send it? Or rely on server remembering?
            // Server currently doesn't remember across disconnects, so show nickname prompt
            showNicknamePrompt(); // Ensure nickname prompt is shown if needed
        };

        ws.onmessage = (event) => {
            try {
                // Added basic protection against overly large messages on client
                 if (event.data.length > 10 * 1024) { // Limit message size (e.g., 10KB)
                    console.warn("Received overly large message from server. Ignoring.");
                    return;
                }
                const message = JSON.parse(event.data);
                // console.log('Message from server:', message); // Reduce logging noise
                handleServerMessage(message);
            } catch (error) {
                console.error('Failed to parse message or handle:', error, event.data);
            }
        };

        ws.onclose = (event) => {
            console.log('WebSocket disconnected:', event.code, event.reason);
            clearInterval(questionTimerInterval);
            statusMessage.textContent = 'Disconnected from server.';
             // Hide game, show nickname prompt on disconnect maybe? Or try reconnecting first.
            gameSection.classList.add('hidden');
            nicknameSection.classList.remove('hidden'); // Force re-enter nickname on disconnect
            myNickname = ''; // Reset nickname state
            myScore = 0; // Reset score state


            if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                reconnectAttempts++;
                statusMessage.textContent = `Disconnected. Attempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`;
                console.log(`Attempting reconnect #${reconnectAttempts} in ${RECONNECT_DELAY / 1000}s`);
                setTimeout(connectWebSocket, RECONNECT_DELAY);
            } else {
                 statusMessage.textContent = 'Disconnected. Could not reconnect.';
                 showError('Connection lost permanently. Please refresh the page.');
                 joinButton.disabled = true; // Prevent trying to join after failed reconnects
            }
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            // The onclose event will usually fire after an error, handling the reconnect logic.
            // However, we can show an immediate error message.
            showError('WebSocket connection error.');
            clearInterval(questionTimerInterval);
             // Consider triggering close logic if it doesn't fire automatically
            // if (ws.readyState !== WebSocket.CLOSED) {
            //     ws.close();
            // }
        };
    }

     function showNicknamePrompt() {
        nicknameSection.classList.remove('hidden');
        gameSection.classList.add('hidden');
        nicknameInput.value = ''; // Clear input
        nicknameInput.focus();
        joinButton.disabled = false; // Ensure join button is enabled
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
                playerScoreSpan.textContent = 0; // Start score at 0
                myScore = 0;
                nicknameSection.classList.add('hidden');
                gameSection.classList.remove('hidden');
                errorMessage.textContent = '';
                statusMessage.textContent = 'Waiting for game to start...';
                break;
            case 'error':
                showError(payload);
                // If error during nickname phase, keep nickname section visible
                if (!myNickname) {
                     nicknameSection.classList.remove('hidden');
                     gameSection.classList.add('hidden');
                     joinButton.disabled = false; // Re-enable button
                }
                break;
            case 'revealAnswer':
                showRevealPhase(payload);
                break;
            case 'answerResult':
                showAnswerFeedback(payload.correct, payload.scoreGained);
                // Score is updated via broadcastState, but update local state too for immediate feel?
                if (payload.correct) {
                    myScore += payload.scoreGained; // Update local score immediately
                    playerScoreSpan.textContent = myScore;
                }
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
        // Update own score display IF nickname is set
        if (myNickname) {
            const myPlayerData = state.players.find(p => p.nickname === myNickname);
            myScore = myPlayerData ? myPlayerData.score : myScore; // Update score from server state if found
            playerScoreSpan.textContent = myScore;
        }
         playerCountSpan.textContent = state.playerCount;

        updateLeaderboard(state.leaderboard);

        switch (state.gameState) {
            case 'waiting':
                statusMessage.textContent = state.playerCount > 0 ? 'Waiting for more players or game start...' : 'Waiting for players...';
                questionArea.classList.add('hidden');
                revealArea.classList.add('hidden');
                emojisDisplay.textContent = '❓❓❓';
                timerValueSpan.textContent = '--';
                clearInterval(questionTimerInterval);
                questionTitleHeading.textContent = 'Waiting for Question...'; // Reset heading
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
                    answerInput.focus(); // Focus input field
                    submitAnswerButton.disabled = false;
                    answerFeedback.textContent = '';
                    answerFeedback.className = 'feedback-text'; // Reset classes

                    // Update heading based on type
                    if (state.currentQuestion.type === 'movie') {
                        questionTitleHeading.textContent = 'Guess the Movie:';
                    } else if (state.currentQuestion.type === 'tv') {
                        questionTitleHeading.textContent = 'Guess the TV Show:';
                    } else {
                        questionTitleHeading.textContent = 'Guess the Title:'; // Fallback
                    }
                }
                break;
            case 'reveal':
                // Reveal content is handled by 'revealAnswer' message
                statusMessage.textContent = 'Answer Revealed!';
                questionArea.classList.add('hidden'); // Hide question input during reveal
                clearInterval(questionTimerInterval);
                timerValueSpan.textContent = '0';
                timerValueSpan.style.color = ''; // Reset timer color
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
            if (timeLeft <= 5 && timeLeft > 0) {
                timerValueSpan.style.color = '#d84315'; // Turn orange/red when low
            }
            if (timeLeft <= 0) {
                clearInterval(questionTimerInterval);
                timerValueSpan.textContent = '0';
                // Server will handle timeout and move to reveal phase
                if (!answerInput.disabled) { // Only show "Time's up!" if they haven't answered
                    answerInput.disabled = true;
                    submitAnswerButton.disabled = true;
                    answerFeedback.textContent = "Time's up!";
                    answerFeedback.className = 'feedback-text feedback-incorrect';
                }
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
         // Server state update will eventually hide this area when gameState changes
         // No need for client-side timeout to hide it anymore
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

        // Very basic sanitization - replace < and > to prevent HTML injection
        const sanitizedMessage = message.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        messageElement.appendChild(document.createTextNode(sanitizedMessage));


         if (isSelf) {
             messageElement.classList.add('chat-self'); // Add class for potential self-styling
         }

        chatMessages.appendChild(messageElement);
        // Scroll to the bottom only if user is already near the bottom
        const isScrolledToBottom = chatMessages.scrollHeight - chatMessages.clientHeight <= chatMessages.scrollTop + 1;
        if(isScrolledToBottom) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }

    function showError(message) {
        errorMessage.textContent = message;
        // Fade out error message after a few seconds?
        setTimeout(clearError, 5000);
    }
    function clearError() {
         errorMessage.textContent = '';
    }


     // --- Event Listeners ---
    joinButton.addEventListener('click', () => {
        const nickname = nicknameInput.value.trim();
        if (ws && ws.readyState === WebSocket.OPEN) {
            if (nickname && nickname.length >= 2) {
                ws.send(JSON.stringify({ type: 'setNickname', payload: { nickname: nickname } }));
                errorMessage.textContent = ''; // Clear previous errors
                joinButton.disabled = true; // Disable button while processing
                statusMessage.textContent = 'Joining...';
            } else {
                 showError('Nickname must be at least 2 characters.');
            }
        } else {
            showError('Not connected to server. Wait for reconnection attempt.');
        }
    });

    nicknameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !joinButton.disabled) {
            joinButton.click();
        }
    });

    submitAnswerButton.addEventListener('click', () => {
        const answer = answerInput.value.trim();
        if (answer && ws && ws.readyState === WebSocket.OPEN && !submitAnswerButton.disabled) {
            ws.send(JSON.stringify({ type: 'submitAnswer', payload: { answer: answer } }));
             // Disable button immediately to prevent double submit
             submitAnswerButton.disabled = true;
             answerInput.disabled = true; // Also disable input
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
             // Basic rate limiting could be added here on client-side too
             ws.send(JSON.stringify({ type: 'chatMessage', payload: { message: message } }));
             chatInput.value = ''; // Clear input after sending
        }
    });

    chatInput.addEventListener('keypress', (e) => {
         if (e.key === 'Enter') {
             e.preventDefault(); // Prevent form submission if chat is inside a form
             sendChatButton.click();
         }
     });


    // --- Initialization ---
    connectWebSocket(); // Start the connection process

}); // End DOMContentLoaded