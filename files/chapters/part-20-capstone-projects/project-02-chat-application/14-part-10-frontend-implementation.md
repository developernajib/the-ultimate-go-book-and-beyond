## Part 10: Frontend Implementation

A chat application is only useful if users can interact with it through a clean interface. In this section, you will build a simple but functional web client using plain HTML, CSS, and JavaScript, no frontend framework required. The client connects to the server over WebSockets, displays messages in real time, shows channel lists and user presence indicators, and handles file uploads. While production chat apps use sophisticated frontend frameworks, this vanilla implementation helps you understand exactly how the browser-side WebSocket API works without any abstraction layers hiding the details.

### 10.1 HTML Client (`web/static/index.html`)
The HTML client establishes a WebSocket connection, renders incoming messages in real time, and posts user input back to the server. It uses plain JavaScript DOM manipulation with no external dependencies.

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>GoChat - Real-Time Chat</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #1a1d21;
            color: #dcddde;
        }

        .container {
            display: flex;
            height: 100vh;
        }

        /* Sidebar */
        .sidebar {
            width: 250px;
            background: #2f3136;
            display: flex;
            flex-direction: column;
        }

        .sidebar-header {
            padding: 20px;
            border-bottom: 1px solid #202225;
        }

        .sidebar-header h2 {
            color: #fff;
            font-size: 16px;
        }

        .channels {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
        }

        .channel {
            padding: 8px 12px;
            border-radius: 4px;
            cursor: pointer;
            margin-bottom: 2px;
            display: flex;
            align-items: center;
        }

        .channel:hover {
            background: #36393f;
        }

        .channel.active {
            background: #393c43;
        }

        .channel-hash {
            margin-right: 6px;
            color: #8e9297;
        }

        /* Main content */
        .main-content {
            flex: 1;
            display: flex;
            flex-direction: column;
        }

        .chat-header {
            height: 60px;
            border-bottom: 1px solid #202225;
            padding: 0 20px;
            display: flex;
            align-items: center;
        }

        .chat-header h3 {
            font-size: 16px;
            color: #fff;
        }

        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
        }

        .message {
            display: flex;
            margin-bottom: 20px;
        }

        .message-avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: #5865f2;
            margin-right: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
        }

        .message-content {
            flex: 1;
        }

        .message-header {
            display: flex;
            align-items: baseline;
            margin-bottom: 4px;
        }

        .message-author {
            font-weight: 600;
            color: #fff;
            margin-right: 8px;
        }

        .message-time {
            font-size: 12px;
            color: #72767d;
        }

        .message-text {
            color: #dcddde;
            line-height: 1.4;
        }

        /* Input area */
        .input-area {
            padding: 20px;
            background: #40444b;
        }

        .input-wrapper {
            background: #40444b;
            border-radius: 8px;
            padding: 12px;
            display: flex;
            align-items: center;
        }

        .input-wrapper input {
            flex: 1;
            background: none;
            border: none;
            color: #dcddde;
            font-size: 14px;
            outline: none;
        }

        .input-wrapper input::placeholder {
            color: #72767d;
        }

        .send-button {
            background: #5865f2;
            color: #fff;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            margin-left: 10px;
        }

        .send-button:hover {
            background: #4752c4;
        }

        /* Login form */
        .login-container {
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            background: #1a1d21;
        }

        .login-form {
            background: #2f3136;
            padding: 40px;
            border-radius: 8px;
            width: 400px;
        }

        .login-form h2 {
            color: #fff;
            margin-bottom: 20px;
            text-align: center;
        }

        .form-group {
            margin-bottom: 20px;
        }

        .form-group label {
            display: block;
            color: #b9bbbe;
            margin-bottom: 8px;
            font-size: 14px;
        }

        .form-group input {
            width: 100%;
            padding: 10px;
            background: #40444b;
            border: 1px solid #202225;
            border-radius: 4px;
            color: #dcddde;
            font-size: 14px;
        }

        .form-group input:focus {
            outline: none;
            border-color: #5865f2;
        }

        .login-button {
            width: 100%;
            padding: 12px;
            background: #5865f2;
            color: #fff;
            border: none;
            border-radius: 4px;
            font-size: 16px;
            cursor: pointer;
        }

        .login-button:hover {
            background: #4752c4;
        }

        .error {
            color: #f04747;
            font-size: 14px;
            margin-top: 10px;
        }

        .typing-indicator {
            color: #72767d;
            font-size: 12px;
            font-style: italic;
            padding: 0 20px;
            height: 20px;
        }
    </style>
</head>
<body>
    <div id="app"></div>
    <script src="app.js"><\/script>
