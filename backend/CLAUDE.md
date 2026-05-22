# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

**Running the Application:**
```bash
# Start the FastAPI server (development mode)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# Alternative: Run directly with Python
python -m uvicorn app.main:app --reload
```

**Environment Setup:**
1. Create `.env` file with required variables:
   ```
   GROQ_API_KEY=your_groq_api_key_here
   ```
2. Ensure Ollama is running with phi3 model: `ollama run phi3`
3. Install dependencies (if requirements exist):
   ```bash
   pip install -r requirements.txt  # if present
   ```

**Database Operations:**
- The app uses SQLite databases located in `./data/db/`
- `tnea_structured.db`: Contains college and TFC center data
- ChromaDB vector store: `./data/db/chroma_db/` (for document embeddings)

**Testing:**
Currently no test suite is implemented. To validate changes:
1. Start the server and test endpoints manually or with curl/postman
2. Key endpoints to verify:
   - POST `/recommend` - Get college recommendations
   - POST `/chat` - Ask questions about TNEA process
   - GET `/college/{code}` - Get college profile
   - GET `/directory` - Browse colleges
   - GET `/tfc` - Get TFC center information

## Code Architecture

**High-Level Structure:**
```
backend/
├── app/
│   ├── main.py          # FastAPI application with all endpoints
│   ├── database.py      # SQLAlchemy models and database setup
│   └── __pycache__/     # Compiled Python files
└── data/
    ├── db/
    │   ├── tnea_structured.db   # SQLite DB with college/TFC data
    │   ├── tnea.db              # Legacy SQLite DB
    │   └── chroma_db/           # Vector DB for document embeddings
    └── docs/                  # Source documents (PDF, DOCX) for RAG
```

**Core Components:**

1. **FastAPI Application (`app/main.py`):**
   - REST API endpoints for college recommendations, chat, directory, etc.
   - LLM integration with Groq (primary) and Ollama (fallback)
   - Session-based memory for user preferences and choices
   - CORS middleware enabled for frontend integration
   - Static file serving for frontend (if present)

2. **Data Models (`app/database.py`):**
   - SQLAlchemy ORM models:
     - `College`: Stores college details with yearly cutoff marks (2021-2025)
     - `TFCCenter`: Stores TNEA Facilitation Center information
   - Automatic table creation on import

3. **RAG System:**
   - Uses ChromaDB with HuggingFace embeddings (`sentence-transformers/all-MiniLM-L6-v2`)
   - Embeddings forced to CPU to save VRAM for Ollama
   - Document sources include PDFs and JSON files in `./data/docs/`
   - Similarity search used to retrieve relevant context for queries

4. **Key Features:**
   - **College Recommendations:** Based on user cutoff score, category, district, and branch preferences
   - **AI Chat:** Combines database queries, vector search, and LLM to answer TNEA-related questions
   - **Branch Mapping:** Handles common abbreviations (CSE → Computer Science and Engineering, etc.)
   - **Choice Tracking:** In-memory storage of user college selections during counselling
   - **Tier Classification:** Categorizes colleges as Safe/Moderate/Dream based on score proximity

**Data Flow:**
1. User query → `/recommend` or `/chat` endpoint
2. For recommendations: Database filtering + grouping + proximity sorting
3. For chat: 
   - Intent detection (fees, scholarships, counselling process, etc.)
   - SQL retrieval for college-specific data
   - Vector search for document-based information
   - LLM synthesis with expert TNEA counsellor persona
   - Response formatting with citations and strategy tips

**Important Notes:**
- The application is designed to work with the Tamil Nadu engineering admissions system
- Cutoff data spans 2021-2025 academic years
- Category system follows TNEA reservation: OC, BC, MBC, SC, SCA, ST
- Document ingestion appears to be handled externally (JSON files processed into ChromaDB)
- Frontend integration is configured via static file mount at root path ("/")