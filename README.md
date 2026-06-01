# ViChat Server

Real-time chat server built with Node.js, Express, Socket.IO, and SQLite.

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Web Client  │     │ Android App  │     │  Any Client  │
│  (index.html)│     │  (Kotlin)   │     │  (Socket.IO) │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                    ┌───────┴───────┐
                    │  Nginx Proxy  │
                    │  (port :3001) │
                    └───────┬───────┘
                            │
                    ┌───────┴───────┐
                    │  Express App  │
                    │   (port 3000) │
                    ├───────────────┤
                    │  Socket.IO    │
                    │  WebSocket    │
                    ├───────────────┤
                    │  REST API     │
                    ├───────────────┤
                    │  SQLite DB    │
                    │  (better-sqlite3) │
                    └───────────────┘
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 18 (Alpine in Docker) |
| Framework | Express 4 |
| WebSocket | Socket.IO 4 |
| Database | SQLite via better-sqlite3 |
| Auth | bcryptjs + UUID tokens |
| Deployment | Docker + Nginx reverse proxy |

## API Endpoints

### REST

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/register` | Register new user |
| POST | `/api/login` | Login, returns token |
| POST | `/api/logout` | Invalidate session |
| GET | `/api/me` | Current user info |
| GET | `/api/contacts` | Contact list with unread counts |
| POST | `/api/contacts/add` | Add contact by username |
| POST | `/api/contacts/remove` | Remove contact |
| GET | `/api/messages/:contactId` | Message history (last 200) |
| PUT | `/api/messages/:id/edit` | Edit own message |
| DELETE | `/api/messages/:id` | Delete own message |

### WebSocket (Socket.IO)

**Client → Server:**
- `private-message` — send message
- `mark-read` — mark messages as read
- `typing` / `stop-typing` — typing indicator

**Server → Client:**
- `private-message` — incoming message
- `message-edited` / `message-deleted` — message mutations
- `contacts-online` — online status updates
- `typing` / `stop-typing` — typing indicator
- `unread-update` — unread count change

## Database Schema (SQLite)

```
users:      id, username, password_hash, color, created_at
sessions:   id, user_id, token, created_at
contacts:   id, user_id, contact_id, added_at (UNIQUE pair)
messages:   id, from_user_id, to_user_id, text, created_at, read_at
```

## Project Structure

```
vica-chat/
├── server.js          # Main server (Express + Socket.IO + REST)
├── db.js              # Database init & schema
├── package.json       # Dependencies
├── Dockerfile         # Docker image definition
├── .dockerignore
├── public/
│   └── index.html     # Web SPA client
└── vica.db            # SQLite database file
```

## Running

```bash
npm install
npm start
```

## Docker

```bash
docker build -t vichat-server .
docker run -p 3000:3000 vichat-server
```

## Deployment

Server runs behind Nginx reverse proxy on `kristonerr.fvds.ru` at port `:3001`.
Nginx config handles WebSocket upgrade headers.