</body>
</html>
```

### 10.2 JavaScript Client (`web/static/app.js`)

The frontend implementation connects to the WebSocket server, renders incoming messages in real time, and handles reconnection with exponential backoff. Keeping the frontend thin, delegating state management to the server, simplifies offline handling and avoids client-side consistency bugs.

```javascript
class ChatApp {
    constructor() {
        this.ws = null;
        this.token = localStorage.getItem('token');
        this.currentChannel = null;
        this.channels = [];
        this.messages = {};
        this.typingTimeout = null;

        if (this.token) {
            this.showChat();
        } else {
            this.showLogin();
        }
    }

    showLogin() {
        document.getElementById('app').innerHTML = `
            <div class="login-container">
                <div class="login-form">
                    <h2>GoChat</h2>
                    <div class="form-group">
                        <label>Username</label>
                        <input type="text" id="username" placeholder="Enter username">
                    </div>
                    <div class="form-group">
                        <label>Password</label>
                        <input type="password" id="password" placeholder="Enter password">
                    </div>
                    <button class="login-button" onclick="app.login()">Login</button>
                    <div id="error" class="error"></div>
                </div>
            </div>
        `;
    }

    async login() {
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            if (response.ok) {
                const data = await response.json();
                this.token = data.token;
                localStorage.setItem('token', this.token);
                this.showChat();
            } else {
                document.getElementById('error').textContent = 'Invalid credentials';
            }
        } catch (error) {
            document.getElementById('error').textContent = 'Login failed';
        }
    }

    async showChat() {
        await this.loadChannels();
        this.renderChat();
        this.connectWebSocket();
    }

    async loadChannels() {
        try {
            const response = await fetch('/api/channels', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            this.channels = await response.json();

            if (this.channels.length > 0) {
                this.currentChannel = this.channels[0];
                await this.loadMessages(this.currentChannel.id);
            }
        } catch (error) {
            console.error('Failed to load channels:', error);
        }
    }

    async loadMessages(channelId) {
        try {
            const response = await fetch(`/api/channels/${channelId}/messages?limit=50`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            const messages = await response.json();
            this.messages[channelId] = messages.reverse();
            this.renderMessages();
        } catch (error) {
            console.error('Failed to load messages:', error);
        }
    }

    renderChat() {
        document.getElementById('app').innerHTML = `
            <div class="container">
                <div class="sidebar">
                    <div class="sidebar-header">
                        <h2>GoChat</h2>
                    </div>
                    <div class="channels" id="channels"></div>
                </div>
                <div class="main-content">
                    <div class="chat-header">
                        <h3># <span id="channel-name"></span></h3>
                    </div>
                    <div class="messages" id="messages"></div>
                    <div class="typing-indicator" id="typing"></div>
                    <div class="input-area">
                        <div class="input-wrapper">
                            <input type="text" id="message-input" placeholder="Type a message..."
                                   onkeypress="app.handleKeyPress(event)"
                                   oninput="app.handleTyping()">
                            <button class="send-button" onclick="app.sendMessage()">Send</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        this.renderChannels();
        this.renderMessages();
    }

    renderChannels() {
        const channelsDiv = document.getElementById('channels');
        channelsDiv.innerHTML = this.channels.map(channel => `
            <div class="channel ${channel.id === this.currentChannel?.id ? 'active' : ''}"
                 onclick="app.switchChannel('${channel.id}')">
                <span class="channel-hash">#</span>
                ${channel.name}
            </div>
        `).join('');
    }

    renderMessages() {
        if (!this.currentChannel) return;

        document.getElementById('channel-name').textContent = this.currentChannel.name;

        const messages = this.messages[this.currentChannel.id] || [];
        const messagesDiv = document.getElementById('messages');

        messagesDiv.innerHTML = messages.map(msg => `
            <div class="message">
                <div class="message-avatar">
                    ${msg.user?.username?.[0]?.toUpperCase() || 'U'}
                </div>
                <div class="message-content">
                    <div class="message-header">
                        <span class="message-author">${msg.user?.username || 'Unknown'}</span>
                        <span class="message-time">${this.formatTime(msg.created_at)}</span>
                    </div>
                    <div class="message-text">${this.escapeHtml(msg.content)}</div>
                </div>
            </div>
        `).join('');

        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    async switchChannel(channelId) {
        this.currentChannel = this.channels.find(c => c.id === channelId);

        if (!this.messages[channelId]) {
            await this.loadMessages(channelId);
        }

        this.renderChannels();
        this.renderMessages();

        // Join room via WebSocket
        this.ws.send(JSON.stringify({
            type: 'join_room',
            data: { room_id: channelId }
        }));
    }

    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws?token=${this.token}`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            // Join current channel
            if (this.currentChannel) {
                this.ws.send(JSON.stringify({
                    type: 'join_room',
                    data: { room_id: this.currentChannel.id }
                }));
            }
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleWebSocketMessage(data);
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            // Reconnect after 3 seconds
            setTimeout(() => this.connectWebSocket(), 3000);
        };
    }

    handleWebSocketMessage(data) {
        switch (data.type) {
            case 'new_message':
                this.handleNewMessage(data.data);
                break;
            case 'typing':
                this.handleTypingIndicator(data.data);
                break;
            case 'user_joined':
            case 'user_left':
                console.log(data.type, data.data);
                break;
        }
    }

    handleNewMessage(message) {
        if (!this.messages[message.channel_id]) {
            this.messages[message.channel_id] = [];
        }

        this.messages[message.channel_id].push(message);

        if (message.channel_id === this.currentChannel?.id) {
            this.renderMessages();
        }
    }

    handleTypingIndicator(data) {
        if (data.room_id === this.currentChannel?.id) {
            const typingDiv = document.getElementById('typing');
            if (data.is_typing) {
                typingDiv.textContent = `${data.user_id} is typing...`;
                setTimeout(() => {
                    typingDiv.textContent = '';
                }, 3000);
            } else {
                typingDiv.textContent = '';
            }
        }
    }

    handleTyping() {
        if (!this.currentChannel) return;

        // Clear previous timeout
        if (this.typingTimeout) {
            clearTimeout(this.typingTimeout);
        }

        // Send typing indicator
        this.ws.send(JSON.stringify({
            type: 'typing',
            data: {
                room_id: this.currentChannel.id,
                is_typing: true
            }
        }));

        // Stop typing after 3 seconds of inactivity
        this.typingTimeout = setTimeout(() => {
            this.ws.send(JSON.stringify({
                type: 'typing',
                data: {
                    room_id: this.currentChannel.id,
                    is_typing: false
                }
            }));
        }, 3000);
    }

    handleKeyPress(event) {
        if (event.key === 'Enter') {
            this.sendMessage();
        }
    }

    sendMessage() {
        const input = document.getElementById('message-input');
        const content = input.value.trim();

        if (!content || !this.currentChannel) return;

        this.ws.send(JSON.stringify({
            type: 'chat_message',
            data: {
                room_id: this.currentChannel.id,
                content: content
            }
        }));

        input.value = '';
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize app
const app = new ChatApp();
```

### Junior → FAANG: Vanilla JavaScript as a Learning Tool

The vanilla JavaScript frontend in this chapter serves one purpose: to show you exactly how the browser WebSocket API works without a framework hiding the details. In a real job, you would use React, Vue, or a mobile SDK for the UI. But understanding what `new WebSocket()`, `socket.onmessage`, and `socket.send()` do at the browser level makes you a better engineer regardless of which framework you use later.

For interviews, being able to describe the browser-side WebSocket lifecycle (connecting, receiving messages, handling errors, reconnecting after disconnect) shows end-to-end system understanding. Reconnection logic (exponential backoff after disconnect, with jitter to avoid thundering herd) is a detail that shows production awareness.

The fact that the frontend is static HTML served by the same Go server demonstrates that a Go HTTP server can serve both API requests and static assets. In production, static assets are typically served by a CDN to reduce server load, but the pattern of serving them from the application server for simplicity in development is common.

### Senior @ FAANG: Frontend as an API Consumer Contract

At senior level, the frontend is the primary consumer of your API. The contract between the frontend and backend (message format, event types, error codes) must be versioned and stable. Breaking changes to the WebSocket message format or the REST API require coordinated frontend and backend releases.

For a mobile chat application (which most production chat systems are), the contract stability requirement is even stronger: mobile clients may not update for months after a release. The backend must support multiple API versions simultaneously, typically the current version and the two previous versions. This multiplexes the operational burden significantly and requires planning before the first version ships.

The presence indicator ("user is typing") shows in the frontend as a simple text indicator. At the backend, this is a distributed state management problem: typing events are ephemeral (should disappear after 3-5 seconds of no typing), must be visible across server instances (requiring Redis), and must be debounced (not sent on every keystroke). The frontend debounce (send a typing event only if the user has not typed for 300ms) reduces backend load. The backend TTL (Redis key expires after 5 seconds) handles the case where the client disconnects while typing. This interplay between frontend and backend behavior is a system design detail worth describing in an interview.

---
