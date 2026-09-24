# Blog Platform

A lightweight personal blog platform built with Vue 3 + Vite (frontend) and Node.js + Express (backend).

## Tech Stack

### Frontend
- **Vue 3** - Progressive JavaScript framework
- **Vite** - Next generation frontend tooling
- **Vue Router** - Official router for Vue.js
- **Pinia** - State management library
- **Element Plus** - Vue 3 UI component library
- **Axios** - HTTP client
- **Marked** - Markdown parser

### Backend
- **Node.js** - JavaScript runtime
- **Express** - Web application framework
- **better-sqlite3** - Fast SQLite3 library
- **jsonwebtoken** - JWT implementation
- **cors** - Cross-Origin Resource Sharing

## Project Structure

```
blog-platform/
├── frontend/          # Vue 3 + Vite frontend
│   ├── src/
│   │   ├── api/       # API client
│   │   ├── components/# Reusable components
│   │   ├── router/    # Vue Router configuration
│   │   ├── stores/    # Pinia stores
│   │   └── views/     # Page components
│   └── ...
├── backend/           # Node.js + Express backend
│   ├── db/            # Database initialization and seeds
│   ├── routes/        # API routes
│   ├── middleware/    # Express middleware
│   └── data/          # SQLite database file
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

1. **Clone or navigate to the project directory**

```bash
cd blog-platform
```

2. **Install backend dependencies**

```bash
cd backend
npm install
```

3. **Install frontend dependencies**

```bash
cd ../frontend
npm install
```

4. **Initialize the database with seed data**

```bash
cd ../backend
npm run seed
```

### Running the Application

1. **Start the backend server (port 3001)**

```bash
cd backend
npm run dev
```

The API server will start at `http://localhost:3001`

2. **Start the frontend development server (port 5173)**

Open a new terminal:

```bash
cd frontend
npm run dev
```

The frontend will be available at `http://localhost:5173`

## Features

- **Article Management**: Create, read, update, and delete blog articles
- **Markdown Support**: Write articles in Markdown with live preview
- **Tag System**: Organize articles with tags and filter by tags
- **Pagination**: Navigate through articles with pagination (10 per page)
- **Admin Panel**: Protected admin area for managing articles
- **JWT Authentication**: Secure admin login with JSON Web Tokens

## API Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/api/auth/login` | Admin login | No |
| GET | `/api/articles` | List articles (with pagination and tag filter) | No |
| GET | `/api/articles/:id` | Get single article | No |
| POST | `/api/articles` | Create new article | Yes |
| PUT | `/api/articles/:id` | Update article | Yes |
| DELETE | `/api/articles/:id` | Delete article | Yes |
| GET | `/api/tags` | Get all unique tags | No |

## Admin Credentials

- **Username**: admin
- **Password**: admin123

## Configuration

### Backend

- Server port: `3001` (configurable via `PORT` environment variable)
- JWT secret: `blog-platform-secret-key` (hardcoded in middleware/auth.js)
- Database file: `backend/data/blog.db`

### Frontend

- Dev server port: `5173`
- API proxy: `/api` requests are proxied to `http://localhost:3001`

## Build for Production

### Backend

The backend runs directly with Node.js:

```bash
cd backend
npm start
```

### Frontend

Build the frontend for production:

```bash
cd frontend
npm run build
```

The built files will be in `frontend/dist/`

## Article List Snapshots (Local Development)

A read-only dev tool captures the article list states shown by the UI
(**文章集合** collection, **当前位置** pagination position, and **空结果** empty
result) in one run and emits comparable summaries. It only sends `GET` requests,
so it never changes article data or the runtime behavior of the list,
pagination, or tag filter.

With the backend running (`http://localhost:3001` by default):

```bash
cd frontend
npm run snapshot:articles
```

Outputs are written to `frontend/dev-snapshots/articles/` (git-ignored):

| File | Purpose |
|------|---------|
| `summary.json` | Deterministic, comparable summary: article ids/titles, pagination, tags, and per-stage + overall `digest` (no timestamps). |
| `latest.json` | Full responses for inspection. |
| `failed.json` | Written only on failure; records the failed stage(s). The previous good `summary.json`/`latest.json` is kept untouched. |

- **Repeat runs overwrite** the previous snapshot. Identical data produces an
  identical `digest`, so summaries can be diffed across builds.
- **Service unavailable / any stage error**: the build exits non-zero, writes
  `failed.json`, and leaves the last good snapshot in place; a later successful
  run clears `failed.json`.

Compare against a saved baseline (exits `0` on match, `2` on difference):

```bash
npm run snapshot:articles -- --baseline path/to/summary.json
```

Options: `--base <url>`, `--out <dir>`, `--baseline <file>`, `--timeout <ms>`
(env: `SNAPSHOT_API_BASE`, `SNAPSHOT_OUT_DIR`, `SNAPSHOT_BASELINE`,
`SNAPSHOT_TIMEOUT`).

## License

MIT
