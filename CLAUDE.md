# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an Adaptive Tutor System built with a Python FastAPI backend and a JavaScript frontend. The system provides personalized learning experiences with features like knowledge graph visualization, coding exercises with sandboxed execution, and AI-powered tutoring.

## Repository Structure

- `backend/` - Python FastAPI backend application
  - `app/` - Main application code
    - `api/` - API endpoints and routing
    - `core/` - Configuration and core utilities
    - `crud/` - Database operations
    - `data/` - Learning content, documents, and knowledge base files
    - `db/` - Database configuration and models
    - `models/` - SQLAlchemy data models
    - `schemas/` - Pydantic data schemas
    - `services/` - Business logic services (RAG, LLM, sandbox, etc.)
  - `tests/` - Backend test suite
- `frontend/` - JavaScript/HTML/CSS frontend
  - `js/` - JavaScript modules and pages
  - `css/` - Stylesheets
  - `pages/` - HTML pages
- `docs/` - Documentation including Technical Design Documents (TDD)

## Development Environment

### Prerequisites
- Python 3.8+
- Node.js (for frontend development)
- pip or poetry for Python package management

### Setup
1. Install Python dependencies: `pip install -r requirements.txt`
2. For VS Code: No manual configuration needed - the project includes `.vscode/settings.json` that automatically configures the Python path
3. For PyCharm: Mark the `backend` directory as "Sources Root"

## Common Commands

### Running the Application
```bash
# Start the backend server
cd backend
python app/main.py
```

### Running Tests
```bash
# Run all tests
cd backend
pytest

# Run tests with coverage
cd backend
pytest --cov=app tests/

# Run specific test file
cd backend
pytest tests/test_chat_endpoints.py
```

### Type Checking
```bash
# Run mypy type checking
cd backend
mypy app/
```

### Building Knowledge Base
```bash
# Build or update the knowledge base
cd backend
python scripts/build_knowledge_base_resumable.py
```

## Architecture Overview

### Backend (FastAPI)
- Uses FastAPI for REST API endpoints
- SQLAlchemy for database ORM
- Pydantic for data validation
- Pydantic-settings for configuration management
- Modular design with separate API endpoints, services, and data layers

### Frontend (Vanilla JS)
- Modular JavaScript with ES6 imports
- Fetch API for backend communication
- Cytoscape.js for knowledge graph visualization
- Monaco Editor for code editing

### Key Services
1. **RAG Service** - Retrieval-Augmented Generation for contextual learning
2. **Sandbox Service** - Secure code execution environment
3. **LLM Gateway** - Interface to language models
4. **User State Service** - Manages learner progress and state
5. **Behavior Interpreter** - Analyzes user interactions

### Configuration Management
- Uses `.env` files for environment-specific configuration
- Pydantic-settings for type-safe configuration loading
- Separate configuration for different API services (LLM, embedding, translation)
- Frontend configuration loaded securely from backend endpoint

### Data Flow
1. User interactions are captured and sent to backend
2. Backend processes data through various services
3. Database stores user progress, chat history, and learning data
4. RAG service retrieves relevant content from knowledge base
5. LLM service generates personalized responses
6. Frontend displays results and updates UI

## Database
- SQLite database for development
- SQLAlchemy ORM for database operations
- Alembic-ready for migrations (if needed)
- Models for users, progress, chat history, events, etc.

## Testing
- Pytest for unit and integration testing
- Test organization mirrors application structure
- Both unit tests and integration tests included
- Mark integration tests with `@pytest.mark.integration`

## Security Considerations
- API keys stored in environment variables, not in code
- CORS configuration for frontend-backend communication
- Sandboxed code execution for user submissions
- Secure configuration loading with validation