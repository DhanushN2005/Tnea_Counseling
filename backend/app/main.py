from fastapi import FastAPI, Depends, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional, Dict
import ollama
import torch
from sqlalchemy.orm import Session
from .database import SessionLocal, College, TFCCenter
from langchain_chroma import Chroma
from langchain_huggingface import HuggingFaceEmbeddings
import os
from groq import Groq
from dotenv import load_dotenv

load_dotenv()
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

app = FastAPI(title="TNEA Pro Counselling AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- In-Memory Cache & Memory ---
USER_SESSIONS: Dict[str, dict] = {} # {session_id: {cutoff, category, choices: []}}
USER_CHOICES: Dict[str, List[dict]] = {} # {session_id: [choice_data]}

# --- GPU & Embeddings ---
# FORCE CPU for embeddings to save VRAM for Ollama (llama3)
# This prevents the "Ollama GPU/Memory Error" on most systems.
device = "cpu"
CHROMA_PATH = "backend/data/db/chroma_db"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
embeddings = HuggingFaceEmbeddings(
    model_name=EMBEDDING_MODEL, 
    model_kwargs={'device': device, 'local_files_only': True}
)
vector_db = Chroma(persist_directory=CHROMA_PATH, embedding_function=embeddings, collection_name="tnea_docs")
print(f"--- Embeddings initialized on device: {device} ---")

# --- Dynamic Branch Discovery ---
# We load all unique branches from the DB to ensure we can match ANY branch
ALL_BRANCHES = []
def load_branches():
    global ALL_BRANCHES
    try:
        db = SessionLocal()
        branches = db.query(College.branch_name).distinct().all()
        ALL_BRANCHES = [b[0].upper() for b in branches if b[0]]
        print(f"--- Loaded {len(ALL_BRANCHES)} unique branches from database ---")
        db.close()
    except Exception as e:
        print(f"Error loading branches: {e}")

load_branches()

def apply_branch_filter(query, branch_clean: str):
    if not branch_clean:
        return query
    from sqlalchemy import or_, func
    b_norm = branch_clean.strip().upper()
    
    if b_norm in ["IT", "INFORMATION TECHNOLOGY"]:
        return query.filter(College.branch_name.ilike("%Information Technology%"))
    elif b_norm in ["CSE", "CS", "COMPUTER SCIENCE", "COMPUTER SCIENCE AND ENGINEERING"]:
        return query.filter(or_(
            College.branch_name.ilike("%Computer Science%"),
            College.branch_name.ilike("%Computer Science and Engineering%"),
            College.branch_name.ilike("%Computer Science & Engineering%")
        ))
    elif b_norm in ["AIDS", "AD", "AI&DS", "AI-DS", "AI AND DS", "ARTIFICIAL INTELLIGENCE AND DATA SCIENCE"]:
        return query.filter(or_(
            College.branch_name.ilike("%Artificial Intelligence and Data Science%"),
            College.branch_name.ilike("%Artificial Intelligence & Data Science%"),
            College.branch_name.ilike("%AI%DS%"),
            College.branch_name.ilike("%Artificial Intelligence and Data Science (SS)%")
        ))
    elif b_norm in ["AIML", "AI&ML", "AI-ML", "AI AND ML", "ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING"]:
        return query.filter(or_(
            College.branch_name.ilike("%Artificial Intelligence and Machine Learning%"),
            College.branch_name.ilike("%Artificial Intelligence & Machine Learning%"),
            College.branch_name.ilike("%AI%ML%")
        ))
    elif b_norm in ["BM", "BME", "BIOMEDICAL", "BIOMEDICAL ENGINEERING", "BIO MEDICAL ENGINEERING"]:
        return query.filter(or_(
            College.branch_name.ilike("%Bio Medical Engineering%"),
            College.branch_name.ilike("%Biomedical Engineering%")
        ))
    else:
        return query.filter(func.replace(College.branch_name, ".", "").ilike(f"%{branch_clean}%"))

# --- Models ---
class QueryRequest(BaseModel):
    query: Optional[str] = None
    session_id: Optional[str] = "default"
    category: Optional[str] = "OC"
    cutoff: Optional[float] = 0.0
    district: Optional[str] = None
    branch: Optional[str] = None

class RecommendationResponse(BaseModel):
    college_code: int
    college_name: str
    branch_name: str
    district: str
    cutoff: str
    history: Optional[dict] = {}
    reason: str
    tier: str # Safe, Moderate, Dream
    label: Optional[str] = ""
    proximity: Optional[float] = 0.0

# --- Core Logic ---

# --- Core Logic ---

def get_db():
    db = SessionLocal()
    try: yield db
    finally: db.close()

@app.post("/recommend", response_model=List[RecommendationResponse])
async def recommend_endpoint(request: QueryRequest, db: Session = Depends(get_db)):
    cutoff = request.cutoff if request.cutoff is not None else 0.0
    # Save to session memory
    USER_SESSIONS[request.session_id] = {"cutoff": cutoff, "category": request.category}

    # 1. Primary Search - Prioritize 2025 data, fallback to 2024
    query = db.query(College).filter((College.cutoff_2025 > 0) | (College.cutoff_2024 > 0)).filter(College.branch_name.isnot(None))
    
    # Normalize input
    dist_clean = request.district.strip().replace(".", "") if request.district else ""
    branch_clean = request.branch.strip().upper().replace(".", "") if request.branch else ""
    
    # Apply filters if provided
    if request.category:
        query = query.filter(College.category == request.category)
    
    if dist_clean:
        # SQL normalization: Remove dots from district name during comparison
        from sqlalchemy import func
        query = query.filter(func.replace(College.district, ".", "").ilike(f"%{dist_clean}%"))
    
    if branch_clean:
        query = apply_branch_filter(query, branch_clean)
    
    results = query.all()
    print(f"DEBUG: Found {len(results)} total matching records for processing.")

    # 2. Relaxed Fallback (If no results in district, search statewide)
    if not results and request.district:
        print(f"DEBUG: Falling back to statewide search.")
        query = db.query(College).filter(College.cutoff_2023 > 0)
        if request.category: query = query.filter(College.category == request.category)
        if branch_clean:
            query = apply_branch_filter(query, branch_clean)
        results = query.limit(500).all() # Get a large pool for fallback

    # Group by College + Branch to avoid duplicates and show ranges
    grouped = {}
    for col in results:
        key = (col.college_name, col.branch_name)
        if key not in grouped:
            grouped[key] = {
                "col": col,
                "cutoffs": []
            }
        # Always store full history for trends, even if latest is missing
        grouped[key]["history"] = {
            "2021": col.cutoff_2021,
            "2022": col.cutoff_2022,
            "2023": col.cutoff_2023,
            "2024": col.cutoff_2024,
            "2025": col.cutoff_2025
        }
        
        # Track the latest available cutoff for range calculation
        latest_c = col.cutoff_2025 or col.cutoff_2024 or col.cutoff_2023
        if latest_c:
            grouped[key]["cutoffs"].append(latest_c)

    recommendations = []
    for (c_name, b_name), data in grouped.items():
        col = data["col"]
        cutoffs = data["cutoffs"]
        if not cutoffs:
            continue
        min_c = min(cutoffs)
        max_c = max(cutoffs)
        
        # Use max_c for proximity/tiering logic as it's the most competitive
        diff = cutoff - max_c
        
        # Friendly Suggester Logic (Balanced thresholds)
        if diff >= 1:
            tier = "Safe"
            label = "High Probability"
            reason = f"Excellent match! Your score of {cutoff} is above the {max_c} cutoff. Very high chance of admission."
        elif -2 <= diff < 1:
            tier = "Moderate"
            label = "Good Match"
            reason = f"Perfect match! This range ({min_c}-{max_c}) fits your score perfectly. Highly recommended."
        elif -10 <= diff < -2:
            tier = "Dream"
            label = "Aspirational Reach"
            reason = f"Great target! This is slightly ambitious but definitely worth a shot in early rounds."
        else: continue
            
        # Format the cutoff display (Single value if same, or Range if different)
        cutoff_display = f"{min_c} - {max_c}" if min_c != max_c else f"{min_c}"
            
        recommendations.append({
            "college_code": int(col.college_code) if col.college_code else 0,
            "college_name": c_name,
            "branch_name": b_name or "General",
            "district": col.district,
            "cutoff": cutoff_display,
            "history": data.get("history", {}),
            "raw_cutoff": max_c,
            "reason": reason,
            "tier": tier,
            "label": label,
            "proximity": abs(diff)
        })
    
    # SMART SORTING: Prioritize colleges closest to the user's cutoff
    recommendations.sort(key=lambda x: x['proximity'])
    
    return recommendations[:50]

@app.post("/chat")
async def chat_endpoint(request: QueryRequest, db: Session = Depends(get_db)):
    raw_query = request.query.strip()
    query_lower = raw_query.lower()
    session_id = request.session_id

    # Conversational Memory Lookup
    session = USER_SESSIONS.get(session_id, {})
    user_cutoff = request.cutoff if request.cutoff is not None else session.get("cutoff", 0.0)
    user_cat = request.category if request.category else session.get("category", "OC")

    # -----------------------------------------------------------------
    # SMART QUERY INTENT DETECTION
    # -----------------------------------------------------------------
    query_norm = query_lower.upper().replace(".", "").replace("?", "").replace("&", " AND ").replace("-", " ")
    q_words = query_norm.split()

    # Intent flags
    is_fee_query = any(w in query_lower for w in ["fee", "fees", "tuition", "cost", "payment", "challan"])
    is_scholarship_query = any(w in query_lower for w in ["scholarship", "concession", "free seat", "first graduate", "7.5"])
    is_counselling_query = any(w in query_lower for w in ["process", "stages", "schedule", "round", "counselling", "counseling", "option filling", "allotment", "document", "verification"])
    is_rank_query = any(w in query_lower for w in ["rank", "marks", "cutoff", "mark", "score"])
    is_tfc_query = any(w in query_lower for w in ["tfc", "facilitation", "center", "centre", "help center"])
    is_category_query = any(w in query_lower for w in ["oc", "bc", "mbc", "sc", "sca", "st", "category", "reservation"])
    is_greeting = query_lower.strip() in ["hi", "hello", "hey", "who are you", "what can you do"]

    # Branch detection
    branch_filter = None
    branch_map = {
        "AIDS": "ARTIFICIAL INTELLIGENCE AND DATA SCIENCE",
        "AD": "ARTIFICIAL INTELLIGENCE AND DATA SCIENCE",
        "AI AND DS": "ARTIFICIAL INTELLIGENCE AND DATA SCIENCE",
        "AIML": "ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING",
        "AI AND ML": "ARTIFICIAL INTELLIGENCE AND MACHINE LEARNING",
        "CSE": "COMPUTER SCIENCE AND ENGINEERING",
        "CS": "COMPUTER SCIENCE AND ENGINEERING",
        "IT": "INFORMATION TECHNOLOGY",
        "ECE": "ELECTRONICS AND COMMUNICATION ENGINEERING",
        "EEE": "ELECTRICAL AND ELECTRONICS ENGINEERING",
        "MECH": "MECHANICAL ENGINEERING",
        "CIVIL": "CIVIL ENGINEERING",
        "BM": "BIO MEDICAL ENGINEERING",
        "BME": "BIO MEDICAL ENGINEERING",
        "AI": "ARTIFICIAL INTELLIGENCE",
        "DS": "DATA SCIENCE",
        "CHEM": "CHEMICAL ENGINEERING",
        "AERO": "AERONAUTICAL ENGINEERING",
        "AUTO": "AUTOMOBILE ENGINEERING",
        "BIOTECH": "BIOTECHNOLOGY",
        "MBA": "MBA",
        "MCA": "MCA",
    }
    for abbr, full in branch_map.items():
        if abbr in q_words or f" {abbr} " in f" {query_norm} ":
            branch_filter = full
            break
    if not branch_filter:
        for b_name in ALL_BRANCHES:
            b_norm = b_name.replace(".", "").upper()
            if b_norm in query_norm:
                branch_filter = b_name
                break

    # Words that are noise for college search (keep narrow — don't block "FEES")
    NOISE_WORDS = {
        "COLLEGE", "INSTITUTE", "ACADEMY", "UNIVERSITY", "AND", "OF", "THE",
        "TELL", "WHAT", "NAME", "SHOW", "LIST", "ABOUT", "GIVE", "FIND",
        "THESE", "THOSE", "WITH", "FOR", "FROM", "HAVE", "DOES", "WILL",
        "PLEASE", "HELP", "KNOW", "WANT", "NEED", "HOW", "WHEN", "WHERE"
    }
    selective_words = [w for w in q_words if w not in NOISE_WORDS and len(w) >= 3]
    is_general_query = not selective_words or all(
        any(w in q for q in [
            "process", "stage", "counselling", "counseling", "fee", "fees",
            "scholarship", "document", "eligibility", "reservation", "round",
            "option", "seat", "allot", "tfc", "category"
        ])
        for w in [s.lower() for s in selective_words]
    )

    # -----------------------------------------------------------------
    # SQL RETRIEVAL — only if it's plausibly a college-specific query
    # -----------------------------------------------------------------
    sql_context = ""
    if not is_general_query:
        from sqlalchemy import func
        matches = []
        for word in selective_words[:5]:  # limit to first 5 meaningful words
            q_sql = db.query(College).filter(
                func.replace(College.college_name, ".", "").ilike(f"%{word}%")
            )
            if branch_filter:
                q_sql = q_sql.filter(College.branch_name.ilike(f"%{branch_filter}%"))
            matches.extend(q_sql.limit(400).all())
            if len(matches) >= 1500:
                break

        # De-duplicate and group by college + branch
        c_grouped = {}
        for m in matches:
            b_key = (m.college_name, m.branch_name)
            if b_key not in c_grouped:
                if len(c_grouped) >= 12:
                    break
                c_grouped[b_key] = {
                    "college_code": m.college_code,
                    "district": m.district,
                    "history": {"2025": [], "2024": [], "2023": [], "2022": [], "2021": []}
                }
            for yr in ["2021", "2022", "2023", "2024", "2025"]:
                val = getattr(m, f"cutoff_{yr}", None)
                if val:
                    c_grouped[b_key]["history"][yr].append(val)

        for (c_n, b_n), data in list(c_grouped.items())[:15]:
            year_parts = []
            for year in ["2025", "2024", "2023", "2022", "2021"]:
                vals = data["history"][year]
                if not vals:
                    continue
                lo, hi = min(vals), max(vals)
                year_parts.append(f"{year}: {lo if lo == hi else f'{lo}–{hi}'}")
            if year_parts:
                sql_context += (
                    f"\n• {c_n} (Code {data['college_code']}, {data['district']}) | "
                    f"{b_n or 'General'} | Cutoffs — {', '.join(year_parts)}"
                )

        if not sql_context and matches:
            for m in matches[:8]:
                latest = m.cutoff_2025 or m.cutoff_2024 or m.cutoff_2023 or "N/A"
                sql_context += f"\n• {m.branch_name} | Latest Cutoff: {latest}"

    # -----------------------------------------------------------------
    # VECTOR / RAG RETRIEVAL
    # -----------------------------------------------------------------
    try:
        # Use a higher k for process/fee/general queries
        k_val = 15 if is_general_query or is_fee_query or is_counselling_query else 8
        docs = vector_db.similarity_search(raw_query, k=k_val)
    except Exception:
        docs = []

    vector_context = "\n\n".join([d.page_content for d in docs])
    citations = list(set(
        f"{d.metadata.get('source')} (Page {d.metadata.get('page')})"
        for d in docs
        if d.metadata.get("source")
    ))

    # -----------------------------------------------------------------
    # GREETING SHORTCUT
    # -----------------------------------------------------------------
    if is_greeting:
        return {
            "answer": (
                "Hello! I'm your TNEA Pro AI counselling assistant. I can help you with:\n\n"
                "- **College & Branch Cutoff History** — see past cutoff marks for any college or branch\n"
                "- **Personalized Recommendations** — get Safe / Moderate / Dream college suggestions based on your score\n"
                "- **Counselling Process** — understand the rounds, document verification, option filling, and allotment\n"
                "- **Fees & Scholarships** — government tuition fee details, first-generation concessions, and more\n"
                "- **TFC Center Info** — find facilitation centers near you for document help\n\n"
                "What would you like to know? 😊"
            ),
            "sources": [],
            "strategy_alert": ""
        }

    # -----------------------------------------------------------------
    # COMPOSE FULL CONTEXT
    # -----------------------------------------------------------------
    context_parts = []
    if sql_context:
        context_parts.append(f"=== College Database Records ===\n{sql_context}")
    if vector_context:
        context_parts.append(f"=== Knowledge Base (PDF / Documents) ===\n{vector_context}")
    full_context = "\n\n".join(context_parts) if context_parts else "No specific records found in the database for this query."

    # -----------------------------------------------------------------
    # SYSTEM PROMPT — expert persona, warm tone, structured output
    # -----------------------------------------------------------------
    system_prompt = """You are TNEA Pro AI — a warm, knowledgeable, and highly experienced TNEA (Tamil Nadu Engineering Admissions) counsellor with 10+ years of expertise.

Your personality:
- Friendly and encouraging, never cold or bureaucratic
- Structured but conversational — like a wise senior mentor explaining to a student
- Honest about limitations without being dismissive
- Always suggest a next practical step

Your knowledge:
- You have deep expertise in TNEA counselling rounds, option filling strategy, seat allotment, document verification
- You know government college fee structures, BC/MBC/SC/ST scholarship schemes, first-graduate concessions, and the 7.5% quota
- You understand cutoff mark patterns across all districts and branches from 2021–2025
- You know how TFC (TNEA Facilitation Centers) work and their role in the process

Output format rules:
- Use **bold** for key terms, numbers, and college names
- Use bullet points or numbered steps for processes
- Use short paragraphs — never walls of text
- When data is available, present it as a clean summary with years
- When data is NOT in context, use your expert knowledge but clearly say "Based on general TNEA guidelines..."
- NEVER say "I couldn't find this in my records" as a full answer — always supplement with what you DO know
- NEVER produce generic placeholder text. Be specific and actionable.
- End with a helpful follow-up suggestion or question when appropriate"""

    user_prompt = f"""Student Profile: Cutoff Mark = {user_cutoff or 'Not set'}, Category = {user_cat or 'OC'}

Context from Knowledge Base:
{full_context}

Student's Question: {raw_query}

Please answer directly and helpfully. If the context has relevant data, use it precisely. If not, draw on your expert knowledge of TNEA and clearly indicate it. Be warm, structured, and end with a helpful next step."""

    # -----------------------------------------------------------------
    # LLM CALL
    # -----------------------------------------------------------------
    try:
        if groq_client:
            print("--- Attempting Groq (Llama-3.3-70b) ---")
            chat_completion = groq_client.chat.completions.create(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                model="llama-3.3-70b-versatile",
                temperature=0.4,
                max_tokens=1024,
            )
            full_response = chat_completion.choices[0].message.content.strip()
        else:
            raise Exception("No Groq API Key found")

    except Exception as e:
        print(f"--- Groq Failed, falling back to Ollama --- Error: {e}")
        try:
            combined_prompt = f"{system_prompt}\n\n{user_prompt}"
            response = ollama.chat(model='phi3', messages=[{'role': 'user', 'content': combined_prompt}])
            full_response = response['message']['content'].strip()
        except Exception as ollama_e:
            error_msg = str(ollama_e).lower()
            if "connection" in error_msg or "refused" in error_msg:
                return {
                    "answer": "I'm having trouble reaching the AI engine right now. Please make sure the Ollama service is running and try again in a moment.",
                    "sources": [],
                    "strategy_alert": "Tip: Open the Ollama app and ensure the service is active."
                }
            return {"answer": f"Unexpected error: {str(ollama_e)}", "sources": []}

    # Generate a strategy tip for cutoff-related queries
    strategy_alert = ""
    if user_cutoff and (is_rank_query or is_general_query) and float(user_cutoff) > 0:
        if float(user_cutoff) >= 190:
            strategy_alert = f"With a cutoff of {user_cutoff}, you're in a strong position! Focus on top Government colleges in your preferred district first."
        elif float(user_cutoff) >= 175:
            strategy_alert = f"Your cutoff of {user_cutoff} gives you solid options across Government and Aided colleges. Consider a mix of safe + aspirational choices."
        elif float(user_cutoff) >= 150:
            strategy_alert = f"With {user_cutoff}, aim for aided and self-financing colleges in your core branch. Widen your district scope for better picks."

    return {
        "answer": full_response,
        "sources": citations,
        "strategy_alert": strategy_alert
    }

@app.get("/college/{code}")
async def get_college_profile(code: int, db: Session = Depends(get_db)):
    colleges = db.query(College).filter(College.college_code == code).filter(College.branch_name.isnot(None)).all()
    if not colleges:
        # Fallback to Chroma search if not in SQL
        docs = vector_db.similarity_search(f"College Code: {code}", k=1)
        if not docs:
            # Just return a skeleton if absolutely nothing is found
            return {
                "name": "Unknown College",
                "code": code,
                "district": "Unknown",
                "category_type": "N/A",
                "branches": {},
                "historical_trends": ["No data available for this college code."]
            }
        
    # Get historical data from RAG (Handling both string and int metadata)
    rag_docs = vector_db.similarity_search(f"Historical data for college code {code}", k=15)
    historical_notes = [d.page_content for d in rag_docs if str(d.metadata.get('college_code')) == str(code)]
    
    first = colleges[0] if colleges else None
    profile = {
        "name": first.college_name if first else "TNEA College",
        "code": code,
        "district": first.district if first else "Various",
        "category_type": first.category if first else "Government/SF",
        "branches": {},
        "historical_trends": historical_notes
    }
    
    for col in colleges:
        b_name = col.branch_name or "General"
        if b_name not in profile["branches"]:
            profile["branches"][b_name] = {}
        
        cat = col.category
        profile["branches"][b_name][cat] = {
            "2021": round(col.cutoff_2021, 2) if col.cutoff_2021 else None,
            "2022": round(col.cutoff_2022, 2) if col.cutoff_2022 else None,
            "2023": round(col.cutoff_2023, 2) if col.cutoff_2023 else None,
            "2024": round(col.cutoff_2024, 2) if col.cutoff_2024 else None,
            "2025": round(col.cutoff_2025, 2) if col.cutoff_2025 else None,
        }
            
    return profile


@app.get("/directory")
async def get_directory(search: Optional[str] = None, db: Session = Depends(get_db)):
    from sqlalchemy import or_, and_, cast, String
    
    branch_map = {
        "aids": ["artificial intelligence and data science", "ai&ds", "ai-ds", "ai and ds"],
        "aiml": ["artificial intelligence and machine learning", "ai&ml", "ai-ml", "ai and ml"],
        "cse": ["computer science", "computer science and engineering", "computer science & engineering"],
        "cs": ["computer science", "computer science and engineering", "computer science & engineering"],
        "it": ["information technology"],
        "ece": ["electronics and communication engineering", "electronics & communication engineering"],
        "eee": ["electrical and electronics engineering", "electrical & electronics engineering"],
        "mech": ["mechanical engineering"],
        "civil": ["civil engineering"],
        "bme": ["bio medical engineering", "biomedical engineering"],
        "bm": ["bio medical engineering", "biomedical engineering"],
        "aero": ["aeronautical engineering"],
        "auto": ["automobile engineering"],
        "biotech": ["biotechnology"]
    }
    
    query = db.query(College).filter(College.branch_name.isnot(None))
    
    if search:
        tokens = search.strip().lower().split()
        if tokens:
            conditions = []
            for token in tokens:
                token_conds = [
                    College.college_name.ilike(f"%{token}%"),
                    College.district.ilike(f"%{token}%"),
                    cast(College.college_code, String).ilike(f"%{token}%")
                ]
                conditions.append(or_(*token_conds))
            
            query = query.filter(and_(*conditions))
            colleges = query.order_by(College.college_name).limit(1500).all()
    else:
        # Default representative subset to make initial load instant
        colleges = query.order_by(College.college_name).limit(500).all()
        
    directory = {}
    for col in colleges:
        code = col.college_code
        if not code:
            continue
        if code not in directory:
            directory[code] = {
                "name": col.college_name,
                "district": col.district,
                "code": code,
                "branches": {}
            }
        
        branch = col.branch_name or "General"
        latest_cutoff = col.cutoff_2025 or col.cutoff_2024 or col.cutoff_2023 or col.cutoff_2022 or col.cutoff_2021
        
        if latest_cutoff:
            if branch not in directory[code]["branches"]:
                directory[code]["branches"][branch] = {"min": latest_cutoff, "max": latest_cutoff}
            else:
                directory[code]["branches"][branch]["min"] = min(directory[code]["branches"][branch]["min"], latest_cutoff)
                directory[code]["branches"][branch]["max"] = max(directory[code]["branches"][branch]["max"], latest_cutoff)

    result = []
    for item in directory.values():
        branches_list = []
        for b_name, b_range in item["branches"].items():
            branches_list.append({
                "name": b_name,
                "min": round(b_range["min"], 2),
                "max": round(b_range["max"], 2)
            })
        item["branches"] = branches_list
        result.append(item)
        
    return {
        "total": len(result),
        "colleges": result
    }


@app.get("/tfc")
async def get_tfc_centers(db: Session = Depends(get_db)):
    return db.query(TFCCenter).limit(100).all()

@app.post("/choice/add")
async def add_choice(session_id: str, college_data: dict):
    if session_id not in USER_CHOICES:
        USER_CHOICES[session_id] = []
    
    # Avoid duplicates and handle missing keys safely (Type-insensitive comparison)
    new_code = str(college_data.get('code', '0000'))
    new_branch = str(college_data.get('branch', 'General'))
    
    is_duplicate = any(
        str(c.get('code')) == new_code and str(c.get('branch')) == new_branch 
        for c in USER_CHOICES[session_id]
    )
    
    if not is_duplicate:
        USER_CHOICES[session_id].append(college_data)
    
    return {"status": "success", "count": len(USER_CHOICES[session_id])}

@app.post("/choice/remove")
async def remove_choice(session_id: str, college_data: dict):
    if session_id in USER_CHOICES:
        code = str(college_data.get('code', '0000'))
        branch = str(college_data.get('branch', 'General'))
        USER_CHOICES[session_id] = [
            c for c in USER_CHOICES[session_id]
            if not (str(c.get('code')) == code and str(c.get('branch')) == branch)
        ]
    return {"status": "success", "count": len(USER_CHOICES.get(session_id, []))}

@app.get("/choice/{session_id}")
async def get_choices(session_id: str):
    return USER_CHOICES.get(session_id, [])

@app.get("/rag_records")
async def get_rag_records(search: Optional[str] = None):
    # Get documents from the specific source we just ingested
    collection = vector_db._collection
    
    # Building query
    query_params = {"where": {"source": "tnea_cutoff_all.json"}}
    if search:
        query_params["limit"] = 100
    else:
        query_params["limit"] = 100 
        
    results = collection.get(**query_params)
    
    documents = results.get('documents', [])
    metadatas = results.get('metadatas', [])
    
    records = []
    for doc, meta in zip(documents, metadatas):
        # Extract college name from doc content
        import re
        match = re.search(r"College: (.*?) \(Code:", doc)
        college_name = match.group(1) if match else "Unknown"
        
        branch_match = re.search(r"Branch: (.*?) \(", doc)
        branch_name = branch_match.group(1) if branch_match else "Unknown"
        
        records.append({
            "code": meta.get('college_code') or "0000",
            "name": college_name or "Unknown College",
            "branch": branch_name or "General",
            "district": meta.get('district') or "Unknown",
            "content": doc
        })
        
    return {
        "count": collection.count(),
        "records": records
    }

@app.get("/health")
async def health(): return {"status": "ok"}

# Serve Frontend
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
